/**
 * Migration A2A Handlers — JSON-RPC method handlers for migration protocol.
 *
 * Registers migration/* methods on the A2A server.
 * Each handler validates input, updates the ticket store, and logs audit entries.
 *
 * Methods:
 *   migration/request   — Source→Target: request migration approval
 *   migration/approve   — Target→Source: approve with reservation
 *   migration/reject    — Target→Source: reject with reason
 *   migration/transfer  — Source→Target: send payload
 *   migration/verify    — Target→Source: verification result
 *   migration/complete  — Target→Source: rehydration complete
 *   migration/status    — Either→Either: query migration state
 *   migration/abort     — Either→Either: cancel migration
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PluginLogger, AuditEntry } from "../types.js";
import type { AuditLog } from "../audit/log.js";
import type {
  MigrationTicket,
  MigrationAuditAction,
  MigrationStatusInfo,
  MigrationPayload,
} from "./types.js";
import { isMigrationReason, isTerminalPhase, VALID_PHASE_TRANSITIONS } from "./types.js";
import type { MigrationTicketStore } from "./ticket-store.js";
import { verifySnapshot } from "./snapshot.js";
import { rehydrate } from "./rehydrate.js";

// Forward declarations to avoid circular dependency
export interface MigrationEngine {
  complete(migrationId: string, newHomeId: string, newEndpoint: string): Promise<any>;
}

export interface MigrationOrchestratorRef {
  run(agentId: string, targetNodeId: string, reason: string): Promise<{
    success: boolean;
    migrationId: string;
    finalPhase: string;
    error?: string;
    warnings?: string[];
  }>;
}

// --- Handler Context ---

/** Dependencies required by migration handlers. */
export interface MigrationHandlerContext {
  /** Ticket store for migration state. */
  ticketStore: MigrationTicketStore;
  /** Audit log for recording migration events. */
  auditLog: AuditLog;
  /** Logger. */
  logger: PluginLogger;
  /** This node's ID. */
  nodeId: string;
  /** Known peer node IDs. If set, only these nodes may initiate migrations to us. */
  knownNodeIds?: Set<string>;
  /** Optional capacity check callback. If provided and returns not-ok, request is rejected. */
  checkCapacity?: () => { ok: boolean; reason?: string };
  /** Optional migration engine for calling complete with hooks. */
  migrationEngine?: MigrationEngine;
  /** Optional migration orchestrator for triggering full lifecycle via API. */
  migrationOrchestrator?: MigrationOrchestratorRef;
  /** Temporary directory for staging migration archives. */
  tmpDir?: string;
  /** Resolve home directory path for an agent on this node. */
  resolveHomePath?: (agentId: string) => string;
  /** Resolve work directory path for an agent on this node. */
  resolveWorkPath?: (agentId: string) => string;
}

// --- JSON-RPC Request/Response Types ---

/** Generic JSON-RPC request shape. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  id: string;
  params: Record<string, unknown>;
}

/** Generic JSON-RPC success response. */
export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string;
  result: Record<string, unknown>;
}

/** Generic JSON-RPC error response. */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string;
  error: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
}

/** Union type for JSON-RPC responses. */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// --- Handler Map Type ---

/** A migration handler function. */
export type MigrationHandler = (
  params: Record<string, unknown>,
  ctx: MigrationHandlerContext,
) => Promise<JsonRpcResponse>;

/** Map of method name to handler function. */
export type MigrationHandlerMap = Map<string, MigrationHandler>;

// --- Handler Registration ---

/**
 * Create the full set of migration JSON-RPC handlers.
 *
 * @param ctx - Handler context with dependencies
 * @returns Map of method names to handler functions
 */
export function createMigrationHandlers(ctx: MigrationHandlerContext): MigrationHandlerMap {
  const handlers: MigrationHandlerMap = new Map();

  handlers.set("migration/request", (params) => handleRequest(params, ctx));
  handlers.set("migration/approve", (params) => handleApprove(params, ctx));
  handlers.set("migration/reject", (params) => handleReject(params, ctx));
  handlers.set("migration/transfer", (params) => handleTransfer(params, ctx));
  handlers.set("migration/verify", (params) => handleVerify(params, ctx));
  handlers.set("migration/complete", (params) => handleComplete(params, ctx));
  handlers.set("migration/status", (params) => handleStatus(params, ctx));
  handlers.set("migration/abort", (params) => handleAbort(params, ctx));
  handlers.set("migration/transfer-and-verify", (params) => handleTransferAndVerify(params, ctx));
  handlers.set("migration/rehydrate", (params) => handleRehydrate(params, ctx));
  handlers.set("migration/run", (params) => handleRun(params, ctx));

  return handlers;
}

// --- Individual Handlers ---

/**
 * Handle migration/request — Source→Target.
 * Validates the request, checks known-peer and capacity, then creates a ticket.
 */
async function handleRequest(
  params: Record<string, unknown>,
  ctx: MigrationHandlerContext,
): Promise<JsonRpcResponse> {
  // Validate required fields
  const migrationId = expectString(params, "migrationId");
  const agentId = expectString(params, "agentId");
  const sourceNodeId = expectString(params, "sourceNodeId");
  const targetNodeId = expectString(params, "targetNodeId");
  const reasonRaw = expectString(params, "reason");
  const sourceEndpoint = expectString(params, "sourceEndpoint");

  if (!migrationId || !agentId || !sourceNodeId || !targetNodeId || !reasonRaw || !sourceEndpoint) {
    return makeError(params, -32602, "Missing required fields: migrationId, agentId, sourceNodeId, targetNodeId, reason, sourceEndpoint");
  }

  if (!isMigrationReason(reasonRaw)) {
    return makeError(params, -32602, `Invalid migration reason: ${reasonRaw}`);
  }

  // Verify this request is for our node
  if (targetNodeId !== ctx.nodeId) {
    return makeError(params, -32602, `This node is ${ctx.nodeId}, not ${targetNodeId}`);
  }

  // Known-peer check: reject requests from unknown nodes
  if (ctx.knownNodeIds && !ctx.knownNodeIds.has(sourceNodeId)) {
    ctx.logger.warn(`[flock:migration] Rejected request from unknown node: ${sourceNodeId}`);
    return makeError(params, -32001, `Unknown source node: ${sourceNodeId}`);
  }

  // Capacity check
  if (ctx.checkCapacity) {
    const cap = ctx.checkCapacity();
    if (!cap.ok) {
      return makeSuccess(params, {
        approved: false,
        reason: cap.reason ?? "CAPACITY_EXCEEDED",
        detail: `Capacity check failed: ${cap.reason ?? "no capacity"}`,
      });
    }
  }

  // Check for duplicate agent
  const existingTickets = ctx.ticketStore.getByAgent(agentId);
  const activeTicket = existingTickets.find((t) => !isTerminalPhase(t.phase));
  if (activeTicket) {
    return makeError(params, -32001, `Agent ${agentId} already has an active migration: ${activeTicket.migrationId}`);
  }

  // Create ticket
  const ticket = ctx.ticketStore.create({
    migrationId,
    agentId,
    source: {
      nodeId: sourceNodeId,
      homeId: `${agentId}@${sourceNodeId}`,
      endpoint: sourceEndpoint,
    },
    target: {
      nodeId: targetNodeId,
      homeId: `${agentId}@${targetNodeId}`,
      endpoint: "", // Will be filled on approve
    },
    reason: reasonRaw,
  });

  logMigrationAudit(ctx, ticket, "initiated", `Migration requested from ${sourceNodeId} to ${targetNodeId}`);

  return makeSuccess(params, {
    migrationId: ticket.migrationId,
    phase: ticket.phase,
    message: "Migration request received",
  });
}

/**
 * Handle migration/approve — Target→Source.
 * Updates ticket phase to AUTHORIZED.
 */
async function handleApprove(
  params: Record<string, unknown>,
  ctx: MigrationHandlerContext,
): Promise<JsonRpcResponse> {
  const migrationId = expectString(params, "migrationId");

  if (!migrationId) {
    return makeError(params, -32602, "Missing required field: migrationId");
  }

  const ticket = ctx.ticketStore.get(migrationId);
  if (!ticket) {
    return makeError(params, -32001, `Migration not found: ${migrationId}`);
  }

  const updated = ctx.ticketStore.updatePhase(migrationId, "AUTHORIZED");

  logMigrationAudit(ctx, updated, "authorized", "Migration approved");

  return makeSuccess(params, {
    migrationId: updated.migrationId,
    phase: updated.phase,
  });
}

/**
 * Handle migration/reject — Target→Source.
 * Moves ticket to ABORTED state.
 */
async function handleReject(
  params: Record<string, unknown>,
  ctx: MigrationHandlerContext,
): Promise<JsonRpcResponse> {
  const migrationId = expectString(params, "migrationId");
  const reason = expectString(params, "reason");

  if (!migrationId) {
    return makeError(params, -32602, "Missing required field: migrationId");
  }

  const ticket = ctx.ticketStore.get(migrationId);
  if (!ticket) {
    return makeError(params, -32001, `Migration not found: ${migrationId}`);
  }

  const updated = ctx.ticketStore.updatePhase(migrationId, "ABORTED");
  logMigrationAudit(ctx, updated, "rejected", `Migration rejected: ${reason ?? "no reason given"}`);

  return makeSuccess(params, {
    migrationId: updated.migrationId,
    phase: updated.phase,
    reason: reason ?? "no reason given",
  });
}

/**
 * Handle migration/transfer — Source→Target.
 * Receives payload and acknowledges receipt.
 */
async function handleTransfer(
  params: Record<string, unknown>,
  ctx: MigrationHandlerContext,
): Promise<JsonRpcResponse> {
  const migrationId = expectString(params, "migrationId");

  if (!migrationId) {
    return makeError(params, -32602, "Missing required field: migrationId");
  }

  const ticket = ctx.ticketStore.get(migrationId);
  if (!ticket) {
    return makeError(params, -32001, `Migration not found: ${migrationId}`);
  }

  logMigrationAudit(ctx, ticket, "transfer_started", "Transfer payload received");

  return makeSuccess(params, {
    migrationId: ticket.migrationId,
    phase: ticket.phase,
    message: "Transfer received",
  });
}

/**
 * Handle migration/verify — Target→Source.
 * Processes verification result from target.
 */
async function handleVerify(
  params: Record<string, unknown>,
  ctx: MigrationHandlerContext,
): Promise<JsonRpcResponse> {
  const migrationId = expectString(params, "migrationId");
  const verified = params.verified;

  if (!migrationId || typeof verified !== "boolean") {
    return makeError(params, -32602, "Missing required fields: migrationId, verified");
  }

  const ticket = ctx.ticketStore.get(migrationId);
  if (!ticket) {
    return makeError(params, -32001, `Migration not found: ${migrationId}`);
  }

  if (verified) {
    // Ownership transfers to target at verification ACK — atomic update
    const updated = ctx.ticketStore.updatePhase(migrationId, "REHYDRATING", { ownershipHolder: "target" });
    logMigrationAudit(ctx, updated, "verification_success", "Verification passed, ownership transferred to target");

    return makeSuccess(params, {
      migrationId: updated.migrationId,
      phase: updated.phase,
      ownershipHolder: updated.ownershipHolder,
    });
  } else {
    const failureReason = expectString(params, "failureReason");
    const updated = ctx.ticketStore.updatePhase(migrationId, "ROLLING_BACK");
    logMigrationAudit(ctx, updated, "verification_failed", `Verification failed: ${failureReason ?? "unknown"}`);

    return makeSuccess(params, {
      migrationId: updated.migrationId,
      phase: updated.phase,
      message: `Verification failed: ${failureReason ?? "unknown"}`,
    });
  }
}

/**
 * Handle migration/complete — Target→Source.
 * Finalizes the migration.
 */
async function handleComplete(
  params: Record<string, unknown>,
  ctx: MigrationHandlerContext,
): Promise<JsonRpcResponse> {
  const migrationId = expectString(params, "migrationId");
  const newHomeId = expectString(params, "newHomeId");
  const newEndpoint = expectString(params, "newEndpoint");

  if (!migrationId) {
    return makeError(params, -32602, "Missing required field: migrationId");
  }

  const ticket = ctx.ticketStore.get(migrationId);
  if (!ticket) {
    return makeError(params, -32001, `Migration not found: ${migrationId}`);
  }

  // Use migration engine if available (triggers hooks for assignment store updates)
  if (ctx.migrationEngine) {
    try {
      const updated = await ctx.migrationEngine.complete(
        migrationId,
        newHomeId ?? `${ticket.agentId}@${ticket.target.nodeId}`,
        newEndpoint ?? ticket.target.endpoint,
      );

      return makeSuccess(params, {
        migrationId: updated.migrationId,
        phase: updated.phase,
        completedAt: updated.updatedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return makeError(params, -32603, `Migration completion failed: ${msg}`);
    }
  }

  // No migration engine — cannot complete without hooks
  return makeError(params, -32603, "Migration engine not available. Cannot complete migration without engine hooks.");
}

/**
 * Handle migration/status — Either→Either.
 * Returns current migration state.
 */
async function handleStatus(
  params: Record<string, unknown>,
  ctx: MigrationHandlerContext,
): Promise<JsonRpcResponse> {
  const migrationId = expectString(params, "migrationId");

  if (!migrationId) {
    return makeError(params, -32602, "Missing required field: migrationId");
  }

  const ticket = ctx.ticketStore.get(migrationId);
  if (!ticket) {
    return makeError(params, -32001, `Migration not found: ${migrationId}`);
  }

  const status: MigrationStatusInfo = {
    migrationId: ticket.migrationId,
    phase: ticket.phase,
    ownershipHolder: ticket.ownershipHolder,
    sourceState: "MIGRATING", // Simplified — real impl would query HomeManager
    targetState: null,
    startedAt: ticket.createdAt,
    lastUpdatedAt: ticket.updatedAt,
  };

  return makeSuccess(params, {
    ...status,
  });
}

/**
 * Handle migration/abort — Either→Either.
 * Cancels a migration in progress.
 */
async function handleAbort(
  params: Record<string, unknown>,
  ctx: MigrationHandlerContext,
): Promise<JsonRpcResponse> {
  const migrationId = expectString(params, "migrationId");
  const reason = expectString(params, "reason");
  const initiator = expectString(params, "initiator");

  if (!migrationId) {
    return makeError(params, -32602, "Missing required field: migrationId");
  }

  const ticket = ctx.ticketStore.get(migrationId);
  if (!ticket) {
    return makeError(params, -32001, `Migration not found: ${migrationId}`);
  }

  // Check if migration can still be aborted (not in terminal state)
  if (isTerminalPhase(ticket.phase)) {
    return makeError(params, -32001, `Migration ${migrationId} is already in terminal state: ${ticket.phase}`);
  }

  // If in ROLLING_BACK, transition to ABORTED
  // Otherwise, go to ROLLING_BACK first (if allowed), then ABORTED
  let updated: MigrationTicket;
  if (ticket.phase === "ROLLING_BACK") {
    updated = ctx.ticketStore.updatePhase(migrationId, "ABORTED");
  } else {
    const canRollBack = VALID_PHASE_TRANSITIONS[ticket.phase]?.includes("ROLLING_BACK") ?? false;
    if (canRollBack) {
      ctx.ticketStore.updatePhase(migrationId, "ROLLING_BACK");
    }
    updated = ctx.ticketStore.updatePhase(migrationId, "ABORTED");
  }

  logMigrationAudit(
    ctx,
    updated,
    "aborted",
    `Migration aborted by ${initiator ?? "unknown"}: ${reason ?? "no reason"}`,
  );

  return makeSuccess(params, {
    migrationId: updated.migrationId,
    phase: updated.phase,
    message: "Migration aborted",
  });
}

/**
 * Handle migration/transfer-and-verify — Source→Target.
 * Receives a base64-encoded archive, writes it to tmpDir, and verifies integrity.
 */
async function handleTransferAndVerify(
  params: Record<string, unknown>,
  ctx: MigrationHandlerContext,
): Promise<JsonRpcResponse> {
  const migrationId = expectString(params, "migrationId");
  const archiveBase64 = expectString(params, "archiveBase64");
  const checksum = expectString(params, "checksum");

  if (!migrationId || !archiveBase64 || !checksum) {
    return makeError(params, -32602, "Missing required fields: migrationId, archiveBase64, checksum");
  }

  if (!ctx.tmpDir) {
    return makeError(params, -32603, "tmpDir not configured on this node");
  }

  try {
    // Decode base64 archive to Buffer
    const archiveBuffer = Buffer.from(archiveBase64, "base64");

    // Write to tmpDir
    const archiveDir = join(ctx.tmpDir, migrationId);
    await mkdir(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, `${migrationId}.tar.gz`);
    await writeFile(archivePath, archiveBuffer);

    // Verify snapshot integrity
    const verification = await verifySnapshot(archivePath, checksum);

    return makeSuccess(params, {
      verified: verification.verified,
      failureReason: verification.failureReason ?? null,
      computedChecksum: verification.computedChecksum ?? null,
      verifiedAt: verification.verifiedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeError(params, -32603, `Transfer-and-verify failed: ${msg}`);
  }
}

/**
 * Handle migration/rehydrate — Source→Target.
 * Receives migration payload, reconstructs the agent on this node.
 */
async function handleRehydrate(
  params: Record<string, unknown>,
  ctx: MigrationHandlerContext,
): Promise<JsonRpcResponse> {
  const migrationId = expectString(params, "migrationId");
  const agentId = expectString(params, "agentId");
  const archiveBase64 = expectString(params, "archiveBase64");
  const checksum = expectString(params, "checksum");

  if (!migrationId || !agentId || !archiveBase64 || !checksum) {
    return makeError(params, -32602, "Missing required fields: migrationId, agentId, archiveBase64, checksum");
  }

  if (!ctx.resolveHomePath || !ctx.resolveWorkPath) {
    return makeError(params, -32603, "resolveHomePath/resolveWorkPath not configured on this node");
  }

  try {
    // Decode base64 archive to Buffer
    const archiveBuffer = Buffer.from(archiveBase64, "base64");

    // Build MigrationPayload from params
    const sizeBytes = typeof params.sizeBytes === "number" ? params.sizeBytes : archiveBuffer.length;
    const agentIdentity = (params.agentIdentity as MigrationPayload["agentIdentity"]) ?? null;
    const workState = (params.workState as MigrationPayload["workState"]) ?? { projects: [], capturedAt: Date.now() };

    const payload: MigrationPayload = {
      portable: {
        archive: archiveBuffer,
        checksum,
        sizeBytes,
      },
      agentIdentity,
      workState,
    };

    // Resolve paths on this node
    const homePath = ctx.resolveHomePath(agentId);
    const workPath = ctx.resolveWorkPath(agentId);

    // Run rehydration
    const result = await rehydrate(payload, homePath, ctx.logger, workPath);

    return makeSuccess(params, {
      success: result.success,
      homePath: result.homePath,
      error: result.error ?? null,
      warnings: result.warnings,
      completedAt: result.completedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeError(params, -32603, `Rehydrate failed: ${msg}`);
  }
}

/**
 * Handle migration/run — Trigger a complete migration via the orchestrator.
 * This is an API-level migration trigger (alternative to flock_migrate tool).
 * Accepts agentId, targetNodeId, reason and runs the full lifecycle.
 */
async function handleRun(
  params: Record<string, unknown>,
  ctx: MigrationHandlerContext,
): Promise<JsonRpcResponse> {
  const agentId = expectString(params, "agentId");
  const targetNodeId = expectString(params, "targetNodeId");
  const reason = expectString(params, "reason") ?? "orchestrator_rebalance";

  if (!agentId) {
    return makeError(params, -32602, "Missing required field: agentId");
  }
  if (!targetNodeId) {
    return makeError(params, -32602, "Missing required field: targetNodeId");
  }

  if (!ctx.migrationOrchestrator) {
    return makeError(params, -32603, "Migration orchestrator not available on this node");
  }

  if (!isMigrationReason(reason)) {
    return makeError(params, -32602, `Invalid migration reason: ${reason}`);
  }

  try {
    ctx.logger.info(`[flock:migration:run] Starting migration: ${agentId} → ${targetNodeId} (${reason})`);
    const result = await ctx.migrationOrchestrator.run(agentId, targetNodeId, reason);

    if (result.success) {
      return makeSuccess(params, {
        success: true,
        migrationId: result.migrationId,
        finalPhase: result.finalPhase,
        warnings: result.warnings ?? [],
      });
    } else {
      return makeSuccess(params, {
        success: false,
        migrationId: result.migrationId,
        finalPhase: result.finalPhase,
        error: result.error ?? "Unknown error",
        warnings: result.warnings ?? [],
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`[flock:migration:run] Error: ${msg}`);
    return makeError(params, -32603, `Migration run failed: ${msg}`);
  }
}

// --- Helper Functions ---

/** Extract a string value from params, or return undefined. */
function expectString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

/** Create a JSON-RPC success response. */
function makeSuccess(
  params: Record<string, unknown>,
  result: Record<string, unknown>,
): JsonRpcSuccessResponse {
  return {
    jsonrpc: "2.0",
    id: typeof params._id === "string" ? params._id : "",
    result,
  };
}

/** Create a JSON-RPC error response. */
function makeError(
  params: Record<string, unknown>,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id: typeof params._id === "string" ? params._id : "",
    error: { code, message, ...(data ? { data } : {}) },
  };
}

/** Log a migration audit entry. */
function logMigrationAudit(
  ctx: MigrationHandlerContext,
  ticket: MigrationTicket,
  action: MigrationAuditAction,
  detail: string,
): void {
  const now = Date.now();
  const entry: AuditEntry = {
    id: `migration-${action}-${ticket.migrationId}-${now}`,
    timestamp: now,
    homeId: ticket.source.homeId,
    agentId: ticket.agentId,
    action: `migration.${action}`,
    level: "YELLOW",
    detail,
  };

  ctx.auditLog.append(entry);
  ctx.logger.info(`[flock:migration] ${ticket.migrationId}: ${action} — ${detail}`);
}
