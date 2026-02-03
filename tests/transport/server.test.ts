import { describe, it, expect, beforeEach, vi } from "vitest";
import { A2AServer } from "../../src/transport/server.js";
import { createAgentCard, buildFlockMetadata } from "../../src/transport/agent-card.js";
import type { CreateCardParams } from "../../src/transport/agent-card.js";
import type { PluginLogger } from "../../src/types.js";
import type { AgentExecutor } from "@a2a-js/sdk/server";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeExecutor(): AgentExecutor {
  return {
    execute: vi.fn().mockImplementation(async (_ctx, eventBus) => {
      eventBus.publish({
        kind: "task",
        id: "test-task",
        contextId: "test-ctx",
        status: { state: "completed" },
      });
      eventBus.finished();
    }),
    cancelTask: vi.fn().mockImplementation(async (_taskId, eventBus) => {
      eventBus.finished();
    }),
  };
}

describe("A2AServer", () => {
  let server: A2AServer;
  const agentParams: CreateCardParams = {
    agentId: "agent-1",
    nodeId: "node-1",
    role: "worker",
    endpointUrl: "http://localhost:3000/flock/a2a/agent-1",
  };

  beforeEach(() => {
    server = new A2AServer({ basePath: "/flock", logger: makeLogger() });
  });

  describe("registerAgent / listAgentCards", () => {
    it("registered agent appears in listAgentCards", () => {
      const card = createAgentCard(agentParams);
      const meta = buildFlockMetadata(agentParams);
      server.registerAgent("agent-1", card, meta, makeExecutor());

      const agents = server.listAgentCards();
      expect(agents).toHaveLength(1);
      expect(agents[0].agentId).toBe("agent-1");
      expect(agents[0].card.name).toBe("agent-1");
    });

    it("getAgentCard returns card for registered agent", () => {
      const card = createAgentCard(agentParams);
      const meta = buildFlockMetadata(agentParams);
      server.registerAgent("agent-1", card, meta, makeExecutor());

      const retrieved = server.getAgentCard("agent-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("agent-1");
    });

    it("getAgentMeta returns metadata for registered agent", () => {
      const card = createAgentCard(agentParams);
      const meta = buildFlockMetadata(agentParams);
      server.registerAgent("agent-1", card, meta, makeExecutor());

      const retrievedMeta = server.getAgentMeta("agent-1");
      expect(retrievedMeta).not.toBeNull();
      expect(retrievedMeta!.role).toBe("worker");
    });
  });

  describe("handleRequest", () => {
    it("for registered agent returns JSON-RPC response", async () => {
      const card = createAgentCard(agentParams);
      const meta = buildFlockMetadata(agentParams);
      server.registerAgent("agent-1", card, meta, makeExecutor());

      const jsonRpcRequest = {
        jsonrpc: "2.0",
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "test-msg-1",
            role: "user",
            parts: [{ kind: "text", text: "hello" }],
          },
        },
        id: "req-1",
      };

      const result = await server.handleRequest("agent-1", jsonRpcRequest);
      expect(result.status).toBe(200);
      expect(result.body).toBeDefined();
    });

    it("for unknown agent returns 404", async () => {
      const result = await server.handleRequest("nonexistent", {
        jsonrpc: "2.0",
        method: "message/send",
        params: {},
        id: "req-1",
      });

      expect(result.status).toBe(404);
      const body = result.body as { error?: { message?: string } };
      expect(body.error?.message).toContain("Agent not found");
    });
  });

  describe("unregisterAgent", () => {
    it("removes agent and returns true", () => {
      const card = createAgentCard(agentParams);
      const meta = buildFlockMetadata(agentParams);
      server.registerAgent("agent-1", card, meta, makeExecutor());

      expect(server.unregisterAgent("agent-1")).toBe(true);
      expect(server.getAgentCard("agent-1")).toBeNull();
      expect(server.listAgentCards()).toHaveLength(0);
    });

    it("returns false for unknown agent", () => {
      expect(server.unregisterAgent("nonexistent")).toBe(false);
    });
  });
});
