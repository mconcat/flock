/**
 * Direct LLM Send — standalone replacement for gateway-send.ts.
 *
 * Instead of routing through OpenClaw's gateway HTTP API, this sends
 * messages directly via pi-ai using the SessionManager.
 *
 * gateway-send.ts (OpenClaw plugin mode):
 *   Flock → HTTP POST /v1/chat/completions → OpenClaw gateway → LLM
 *
 * direct-send.ts (standalone mode):
 *   Flock → SessionManager → pi-ai → LLM
 */

import type { SessionSendFn } from "./executor.js";
import type { SessionManager, AgentSessionConfig } from "../session/manager.js";
import type { PluginLogger } from "../types.js";

export interface DirectSendOptions {
  /** Session manager instance. */
  sessionManager: SessionManager;
  /** Resolves agent config (model, system prompt, tools) for a given agent ID. */
  resolveAgentConfig: (agentId: string) => AgentSessionConfig;
  /** Logger instance. */
  logger: PluginLogger;
}

/**
 * Create a SessionSendFn that calls the LLM directly via pi-ai.
 *
 * Drop-in replacement for createGatewaySessionSend() — same interface,
 * different backend. The executor and scheduler don't need to change.
 */
export function createDirectSend(opts: DirectSendOptions): SessionSendFn {
  const { sessionManager, resolveAgentConfig, logger } = opts;

  return async (agentId: string, message: string, _sessionKey?: string): Promise<string | null> => {
    logger.info(`[flock:direct-send] sending to "${agentId}": ${message.slice(0, 100)}...`);

    const config = resolveAgentConfig(agentId);
    const { text } = await sessionManager.send(agentId, message, config);

    if (text) {
      logger.info(`[flock:direct-send] "${agentId}" responded: ${text.slice(0, 100)}...`);
    } else {
      logger.warn(`[flock:direct-send] "${agentId}" returned empty response`);
    }

    return text;
  };
}
