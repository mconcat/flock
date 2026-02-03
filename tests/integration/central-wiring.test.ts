/**
 * Integration test: Central topology wiring.
 *
 * Verifies that the plugin registers correctly in central mode
 * and that the topology selection produces the right resolver behavior.
 */

import { describe, it, expect } from "vitest";
import { resolveFlockConfig } from "../../src/config.js";
import { createCentralResolver, createCentralSysadminResolver, createCentralExecution } from "../../src/transport/topologies/central.js";
import { createPeerResolver } from "../../src/transport/topologies/peer.js";
import { createAssignmentStore } from "../../src/nodes/assignment.js";
import { NodeRegistry } from "../../src/nodes/registry.js";
import { A2AServer } from "../../src/transport/server.js";
import { createA2AClient } from "../../src/transport/client.js";
import { createWorkerCard } from "../../src/transport/agent-card.js";
import { createEchoExecutor } from "../../src/transport/echo-executor.js";
import type { PluginLogger } from "../../src/types.js";

const logger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("Config topology field", () => {
  it("defaults to peer when not specified", () => {
    const config = resolveFlockConfig({});
    expect(config.topology).toBe("peer");
  });

  it("accepts 'peer' topology", () => {
    const config = resolveFlockConfig({ topology: "peer" });
    expect(config.topology).toBe("peer");
  });

  it("accepts 'central' topology", () => {
    const config = resolveFlockConfig({ topology: "central" });
    expect(config.topology).toBe("central");
  });

  it("defaults to peer for invalid topology values", () => {
    const config = resolveFlockConfig({ topology: "mesh" });
    expect(config.topology).toBe("peer");
  });

  it("defaults to peer for non-string topology", () => {
    const config = resolveFlockConfig({ topology: 42 });
    expect(config.topology).toBe("peer");
  });
});

describe("Central topology wiring", () => {
  it("central resolver routes all agents locally", async () => {
    const resolve = createCentralResolver();

    const route = await resolve("any-worker");
    expect(route.local).toBe(true);
  });

  it("peer resolver routes remote agents to remote endpoint", async () => {
    const server = new A2AServer({ basePath: "/flock", logger });
    const registry = new NodeRegistry();

    registry.register({
      nodeId: "remote-node",
      a2aEndpoint: "http://remote:3779/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: ["remote-worker"],
    });

    const resolve = createPeerResolver(server, registry);
    const route = await resolve("remote-worker");
    expect(route.local).toBe(false);
  });

  it("topology selection produces different routing behavior", async () => {
    const server = new A2AServer({ basePath: "/flock", logger });
    const registry = new NodeRegistry();

    registry.register({
      nodeId: "remote-node",
      a2aEndpoint: "http://remote:3779/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: ["worker-x"],
    });

    const peerResolve = createPeerResolver(server, registry);
    const centralResolve = createCentralResolver();

    // Same agent ID, different topologies
    const peerRoute = await peerResolve("worker-x");
    const centralRoute = await centralResolve("worker-x");

    // Peer routes remotely, central routes locally
    expect(peerRoute.local).toBe(false);
    expect(centralRoute.local).toBe(true);
  });
});

describe("Central A2AClient with sysadmin resolver", () => {
  it("creates client with both resolvers", () => {
    const server = new A2AServer({ basePath: "/flock", logger });
    const assignments = createAssignmentStore();
    const registry = new NodeRegistry();

    const resolve = createCentralResolver();
    const resolveSysadmin = createCentralSysadminResolver(assignments, registry);

    const client = createA2AClient({
      localServer: server,
      resolve,
      resolveSysadmin,
      logger,
    });

    expect(client).toBeDefined();
    expect(client.sendMessage).toBeTypeOf("function");
    expect(client.sendSysadminRequest).toBeTypeOf("function");
  });

  it("sendMessage routes locally in central mode", async () => {
    const server = new A2AServer({ basePath: "/flock", logger });

    // Register a local agent
    const { card, meta } = createWorkerCard(
      "worker-1",
      "central-node",
      "http://localhost/flock/a2a/worker-1",
    );
    const executor = createEchoExecutor({ agentId: "worker-1", logger });
    server.registerAgent("worker-1", card, meta, executor);

    const resolve = createCentralResolver();
    const client = createA2AClient({
      localServer: server,
      resolve,
      logger,
    });

    // Should route locally and get a response from the echo executor
    const result = await client.sendMessage("worker-1", "hello from central");
    expect(result.state).toBe("completed");
    expect(result.response).toContain("hello from central");
  });
});

describe("Central execution — getNode + reassign", () => {
  it("full migration flow: assign → query → reassign → query", async () => {
    const assignments = createAssignmentStore();
    const { getNode, reassign } = createCentralExecution(assignments);

    // Initially unassigned
    expect(await getNode("worker-1")).toBeNull();

    // Assign to node-A
    await assignments.set("worker-1", "node-A", "/data/w1");
    expect(await getNode("worker-1")).toBe("node-A");

    // Migrate to node-B
    await reassign("worker-1", "node-B");
    expect(await getNode("worker-1")).toBe("node-B");

    // Portable path preserved
    const assignment = assignments.get("worker-1");
    expect(assignment!.portablePath).toBe("/data/w1");
  });
});
