/**
 * Tests for A2AClient remote send — cross-node HTTP communication.
 *
 * Uses a real HTTP server to test the remote send path without mocks.
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
import type { PluginLogger } from "../../src/types.js";

const logger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let remoteHttpServer: http.Server;
let remoteA2AServer: A2AServer;
let remoteUrl: string;

let localA2AServer: A2AServer;
let nodeRegistry: NodeRegistry;
let client: A2AClient;

beforeAll(async () => {
  // --- Set up the "remote" node ---
  remoteA2AServer = new A2AServer({ basePath: "/flock", logger });

  const { card: remoteCard, meta: remoteMeta } = createWorkerCard(
    "remote-echo",
    "remote-node",
    "http://localhost/flock/a2a/remote-echo",
  );
  const remoteExecutor = createEchoExecutor({ agentId: "remote-echo", logger });
  remoteA2AServer.registerAgent("remote-echo", remoteCard, remoteMeta, remoteExecutor);

  // Spin up a real HTTP server for the remote node
  remoteHttpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";

    if (method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      const agentMatch = url.pathname.match(/^\/flock\/a2a\/([^/]+)$/);
      if (agentMatch) {
        const result = await remoteA2AServer.handleRequest(agentMatch[1], body);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }
    }

    if (method === "GET" && url.pathname === "/flock/.well-known/agent-card.json") {
      const agents = remoteA2AServer.listAgentCards();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        agents: agents.map((a) => ({ id: a.agentId, ...a.card })),
      }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    remoteHttpServer.listen(0, "127.0.0.1", resolve);
  });
  const addr = remoteHttpServer.address();
  if (typeof addr === "object" && addr !== null) {
    remoteUrl = `http://127.0.0.1:${addr.port}/flock`;
  }

  // --- Set up the "local" node with client + resolver ---
  localA2AServer = new A2AServer({ basePath: "/flock", logger });

  // Register a local agent
  const { card: localCard, meta: localMeta } = createWorkerCard(
    "local-echo",
    "local-node",
    "http://localhost/flock/a2a/local-echo",
  );
  const localExecutor = createEchoExecutor({ agentId: "local-echo", logger });
  localA2AServer.registerAgent("local-echo", localCard, localMeta, localExecutor);

  // Set up node registry pointing to the remote server
  nodeRegistry = new NodeRegistry();
  nodeRegistry.register({
    nodeId: "remote-node",
    a2aEndpoint: remoteUrl,
    status: "online",
    lastSeen: Date.now(),
    agentIds: ["remote-echo"],
  });

  const resolve = createPeerResolver(localA2AServer, nodeRegistry);

  client = createA2AClient({
    localServer: localA2AServer,
    resolve,
    logger,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    remoteHttpServer.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("A2AClient remote send", () => {
  it("sends message to local agent via local path", async () => {
    const result = await client.sendMessage("local-echo", "Hello local");
    expect(result.state).toBe("completed");
    expect(result.response).toContain("[local-echo] echo:");
    expect(result.response).toContain("Hello local");
  });

  it("sends message to remote agent via HTTP", async () => {
    const result = await client.sendMessage("remote-echo", "Hello remote");
    expect(result.state).toBe("completed");
    expect(result.response).toContain("[remote-echo] echo:");
    expect(result.response).toContain("Hello remote");
  });

  it("remote send returns valid task structure", async () => {
    const result = await client.sendMessage("remote-echo", "Structure test");
    expect(result.taskId).toBeTruthy();
    expect(typeof result.taskId).toBe("string");
    expect(result.artifacts.length).toBeGreaterThan(0);
  });

  it("throws for agent not found locally or remotely", async () => {
    await expect(
      client.sendMessage("nobody", "Hello?"),
    ).rejects.toThrow();
  });
});
