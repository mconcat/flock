/**
 * Gateway Session Send
 *
 * Implements SessionSendFn by routing messages through the OpenClaw gateway's
 * OpenAI-compatible HTTP endpoint (/v1/chat/completions).
 *
 * This delegates all LLM handling (auth, model selection, system prompts)
 * to the gateway. The agent must be registered in OpenClaw's agents.list.
 *
 * Flow:
 *   Flock A2A message → FlockExecutor → sessionSend() → HTTP POST to gateway
 *   → gateway resolves agent session → LLM call → response
 */

import type { SessionSendFn } from "./executor.js";
import type { PluginLogger } from "../types.js";

export interface GatewaySessionSendOptions {
  /** Gateway HTTP port. */
  port: number;
  /** Gateway auth token. */
  token: string;
  /** Logger instance. */
  logger: PluginLogger;
  /** Response timeout in ms. Default: 600000 (10 min). Set high to let agents
   *  work continuously via tool calls without losing turns to timeouts. */
  timeoutMs?: number;
}

/**
 * Create a SessionSendFn that routes messages through the OpenClaw gateway.
 *
 * Uses the gateway's OpenAI-compatible /v1/chat/completions endpoint with
 * X-OpenClaw-Agent-Id header to target specific agents. When a sessionKey
 * is provided, X-OpenClaw-Session-Key routes to a per-channel/DM session.
 */
export function createGatewaySessionSend(opts: GatewaySessionSendOptions): SessionSendFn {
  const { port, token, logger, timeoutMs = 600_000 } = opts;
  const baseUrl = `http://127.0.0.1:${port}`;

  return async (agentId: string, message: string, sessionKey?: string): Promise<string | null> => {
    const target = sessionKey ? `"${agentId}" [${sessionKey}]` : `"${agentId}"`;
    logger.info(`[flock:gateway-send] Sending to ${target}: ${message.slice(0, 100)}...`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // System prompts are managed by OpenClaw via workspace files (AGENTS.md,
    // SOUL.md, etc.). We only send the user message here — the gateway
    // resolves the agent's session and applies its native prompt stack.
    const messages: Array<{ role: string; content: string }> = [];
    messages.push({ role: "user", content: message });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "X-OpenClaw-Agent-Id": agentId,
    };
    if (sessionKey) {
      headers["X-OpenClaw-Session-Key"] = sessionKey;
    }

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: `openclaw/${agentId}`,
          messages,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Gateway HTTP ${res.status}: ${body.slice(0, 300)}`);
      }

      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = data.choices?.[0]?.message?.content ?? null;

      if (content) {
        logger.info(`[flock:gateway-send] Agent "${agentId}" responded: ${content.slice(0, 100)}...`);
      } else {
        logger.warn(`[flock:gateway-send] Agent "${agentId}" returned empty response`);
      }

      return content;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Gateway send to "${agentId}" timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}
