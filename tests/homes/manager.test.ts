import { describe, it, expect, beforeEach } from "vitest";
import { createHomeManager } from "../../src/homes/manager.js";
import { createMemoryDatabase } from "../../src/db/memory.js";
import type { FlockDatabase } from "../../src/db/interface.js";
import type { PluginLogger } from "../../src/types.js";
import { vi } from "vitest";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("HomeManager", () => {
  let db: FlockDatabase;
  let manager: ReturnType<typeof createHomeManager>;

  beforeEach(() => {
    db = createMemoryDatabase();
    manager = createHomeManager({ db, logger: makeLogger() });
  });

  describe("create", () => {
    it("creates home with state UNASSIGNED", () => {
      const home = manager.create("agent-1", "node-1");
      expect(home.homeId).toBe("agent-1@node-1");
      expect(home.agentId).toBe("agent-1");
      expect(home.nodeId).toBe("node-1");
      expect(home.state).toBe("UNASSIGNED");
      expect(home.leaseExpiresAt).toBeNull();
      expect(home.createdAt).toBeGreaterThan(0);
      expect(home.updatedAt).toBeGreaterThan(0);
    });

    it("throws if home already exists", () => {
      manager.create("agent-1", "node-1");
      expect(() => manager.create("agent-1", "node-1")).toThrow(/already exists/);
    });
  });

  describe("get", () => {
    it("returns home by homeId", () => {
      manager.create("agent-1", "node-1");
      const home = manager.get("agent-1@node-1");
      expect(home).not.toBeNull();
      expect(home!.agentId).toBe("agent-1");
    });

    it("returns null for unknown homeId", () => {
      expect(manager.get("nonexistent@node")).toBeNull();
    });
  });

  describe("valid transitions", () => {
    it("UNASSIGNED → PROVISIONING → IDLE → LEASED → ACTIVE → FROZEN", () => {
      manager.create("agent-1", "node-1");
      const homeId = "agent-1@node-1";

      let t = manager.transition(homeId, "PROVISIONING", "starting", "system");
      expect(t.fromState).toBe("UNASSIGNED");
      expect(t.toState).toBe("PROVISIONING");

      t = manager.transition(homeId, "IDLE", "ready", "system");
      expect(t.fromState).toBe("PROVISIONING");
      expect(t.toState).toBe("IDLE");

      t = manager.transition(homeId, "LEASED", "assigned to user", "admin");
      expect(t.fromState).toBe("IDLE");
      expect(t.toState).toBe("LEASED");

      t = manager.transition(homeId, "ACTIVE", "agent connected", "agent-1");
      expect(t.fromState).toBe("LEASED");
      expect(t.toState).toBe("ACTIVE");

      t = manager.transition(homeId, "FROZEN", "lease expired", "system");
      expect(t.fromState).toBe("ACTIVE");
      expect(t.toState).toBe("FROZEN");
    });

    it("any state can transition to ERROR (except RETIRED)", () => {
      manager.create("a1", "n1");
      manager.transition("a1@n1", "PROVISIONING", "starting", "system");
      manager.transition("a1@n1", "ERROR", "something broke", "system");
      const home = manager.get("a1@n1");
      expect(home!.state).toBe("ERROR");
    });

    it("FROZEN → LEASED (re-lease)", () => {
      manager.create("a2", "n1");
      manager.transition("a2@n1", "PROVISIONING", "init", "system");
      manager.transition("a2@n1", "IDLE", "ready", "system");
      manager.transition("a2@n1", "FROZEN", "freeze", "system");
      manager.transition("a2@n1", "LEASED", "re-leased", "admin");
      const home = manager.get("a2@n1");
      expect(home!.state).toBe("LEASED");
    });
  });

  describe("invalid transitions", () => {
    it("throws on invalid transition", () => {
      manager.create("agent-1", "node-1");
      // UNASSIGNED → ACTIVE is not valid
      expect(() =>
        manager.transition("agent-1@node-1", "ACTIVE", "skip", "system"),
      ).toThrow(/invalid transition/);
    });

    it("throws when transitioning from RETIRED (terminal)", () => {
      manager.create("agent-1", "node-1");
      manager.transition("agent-1@node-1", "RETIRED", "done", "system");
      expect(() =>
        manager.transition("agent-1@node-1", "UNASSIGNED", "restart", "system"),
      ).toThrow(/invalid transition/);
    });

    it("throws for unknown homeId", () => {
      expect(() =>
        manager.transition("nonexistent@node", "IDLE", "test", "system"),
      ).toThrow(/not found/);
    });
  });

  describe("setLeaseExpiry", () => {
    it("sets lease expiry on a home", () => {
      manager.create("agent-1", "node-1");
      const expiry = Date.now() + 60_000;
      manager.setLeaseExpiry("agent-1@node-1", expiry);

      const home = manager.get("agent-1@node-1");
      expect(home!.leaseExpiresAt).toBe(expiry);
    });
  });

  describe("list with filters", () => {
    it("lists all homes", () => {
      manager.create("a1", "n1");
      manager.create("a2", "n1");
      manager.create("a3", "n2");

      const all = manager.list();
      expect(all).toHaveLength(3);
    });

    it("filters by nodeId", () => {
      manager.create("a1", "n1");
      manager.create("a2", "n2");

      const n1Homes = manager.list({ nodeId: "n1" });
      expect(n1Homes).toHaveLength(1);
      expect(n1Homes[0].nodeId).toBe("n1");
    });

    it("filters by state", () => {
      manager.create("a1", "n1");
      manager.create("a2", "n1");
      manager.transition("a1@n1", "PROVISIONING", "init", "system");

      const provisioning = manager.list({ state: "PROVISIONING" });
      expect(provisioning).toHaveLength(1);
      expect(provisioning[0].homeId).toBe("a1@n1");

      const unassigned = manager.list({ state: "UNASSIGNED" });
      expect(unassigned).toHaveLength(1);
      expect(unassigned[0].homeId).toBe("a2@n1");
    });
  });

  describe("checkLeaseExpiry", () => {
    it("freezes homes with expired leases", () => {
      manager.create("a1", "n1");
      manager.transition("a1@n1", "PROVISIONING", "init", "system");
      manager.transition("a1@n1", "IDLE", "ready", "system");
      manager.transition("a1@n1", "LEASED", "assigned", "admin");
      // Set expiry in the past
      manager.setLeaseExpiry("a1@n1", Date.now() - 1000);

      const expired = manager.checkLeaseExpiry();
      expect(expired).toHaveLength(1);
      expect(expired[0].toState).toBe("FROZEN");

      const home = manager.get("a1@n1");
      expect(home!.state).toBe("FROZEN");
    });

    it("does not freeze homes with future leases", () => {
      manager.create("a1", "n1");
      manager.transition("a1@n1", "PROVISIONING", "init", "system");
      manager.transition("a1@n1", "IDLE", "ready", "system");
      manager.transition("a1@n1", "LEASED", "assigned", "admin");
      manager.setLeaseExpiry("a1@n1", Date.now() + 60_000);

      const expired = manager.checkLeaseExpiry();
      expect(expired).toHaveLength(0);
    });
  });
});
