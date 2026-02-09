import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGatewaySessionSend } from "../../src/transport/gateway-send.js";
import type { PluginLogger } from "../../src/types.js";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const GATEWAY_PORT = 9999;
const TOKEN = "test-token";

describe("gateway-send", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(responseContent: string) {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: responseContent } }],
      }),
    });
    globalThis.fetch = mock;
    return mock;
  }

  it("sends request to gateway with correct headers", async () => {
    const fetchMock = mockFetch("Hello!");
    const send = createGatewaySessionSend({
      port: GATEWAY_PORT,
      token: TOKEN,
      logger: makeLogger(),
    });

    await send("dev-code", "Do something");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`);
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(opts.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(opts.headers["X-OpenClaw-Agent-Id"]).toBe("dev-code");
  });

  it("omits X-OpenClaw-Session-Key when no sessionKey", async () => {
    const fetchMock = mockFetch("ok");
    const send = createGatewaySessionSend({
      port: GATEWAY_PORT,
      token: TOKEN,
      logger: makeLogger(),
    });

    await send("dev-code", "hello");

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["X-OpenClaw-Session-Key"]).toBeUndefined();
  });

  it("includes X-OpenClaw-Session-Key when sessionKey is provided", async () => {
    const fetchMock = mockFetch("ok");
    const send = createGatewaySessionSend({
      port: GATEWAY_PORT,
      token: TOKEN,
      logger: makeLogger(),
    });

    const sessionKey = "agent:dev-code:flock:channel:project-alpha";
    await send("dev-code", "hello", sessionKey);

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["X-OpenClaw-Session-Key"]).toBe(sessionKey);
  });

  it("sends correct body with model and messages", async () => {
    const fetchMock = mockFetch("response");
    const send = createGatewaySessionSend({
      port: GATEWAY_PORT,
      token: TOKEN,
      logger: makeLogger(),
    });

    await send("qa-agent", "Run tests");

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("openclaw/qa-agent");
    expect(body.messages).toEqual([{ role: "user", content: "Run tests" }]);
    expect(body.stream).toBe(false);
  });

  it("returns response content", async () => {
    mockFetch("Agent says hello!");
    const send = createGatewaySessionSend({
      port: GATEWAY_PORT,
      token: TOKEN,
      logger: makeLogger(),
    });

    const result = await send("dev-code", "hi");
    expect(result).toBe("Agent says hello!");
  });

  it("returns null for empty response", async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: {} }] }),
    });
    globalThis.fetch = mock;

    const send = createGatewaySessionSend({
      port: GATEWAY_PORT,
      token: TOKEN,
      logger: makeLogger(),
    });

    const result = await send("dev-code", "hi");
    expect(result).toBeNull();
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const send = createGatewaySessionSend({
      port: GATEWAY_PORT,
      token: TOKEN,
      logger: makeLogger(),
    });

    await expect(send("dev-code", "hi")).rejects.toThrow("Gateway HTTP 500");
  });

  it("DM session key is passed through correctly", async () => {
    const fetchMock = mockFetch("ok");
    const send = createGatewaySessionSend({
      port: GATEWAY_PORT,
      token: TOKEN,
      logger: makeLogger(),
    });

    const dmSessionKey = "agent:dev-code:flock:dm:pm";
    await send("dev-code", "hello from pm", dmSessionKey);

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["X-OpenClaw-Session-Key"]).toBe(dmSessionKey);
  });
});
