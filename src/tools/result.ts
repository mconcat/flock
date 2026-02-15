/**
 * Tool result helpers — pi-agent-core compatible.
 *
 * Replaces the legacy toOCResult() which produced ToolResultOC.
 * AgentToolResult<T> from pi-agent-core is the new standard.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

/** Convenience input for building an AgentToolResult. */
export interface FlockToolInput {
  ok: boolean;
  output?: string;
  error?: string;
  data?: Record<string, unknown>;
}

/**
 * Build an AgentToolResult from a simple ok/error shape.
 *
 * Drop-in replacement for the legacy `toOCResult()`.
 * Produces the same wire format that pi-agent-core expects.
 */
export function toResult(input: FlockToolInput): AgentToolResult<Record<string, unknown>> {
  const text = input.ok
    ? input.output ?? JSON.stringify(input.data ?? { ok: true }, null, 2)
    : input.error ?? "Unknown error";

  return {
    content: [{ type: "text" as const, text }],
    details: { ok: input.ok, ...(input.data ?? {}) },
  };
}
