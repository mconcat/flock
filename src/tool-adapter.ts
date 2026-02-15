/**
 * Tool adapter: bridges Flock ToolDefinition ↔ pi-agent-core AgentTool.
 *
 * During migration, Flock tools are defined as ToolDefinition (loose types).
 * This adapter converts them to AgentTool for use with pi-agent-core's Agent.
 *
 * Direction:
 *   ToolDefinition → AgentTool  (for standalone mode / Agent.setTools())
 *   AgentTool → ToolDefinition  (not needed — OpenClaw plugin mode uses ToolDefinition directly)
 */

import { Type, type TSchema } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition, ToolResultOC } from "./types.js";

/**
 * Convert a JSON Schema-style parameters object to a TypeBox TObject.
 *
 * Flock tools define parameters as plain JSON Schema objects:
 *   { type: "object", properties: { agentId: { type: "string", ... } }, required: [...] }
 *
 * pi-agent-core expects TypeBox TSchema. We wrap the raw schema rather than
 * rewriting every tool — TypeBox's Type.Unsafe() preserves the JSON Schema
 * representation for LLM tool calling while satisfying the type system.
 */
function jsonSchemaToTypebox(schema: Record<string, unknown>): TSchema {
  // Type.Unsafe() creates a TypeBox schema from raw JSON Schema.
  // The LLM providers serialize it back to JSON Schema for tool definitions,
  // so the round-trip is lossless.
  return Type.Unsafe<Record<string, unknown>>(schema);
}

/**
 * Convert a Flock ToolDefinition to a pi-agent-core AgentTool.
 *
 * The execute signature is compatible:
 *   Flock:    (toolCallId, params, signal?, onUpdate?) => Promise<ToolResultOC>
 *   AgentTool: (toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult<T>>
 *
 * ToolResultOC = { content: [{ type: "text", text }], details? }
 * AgentToolResult = { content: (TextContent | ImageContent)[], details }
 * These are structurally compatible — both have content arrays with { type: "text", text }.
 */
export function toAgentTool(tool: ToolDefinition): AgentTool<TSchema, Record<string, unknown>> {
  const tbSchema = jsonSchemaToTypebox(tool.parameters);

  return {
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    parameters: tbSchema,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (partialResult: AgentToolResult<Record<string, unknown>>) => void,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      // pi-agent-core passes params as the parsed JSON object from the LLM.
      // Flock tools expect Record<string, unknown> — safe to cast since
      // LLM tool call arguments are always objects.
      const typedParams = (params ?? {}) as Record<string, unknown>;
      const result: ToolResultOC = await tool.execute(
        toolCallId,
        typedParams,
        signal,
        onUpdate as ((data: unknown) => void) | undefined,
      );
      return {
        content: result.content,
        details: result.details ?? {},
      };
    },
  };
}

/**
 * Convert an array of Flock ToolDefinitions to AgentTools.
 */
export function toAgentTools(tools: ToolDefinition[]): AgentTool<TSchema, Record<string, unknown>>[] {
  return tools.map(toAgentTool);
}
