/**
 * Migration Engine — orchestrator for the full migration lifecycle.
 *
 * Manages the state machine: REQUESTED → AUTHORIZED → FREEZING → FROZEN →
 * SNAPSHOTTING → TRANSFERRING → VERIFYING → REHYDRATING → FINALIZING → COMPLETED.
 *
 * Integrates with HomeManager for home state transitions, the ticket store for
 * migration state, snapshot/rehydrate modules for data operations, and the
 * audit log for recording all events.
 *
 * Factory function pattern following createHomeManager, createAuditLog.
 */

import { randomUUID } from "node:crypto";
import type { PluginLogger, AuditEntry } from "../types.js";
import type { HomeManager } from "../homes/manager.js";
import type { AuditLog } from "../audit/log.js";
import type {
  MigrationTicket,
  MigrationPhase,
  MigrationReason,
  MigrationError,
  VerificationResult,
  PhaseTimeouts,
  MigrationAuditAction,
  MigrationMode,
} from "./types.js";
import { MigrationErrorCode, DEFAULT_PHASE_TIMEOUTS, VALID_PHASE_TRANSITIONS, isTerminalPhase } from "./types.js";
import type { NodeRegistry } from "../nodes/registry.js";
import { onMigrationComplete } from "./registry-hooks.js";
import type { MigrationTicketStore } from "./ticket-store.js";
import type { AssignmentStore } from "../nodes/assignment.js";
import { onMigrationCompleteAssignment } from "./assignment-hooks.js";
import { createSnapshot, verifySnapshot } from "./snapshot.js";
import { rehydrate } from "./rehydrate.js";
import { withRetry, getRetryPolicy } from "./retry.js";

// --- Engine Interface ---

/** Migration engine public interface. */
export interface MigrationEngine {
  /**
   * Initiate a migration for an agent to a target node.
   *
   * @param agentId - Agent to migrate
   * @param targetNodeId - Destination node
   * @param reason - Reason for migration
   * @returns The created migration ticket
   */
  initiate(
    agentId: string,
    targetNodeId: string,
    reason: MigrationReason,
  ): MigrationTicket;

  /**
   * Advance a migration to the next phase.
   * Handles the phase-specific logic and transitions.
   *
   * @param migrationId - Migration to advance
   * @returns Updated ticket
   */
  advancePhase(migrationId: string): Promise<MigrationTicket>;

  /**
   * Rollback a migration to a safe state.
   * Performs phase-appropriate cleanup and state restoration.
   *
   * @param migrationId - Migration to roll back
   * @param reason - Reason for rollback
   * @returns Updated ticket
   */
  rollback(migrationId: string, reason: string): MigrationTicket;

  /**
   * Handle an incoming verification result from the target.
   * This is the ownership transfer point when verification succeeds.
   *
   * @param migrationId - Migration ID
   * @param result - Verification result from target
   * @returns Updated ticket
   */
  handleVerification(migrationId: string, result: VerificationResult): MigrationTicket;

  /**
   * Complete a migration (called after rehydrate succeeds on target).
   *
   * @param migrationId - Migration to complete
   * @param newHomeId - New home ID on target
   * @param newEndpoint - New A2A endpoint on target
   * @returns Updated ticket
   */
  complete(migrationId: string, newHomeId: string, newEndpoint: string): Promise<MigrationTicket>;

  /**
   * Get the current status of a migration.
   *
   * @param migrationId - Migration ID
   * @returns Current ticket or null
   */
  getStatus(migrationId: string): MigrationTicket | null;

  /**
   * List all active (non-terminal) migrations.
   *
   * @returns Array of active migration tickets
   */
  listActive(): MigrationTicket[];

  /**
   * Advance a migration phase with automatic retry for retryable errors.
   * Uses the appropriate retry policy from the error catalog.
   * On non-retryable errors, proceeds to rollback.
   *
   * @param migrationId - Migration to advance
   * @returns Updated ticket
   */
  advancePhaseWithRetry(migrationId: string): Promise<MigrationTicket>;
}

// --- Engine Configuration ---

/** Configuration for the migration engine. */
export interface MigrationEngineConfig {
  /** Ticket store for migration state. */
  ticketStore: MigrationTicketStore;
  /** Home manager for home state transitions. */
  homeManager: HomeManager;
  /** Audit log for recording events. */
  auditLog: AuditLog;
  /** Logger. */
  logger: PluginLogger;
  /** This node's ID. */
  nodeId: string;
  /** This node's A2A endpoint. */
  endpoint: string;
  /** Migration mode (p2p or central). */
  mode: MigrationMode;
  /** Temporary directory for snapshots. */
  tmpDir: string;
  /** Phase timeouts (optional, uses defaults). */
  timeouts?: Partial<PhaseTimeouts>;
  /** Optional node registry for post-migration agent routing updates. */
  registry?: NodeRegistry;
  /** Optional assignment store for post-migration assignment updates. */
  assignments?: AssignmentStore;
}

// --- Factory Function ---

/**
 * Create a migration engine instance.
 *
 * @param config - Engine configuration
 * @returns MigrationEngine instance
 */
export function createMigrationEngine(config: MigrationEngineConfig): MigrationEngine {
  const {
    ticketStore,
    homeManager,
    auditLog,
    logger,
    nodeId,
    endpoint,
    mode,
    tmpDir,
    registry,
    assignments,
  } = config;

  const timeouts: PhaseTimeouts = {
    ...DEFAULT_PHASE_TIMEOUTS,
    ...config.timeouts,
  };

  function initiate(
    agentId: string,
    targetNodeId: string,
    reason: MigrationReason,
  ): MigrationTicket {
    // Validate agent exists and is in a migratable state
    const sourceHomeId = `${agentId}@${nodeId}`;
    const home = homeManager.get(sourceHomeId);
    if (!home) {
      throw new MigrationEngineError(
        MigrationErrorCode.FREEZE_INVALID_STATE,
        `No home found for agent ${agentId} on node ${nodeId}`,
      );
    }

    if (home.state !== "ACTIVE" && home.state !== "LEASED") {
      throw new MigrationEngineError(
        MigrationErrorCode.FREEZE_INVALID_STATE,
        `Agent ${agentId} is in state ${home.state}, must be ACTIVE or LEASED to migrate`,
      );
    }

    // Check for existing active migration for this agent
    const existingTickets = ticketStore.getByAgent(agentId);
    const activeMigration = existingTickets.find((t) => !isTerminalPhase(t.phase));
    if (activeMigration) {
      throw new MigrationEngineError(
        MigrationErrorCode.INTERNAL_STATE_INCONSISTENCY,
        `Agent ${agentId} already has an active migration: ${activeMigration.migrationId}`,
      );
    }

    const migrationId = randomUUID();
    const ticket = ticketStore.create({
      migrationId,
      agentId,
      source: {
        nodeId,
        homeId: sourceHomeId,
        endpoint,
      },
      target: {
        nodeId: targetNodeId,
        homeId: `${agentId}@${targetNodeId}`,
        endpoint: "", // Will be populated during authorization
      },
      reason,
    });

    logAudit(ticket, "initiated", `Migration initiated: ${nodeId} → ${targetNodeId} (${reason})`);
    logger.info(`[flock:migration:engine] Initiated migration ${migrationId} for ${agentId} → ${targetNodeId}`);

    return ticket;
  }

  async function advancePhase(migrationId: string): Promise<MigrationTicket> {
    const ticket = ticketStore.get(migrationId);
    if (!ticket) {
      throw new MigrationEngineError(
        MigrationErrorCode.UNKNOWN,
        `Migration not found: ${migrationId}`,
      );
    }

    switch (ticket.phase) {
      case "REQUESTED":
        // Move to AUTHORIZED (after external approval)
        return ticketStore.updatePhase(migrationId, "AUTHORIZED");

      case "AUTHORIZED":
        return advanceToFreezing(ticket);

      case "FREEZING":
        return advanceToFrozen(ticket);

      case "FROZEN":
        return ticketStore.updatePhase(migrationId, "SNAPSHOTTING");

      case "SNAPSHOTTING": {
        // Transition home to MIGRATING before transfer begins
        const snapshotHome = homeManager.get(ticket.source.homeId);
        if (snapshotHome && snapshotHome.state === "FROZEN") {
          homeManager.transition(
            ticket.source.homeId,
            "MIGRATING",
            `Migration ${ticket.migrationId}: starting transfer`,
            "migration-engine",
          );
        }
        return ticketStore.updatePhase(migrationId, "TRANSFERRING");
      }

      case "TRANSFERRING":
        return ticketStore.updatePhase(migrationId, "VERIFYING");

      case "VERIFYING":
        // Verification is handled by handleVerification()
        return ticket;

      case "REHYDRATING":
        return ticketStore.updatePhase(migrationId, "FINALIZING");

      case "FINALIZING":
        return ticketStore.updatePhase(migrationId, "COMPLETED");

      default:
        throw new MigrationEngineError(
          MigrationErrorCode.INTERNAL_STATE_INCONSISTENCY,
          `Cannot advance from terminal phase: ${ticket.phase}`,
        );
    }
  }

  function advanceToFreezing(ticket: MigrationTicket): MigrationTicket {
    const home = homeManager.get(ticket.source.homeId);
    if (!home) {
      throw new MigrationEngineError(
        MigrationErrorCode.FREEZE_INVALID_STATE,
        `Source home not found: ${ticket.source.homeId}`,
      );
    }

    // Transition home to FROZEN
    if (home.state === "ACTIVE" || home.state === "LEASED") {
      homeManager.transition(
        ticket.source.homeId,
        "FROZEN",
        `Migration ${ticket.migrationId}: freezing for transfer`,
        "migration-engine",
      );
    }

    const updated = ticketStore.updatePhase(ticket.migrationId, "FREEZING");
    logAudit(updated, "frozen", `Agent frozen for migration`);
    return updated;
  }

  function advanceToFrozen(ticket: MigrationTicket): MigrationTicket {
    return ticketStore.updatePhase(ticket.migrationId, "FROZEN");
  }

  function rollback(migrationId: string, reason: string): MigrationTicket {
    const ticket = ticketStore.get(migrationId);
    if (!ticket) {
      throw new MigrationEngineError(
        MigrationErrorCode.UNKNOWN,
        `Migration not found: ${migrationId}`,
      );
    }

    // Check if already in terminal state
    if (isTerminalPhase(ticket.phase)) {
      throw new MigrationEngineError(
        MigrationErrorCode.INTERNAL_STATE_INCONSISTENCY,
        `Cannot rollback migration in terminal state: ${ticket.phase}`,
      );
    }

    logger.info(`[flock:migration:engine] Rolling back ${migrationId} from ${ticket.phase}: ${reason}`);

    // Phase-appropriate rollback
    rollbackHomeState(ticket);

    // Transition ticket: use ROLLING_BACK if allowed, otherwise go directly to ABORTED
    const canRollBack = VALID_PHASE_TRANSITIONS[ticket.phase].includes("ROLLING_BACK");
    if (canRollBack) {
      ticketStore.updatePhase(migrationId, "ROLLING_BACK");
    }
    const updated = ticketStore.updatePhase(migrationId, "ABORTED");

    logAudit(updated, "rollback", `Rollback from ${ticket.phase}: ${reason}`);

    return updated;
  }

  function rollbackHomeState(ticket: MigrationTicket): void {
    const home = homeManager.get(ticket.source.homeId);
    if (!home) {
      logger.warn(`[flock:migration:engine] Source home not found during rollback: ${ticket.source.homeId}`);
      return;
    }

    // Rollback source home state based on phase
    switch (ticket.phase) {
      case "FREEZING":
      case "FROZEN":
      case "SNAPSHOTTING":
        // FROZEN → LEASED
        if (home.state === "FROZEN") {
          homeManager.transition(
            ticket.source.homeId,
            "LEASED",
            `Migration ${ticket.migrationId} rolled back: reverting from FROZEN`,
            "migration-engine",
          );
        }
        break;

      case "TRANSFERRING":
      case "VERIFYING":
        // MIGRATING → FROZEN → LEASED
        if (home.state === "MIGRATING") {
          homeManager.transition(
            ticket.source.homeId,
            "FROZEN",
            `Migration ${ticket.migrationId} rolled back: reverting from MIGRATING`,
            "migration-engine",
          );
          homeManager.transition(
            ticket.source.homeId,
            "LEASED",
            `Migration ${ticket.migrationId} rolled back: reverting to LEASED`,
            "migration-engine",
          );
        } else if (home.state === "FROZEN") {
          homeManager.transition(
            ticket.source.homeId,
            "LEASED",
            `Migration ${ticket.migrationId} rolled back: reverting from FROZEN`,
            "migration-engine",
          );
        }
        break;

      case "REHYDRATING":
      case "FINALIZING":
        // After verification, ownership has transferred. Only rollback if source still owns.
        if (ticket.ownershipHolder === "source" && (home.state === "MIGRATING" || home.state === "FROZEN")) {
          if (home.state === "MIGRATING") {
            homeManager.transition(
              ticket.source.homeId,
              "FROZEN",
              `Migration ${ticket.migrationId} rolled back`,
              "migration-engine",
            );
          }
          homeManager.transition(
            ticket.source.homeId,
            "LEASED",
            `Migration ${ticket.migrationId} rolled back`,
            "migration-engine",
          );
        }
        break;

      default:
        // REQUESTED, AUTHORIZED — no home state change needed
        break;
    }
  }

  function handleVerification(migrationId: string, result: VerificationResult): MigrationTicket {
    const ticket = ticketStore.get(migrationId);
    if (!ticket) {
      throw new MigrationEngineError(
        MigrationErrorCode.UNKNOWN,
        `Migration not found: ${migrationId}`,
      );
    }

    if (ticket.phase !== "VERIFYING") {
      throw new MigrationEngineError(
        MigrationErrorCode.INTERNAL_STATE_INCONSISTENCY,
        `Expected phase VERIFYING, got ${ticket.phase}`,
      );
    }

    if (result.verified) {
      // ★ OWNERSHIP TRANSFER POINT ★ — atomic phase + ownership update
      const updated = ticketStore.updatePhase(migrationId, "REHYDRATING", { ownershipHolder: "target" });
      logAudit(updated, "verification_success", "Verification passed — ownership transferred to target");
      logger.info(`[flock:migration:engine] ${migrationId}: Verification ACK — ownership → target`);
      return updated;
    } else {
      // Verification failed — rollback
      const failReason = result.failureReason ?? "unknown";
      logAudit(ticket, "verification_failed", `Verification failed: ${failReason}`);
      return rollback(migrationId, `Verification failed: ${failReason}`);
    }
  }

  async function complete(migrationId: string, newHomeId: string, newEndpoint: string): Promise<MigrationTicket> {
    const ticket = ticketStore.get(migrationId);
    if (!ticket) {
      throw new MigrationEngineError(
        MigrationErrorCode.UNKNOWN,
        `Migration not found: ${migrationId}`,
      );
    }

    if (ticket.phase !== "FINALIZING" && ticket.phase !== "REHYDRATING") {
      throw new MigrationEngineError(
        MigrationErrorCode.INTERNAL_STATE_INCONSISTENCY,
        `Expected phase FINALIZING or REHYDRATING, got ${ticket.phase}`,
      );
    }

    // Advance to FINALIZING if in REHYDRATING
    if (ticket.phase === "REHYDRATING") {
      ticketStore.updatePhase(migrationId, "FINALIZING");
    }

    // Retire source home
    const sourceHome = homeManager.get(ticket.source.homeId);
    if (sourceHome && sourceHome.state !== "RETIRED") {
      // Ensure source is in a state that can transition to RETIRED
      if (sourceHome.state === "MIGRATING") {
        homeManager.transition(
          ticket.source.homeId,
          "FROZEN",
          `Migration ${migrationId}: preparing for retirement`,
          "migration-engine",
        );
      }
      if (sourceHome.state === "FROZEN" || homeManager.get(ticket.source.homeId)?.state === "FROZEN") {
        homeManager.transition(
          ticket.source.homeId,
          "RETIRED",
          `Migration ${migrationId}: agent migrated to ${newHomeId}`,
          "migration-engine",
        );
      }
    }

    const updated = ticketStore.updatePhase(migrationId, "COMPLETED");
    logAudit(updated, "finalized", `Migration complete. New home: ${newHomeId}, endpoint: ${newEndpoint}`);
    logger.info(`[flock:migration:engine] ${migrationId}: Migration completed → ${newHomeId}`);

    // Update node registry if provided
    if (registry) {
      onMigrationComplete(updated, registry);
      logger.info(`[flock:migration:engine] ${migrationId}: Registry updated for agent ${updated.agentId}`);
    }

    // Update assignment store if provided
    if (assignments) {
      await onMigrationCompleteAssignment(updated, assignments, logger);
    }

    return updated;
  }

  function getStatus(migrationId: string): MigrationTicket | null {
    return ticketStore.get(migrationId);
  }

  function listActive(): MigrationTicket[] {
    return ticketStore.list().filter((t) => !isTerminalPhase(t.phase));
  }

  function logAudit(ticket: MigrationTicket, action: MigrationAuditAction, detail: string): void {
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

    auditLog.append(entry);
  }

  async function advancePhaseWithRetry(migrationId: string): Promise<MigrationTicket> {
    try {
      return await advancePhase(migrationId);
    } catch (err) {
      if (err instanceof MigrationEngineError) {
        const retryPolicy = getRetryPolicy(err.code);
        if (retryPolicy) {
          logger.info(
            `[flock:migration:engine] Error ${MigrationErrorCode[err.code]} is retryable ` +
            `(${retryPolicy.maxAttempts} attempts, ${retryPolicy.baseDelayMs}ms base delay)`,
          );
          return withRetry(
            () => advancePhase(migrationId),
            retryPolicy,
            logger,
          );
        }
      }

      // Non-retryable error — rollback
      const ticket = ticketStore.get(migrationId);
      if (ticket && !isTerminalPhase(ticket.phase)) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[flock:migration:engine] Non-retryable error during ${ticket.phase}, rolling back: ${errorMsg}`,
        );
        return rollback(migrationId, `Non-retryable error: ${errorMsg}`);
      }

      throw err;
    }
  }

  return {
    initiate,
    advancePhase,
    advancePhaseWithRetry,
    rollback,
    handleVerification,
    complete,
    getStatus,
    listActive,
  };
}

// --- Error Class ---

/** Typed error for migration engine operations. */
export class MigrationEngineError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string) {
    super(message);
    this.name = "MigrationEngineError";
    this.code = code;
  }
}
