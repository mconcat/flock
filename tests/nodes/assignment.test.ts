/**
 * Tests for AssignmentStore — agent→node assignment tracking.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createAssignmentStore } from "../../src/nodes/assignment.js";
import type { AssignmentStore } from "../../src/nodes/assignment.js";

describe("createAssignmentStore", () => {
  let store: AssignmentStore;

  beforeEach(() => {
    store = createAssignmentStore();
  });

  describe("get / set", () => {
    it("returns null for unknown agent", () => {
      expect(store.get("nonexistent")).toBeNull();
    });

    it("stores and retrieves an assignment", async () => {
      await store.set("worker-1", "node-A", "/data/worker-1");

      const assignment = store.get("worker-1");
      expect(assignment).not.toBeNull();
      expect(assignment!.agentId).toBe("worker-1");
      expect(assignment!.nodeId).toBe("node-A");
      expect(assignment!.portablePath).toBe("/data/worker-1");
      expect(assignment!.assignedAt).toBeGreaterThan(0);
    });

    it("returns a copy (not the internal reference)", async () => {
      await store.set("worker-1", "node-A", "/data/w1");

      const a = store.get("worker-1");
      const b = store.get("worker-1");
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it("updates an existing assignment", async () => {
      await store.set("worker-1", "node-A", "/data/w1");
      await store.set("worker-1", "node-B", "/data/w1-migrated");

      const assignment = store.get("worker-1");
      expect(assignment!.nodeId).toBe("node-B");
      expect(assignment!.portablePath).toBe("/data/w1-migrated");
    });

    it("preserves portablePath when not provided on update", async () => {
      await store.set("worker-1", "node-A", "/data/w1");
      await store.set("worker-1", "node-B");

      const assignment = store.get("worker-1");
      expect(assignment!.nodeId).toBe("node-B");
      expect(assignment!.portablePath).toBe("/data/w1");
    });

    it("defaults portablePath to empty string when never set", async () => {
      await store.set("worker-1", "node-A");

      const assignment = store.get("worker-1");
      expect(assignment!.portablePath).toBe("");
    });
  });

  describe("getNodeId", () => {
    it("returns null for unknown agent", async () => {
      const nodeId = await store.getNodeId("nonexistent");
      expect(nodeId).toBeNull();
    });

    it("returns the nodeId for an assigned agent", async () => {
      await store.set("worker-1", "node-A");
      const nodeId = await store.getNodeId("worker-1");
      expect(nodeId).toBe("node-A");
    });
  });

  describe("remove", () => {
    it("removes an assignment", async () => {
      await store.set("worker-1", "node-A");
      await store.remove("worker-1");

      expect(store.get("worker-1")).toBeNull();
    });

    it("is a no-op for unknown agent", async () => {
      // Should not throw
      await store.remove("nonexistent");
    });
  });

  describe("listByNode", () => {
    it("returns empty array for unknown node", () => {
      expect(store.listByNode("unknown")).toEqual([]);
    });

    it("returns assignments for a specific node", async () => {
      await store.set("worker-1", "node-A", "/w1");
      await store.set("worker-2", "node-A", "/w2");
      await store.set("worker-3", "node-B", "/w3");

      const nodeA = store.listByNode("node-A");
      expect(nodeA).toHaveLength(2);
      expect(nodeA.map((a) => a.agentId).sort()).toEqual(["worker-1", "worker-2"]);

      const nodeB = store.listByNode("node-B");
      expect(nodeB).toHaveLength(1);
      expect(nodeB[0].agentId).toBe("worker-3");
    });

    it("returns copies of assignments", async () => {
      await store.set("worker-1", "node-A");

      const list1 = store.listByNode("node-A");
      const list2 = store.listByNode("node-A");
      expect(list1[0]).not.toBe(list2[0]);
      expect(list1[0]).toEqual(list2[0]);
    });
  });

  describe("list", () => {
    it("returns empty array when no assignments", () => {
      expect(store.list()).toEqual([]);
    });

    it("returns all assignments", async () => {
      await store.set("worker-1", "node-A");
      await store.set("worker-2", "node-B");
      await store.set("worker-3", "node-A");

      const all = store.list();
      expect(all).toHaveLength(3);
      expect(all.map((a) => a.agentId).sort()).toEqual(["worker-1", "worker-2", "worker-3"]);
    });
  });
});
