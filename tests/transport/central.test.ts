/**
 * Tests for central topology resolvers.
 *
 * Central mode: all workers local, sysadmin via assignment lookup.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createCentralResolver,
  createCentralSysadminResolver,
  createCentralExecution,
} from "../../src/transport/topologies/central.js";
import { createAssignmentStore } from "../../src/nodes/assignment.js";
import { NodeRegistry } from "../../src/nodes/registry.js";
import type { AssignmentStore } from "../../src/nodes/assignment.js";
import type { ResolveAgent, ResolveSysadmin } from "../../src/transport/routing.js";

describe("createCentralResolver", () => {
  let resolve: ResolveAgent;

  beforeEach(() => {
    resolve = createCentralResolver();
  });

  it("routes any agent locally", async () => {
    const route = await resolve("worker-alpha");
    expect(route.local).toBe(true);
  });

  it("routes unknown agents locally", async () => {
    const route = await resolve("nonexistent");
    expect(route.local).toBe(true);
  });

  it("routes multiple agents locally", async () => {
    const agents = ["worker-1", "worker-2", "worker-3", "sysadmin"];
    for (const agentId of agents) {
      const route = await resolve(agentId);
      expect(route.local).toBe(true);
    }
  });
});

describe("createCentralSysadminResolver", () => {
  let assignments: AssignmentStore;
  let registry: NodeRegistry;
  let resolve: ResolveSysadmin;

  beforeEach(() => {
    assignments = createAssignmentStore();
    registry = new NodeRegistry();
    resolve = createCentralSysadminResolver(assignments, registry);
  });

  it("falls back to local when agent has no assignment", async () => {
    const route = await resolve("unassigned-worker");
    expect(route.local).toBe(true);
  });

  it("routes to remote node when agent is assigned", async () => {
    // Register a remote node
    registry.register({
      nodeId: "node-A",
      a2aEndpoint: "http://node-a:3779/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: ["sysadmin"],
    });

    // Assign the worker to that node
    await assignments.set("worker-1", "node-A");

    const route = await resolve("worker-1");
    expect(route.local).toBe(false);
    if (!route.local) {
      expect(route.endpoint).toBe("http://node-a:3779/flock");
      expect(route.nodeId).toBe("node-A");
    }
  });

  it("falls back to local when assigned node is offline", async () => {
    registry.register({
      nodeId: "node-A",
      a2aEndpoint: "http://node-a:3779/flock",
      status: "offline",
      lastSeen: Date.now() - 60_000,
      agentIds: ["sysadmin"],
    });

    await assignments.set("worker-1", "node-A");

    const route = await resolve("worker-1");
    expect(route.local).toBe(true);
  });

  it("falls back to local when assigned node is not in registry", async () => {
    await assignments.set("worker-1", "unknown-node");

    const route = await resolve("worker-1");
    expect(route.local).toBe(true);
  });

  it("routes to correct node when multiple nodes exist", async () => {
    registry.register({
      nodeId: "node-A",
      a2aEndpoint: "http://node-a:3779/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: [],
    });
    registry.register({
      nodeId: "node-B",
      a2aEndpoint: "http://node-b:3779/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: [],
    });

    await assignments.set("worker-1", "node-A");
    await assignments.set("worker-2", "node-B");

    const route1 = await resolve("worker-1");
    expect(route1.local).toBe(false);
    if (!route1.local) {
      expect(route1.endpoint).toBe("http://node-a:3779/flock");
    }

    const route2 = await resolve("worker-2");
    expect(route2.local).toBe(false);
    if (!route2.local) {
      expect(route2.endpoint).toBe("http://node-b:3779/flock");
    }
  });

  it("routes to updated node after reassignment", async () => {
    registry.register({
      nodeId: "node-A",
      a2aEndpoint: "http://node-a:3779/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: [],
    });
    registry.register({
      nodeId: "node-B",
      a2aEndpoint: "http://node-b:3779/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: [],
    });

    await assignments.set("worker-1", "node-A");
    let route = await resolve("worker-1");
    expect(route.local).toBe(false);
    if (!route.local) {
      expect(route.endpoint).toBe("http://node-a:3779/flock");
    }

    // Reassign to node-B
    await assignments.set("worker-1", "node-B");
    route = await resolve("worker-1");
    expect(route.local).toBe(false);
    if (!route.local) {
      expect(route.endpoint).toBe("http://node-b:3779/flock");
    }
  });
});

describe("createCentralExecution", () => {
  let assignments: AssignmentStore;

  beforeEach(() => {
    assignments = createAssignmentStore();
  });

  describe("getNode", () => {
    it("returns null for unassigned agent", async () => {
      const { getNode } = createCentralExecution(assignments);
      const nodeId = await getNode("unassigned");
      expect(nodeId).toBeNull();
    });

    it("returns the assigned node", async () => {
      await assignments.set("worker-1", "node-A");
      const { getNode } = createCentralExecution(assignments);
      const nodeId = await getNode("worker-1");
      expect(nodeId).toBe("node-A");
    });
  });

  describe("reassign", () => {
    it("moves agent to new node", async () => {
      await assignments.set("worker-1", "node-A", "/data/w1");
      const { reassign, getNode } = createCentralExecution(assignments);

      await reassign("worker-1", "node-B");

      const nodeId = await getNode("worker-1");
      expect(nodeId).toBe("node-B");

      // Preserves portable path
      const assignment = assignments.get("worker-1");
      expect(assignment!.portablePath).toBe("/data/w1");
    });

    it("creates assignment if agent was not previously assigned", async () => {
      const { reassign, getNode } = createCentralExecution(assignments);

      await reassign("new-worker", "node-C");

      const nodeId = await getNode("new-worker");
      expect(nodeId).toBe("node-C");
    });
  });
});
