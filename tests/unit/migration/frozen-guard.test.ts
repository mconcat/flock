import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { checkFrozenStatus } from "../../../src/migration/frozen-guard.js";
import { createTicketStore } from "../../../src/migration/ticket-store.js";
import type { MigrationTicketStore } from "../../../src/migration/ticket-store.js";
import type { MigrationPhase } from "../../../src/migration/types.js";
import type { PluginLogger } from "../../../src/types.js";

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

/** Walk a ticket to the given phase via the happy path. */
function walkToPhase(store: MigrationTicketStore, migrationId: string, targetPhase: MigrationPhase): void {
  const orderedPhases: MigrationPhase[] = [
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

  for (const phase of orderedPhases) {
    store.updatePhase(migrationId, phase);
    if (phase === targetPhase) break;
  }
}

describe("FrozenGuard", () => {
  let store: MigrationTicketStore;

  beforeEach(() => {
    store = createTicketStore({ logger: makeLogger() });
  });

  describe("checkFrozenStatus", () => {
    it("returns rejected=false when agent has no migrations", () => {
      const result = checkFrozenStatus("agent-1", store);
      expect(result.rejected).toBe(false);
      expect(result.reason).toBeUndefined();
      expect(result.estimatedDowntimeMs).toBeUndefined();
    });

    it("returns rejected=false for REQUESTED phase", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });

      const result = checkFrozenStatus("agent-1", store);
      expect(result.rejected).toBe(false);
    });

    it("returns rejected=false for AUTHORIZED phase", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });
      walkToPhase(store, "mig-1", "AUTHORIZED");

      const result = checkFrozenStatus("agent-1", store);
      expect(result.rejected).toBe(false);
    });

    const frozenPhases: MigrationPhase[] = [
      "FREEZING",
      "FROZEN",
      "SNAPSHOTTING",
      "TRANSFERRING",
      "VERIFYING",
      "REHYDRATING",
    ];

    for (const phase of frozenPhases) {
      it(`returns rejected=true for ${phase} phase`, () => {
        store.create({
          migrationId: "mig-1",
          agentId: "agent-1",
          source: makeSourceEndpoint(),
          target: makeTargetEndpoint(),
          reason: "agent_request",
        });
        walkToPhase(store, "mig-1", phase);

        const result = checkFrozenStatus("agent-1", store);
        expect(result.rejected).toBe(true);
        expect(result.reason).toContain("agent-1");
        expect(result.reason).toContain(phase);
        expect(result.reason).toContain("mig-1");
        expect(result.estimatedDowntimeMs).toBeGreaterThan(0);
      });
    }

    it("returns rejected=false for FINALIZING phase", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });
      walkToPhase(store, "mig-1", "FINALIZING");

      const result = checkFrozenStatus("agent-1", store);
      expect(result.rejected).toBe(false);
    });

    it("returns rejected=false for COMPLETED phase", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });
      walkToPhase(store, "mig-1", "COMPLETED");

      const result = checkFrozenStatus("agent-1", store);
      expect(result.rejected).toBe(false);
    });

    it("returns rejected=false for ABORTED phase", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });
      store.updatePhase("mig-1", "ABORTED");

      const result = checkFrozenStatus("agent-1", store);
      expect(result.rejected).toBe(false);
    });

    it("checks the correct agent — no cross-agent interference", () => {
      // agent-1 is frozen
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });
      walkToPhase(store, "mig-1", "FROZEN");

      // agent-2 should not be affected
      const result = checkFrozenStatus("agent-2", store);
      expect(result.rejected).toBe(false);
    });

    it("includes estimated downtime in result", () => {
      store.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: makeSourceEndpoint(),
        target: makeTargetEndpoint(),
        reason: "agent_request",
      });
      walkToPhase(store, "mig-1", "TRANSFERRING");

      const result = checkFrozenStatus("agent-1", store);
      expect(result.rejected).toBe(true);
      expect(result.estimatedDowntimeMs).toBe(300_000); // ~5 min for TRANSFERRING
    });
  });
});
