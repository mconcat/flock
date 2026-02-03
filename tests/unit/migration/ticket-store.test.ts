import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { createTicketStore } from "../../../src/migration/ticket-store.js";
import type { MigrationTicketStore } from "../../../src/migration/ticket-store.js";
import type { PluginLogger } from "../../../src/types.js";
import type { MigrationPhase } from "../../../src/migration/types.js";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeSourceEndpoint() {
  return {
    nodeId: "node-1",
    homeId: "agent-1@node-1",
    endpoint: "http://node-1:3779/flock",
  };
}

function makeTargetEndpoint() {
  return {
    nodeId: "node-2",
    homeId: "agent-1@node-2",
    endpoint: "http://node-2:3779/flock",
  };
}

describe("MigrationTicketStore", () => {
  let store: MigrationTicketStore;

  beforeEach(() => {
    store = createTicketStore({ logger: makeLogger() });
  });

  describe("create", () => {
    it("creates a ticket in REQUESTED phase", () => {
      const ticket = store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      expect(ticket.migrationId).toBe("mig-1");
      expect(ticket.agentId).toBe("agent-1");
      expect(ticket.phase).toBe("REQUESTED");
      expect(ticket.ownershipHolder).toBe("source");
      expect(ticket.reservationId).toBeNull();
      expect(ticket.error).toBeNull();
      expect(ticket.createdAt).toBeGreaterThan(0);
      expect(ticket.updatedAt).toBeGreaterThan(0);
      expect(ticket.timestamps.REQUESTED).toBeGreaterThan(0);
    });

    it("stores source and target endpoints", () => {
      const ticket = store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "node_retiring",
      });

      expect(ticket.source.nodeId).toBe("node-1");
      expect(ticket.source.homeId).toBe("agent-1@node-1");
      expect(ticket.target.nodeId).toBe("node-2");
      expect(ticket.target.homeId).toBe("agent-1@node-2");
    });

    it("throws if migration ID already exists", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      expect(() =>
        store.create({
          migrationId: "mig-1",
          agentId: "agent-2",
          source: makeSourceEndpoint(),
          target: makeTargetEndpoint(),
          reason: "agent_request",
        }),
      ).toThrow(/already exists/);
    });
  });

  describe("get", () => {
    it("returns ticket by migration ID", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      const ticket = store.get("mig-1");
      expect(ticket).not.toBeNull();
      expect(ticket!.migrationId).toBe("mig-1");
    });

    it("returns null for unknown migration ID", () => {
      expect(store.get("nonexistent")).toBeNull();
    });

    it("returns a clone (mutations don't affect store)", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      const ticket = store.get("mig-1")!;
      ticket.phase = "COMPLETED"; // mutate the clone

      const fresh = store.get("mig-1")!;
      expect(fresh.phase).toBe("REQUESTED"); // store is unaffected
    });
  });

  describe("getByAgent", () => {
    it("returns all tickets for an agent", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });
      store.create({
        migrationId: "mig-2",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: { ...makeTargetEndpoint(), nodeId: "node-3", homeId: "agent-1@node-3" },
        reason: "node_retiring",
      });
      store.create({
        migrationId: "mig-3",
        agentId: "agent-2",
        source: { ...makeSourceEndpoint(), homeId: "agent-2@node-1" },
        target: { ...makeTargetEndpoint(), homeId: "agent-2@node-2" },
        reason: "agent_request",
      });

      const tickets = store.getByAgent("agent-1");
      expect(tickets).toHaveLength(2);
      expect(tickets.every((t) => t.agentId === "agent-1")).toBe(true);
    });

    it("returns empty array for unknown agent", () => {
      expect(store.getByAgent("unknown-agent")).toHaveLength(0);
    });
  });

  describe("updatePhase", () => {
    it("transitions through the happy path", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      const phases: MigrationPhase[] = [
        "AUTHORIZED",
        "FREEZING",
        "FROZEN",
        "SNAPSHOTTING",
        "TRANSFERRING",
        "VERIFYING",
        "REHYDRATING",
        "FINALIZING",
        "COMPLETED",
      ];

      for (const phase of phases) {
        const updated = store.updatePhase("mig-1", phase);
        expect(updated.phase).toBe(phase);
        expect(updated.timestamps[phase]).toBeGreaterThan(0);
      }
    });

    it("rejects invalid phase transitions", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      // REQUESTED → TRANSFERRING is not valid (must go through AUTHORIZED first)
      expect(() => store.updatePhase("mig-1", "TRANSFERRING")).toThrow(/Invalid phase transition/);
    });

    it("rejects transitions from terminal states", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      store.updatePhase("mig-1", "ABORTED");

      // Cannot transition from ABORTED (terminal)
      expect(() => store.updatePhase("mig-1", "REQUESTED")).toThrow(/terminal state/);
    });

    it("allows ROLLING_BACK → ABORTED", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      store.updatePhase("mig-1", "AUTHORIZED");
      store.updatePhase("mig-1", "FREEZING");
      store.updatePhase("mig-1", "FROZEN");
      store.updatePhase("mig-1", "ROLLING_BACK");

      const updated = store.updatePhase("mig-1", "ABORTED");
      expect(updated.phase).toBe("ABORTED");
    });

    it("allows any non-terminal phase to transition to FAILED", () => {
      const testPhases: MigrationPhase[] = [
        "REQUESTED",
        "AUTHORIZED",
        "FREEZING",
        "FROZEN",
        "SNAPSHOTTING",
        "TRANSFERRING",
        "VERIFYING",
        "REHYDRATING",
        "FINALIZING",
        "ROLLING_BACK",
      ];

      for (const phase of testPhases) {
        const migId = `mig-fail-${phase}`;
        store.create({
          migrationId: migId,
          agentId: "agent-1",
          source: makeSourceEndpoint(),
          target: makeTargetEndpoint(),
          reason: "agent_request",
        });

        // Walk to the target phase
        const pathToPhase = getPathToPhase(phase);
        for (const p of pathToPhase) {
          store.updatePhase(migId, p);
        }

        // Now transition to FAILED
        const updated = store.updatePhase(migId, "FAILED");
        expect(updated.phase).toBe("FAILED");
      }
    });

    it("throws for unknown migration ID", () => {
      expect(() => store.updatePhase("nonexistent", "AUTHORIZED")).toThrow(/not found/);
    });
  });

  describe("update", () => {
    it("updates ownershipHolder", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      const updated = store.update("mig-1", { ownershipHolder: "target" });
      expect(updated.ownershipHolder).toBe("target");
    });

    it("updates reservationId", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      const updated = store.update("mig-1", { reservationId: "res-123" });
      expect(updated.reservationId).toBe("res-123");
    });

    it("updates error field", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      const updated = store.update("mig-1", {
        error: {
          code: 5001,
          message: "Checksum mismatch",
          phase: "VERIFYING",
          origin: "target",
          recovery: { type: "auto_rollback" },
        },
      });

      expect(updated.error).not.toBeNull();
      expect(updated.error!.code).toBe(5001);
    });

    it("validates phase transitions when phase is included", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      // Valid: REQUESTED → AUTHORIZED
      const updated = store.update("mig-1", { phase: "AUTHORIZED" });
      expect(updated.phase).toBe("AUTHORIZED");

      // Invalid: AUTHORIZED → COMPLETED
      expect(() => store.update("mig-1", { phase: "COMPLETED" })).toThrow(/Invalid phase transition/);
    });
  });

  describe("list", () => {
    it("lists all tickets", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });
      store.create({
        migrationId: "mig-2",
        agentId: "agent-2",
        source: { ...makeSourceEndpoint(), homeId: "agent-2@node-1" },
        target: { ...makeTargetEndpoint(), homeId: "agent-2@node-2" },
        reason: "node_retiring",
      });

      const all = store.list();
      expect(all).toHaveLength(2);
    });

    it("filters by agentId", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });
      store.create({
        migrationId: "mig-2",
        agentId: "agent-2",
        source: { ...makeSourceEndpoint(), homeId: "agent-2@node-1" },
        target: { ...makeTargetEndpoint(), homeId: "agent-2@node-2" },
        reason: "node_retiring",
      });

      const filtered = store.list({ agentId: "agent-1" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].agentId).toBe("agent-1");
    });

    it("filters by phase", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });
      store.create({
        migrationId: "mig-2",
        agentId: "agent-2",
        source: { ...makeSourceEndpoint(), homeId: "agent-2@node-1" },
        target: { ...makeTargetEndpoint(), homeId: "agent-2@node-2" },
        reason: "node_retiring",
      });

      store.updatePhase("mig-1", "AUTHORIZED");

      const requested = store.list({ phase: "REQUESTED" });
      expect(requested).toHaveLength(1);
      expect(requested[0].migrationId).toBe("mig-2");

      const authorized = store.list({ phase: "AUTHORIZED" });
      expect(authorized).toHaveLength(1);
      expect(authorized[0].migrationId).toBe("mig-1");
    });

    it("filters by sourceNodeId", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      const filtered = store.list({ sourceNodeId: "node-1" });
      expect(filtered).toHaveLength(1);

      const empty = store.list({ sourceNodeId: "node-99" });
      expect(empty).toHaveLength(0);
    });
  });

  describe("remove", () => {
    it("removes a ticket", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      const removed = store.remove("mig-1");
      expect(removed).toBe(true);
      expect(store.get("mig-1")).toBeNull();
    });

    it("returns false for nonexistent ticket", () => {
      expect(store.remove("nonexistent")).toBe(false);
    });
  });
});

// --- Helper: get path to a specific phase ---

function getPathToPhase(targetPhase: MigrationPhase): MigrationPhase[] {
  // All start at REQUESTED — return the path from REQUESTED to targetPhase (exclusive)
  const orderedPhases: MigrationPhase[] = [
    "REQUESTED",
    "AUTHORIZED",
    "FREEZING",
    "FROZEN",
    "SNAPSHOTTING",
    "TRANSFERRING",
    "VERIFYING",
    "REHYDRATING",
    "FINALIZING",
  ];

  // Special case: ROLLING_BACK comes from FROZEN
  if (targetPhase === "ROLLING_BACK") {
    return ["AUTHORIZED", "FREEZING", "FROZEN", "ROLLING_BACK"];
  }

  const path: MigrationPhase[] = [];
  for (const phase of orderedPhases) {
    // Skip REQUESTED since that's the starting phase
    if (phase === "REQUESTED") continue;
    if (phase === targetPhase) break;
    path.push(phase);
  }
  return path;
}
