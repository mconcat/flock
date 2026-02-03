/**
 * Migration E2E Integration Test
 *
 * Simulates real migration scenarios between two nodes on the same process.
 * NO mocks — real filesystem, real functions, real state machines.
 *
 * Sections:
 *   Orchestrator Tests (production-like flow via single run() call):
 *     1. Happy Path — full migration lifecycle via orchestrator
 *     2. Automatic Rollback — verification failure triggers rollback
 *   Engine-Level Tests (manual step-by-step engine interaction):
 *     3. Rollback — transfer failure with corrupt checksum
 *     4. Abort — early cancellation after authorization
 *     5. Frozen Guard — message rejection during migration
 *     6. Path Traversal Rejection — malicious relativePath
 *   Additional:
 *     - Cross-node handler round-trip
 *     - Snapshot checksum integrity
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createMigrationEngine } from "../../src/migration/engine.js";
import type { MigrationEngine } from "../../src/migration/engine.js";
import { createTicketStore } from "../../src/migration/ticket-store.js";
import type { MigrationTicketStore } from "../../src/migration/ticket-store.js";
import { createHomeManager } from "../../src/homes/manager.js";
import type { HomeManager } from "../../src/homes/manager.js";
import { createMemoryDatabase } from "../../src/db/memory.js";
import type { FlockDatabase } from "../../src/db/interface.js";
import { createAuditLog } from "../../src/audit/log.js";
import type { AuditLog } from "../../src/audit/log.js";
import { NodeRegistry } from "../../src/nodes/registry.js";
import type { PluginLogger } from "../../src/types.js";

import { createSnapshot, verifySnapshot, computeSha256 } from "../../src/migration/snapshot.js";
import { rehydrate } from "../../src/migration/rehydrate.js";
import { checkFrozenStatus } from "../../src/migration/frozen-guard.js";
import { createMigrationHandlers } from "../../src/migration/handlers.js";
import type { MigrationHandlerContext, MigrationHandlerMap } from "../../src/migration/handlers.js";
import { createMigrationOrchestrator } from "../../src/migration/orchestrator.js";
import type { MigrationTransport } from "../../src/migration/orchestrator.js";
import { createLocalDispatch, createA2ATransport } from "../../src/migration/a2a-transport.js";

import type { MigrationPayload, WorkStateManifest } from "../../src/migration/types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Test Infrastructure
// ---------------------------------------------------------------------------

function makeLogger(prefix: string): PluginLogger {
  const noop = (): void => {};
  return {
    info: process.env.E2E_VERBOSE ? (msg: string) => console.log(`[${prefix}] ${msg}`) : noop,
    warn: process.env.E2E_VERBOSE ? (msg: string) => console.warn(`[${prefix}] ${msg}`) : noop,
    error: (msg: string) => console.error(`[${prefix}] ${msg}`),
    debug: noop,
  };
}

/** All the pieces that make up a simulated Flock node. */
interface TestNode {
  nodeId: string;
  db: FlockDatabase;
  homeManager: HomeManager;
  ticketStore: MigrationTicketStore;
  auditLog: AuditLog;
  engine: MigrationEngine;
  handlers: MigrationHandlerMap;
  handlerContext: MigrationHandlerContext;
  logger: PluginLogger;
  /** Filesystem root for agent homes on this node. */
  homesDir: string;
  /** Filesystem root for agent work directories on this node. */
  workDir: string;
  /** Temporary directory for snapshots. */
  tmpDir: string;
  registry: NodeRegistry;
}

/** Shared registry visible to both nodes. */
let sharedRegistry: NodeRegistry;
let rootTmpDir: string;

function createTestNode(nodeId: string, baseDir: string): TestNode {
  const db = createMemoryDatabase();
  const logger = makeLogger(nodeId);
  const homeManager = createHomeManager({ db, logger });
  const ticketStore = createTicketStore({ logger });
  const auditLog = createAuditLog({ db, logger });

  const homesDir = join(baseDir, nodeId, "homes");
  const workDir = join(baseDir, nodeId, "work");
  const tmpDir = join(baseDir, nodeId, "tmp");

  const engine = createMigrationEngine({
    ticketStore,
    homeManager,
    auditLog,
    logger,
    nodeId,
    endpoint: `http://${nodeId}:3779/flock`,
    mode: "p2p",
    tmpDir,
    registry: sharedRegistry,
  });

  const handlerContext: MigrationHandlerContext = {
    ticketStore,
    auditLog,
    logger,
    nodeId,
    tmpDir,
    resolveHomePath: (agentId: string) => join(homesDir, agentId),
    resolveWorkPath: (agentId: string) => join(workDir, agentId),
  };

  const handlers = createMigrationHandlers(handlerContext);

  return {
    nodeId,
    db,
    homeManager,
    ticketStore,
    auditLog,
    engine,
    handlers,
    handlerContext,
    logger,
    homesDir,
    workDir,
    tmpDir,
    registry: sharedRegistry,
  };
}

/**
 * Walk a home through valid transitions to reach a target state.
 */
function setupHome(
  homeManager: HomeManager,
  agentId: string,
  nodeId: string,
  targetState: string,
): void {
  homeManager.create(agentId, nodeId);
  const homeId = `${agentId}@${nodeId}`;

  if (targetState === "UNASSIGNED") return;
  homeManager.transition(homeId, "PROVISIONING", "setup", "test");
  if (targetState === "PROVISIONING") return;
  homeManager.transition(homeId, "IDLE", "setup", "test");
  if (targetState === "IDLE") return;
  homeManager.transition(homeId, "LEASED", "setup", "test");
  if (targetState === "LEASED") return;
  homeManager.transition(homeId, "ACTIVE", "setup", "test");
  if (targetState === "ACTIVE") return;
}

/**
 * Populate an agent home directory with realistic files:
 * SOUL.md, memory/, knowledge/, toolkit/, playbooks/
 */
async function populateAgentHome(homeDir: string): Promise<void> {
  await mkdir(join(homeDir, "toolkit"), { recursive: true });
  await mkdir(join(homeDir, "playbooks"), { recursive: true });
  await mkdir(join(homeDir, "knowledge", "active"), { recursive: true });
  await mkdir(join(homeDir, "knowledge", "archive"), { recursive: true });
  await mkdir(join(homeDir, "memory"), { recursive: true });

  await writeFile(
    join(homeDir, "SOUL.md"),
    "# worker-1\n\nI am a diligent worker agent. I build things.\n",
  );
  await writeFile(
    join(homeDir, "memory", "2025-01-15.md"),
    "# 2025-01-15\n\n- Completed migration engine implementation.\n- Learned about tar.gz checksums.\n",
  );
  await writeFile(
    join(homeDir, "toolkit", "build.ts"),
    'export async function build() { return "built"; }\n',
  );
  await writeFile(
    join(homeDir, "playbooks", "deploy.md"),
    "# Deploy Playbook\n\n1. Build\n2. Test\n3. Ship\n",
  );
  await writeFile(
    join(homeDir, "knowledge", "active", "architecture.md"),
    "# Architecture\n\nFlock uses a migration engine with 10 phases.\n",
  );
  await writeFile(
    join(homeDir, "knowledge", "archive", "old-notes.md"),
    "# Old Notes\n\nArchived knowledge from before migration.\n",
  );
}

/**
 * Create a git repo inside the work directory with a branch and a commit.
 * Returns the commit SHA and branch name.
 */
async function createGitRepo(
  workDir: string,
  projectName: string,
): Promise<{ branch: string; commitSha: string; repoPath: string }> {
  const repoPath = join(workDir, projectName);
  await mkdir(repoPath, { recursive: true });

  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@flock.local"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Flock Test"], { cwd: repoPath });

  await writeFile(join(repoPath, "README.md"), `# ${projectName}\n\nA test project.\n`);
  await mkdir(join(repoPath, "src"), { recursive: true });
  await writeFile(join(repoPath, "src", "index.ts"), 'export const hello = "world";\n');

  await execFileAsync("git", ["add", "."], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: repoPath });

  const { stdout: branchOut } = await execFileAsync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: repoPath },
  );
  const { stdout: shaOut } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoPath },
  );

  return {
    branch: branchOut.trim(),
    commitSha: shaOut.trim(),
    repoPath,
  };
}

/**
 * Create a bare git repo and push from a working repo.
 * Returns the bare repo path for use as a remote URL.
 */
async function createBareRepoFrom(
  workingRepoPath: string,
  bareDir: string,
  projectName: string,
): Promise<string> {
  const barePath = join(bareDir, `${projectName}.git`);
  await mkdir(barePath, { recursive: true });
  await execFileAsync("git", ["init", "--bare"], { cwd: barePath });

  const { stdout: branchOut } = await execFileAsync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: workingRepoPath },
  );
  const branch = branchOut.trim();

  await execFileAsync("git", ["remote", "add", "origin", barePath], { cwd: workingRepoPath });
  await execFileAsync("git", ["push", "origin", branch], { cwd: workingRepoPath });

  return barePath;
}

// ---------------------------------------------------------------------------
// Local Transport — wraps target node functions for in-process orchestrator
// ---------------------------------------------------------------------------

function createLocalTransport(targetNode: TestNode): MigrationTransport {
  return {
    async notifyRequest(params) {
      const handler = targetNode.handlers.get("migration/request")!;
      const result = await handler(
        {
          migrationId: params.migrationId,
          agentId: params.agentId,
          sourceNodeId: params.sourceNodeId,
          targetNodeId: params.targetNodeId,
          reason: params.reason,
          sourceEndpoint: params.sourceEndpoint,
        },
        {
          ticketStore: targetNode.ticketStore,
          auditLog: targetNode.auditLog,
          logger: targetNode.logger,
          nodeId: targetNode.nodeId,
        },
      );

      if ("error" in result) {
        return { accepted: false, error: result.error.message };
      }
      return { accepted: true };
    },

    async transferAndVerify(params) {
      const archivePath = join(targetNode.tmpDir, `${params.migrationId}.tar.gz`);
      await mkdir(targetNode.tmpDir, { recursive: true });
      await writeFile(archivePath, params.archiveBuffer);
      return verifySnapshot(archivePath, params.checksum);
    },

    async rehydrate(params) {
      return rehydrate(params.payload, params.targetHomePath, targetNode.logger, params.targetWorkDir);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Migration E2E", () => {
  let source: TestNode;
  let target: TestNode;

  beforeEach(async () => {
    rootTmpDir = await mkdtemp(join(tmpdir(), "flock-migration-e2e-"));

    sharedRegistry = new NodeRegistry();
    sharedRegistry.register({
      nodeId: "source-node",
      a2aEndpoint: "http://source-node:3779/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: ["worker-1"],
    });
    sharedRegistry.register({
      nodeId: "target-node",
      a2aEndpoint: "http://target-node:3779/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: [],
    });

    source = createTestNode("source-node", rootTmpDir);
    target = createTestNode("target-node", rootTmpDir);
  });

  afterEach(async () => {
    await rm(rootTmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Orchestrator Tests — production-like flow via single run() call
  // =========================================================================

  // =========================================================================
  // Scenario 1: Happy Path — Full Migration via Orchestrator
  // =========================================================================
  describe("Scenario 1: Happy Path — Full Migration via Orchestrator", () => {
    it("completes full migration lifecycle with a single orchestrator.run() call", async () => {
      // --- Setup environment ---
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      const sourceWorkDir = join(source.workDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      const gitInfo = await createGitRepo(sourceWorkDir, "my-project");
      const bareRepoPath = await createBareRepoFrom(
        gitInfo.repoPath,
        join(rootTmpDir, "bare-repos"),
        "my-project",
      );

      expect(source.homeManager.get("worker-1@source-node")!.state).toBe("ACTIVE");

      // --- Create orchestrator with local transport ---
      const orchestrator = createMigrationOrchestrator({
        engine: source.engine,
        transport: createLocalTransport(target),
        sourceNodeId: "source-node",
        sourceEndpoint: "http://source-node:3779/flock",
        resolveSourceHome: (agentId) => join(source.homesDir, agentId),
        resolveSourceWork: (agentId) => join(source.workDir, agentId),
        resolveTargetHome: (agentId) => join(target.homesDir, agentId),
        resolveTargetWork: (agentId) => join(target.workDir, agentId),
        resolveTargetEndpoint: (nodeId) => `http://${nodeId}:3779/flock`,
        tmpDir: source.tmpDir,
        logger: source.logger,
        transformWorkState: (ws) => ({
          ...ws,
          projects: ws.projects.map((p) => ({
            ...p,
            remoteUrl: bareRepoPath,
          })),
        }),
      });

      // --- RUN — single call drives the entire lifecycle ---
      const result = await orchestrator.run("worker-1", "target-node", "agent_request");

      // --- Verify orchestrator result ---
      expect(result.success).toBe(true);
      expect(result.finalPhase).toBe("COMPLETED");

      // --- Verify source state ---
      const sourceHome = source.homeManager.get("worker-1@source-node");
      expect(sourceHome!.state).toBe("RETIRED");

      // --- Verify target files were restored ---
      const targetHomeDir = join(target.homesDir, "worker-1");
      const targetWorkDir = join(target.workDir, "worker-1");

      const soulContent = await readFile(join(targetHomeDir, "SOUL.md"), "utf-8");
      expect(soulContent).toContain("worker-1");

      const memoryContent = await readFile(join(targetHomeDir, "memory", "2025-01-15.md"), "utf-8");
      expect(memoryContent).toContain("migration engine");

      const toolContent = await readFile(join(targetHomeDir, "toolkit", "build.ts"), "utf-8");
      expect(toolContent).toContain("built");

      const playbookContent = await readFile(join(targetHomeDir, "playbooks", "deploy.md"), "utf-8");
      expect(playbookContent).toContain("Deploy Playbook");

      const knowledgeContent = await readFile(
        join(targetHomeDir, "knowledge", "active", "architecture.md"),
        "utf-8",
      );
      expect(knowledgeContent).toContain("migration engine");

      // --- Verify git repo was restored ---
      const repoStat = await stat(join(targetWorkDir, "my-project", ".git"));
      expect(repoStat.isDirectory()).toBe(true);

      const readmeContent = await readFile(join(targetWorkDir, "my-project", "README.md"), "utf-8");
      expect(readmeContent).toContain("my-project");

      // --- Verify registry update ---
      const sourceNodeEntry = sharedRegistry.get("source-node");
      expect(sourceNodeEntry!.agentIds).not.toContain("worker-1");

      const targetNodeEntry = sharedRegistry.get("target-node");
      expect(targetNodeEntry!.agentIds).toContain("worker-1");

      const agentNode = sharedRegistry.findNodeForAgent("worker-1");
      expect(agentNode).not.toBeNull();
      expect(agentNode!.nodeId).toBe("target-node");

      // --- Verify frozen guard cleared ---
      const frozenCheck = checkFrozenStatus("worker-1", source.ticketStore);
      expect(frozenCheck.rejected).toBe(false);

      // --- No active migrations ---
      expect(source.engine.listActive()).toHaveLength(0);

      // --- Audit trail ---
      const auditEntries = source.auditLog.query({ agentId: "worker-1" });
      const migrationAudits = auditEntries.filter((e) => e.action.startsWith("migration."));
      expect(migrationAudits.length).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  // Scenario 1b: Orchestrator Automatic Rollback on Verification Failure
  // =========================================================================
  describe("Scenario 1b: Orchestrator Automatic Rollback", () => {
    it("rolls back automatically when verification fails", async () => {
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      // Transport that always returns failed verification
      const badTransport: MigrationTransport = {
        ...createLocalTransport(target),
        async transferAndVerify() {
          return {
            verified: false,
            failureReason: "CHECKSUM_MISMATCH" as const,
            verifiedAt: Date.now(),
          };
        },
      };

      const orchestrator = createMigrationOrchestrator({
        engine: source.engine,
        transport: badTransport,
        sourceNodeId: "source-node",
        sourceEndpoint: "http://source-node:3779/flock",
        resolveSourceHome: (agentId) => join(source.homesDir, agentId),
        resolveSourceWork: (agentId) => join(source.workDir, agentId),
        resolveTargetHome: (agentId) => join(target.homesDir, agentId),
        resolveTargetWork: (agentId) => join(target.workDir, agentId),
        resolveTargetEndpoint: (nodeId) => `http://${nodeId}:3779/flock`,
        tmpDir: source.tmpDir,
        logger: source.logger,
      });

      const result = await orchestrator.run("worker-1", "target-node", "agent_request");

      // Should fail
      expect(result.success).toBe(false);
      expect(result.error).toContain("Verification failed");

      // Source home rolled back to LEASED
      const sourceHome = source.homeManager.get("worker-1@source-node");
      expect(sourceHome!.state).toBe("LEASED");

      // No active migrations
      expect(source.engine.listActive()).toHaveLength(0);

      // Frozen guard cleared
      const frozenCheck = checkFrozenStatus("worker-1", source.ticketStore);
      expect(frozenCheck.rejected).toBe(false);
    });

    it("rolls back automatically when rehydration fails", async () => {
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      // Transport that accepts/verifies but fails rehydration
      const failRehydrateTransport: MigrationTransport = {
        ...createLocalTransport(target),
        async rehydrate() {
          return {
            success: false,
            homePath: "/nonexistent",
            error: {
              code: 6001,
              message: "Simulated rehydration failure",
              phase: "REHYDRATING" as const,
              origin: "target" as const,
              recovery: { type: "auto_rollback" as const },
            },
            warnings: [],
            completedAt: Date.now(),
          };
        },
      };

      const orchestrator = createMigrationOrchestrator({
        engine: source.engine,
        transport: failRehydrateTransport,
        sourceNodeId: "source-node",
        sourceEndpoint: "http://source-node:3779/flock",
        resolveSourceHome: (agentId) => join(source.homesDir, agentId),
        resolveSourceWork: (agentId) => join(source.workDir, agentId),
        resolveTargetHome: (agentId) => join(target.homesDir, agentId),
        resolveTargetWork: (agentId) => join(target.workDir, agentId),
        resolveTargetEndpoint: (nodeId) => `http://${nodeId}:3779/flock`,
        tmpDir: source.tmpDir,
        logger: source.logger,
      });

      const result = await orchestrator.run("worker-1", "target-node", "agent_request");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Simulated rehydration failure");

      // No active migrations after rollback
      expect(source.engine.listActive()).toHaveLength(0);
    });
  });

  // =========================================================================
  // Scenario 1c: Happy Path via A2ATransport (handler-based dispatch)
  // =========================================================================
  describe("Scenario 1c: Happy Path via A2ATransport", () => {
    it("completes full migration using createLocalDispatch + createA2ATransport", async () => {
      // --- Setup environment ---
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      const sourceWorkDir = join(source.workDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      const gitInfo = await createGitRepo(sourceWorkDir, "my-project");
      const bareRepoPath = await createBareRepoFrom(
        gitInfo.repoPath,
        join(rootTmpDir, "bare-repos"),
        "my-project",
      );

      expect(source.homeManager.get("worker-1@source-node")!.state).toBe("ACTIVE");

      // --- Create A2A transport via handler dispatch ---
      const nodeHandlerMap = new Map<string, { handlers: MigrationHandlerMap; context: MigrationHandlerContext }>();
      nodeHandlerMap.set("source-node", { handlers: source.handlers, context: source.handlerContext });
      nodeHandlerMap.set("target-node", { handlers: target.handlers, context: target.handlerContext });

      const dispatch = createLocalDispatch(nodeHandlerMap);
      const a2aTransport = createA2ATransport(dispatch, source.logger);

      const orchestrator = createMigrationOrchestrator({
        engine: source.engine,
        transport: a2aTransport,
        sourceNodeId: "source-node",
        sourceEndpoint: "http://source-node:3779/flock",
        resolveSourceHome: (agentId) => join(source.homesDir, agentId),
        resolveSourceWork: (agentId) => join(source.workDir, agentId),
        resolveTargetHome: (agentId) => join(target.homesDir, agentId),
        resolveTargetWork: (agentId) => join(target.workDir, agentId),
        resolveTargetEndpoint: (nodeId) => `http://${nodeId}:3779/flock`,
        tmpDir: source.tmpDir,
        logger: source.logger,
        transformWorkState: (ws) => ({
          ...ws,
          projects: ws.projects.map((p) => ({
            ...p,
            remoteUrl: bareRepoPath,
          })),
        }),
      });

      // --- RUN ---
      const result = await orchestrator.run("worker-1", "target-node", "agent_request");

      // --- Verify success ---
      expect(result.success).toBe(true);
      expect(result.finalPhase).toBe("COMPLETED");

      // --- Verify source state ---
      const sourceHome = source.homeManager.get("worker-1@source-node");
      expect(sourceHome!.state).toBe("RETIRED");

      // --- Verify target files were restored via handler ---
      const targetHomeDir = join(target.homesDir, "worker-1");
      const targetWorkDir = join(target.workDir, "worker-1");

      const soulContent = await readFile(join(targetHomeDir, "SOUL.md"), "utf-8");
      expect(soulContent).toContain("worker-1");

      const memoryContent = await readFile(join(targetHomeDir, "memory", "2025-01-15.md"), "utf-8");
      expect(memoryContent).toContain("migration engine");

      // --- Verify git repo was restored ---
      const repoStat = await stat(join(targetWorkDir, "my-project", ".git"));
      expect(repoStat.isDirectory()).toBe(true);

      const readmeContent = await readFile(join(targetWorkDir, "my-project", "README.md"), "utf-8");
      expect(readmeContent).toContain("my-project");

      // --- Verify registry update ---
      const targetNodeEntry = sharedRegistry.get("target-node");
      expect(targetNodeEntry!.agentIds).toContain("worker-1");

      const agentNode = sharedRegistry.findNodeForAgent("worker-1");
      expect(agentNode!.nodeId).toBe("target-node");
    });

    it("rolls back via A2ATransport when verification fails", async () => {
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      // Use real handlers for most operations but create a dispatch that
      // returns bad verification for transfer-and-verify
      const nodeHandlerMap = new Map<string, { handlers: MigrationHandlerMap; context: MigrationHandlerContext }>();
      nodeHandlerMap.set("source-node", { handlers: source.handlers, context: source.handlerContext });
      nodeHandlerMap.set("target-node", { handlers: target.handlers, context: target.handlerContext });

      const realDispatch = createLocalDispatch(nodeHandlerMap);

      // Wrap dispatch to intercept transfer-and-verify
      const badDispatch = async (targetNodeId: string, method: string, params: Record<string, unknown>) => {
        if (method === "migration/transfer-and-verify") {
          return {
            result: {
              verified: false,
              failureReason: "CHECKSUM_MISMATCH",
              computedChecksum: "0".repeat(64),
              verifiedAt: Date.now(),
            },
          };
        }
        return realDispatch(targetNodeId, method, params);
      };

      const a2aTransport = createA2ATransport(badDispatch, source.logger);

      const orchestrator = createMigrationOrchestrator({
        engine: source.engine,
        transport: a2aTransport,
        sourceNodeId: "source-node",
        sourceEndpoint: "http://source-node:3779/flock",
        resolveSourceHome: (agentId) => join(source.homesDir, agentId),
        resolveSourceWork: (agentId) => join(source.workDir, agentId),
        resolveTargetHome: (agentId) => join(target.homesDir, agentId),
        resolveTargetWork: (agentId) => join(target.workDir, agentId),
        resolveTargetEndpoint: (nodeId) => `http://${nodeId}:3779/flock`,
        tmpDir: source.tmpDir,
        logger: source.logger,
      });

      const result = await orchestrator.run("worker-1", "target-node", "agent_request");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Verification failed");

      const sourceHome = source.homeManager.get("worker-1@source-node");
      expect(sourceHome!.state).toBe("LEASED");

      expect(source.engine.listActive()).toHaveLength(0);
    });

    it("dispatch returns error for unknown node", async () => {
      const nodeHandlerMap = new Map<string, { handlers: MigrationHandlerMap; context: MigrationHandlerContext }>();
      const dispatch = createLocalDispatch(nodeHandlerMap);

      const result = await dispatch("nonexistent-node", "migration/request", {});
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain("Unknown node");
    });

    it("dispatch returns error for unknown method", async () => {
      const nodeHandlerMap = new Map<string, { handlers: MigrationHandlerMap; context: MigrationHandlerContext }>();
      nodeHandlerMap.set("target-node", { handlers: target.handlers, context: target.handlerContext });
      const dispatch = createLocalDispatch(nodeHandlerMap);

      const result = await dispatch("target-node", "migration/nonexistent", {});
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain("Method not found");
    });
  });

  // =========================================================================
  // Engine-Level Tests — manual step-by-step for error path coverage
  // =========================================================================

  // =========================================================================
  // Scenario 2: Rollback — Transfer Failure
  // =========================================================================
  describe("Scenario 2: Rollback — Transfer Failure", () => {
    it("rolls back when verification detects checksum mismatch", async () => {
      // Setup
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      // Initiate → Authorize → Freeze → Snapshot
      const ticket = source.engine.initiate("worker-1", "target-node", "agent_request");
      await source.engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      await source.engine.advancePhase(ticket.migrationId); // → FREEZING
      await source.engine.advancePhase(ticket.migrationId); // → FROZEN
      await source.engine.advancePhase(ticket.migrationId); // → SNAPSHOTTING

      // Create snapshot
      const snapshotResult = await createSnapshot(
        sourceHomeDir,
        ticket.migrationId,
        source.tmpDir,
        source.logger,
      );

      // Transfer
      await source.engine.advancePhase(ticket.migrationId); // → TRANSFERRING
      await source.engine.advancePhase(ticket.migrationId); // → VERIFYING

      // Simulate corrupt checksum by verifying against a wrong checksum
      const corruptChecksum = "0".repeat(64);
      const targetArchivePath = join(target.tmpDir, "received-archive.tar.gz");
      await mkdir(target.tmpDir, { recursive: true });
      await writeFile(targetArchivePath, await readFile(snapshotResult.archivePath));

      const badVerification = await verifySnapshot(targetArchivePath, corruptChecksum);

      // Verify: target rejects (checksum mismatch)
      expect(badVerification.verified).toBe(false);
      expect(badVerification.failureReason).toBe("CHECKSUM_MISMATCH");

      // Rollback: engine handles verification failure
      const afterRollback = source.engine.handleVerification(ticket.migrationId, badVerification);

      expect(afterRollback.phase).toBe("ABORTED");
      expect(afterRollback.ownershipHolder).toBe("source");

      // Source home should be back to LEASED
      const sourceHome = source.homeManager.get("worker-1@source-node");
      expect(sourceHome!.state).toBe("LEASED");

      // No active migrations
      expect(source.engine.listActive()).toHaveLength(0);

      // Frozen guard should no longer reject
      const frozenCheck = checkFrozenStatus("worker-1", source.ticketStore);
      expect(frozenCheck.rejected).toBe(false);
    });
  });

  // =========================================================================
  // Scenario 3: Abort — Early Cancellation
  // =========================================================================
  describe("Scenario 3: Abort — Early Cancellation", () => {
    it("aborts after authorization with no lasting state changes", async () => {
      // Setup
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      // Initiate and authorize
      const ticket = source.engine.initiate("worker-1", "target-node", "agent_request");
      await source.engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      expect(source.engine.getStatus(ticket.migrationId)!.phase).toBe("AUTHORIZED");

      // Agent should still be ACTIVE (not frozen yet)
      const homeBeforeAbort = source.homeManager.get("worker-1@source-node");
      expect(homeBeforeAbort!.state).toBe("ACTIVE");

      // Abort via engine rollback
      const aborted = source.engine.rollback(ticket.migrationId, "User cancelled");

      expect(aborted.phase).toBe("ABORTED");

      // Agent stays on source, state is still ACTIVE (no freeze happened)
      const homeAfterAbort = source.homeManager.get("worker-1@source-node");
      expect(homeAfterAbort!.state).toBe("ACTIVE");

      // No active migrations
      expect(source.engine.listActive()).toHaveLength(0);

      // Can initiate a new migration for the same agent
      const newTicket = source.engine.initiate("worker-1", "target-node", "agent_request");
      expect(newTicket.phase).toBe("REQUESTED");
    });

    it("aborts via JSON-RPC handler", async () => {
      // Setup source and target
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const ticket = source.engine.initiate("worker-1", "target-node", "agent_request");
      await source.engine.advancePhase(ticket.migrationId); // → AUTHORIZED

      // Create matching ticket on target side for the abort handler
      const requestHandler = target.handlers.get("migration/request")!;
      await requestHandler(
        {
          migrationId: ticket.migrationId,
          agentId: "worker-1",
          sourceNodeId: "source-node",
          targetNodeId: "target-node",
          reason: "agent_request",
          sourceEndpoint: "http://source-node:3779/flock",
        },
        { ticketStore: target.ticketStore, auditLog: target.auditLog, logger: target.logger, nodeId: "target-node" },
      );

      // Abort via handler on target side
      const abortHandler = target.handlers.get("migration/abort")!;
      const abortResult = await abortHandler(
        {
          migrationId: ticket.migrationId,
          reason: "Capacity changed",
          initiator: "target-node",
        },
        { ticketStore: target.ticketStore, auditLog: target.auditLog, logger: target.logger, nodeId: "target-node" },
      );

      expect("result" in abortResult).toBe(true);
      if ("result" in abortResult) {
        expect(abortResult.result.phase).toBe("ABORTED");
      }

      // Target ticket is aborted
      const targetTicket = target.ticketStore.get(ticket.migrationId);
      expect(targetTicket!.phase).toBe("ABORTED");
    });
  });

  // =========================================================================
  // Scenario 4: Frozen Guard
  // =========================================================================
  describe("Scenario 4: Frozen Guard", () => {
    it("rejects messages during migration, allows after completion", async () => {
      // Setup
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      // Before migration: not frozen
      const beforeMigration = checkFrozenStatus("worker-1", source.ticketStore);
      expect(beforeMigration.rejected).toBe(false);

      // Start migration, get to FROZEN state
      const ticket = source.engine.initiate("worker-1", "target-node", "agent_request");
      await source.engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      await source.engine.advancePhase(ticket.migrationId); // → FREEZING
      await source.engine.advancePhase(ticket.migrationId); // → FROZEN

      // Check frozen guard — should reject messages
      const duringMigration = checkFrozenStatus("worker-1", source.ticketStore);
      expect(duringMigration.rejected).toBe(true);
      expect(duringMigration.reason).toContain("worker-1");
      expect(duringMigration.reason).toContain("migrating");
      expect(duringMigration.estimatedDowntimeMs).toBeGreaterThan(0);

      // Advance through remaining phases
      await source.engine.advancePhase(ticket.migrationId); // → SNAPSHOTTING

      // Still frozen during snapshotting
      const duringSnapshot = checkFrozenStatus("worker-1", source.ticketStore);
      expect(duringSnapshot.rejected).toBe(true);

      await source.engine.advancePhase(ticket.migrationId); // → TRANSFERRING

      // Still frozen during transfer
      const duringTransfer = checkFrozenStatus("worker-1", source.ticketStore);
      expect(duringTransfer.rejected).toBe(true);

      await source.engine.advancePhase(ticket.migrationId); // → VERIFYING

      // Still frozen during verification
      const duringVerify = checkFrozenStatus("worker-1", source.ticketStore);
      expect(duringVerify.rejected).toBe(true);

      // Complete verification
      source.engine.handleVerification(ticket.migrationId, {
        verified: true,
        verifiedAt: Date.now(),
      });

      // Still frozen during rehydration
      const duringRehydrate = checkFrozenStatus("worker-1", source.ticketStore);
      expect(duringRehydrate.rejected).toBe(true);

      // Complete migration
      source.engine.complete(
        ticket.migrationId,
        "worker-1@target-node",
        "http://target-node:3779/flock",
      );

      // After completion: no longer frozen
      const afterCompletion = checkFrozenStatus("worker-1", source.ticketStore);
      expect(afterCompletion.rejected).toBe(false);
    });

    it("frozen guard clears after rollback", async () => {
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const ticket = source.engine.initiate("worker-1", "target-node", "agent_request");
      await source.engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      await source.engine.advancePhase(ticket.migrationId); // → FREEZING
      await source.engine.advancePhase(ticket.migrationId); // → FROZEN

      // Should be rejected
      expect(checkFrozenStatus("worker-1", source.ticketStore).rejected).toBe(true);

      // Rollback
      source.engine.rollback(ticket.migrationId, "changed my mind");

      // Should no longer be rejected
      expect(checkFrozenStatus("worker-1", source.ticketStore).rejected).toBe(false);
    });
  });

  // =========================================================================
  // Scenario 5: Path Traversal Rejection
  // =========================================================================
  describe("Scenario 5: Path Traversal Rejection", () => {
    it("skips projects with path traversal in relativePath", async () => {
      // Setup source home for a valid archive
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      // Create a valid archive
      const archivePath = join(source.tmpDir, "traversal-test.tar.gz");
      await mkdir(source.tmpDir, { recursive: true });
      await execFileAsync("tar", ["czf", archivePath, "-C", sourceHomeDir, "."]);
      const archiveBuffer = await readFile(archivePath);
      const checksum = createHash("sha256").update(archiveBuffer).digest("hex");

      // Build a payload with a malicious relativePath
      const maliciousWorkState: WorkStateManifest = {
        projects: [
          {
            relativePath: "../../etc/evil",
            remoteUrl: "https://example.com/evil.git",
            branch: "main",
            commitSha: "abc123",
            uncommittedPatch: null,
            untrackedFiles: [],
          },
        ],
        capturedAt: Date.now(),
      };

      const payload: MigrationPayload = {
        portable: {
          archive: archiveBuffer,
          checksum,
          sizeBytes: archiveBuffer.length,
        },
        agentIdentity: null,
        workState: maliciousWorkState,
      };

      const targetHomeDir = join(target.homesDir, "worker-1");
      const targetWorkDir = join(target.workDir, "worker-1");
      await mkdir(targetWorkDir, { recursive: true });

      const result = await rehydrate(payload, targetHomeDir, target.logger, targetWorkDir);

      // Should succeed but skip the malicious project
      expect(result.success).toBe(true);
      expect(result.warnings.some((w) => w.includes("Path traversal detected"))).toBe(true);

      // The evil path should NOT exist
      const evilPath = join(targetWorkDir, "..", "..", "etc", "evil");
      await expect(stat(evilPath)).rejects.toThrow();
    });

    it("allows safe paths while rejecting traversal in same manifest", async () => {
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      // Create bare repo for the safe project
      const safeWorkDir = join(rootTmpDir, "safe-work");
      const gitInfo = await createGitRepo(safeWorkDir, "safe-project");
      const barePath = await createBareRepoFrom(
        gitInfo.repoPath,
        join(rootTmpDir, "bare-repos"),
        "safe-project",
      );

      const archivePath = join(source.tmpDir, "mixed-test.tar.gz");
      await mkdir(source.tmpDir, { recursive: true });
      await execFileAsync("tar", ["czf", archivePath, "-C", sourceHomeDir, "."]);
      const archiveBuffer = await readFile(archivePath);
      const checksum = createHash("sha256").update(archiveBuffer).digest("hex");

      const mixedWorkState: WorkStateManifest = {
        projects: [
          {
            relativePath: "../../etc/evil",
            remoteUrl: "https://example.com/evil.git",
            branch: "main",
            commitSha: "abc123",
            uncommittedPatch: null,
            untrackedFiles: [],
          },
          {
            relativePath: "safe-project",
            remoteUrl: barePath,
            branch: gitInfo.branch,
            commitSha: gitInfo.commitSha,
            uncommittedPatch: null,
            untrackedFiles: [],
          },
        ],
        capturedAt: Date.now(),
      };

      const payload: MigrationPayload = {
        portable: {
          archive: archiveBuffer,
          checksum,
          sizeBytes: archiveBuffer.length,
        },
        agentIdentity: null,
        workState: mixedWorkState,
      };

      const targetHomeDir = join(target.homesDir, "worker-1-mixed");
      const targetWorkDir = join(target.workDir, "worker-1-mixed");

      const result = await rehydrate(payload, targetHomeDir, target.logger, targetWorkDir);

      expect(result.success).toBe(true);

      // Traversal warning present
      expect(result.warnings.some((w) => w.includes("Path traversal detected"))).toBe(true);

      // Safe project was cloned
      const safeReadme = await readFile(join(targetWorkDir, "safe-project", "README.md"), "utf-8");
      expect(safeReadme).toContain("safe-project");
    });
  });

  // =========================================================================
  // Additional: Cross-node handler round-trip
  // =========================================================================
  describe("Cross-node handler round-trip", () => {
    it("runs request → approve → status → abort cycle via handlers", async () => {
      // Target receives a request
      const requestHandler = target.handlers.get("migration/request")!;
      const reqResp = await requestHandler(
        {
          migrationId: "cross-node-test-1",
          agentId: "worker-1",
          sourceNodeId: "source-node",
          targetNodeId: "target-node",
          reason: "orchestrator_rebalance",
          sourceEndpoint: "http://source-node:3779/flock",
        },
        { ticketStore: target.ticketStore, auditLog: target.auditLog, logger: target.logger, nodeId: "target-node" },
      );

      expect("result" in reqResp).toBe(true);

      // Target approves
      const approveHandler = target.handlers.get("migration/approve")!;
      const approveResp = await approveHandler(
        { migrationId: "cross-node-test-1" },
        { ticketStore: target.ticketStore, auditLog: target.auditLog, logger: target.logger, nodeId: "target-node" },
      );

      expect("result" in approveResp).toBe(true);
      if ("result" in approveResp) {
        expect(approveResp.result.phase).toBe("AUTHORIZED");
      }

      // Query status
      const statusHandler = target.handlers.get("migration/status")!;
      const statusResp = await statusHandler(
        { migrationId: "cross-node-test-1" },
        { ticketStore: target.ticketStore, auditLog: target.auditLog, logger: target.logger, nodeId: "target-node" },
      );

      expect("result" in statusResp).toBe(true);
      if ("result" in statusResp) {
        expect(statusResp.result.phase).toBe("AUTHORIZED");
        expect(statusResp.result.ownershipHolder).toBe("source");
      }

      // Abort
      const abortHandler = target.handlers.get("migration/abort")!;
      const abortResp = await abortHandler(
        {
          migrationId: "cross-node-test-1",
          reason: "Test complete",
          initiator: "test-runner",
        },
        { ticketStore: target.ticketStore, auditLog: target.auditLog, logger: target.logger, nodeId: "target-node" },
      );

      expect("result" in abortResp).toBe(true);
      if ("result" in abortResp) {
        expect(abortResp.result.phase).toBe("ABORTED");
      }
    });

    it("rejects duplicate migration for same agent", async () => {
      const requestHandler = target.handlers.get("migration/request")!;

      // First request succeeds
      const first = await requestHandler(
        {
          migrationId: "dup-test-1",
          agentId: "worker-dup",
          sourceNodeId: "source-node",
          targetNodeId: "target-node",
          reason: "agent_request",
          sourceEndpoint: "http://source-node:3779/flock",
        },
        { ticketStore: target.ticketStore, auditLog: target.auditLog, logger: target.logger, nodeId: "target-node" },
      );
      expect("result" in first).toBe(true);

      // Second request for same agent fails
      const second = await requestHandler(
        {
          migrationId: "dup-test-2",
          agentId: "worker-dup",
          sourceNodeId: "source-node",
          targetNodeId: "target-node",
          reason: "agent_request",
          sourceEndpoint: "http://source-node:3779/flock",
        },
        { ticketStore: target.ticketStore, auditLog: target.auditLog, logger: target.logger, nodeId: "target-node" },
      );

      expect("error" in second).toBe(true);
      if ("error" in second) {
        expect(second.error.message).toContain("already has an active migration");
      }
    });
  });

  // =========================================================================
  // Additional: Snapshot checksum integrity
  // =========================================================================
  describe("Snapshot checksum integrity", () => {
    it("end-to-end: snapshot → verify with correct checksum → pass", async () => {
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      const snapshot = await createSnapshot(
        sourceHomeDir,
        "checksum-test-1",
        source.tmpDir,
        source.logger,
      );

      const result = await verifySnapshot(snapshot.archivePath, snapshot.checksum);
      expect(result.verified).toBe(true);
    });

    it("end-to-end: snapshot → tamper → verify → fail", async () => {
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      const snapshot = await createSnapshot(
        sourceHomeDir,
        "checksum-tamper-1",
        source.tmpDir,
        source.logger,
      );

      // Tamper with the archive (append garbage bytes)
      const original = await readFile(snapshot.archivePath);
      const tampered = Buffer.concat([original, Buffer.from("TAMPERED")]);
      await writeFile(snapshot.archivePath, tampered);

      const result = await verifySnapshot(snapshot.archivePath, snapshot.checksum);
      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe("CHECKSUM_MISMATCH");
    });

    it("computeSha256 is deterministic across calls", async () => {
      setupHome(source.homeManager, "worker-1", "source-node", "ACTIVE");

      const sourceHomeDir = join(source.homesDir, "worker-1");
      await populateAgentHome(sourceHomeDir);

      const snapshot = await createSnapshot(
        sourceHomeDir,
        "deterministic-1",
        source.tmpDir,
        source.logger,
      );

      const hash1 = await computeSha256(snapshot.archivePath);
      const hash2 = await computeSha256(snapshot.archivePath);
      expect(hash1).toBe(hash2);
      expect(hash1).toBe(snapshot.checksum);
    });
  });
});
