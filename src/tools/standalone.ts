/**
 * Standalone tool builder — produces AgentTool[] for pi-agent-core Agent.
 *
 * In plugin mode, tools are registered via api.registerTool() with context
 * injection (agentId comes from OpenClaw session).
 *
 * In standalone mode, we build the tool set directly per agent, injecting
 * the agentId at construction time instead of via OpenClaw's session context.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@mariozechner/pi-ai";
import type { ToolDefinition, ToolResultOC } from "../types.js";
import type { ToolDeps } from "./index.js";
import { toAgentTool } from "../tool-adapter.js";

/**
 * Wrap a ToolDefinition so that _callerAgentId is always injected.
 * Standalone equivalent of wrapToolWithAgentId in tools/index.ts.
 */
function injectAgentId(tool: ToolDefinition, agentId: string): ToolDefinition {
  return {
    ...tool,
    async execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (data: unknown) => void): Promise<ToolResultOC> {
      params._callerAgentId = agentId;
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

/**
 * Build Flock tools for standalone agent execution.
 *
 * Returns AgentTool[] ready for Agent.setTools().
 * Tools are bound to the specified agentId (no OpenClaw context injection needed).
 *
 * This imports tool creator functions dynamically to avoid circular deps
 * when called before full initialization.
 */
export function buildStandaloneTools(
  deps: ToolDeps,
  agentId: string,
  toolCreators: Array<(deps: ToolDeps) => ToolDefinition | ToolDefinition[]>,
): AgentTool<TSchema, Record<string, unknown>>[] {
  const tools: ToolDefinition[] = [];

  for (const creator of toolCreators) {
    const result = creator(deps);
    if (Array.isArray(result)) {
      tools.push(...result);
    } else {
      tools.push(result);
    }
  }

  return tools
    .map((tool) => injectAgentId(tool, agentId))
    .map(toAgentTool);
}
