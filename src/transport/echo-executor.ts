/**
 * Echo Agent Executor
 *
 * A test executor that echoes back the received message.
 * Used for E2E testing of the A2A transport layer without
 * requiring an LLM backend.
 *
 * Behavior:
 *   - Receives a message via A2A
 *   - Echoes back with agent ID prefix
 *   - Completes the task with an artifact containing the echo
 */

import type {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
} from "@a2a-js/sdk/server";
import type { PluginLogger } from "../types.js";
import {
  extractText,
  task,
  taskStatus,
  artifact,
  textPart,
} from "./a2a-helpers.js";

export interface EchoExecutorParams {
  /** Agent ID for labeling responses. */
  agentId: string;
  /** Logger instance. */
  logger: PluginLogger;
}

/**
 * Create an AgentExecutor that echoes messages back.
 * Response format: "[agentId] echo: <original message>"
 */
export function createEchoExecutor(params: EchoExecutorParams): AgentExecutor {
  const { agentId, logger } = params;

  return {
    async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      const { userMessage, taskId, contextId } = ctx;
      const text = extractText(userMessage);

      logger.info(`[flock:echo:${agentId}] Received: ${text.slice(0, 100)}`);

      const echoText = `[${agentId}] echo: ${text}`;

      eventBus.publish(
        task(taskId, contextId, taskStatus("completed", echoText), [
          artifact("echo-response", [textPart(echoText)], `Echo from ${agentId}`),
        ]),
      );
      eventBus.finished();
    },

    async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
      logger.info(`[flock:echo:${agentId}] Task ${taskId} canceled`);
      eventBus.publish(task(taskId, taskId, taskStatus("canceled")));
      eventBus.finished();
    },
  };
}
