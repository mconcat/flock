import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager, type AgentSessionConfig } from "../../src/session/manager.js";
import type { PluginLogger } from "../../src/types.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeConfig(overrides?: Partial<AgentSessionConfig>): AgentSessionConfig {
  return {
    model: "anthropic/claude-sonnet-4-20250514",
    systemPrompt: "You are a test agent.",
    tools: [],
    ...overrides,
  };
}

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager(makeLogger());
  });

  describe("getOrCreate", () => {
    it("creates a new agent session", () => {
      const config = makeConfig();
      const agent = manager.getOrCreate("agent-1", config);
      expect(agent).toBeDefined();
      expect(agent.state.systemPrompt).toBe("You are a test agent.");
      expect(manager.has("agent-1")).toBe(true);
    });

    it("returns same agent instance on subsequent calls", () => {
      const config = makeConfig();
      const agent1 = manager.getOrCreate("agent-1", config);
      const agent2 = manager.getOrCreate("agent-1", config);
      expect(agent1).toBe(agent2);
    });

    it("updates system prompt on config change", () => {
      const config1 = makeConfig({ systemPrompt: "Prompt v1" });
      const agent = manager.getOrCreate("agent-1", config1);
      expect(agent.state.systemPrompt).toBe("Prompt v1");

      const config2 = makeConfig({ systemPrompt: "Prompt v2" });
      manager.getOrCreate("agent-1", config2);
      expect(agent.state.systemPrompt).toBe("Prompt v2");
    });

    it("updates thinking level on config change", () => {
      const config1 = makeConfig({ thinkingLevel: "off" });
      const agent = manager.getOrCreate("agent-1", config1);
      expect(agent.state.thinkingLevel).toBe("off");

      const config2 = makeConfig({ thinkingLevel: "high" });
      manager.getOrCreate("agent-1", config2);
      expect(agent.state.thinkingLevel).toBe("high");
    });

    it("throws on invalid model format", () => {
      const config = makeConfig({ model: "no-slash" });
      expect(() => manager.getOrCreate("agent-1", config)).toThrow(
        'Invalid model format "no-slash"',
      );
    });
  });

  describe("has / get / getConfig", () => {
    it("returns false/undefined for unknown agents", () => {
      expect(manager.has("nope")).toBe(false);
      expect(manager.get("nope")).toBeUndefined();
      expect(manager.getConfig("nope")).toBeUndefined();
    });

    it("returns agent and config after creation", () => {
      const config = makeConfig();
      manager.getOrCreate("agent-1", config);
      expect(manager.has("agent-1")).toBe(true);
      expect(manager.get("agent-1")).toBeDefined();
      expect(manager.getConfig("agent-1")?.model).toBe("anthropic/claude-sonnet-4-20250514");
    });
  });

  describe("clearHistory", () => {
    it("clears messages for an existing agent", () => {
      const config = makeConfig();
      const agent = manager.getOrCreate("agent-1", config);
      // Manually add a message to verify clearing
      agent.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
      expect(agent.state.messages.length).toBe(1);

      manager.clearHistory("agent-1");
      expect(agent.state.messages.length).toBe(0);
    });

    it("does nothing for unknown agent", () => {
      // Should not throw
      manager.clearHistory("unknown");
    });
  });

  describe("destroy", () => {
    it("removes the agent session", () => {
      const config = makeConfig();
      manager.getOrCreate("agent-1", config);
      expect(manager.has("agent-1")).toBe(true);

      manager.destroy("agent-1");
      expect(manager.has("agent-1")).toBe(false);
      expect(manager.get("agent-1")).toBeUndefined();
    });

    it("does nothing for unknown agent", () => {
      manager.destroy("unknown"); // Should not throw
    });
  });

  describe("destroyAll", () => {
    it("removes all sessions", () => {
      const config = makeConfig();
      manager.getOrCreate("agent-1", config);
      manager.getOrCreate("agent-2", config);
      expect(manager.listAgents()).toHaveLength(2);

      manager.destroyAll();
      expect(manager.listAgents()).toHaveLength(0);
    });
  });

  describe("listAgents", () => {
    it("returns empty array initially", () => {
      expect(manager.listAgents()).toEqual([]);
    });

    it("returns all active agent IDs", () => {
      const config = makeConfig();
      manager.getOrCreate("alpha", config);
      manager.getOrCreate("beta", config);
      expect(manager.listAgents().sort()).toEqual(["alpha", "beta"]);
    });
  });
});
