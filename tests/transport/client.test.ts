import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createA2AClient } from "../../src/transport/client.js";
import type { A2AClient } from "../../src/transport/client.js";
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

function makeExecutor(response?: string): AgentExecutor {
  const responseText = response ?? "Agent response";
  return {
    execute: vi.fn().mockImplementation(async (ctx, eventBus) => {
      eventBus.publish({
        kind: "task",
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: "completed", message: {
          kind: "message",
          messageId: "resp-1",
          role: "agent",
          parts: [{ kind: "text", text: responseText }],
        }},
        artifacts: [{
          artifactId: "art-1",
          name: "response",
          parts: [{ kind: "text", text: responseText }],
        }],
      });
      eventBus.finished();
    }),
    cancelTask: vi.fn().mockImplementation(async (_taskId, eventBus) => {
      eventBus.finished();
    }),
  };
}

describe("createA2AClient", () => {
  let server: A2AServer;
  let client: A2AClient;
  const agentParams: CreateCardParams = {
    agentId: "agent-1",
    nodeId: "node-1",
    role: "worker",
    endpointUrl: "http://localhost:3000/flock/a2a/agent-1",
  };

  beforeEach(() => {
    server = new A2AServer({ basePath: "/flock", logger: makeLogger() });
    client = createA2AClient({ localServer: server, logger: makeLogger() });
  });

  describe("sendMessage", () => {
    it("with local server gets result back", async () => {
      const card = createAgentCard(agentParams);
      const meta = buildFlockMetadata(agentParams);
      server.registerAgent("agent-1", card, meta, makeExecutor("Hello back!"));

      const result = await client.sendMessage("agent-1", "Hello");
      expect(result.state).toBe("completed");
      expect(result.response).toContain("Hello back!");
    });

    it("to unknown agent throws error", async () => {
      await expect(
        client.sendMessage("nonexistent", "Hello"),
      ).rejects.toThrow(/Agent not found|404/);
    });
  });

  describe("sendSysadminRequest", () => {
    it("gets triage result", async () => {
      const sysParams: CreateCardParams = {
        agentId: "sysadmin",
        nodeId: "node-1",
        role: "sysadmin",
        endpointUrl: "http://localhost:3000/flock/a2a/sysadmin",
      };
      const card = createAgentCard(sysParams);
      const meta = buildFlockMetadata(sysParams);
      server.registerAgent("sysadmin", card, meta, makeExecutor("GREEN: Approved"));

      const result = await client.sendSysadminRequest("sysadmin", "Install package", {
        urgency: "normal",
        project: "test",
      });
      expect(result.state).toBe("completed");
      expect(result.response).toBeTruthy();
    });
  });

  describe("no local server", () => {
    it("throws error when no local server configured", async () => {
      const noServerClient = createA2AClient({ logger: makeLogger() });
      await expect(
        noServerClient.sendMessage("agent-1", "Hello"),
      ).rejects.toThrow(/No local server/);
    });
  });

  describe("getAgentCard / listAgents", () => {
    it("getAgentCard returns card from local registry", () => {
      const card = createAgentCard(agentParams);
      const meta = buildFlockMetadata(agentParams);
      server.registerAgent("agent-1", card, meta, makeExecutor());

      const retrieved = client.getAgentCard("agent-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("agent-1");
    });

    it("listAgents returns all registered agents", () => {
      server.registerAgent("agent-1", createAgentCard(agentParams), buildFlockMetadata(agentParams), makeExecutor());
      const agents = client.listAgents();
      expect(agents).toHaveLength(1);
    });
  });

  describe("remote failure simulation", () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    
    beforeEach(() => {
      // Mock global fetch for remote failure tests
      mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("handles network timeouts (AbortSignal)", async () => {
      const resolver = vi.fn().mockResolvedValue({
        local: false,
        endpoint: "http://remote-agent.example.com:3000/flock"
      });

      const clientWithResolver = createA2AClient({
        resolve: resolver,
        logger: makeLogger(),
        defaultTimeoutMs: 100, // Short timeout for test
      });

      // Mock fetch to simulate timeout
      mockFetch.mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error("This operation was aborted")), 200);
        });
      });

      await expect(
        clientWithResolver.sendMessage("remote-agent", "Hello")
      ).rejects.toThrow(/aborted|timeout/i);

      expect(resolver).toHaveBeenCalledWith("remote-agent");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://remote-agent.example.com:3000/flock/a2a/remote-agent",
        expect.objectContaining({
          method: "POST",
          signal: expect.any(AbortSignal),
        })
      );
    });

    it("handles HTTP 500 error responses", async () => {
      const resolver = vi.fn().mockResolvedValue({
        local: false,
        endpoint: "http://remote-agent.example.com:3000/flock"
      });

      const clientWithResolver = createA2AClient({
        resolve: resolver,
        logger: makeLogger(),
      });

      // Mock fetch to return HTTP 500
      mockFetch.mockResolvedValue({
        status: 500,
        json: vi.fn().mockResolvedValue({
          error: { code: -32603, message: "Internal server error" }
        }),
      });

      await expect(
        clientWithResolver.sendMessage("remote-agent", "Hello")
      ).rejects.toThrow(/A2A request failed \(500\)/);
    });

    it("handles HTTP 503 service unavailable", async () => {
      const resolver = vi.fn().mockResolvedValue({
        local: false,
        endpoint: "http://remote-agent.example.com:3000/flock"
      });

      const clientWithResolver = createA2AClient({
        resolve: resolver,
        logger: makeLogger(),
      });

      // Mock fetch to return HTTP 503
      mockFetch.mockResolvedValue({
        status: 503,
        json: vi.fn().mockResolvedValue({
          error: "Service temporarily unavailable"
        }),
      });

      await expect(
        clientWithResolver.sendMessage("remote-agent", "Hello")
      ).rejects.toThrow(/A2A request failed \(503\)/);
    });

    it("handles JSON-RPC error responses", async () => {
      const resolver = vi.fn().mockResolvedValue({
        local: false,
        endpoint: "http://remote-agent.example.com:3000/flock"
      });

      const clientWithResolver = createA2AClient({
        resolve: resolver,
        logger: makeLogger(),
      });

      // Mock fetch to return HTTP 200 but with JSON-RPC error
      mockFetch.mockResolvedValue({
        status: 200,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          error: {
            code: -32601,
            message: "Method not found"
          },
          id: "test-id"
        }),
      });

      await expect(
        clientWithResolver.sendMessage("remote-agent", "Hello")
      ).rejects.toThrow(/A2A RPC error.*Method not found/);
    });

    it("handles connection refused / DNS failures", async () => {
      const resolver = vi.fn().mockResolvedValue({
        local: false,
        endpoint: "http://nonexistent-host.invalid:3000/flock"
      });

      const clientWithResolver = createA2AClient({
        resolve: resolver,
        logger: makeLogger(),
      });

      // Mock fetch to throw network error
      mockFetch.mockRejectedValue(new Error("fetch failed"));

      await expect(
        clientWithResolver.sendMessage("remote-agent", "Hello")
      ).rejects.toThrow("fetch failed");
    });

    it("handles malformed response body (invalid JSON)", async () => {
      const resolver = vi.fn().mockResolvedValue({
        local: false,
        endpoint: "http://remote-agent.example.com:3000/flock"
      });

      const clientWithResolver = createA2AClient({
        resolve: resolver,
        logger: makeLogger(),
      });

      // Mock fetch to return invalid JSON
      mockFetch.mockResolvedValue({
        status: 200,
        json: vi.fn().mockRejectedValue(new Error("Unexpected token in JSON")),
      });

      await expect(
        clientWithResolver.sendMessage("remote-agent", "Hello")
      ).rejects.toThrow("Unexpected token in JSON");
    });

    it("handles response missing result field", async () => {
      const resolver = vi.fn().mockResolvedValue({
        local: false,
        endpoint: "http://remote-agent.example.com:3000/flock"
      });

      const clientWithResolver = createA2AClient({
        resolve: resolver,
        logger: makeLogger(),
      });

      // Mock fetch to return valid JSON but missing result
      mockFetch.mockResolvedValue({
        status: 200,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: "test-id"
          // Missing result field
        }),
      });

      await expect(
        clientWithResolver.sendMessage("remote-agent", "Hello")
      ).rejects.toThrow("A2A response missing result");
    });

    it("handles unexpected response shape", async () => {
      const resolver = vi.fn().mockResolvedValue({
        local: false,
        endpoint: "http://remote-agent.example.com:3000/flock"
      });

      const clientWithResolver = createA2AClient({
        resolve: resolver,
        logger: makeLogger(),
      });

      // Mock fetch to return valid JSON but unexpected shape
      mockFetch.mockResolvedValue({
        status: 200,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          result: {
            // Neither Task nor Message shape
            weird: "response",
            unexpected: true
          },
          id: "test-id"
        }),
      });

      await expect(
        clientWithResolver.sendMessage("remote-agent", "Hello")
      ).rejects.toThrow(/Unexpected A2A response shape/);
    });

    it("handles custom timeout configuration", async () => {
      const resolver = vi.fn().mockResolvedValue({
        local: false,
        endpoint: "http://remote-agent.example.com:3000/flock"
      });

      const clientWithShortTimeout = createA2AClient({
        resolve: resolver,
        logger: makeLogger(),
        defaultTimeoutMs: 50, // Very short timeout
      });

      // Mock fetch to simulate timeout by checking AbortSignal
      mockFetch.mockImplementation((url, options) => {
        return new Promise((_, reject) => {
          // Check if signal is already aborted
          if (options?.signal?.aborted) {
            reject(new Error("The operation was aborted"));
            return;
          }
          
          // Listen for abort events
          options?.signal?.addEventListener('abort', () => {
            reject(new Error("The operation was aborted"));
          });
          
          // Don't resolve - let the timeout handle it
        });
      });

      const startTime = Date.now();
      await expect(
        clientWithShortTimeout.sendMessage("remote-agent", "Hello")
      ).rejects.toThrow(/aborted/);
      const duration = Date.now() - startTime;

      // Should timeout quickly, not wait for default timeout
      expect(duration).toBeLessThan(1000);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });
  });
});
