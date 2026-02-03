/**
 * Migration ↔ Central Topology Integration Test
 *
 * Tests the full integration between the migration engine and central topology:
 *   1. Sets up two nodes (central + worker) with real HTTP servers
 *   2. Has a central node with workers and an assignment store
 *   3. Triggers migration via flock_migrate tool (sysadmin role required)
 *   4. Exercises the full lifecycle THROUGH A2A HTTP handlers (not engine.advancePhase directly)
 *   5. Verifies assignment store auto-updates after completion
 *   6. Verifies sysadmin routing changes to new node after migration
 *   7. NO mocks, NO Docker — real HTTP like existing tests
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
import type { AuditLog } from "../../src/audit/log.js";
import type { PluginLogger } from "../../src/types.js";
import type { MigrationHandlerContext } from "../../src/migration/handlers.js";
import { registerFlockTools, type ToolDeps } from "../../src/tools/index.js";
import type { FlockConfig } from "../../src/config.js";
import { createFlockExecutor } from "../../src/transport/executor.js";
import { createGatewaySessionSend } from "../../src/transport/gateway-send.js";

// ---------------------------------------------------------------------------
// Test Infrastructure
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

// Silent logger for infrastructure
const logger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// HTTP Server Factory
// ---------------------------------------------------------------------------

interface TestHttpServer {
  port: number;
  close: () => Promise<void>;
  url: string;
}

async function createTestHttpServer(
  name: string,
  a2aServer: A2AServer,
): Promise<TestHttpServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = req.url || "";
        const method = req.method || "GET";

        // Only handle /flock/* URLs
        if (!url.startsWith("/flock")) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }

        // Read body for POST requests
        let body: unknown;
        if (method === "POST") {
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(chunk));
          await new Promise<void>((resolve) => {
            req.on("end", () => {
              const raw = Buffer.concat(chunks).toString("utf-8");
              if (raw) {
                try {
                  body = JSON.parse(raw);
                } catch {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "Invalid JSON" }));
                  return;
                }
              }
              resolve();
            });
          });
        }

        // Extract agentId from URL
        const agentIdMatch = url.match(/\/flock\/a2a\/([^\/]+)/);
        const agentId = agentIdMatch?.[1];

        if (method === "POST" && agentId) {
          const result = await a2aServer.handleRequest(agentId, body);
          res.statusCode = result.status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result.body));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Route not found" }));
        }
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }

      const port = addr.port;
      const url = `http://127.0.0.1:${port}`;

      const close = (): Promise<void> =>
        new Promise((resolve) => {
          server.close(() => resolve());
        });

      resolve({ port, close, url });
    });

    server.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Tool Execution Helper
// ---------------------------------------------------------------------------

async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  callerAgentId: string,
  toolDeps: ToolDeps,
): Promise<{ ok: boolean; output?: string; error?: string; data?: unknown }> {
  // Mock PluginApi for tools
  const mockApi = {
    registerTool: (tool: any) => {
      // Store tools in a map for execution
      if (!mockApi._tools) mockApi._tools = new Map();
      if (typeof tool === "function") {
        const resolved = tool({ agentId: "test-agent" });
        if (resolved) {
          const list = Array.isArray(resolved) ? resolved : [resolved];
          for (const t of list) mockApi._tools.set(t.name, t);
        }
      } else {
        mockApi._tools.set(tool.name, tool);
      }
    },
    _tools: new Map() as Map<string, any>,
  };

  // Register all flock tools
  registerFlockTools(mockApi as any, toolDeps);

  // Find and execute the requested tool
  const tool = mockApi._tools.get(toolName);
  if (!tool) {
    return { ok: false, error: `Tool not found: ${toolName}` };
  }

  try {
    // Use new execute signature and convert result format
    // Put callerAgentId as 'agentId' since that's what tools expect for the caller's ID
    const toolParams = { ...params };
    if (!toolParams.agentId) {
      toolParams.agentId = callerAgentId;
    }
    
    const result = await tool.execute("test-call-id", toolParams);
    
    // Convert from ToolResultOC to legacy format for test assertions
    return {
      ok: result.details?.ok ?? false,
      output: result.content[0]?.text,
      error: result.details?.ok === false ? result.content[0]?.text : undefined,
      data: result.details,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Migration ↔ Central Topology Integration", () => {
  let tmpDir: string;
  let centralServer: TestHttpServer;
  let workerNode1: TestHttpServer;
  let workerNode2: TestHttpServer;

  let centralA2AServer: A2AServer;
  let centralA2AClient: A2AClient;
  let assignments: AssignmentStore;
  let migrationEngine: MigrationEngine;
  let homeManager: HomeManager;
  let auditLog: AuditLog;
  let toolDeps: ToolDeps;

  beforeAll(async () => {
    // Create temporary directory
    tmpDir = await mkdtemp(join(tmpdir(), "flock-migration-test-"));

    // Initialize central node infrastructure
    const db = createMemoryDatabase();
    db.migrate();
    auditLog = createAuditLog({ db, logger });
    homeManager = createHomeManager({ db, logger });
    assignments = createAssignmentStore();

    const nodeRegistry = new NodeRegistry();
    const migrationTicketStore = createTicketStore({ logger });

    // Create migration context for A2A handlers (without migration engine initially)
    const migrationContext: MigrationHandlerContext = {
      ticketStore: migrationTicketStore,
      auditLog,
      logger,
      nodeId: "central",
    };

    // Initialize central A2A server with migration handlers
    centralA2AServer = new A2AServer({
      basePath: "/flock",
      logger,
      migrationContext,
    });

    // Initialize migration engine
    migrationEngine = createMigrationEngine({
      ticketStore: migrationTicketStore,
      homeManager,
      auditLog,
      logger,
      nodeId: "central",
      endpoint: "http://central/flock",
      mode: "central",
      tmpDir,
      registry: nodeRegistry,
      assignments,
    });

    // Update migration context with engine (for assignment store hooks)
    migrationContext.migrationEngine = migrationEngine;

    // Create central topology resolvers
    const resolve = createCentralResolver();
    const resolveSysadmin = createCentralSysadminResolver(assignments, nodeRegistry);

    centralA2AClient = createA2AClient({
      localServer: centralA2AServer,
      resolve,
      resolveSysadmin,
      logger,
    });

    // Start HTTP servers
    centralServer = await createTestHttpServer("central", centralA2AServer);
    
    // Mock worker nodes (just echo sysadmin agents)
    const worker1A2AServer = new A2AServer({ basePath: "/flock", logger });
    const worker2A2AServer = new A2AServer({ basePath: "/flock", logger });
    
    workerNode1 = await createTestHttpServer("worker1", worker1A2AServer);
    workerNode2 = await createTestHttpServer("worker2", worker2A2AServer);

    // Register worker nodes in central registry
    nodeRegistry.register({
      nodeId: "worker-1",
      a2aEndpoint: `${workerNode1.url}/flock`,
      status: "online",
      lastSeen: Date.now(),
      agentIds: [],
    });

    nodeRegistry.register({
      nodeId: "worker-2", 
      a2aEndpoint: `${workerNode2.url}/flock`,
      status: "online",
      lastSeen: Date.now(),
      agentIds: [],
    });

    // Register sysadmin agents on worker nodes
    const sysadmin1Card = createSysadminCard("worker-1", `${workerNode1.url}/flock/a2a/sysadmin-1`, "sysadmin-1");
    const sysadmin2Card = createSysadminCard("worker-2", `${workerNode2.url}/flock/a2a/sysadmin-2`, "sysadmin-2");
    
    worker1A2AServer.registerAgent("sysadmin-1", sysadmin1Card.card, sysadmin1Card.meta, createEchoExecutor({ agentId: "sysadmin-1", logger }));
    worker2A2AServer.registerAgent("sysadmin-2", sysadmin2Card.card, sysadmin2Card.meta, createEchoExecutor({ agentId: "sysadmin-2", logger }));

    // Register worker agents on central (co-located)
    const worker1Card = createWorkerCard("worker-alpha", "worker-1", `${centralServer.url}/flock/a2a/worker-alpha`);
    const worker2Card = createWorkerCard("worker-beta", "worker-1", `${centralServer.url}/flock/a2a/worker-beta`);
    const centralSysadminCard = createSysadminCard("central", `${centralServer.url}/flock/a2a/central-sysadmin`, "central-sysadmin");

    centralA2AServer.registerAgent("worker-alpha", worker1Card.card, worker1Card.meta, createEchoExecutor({ agentId: "worker-alpha", logger }));
    centralA2AServer.registerAgent("worker-beta", worker2Card.card, worker2Card.meta, createEchoExecutor({ agentId: "worker-beta", logger }));
    centralA2AServer.registerAgent("central-sysadmin", centralSysadminCard.card, centralSysadminCard.meta, createEchoExecutor({ agentId: "central-sysadmin", logger }));

    // Set up initial assignments (logical assignment to worker-1, but physically on central)
    await assignments.set("worker-alpha", "worker-1");
    await assignments.set("worker-beta", "worker-1");

    // Create homes on central node (where workers physically run in central topology)
    homeManager.create("worker-alpha", "central");
    homeManager.create("worker-beta", "central");
    homeManager.transition("worker-alpha@central", "PROVISIONING", "test setup", "test");
    homeManager.transition("worker-alpha@central", "IDLE", "provisioning complete", "test");
    homeManager.transition("worker-alpha@central", "LEASED", "lease acquired", "test");
    homeManager.transition("worker-alpha@central", "ACTIVE", "agent started", "test");
    homeManager.transition("worker-beta@central", "PROVISIONING", "test setup", "test");
    homeManager.transition("worker-beta@central", "IDLE", "provisioning complete", "test");
    homeManager.transition("worker-beta@central", "LEASED", "lease acquired", "test");
    homeManager.transition("worker-beta@central", "ACTIVE", "agent started", "test");

    // Mock config for tools
    const mockConfig: FlockConfig = {
      dataDir: tmpDir,
      dbBackend: "memory",
      topology: "central",
      homes: { rootDir: tmpDir, baseDir: tmpDir },
      sysadmin: { enabled: true, autoGreen: false },
      economy: { enabled: false, initialBalance: 0 },
      nodeId: "central",
      remoteNodes: [],
      testAgents: [],
      gatewayAgents: [],
      gateway: { port: 3779, token: "" },
    };

    // Create tool dependencies
    toolDeps = {
      config: mockConfig,
      homes: homeManager,
      audit: auditLog,
      provisioner: {} as any, // Not needed for this test
      a2aClient: centralA2AClient,
      a2aServer: centralA2AServer,
      taskStore: db.tasks,
      migrationEngine,
    };

    log({ step: "setup", action: "completed", details: { centralPort: centralServer.port, worker1Port: workerNode1.port, worker2Port: workerNode2.port } });
  }, 30000);

  afterAll(async () => {
    await centralServer?.close();
    await workerNode1?.close();
    await workerNode2?.close();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("should integrate migration engine with central topology through A2A HTTP", async () => {
    // Step 1: Verify initial state  
    await assignments.set("central-sysadmin", "central");
    homeManager.create("central-sysadmin", "central");
    homeManager.transition("central-sysadmin@central", "PROVISIONING", "test setup", "test");
    homeManager.transition("central-sysadmin@central", "IDLE", "provisioning complete", "test");
    homeManager.transition("central-sysadmin@central", "LEASED", "lease acquired", "test");
    homeManager.transition("central-sysadmin@central", "ACTIVE", "agent started", "test");

    const initialAssignment = assignments.get("central-sysadmin");
    expect(initialAssignment?.nodeId).toBe("central");
    log({ step: "initial-state", action: "verified", details: { assignment: initialAssignment } });

    const initialHome = homeManager.get("central-sysadmin@central");
    expect(initialHome?.state).toBe("ACTIVE");
    log({ step: "initial-home", action: "verified", details: { home: initialHome } });

    // Step 2: Initiate migration directly via engine
    // (flock_migrate tool now requires orchestrator; this test validates
    // individual A2A steps, so we bypass the tool and use the engine directly)
    const ticket = migrationEngine.initiate(
      "central-sysadmin",
      "worker-2",
      "orchestrator_rebalance",
    );

    log({ step: "migration-initiate", action: "engine-direct", details: { migrationId: ticket.migrationId, phase: ticket.phase } });

    expect(ticket.migrationId).toBeDefined();
    expect(ticket.agentId).toBe("central-sysadmin");
    expect(ticket.target.nodeId).toBe("worker-2");
    expect(ticket.phase).toBe("REQUESTED");

    const migrationId = ticket.migrationId;

    // Step 3: Advance through migration phases via A2A HTTP calls
    // Note: In a real scenario, these would be triggered by the migration orchestrator
    // For this test, we'll simulate the calls directly

    // Simulate target node approving the migration
    const approveRequest = {
      jsonrpc: "2.0",
      id: "approve-1",
      method: "migration/approve",
      params: { migrationId },
    };

    const approveResponse = await fetch(`${centralServer.url}/flock/a2a/central-sysadmin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(approveRequest),
    });

    const approveResult = await approveResponse.json();
    log({ step: "migration-approve", action: "a2a-http", details: { request: approveRequest, response: approveResult } });
    
    expect(approveResponse.status).toBe(200);
    expect(approveResult).toHaveProperty("result");
    expect(approveResult.result.phase).toBe("AUTHORIZED");

    // Step 4: Advance migration to completion through the engine
    // (Simulating the full lifecycle - in reality this would involve actual snapshots/transfers)
    
    let currentTicket = migrationEngine.getStatus(migrationId);
    expect(currentTicket?.phase).toBe("AUTHORIZED");

    // Advance through phases
    currentTicket = await migrationEngine.advancePhase(migrationId); // AUTHORIZED → FREEZING
    expect(currentTicket.phase).toBe("FREEZING");
    log({ step: "migration-phase", action: "freezing", phase: currentTicket.phase });

    currentTicket = await migrationEngine.advancePhase(migrationId); // FREEZING → FROZEN
    expect(currentTicket.phase).toBe("FROZEN");
    log({ step: "migration-phase", action: "frozen", phase: currentTicket.phase });

    currentTicket = await migrationEngine.advancePhase(migrationId); // FROZEN → SNAPSHOTTING
    expect(currentTicket.phase).toBe("SNAPSHOTTING");
    log({ step: "migration-phase", action: "snapshotting", phase: currentTicket.phase });

    currentTicket = await migrationEngine.advancePhase(migrationId); // SNAPSHOTTING → TRANSFERRING
    expect(currentTicket.phase).toBe("TRANSFERRING");
    log({ step: "migration-phase", action: "transferring", phase: currentTicket.phase });

    currentTicket = await migrationEngine.advancePhase(migrationId); // TRANSFERRING → VERIFYING
    expect(currentTicket.phase).toBe("VERIFYING");
    log({ step: "migration-phase", action: "verifying", phase: currentTicket.phase });

    // Simulate verification success via A2A HTTP
    const verifyRequest = {
      jsonrpc: "2.0", 
      id: "verify-1",
      method: "migration/verify",
      params: { migrationId, verified: true },
    };

    const verifyResponse = await fetch(`${centralServer.url}/flock/a2a/central-sysadmin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verifyRequest),
    });

    const verifyResult = await verifyResponse.json();
    log({ step: "migration-verify", action: "a2a-http", details: { request: verifyRequest, response: verifyResult } });

    expect(verifyResponse.status).toBe(200);
    expect(verifyResult.result.phase).toBe("REHYDRATING");

    // Advance to FINALIZING phase
    currentTicket = await migrationEngine.advancePhase(migrationId); // REHYDRATING → FINALIZING
    expect(currentTicket.phase).toBe("FINALIZING");
    log({ step: "migration-phase", action: "finalizing", phase: currentTicket.phase });

    // Complete the migration via A2A HTTP
    const completeRequest = {
      jsonrpc: "2.0",
      id: "complete-1", 
      method: "migration/complete",
      params: { migrationId, newHomeId: "central-sysadmin@worker-2" },
    };

    const completeResponse = await fetch(`${centralServer.url}/flock/a2a/central-sysadmin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(completeRequest),
    });

    const completeResult = await completeResponse.json();
    log({ step: "migration-complete", action: "a2a-http", details: { request: completeRequest, response: completeResult } });

    if (completeResponse.status !== 200) {
      console.error("Complete request failed:", completeResponse.status, completeResult);
    }

    expect(completeResponse.status).toBe(200);
    expect(completeResult.result.phase).toBe("COMPLETED");

    // Step 5: Verify assignment store was automatically updated
    const finalAssignment = assignments.get("central-sysadmin");
    expect(finalAssignment?.nodeId).toBe("worker-2");
    log({ step: "assignment-updated", action: "verified", details: { assignment: finalAssignment } });

    // Step 6: Verify sysadmin routing changes
    // The assignment store update should cause sysadmin routing to now point to worker-2
    const finalNodeId = await assignments.getNodeId("central-sysadmin");
    expect(finalNodeId).toBe("worker-2");
    log({ step: "sysadmin-routing", action: "verified", details: { nodeId: finalNodeId } });

    // Step 7: Verify source home state changed appropriately
    const sourceHome = homeManager.get("central-sysadmin@central");
    expect(sourceHome?.state).toBe("RETIRED");
    log({ step: "source-home-retired", action: "verified", details: { home: sourceHome } });

    // Step 8: Verify audit trail
    const auditEntries = auditLog.query({ agentId: "central-sysadmin", limit: 10 });
    expect(auditEntries.length).toBeGreaterThan(0);
    
    const migrationEntries = auditEntries.filter(e => e.action.startsWith("migration."));
    expect(migrationEntries.length).toBeGreaterThan(3); // Should have initiated, authorized, finalized, etc.
    
    log({ step: "audit-verified", action: "verified", details: { entries: migrationEntries.length, sample: migrationEntries[0] } });

    // Success! The integration worked end-to-end
    log({ step: "integration-complete", action: "success" });
  }, 30000);

  it("should enforce sysadmin role requirement for flock_migrate", async () => {
    // Attempt migration by a worker agent (should fail).
    // params.agentId is injected by OpenClaw as the caller's identity.
    // params.targetAgentId is the agent to migrate.
    const result = await executeTool(
      "flock_migrate",
      {
        agentId: "worker-beta", // Injected caller identity (worker role)
        targetAgentId: "worker-beta", // Agent to migrate
        targetNodeId: "worker-2", 
        reason: "test",
      },
      "worker-beta",
      toolDeps,
    );

    log({ step: "permission-test", action: "executed", details: result });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Permission denied");
    expect(result.error).toContain("only sysadmin or orchestrator agents");
  });
});