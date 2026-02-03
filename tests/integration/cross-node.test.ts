/**
 * Cross-Node Integration Test
 *
 * Spins up TWO A2A HTTP servers in the same process, each representing
 * a separate Flock node. Tests bidirectional cross-node A2A communication.
 *
 * This is the KEY Phase 3 test — proves multi-node works without Docker.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { A2AServer } from "../../src/transport/server.js";
import { createA2AClient } from "../../src/transport/client.js";
import type { A2AClient } from "../../src/transport/client.js";
import { createPeerResolver } from "../../src/transport/topologies/peer.js";
import { NodeRegistry } from "../../src/nodes/registry.js";
import { createWorkerCard } from "../../src/transport/agent-card.js";
import { createEchoExecutor } from "../../src/transport/echo-executor.js";
import { discoverRemoteAgents } from "../../src/nodes/discovery.js";
import type { PluginLogger } from "../../src/types.js";

const logger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// --- Node 1 ---
let node1Http: http.Server;
let node1A2A: A2AServer;
let node1Client: A2AClient;
let node1Registry: NodeRegistry;
let node1Url: string;

// --- Node 2 ---
let node2Http: http.Server;
let node2A2A: A2AServer;
let node2Client: A2AClient;
let node2Registry: NodeRegistry;
let node2Url: string;

/** Create an HTTP server that routes /flock/* to an A2AServer. */
function createA2AHttpServer(a2aServer: A2AServer): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";

    // POST /flock/a2a/:agentId
    if (method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);

      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const agentMatch = url.pathname.match(/^\/flock\/a2a\/([^/]+)$/);
      if (agentMatch) {
        const result = await a2aServer.handleRequest(agentMatch[1], body);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }
    }

    // GET /flock/.well-known/agent-card.json
    if (method === "GET" && url.pathname === "/flock/.well-known/agent-card.json") {
      const agents = a2aServer.listAgentCards();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        agents: agents.map((a) => ({ id: a.agentId, ...a.card })),
      }));
      return;
    }

    // GET /flock/a2a/:agentId/agent-card.json
    const cardMatch = url.pathname.match(/^\/flock\/a2a\/([^/]+)\/agent-card\.json$/);
    if (method === "GET" && cardMatch) {
      const card = a2aServer.getAgentCard(cardMatch[1]);
      if (!card) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(card));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });
}

async function startServer(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (typeof addr === "object" && addr !== null) {
    return `http://127.0.0.1:${addr.port}/flock`;
  }
  throw new Error("Failed to get server address");
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

beforeAll(async () => {
  // --- Create Node 1 ---
  node1A2A = new A2AServer({ basePath: "/flock", logger });

  const { card: worker1Card, meta: worker1Meta } = createWorkerCard(
    "worker-alpha",
    "node-1",
    "http://localhost/flock/a2a/worker-alpha",
  );
  const executor1 = createEchoExecutor({ agentId: "worker-alpha", logger });
  node1A2A.registerAgent("worker-alpha", worker1Card, worker1Meta, executor1);

  node1Http = createA2AHttpServer(node1A2A);
  node1Url = await startServer(node1Http);

  // --- Create Node 2 ---
  node2A2A = new A2AServer({ basePath: "/flock", logger });

  const { card: worker2Card, meta: worker2Meta } = createWorkerCard(
    "worker-beta",
    "node-2",
    "http://localhost/flock/a2a/worker-beta",
  );
  const executor2 = createEchoExecutor({ agentId: "worker-beta", logger });
  node2A2A.registerAgent("worker-beta", worker2Card, worker2Meta, executor2);

  node2Http = createA2AHttpServer(node2A2A);
  node2Url = await startServer(node2Http);

  // --- Wire Node 1 → Node 2 ---
  node1Registry = new NodeRegistry();
  node1Registry.register({
    nodeId: "node-2",
    a2aEndpoint: node2Url,
    status: "online",
    lastSeen: Date.now(),
    agentIds: ["worker-beta"],
  });

  const resolve1 = createPeerResolver(node1A2A, node1Registry);
  node1Client = createA2AClient({
    localServer: node1A2A,
    resolve: resolve1,
    logger,
  });

  // --- Wire Node 2 → Node 1 ---
  node2Registry = new NodeRegistry();
  node2Registry.register({
    nodeId: "node-1",
    a2aEndpoint: node1Url,
    status: "online",
    lastSeen: Date.now(),
    agentIds: ["worker-alpha"],
  });

  const resolve2 = createPeerResolver(node2A2A, node2Registry);
  node2Client = createA2AClient({
    localServer: node2A2A,
    resolve: resolve2,
    logger,
  });
});

afterAll(async () => {
  await Promise.all([stopServer(node1Http), stopServer(node2Http)]);
});

// --- Tests ---

describe("Cross-Node A2A Communication", () => {
  describe("Node 1 → Node 2", () => {
    it("Node 1 can reach its own local agent", async () => {
      const result = await node1Client.sendMessage("worker-alpha", "ping local");
      expect(result.state).toBe("completed");
      expect(result.response).toContain("[worker-alpha] echo:");
    });

    it("Node 1 sends message to Node 2 agent via HTTP", async () => {
      const result = await node1Client.sendMessage("worker-beta", "Hello from node-1!");
      expect(result.state).toBe("completed");
      expect(result.response).toContain("[worker-beta] echo:");
      expect(result.response).toContain("Hello from node-1!");
    });

    it("returns valid task metadata from cross-node call", async () => {
      const result = await node1Client.sendMessage("worker-beta", "metadata test");
      expect(result.taskId).toBeTruthy();
      expect(typeof result.taskId).toBe("string");
      expect(result.artifacts.length).toBeGreaterThan(0);
    });
  });

  describe("Node 2 → Node 1 (bidirectional)", () => {
    it("Node 2 can reach its own local agent", async () => {
      const result = await node2Client.sendMessage("worker-beta", "ping local");
      expect(result.state).toBe("completed");
      expect(result.response).toContain("[worker-beta] echo:");
    });

    it("Node 2 sends message to Node 1 agent via HTTP", async () => {
      const result = await node2Client.sendMessage("worker-alpha", "Hello from node-2!");
      expect(result.state).toBe("completed");
      expect(result.response).toContain("[worker-alpha] echo:");
      expect(result.response).toContain("Hello from node-2!");
    });
  });

  describe("Agent Card Discovery", () => {
    it("discovers agents on Node 2 from Node 1", async () => {
      const agents = await discoverRemoteAgents(node2Url, logger);
      expect(agents.length).toBe(1);
      expect(agents[0].agentId).toBe("worker-beta");
      expect(agents[0].card.name).toBe("worker-beta");
    });

    it("discovers agents on Node 1 from Node 2", async () => {
      const agents = await discoverRemoteAgents(node1Url, logger);
      expect(agents.length).toBe(1);
      expect(agents[0].agentId).toBe("worker-alpha");
    });

    it("discovery handles unreachable endpoint gracefully", async () => {
      const agents = await discoverRemoteAgents("http://127.0.0.1:1/flock", logger);
      expect(agents).toEqual([]);
    });
  });

  describe("Multiple round-trips", () => {
    it("handles concurrent cross-node messages", async () => {
      const [r1, r2, r3] = await Promise.all([
        node1Client.sendMessage("worker-beta", "concurrent-1"),
        node2Client.sendMessage("worker-alpha", "concurrent-2"),
        node1Client.sendMessage("worker-beta", "concurrent-3"),
      ]);

      expect(r1.state).toBe("completed");
      expect(r2.state).toBe("completed");
      expect(r3.state).toBe("completed");
      expect(r1.response).toContain("concurrent-1");
      expect(r2.response).toContain("concurrent-2");
      expect(r3.response).toContain("concurrent-3");
    });
  });
});
