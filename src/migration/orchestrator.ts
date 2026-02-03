/**
 * Migration Orchestrator — drives the full migration lifecycle.
 *
 * Coordinates the migration engine with a pluggable transport layer
 * to execute the complete migration flow:
 *   REQUESTED → AUTHORIZED → FREEZING → FROZEN → SNAPSHOTTING →
 *   TRANSFERRING → VERIFYING → REHYDRATING → COMPLETED
 *
 * The transport abstraction allows the same orchestrator to work in tests
 * (local in-process calls) and production (HTTP/A2A) without code changes.
 *
 * On any error the orchestrator attempts rollback via engine.rollback().
 */

import { readFile } from "node:fs/promises";
import type { PluginLogger } from "../types.js";
import type { MigrationEngine } from "./engine.js";
import type {
  MigrationPhase,
  MigrationReason,
  MigrationPayload,
  AgentIdentityPayload,
  VerificationResult,
  WorkStateManifest,
} from "./types.js";
import { isTerminalPhase } from "./types.js";
import type { RehydrateResult } from "./rehydrate.js";
import { createSnapshot } from "./snapshot.js";

// --- Transport Interface ---

/**
 * Transport abstraction for cross-node migration communication.
 *
 * In tests, implement with local function calls.
 * In production, implement with HTTP/A2A JSON-RPC.
 */
export interface MigrationTransport {
  /** Notify target about incoming migration. Maps to migration/request handler. */
  notifyRequest(params: {
    migrationId: string;
    agentId: string;
    sourceNodeId: string;
    targetNodeId: string;
    reason: string;
    sourceEndpoint: string;
  }): Promise<{ accepted: boolean; error?: string }>;

  /** Transfer archive to target and get verification. Combines transfer + verify steps. */
  transferAndVerify(params: {
    migrationId: string;
    targetNodeId: string;
    archiveBuffer: Buffer;
    checksum: string;
  }): Promise<VerificationResult>;

  /** Rehydrate agent on target node. */
  rehydrate(params: {
    migrationId: string;
    targetNodeId: string;
    payload: MigrationPayload;
    targetHomePath: string;
    targetWorkDir?: string;
  }): Promise<RehydrateResult>;
}

// --- Orchestrator Config ---

/** Configuration for the migration orchestrator. */
export interface MigrationOrchestratorConfig {
  /** Migration engine instance (source-side). */
  engine: MigrationEngine;
  /** Transport for cross-node communication. */
  transport: MigrationTransport;
  /** Source node ID. */
  sourceNodeId: string;
  /** Source node A2A endpoint. */
  sourceEndpoint: string;
  /** Resolve the source home path for an agent. */
  resolveSourceHome: (agentId: string) => string;
  /** Resolve the source work directory for an agent. */
  resolveSourceWork: (agentId: string) => string;
  /** Resolve the target home path for an agent on a given node. */
  resolveTargetHome: (agentId: string, targetNodeId: string) => string;
  /** Resolve the target work directory for an agent on a given node. */
  resolveTargetWork: (agentId: string, targetNodeId: string) => string;
  /** Resolve the A2A endpoint for a target node. */
  resolveTargetEndpoint: (targetNodeId: string) => string;
  /** Temporary directory for snapshot staging. */
  tmpDir: string;
  /** Logger instance. */
  logger: PluginLogger;
  /** Optional: build identity payload for the agent (P2P mode). */
  buildIdentity?: (agentId: string) => AgentIdentityPayload | null;
  /** Optional: transform work state before transfer (e.g., rewrite remote URLs). */
  transformWorkState?: (workState: WorkStateManifest) => WorkStateManifest;
}

// --- Orchestrator Result ---

/** Result of an orchestrated migration. */
export interface OrchestratorResult {
  /** Whether the migration completed successfully. */
  success: boolean;
  /** Migration ID. */
  migrationId: string;
  /** Final phase the migration reached. */
  finalPhase: MigrationPhase;
  /** Error message if migration failed. */
  error?: string;
  /** Non-fatal warnings collected during migration. */
  warnings?: string[];
}

// --- Orchestrator Interface ---

/** Migration orchestrator that drives the full lifecycle with a single call. */
export interface MigrationOrchestrator {
  /**
   * Run a complete migration for an agent to a target node.
   *
   * Drives the engine through all phases, creates snapshot, transfers data,
   * verifies integrity, rehydrates on target, and completes the migration.
   *
   * On any error, automatically rolls back via engine.rollback().
   *
   * @param agentId - Agent to migrate
   * @param targetNodeId - Destination node
   * @param reason - Reason for migration
   * @returns Result with success/failure and final phase
   */
  run(agentId: string, targetNodeId: string, reason: MigrationReason): Promise<OrchestratorResult>;
}

// --- Factory Function ---

/**
 * Create a migration orchestrator.
 *
 * @param config - Orchestrator configuration
 * @returns MigrationOrchestrator instance
 */
export function createMigrationOrchestrator(config: MigrationOrchestratorConfig): MigrationOrchestrator {
  const {
    engine,
    transport,
    sourceNodeId,
    sourceEndpoint,
    resolveSourceHome,
    resolveSourceWork,
    resolveTargetHome,
    resolveTargetWork,
    resolveTargetEndpoint,
    tmpDir,
    logger,
    buildIdentity,
    transformWorkState,
  } = config;

  async function run(
    agentId: string,
    targetNodeId: string,
    reason: MigrationReason,
  ): Promise<OrchestratorResult> {
    const warnings: string[] = [];
    let migrationId = "";

    try {
      // Step 1: Initiate → REQUESTED
      logger.info(`[flock:migration:orchestrator] Starting migration: ${agentId} → ${targetNodeId}`);
      const ticket = engine.initiate(agentId, targetNodeId, reason);
      migrationId = ticket.migrationId;

      // Step 2: Notify target → get acceptance
      logger.info(`[flock:migration:orchestrator] ${migrationId}: Notifying target ${targetNodeId}`);
      const requestResult = await transport.notifyRequest({
        migrationId,
        agentId,
        sourceNodeId,
        targetNodeId,
        reason,
        sourceEndpoint,
      });

      if (!requestResult.accepted) {
        const errorMsg = requestResult.error ?? "Target rejected migration request";
        logger.warn(`[flock:migration:orchestrator] ${migrationId}: Target rejected: ${errorMsg}`);
        engine.rollback(migrationId, errorMsg);
        return {
          success: false,
          migrationId,
          finalPhase: engine.getStatus(migrationId)?.phase ?? "ABORTED",
          error: errorMsg,
        };
      }

      // Step 3: Advance to AUTHORIZED
      await engine.advancePhase(migrationId);

      // Step 4: Advance to FREEZING (freezes home)
      await engine.advancePhase(migrationId);

      // Step 5: Advance to FROZEN
      await engine.advancePhase(migrationId);

      // Step 6: Advance to SNAPSHOTTING
      await engine.advancePhase(migrationId);

      // Step 7: Create snapshot
      const sourceHomePath = resolveSourceHome(agentId);
      const sourceWorkPath = resolveSourceWork(agentId);
      logger.info(`[flock:migration:orchestrator] ${migrationId}: Creating snapshot`);
      const snapshot = await createSnapshot(sourceHomePath, migrationId, tmpDir, logger, sourceWorkPath);

      // Step 8: Advance to TRANSFERRING (home → MIGRATING)
      await engine.advancePhase(migrationId);

      // Step 9: Advance to VERIFYING
      await engine.advancePhase(migrationId);

      // Step 10: Transfer archive and verify on target
      const archiveBuffer = await readFile(snapshot.archivePath);
      logger.info(`[flock:migration:orchestrator] ${migrationId}: Transferring ${archiveBuffer.length} bytes`);
      const verification = await transport.transferAndVerify({
        migrationId,
        targetNodeId,
        archiveBuffer,
        checksum: snapshot.checksum,
      });

      // Step 11: Handle verification — ownership transfer point
      // If verification fails, handleVerification internally calls rollback
      const afterVerification = engine.handleVerification(migrationId, verification);
      if (afterVerification.phase !== "REHYDRATING") {
        return {
          success: false,
          migrationId,
          finalPhase: afterVerification.phase,
          error: `Verification failed: ${verification.failureReason ?? "unknown"}`,
        };
      }

      // Step 12: Rehydrate on target
      const targetHomePath = resolveTargetHome(agentId, targetNodeId);
      const targetWorkPath = resolveTargetWork(agentId, targetNodeId);

      const workState = transformWorkState
        ? transformWorkState(snapshot.workState)
        : snapshot.workState;

      const agentIdentity = buildIdentity ? buildIdentity(agentId) : null;

      const payload: MigrationPayload = {
        portable: {
          archive: archiveBuffer,
          checksum: snapshot.checksum,
          sizeBytes: archiveBuffer.length,
        },
        agentIdentity,
        workState,
      };

      logger.info(`[flock:migration:orchestrator] ${migrationId}: Rehydrating on ${targetNodeId}`);
      const rehydrateResult = await transport.rehydrate({
        migrationId,
        targetNodeId,
        payload,
        targetHomePath,
        targetWorkDir: targetWorkPath,
      });

      if (!rehydrateResult.success) {
        const errorMsg = rehydrateResult.error?.message ?? "Rehydration failed";
        logger.warn(`[flock:migration:orchestrator] ${migrationId}: Rehydration failed: ${errorMsg}`);
        engine.rollback(migrationId, errorMsg);
        return {
          success: false,
          migrationId,
          finalPhase: engine.getStatus(migrationId)?.phase ?? "ABORTED",
          error: errorMsg,
          warnings: rehydrateResult.warnings.length > 0 ? rehydrateResult.warnings : undefined,
        };
      }

      if (rehydrateResult.warnings.length > 0) {
        warnings.push(...rehydrateResult.warnings);
      }

      // Step 13: Complete → COMPLETED (source home RETIRED)
      const newHomeId = `${agentId}@${targetNodeId}`;
      const newEndpoint = resolveTargetEndpoint(targetNodeId);
      logger.info(`[flock:migration:orchestrator] ${migrationId}: Completing → ${newHomeId}`);
      const completed = await engine.complete(migrationId, newHomeId, newEndpoint);

      logger.info(`[flock:migration:orchestrator] ${migrationId}: Migration completed successfully`);
      return {
        success: true,
        migrationId,
        finalPhase: completed.phase,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[flock:migration:orchestrator] ${migrationId || "unknown"}: Error: ${errorMsg}`);

      // Attempt rollback if we have an active migration
      if (migrationId) {
        try {
          const status = engine.getStatus(migrationId);
          if (status && !isTerminalPhase(status.phase)) {
            engine.rollback(migrationId, `Orchestrator error: ${errorMsg}`);
          }
        } catch (rollbackErr) {
          const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          logger.error(`[flock:migration:orchestrator] ${migrationId}: Rollback failed: ${rbMsg}`);
        }
      }

      return {
        success: false,
        migrationId: migrationId || "unknown",
        finalPhase: migrationId
          ? (engine.getStatus(migrationId)?.phase ?? "FAILED")
          : "FAILED",
        error: errorMsg,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }
  }

  return { run };
}
