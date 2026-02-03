import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { createMigrationEngine, MigrationEngineError } from "../../../src/migration/engine.js";
import type { MigrationEngine } from "../../../src/migration/engine.js";
import { createTicketStore } from "../../../src/migration/ticket-store.js";
import type { MigrationTicketStore } from "../../../src/migration/ticket-store.js";
import { createHomeManager } from "../../../src/homes/manager.js";
import type { HomeManager } from "../../../src/homes/manager.js";
import { createMemoryDatabase } from "../../../src/db/memory.js";
import { createAuditLog } from "../../../src/audit/log.js";
import type { AuditLog } from "../../../src/audit/log.js";
import type { FlockDatabase } from "../../../src/db/interface.js";
import type { PluginLogger } from "../../../src/types.js";
import { MigrationErrorCode } from "../../../src/migration/types.js";
import { NodeRegistry } from "../../../src/nodes/registry.js";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Set up a home in a given state by walking through valid transitions.
 */
function setupHome(homeManager: HomeManager, agentId: string, nodeId: string, targetState: string): void {
  homeManager.create(agentId, nodeId);
  const homeId = `${agentId}@${nodeId}`;

  // Walk to target state
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

describe("MigrationEngine", () => {
  let db: FlockDatabase;
  let homeManager: HomeManager;
  let ticketStore: MigrationTicketStore;
  let auditLog: AuditLog;
  let engine: MigrationEngine;
  let logger: PluginLogger;

  beforeEach(() => {
    db = createMemoryDatabase();
    logger = makeLogger();
    homeManager = createHomeManager({ db, logger });
    ticketStore = createTicketStore({ logger });
    auditLog = createAuditLog({ db, logger });

    engine = createMigrationEngine({
      ticketStore,
      homeManager,
      auditLog,
      logger,
      nodeId: "node-1",
      endpoint: "http://node-1:3779/flock",
      mode: "p2p",
      tmpDir: "/tmp/flock-migration",
    });
  });

  describe("initiate", () => {
    it("creates a migration ticket in REQUESTED phase", () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");

      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      expect(ticket.phase).toBe("REQUESTED");
      expect(ticket.agentId).toBe("agent-1");
      expect(ticket.source.nodeId).toBe("node-1");
      expect(ticket.target.nodeId).toBe("node-2");
      expect(ticket.ownershipHolder).toBe("source");
      expect(ticket.reason).toBe("agent_request");
    });

    it("works with LEASED state", () => {
      setupHome(homeManager, "agent-1", "node-1", "LEASED");

      const ticket = engine.initiate("agent-1", "node-2", "node_retiring");
      expect(ticket.phase).toBe("REQUESTED");
    });

    it("throws for agent not in ACTIVE/LEASED state", () => {
      setupHome(homeManager, "agent-1", "node-1", "IDLE");

      expect(() => engine.initiate("agent-1", "node-2", "agent_request")).toThrow(
        /must be ACTIVE or LEASED/,
      );
    });

    it("throws for nonexistent agent", () => {
      expect(() => engine.initiate("nonexistent", "node-2", "agent_request")).toThrow(
        /No home found/,
      );
    });

    it("throws if agent already has an active migration", () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");

      engine.initiate("agent-1", "node-2", "agent_request");

      expect(() => engine.initiate("agent-1", "node-3", "agent_request")).toThrow(
        /already has an active migration/,
      );
    });
  });

  describe("advancePhase — happy path", () => {
    it("advances from REQUESTED → AUTHORIZED", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      const updated = await engine.advancePhase(ticket.migrationId);
      expect(updated.phase).toBe("AUTHORIZED");
    });

    it("advances AUTHORIZED → FREEZING and freezes the home", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      await engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      const updated = await engine.advancePhase(ticket.migrationId); // → FREEZING

      expect(updated.phase).toBe("FREEZING");

      // Home should be FROZEN
      const home = homeManager.get("agent-1@node-1");
      expect(home!.state).toBe("FROZEN");
    });

    it("advances through FREEZING → FROZEN → SNAPSHOTTING → TRANSFERRING → VERIFYING", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      await engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      await engine.advancePhase(ticket.migrationId); // → FREEZING
      await engine.advancePhase(ticket.migrationId); // → FROZEN
      await engine.advancePhase(ticket.migrationId); // → SNAPSHOTTING
      await engine.advancePhase(ticket.migrationId); // → TRANSFERRING

      const updated = await engine.advancePhase(ticket.migrationId); // → VERIFYING
      expect(updated.phase).toBe("VERIFYING");
    });
  });

  describe("handleVerification — ownership transfer", () => {
    it("transfers ownership on successful verification", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      // Advance to VERIFYING
      await engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      await engine.advancePhase(ticket.migrationId); // → FREEZING
      await engine.advancePhase(ticket.migrationId); // → FROZEN
      await engine.advancePhase(ticket.migrationId); // → SNAPSHOTTING
      await engine.advancePhase(ticket.migrationId); // → TRANSFERRING
      await engine.advancePhase(ticket.migrationId); // → VERIFYING

      // Verify ownership is still source
      const beforeVerify = engine.getStatus(ticket.migrationId)!;
      expect(beforeVerify.ownershipHolder).toBe("source");

      // Handle verification success
      const updated = engine.handleVerification(ticket.migrationId, {
        verified: true,
        computedChecksum: "abc123",
        verifiedAt: Date.now(),
      });

      // ★ OWNERSHIP TRANSFER POINT ★
      expect(updated.phase).toBe("REHYDRATING");
      expect(updated.ownershipHolder).toBe("target");
    });

    it("rolls back on verification failure", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      await engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      await engine.advancePhase(ticket.migrationId); // → FREEZING
      await engine.advancePhase(ticket.migrationId); // → FROZEN
      await engine.advancePhase(ticket.migrationId); // → SNAPSHOTTING
      await engine.advancePhase(ticket.migrationId); // → TRANSFERRING
      await engine.advancePhase(ticket.migrationId); // → VERIFYING

      const updated = engine.handleVerification(ticket.migrationId, {
        verified: false,
        failureReason: "CHECKSUM_MISMATCH",
        computedChecksum: "wrong",
        verifiedAt: Date.now(),
      });

      expect(updated.phase).toBe("ABORTED");
      expect(updated.ownershipHolder).toBe("source");
    });

    it("throws when not in VERIFYING phase", () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      expect(() =>
        engine.handleVerification(ticket.migrationId, {
          verified: true,
          verifiedAt: Date.now(),
        }),
      ).toThrow(/Expected phase VERIFYING/);
    });
  });

  describe("complete", () => {
    it("transitions to COMPLETED and retires source home", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      // Advance to REHYDRATING (via verification)
      await engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      await engine.advancePhase(ticket.migrationId); // → FREEZING
      await engine.advancePhase(ticket.migrationId); // → FROZEN
      await engine.advancePhase(ticket.migrationId); // → SNAPSHOTTING
      await engine.advancePhase(ticket.migrationId); // → TRANSFERRING
      await engine.advancePhase(ticket.migrationId); // → VERIFYING

      engine.handleVerification(ticket.migrationId, {
        verified: true,
        verifiedAt: Date.now(),
      });

      // Complete the migration
      const completed = await engine.complete(
        ticket.migrationId,
        "agent-1@node-2",
        "http://node-2:3779/flock",
      );

      expect(completed.phase).toBe("COMPLETED");

      // Source home should be RETIRED
      const sourceHome = homeManager.get("agent-1@node-1");
      expect(sourceHome!.state).toBe("RETIRED");
    });

    it("throws when not in FINALIZING or REHYDRATING phase", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      await expect(
        engine.complete(ticket.migrationId, "agent-1@node-2", "http://node-2:3779/flock"),
      ).rejects.toThrow(/Expected phase FINALIZING or REHYDRATING/);
    });
  });

  describe("rollback", () => {
    it("rolls back from FREEZING phase (FROZEN → LEASED)", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      await engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      await engine.advancePhase(ticket.migrationId); // → FREEZING (home → FROZEN)

      const rolled = engine.rollback(ticket.migrationId, "test rollback");

      expect(rolled.phase).toBe("ABORTED");

      // Home should be back to LEASED
      const home = homeManager.get("agent-1@node-1");
      expect(home!.state).toBe("LEASED");
    });

    it("rolls back from FROZEN phase (FROZEN → LEASED)", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      await engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      await engine.advancePhase(ticket.migrationId); // → FREEZING
      await engine.advancePhase(ticket.migrationId); // → FROZEN

      const rolled = engine.rollback(ticket.migrationId, "test rollback");

      expect(rolled.phase).toBe("ABORTED");
      const home = homeManager.get("agent-1@node-1");
      expect(home!.state).toBe("LEASED");
    });

    it("rolls back from REQUESTED phase (no home state change)", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      const rolled = engine.rollback(ticket.migrationId, "cancelled");

      expect(rolled.phase).toBe("ABORTED");

      // Home should still be ACTIVE (no state change for early phases)
      const home = homeManager.get("agent-1@node-1");
      expect(home!.state).toBe("ACTIVE");
    });

    it("throws for terminal state migration", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      engine.rollback(ticket.migrationId, "first rollback");

      expect(() => engine.rollback(ticket.migrationId, "second rollback")).toThrow(
        /terminal state/,
      );
    });
  });

  describe("getStatus / listActive", () => {
    it("returns ticket status", () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      const status = engine.getStatus(ticket.migrationId);
      expect(status).not.toBeNull();
      expect(status!.phase).toBe("REQUESTED");
    });

    it("returns null for unknown migration", () => {
      expect(engine.getStatus("nonexistent")).toBeNull();
    });

    it("lists active migrations", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      setupHome(homeManager, "agent-2", "node-1", "ACTIVE");

      engine.initiate("agent-1", "node-2", "agent_request");
      const ticket2 = engine.initiate("agent-2", "node-2", "node_retiring");

      // Both should be active
      expect(engine.listActive()).toHaveLength(2);

      // Abort one
      engine.rollback(ticket2.migrationId, "cancelled");

      // Only one should be active
      expect(engine.listActive()).toHaveLength(1);
    });
  });

  describe("audit logging", () => {
    it("records audit entries for migration events", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      await engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      await engine.advancePhase(ticket.migrationId); // → FREEZING

      const entries = auditLog.query({ agentId: "agent-1" });
      const migrationEntries = entries.filter((e) => e.action.startsWith("migration."));

      // Should have at least: initiated, frozen
      expect(migrationEntries.length).toBeGreaterThanOrEqual(2);
      expect(migrationEntries.some((e) => e.action === "migration.initiated")).toBe(true);
      expect(migrationEntries.some((e) => e.action === "migration.frozen")).toBe(true);
    });
  });

  describe("full lifecycle (happy path)", () => {
    it("completes a full migration from initiate to complete", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");

      // Phase 0: Initiate
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");
      expect(ticket.phase).toBe("REQUESTED");
      expect(ticket.ownershipHolder).toBe("source");

      // Phase 1: Authorization
      await engine.advancePhase(ticket.migrationId);
      expect(engine.getStatus(ticket.migrationId)!.phase).toBe("AUTHORIZED");

      // Phase 2: Freeze
      await engine.advancePhase(ticket.migrationId);
      expect(engine.getStatus(ticket.migrationId)!.phase).toBe("FREEZING");
      expect(homeManager.get("agent-1@node-1")!.state).toBe("FROZEN");

      await engine.advancePhase(ticket.migrationId);
      expect(engine.getStatus(ticket.migrationId)!.phase).toBe("FROZEN");

      // Phase 3: Snapshot
      await engine.advancePhase(ticket.migrationId);
      expect(engine.getStatus(ticket.migrationId)!.phase).toBe("SNAPSHOTTING");

      // Phase 4: Transfer
      await engine.advancePhase(ticket.migrationId);
      expect(engine.getStatus(ticket.migrationId)!.phase).toBe("TRANSFERRING");

      // Phase 5: Verify
      await engine.advancePhase(ticket.migrationId);
      expect(engine.getStatus(ticket.migrationId)!.phase).toBe("VERIFYING");
      expect(engine.getStatus(ticket.migrationId)!.ownershipHolder).toBe("source");

      // Verification ACK — ownership transfer
      engine.handleVerification(ticket.migrationId, {
        verified: true,
        computedChecksum: "abc",
        verifiedAt: Date.now(),
      });
      expect(engine.getStatus(ticket.migrationId)!.phase).toBe("REHYDRATING");
      expect(engine.getStatus(ticket.migrationId)!.ownershipHolder).toBe("target");

      // Phase 6: Complete
      const completed = await engine.complete(
        ticket.migrationId,
        "agent-1@node-2",
        "http://node-2:3779/flock",
      );
      expect(completed.phase).toBe("COMPLETED");
      expect(homeManager.get("agent-1@node-1")!.state).toBe("RETIRED");

      // No more active migrations
      expect(engine.listActive()).toHaveLength(0);
    });
  });

  describe("home → MIGRATING transition (I1)", () => {
    it("transitions home to MIGRATING when advancing from SNAPSHOTTING to TRANSFERRING", async () => {
      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engine.initiate("agent-1", "node-2", "agent_request");

      await engine.advancePhase(ticket.migrationId); // → AUTHORIZED
      await engine.advancePhase(ticket.migrationId); // → FREEZING (home → FROZEN)
      await engine.advancePhase(ticket.migrationId); // → FROZEN
      await engine.advancePhase(ticket.migrationId); // → SNAPSHOTTING

      // Home should still be FROZEN at SNAPSHOTTING
      expect(homeManager.get("agent-1@node-1")!.state).toBe("FROZEN");

      await engine.advancePhase(ticket.migrationId); // → TRANSFERRING (home → MIGRATING)

      // Home should now be MIGRATING
      expect(homeManager.get("agent-1@node-1")!.state).toBe("MIGRATING");

      const status = engine.getStatus(ticket.migrationId);
      expect(status!.phase).toBe("TRANSFERRING");
    });
  });

  describe("registry hooks integration", () => {
    it("updates registry on migration complete", async () => {
      const registry = new NodeRegistry();
      registry.register({
        nodeId: "node-1",
        a2aEndpoint: "http://node-1:3779/flock",
        status: "online",
        lastSeen: Date.now(),
        agentIds: ["agent-1", "agent-2"],
      });
      registry.register({
        nodeId: "node-2",
        a2aEndpoint: "http://node-2:3779/flock",
        status: "online",
        lastSeen: Date.now(),
        agentIds: [],
      });

      // Create engine with registry
      const engineWithRegistry = createMigrationEngine({
        ticketStore,
        homeManager,
        auditLog,
        logger,
        nodeId: "node-1",
        endpoint: "http://node-1:3779/flock",
        mode: "p2p",
        tmpDir: "/tmp/flock-migration",
        registry,
      });

      setupHome(homeManager, "agent-1", "node-1", "ACTIVE");
      const ticket = engineWithRegistry.initiate("agent-1", "node-2", "agent_request");

      // Advance to REHYDRATING
      await engineWithRegistry.advancePhase(ticket.migrationId);
      await engineWithRegistry.advancePhase(ticket.migrationId);
      await engineWithRegistry.advancePhase(ticket.migrationId);
      await engineWithRegistry.advancePhase(ticket.migrationId);
      await engineWithRegistry.advancePhase(ticket.migrationId);
      await engineWithRegistry.advancePhase(ticket.migrationId);

      engineWithRegistry.handleVerification(ticket.migrationId, {
        verified: true,
        verifiedAt: Date.now(),
      });

      // Complete migration
      engineWithRegistry.complete(
        ticket.migrationId,
        "agent-1@node-2",
        "http://node-2:3779/flock",
      );

      // Check registry was updated
      const sourceNode = registry.get("node-1");
      expect(sourceNode!.agentIds).not.toContain("agent-1");
      expect(sourceNode!.agentIds).toContain("agent-2");

      const targetNode = registry.get("node-2");
      expect(targetNode!.agentIds).toContain("agent-1");
    });
  });

  describe("error handling", () => {
    it("MigrationEngineError has correct code", () => {
      const err = new MigrationEngineError(
        MigrationErrorCode.FREEZE_INVALID_STATE,
        "test error",
      );
      expect(err.code).toBe(MigrationErrorCode.FREEZE_INVALID_STATE);
      expect(err.name).toBe("MigrationEngineError");
      expect(err.message).toBe("test error");
    });
  });
});
