/**
 * Flock System Failure Handler
 *
 * Handles system-level transport failures only:
 * - Agent unreachable (process down, network error)
 * - Timeout (no response within deadline)
 * - Max retries exceeded
 * - Internal errors
 *
 * Business-level failures (rejected, partial, etc.) are NOT handled here.
 * Those are communicated back to the sender agent who decides what to do.
 */

/** Kinds of system-level failures the transport can encounter. */
export type SystemFailureKind =
  | "timeout"
  | "agent-unavailable"
  | "internal-error"
  | "max-retries";

/** Context passed to the failure handler describing what went wrong. */
export interface SystemFailureContext {
  kind: SystemFailureKind;
  targetAgentId: string;
  errorDetail?: string;
  attemptCount: number;
  maxRetries?: number; // default 2
}

/** Result of handling a system failure — used by the transport layer. */
export interface SystemFailureResult {
  shouldRetry: boolean;
  /** If not retrying, the error message to send back to the caller agent. */
  callerNotification?: string;
  /** Audit level for logging. */
  auditLevel: "GREEN" | "YELLOW" | "RED";
  /** Brief description for audit log. */
  auditDetail: string;
}

const DEFAULT_MAX_RETRIES = 2;

/**
 * Handle a system-level transport failure.
 *
 * This function decides whether to retry and, if not, produces a
 * structured notification to send back to the calling agent.
 * It does NOT decide business-level strategy (alternate agents, etc.) —
 * that's the sender agent's responsibility.
 */
export function handleSystemFailure(
  ctx: SystemFailureContext,
): SystemFailureResult {
  const maxRetries = ctx.maxRetries ?? DEFAULT_MAX_RETRIES;

  switch (ctx.kind) {
    case "timeout":
      return handleTimeout(ctx, maxRetries);
    case "agent-unavailable":
      return handleAgentUnavailable(ctx);
    case "internal-error":
      return handleInternalError(ctx);
    case "max-retries":
      return handleMaxRetries(ctx);
  }
}

function handleTimeout(
  ctx: SystemFailureContext,
  maxRetries: number,
): SystemFailureResult {
  // First timeout → retry (transient). Subsequent → give up.
  if (ctx.attemptCount < maxRetries) {
    return {
      shouldRetry: true,
      auditLevel: "YELLOW",
      auditDetail: `Timeout reaching ${ctx.targetAgentId} (attempt ${ctx.attemptCount}/${maxRetries}), retrying`,
    };
  }

  return {
    shouldRetry: false,
    callerNotification:
      `[System] Message to ${ctx.targetAgentId} timed out after ${ctx.attemptCount} attempts. ` +
      `The agent may be overloaded or unresponsive. ` +
      `Use flock_discover to find an alternative agent if needed.`,
    auditLevel: "YELLOW",
    auditDetail: `Timeout reaching ${ctx.targetAgentId} after ${ctx.attemptCount} attempts — gave up`,
  };
}

function handleAgentUnavailable(
  ctx: SystemFailureContext,
): SystemFailureResult {
  const detail = ctx.errorDetail ? ` (${ctx.errorDetail})` : "";
  return {
    shouldRetry: false,
    callerNotification:
      `[System] Agent ${ctx.targetAgentId} is unavailable${detail}. ` +
      `The agent may be offline or unreachable. ` +
      `Use flock_discover to find an alternative agent if needed.`,
    auditLevel: "RED",
    auditDetail: `Agent ${ctx.targetAgentId} unavailable${detail}`,
  };
}

function handleInternalError(ctx: SystemFailureContext): SystemFailureResult {
  const detail = ctx.errorDetail ? `: ${ctx.errorDetail}` : "";
  return {
    shouldRetry: false,
    callerNotification:
      `[System] Internal error while sending message to ${ctx.targetAgentId}${detail}. ` +
      `This is a system issue, not a problem with your request. ` +
      `The error has been logged for investigation.`,
    auditLevel: "RED",
    auditDetail: `Internal error sending to ${ctx.targetAgentId}${detail}`,
  };
}

function handleMaxRetries(ctx: SystemFailureContext): SystemFailureResult {
  return {
    shouldRetry: false,
    callerNotification:
      `[System] Maximum retries (${ctx.attemptCount}) exceeded for ${ctx.targetAgentId}. ` +
      `The target agent is unresponsive. ` +
      `Use flock_discover to find an alternative agent if needed.`,
    auditLevel: "RED",
    auditDetail: `Max retries exceeded for ${ctx.targetAgentId} (${ctx.attemptCount} attempts)`,
  };
}
