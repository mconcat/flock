import { describe, it, expect, beforeEach } from "vitest";
import { NodeRegistry } from "../../../src/nodes/registry.js";
import { onMigrationComplete } from "../../../src/migration/registry-hooks.js";
import type { MigrationTicket } from "../../../src/migration/types.js";

function makeTicket(overrides?: Partial<MigrationTicket>): MigrationTicket {
  const now = Date.now();
  return {
    migrationId: "mig-1",
    agentId: "agent-1",
    source: {
      nodeId: "node-1",
      homeId: "agent-1@node-1",
      endpoint: "http://node-1:3779/flock",
    },
    target: {
      nodeId: "node-2",
      homeId: "agent-1@node-2",
      endpoint: "http://node-2:3779/flock",
    },
    phase: "COMPLETED",
    ownershipHolder: "target",
    reason: "agent_request",
    reservationId: null,
    timestamps: { REQUESTED: now, COMPLETED: now },
    createdAt: now,
    updatedAt: now,
    error: null,
    ...overrides,
  };
}

describe("RegistryHooks", () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
  });

  describe("onMigrationComplete", () => {
    it("removes agent from source node and adds to target node", () => {
      // Register source and target nodes
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
        agentIds: ["agent-3"],
      });

      const ticket = makeTicket();
      onMigrationComplete(ticket, registry);

      // Source should no longer have agent-1
      const sourceNode = registry.get("node-1");
      expect(sourceNode).not.toBeNull();
      expect(sourceNode!.agentIds).not.toContain("agent-1");
      expect(sourceNode!.agentIds).toContain("agent-2");

      // Target should now have agent-1
      const targetNode = registry.get("node-2");
      expect(targetNode).not.toBeNull();
      expect(targetNode!.agentIds).toContain("agent-1");
      expect(targetNode!.agentIds).toContain("agent-3");
    });

    it("registers target node if not yet in registry", () => {
      registry.register({
        nodeId: "node-1",
        a2aEndpoint: "http://node-1:3779/flock",
        status: "online",
        lastSeen: Date.now(),
        agentIds: ["agent-1"],
      });

      const ticket = makeTicket();
      onMigrationComplete(ticket, registry);

      // Target node should have been registered
      const targetNode = registry.get("node-2");
      expect(targetNode).not.toBeNull();
      expect(targetNode!.agentIds).toContain("agent-1");
      expect(targetNode!.a2aEndpoint).toBe("http://node-2:3779/flock");
      expect(targetNode!.status).toBe("online");
    });

    it("handles source node not in registry gracefully", () => {
      registry.register({
        nodeId: "node-2",
        a2aEndpoint: "http://node-2:3779/flock",
        status: "online",
        lastSeen: Date.now(),
        agentIds: [],
      });

      const ticket = makeTicket();
      // Should not throw even if source node isn't registered
      onMigrationComplete(ticket, registry);

      const targetNode = registry.get("node-2");
      expect(targetNode!.agentIds).toContain("agent-1");
    });

    it("does not duplicate agent on target if already present", () => {
      registry.register({
        nodeId: "node-1",
        a2aEndpoint: "http://node-1:3779/flock",
        status: "online",
        lastSeen: Date.now(),
        agentIds: ["agent-1"],
      });
      registry.register({
        nodeId: "node-2",
        a2aEndpoint: "http://node-2:3779/flock",
        status: "online",
        lastSeen: Date.now(),
        agentIds: ["agent-1"],
      });

      const ticket = makeTicket();
      onMigrationComplete(ticket, registry);

      const targetNode = registry.get("node-2");
      const agentCount = targetNode!.agentIds.filter((id) => id === "agent-1").length;
      expect(agentCount).toBe(1);
    });

    it("removes agent from source even when source had only that agent", () => {
      registry.register({
        nodeId: "node-1",
        a2aEndpoint: "http://node-1:3779/flock",
        status: "online",
        lastSeen: Date.now(),
        agentIds: ["agent-1"],
      });
      registry.register({
        nodeId: "node-2",
        a2aEndpoint: "http://node-2:3779/flock",
        status: "online",
        lastSeen: Date.now(),
        agentIds: [],
      });

      const ticket = makeTicket();
      onMigrationComplete(ticket, registry);

      const sourceNode = registry.get("node-1");
      expect(sourceNode!.agentIds).toHaveLength(0);
    });
  });
});
