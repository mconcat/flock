/**
 * Tests for peer resolver — local/remote/parent routing decisions.
 *
 * Formerly tested AgentRouter class; now tests createPeerResolver factory.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import http from "node:http";
import { createPeerResolver } from "../../src/transport/topologies/peer.js";
import type { ResolveAgent } from "../../src/transport/routing.js";
import { A2AServer } from "../../src/transport/server.js";
import { NodeRegistry } from "../../src/nodes/registry.js";
import { createWorkerCard } from "../../src/transport/agent-card.js";
import { createEchoExecutor } from "../../src/transport/echo-executor.js";
import type { PluginLogger } from "../../src/types.js";

const logger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("createPeerResolver", () => {
  let server: A2AServer;
  let registry: NodeRegistry;
  let resolve: ResolveAgent;

  beforeEach(() => {
    server = new A2AServer({ basePath: "/flock", logger });
    registry = new NodeRegistry();
    resolve = createPeerResolver(server, registry);

    // Register a local agent
    const { card, meta } = createWorkerCard(
      "local-worker",
      "local-node",
      "http://localhost/flock/a2a/local-worker",
    );
    const executor = createEchoExecutor({ agentId: "local-worker", logger });
    server.registerAgent("local-worker", card, meta, executor);

    // Register a remote node with agents
    registry.register({
      nodeId: "remote-node",
      a2aEndpoint: "http://node2:3002/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: ["remote-worker"],
    });
  });

  it("routes local agent to local", async () => {
    const route = await resolve("local-worker");
    expect(route.local).toBe(true);
  });

  it("routes remote agent to remote endpoint", async () => {
    const route = await resolve("remote-worker");
    expect(route.local).toBe(false);
    if (!route.local) {
      expect(route.endpoint).toBe("http://node2:3002/flock");
      expect(route.nodeId).toBe("remote-node");
    }
  });

  it("falls back to local for unknown agents", async () => {
    const route = await resolve("unknown-agent");
    expect(route.local).toBe(true);
  });

  it("falls back to local when remote node is offline", async () => {
    registry.updateStatus("remote-node", "offline");
    const route = await resolve("remote-worker");
    expect(route.local).toBe(true);
  });

  it("routes to remote when status is unknown (not offline)", async () => {
    registry.updateStatus("remote-node", "unknown");
    const route = await resolve("remote-worker");
    expect(route.local).toBe(false);
  });

  it("prefers local agent over remote with same ID", async () => {
    registry.register({
      nodeId: "other-node",
      a2aEndpoint: "http://node3:3003/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: ["local-worker"],
    });

    const route = await resolve("local-worker");
    expect(route.local).toBe(true);
  });
});

describe("createPeerResolver — parent registry fallback", () => {
  let server: A2AServer;
  let registry: NodeRegistry;
  let resolve: ResolveAgent;
  let parentHttpServer: http.Server;
  let parentUrl: string;

  beforeEach(async () => {
    server = new A2AServer({ basePath: "/flock", logger });
    registry = new NodeRegistry();

    // Register a local agent
    const { card, meta } = createWorkerCard(
      "local-worker",
      "local-node",
      "http://localhost/flock/a2a/local-worker",
    );
    const executor = createEchoExecutor({ agentId: "local-worker", logger });
    server.registerAgent("local-worker", card, meta, executor);

    // Spin up parent registry HTTP server
    parentHttpServer = http.createServer((req, res) => {
      if (req.url === "/flock/.well-known/agent-card.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          agents: [
            { id: "parent-worker", name: "parent-worker", url: "http://far-node:5000/flock/a2a/parent-worker" },
          ],
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((res) => {
      parentHttpServer.listen(0, "127.0.0.1", res);
    });

    const addr = parentHttpServer.address();
    if (typeof addr === "object" && addr !== null) {
      parentUrl = `http://127.0.0.1:${addr.port}/flock`;
    }

    registry.setParent({ endpoint: parentUrl });

    // Create resolver after parent is set
    resolve = createPeerResolver(server, registry);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      parentHttpServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("resolves agent from parent when not found locally", async () => {
    const route = await resolve("parent-worker");
    expect(route.local).toBe(false);
    if (!route.local) {
      expect(route.endpoint).toBe("http://far-node:5000/flock");
      expect(route.nodeId).toContain("parent-resolved");
    }
  });

  it("prefers local over parent", async () => {
    const route = await resolve("local-worker");
    expect(route.local).toBe(true);
  });

  it("prefers local registry over parent", async () => {
    registry.register({
      nodeId: "known-node",
      a2aEndpoint: "http://known:3002/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: ["parent-worker"],
    });

    const route = await resolve("parent-worker");
    expect(route.local).toBe(false);
    if (!route.local) {
      expect(route.endpoint).toBe("http://known:3002/flock");
      expect(route.nodeId).toBe("known-node");
    }
  });

  it("caches parent result — second call doesn't need parent", async () => {
    // First call — hits parent
    await resolve("parent-worker");

    // Kill parent server
    await new Promise<void>((resolve, reject) => {
      parentHttpServer.close((err) => (err ? reject(err) : resolve()));
    });

    // Second call — should use cached local entry
    const route = await resolve("parent-worker");
    expect(route.local).toBe(false);
    if (!route.local) {
      expect(route.endpoint).toBe("http://far-node:5000/flock");
    }
  });

  it("falls back to local when parent also doesn't know the agent", async () => {
    const route = await resolve("totally-unknown");
    expect(route.local).toBe(true);
  });
});
