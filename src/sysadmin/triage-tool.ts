/**
 * Sysadmin Triage Tool
 *
 * Registers `triage_decision` as a tool that the sysadmin agent
 * calls to submit structured triage classifications. The tool captures
 * the decision in a shared store keyed by request ID, which the executor
 * reads after the agent responds.
 *
 * Flow:
 *   1. Executor generates requestId, includes it in the triage prompt
 *   2. Executor sends prompt via normal sessionSend (gateway)
 *   3. Agent LLM sees triage_decision tool, calls it with level/reasoning/request_id
 *   4. Tool execute() captures structured data in triageCaptures map
 *   5. Agent generates text response, gateway returns it
 *   6. Executor calls popTriageCapture(requestId) → gets structured TriageToolCall
 *
 * No text parsing. No gateway bypass. Deterministic structured output.
 */

import type { ToolDefinition, ToolResultOC } from "../types.js";
import { toOCResult } from "../types.js";
import type { TriageResult } from "../transport/types.js";

// --- Types ---

export interface TriageToolCall {
  level: "GREEN" | "YELLOW" | "RED";
  reasoning: string;
  action_plan: string;
  risk_factors: string[];
}

// --- Capture Store ---

const triageCaptures = new Map<string, TriageToolCall>();

/**
 * Pop (read + delete) a triage capture by request ID.
 * Returns null if no capture exists for this ID.
 */
export function popTriageCapture(requestId: string): TriageToolCall | null {
  const result = triageCaptures.get(requestId) ?? null;
  triageCaptures.delete(requestId);
  return result;
}

/** Visible for testing only. */
export function _getCaptureStoreSize(): number {
  return triageCaptures.size;
}

// --- Tool ---

const VALID_LEVELS = new Set(["GREEN", "YELLOW", "RED"]);

/**
 * Create the triage_decision tool definition.
 *
 * OpenClaw execute signature: (toolCallId, params, signal?, onUpdate?)
 * Returns: { content: [{ type: "text", text }] }
 */
export function createTriageDecisionTool(): ToolDefinition {
  return {
    name: "triage_decision",
    description:
      "Submit your triage classification for an agent request. " +
      "Call this when you classify a request as GREEN, YELLOW, or RED. " +
      "Do NOT call for WHITE (no triage needed). " +
      "Include the request-id from the request metadata.",
    parameters: {
      type: "object",
      required: ["request_id", "level", "reasoning", "action_plan"],
      properties: {
        request_id: {
          type: "string",
          description: "The request ID from the triage prompt header.",
        },
        level: {
          type: "string",
          enum: ["GREEN", "YELLOW", "RED"],
          description:
            "GREEN: safe, auto-execute. " +
            "YELLOW: execute with review/logging. " +
            "RED: block, requires human approval.",
        },
        reasoning: {
          type: "string",
          description:
            "Why you chose this classification. " +
            "Include risk assessment, blast radius, and reversibility analysis.",
        },
        action_plan: {
          type: "string",
          description:
            "GREEN/YELLOW: what would be executed. " +
            "RED: what the human should evaluate and why it's dangerous.",
        },
        risk_factors: {
          type: "array",
          items: { type: "string" },
          description: "Specific risk factors identified in this request.",
        },
      },
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<ToolResultOC> {
      const requestId = typeof params.request_id === "string"
        ? params.request_id.trim()
        : "";

      if (!requestId) {
        return toOCResult({ ok: false, error: "request_id is required" });
      }

      const call = parseTriageParams(params);
      if (!call) {
        return toOCResult({
          ok: false,
          error: "Invalid triage parameters. Required: level (GREEN/YELLOW/RED), reasoning, action_plan.",
        });
      }

      // Store in capture map
      triageCaptures.set(requestId, call);

      // Auto-expire after 5 minutes to prevent leaks
      setTimeout(() => triageCaptures.delete(requestId), 5 * 60_000);

      const icon = { GREEN: "🟢", YELLOW: "🟡", RED: "🔴" }[call.level];
      return toOCResult({
        ok: true,
        output: `${icon} Triage classification recorded: ${call.level}`,
        data: { level: call.level, requestId },
      });
    },
  };
}

// --- Helpers ---

function parseTriageParams(params: Record<string, unknown>): TriageToolCall | null {
  const level = typeof params.level === "string" ? params.level.toUpperCase() : "";
  if (!VALID_LEVELS.has(level)) return null;

  return {
    level: level as "GREEN" | "YELLOW" | "RED",
    reasoning: typeof params.reasoning === "string" ? params.reasoning : "",
    action_plan: typeof params.action_plan === "string" ? params.action_plan : "",
    risk_factors: Array.isArray(params.risk_factors)
      ? params.risk_factors.filter((r): r is string => typeof r === "string")
      : [],
  };
}

/**
 * Convert a TriageToolCall to a TriageResult for the A2A artifact.
 */
export function toTriageResult(call: TriageToolCall): TriageResult {
  return {
    level: call.level,
    action: call.action_plan,
    reasoning: call.reasoning,
    riskFactors: call.risk_factors.length > 0 ? call.risk_factors : undefined,
    requiresHumanApproval: call.level === "RED",
  };
}
