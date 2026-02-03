/**
 * Integration test: A2A protocol over real HTTP
 *
 * Spins up an actual HTTP server with the A2A endpoints,
 * then sends JSON-RPC requests using fetch. Tests the full
 * stack: HTTP → JsonRpcTransportHandler → AgentExecutor → response.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { A2AServer } from "../../src/transport/server.js";
import {
  createWorkerCard,
  createSysadminCard,
  buildFlockMetadata,
} from "../../src/transport/agent-card.js";
import { createFlockExecutor } from "../../src/transport/executor.js";
import type { PluginLogger } from "../../src/types.js";

const logger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let server: http.Server;
let a2aServer: A2AServer;
let baseUrl: string;

beforeAll(async () => {
  a2aServer = new A2AServer({ basePath: "/flock", logger });

  // Register a worker agent with a mock sessionSend
  const { card: workerCard, meta: workerMeta } = createWorkerCard(
    "test-worker",
    "test-node",
    "http://localhost/flock/a2a/test-worker",
  );
  const workerExecutor = createFlockExecutor({
    flockMeta: workerMeta,
    sessionSend: async (_agentId: string, message: string) => {
      return `Echo: ${message}`;
    },
    logger,
    responseTimeoutMs: 5000,
  });
  a2aServer.registerAgent("test-worker", workerCard, workerMeta, workerExecutor);

  // Register a sysadmin agent — sessionSend simulates the LLM calling triage_decision
  const { card: sysCard, meta: sysMeta } = createSysadminCard(
    "test-node",
    "http://localhost/flock/a2a/sysadmin",
  );
  const { createTriageDecisionTool } = await import("../../src/sysadmin/triage-tool.js");
  const triageTool = createTriageDecisionTool();
  const sysExecutor = createFlockExecutor({
    flockMeta: sysMeta,
    sessionSend: async (_agentId: string, message: string) => {
      // Simulate: the LLM sees the triage_decision tool and calls it
      const match = message.match(/Request ID: (triage-[^\s]+)/);
      if (match?.[1]) {
        await triageTool.execute(`mock-tool-call-${Date.now()}`, {
          request_id: match[1],
          level: "GREEN",
          reasoning: "Package installation is a standard operation within agent's scope.",
          action_plan: "Install nodejs 22 via apt.",
          risk_factors: [],
        });
      }
      return "🟢 Triage classification recorded: GREEN. Package installed.";
    },
    logger,
    responseTimeoutMs: 5000,
  });
  a2aServer.registerAgent("sysadmin", sysCard, sysMeta, sysExecutor);

  // Create a real HTTP server
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";

    // Read body for POST
    let body: unknown = null;
    if (method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
    }

    // Route: POST /flock/a2a/:agentId
    const a2aMatch = url.pathname.match(/^\/flock\/a2a\/([^/]+)$/);
    if (method === "POST" && a2aMatch) {
      const agentId = a2aMatch[1];
      const result = await a2aServer.handleRequest(agentId, body);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
      return;
    }

    // Route: GET /flock/.well-known/agent-card.json
    if (method === "GET" && url.pathname === "/flock/.well-known/agent-card.json") {
      const agents = a2aServer.listAgentCards();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ agents }));
      return;
    }

    // Route: GET /flock/a2a/:agentId/agent-card.json
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

  // Listen on random port
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const addr = server.address();
  if (typeof addr === "object" && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

// --- Tests ---

describe("A2A over HTTP", () => {
  it("GET agent card directory", async () => {
    const res = await fetch(`${baseUrl}/flock/.well-known/agent-card.json`);
    expect(res.status).toBe(200);

    const data = await res.json() as { agents: Array<{ agentId: string }> };
    expect(data.agents.length).toBeGreaterThanOrEqual(2);
  });

  it("GET individual agent card", async () => {
    const res = await fetch(`${baseUrl}/flock/a2a/test-worker/agent-card.json`);
    expect(res.status).toBe(200);

    const card = await res.json() as { name: string; skills: unknown[] };
    expect(card.name).toBe("test-worker");
  });

  it("GET nonexistent agent card → 404", async () => {
    const res = await fetch(`${baseUrl}/flock/a2a/nobody/agent-card.json`);
    expect(res.status).toBe(404);
  });

  it("POST message/send to worker → completed task", async () => {
    const res = await fetch(`${baseUrl}/flock/a2a/test-worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "test-msg-1",
            role: "user",
            parts: [{ kind: "text", text: "Hello worker" }],
          },
        },
        id: "req-1",
      }),
    });

    expect(res.status).toBe(200);
    const rpc = await res.json() as {
      result?: { kind: string; status: { state: string } };
      error?: { message: string };
    };
    expect(rpc.error).toBeUndefined();
    expect(rpc.result).toBeDefined();
    // The executor echoes back
    expect(rpc.result!.kind).toBe("task");
    expect(rpc.result!.status.state).toBe("completed");
  });

  it("POST message/send to sysadmin → White classification (no triage tool call)", async () => {
    const res = await fetch(`${baseUrl}/flock/a2a/sysadmin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "test-msg-2",
            role: "user",
            parts: [
              { kind: "text", text: "Install nodejs 22" },
              {
                kind: "data",
                data: {
                  flockType: "sysadmin-request",
                  urgency: "normal",
                },
              },
            ],
          },
        },
        id: "req-2",
      }),
    });

    expect(res.status).toBe(200);
    const rpc = await res.json() as {
      result?: {
        kind: string;
        status: { state: string };
        artifacts?: Array<{ name: string; parts: Array<{ kind: string; data?: Record<string, unknown> }> }>;
      };
    };
    expect(rpc.result!.kind).toBe("task");
    expect(rpc.result!.status.state).toBe("completed");

    // Echo executor doesn't call triage_decision → White classification → response artifact
    const responseArt = rpc.result!.artifacts?.find((a) => a.name === "response");
    expect(responseArt).toBeDefined();
  });

  it("POST to unknown agent → 404 JSON-RPC error", async () => {
    const res = await fetch(`${baseUrl}/flock/a2a/ghost`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "test-msg-3",
            role: "user",
            parts: [{ kind: "text", text: "Hello?" }],
          },
        },
        id: "req-3",
      }),
    });

    expect(res.status).toBe(404);
    const rpc = await res.json() as { error?: { message: string } };
    expect(rpc.error?.message).toContain("ghost");
  });

  it("POST invalid JSON → 400", async () => {
    const res = await fetch(`${baseUrl}/flock/a2a/test-worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json {{{",
    });
    expect(res.status).toBe(400);
  });
});
