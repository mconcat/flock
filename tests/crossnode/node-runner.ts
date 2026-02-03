/**
 * Cross-Node Test — Node Runner
 *
 * Standalone script that creates a Flock A2A node with echo agents.
 * Designed to run inside Docker containers for cross-node testing.
 *
 * Features:
 *   - A2A server with echo agents
 *   - A2AClient with AgentRouter for transparent cross-node routing
 *   - /flock/proxy-send endpoint so the test runner can trigger
 *     agent-to-agent sends through the router (local or remote)
 *
 * Environment variables:
 *   FLOCK_NODE_ID     — This node's identity (e.g. "node-1")
 *   FLOCK_PORT        — Port to listen on (e.g. 3001)
 *   FLOCK_AGENTS      — Comma-separated agent IDs to register
 *   FLOCK_REMOTE_NODES — Comma-separated "nodeId:endpoint" pairs
 */

import http from "node:http";
import { A2AServer } from "../../src/transport/server.js";
import { createA2AClient } from "../../src/transport/client.js";
import { createPeerResolver } from "../../src/transport/topologies/peer.js";
import { createWorkerCard } from "../../src/transport/agent-card.js";
import { createEchoExecutor } from "../../src/transport/echo-executor.js";
import { NodeRegistry } from "../../src/nodes/registry.js";
import { discoverRemoteAgents } from "../../src/nodes/discovery.js";
import type { PluginLogger } from "../../src/types.js";

const logger: PluginLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
  debug: (msg) => console.log(msg),
};

const nodeId = process.env.FLOCK_NODE_ID ?? "node-1";
const port = parseInt(process.env.FLOCK_PORT ?? "3001", 10);
const agentNames = (process.env.FLOCK_AGENTS ?? "echo-agent")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const remoteNodeSpecs = (process.env.FLOCK_REMOTE_NODES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// --- Create A2A Server + Node Registry ---
const a2aServer = new A2AServer({ basePath: "/flock", logger });
const nodeRegistry = new NodeRegistry();

// Register local agents
for (const agentId of agentNames) {
  const endpointUrl = `http://localhost:${port}/flock/a2a/${agentId}`;
  const { card, meta } = createWorkerCard(agentId, nodeId, endpointUrl);
  const executor = createEchoExecutor({ agentId, logger });
  a2aServer.registerAgent(agentId, card, meta, executor);
  logger.info(`[${nodeId}] Registered agent: ${agentId}`);
}

// Register remote nodes
for (const spec of remoteNodeSpecs) {
  const colonIdx = spec.indexOf(":");
  if (colonIdx === -1) continue;
  const remoteNodeId = spec.slice(0, colonIdx);
  const remoteEndpoint = spec.slice(colonIdx + 1);
  nodeRegistry.register({
    nodeId: remoteNodeId,
    a2aEndpoint: remoteEndpoint,
    status: "unknown",
    lastSeen: 0,
    agentIds: [],
  });
  logger.info(`[${nodeId}] Registered remote node: ${remoteNodeId} at ${remoteEndpoint}`);
}

// --- Create A2AClient with peer resolver for transparent routing ---
const resolve = createPeerResolver(a2aServer, nodeRegistry);
const a2aClient = createA2AClient({
  localServer: a2aServer,
  resolve,
  logger,
});

// Track whether remote discovery has completed
let discoveryComplete = false;

// --- Type guard for proxy-send request body ---
interface ProxySendBody {
  targetAgentId: string;
  message: string;
}

function isProxySendBody(v: unknown): v is ProxySendBody {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.targetAgentId === "string" && typeof obj.message === "string";
}

// --- Create HTTP Server ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const method = req.method ?? "GET";

  // Health check — includes discovery status
  if (method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      nodeId,
      agents: agentNames,
      discoveryComplete,
    }));
    return;
  }

  // POST /flock/proxy-send — Test harness: send via A2AClient (transparent routing)
  if (method === "POST" && url.pathname === "/flock/proxy-send") {
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

    if (!isProxySendBody(body)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Expected { targetAgentId: string, message: string }" }));
      return;
    }

    try {
      const result = await a2aClient.sendMessage(body.targetAgentId, body.message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        taskId: result.taskId,
        state: result.state,
        response: result.response,
        artifactCount: result.artifacts.length,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[${nodeId}] proxy-send error: ${msg}`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

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

  res.writeHead(404);
  res.end("Not found");
});

server.listen(port, "0.0.0.0", () => {
  logger.info(`[${nodeId}] A2A server listening on port ${port}`);
  logger.info(`[${nodeId}] Agents: ${agentNames.join(", ")}`);

  // Background: discover remote agents with retries
  if (remoteNodeSpecs.length > 0) {
    runDiscovery().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[${nodeId}] Discovery fatal error: ${msg}`);
    });
  } else {
    discoveryComplete = true;
  }
});

/** Retry discovery until all remote nodes have been contacted. */
async function runDiscovery(): Promise<void> {
  const maxAttempts = 15;
  const delayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, delayMs));

    let allDiscovered = true;

    for (const node of nodeRegistry.list()) {
      // Skip nodes that already have discovered agents
      if (node.agentIds.length > 0) continue;

      try {
        const agents = await discoverRemoteAgents(node.a2aEndpoint, logger);
        const ids = agents.map((a) => a.agentId);
        if (ids.length > 0) {
          nodeRegistry.updateAgents(node.nodeId, ids);
          nodeRegistry.updateStatus(node.nodeId, "online");
          logger.info(`[${nodeId}] Discovered ${ids.length} agent(s) on ${node.nodeId}: ${ids.join(", ")}`);
        } else {
          allDiscovered = false;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[${nodeId}] Discovery attempt ${attempt} failed for ${node.nodeId}: ${msg}`);
        allDiscovered = false;
      }
    }

    if (allDiscovered) {
      discoveryComplete = true;
      logger.info(`[${nodeId}] Discovery complete after ${attempt} attempt(s)`);
      return;
    }
  }

  // Mark complete even on partial discovery so tests can proceed
  discoveryComplete = true;
  logger.warn(`[${nodeId}] Discovery finished with partial results after ${maxAttempts} attempts`);
}
