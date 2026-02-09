/**
 * Flock Agent Executor
 *
 * Implements the A2A SDK's AgentExecutor interface, bridging
 * A2A task requests to Clawdbot's session-based agent communication.
 *
 * Flow:
 *   A2A request → executor.execute() → sessions_send to target agent
 *   → agent processes request → response captured → Task completed
 */

import type {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
} from "@a2a-js/sdk/server";
import type { Artifact } from "@a2a-js/sdk";
import type { PluginLogger, AuditLevel } from "../types.js";
import type { AuditLog } from "../audit/log.js";
import type { TaskStore } from "../db/interface.js";
import type { FlockTaskMetadata, FlockCardMetadata, TriageResult } from "./types.js";
import { popTriageCapture, toTriageResult } from "../sysadmin/triage-tool.js";
import {
  extractText,
  extractData,
  task,
  taskStatus,
  artifact,
  textPart,
  dataPart,
} from "./a2a-helpers.js";

/**
 * Function signature for sending a message to a Clawdbot agent session.
 * Injected as dependency — actual implementation uses sessions_send.
 */
export type SessionSendFn = (
  agentId: string,
  message: string,
) => Promise<string | null>;

export interface FlockExecutorParams {
  /** Flock metadata for the agent this executor handles. */
  flockMeta: FlockCardMetadata;
  /** Function to send messages to Clawdbot sessions. */
  sessionSend: SessionSendFn;
  /** Audit log for automatic task event recording. */
  audit?: AuditLog;
  /** Task store for recording task lifecycle. */
  taskStore?: TaskStore;
  /** Logger instance. */
  logger: PluginLogger;
  /** Timeout for waiting for agent response (ms). Default: 600000 (10 min). */
  responseTimeoutMs?: number;
}

export function createFlockExecutor(params: FlockExecutorParams): AgentExecutor {
  const {
    flockMeta,
    sessionSend,
    audit,
    taskStore,
    logger,
    responseTimeoutMs = 600_000,
  } = params;

  const isSysadmin = flockMeta.role === "sysadmin";

  return {
    async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      const { userMessage, taskId, contextId } = ctx;

      const textContent = extractText(userMessage);
      const data = extractData(userMessage);
      const taskMeta = toFlockTaskMeta(data);
      const isSysadminRequest = isSysadmin && taskMeta?.flockType === "sysadmin-request";

      // Generate a unique request ID for triage capture
      const requestId = isSysadminRequest
        ? `triage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        : undefined;

      const agentId = flockMeta.homeId.split("@")[0];
      const fromHome = taskMeta?.fromHome ?? "unknown";
      const startTime = Date.now();

      logger.info(
        `[flock:executor] Task ${taskId} for ${flockMeta.homeId}: ${textContent.slice(0, 100)}...`,
      );

      // Record task in TaskStore (state: submitted → working)
      if (taskStore) {
        taskStore.insert({
          taskId,
          contextId,
          fromAgentId: fromHome,
          toAgentId: agentId,
          state: "submitted",
          messageType: taskMeta?.flockType ?? "a2a-message",
          summary: textContent.slice(0, 200),
          payload: JSON.stringify({ text: textContent, data }),
          responseText: null,
          responsePayload: null,
          createdAt: startTime,
          updatedAt: startTime,
          completedAt: null,
        });
        taskStore.update(taskId, { state: "working", updatedAt: Date.now() });
      }

      // No triage wrapper — sysadmin classifies on its own (White/Green/Yellow/Red).
      // For agent requests (sysadmin-request), include metadata context only.
      const prompt = isSysadminRequest
        ? buildRequestContext(textContent, taskMeta, requestId)
        : textContent;

      // Working status
      eventBus.publish(task(taskId, contextId, taskStatus("working", "Processing request...")));

      try {
        const response = await Promise.race([
          sessionSend(agentId, prompt),
          timeout(responseTimeoutMs),
        ]);

        if (response === null || response === undefined) {
          throw new Error("Agent did not respond (timeout or no session)");
        }

        const artifacts: Artifact[] = [];
        let statusMessage: string;
        let auditLevel: AuditLevel = "GREEN";

        if (isSysadminRequest && requestId) {
          // Check for structured triage capture from triage_decision tool call
          const triageCall = popTriageCapture(requestId);

          if (triageCall) {
            const result = toTriageResult(triageCall);
            auditLevel = result.level;
            artifacts.push(
              artifact("triage-result", [
                dataPart(result),
                textPart(formatReceipt(result)),
              ], "Sysadmin triage decision and receipt"),
            );
            statusMessage = formatReceipt(result);
          } else {
            // Agent did not call triage_decision — classified as White (no triage needed).
            // This is valid: sysadmin decided the request doesn't warrant triage.
            logger.info(
              `[flock:executor] Sysadmin "${agentId}" classified request ${requestId} as White (no triage tool call)`,
            );
            artifacts.push(artifact("response", [textPart(response)]));
            statusMessage = response;
            auditLevel = "GREEN"; // White maps to GREEN for audit purposes
          }
        } else {
          // Standard message flow (workers + non-triage sysadmin messages)
          artifacts.push(artifact("response", [textPart(response)]));
          statusMessage = response;
        }

        const completedAt = Date.now();

        // Update TaskStore with completion
        if (taskStore) {
          taskStore.update(taskId, {
            state: "completed",
            responseText: statusMessage,
            updatedAt: completedAt,
            completedAt,
          });
        }

        // Audit: record completed task
        audit?.append({
          id: taskId,
          timestamp: completedAt,
          agentId: fromHome,
          homeId: flockMeta.homeId,
          action: taskMeta?.flockType ?? "a2a-message",
          level: auditLevel,
          detail: textContent.slice(0, 500),
          result: "completed",
          duration: completedAt - startTime,
        });

        eventBus.publish(task(taskId, contextId, taskStatus("completed", statusMessage), artifacts));
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[flock:executor] Task ${taskId} failed: ${errorMsg}`);

        const failedAt = Date.now();

        // Update TaskStore with failure
        if (taskStore) {
          taskStore.update(taskId, {
            state: "failed",
            responseText: errorMsg,
            updatedAt: failedAt,
            completedAt: failedAt,
          });
        }

        // Audit: record failed task
        audit?.append({
          id: taskId,
          timestamp: failedAt,
          agentId: fromHome,
          homeId: flockMeta.homeId,
          action: taskMeta?.flockType ?? "a2a-message",
          level: "RED",
          detail: `FAILED: ${textContent.slice(0, 300)} — ${errorMsg}`,
          result: "failed",
          duration: failedAt - startTime,
        });

        eventBus.publish(task(taskId, contextId, taskStatus("failed", `Error: ${errorMsg}`)));
      }

      eventBus.finished();
    },

    async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
      logger.info(`[flock:executor] Task ${taskId} canceled`);

      const canceledAt = Date.now();

      // Update TaskStore with cancellation
      if (taskStore) {
        const existing = taskStore.get(taskId);
        if (existing) {
          taskStore.update(taskId, {
            state: "canceled",
            updatedAt: canceledAt,
            completedAt: canceledAt,
          });
        }
      }

      // Audit: record canceled task
      audit?.append({
        id: taskId,
        timestamp: canceledAt,
        agentId: "system",
        homeId: flockMeta.homeId,
        action: "task-canceled",
        level: "YELLOW",
        detail: `Task ${taskId} canceled`,
        result: "canceled",
      });

      eventBus.publish(task(taskId, taskId, taskStatus("canceled")));
      eventBus.finished();
    },
  };
}

// --- Helpers ---

const VALID_FLOCK_TYPES = new Set(["sysadmin-request", "worker-task", "review", "system-op"]);
const VALID_URGENCIES = new Set(["low", "normal", "high"]);
const VALID_TRIAGE_LEVELS = new Set(["GREEN", "YELLOW", "RED"]);

/** Safely extract and validate FlockTaskMetadata from DataPart data, or null. */
function toFlockTaskMeta(data: Record<string, unknown> | null): FlockTaskMetadata | null {
  if (!data || typeof data.flockType !== "string") return null;
  if (!VALID_FLOCK_TYPES.has(data.flockType)) return null;

  return {
    flockType: data.flockType as FlockTaskMetadata["flockType"],
    urgency: typeof data.urgency === "string" && VALID_URGENCIES.has(data.urgency)
      ? data.urgency as FlockTaskMetadata["urgency"]
      : undefined,
    project: typeof data.project === "string" ? data.project : undefined,
    fromHome: typeof data.fromHome === "string" ? data.fromHome : undefined,
    expectedLevel: typeof data.expectedLevel === "string" && VALID_TRIAGE_LEVELS.has(data.expectedLevel)
      ? data.expectedLevel as FlockTaskMetadata["expectedLevel"]
      : undefined,
  };
}

/**
 * Build a lightweight metadata context for agent requests.
 * No triage instructions — the sysadmin's L2 prompt handles classification.
 * Just provides who's asking, urgency, and a request-id for tool correlation.
 */
function buildRequestContext(
  request: string,
  meta: FlockTaskMetadata | null,
  requestId?: string,
): string {
  const tags = [
    meta?.fromHome && `from: ${meta.fromHome}`,
    meta?.urgency && `urgency: ${meta.urgency}`,
    meta?.project && `project: ${meta.project}`,
    requestId && `request-id: ${requestId}`,
  ].filter(Boolean);

  if (tags.length === 0) return request;

  return `[${tags.join(" | ")}]\n\n${request}`;
}

function formatReceipt(result: TriageResult): string {
  const icon = { GREEN: "🟢", YELLOW: "🟡", RED: "🔴" }[result.level];
  const lines = [
    `## Triage Receipt ${icon} ${result.level}`,
    "",
    `**Action:** ${result.action}`,
  ];

  if (result.requiresHumanApproval) {
    lines.push("", "⚠️ **Human approval required** — this request has been escalated.");
  }

  if (result.riskFactors && result.riskFactors.length > 0) {
    lines.push("", "### Risk Factors", ...result.riskFactors.map(r => `- ${r}`));
  }

  lines.push("", "### Reasoning", result.reasoning);

  return lines.join("\n");
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
  );
}
