import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDirectSend } from "../../src/transport/direct-send.js";
import { SessionManager, type AgentSessionConfig } from "../../src/session/manager.js";
import type { PluginLogger } from "../../src/types.js";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeConfig(): AgentSessionConfig {
  return {
    model: "anthropic/claude-sonnet-4-20250514",
    systemPrompt: "You are a test agent.",
    tools: [],
  };
}

describe("createDirectSend", () => {
  let sessionManager: SessionManager;
  let logger: PluginLogger;

  beforeEach(() => {
    logger = makeLogger();
    sessionManager = new SessionManager(logger);
  });

  it("returns a SessionSendFn", () => {
    const send = createDirectSend({
      sessionManager,
      resolveAgentConfig: makeConfig,
      logger,
    });
    expect(typeof send).toBe("function");
  });

  it("calls sessionManager.send with correct agentId and message", async () => {
    const mockResult = { text: "Hello from agent!", events: [] };
    const sendSpy = vi.spyOn(sessionManager, "send").mockResolvedValue(mockResult);

    const send = createDirectSend({
      sessionManager,
      resolveAgentConfig: makeConfig,
      logger,
    });

    const result = await send("dev-code", "Do something");
    expect(result).toBe("Hello from agent!");
    expect(sendSpy).toHaveBeenCalledWith("dev-code", "Do something", expect.any(Object));
  });

  it("returns null for empty response", async () => {
    vi.spyOn(sessionManager, "send").mockResolvedValue({ text: null, events: [] });

    const send = createDirectSend({
      sessionManager,
      resolveAgentConfig: makeConfig,
      logger,
    });

    const result = await send("dev-code", "hi");
    expect(result).toBeNull();
  });

  it("uses resolveAgentConfig for each call", async () => {
    vi.spyOn(sessionManager, "send").mockResolvedValue({ text: "ok", events: [] });

    const configResolver = vi.fn().mockReturnValue(makeConfig());
    const send = createDirectSend({
      sessionManager,
      resolveAgentConfig: configResolver,
      logger,
    });

    await send("agent-1", "msg1");
    await send("agent-2", "msg2");

    expect(configResolver).toHaveBeenCalledWith("agent-1");
    expect(configResolver).toHaveBeenCalledWith("agent-2");
  });

  it("propagates errors from sessionManager.send", async () => {
    vi.spyOn(sessionManager, "send").mockRejectedValue(new Error("LLM error"));

    const send = createDirectSend({
      sessionManager,
      resolveAgentConfig: makeConfig,
      logger,
    });

    await expect(send("dev-code", "hi")).rejects.toThrow("LLM error");
  });

  it("logs send and response", async () => {
    vi.spyOn(sessionManager, "send").mockResolvedValue({ text: "response", events: [] });

    const send = createDirectSend({
      sessionManager,
      resolveAgentConfig: makeConfig,
      logger,
    });

    await send("dev-code", "test message");

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[flock:direct-send] sending to "dev-code"'),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[flock:direct-send] "dev-code" responded'),
    );
  });
});
