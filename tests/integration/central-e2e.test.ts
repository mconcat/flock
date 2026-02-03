/**
 * Central Node E2E Lifecycle Integration Test
 *
 * Exercises the FULL central-topology lifecycle:
 *   1. Worker creation + attachment to physical nodes
 *   2. Worker task execution via A2A
 *   3. Multiple workers on same node
 *   4. Same-node worker↔worker communication (LOCAL on central)
 *   5. Third worker on different node
 *   6. Multi-node communication (worker→worker LOCAL, worker→sysadmin REMOTE HTTP)
 *   7. Migration: worker-alpha from node-1 to node-2 (full lifecycle)
 *   8. POST_MIGRATION.md verification
 *   9. Post-migration portable data continuity + sysadmin re-routing
 *
 * Architecture:
 *   Central "node": In-process A2AServer + createCentralResolver + AssignmentStore + MigrationEngine
 *   Worker Node 1:  Real HTTP server with sysadmin echo agent
 *   Worker Node 2:  Real HTTP server with sysadmin echo agent
 *   Worker agents:  Echo executors registered on the central A2AServer
 *
 * NO mocks, NO Docker — real HTTP for cross-node, in-process for local.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdir, writeFile, readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { A2AServer } from "../../src/transport/server.js";
import { createA2AClient } from "../../src/transport/client.js";
import type { A2AClient } from "../../src/transport/client.js";
import {
  createCentralResolver,
  createCentralSysadminResolver,
  createCentralExecution,
} from "../../src/transport/topologies/central.js";
import { createAssignmentStore } from "../../src/nodes/assignment.js";
import type { AssignmentStore } from "../../src/nodes/assignment.js";
import { NodeRegistry } from "../../src/nodes/registry.js";
import { createWorkerCard, createSysadminCard } from "../../src/transport/agent-card.js";
import { createEchoExecutor } from "../../src/transport/echo-executor.js";
import { createMemoryDatabase } from "../../src/db/memory.js";
import { createHomeManager } from "../../src/homes/manager.js";
import type { HomeManager } from "../../src/homes/manager.js";
import { createMigrationEngine } from "../../src/migration/engine.js";
import type { MigrationEngine } from "../../src/migration/engine.js";
import { createTicketStore } from "../../src/migration/ticket-store.js";
import type { MigrationTicketStore } from "../../src/migration/ticket-store.js";
import { createAuditLog } from "../../src/audit/log.js";
import {
  hasPostMigrationTasks,
  readPostMigrationTasks,
  clearPostMigrationTasks,
} from "../../src/migration/post-migration.js";
import { checkFrozenStatus } from "../../src/migration/frozen-guard.js";
import { createHttpDispatch, createA2ATransport } from "../../src/migration/a2a-transport.js";
import { createMigrationOrchestrator } from "../../src/migration/orchestrator.js";
import type { MigrationOrchestrator } from "../../src/migration/orchestrator.js";
import type { MigrationHandlerContext } from "../../src/migration/handlers.js";
import type { PluginLogger } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Structured Test Logger
// ---------------------------------------------------------------------------

interface TestLog {
  timestamp: number;
  step: string;
  action: string;
  from?: string;
  to?: string;
  message?: string;
  response?: string;
  route?: "local" | "remote";
  endpoint?: string;
  phase?: string;
  details?: Record<string, unknown>;
}

const testLogs: TestLog[] = [];

function log(entry: Omit<TestLog, "timestamp">): void {
  testLogs.push({ timestamp: Date.now(), ...entry });
}

// ---------------------------------------------------------------------------
// Silent logger for infrastructure (captures nothing — the TestLog captures everything)
// ---------------------------------------------------------------------------

const logger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// HTTP Server Factory (from cross-node.test.ts pattern)
// ---------------------------------------------------------------------------

function createA2AHttpServer(a2aServer: A2AServer): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";

    if (method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);

      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const agentMatch = url.pathname.match(/^\/flock\/a2a\/([^/]+)$/);
      if (agentMatch) {
        const result = await a2aServer.handleRequest(agentMatch[1], body);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }
    }

    if (method === "GET" && url.pathname === "/flock/.well-known/agent-card.json") {
      const agents = a2aServer.listAgentCards();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          agents: agents.map((a) => ({ id: a.agentId, ...a.card })),
        }),
      );
      return;
    }

    const cardMatch = url.pathname.match(/^\/flock\/a2a\/([^/]+)\/agent-card\.json$/);
    if (method === "GET" && cardMatch) {
      const card = a2aServer.getAgentCard(cardMatch[1]);
      if (!card) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(card));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });
}

async function startServer(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (typeof addr === "object" && addr !== null) {
    return `http://127.0.0.1:${addr.port}/flock`;
  }
  throw new Error("Failed to get server address");
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Helper: Walk home through valid transitions to a target state
// ---------------------------------------------------------------------------

function setupHome(
  homeManager: HomeManager,
  agentId: string,
  nodeId: string,
  targetState: "ACTIVE" | "LEASED",
): void {
  homeManager.create(agentId, nodeId);
  const homeId = `${agentId}@${nodeId}`;
  homeManager.transition(homeId, "PROVISIONING", "setup", "test");
  homeManager.transition(homeId, "IDLE", "provisioned", "test");
  homeManager.transition(homeId, "LEASED", "lease-granted", "test");
  if (targetState === "ACTIVE") {
    homeManager.transition(homeId, "ACTIVE", "activated", "test");
  }
}

// ---------------------------------------------------------------------------
// Helper: Populate agent home with expected directory structure
// ---------------------------------------------------------------------------

async function populateAgentHome(homeDir: string, agentId: string): Promise<void> {
  await mkdir(join(homeDir, "toolkit"), { recursive: true });
  await mkdir(join(homeDir, "playbooks"), { recursive: true });
  await mkdir(join(homeDir, "knowledge", "active"), { recursive: true });
  await mkdir(join(homeDir, "knowledge", "archive"), { recursive: true });

  await writeFile(
    join(homeDir, "SOUL.md"),
    `# ${agentId}\n\nI am ${agentId}, a worker agent in the flock.\n`,
  );
  await writeFile(
    join(homeDir, "toolkit", "tools.json"),
    JSON.stringify({ agent: agentId, tools: ["echo", "build", "deploy"] }, null, 2),
  );
  await writeFile(
    join(homeDir, "playbooks", "default.md"),
    `# Default Playbook for ${agentId}\n\n1. Receive task\n2. Execute\n3. Report\n`,
  );
  await writeFile(
    join(homeDir, "knowledge", "active", "context.md"),
    `# Active Context\n\nWorking on tasks assigned to ${agentId}.\n`,
  );
  await writeFile(
    join(homeDir, "knowledge", "archive", "history.md"),
    `# History\n\nPrevious work by ${agentId}.\n`,
  );
  await writeFile(
    join(homeDir, "portable-data.txt"),
    `Critical portable data for ${agentId} — must survive migration.\n`,
  );
}

// ---------------------------------------------------------------------------
// Test State (shared across sequential steps)
// ---------------------------------------------------------------------------

// Worker node HTTP servers
let node1Http: http.Server;
let node1A2A: A2AServer;
let node1Url: string;

let node2Http: http.Server;
let node2A2A: A2AServer;
let node2Url: string;

// Central node infrastructure
let centralA2A: A2AServer;
let centralClient: A2AClient;
let assignments: AssignmentStore;
let registry: NodeRegistry;
let homeManager: HomeManager;
let migrationEngine: MigrationEngine;
let ticketStore: MigrationTicketStore;

// Filesystem temp roots
let rootTmpDir: string;
let sourceHomePath: string;
let targetHomePath: string;
let snapshotTmpDir: string;

// Migration orchestrator
let migrationOrchestrator: MigrationOrchestrator;

// Migration state carried between steps
let migrationId: string;

// ---------------------------------------------------------------------------
// Setup & Teardown
// ---------------------------------------------------------------------------

describe("Central Node E2E Lifecycle", () => {
  beforeAll(async () => {
    // --- Temp directory structure ---
    rootTmpDir = await mkdtemp(join(tmpdir(), "flock-central-e2e-"));
    sourceHomePath = join(rootTmpDir, "node1", "homes", "worker-alpha");
    targetHomePath = join(rootTmpDir, "node2", "homes", "worker-alpha");
    snapshotTmpDir = join(rootTmpDir, "snapshots");

    log({
      step: "0.setup",
      action: "create-temp-dirs",
      details: { rootTmpDir, sourceHomePath, targetHomePath, snapshotTmpDir },
    });

    // --- Worker Node 1: HTTP server with sysadmin ---
    const node1MigrationContext: MigrationHandlerContext = {
      ticketStore: createTicketStore({ logger }),
      auditLog: createAuditLog({ db: createMemoryDatabase(), logger }),
      logger,
      nodeId: "worker-node-1",
      tmpDir: join(rootTmpDir, "node1", "tmp"),
      resolveHomePath: (agentId: string) => join(rootTmpDir, "node1", "homes", agentId),
      resolveWorkPath: (agentId: string) => join(rootTmpDir, "node1", "work", agentId),
    };
    node1A2A = new A2AServer({ basePath: "/flock", logger, migrationContext: node1MigrationContext });
    const { card: sysadmin1Card, meta: sysadmin1Meta } = createSysadminCard(
      "worker-node-1",
      "http://localhost/flock/a2a/sysadmin",
    );
    // Label the executor with node ID so responses are distinguishable
    const sysadmin1Executor = createEchoExecutor({
      agentId: "sysadmin@worker-node-1",
      logger,
    });
    node1A2A.registerAgent("sysadmin", sysadmin1Card, sysadmin1Meta, sysadmin1Executor);
    node1Http = createA2AHttpServer(node1A2A);
    node1Url = await startServer(node1Http);

    log({
      step: "0.setup",
      action: "start-worker-node-1",
      endpoint: node1Url,
      details: { agents: ["sysadmin"] },
    });

    // --- Worker Node 2: HTTP server with sysadmin ---
    const node2MigrationContext: MigrationHandlerContext = {
      ticketStore: createTicketStore({ logger }),
      auditLog: createAuditLog({ db: createMemoryDatabase(), logger }),
      logger,
      nodeId: "worker-node-2",
      tmpDir: join(rootTmpDir, "node2", "tmp"),
      resolveHomePath: (agentId: string) => join(rootTmpDir, "node2", "homes", agentId),
      resolveWorkPath: (agentId: string) => join(rootTmpDir, "node2", "work", agentId),
    };
    node2A2A = new A2AServer({ basePath: "/flock", logger, migrationContext: node2MigrationContext });
    const { card: sysadmin2Card, meta: sysadmin2Meta } = createSysadminCard(
      "worker-node-2",
      "http://localhost/flock/a2a/sysadmin",
    );
    const sysadmin2Executor = createEchoExecutor({
      agentId: "sysadmin@worker-node-2",
      logger,
    });
    node2A2A.registerAgent("sysadmin", sysadmin2Card, sysadmin2Meta, sysadmin2Executor);
    node2Http = createA2AHttpServer(node2A2A);
    node2Url = await startServer(node2Http);

    log({
      step: "0.setup",
      action: "start-worker-node-2",
      endpoint: node2Url,
      details: { agents: ["sysadmin"] },
    });

    // --- Central Node: in-process ---
    const db = createMemoryDatabase();
    assignments = createAssignmentStore();
    registry = new NodeRegistry();

    registry.register({
      nodeId: "worker-node-1",
      a2aEndpoint: node1Url,
      status: "online",
      lastSeen: Date.now(),
      agentIds: ["sysadmin"],
    });
    registry.register({
      nodeId: "worker-node-2",
      a2aEndpoint: node2Url,
      status: "online",
      lastSeen: Date.now(),
      agentIds: ["sysadmin"],
    });

    centralA2A = new A2AServer({ basePath: "/flock", logger });
    homeManager = createHomeManager({ db, logger });

    const resolve = createCentralResolver();
    const resolveSysadmin = createCentralSysadminResolver(assignments, registry);

    centralClient = createA2AClient({
      localServer: centralA2A,
      resolve,
      resolveSysadmin,
      logger,
    });

    ticketStore = createTicketStore({ logger });
    const auditLog = createAuditLog({ db, logger });

    migrationEngine = createMigrationEngine({
      ticketStore,
      homeManager,
      auditLog,
      logger,
      nodeId: "central-node",
      endpoint: "http://central:3779/flock",
      mode: "central",
      tmpDir: snapshotTmpDir,
      registry,
    });

    // --- Migration Orchestrator with HTTP transport ---
    const httpDispatch = createHttpDispatch(registry, logger);
    const migrationTransport = createA2ATransport(httpDispatch, logger);

    migrationOrchestrator = createMigrationOrchestrator({
      engine: migrationEngine,
      transport: migrationTransport,
      sourceNodeId: "central-node",
      sourceEndpoint: "http://central:3779/flock",
      resolveSourceHome: (agentId) => join(rootTmpDir, "node1", "homes", agentId),
      resolveSourceWork: (agentId) => join(rootTmpDir, "node1", "work", agentId),
      resolveTargetHome: (agentId, targetNodeId) => {
        const nodeDir = targetNodeId.replace("worker-node-", "node");
        return join(rootTmpDir, nodeDir, "homes", agentId);
      },
      resolveTargetWork: (agentId, targetNodeId) => {
        const nodeDir = targetNodeId.replace("worker-node-", "node");
        return join(rootTmpDir, nodeDir, "work", agentId);
      },
      resolveTargetEndpoint: (nodeId) => registry.get(nodeId)?.a2aEndpoint ?? "",
      tmpDir: snapshotTmpDir,
      logger,
    });

    log({
      step: "0.setup",
      action: "create-central-node",
      details: {
        topology: "central",
        registryNodes: registry.list().map((n) => n.nodeId),
      },
    });
  });

  afterAll(async () => {
    // Stop HTTP servers
    await Promise.all([stopServer(node1Http), stopServer(node2Http)]);

    // Clean up temp directories
    await rm(rootTmpDir, { recursive: true, force: true });

    // --- Dump full structured test log ---
    console.log("\n" + "═".repeat(80));
    console.log("  CENTRAL NODE E2E LIFECYCLE — FULL STRUCTURED TEST LOG");
    console.log("═".repeat(80));

    for (const entry of testLogs) {
      const time = new Date(entry.timestamp).toISOString().split("T")[1];
      console.log(`\n  [${time}] Step: ${entry.step}`);
      console.log(`    Action:   ${entry.action}`);
      if (entry.from) console.log(`    From:     ${entry.from}`);
      if (entry.to) console.log(`    To:       ${entry.to}`);
      if (entry.route) console.log(`    Route:    ${entry.route}`);
      if (entry.endpoint) console.log(`    Endpoint: ${entry.endpoint}`);
      if (entry.phase) console.log(`    Phase:    ${entry.phase}`);
      if (entry.message) console.log(`    Message:  ${entry.message}`);
      if (entry.response) console.log(`    Response: ${entry.response}`);
      if (entry.details) console.log(`    Details:  ${JSON.stringify(entry.details)}`);
    }

    console.log("\n" + "─".repeat(80));
    console.log(`  Total log entries: ${testLogs.length}`);
    console.log("═".repeat(80) + "\n");
  });

  // ==========================================================================
  // Step 1: Worker agent creation + attachment to worker node
  // ==========================================================================
  it("Step 1: creates worker-alpha and assigns to worker-node-1", async () => {
    // Register worker-alpha on central A2AServer
    const { card: alphaCard, meta: alphaMeta } = createWorkerCard(
      "worker-alpha",
      "central-node",
      "http://central/flock/a2a/worker-alpha",
    );
    const alphaExecutor = createEchoExecutor({ agentId: "worker-alpha", logger });
    centralA2A.registerAgent("worker-alpha", alphaCard, alphaMeta, alphaExecutor);

    log({
      step: "1.create-worker-alpha",
      action: "register-agent",
      to: "central-a2a",
      message: "Registered worker-alpha echo executor on central A2AServer",
    });

    // Assign to worker-node-1 in the assignment store
    await assignments.set("worker-alpha", "worker-node-1", sourceHomePath);

    log({
      step: "1.create-worker-alpha",
      action: "assign-to-node",
      from: "worker-alpha",
      to: "worker-node-1",
      details: { portablePath: sourceHomePath },
    });

    // Create home on central node and activate
    setupHome(homeManager, "worker-alpha", "central-node", "ACTIVE");

    log({
      step: "1.create-worker-alpha",
      action: "home-setup",
      details: { homeId: "worker-alpha@central-node", state: "ACTIVE" },
    });

    // Populate portable storage
    await populateAgentHome(sourceHomePath, "worker-alpha");

    log({
      step: "1.create-worker-alpha",
      action: "populate-storage",
      details: { path: sourceHomePath },
    });

    // Verify
    expect(centralA2A.hasAgent("worker-alpha")).toBe(true);
    expect(assignments.get("worker-alpha")).not.toBeNull();
    expect(assignments.get("worker-alpha")!.nodeId).toBe("worker-node-1");

    const home = homeManager.get("worker-alpha@central-node");
    expect(home).not.toBeNull();
    expect(home!.state).toBe("ACTIVE");
  });

  // ==========================================================================
  // Step 2: Worker does work within scope
  // ==========================================================================
  it("Step 2: worker-alpha receives a task and produces output via A2A", async () => {
    const taskMessage = "Build the dashboard component for project-X";

    log({
      step: "2.worker-task",
      action: "a2a-send",
      from: "test-client",
      to: "worker-alpha",
      message: taskMessage,
      route: "local",
    });

    const result = await centralClient.sendMessage("worker-alpha", taskMessage);

    log({
      step: "2.worker-task",
      action: "a2a-response",
      from: "worker-alpha",
      response: result.response,
      route: "local",
      details: { state: result.state, taskId: result.taskId },
    });

    expect(result.state).toBe("completed");
    expect(result.response).toContain("[worker-alpha] echo:");
    expect(result.response).toContain(taskMessage);
    expect(result.taskId).toBeTruthy();
    expect(result.artifacts.length).toBeGreaterThan(0);
  });

  // ==========================================================================
  // Step 3: Second worker deployed to same node
  // ==========================================================================
  it("Step 3: creates worker-beta and assigns to worker-node-1 (same node)", async () => {
    const { card: betaCard, meta: betaMeta } = createWorkerCard(
      "worker-beta",
      "central-node",
      "http://central/flock/a2a/worker-beta",
    );
    const betaExecutor = createEchoExecutor({ agentId: "worker-beta", logger });
    centralA2A.registerAgent("worker-beta", betaCard, betaMeta, betaExecutor);

    await assignments.set(
      "worker-beta",
      "worker-node-1",
      join(rootTmpDir, "node1", "homes", "worker-beta"),
    );

    log({
      step: "3.create-worker-beta",
      action: "register-and-assign",
      to: "worker-node-1",
      message: "worker-beta registered on central, assigned to worker-node-1 (same as alpha)",
      details: {
        centralAgents: centralA2A.listAgentCards().map((a) => a.agentId),
        node1Assignments: assignments.listByNode("worker-node-1").map((a) => a.agentId),
      },
    });

    expect(centralA2A.hasAgent("worker-beta")).toBe(true);
    expect(assignments.get("worker-beta")!.nodeId).toBe("worker-node-1");

    // Both workers are on the same physical node
    const node1Workers = assignments.listByNode("worker-node-1");
    expect(node1Workers.length).toBe(2);
    expect(node1Workers.map((w) => w.agentId).sort()).toEqual(["worker-alpha", "worker-beta"]);
  });

  // ==========================================================================
  // Step 4: Same-node worker↔worker communication
  // ==========================================================================
  it("Step 4: worker-alpha ↔ worker-beta communicate locally on central", async () => {
    // Alpha → Beta
    const msgAlphaToBeta = "Hey beta, can you review my dashboard code?";

    log({
      step: "4.alpha-to-beta",
      action: "a2a-send",
      from: "worker-alpha",
      to: "worker-beta",
      message: msgAlphaToBeta,
      route: "local",
    });

    const alphaToBeta = await centralClient.sendMessage("worker-beta", msgAlphaToBeta);

    log({
      step: "4.alpha-to-beta",
      action: "a2a-response",
      from: "worker-beta",
      response: alphaToBeta.response,
      route: "local",
    });

    expect(alphaToBeta.state).toBe("completed");
    expect(alphaToBeta.response).toContain("[worker-beta] echo:");
    expect(alphaToBeta.response).toContain(msgAlphaToBeta);

    // Beta → Alpha
    const msgBetaToAlpha = "Sure alpha, the code looks good. Ship it!";

    log({
      step: "4.beta-to-alpha",
      action: "a2a-send",
      from: "worker-beta",
      to: "worker-alpha",
      message: msgBetaToAlpha,
      route: "local",
    });

    const betaToAlpha = await centralClient.sendMessage("worker-alpha", msgBetaToAlpha);

    log({
      step: "4.beta-to-alpha",
      action: "a2a-response",
      from: "worker-alpha",
      response: betaToAlpha.response,
      route: "local",
    });

    expect(betaToAlpha.state).toBe("completed");
    expect(betaToAlpha.response).toContain("[worker-alpha] echo:");
    expect(betaToAlpha.response).toContain(msgBetaToAlpha);
  });

  // ==========================================================================
  // Step 5: Third worker on different node
  // ==========================================================================
  it("Step 5: creates worker-gamma and assigns to worker-node-2", async () => {
    const { card: gammaCard, meta: gammaMeta } = createWorkerCard(
      "worker-gamma",
      "central-node",
      "http://central/flock/a2a/worker-gamma",
    );
    const gammaExecutor = createEchoExecutor({ agentId: "worker-gamma", logger });
    centralA2A.registerAgent("worker-gamma", gammaCard, gammaMeta, gammaExecutor);

    await assignments.set(
      "worker-gamma",
      "worker-node-2",
      join(rootTmpDir, "node2", "homes", "worker-gamma"),
    );

    log({
      step: "5.create-worker-gamma",
      action: "register-and-assign",
      to: "worker-node-2",
      message: "worker-gamma on central, assigned to different physical node",
      details: {
        centralAgents: centralA2A.listAgentCards().map((a) => a.agentId),
        node2Assignments: assignments.listByNode("worker-node-2").map((a) => a.agentId),
      },
    });

    expect(centralA2A.hasAgent("worker-gamma")).toBe(true);
    expect(assignments.get("worker-gamma")!.nodeId).toBe("worker-node-2");
  });

  // ==========================================================================
  // Step 6: Multi-node communication verification
  // ==========================================================================
  it("Step 6a: worker-alpha → worker-gamma routes LOCAL (co-located on central)", async () => {
    const msg = "Gamma, deploy the API gateway when ready";

    log({
      step: "6a.alpha-to-gamma",
      action: "a2a-send",
      from: "worker-alpha",
      to: "worker-gamma",
      message: msg,
      route: "local",
    });

    const result = await centralClient.sendMessage("worker-gamma", msg);

    log({
      step: "6a.alpha-to-gamma",
      action: "a2a-response",
      from: "worker-gamma",
      response: result.response,
      route: "local",
    });

    expect(result.state).toBe("completed");
    expect(result.response).toContain("[worker-gamma] echo:");
    expect(result.response).toContain(msg);
  });

  it("Step 6b: worker-alpha → sysadmin routes REMOTE to node-1", async () => {
    const request = "Install Node.js 22 LTS for the dashboard project";

    log({
      step: "6b.alpha-sysadmin",
      action: "sysadmin-request",
      from: "worker-alpha",
      to: "sysadmin@worker-node-1",
      message: request,
      route: "remote",
      endpoint: node1Url,
    });

    const result = await centralClient.sendSysadminRequest("sysadmin", request, {
      urgency: "normal",
      project: "dashboard",
      fromHome: "worker-alpha",
    });

    log({
      step: "6b.alpha-sysadmin",
      action: "sysadmin-response",
      from: "sysadmin@worker-node-1",
      response: result.response,
      route: "remote",
      endpoint: node1Url,
    });

    expect(result.state).toBe("completed");
    // Sysadmin on node-1 echoes with its labeled ID
    expect(result.response).toContain("[sysadmin@worker-node-1] echo:");
    expect(result.response).toContain(request);
  });

  it("Step 6c: worker-gamma → sysadmin routes REMOTE to node-2", async () => {
    const request = "Open port 8080 for the API gateway service";

    log({
      step: "6c.gamma-sysadmin",
      action: "sysadmin-request",
      from: "worker-gamma",
      to: "sysadmin@worker-node-2",
      message: request,
      route: "remote",
      endpoint: node2Url,
    });

    const result = await centralClient.sendSysadminRequest("sysadmin", request, {
      urgency: "high",
      project: "api-gateway",
      fromHome: "worker-gamma",
    });

    log({
      step: "6c.gamma-sysadmin",
      action: "sysadmin-response",
      from: "sysadmin@worker-node-2",
      response: result.response,
      route: "remote",
      endpoint: node2Url,
    });

    expect(result.state).toBe("completed");
    // Sysadmin on node-2 echoes with its labeled ID
    expect(result.response).toContain("[sysadmin@worker-node-2] echo:");
    expect(result.response).toContain(request);
  });

  // ==========================================================================
  // Step 7: Migration — worker-alpha from node-1 to node-2
  // ==========================================================================
  it("Step 7: full migration lifecycle for worker-alpha (node-1 → node-2) via orchestrator", async () => {
    // Pre-migration: verify agent is not frozen
    const preMigrationGuard = checkFrozenStatus("worker-alpha", ticketStore);
    expect(preMigrationGuard.rejected).toBe(false);

    log({
      step: "7.orchestrator-migration",
      action: "pre-check",
      from: "worker-alpha",
      details: { frozenGuardRejected: false, homeState: homeManager.get("worker-alpha@central-node")!.state },
    });

    // RUN — single orchestrator call drives the full lifecycle over real HTTP
    const result = await migrationOrchestrator.run("worker-alpha", "worker-node-2", "orchestrator_rebalance");
    migrationId = result.migrationId;

    log({
      step: "7.orchestrator-migration",
      action: "orchestrator-result",
      from: "worker-alpha",
      to: "worker-node-2",
      phase: result.finalPhase,
      details: {
        success: result.success,
        migrationId: result.migrationId,
        finalPhase: result.finalPhase,
        warnings: result.warnings,
      },
    });

    expect(result.success).toBe(true);
    expect(result.finalPhase).toBe("COMPLETED");

    // Verify source home is RETIRED
    const sourceHome = homeManager.get("worker-alpha@central-node");
    expect(sourceHome!.state).toBe("RETIRED");

    // Verify frozen guard is cleared
    const postMigrationGuard = checkFrozenStatus("worker-alpha", ticketStore);
    expect(postMigrationGuard.rejected).toBe(false);

    // No active migrations
    expect(migrationEngine.listActive()).toHaveLength(0);

    log({
      step: "7.orchestrator-migration",
      action: "post-migration-verify",
      details: {
        sourceHomeState: "RETIRED",
        frozenGuardRejected: false,
        activeMigrations: 0,
      },
    });
  });

  // ==========================================================================
  // Step 8: POST_MIGRATION verification
  // ==========================================================================
  it("Step 8: POST_MIGRATION.md exists in new home and agent processes it", async () => {
    // Write POST_MIGRATION.md into the rehydrated target home
    const postMigrationContent = [
      "# Post-Migration Tasks",
      "",
      "Migration: worker-alpha from worker-node-1 → worker-node-2",
      "",
      "## Required Actions",
      "- [ ] Resume active conversations with worker-beta",
      "- [ ] Re-provision API keys for dashboard project",
      "- [ ] Verify file access to portable storage",
      "- [ ] Update local environment configuration",
      "",
      "## Context",
      "Previously working on dashboard component for project-X.",
      "Last interaction with worker-beta was a code review.",
    ].join("\n");

    await writeFile(join(targetHomePath, "POST_MIGRATION.md"), postMigrationContent);

    log({
      step: "8.post-migration",
      action: "write-post-migration",
      details: { path: join(targetHomePath, "POST_MIGRATION.md") },
    });

    // Verify file exists
    const hasTasks = await hasPostMigrationTasks(targetHomePath);
    expect(hasTasks).toBe(true);

    log({
      step: "8.post-migration",
      action: "check-exists",
      details: { hasTasks: true },
    });

    // Agent reads the tasks
    const content = await readPostMigrationTasks(targetHomePath);
    expect(content).not.toBeNull();
    expect(content).toContain("Post-Migration Tasks");
    expect(content).toContain("Resume active conversations");
    expect(content).toContain("Re-provision API keys");

    log({
      step: "8.post-migration",
      action: "read-tasks",
      message: "Agent reads POST_MIGRATION.md",
      response: content!.split("\n")[0],
      details: { contentLength: content!.length },
    });

    // Agent acknowledges by clearing the file
    await clearPostMigrationTasks(targetHomePath);
    const hasTasksAfterClear = await hasPostMigrationTasks(targetHomePath);
    expect(hasTasksAfterClear).toBe(false);

    log({
      step: "8.post-migration",
      action: "clear-tasks",
      message: "Agent processed and cleared POST_MIGRATION.md",
      details: { hasTasksAfterClear: false },
    });
  });

  // ==========================================================================
  // Step 9: Post-migration portable data continuity
  // ==========================================================================
  it("Step 9a: portable data is accessible at the new location", async () => {
    // Verify all expected files survived migration
    const soulContent = await readFile(join(targetHomePath, "SOUL.md"), "utf-8");
    expect(soulContent).toContain("worker-alpha");

    const toolsContent = await readFile(join(targetHomePath, "toolkit", "tools.json"), "utf-8");
    const tools = JSON.parse(toolsContent) as { agent: string; tools: string[] };
    expect(tools.agent).toBe("worker-alpha");
    expect(tools.tools).toContain("echo");

    const playbookContent = await readFile(
      join(targetHomePath, "playbooks", "default.md"),
      "utf-8",
    );
    expect(playbookContent).toContain("Default Playbook");

    const knowledgeContent = await readFile(
      join(targetHomePath, "knowledge", "active", "context.md"),
      "utf-8",
    );
    expect(knowledgeContent).toContain("worker-alpha");

    const portableData = await readFile(join(targetHomePath, "portable-data.txt"), "utf-8");
    expect(portableData).toContain("Critical portable data");
    expect(portableData).toContain("must survive migration");

    log({
      step: "9a.data-continuity",
      action: "verify-portable-data",
      details: {
        soulMd: true,
        toolkitJson: true,
        playbook: true,
        knowledge: true,
        portableData: true,
      },
    });
  });

  it("Step 9b: worker-alpha can still communicate after migration", async () => {
    // Worker-alpha is still on the central A2AServer — migration doesn't
    // remove the LLM session, just changes the physical node assignment
    const msg = "Post-migration task: deploy updated dashboard";

    log({
      step: "9b.post-migration-work",
      action: "a2a-send",
      from: "test-client",
      to: "worker-alpha",
      message: msg,
      route: "local",
    });

    const result = await centralClient.sendMessage("worker-alpha", msg);

    log({
      step: "9b.post-migration-work",
      action: "a2a-response",
      from: "worker-alpha",
      response: result.response,
      route: "local",
    });

    expect(result.state).toBe("completed");
    expect(result.response).toContain("[worker-alpha] echo:");
    expect(result.response).toContain(msg);
  });

  it("Step 9c: sysadmin requests now route to node-2 (not node-1)", async () => {
    // Update the assignment store to reflect migration
    const { reassign } = createCentralExecution(assignments);
    await reassign("worker-alpha", "worker-node-2");

    const updatedAssignment = assignments.get("worker-alpha");
    expect(updatedAssignment).not.toBeNull();
    expect(updatedAssignment!.nodeId).toBe("worker-node-2");
    // Portable path should be preserved
    expect(updatedAssignment!.portablePath).toBe(sourceHomePath);

    log({
      step: "9c.sysadmin-reroute",
      action: "reassign",
      from: "worker-node-1",
      to: "worker-node-2",
      details: {
        agentId: "worker-alpha",
        oldNode: "worker-node-1",
        newNode: "worker-node-2",
      },
    });

    // Now sysadmin requests from worker-alpha should route to node-2's sysadmin
    const request = "Install Python 3.12 for ML pipeline";

    log({
      step: "9c.sysadmin-reroute",
      action: "sysadmin-request",
      from: "worker-alpha",
      to: "sysadmin@worker-node-2",
      message: request,
      route: "remote",
      endpoint: node2Url,
    });

    const result = await centralClient.sendSysadminRequest("sysadmin", request, {
      urgency: "normal",
      project: "ml-pipeline",
      fromHome: "worker-alpha",
    });

    log({
      step: "9c.sysadmin-reroute",
      action: "sysadmin-response",
      from: "sysadmin@worker-node-2",
      response: result.response,
      route: "remote",
      endpoint: node2Url,
    });

    expect(result.state).toBe("completed");
    // KEY ASSERTION: Now routes to node-2, not node-1
    expect(result.response).toContain("[sysadmin@worker-node-2] echo:");
    expect(result.response).toContain(request);
    // Must NOT contain node-1
    expect(result.response).not.toContain("worker-node-1");
  });

  it("Step 9d: worker-gamma sysadmin still routes to node-2 (unchanged)", async () => {
    const request = "Check disk usage on worker-node-2";

    log({
      step: "9d.gamma-sysadmin-unchanged",
      action: "sysadmin-request",
      from: "worker-gamma",
      to: "sysadmin@worker-node-2",
      message: request,
      route: "remote",
      endpoint: node2Url,
    });

    const result = await centralClient.sendSysadminRequest("sysadmin", request, {
      urgency: "low",
      fromHome: "worker-gamma",
    });

    log({
      step: "9d.gamma-sysadmin-unchanged",
      action: "sysadmin-response",
      from: "sysadmin@worker-node-2",
      response: result.response,
      route: "remote",
      endpoint: node2Url,
    });

    expect(result.state).toBe("completed");
    expect(result.response).toContain("[sysadmin@worker-node-2] echo:");
  });

  it("Step 9e: concurrent cross-worker + sysadmin requests all succeed", async () => {
    log({
      step: "9e.concurrent-final",
      action: "concurrent-burst",
      message: "Sending 5 concurrent A2A requests (3 local + 2 remote sysadmin)",
    });

    const [r1, r2, r3, r4, r5] = await Promise.all([
      centralClient.sendMessage("worker-alpha", "concurrent-alpha"),
      centralClient.sendMessage("worker-beta", "concurrent-beta"),
      centralClient.sendMessage("worker-gamma", "concurrent-gamma"),
      centralClient.sendSysadminRequest("sysadmin", "concurrent-sysadmin-alpha", {
        fromHome: "worker-alpha",
      }),
      centralClient.sendSysadminRequest("sysadmin", "concurrent-sysadmin-gamma", {
        fromHome: "worker-gamma",
      }),
    ]);

    log({
      step: "9e.concurrent-final",
      action: "concurrent-results",
      details: {
        alpha: r1.state,
        beta: r2.state,
        gamma: r3.state,
        sysadminAlpha: r4.state,
        sysadminGamma: r5.state,
      },
    });

    // All workers respond locally
    expect(r1.state).toBe("completed");
    expect(r1.response).toContain("[worker-alpha]");
    expect(r2.state).toBe("completed");
    expect(r2.response).toContain("[worker-beta]");
    expect(r3.state).toBe("completed");
    expect(r3.response).toContain("[worker-gamma]");

    // Sysadmin requests route to correct nodes
    expect(r4.state).toBe("completed");
    expect(r4.response).toContain("[sysadmin@worker-node-2]"); // alpha migrated to node-2
    expect(r5.state).toBe("completed");
    expect(r5.response).toContain("[sysadmin@worker-node-2]"); // gamma was always on node-2
  });
});
