/**
 * Gateway Session Send
 *
 * Routes messages to OpenClaw agent sessions via the gateway's
 * OpenAI-compatible HTTP endpoint (/v1/chat/completions).
 *
 * This delegates all LLM handling (auth, model selection, system prompts)
 * to the gateway. The agent must be registered in OpenClaw's agents.list.
 *
 * Supports two modes:
 * - **Synchronous** (default): waits for the agent response and returns it.
 * - **Fire-and-forget**: sends the message without waiting for a response.
 *   Used by the work loop scheduler where we only need to kick the agent.
 *
 * Flow:
 *   sessionSend(agentId, message, sessionKey) → HTTP POST to gateway
 *   → gateway resolves agent session → LLM call → response (or fire-and-forget)
 */

import type { PluginLogger } from "../types.js";

/**
 * Send a message to an OpenClaw agent session and optionally wait for
 * the response.
 *
 * @param agentId   - Target agent identifier (must be in agents.list)
 * @param message   - User message text
 * @param sessionKey - Optional session key for per-channel routing
 * @returns The agent's response text, or null if fire-and-forget / empty
 */
export type SessionSendFn = (
  agentId: string,
  message: string,
  sessionKey?: string,
) => Promise<string | null>;

export interface GatewaySessionSendOptions {
  /** Gateway HTTP port. */
  port: number;
  /** Gateway auth token. */
  token: string;
  /** Logger instance. */
  logger: PluginLogger;
  /** Response timeout in ms. Default: 600000 (10 min). */
  timeoutMs?: number;
  /** Fire-and-forget mode: send without waiting for the agent response. */
  fireAndForget?: boolean;
}

/**
 * Create a SessionSendFn that routes messages through the OpenClaw gateway.
 *
 * Uses the gateway's OpenAI-compatible /v1/chat/completions endpoint with
 * X-OpenClaw-Agent-Id header to target specific agents. When a sessionKey
 * is provided, X-OpenClaw-Session-Key routes to a per-channel/DM session.
 */
export function createGatewaySessionSend(opts: GatewaySessionSendOptions): SessionSendFn {
  const { port, token, logger, timeoutMs = 600_000, fireAndForget = false } = opts;
  const baseUrl = `http://127.0.0.1:${port}`;

  return async (agentId: string, message: string, sessionKey?: string): Promise<string | null> => {
    const target = sessionKey ? `"${agentId}" [${sessionKey}]` : `"${agentId}"`;
    logger.info(`[flock:gateway-send] Sending to ${target}: ${message.slice(0, 100)}...`);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "X-OpenClaw-Agent-Id": agentId,
    };
    if (sessionKey) {
      headers["X-OpenClaw-Session-Key"] = sessionKey;
    }

    const body = JSON.stringify({
      model: `openclaw/${agentId}`,
      messages: [{ role: "user", content: message }],
      stream: false,
    });

    if (fireAndForget) {
      // Fire-and-forget: send the request but don't wait for the full response.
      // We still check for HTTP errors (connection refused, auth failure, etc.)
      // but don't wait for the LLM to finish processing.
      try {
        const controller = new AbortController();
        // Short timeout: just enough to confirm the request was accepted
        const timer = setTimeout(() => controller.abort(), 10_000);

        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          const errorBody = await res.text().catch(() => "");
          throw new Error(`Gateway HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
        }

        // Don't wait for body — the agent is now running
        logger.info(`[flock:gateway-send] Fire-and-forget accepted for ${target}`);
        return null;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          // Timeout on the acceptance check — the request may still be processing.
          // This is OK for fire-and-forget; the gateway likely accepted it.
          logger.info(`[flock:gateway-send] Fire-and-forget timeout for ${target} (likely accepted)`);
          return null;
        }
        throw err;
      }
    }

    // Synchronous mode: wait for the full response
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        throw new Error(`Gateway HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
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
