/**
 * Central Node Gateway Pipeline E2E Lifecycle Integration Test
 *
 * Exercises the FULL central-topology lifecycle through the GATEWAY PIPELINE:
 *   1. Worker creation + attachment to physical nodes
 *   2. Worker task execution via FlockExecutor → Gateway HTTP pipeline
 *   3. Multiple workers on same node
 *   4. Same-node worker↔worker communication (through gateway pipeline)
 *   5. Third worker on different node
 *   6. Multi-node communication (worker→worker LOCAL via gateway, worker→sysadmin REMOTE HTTP)
 *   7. Migration: worker-alpha from node-1 to node-2 (full lifecycle)
 *   8. POST_MIGRATION.md verification
 *   9. Post-migration portable data continuity + sysadmin re-routing
 *
 * KEY DIFFERENCE from central-e2e.test.ts:
 *   Worker agents use FlockExecutor + createGatewaySessionSend (real HTTP to gateway)
 *   instead of createEchoExecutor (instant in-process echo).
 *
 * Flow for worker messages:
 *   A2A message → FlockExecutor → HTTP POST to Test Gateway Server
 *   → gateway returns agent response → FlockExecutor captures response
 *   → TaskStore updated → AuditLog appended → A2A task completed
 *
 * ADDITIONALLY verifies (things the echo test couldn't check):
 *   - TaskStore records: submitted → working → completed lifecycle
 *   - AuditLog entries: each completed task is audited
 *   - Gateway request log: correct agent IDs, messages, and headers
 *   - Response format: "via gateway" proves messages traverse the pipeline
 *
 * Architecture:
 *   Central "node":  In-process A2AServer + FlockExecutors → Gateway HTTP
 *   Worker Node 1:   Real HTTP server with sysadmin echo agent
 *   Worker Node 2:   Real HTTP server with sysadmin echo agent
 *   Test Gateway:    Real HTTP server simulating /v1/chat/completions
 *
 * NO mocks, NO Docker — real HTTP for all cross-boundary communication.
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
import { createFlockExecutor } from "../../src/transport/executor.js";
import type { SessionSendFn } from "../../src/transport/executor.js";
import { createGatewaySessionSend } from "../../src/transport/gateway-send.js";
import { createMemoryDatabase } from "../../src/db/memory.js";
import type { FlockDatabase } from "../../src/db/interface.js";
import { createHomeManager } from "../../src/homes/manager.js";
import type { HomeManager } from "../../src/homes/manager.js";
import { createMigrationEngine } from "../../src/migration/engine.js";
import type { MigrationEngine } from "../../src/migration/engine.js";
import { createTicketStore } from "../../src/migration/ticket-store.js";
import type { MigrationTicketStore } from "../../src/migration/ticket-store.js";
import { createAuditLog } from "../../src/audit/log.js";
import type { AuditLog } from "../../src/audit/log.js";
import { createSnapshot, verifySnapshot } from "../../src/migration/snapshot.js";
import { rehydrate } from "../../src/migration/rehydrate.js";
import {
  hasPostMigrationTasks,
  readPostMigrationTasks,
  clearPostMigrationTasks,
} from "../../src/migration/post-migration.js";
import { checkFrozenStatus } from "../../src/migration/frozen-guard.js";
import type { PluginLogger } from "../../src/types.js";
import type { MigrationPayload } from "../../src/migration/types.js";

// ---------------------------------------------------------------------------
// Gateway Request Log
// ---------------------------------------------------------------------------

interface GatewayRequest {
  timestamp: number;
  agentId: string;
  model: string;
  message: string;
  authorization: string;
}

const gatewayRequests: GatewayRequest[] = [];

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
  route?: "local" | "remote" | "gateway";
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
// Test Gateway HTTP Server (simulates OpenClaw gateway /v1/chat/completions)
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatCompletionRequestBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
}

/** Type guard for chat completion request body. */
function isChatCompletionRequest(body: unknown): body is ChatCompletionRequestBody {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.model !== "string") return false;
  if (!Array.isArray(obj.messages)) return false;
  for (const msg of obj.messages) {
    if (typeof msg !== "object" || msg === null) return false;
    const m = msg as Record<string, unknown>;
    if (typeof m.role !== "string" || typeof m.content !== "string") return false;
  }
  return true;
}

function createGatewayHttpServer(): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
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

      if (!isChatCompletionRequest(body)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid chat completion request" }));
        return;
      }

      const agentIdHeader = req.headers["x-openclaw-agent-id"] ?? req.headers["x-clawdbot-agent-id"];
      const agentId = typeof agentIdHeader === "string" ? agentIdHeader : "unknown";
      const authHeader = req.headers["authorization"];
      const authorization = typeof authHeader === "string" ? authHeader : "";

      // Extract the last user message
      const lastUserMsg = body.messages
        .filter((m) => m.role === "user")
        .at(-1);
      const messageContent = lastUserMsg?.content ?? "";

      // Log this gateway request
      gatewayRequests.push({
        timestamp: Date.now(),
        agentId,
        model: body.model,
        message: messageContent,
        authorization,
      });

      log({
        step: "gateway",
        action: "chat-completion",
        from: agentId,
        message: messageContent.slice(0, 100),
        route: "gateway",
        details: { model: body.model, messageCount: body.messages.length },
      });

      // Return OpenAI-compatible response with "via gateway" marker
      const responseContent = `[${agentId} via gateway] processed: ${messageContent}`;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-test-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: responseContent },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

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

async function startGatewayServer(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (typeof addr === "object" && addr !== null) {
    return addr.port;
  }
  throw new Error("Failed to get gateway server address");
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

// Gateway HTTP server
let gatewayHttp: http.Server;
let gatewayPort: number;

// Central node infrastructure
let centralA2A: A2AServer;
let centralClient: A2AClient;
let assignments: AssignmentStore;
let registry: NodeRegistry;
let homeManager: HomeManager;
let migrationEngine: MigrationEngine;
let ticketStore: MigrationTicketStore;

// Shared database, TaskStore, and AuditLog
let db: FlockDatabase;
let auditLog: AuditLog;
let sessionSend: SessionSendFn;

// Filesystem temp roots
let rootTmpDir: string;
let sourceHomePath: string;
let targetHomePath: string;
let snapshotTmpDir: string;

// Migration state carried between steps
let migrationId: string;

// ---------------------------------------------------------------------------
// Setup & Teardown
// ---------------------------------------------------------------------------

describe("Central Node Gateway Pipeline E2E Lifecycle", () => {
  beforeAll(async () => {
    // --- Temp directory structure ---
    rootTmpDir = await mkdtemp(join(tmpdir(), "flock-central-gw-e2e-"));
    sourceHomePath = join(rootTmpDir, "node1", "homes", "worker-alpha");
    targetHomePath = join(rootTmpDir, "node2", "homes", "worker-alpha");
    snapshotTmpDir = join(rootTmpDir, "snapshots");

    log({
      step: "0.setup",
      action: "create-temp-dirs",
      details: { rootTmpDir, sourceHomePath, targetHomePath, snapshotTmpDir },
    });

    // --- Test Gateway HTTP Server ---
    gatewayHttp = createGatewayHttpServer();
    gatewayPort = await startGatewayServer(gatewayHttp);

    log({
      step: "0.setup",
      action: "start-gateway-server",
      endpoint: `http://127.0.0.1:${gatewayPort}`,
      details: { port: gatewayPort },
    });

    // --- Gateway session send (shared by all worker FlockExecutors) ---
    sessionSend = createGatewaySessionSend({
      port: gatewayPort,
      token: "test-token",
      logger,
    });

    // --- Worker Node 1: HTTP server with sysadmin ---
    node1A2A = new A2AServer({ basePath: "/flock", logger });
    const { card: sysadmin1Card, meta: sysadmin1Meta } = createSysadminCard(
      "worker-node-1",
      "http://localhost/flock/a2a/sysadmin",
    );
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
    node2A2A = new A2AServer({ basePath: "/flock", logger });
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
    db = createMemoryDatabase();
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
    auditLog = createAuditLog({ db, logger });

    const resolve = createCentralResolver();
    const resolveSysadmin = createCentralSysadminResolver(assignments, registry);

    centralClient = createA2AClient({
      localServer: centralA2A,
      resolve,
      resolveSysadmin,
      logger,
    });

    ticketStore = createTicketStore({ logger });

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

    log({
      step: "0.setup",
      action: "create-central-node",
      details: {
        topology: "central",
        pipeline: "gateway",
        registryNodes: registry.list().map((n) => n.nodeId),
        gatewayPort,
      },
    });
  });

  afterAll(async () => {
    // Stop HTTP servers
    await Promise.all([
      stopServer(node1Http),
      stopServer(node2Http),
      stopServer(gatewayHttp),
    ]);

    // Clean up temp directories
    await rm(rootTmpDir, { recursive: true, force: true });

    // --- Dump full structured test log ---
    console.log("\n" + "═".repeat(80));
    console.log("  CENTRAL NODE GATEWAY PIPELINE E2E — FULL STRUCTURED TEST LOG");
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
    console.log(`  Gateway requests:  ${gatewayRequests.length}`);
    console.log("═".repeat(80) + "\n");
  });

  // ==========================================================================
  // Step 1: Worker agent creation + attachment to worker node
  // ==========================================================================
  it("Step 1: creates worker-alpha with FlockExecutor→gateway and assigns to worker-node-1", async () => {
    // Register worker-alpha on central A2AServer with FlockExecutor (not echo)
    const { card: alphaCard, meta: alphaMeta } = createWorkerCard(
      "worker-alpha",
      "central-node",
      "http://central/flock/a2a/worker-alpha",
    );
    const alphaExecutor = createFlockExecutor({
      flockMeta: alphaMeta,
      sessionSend,
      audit: auditLog,
      taskStore: db.tasks,
      logger,
    });
    centralA2A.registerAgent("worker-alpha", alphaCard, alphaMeta, alphaExecutor);

    log({
      step: "1.create-worker-alpha",
      action: "register-agent",
      to: "central-a2a",
      message: "Registered worker-alpha FlockExecutor→gateway on central A2AServer",
      route: "gateway",
      details: { executor: "FlockExecutor", pipeline: "gateway" },
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

    // Verify no gateway requests yet
    expect(gatewayRequests.length).toBe(0);
  });

  // ==========================================================================
  // Step 2: Worker does work via gateway pipeline
  // ==========================================================================
  it("Step 2: worker-alpha receives a task and produces output via gateway pipeline", async () => {
    const taskMessage = "Build the dashboard component for project-X";
    const gwCountBefore = gatewayRequests.length;
    const taskCountBefore = db.tasks.count();
    const auditCountBefore = auditLog.count();

    log({
      step: "2.worker-task",
      action: "a2a-send",
      from: "test-client",
      to: "worker-alpha",
      message: taskMessage,
      route: "gateway",
    });

    const result = await centralClient.sendMessage("worker-alpha", taskMessage);

    log({
      step: "2.worker-task",
      action: "a2a-response",
      from: "worker-alpha",
      response: result.response,
      route: "gateway",
      details: { state: result.state, taskId: result.taskId },
    });

    // A2A response assertions
    expect(result.state).toBe("completed");
    expect(result.response).toContain("via gateway");
    expect(result.response).toContain("[worker-alpha via gateway]");
    expect(result.response).toContain(taskMessage);
    expect(result.taskId).toBeTruthy();
    expect(result.artifacts.length).toBeGreaterThan(0);

    // TaskStore verification: record created with correct lifecycle
    const taskRecord = db.tasks.get(result.taskId);
    expect(taskRecord).not.toBeNull();
    expect(taskRecord!.state).toBe("completed");
    expect(taskRecord!.toAgentId).toBe("worker-alpha");
    expect(taskRecord!.messageType).toBe("a2a-message");
    expect(taskRecord!.summary).toContain(taskMessage.slice(0, 100));
    expect(taskRecord!.responseText).toContain("via gateway");
    expect(taskRecord!.completedAt).not.toBeNull();
    expect(taskRecord!.completedAt!).toBeGreaterThanOrEqual(taskRecord!.createdAt);

    log({
      step: "2.worker-task",
      action: "verify-task-store",
      details: {
        taskId: result.taskId,
        state: taskRecord!.state,
        fromAgentId: taskRecord!.fromAgentId,
        toAgentId: taskRecord!.toAgentId,
        duration: taskRecord!.completedAt! - taskRecord!.createdAt,
      },
    });

    // AuditLog verification: entry created for completed task
    expect(auditLog.count()).toBe(auditCountBefore + 1);
    const auditEntries = auditLog.query({ homeId: "worker-alpha@central-node" });
    expect(auditEntries.length).toBeGreaterThan(0);
    const latestAudit = auditEntries.at(-1)!;
    expect(latestAudit.action).toBe("a2a-message");
    expect(latestAudit.result).toBe("completed");
    expect(latestAudit.level).toBe("GREEN");
    expect(latestAudit.detail).toContain(taskMessage.slice(0, 100));

    log({
      step: "2.worker-task",
      action: "verify-audit-log",
      details: {
        action: latestAudit.action,
        level: latestAudit.level,
        result: latestAudit.result,
      },
    });

    // Gateway request log verification
    expect(gatewayRequests.length).toBe(gwCountBefore + 1);
    const gwReq = gatewayRequests.at(-1)!;
    expect(gwReq.agentId).toBe("worker-alpha");
    expect(gwReq.model).toBe("openclaw/worker-alpha");
    expect(gwReq.message).toContain(taskMessage);
    expect(gwReq.authorization).toBe("Bearer test-token");

    log({
      step: "2.worker-task",
      action: "verify-gateway-log",
      details: {
        agentId: gwReq.agentId,
        model: gwReq.model,
        hasAuth: gwReq.authorization.startsWith("Bearer "),
      },
    });

    // TaskStore count incremented
    expect(db.tasks.count()).toBe(taskCountBefore + 1);
  });

  // ==========================================================================
  // Step 3: Second worker deployed to same node
  // ==========================================================================
  it("Step 3: creates worker-beta with FlockExecutor→gateway and assigns to worker-node-1 (same node)", async () => {
    const { card: betaCard, meta: betaMeta } = createWorkerCard(
      "worker-beta",
      "central-node",
      "http://central/flock/a2a/worker-beta",
    );
    const betaExecutor = createFlockExecutor({
      flockMeta: betaMeta,
      sessionSend,
      audit: auditLog,
      taskStore: db.tasks,
      logger,
    });
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
      message: "worker-beta FlockExecutor→gateway registered on central, assigned to worker-node-1 (same as alpha)",
      route: "gateway",
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
  // Step 4: Same-node worker↔worker communication (through gateway)
  // ==========================================================================
  it("Step 4: worker-alpha ↔ worker-beta communicate through gateway pipeline", async () => {
    const gwCountBefore = gatewayRequests.length;
    const taskCountBefore = db.tasks.count();

    // Alpha → Beta
    const msgAlphaToBeta = "Hey beta, can you review my dashboard code?";

    log({
      step: "4.alpha-to-beta",
      action: "a2a-send",
      from: "worker-alpha",
      to: "worker-beta",
      message: msgAlphaToBeta,
      route: "gateway",
    });

    const alphaToBeta = await centralClient.sendMessage("worker-beta", msgAlphaToBeta);

    log({
      step: "4.alpha-to-beta",
      action: "a2a-response",
      from: "worker-beta",
      response: alphaToBeta.response,
      route: "gateway",
    });

    expect(alphaToBeta.state).toBe("completed");
    expect(alphaToBeta.response).toContain("[worker-beta via gateway]");
    expect(alphaToBeta.response).toContain(msgAlphaToBeta);

    // Verify TaskStore record for alpha→beta
    const alphaToBetaTask = db.tasks.get(alphaToBeta.taskId);
    expect(alphaToBetaTask).not.toBeNull();
    expect(alphaToBetaTask!.state).toBe("completed");
    expect(alphaToBetaTask!.toAgentId).toBe("worker-beta");

    // Beta → Alpha
    const msgBetaToAlpha = "Sure alpha, the code looks good. Ship it!";

    log({
      step: "4.beta-to-alpha",
      action: "a2a-send",
      from: "worker-beta",
      to: "worker-alpha",
      message: msgBetaToAlpha,
      route: "gateway",
    });

    const betaToAlpha = await centralClient.sendMessage("worker-alpha", msgBetaToAlpha);

    log({
      step: "4.beta-to-alpha",
      action: "a2a-response",
      from: "worker-alpha",
      response: betaToAlpha.response,
      route: "gateway",
    });

    expect(betaToAlpha.state).toBe("completed");
    expect(betaToAlpha.response).toContain("[worker-alpha via gateway]");
    expect(betaToAlpha.response).toContain(msgBetaToAlpha);

    // Verify TaskStore record for beta→alpha
    const betaToAlphaTask = db.tasks.get(betaToAlpha.taskId);
    expect(betaToAlphaTask).not.toBeNull();
    expect(betaToAlphaTask!.state).toBe("completed");
    expect(betaToAlphaTask!.toAgentId).toBe("worker-alpha");

    // Both communications went through the gateway (2 new requests)
    expect(gatewayRequests.length).toBe(gwCountBefore + 2);

    // Verify gateway saw both agents
    const recentGwReqs = gatewayRequests.slice(gwCountBefore);
    expect(recentGwReqs[0].agentId).toBe("worker-beta");
    expect(recentGwReqs[1].agentId).toBe("worker-alpha");

    // TaskStore has 2 new records
    expect(db.tasks.count()).toBe(taskCountBefore + 2);

    log({
      step: "4.bidirectional",
      action: "verify-gateway-log",
      details: {
        gatewayRequestsForStep: 2,
        taskRecordsCreated: 2,
        agents: recentGwReqs.map((r) => r.agentId),
      },
    });
  });

  // ==========================================================================
  // Step 5: Third worker on different node
  // ==========================================================================
  it("Step 5: creates worker-gamma with FlockExecutor→gateway and assigns to worker-node-2", async () => {
    const { card: gammaCard, meta: gammaMeta } = createWorkerCard(
      "worker-gamma",
      "central-node",
      "http://central/flock/a2a/worker-gamma",
    );
    const gammaExecutor = createFlockExecutor({
      flockMeta: gammaMeta,
      sessionSend,
      audit: auditLog,
      taskStore: db.tasks,
      logger,
    });
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
      message: "worker-gamma FlockExecutor→gateway on central, assigned to different physical node",
      route: "gateway",
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
  it("Step 6a: worker-alpha → worker-gamma routes through gateway (co-located on central)", async () => {
    const gwCountBefore = gatewayRequests.length;
    const msg = "Gamma, deploy the API gateway when ready";

    log({
      step: "6a.alpha-to-gamma",
      action: "a2a-send",
      from: "worker-alpha",
      to: "worker-gamma",
      message: msg,
      route: "gateway",
    });

    const result = await centralClient.sendMessage("worker-gamma", msg);

    log({
      step: "6a.alpha-to-gamma",
      action: "a2a-response",
      from: "worker-gamma",
      response: result.response,
      route: "gateway",
    });

    expect(result.state).toBe("completed");
    expect(result.response).toContain("[worker-gamma via gateway]");
    expect(result.response).toContain(msg);

    // Verify gateway received the request with correct agent ID
    expect(gatewayRequests.length).toBe(gwCountBefore + 1);
    expect(gatewayRequests.at(-1)!.agentId).toBe("worker-gamma");

    // TaskStore record created
    const taskRecord = db.tasks.get(result.taskId);
    expect(taskRecord).not.toBeNull();
    expect(taskRecord!.toAgentId).toBe("worker-gamma");
    expect(taskRecord!.state).toBe("completed");
  });

  it("Step 6b: worker-alpha → sysadmin routes REMOTE to node-1 (bypasses gateway)", async () => {
    const gwCountBefore = gatewayRequests.length;
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
    // Sysadmin on node-1 echoes with its labeled ID (NOT via gateway)
    expect(result.response).toContain("[sysadmin@worker-node-1] echo:");
    expect(result.response).toContain(request);

    // Gateway should NOT have received this request (sysadmin is remote HTTP, not gateway)
    expect(gatewayRequests.length).toBe(gwCountBefore);

    log({
      step: "6b.alpha-sysadmin",
      action: "verify-no-gateway",
      details: {
        gatewayRequestsUnchanged: true,
        route: "remote-http-direct",
      },
    });
  });

  it("Step 6c: worker-gamma → sysadmin routes REMOTE to node-2 (bypasses gateway)", async () => {
    const gwCountBefore = gatewayRequests.length;
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
    // Sysadmin on node-2 echoes with its labeled ID (NOT via gateway)
    expect(result.response).toContain("[sysadmin@worker-node-2] echo:");
    expect(result.response).toContain(request);

    // Gateway should NOT have received this request
    expect(gatewayRequests.length).toBe(gwCountBefore);
  });

  // ==========================================================================
  // Step 7: Migration — worker-alpha from node-1 to node-2
  // ==========================================================================
  it("Step 7: full migration lifecycle for worker-alpha (node-1 → node-2)", async () => {
    // --- 7a: Pre-migration frozen guard check ---
    const preMigrationGuard = checkFrozenStatus("worker-alpha", ticketStore);
    expect(preMigrationGuard.rejected).toBe(false);

    log({
      step: "7a.pre-migration",
      action: "frozen-guard-check",
      from: "worker-alpha",
      details: { rejected: false },
    });

    // --- 7b: Initiate migration ---
    const ticket = migrationEngine.initiate(
      "worker-alpha",
      "worker-node-2",
      "orchestrator_rebalance",
    );
    migrationId = ticket.migrationId;

    log({
      step: "7b.initiate",
      action: "migration-initiate",
      from: "worker-alpha",
      to: "worker-node-2",
      phase: "REQUESTED",
      details: {
        migrationId,
        reason: "orchestrator_rebalance",
        sourceHome: ticket.source.homeId,
        targetHome: ticket.target.homeId,
        ownershipHolder: ticket.ownershipHolder,
      },
    });

    expect(ticket.phase).toBe("REQUESTED");
    expect(ticket.ownershipHolder).toBe("source");
    expect(ticket.source.nodeId).toBe("central-node");
    expect(ticket.target.nodeId).toBe("worker-node-2");

    // --- 7c: REQUESTED → AUTHORIZED ---
    await migrationEngine.advancePhase(migrationId);
    const afterAuth = migrationEngine.getStatus(migrationId)!;

    log({
      step: "7c.authorize",
      action: "migration-advance",
      phase: "AUTHORIZED",
      details: { ownershipHolder: afterAuth.ownershipHolder },
    });

    expect(afterAuth.phase).toBe("AUTHORIZED");

    // --- 7d: AUTHORIZED → FREEZING (home transitions to FROZEN) ---
    await migrationEngine.advancePhase(migrationId);
    const afterFreeze = migrationEngine.getStatus(migrationId)!;

    log({
      step: "7d.freeze",
      action: "migration-advance",
      phase: "FREEZING",
      details: {
        homeState: homeManager.get("worker-alpha@central-node")!.state,
      },
    });

    expect(afterFreeze.phase).toBe("FREEZING");
    expect(homeManager.get("worker-alpha@central-node")!.state).toBe("FROZEN");

    // Frozen guard should now reject
    const midMigrationGuard = checkFrozenStatus("worker-alpha", ticketStore);
    expect(midMigrationGuard.rejected).toBe(true);
    expect(midMigrationGuard.estimatedDowntimeMs).toBeGreaterThan(0);

    log({
      step: "7d.freeze",
      action: "frozen-guard-check",
      from: "worker-alpha",
      details: {
        rejected: true,
        reason: midMigrationGuard.reason,
        estimatedDowntimeMs: midMigrationGuard.estimatedDowntimeMs,
      },
    });

    // --- 7e: FREEZING → FROZEN ---
    await migrationEngine.advancePhase(migrationId);
    expect(migrationEngine.getStatus(migrationId)!.phase).toBe("FROZEN");

    log({ step: "7e.frozen", action: "migration-advance", phase: "FROZEN" });

    // --- 7f: FROZEN → SNAPSHOTTING ---
    await migrationEngine.advancePhase(migrationId);
    expect(migrationEngine.getStatus(migrationId)!.phase).toBe("SNAPSHOTTING");

    log({ step: "7f.snapshotting", action: "migration-advance", phase: "SNAPSHOTTING" });

    // Create actual snapshot of portable storage
    const snapshotResult = await createSnapshot(
      sourceHomePath,
      migrationId,
      snapshotTmpDir,
      logger,
    );

    log({
      step: "7f.snapshotting",
      action: "snapshot-create",
      details: {
        archivePath: snapshotResult.archivePath,
        checksum: snapshotResult.checksum.slice(0, 16) + "…",
        sizeBytes: snapshotResult.sizeBytes,
      },
    });

    expect(snapshotResult.archivePath).toContain("agent-layer.tar.gz");
    expect(snapshotResult.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshotResult.sizeBytes).toBeGreaterThan(0);

    // --- 7g: SNAPSHOTTING → TRANSFERRING (home transitions to MIGRATING) ---
    await migrationEngine.advancePhase(migrationId);
    expect(migrationEngine.getStatus(migrationId)!.phase).toBe("TRANSFERRING");
    expect(homeManager.get("worker-alpha@central-node")!.state).toBe("MIGRATING");

    log({
      step: "7g.transfer",
      action: "migration-advance",
      phase: "TRANSFERRING",
      details: { homeState: "MIGRATING" },
    });

    // --- 7h: TRANSFERRING → VERIFYING ---
    await migrationEngine.advancePhase(migrationId);
    expect(migrationEngine.getStatus(migrationId)!.phase).toBe("VERIFYING");

    log({ step: "7h.verifying", action: "migration-advance", phase: "VERIFYING" });

    // Verify the snapshot checksum
    const verifyResult = await verifySnapshot(snapshotResult.archivePath, snapshotResult.checksum);

    log({
      step: "7h.verifying",
      action: "snapshot-verify",
      details: {
        verified: verifyResult.verified,
        computedChecksum: verifyResult.computedChecksum?.slice(0, 16) + "…",
      },
    });

    expect(verifyResult.verified).toBe(true);

    // --- 7i: VERIFYING → REHYDRATING (ownership transfers to target) ---
    const afterVerify = migrationEngine.handleVerification(migrationId, verifyResult);

    log({
      step: "7i.ownership-transfer",
      action: "migration-verify",
      phase: "REHYDRATING",
      details: {
        ownershipHolder: afterVerify.ownershipHolder,
        previousOwner: "source",
      },
    });

    expect(afterVerify.phase).toBe("REHYDRATING");
    expect(afterVerify.ownershipHolder).toBe("target");

    // Rehydrate to target location
    const archiveBuffer = await readFile(snapshotResult.archivePath);
    const payload: MigrationPayload = {
      portable: {
        archive: archiveBuffer,
        checksum: snapshotResult.checksum,
        sizeBytes: archiveBuffer.length,
      },
      agentIdentity: null, // Central mode — identity stays on central
      workState: { projects: [], capturedAt: Date.now() },
    };

    const rehydrateResult = await rehydrate(payload, targetHomePath, logger);

    log({
      step: "7i.rehydrate",
      action: "rehydrate",
      details: {
        success: rehydrateResult.success,
        targetPath: rehydrateResult.homePath,
        warnings: rehydrateResult.warnings,
      },
    });

    expect(rehydrateResult.success).toBe(true);

    // --- 7j: REHYDRATING → FINALIZING ---
    await migrationEngine.advancePhase(migrationId);
    expect(migrationEngine.getStatus(migrationId)!.phase).toBe("FINALIZING");

    log({ step: "7j.finalizing", action: "migration-advance", phase: "FINALIZING" });

    // --- 7k: Complete migration → COMPLETED ---
    const completed = await migrationEngine.complete(
      migrationId,
      "worker-alpha@worker-node-2",
      node2Url,
    );

    log({
      step: "7k.complete",
      action: "migration-complete",
      phase: "COMPLETED",
      details: {
        newHomeId: "worker-alpha@worker-node-2",
        newEndpoint: node2Url,
        sourceHomeState: homeManager.get("worker-alpha@central-node")!.state,
      },
    });

    expect(completed.phase).toBe("COMPLETED");

    // Source home should be RETIRED
    expect(homeManager.get("worker-alpha@central-node")!.state).toBe("RETIRED");

    // Frozen guard should clear
    const postMigrationGuard = checkFrozenStatus("worker-alpha", ticketStore);
    expect(postMigrationGuard.rejected).toBe(false);

    log({
      step: "7k.complete",
      action: "frozen-guard-check",
      from: "worker-alpha",
      details: { rejected: false },
    });

    // No active migrations remain
    expect(migrationEngine.listActive()).toHaveLength(0);
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

  it("Step 9b: worker-alpha can still communicate through gateway after migration", async () => {
    const gwCountBefore = gatewayRequests.length;
    const msg = "Post-migration task: deploy updated dashboard";

    log({
      step: "9b.post-migration-work",
      action: "a2a-send",
      from: "test-client",
      to: "worker-alpha",
      message: msg,
      route: "gateway",
    });

    const result = await centralClient.sendMessage("worker-alpha", msg);

    log({
      step: "9b.post-migration-work",
      action: "a2a-response",
      from: "worker-alpha",
      response: result.response,
      route: "gateway",
    });

    expect(result.state).toBe("completed");
    expect(result.response).toContain("[worker-alpha via gateway]");
    expect(result.response).toContain(msg);

    // Gateway received the request (pipeline still works post-migration)
    expect(gatewayRequests.length).toBe(gwCountBefore + 1);
    expect(gatewayRequests.at(-1)!.agentId).toBe("worker-alpha");

    // TaskStore record created
    const taskRecord = db.tasks.get(result.taskId);
    expect(taskRecord).not.toBeNull();
    expect(taskRecord!.state).toBe("completed");
    expect(taskRecord!.responseText).toContain("via gateway");
  });

  it("Step 9c: sysadmin requests now route to node-2 (not node-1)", async () => {
    const gwCountBefore = gatewayRequests.length;

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

    // Sysadmin requests do NOT go through gateway
    expect(gatewayRequests.length).toBe(gwCountBefore);
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

  it("Step 9e: concurrent cross-worker + sysadmin requests all succeed via gateway", async () => {
    const gwCountBefore = gatewayRequests.length;
    const taskCountBefore = db.tasks.count();

    log({
      step: "9e.concurrent-final",
      action: "concurrent-burst",
      message: "Sending 5 concurrent A2A requests (3 gateway workers + 2 remote sysadmin)",
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

    // All workers respond through gateway
    expect(r1.state).toBe("completed");
    expect(r1.response).toContain("[worker-alpha via gateway]");
    expect(r2.state).toBe("completed");
    expect(r2.response).toContain("[worker-beta via gateway]");
    expect(r3.state).toBe("completed");
    expect(r3.response).toContain("[worker-gamma via gateway]");

    // Sysadmin requests route to correct nodes (NOT through gateway)
    expect(r4.state).toBe("completed");
    expect(r4.response).toContain("[sysadmin@worker-node-2]"); // alpha migrated to node-2
    expect(r5.state).toBe("completed");
    expect(r5.response).toContain("[sysadmin@worker-node-2]"); // gamma was always on node-2

    // 3 worker messages went through gateway, 2 sysadmin did not
    expect(gatewayRequests.length).toBe(gwCountBefore + 3);

    // Verify gateway received the 3 worker requests
    const recentGwReqs = gatewayRequests.slice(gwCountBefore);
    const gwAgentIds = recentGwReqs.map((r) => r.agentId).sort();
    expect(gwAgentIds).toEqual(["worker-alpha", "worker-beta", "worker-gamma"]);

    // 3 new TaskStore records for worker messages
    expect(db.tasks.count()).toBeGreaterThanOrEqual(taskCountBefore + 3);

    log({
      step: "9e.concurrent-final",
      action: "verify-concurrent",
      details: {
        gatewayRequests: 3,
        sysadminRoutes: 2,
        taskRecords: db.tasks.count() - taskCountBefore,
      },
    });
  });

  // ==========================================================================
  // Step 10: Comprehensive gateway pipeline verification
  // ==========================================================================
  it("Step 10: comprehensive gateway pipeline and store verification", () => {
    // --- Gateway request log summary ---
    const totalGatewayRequests = gatewayRequests.length;
    expect(totalGatewayRequests).toBeGreaterThanOrEqual(7); // step2:1 + step4:2 + step6a:1 + step9b:1 + step9e:3 = 8

    // All gateway requests had correct auth
    for (const req of gatewayRequests) {
      expect(req.authorization).toBe("Bearer test-token");
    }

    // All gateway models follow the openclaw/<agentId> pattern
    for (const req of gatewayRequests) {
      expect(req.model).toBe(`openclaw/${req.agentId}`);
    }

    // All three worker agents used the gateway
    const uniqueAgents = new Set(gatewayRequests.map((r) => r.agentId));
    expect(uniqueAgents.has("worker-alpha")).toBe(true);
    expect(uniqueAgents.has("worker-beta")).toBe(true);
    expect(uniqueAgents.has("worker-gamma")).toBe(true);
    expect(uniqueAgents.size).toBe(3); // No other agents touched the gateway

    log({
      step: "10.verification",
      action: "gateway-summary",
      details: {
        totalRequests: totalGatewayRequests,
        uniqueAgents: Array.from(uniqueAgents),
        allAuthValid: true,
        allModelsValid: true,
      },
    });

    // --- TaskStore summary ---
    const allTasks = db.tasks.list();
    expect(allTasks.length).toBeGreaterThanOrEqual(7);

    // All tasks should be completed (no failures in this test)
    const completedTasks = db.tasks.list({ state: "completed" });
    expect(completedTasks.length).toBe(allTasks.length);

    // Every task has a non-null completedAt
    for (const t of completedTasks) {
      expect(t.completedAt).not.toBeNull();
      expect(t.completedAt!).toBeGreaterThanOrEqual(t.createdAt);
    }

    // Every worker task response contains "via gateway"
    const workerTasks = allTasks.filter((t) =>
      t.toAgentId.startsWith("worker-"),
    );
    for (const t of workerTasks) {
      expect(t.responseText).not.toBeNull();
      expect(t.responseText!).toContain("via gateway");
    }

    log({
      step: "10.verification",
      action: "task-store-summary",
      details: {
        totalTasks: allTasks.length,
        completedTasks: completedTasks.length,
        workerTasks: workerTasks.length,
        allResponsesViaGateway: true,
      },
    });

    // --- AuditLog summary ---
    const totalAuditEntries = auditLog.count();
    expect(totalAuditEntries).toBeGreaterThanOrEqual(7);

    // All worker audit entries are GREEN
    const workerAudits = auditLog.query({ action: "a2a-message" });
    for (const entry of workerAudits) {
      expect(entry.level).toBe("GREEN");
      expect(entry.result).toBe("completed");
    }

    log({
      step: "10.verification",
      action: "audit-log-summary",
      details: {
        totalAuditEntries,
        workerAudits: workerAudits.length,
        allGreen: true,
      },
    });

    // --- Cross-check: gateway requests ≈ worker task records ---
    // Each gateway request corresponds to a TaskStore record
    expect(workerTasks.length).toBe(totalGatewayRequests);

    log({
      step: "10.verification",
      action: "cross-check",
      details: {
        gatewayRequests: totalGatewayRequests,
        workerTaskRecords: workerTasks.length,
        auditEntries: workerAudits.length,
        match: totalGatewayRequests === workerTasks.length,
      },
    });
  });
});
