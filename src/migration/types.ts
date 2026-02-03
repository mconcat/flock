/**
 * Migration Engine — Type Definitions
 *
 * All types for agent migration between Flock nodes.
 * Implements the migration protocol from design doc §11.
 *
 * Migration phases follow: REQUESTED → AUTHORIZED → FREEZING → FROZEN →
 * SNAPSHOTTING → TRANSFERRING → VERIFYING → REHYDRATING → FINALIZING →
 * COMPLETED (or ROLLING_BACK / ABORTED / FAILED on error).
 */

import type { AuditEntry, AuditLevel, HomeState } from "../types.js";

// --- Migration Phases ---

/** Migration phases (ordered). Terminal states: COMPLETED, ABORTED, FAILED. */
export type MigrationPhase =
  | "REQUESTED"
  | "AUTHORIZED"
  | "FREEZING"
  | "FROZEN"
  | "SNAPSHOTTING"
  | "TRANSFERRING"
  | "VERIFYING"
  | "REHYDRATING"
  | "FINALIZING"
  | "COMPLETED"
  | "ROLLING_BACK"
  | "ABORTED"
  | "FAILED";

/** All valid migration phases as a readonly array for runtime validation. */
export const MIGRATION_PHASES: readonly MigrationPhase[] = [
  "REQUESTED",
  "AUTHORIZED",
  "FREEZING",
  "FROZEN",
  "SNAPSHOTTING",
  "TRANSFERRING",
  "VERIFYING",
  "REHYDRATING",
  "FINALIZING",
  "COMPLETED",
  "ROLLING_BACK",
  "ABORTED",
  "FAILED",
] as const;

/** Terminal migration phases — no further transitions allowed. */
export const TERMINAL_PHASES: ReadonlySet<MigrationPhase> = new Set([
  "COMPLETED",
  "ABORTED",
  "FAILED",
]);

/** Check if a migration phase is terminal (COMPLETED, ABORTED, or FAILED). */
export function isTerminalPhase(phase: MigrationPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** Runtime check for MigrationPhase. */
export function isMigrationPhase(v: unknown): v is MigrationPhase {
  return typeof v === "string" && VALID_PHASES_SET.has(v);
}

const VALID_PHASES_SET = new Set<string>(MIGRATION_PHASES);

/**
 * Valid phase transitions.
 * Key = current phase, value = set of allowed next phases.
 */
export const VALID_PHASE_TRANSITIONS: Readonly<Record<MigrationPhase, readonly MigrationPhase[]>> = {
  REQUESTED: ["AUTHORIZED", "ABORTED", "FAILED"],
  AUTHORIZED: ["FREEZING", "ABORTED", "FAILED"],
  FREEZING: ["FROZEN", "ABORTED", "FAILED"],
  FROZEN: ["SNAPSHOTTING", "ROLLING_BACK", "ABORTED", "FAILED"],
  SNAPSHOTTING: ["TRANSFERRING", "ROLLING_BACK", "FAILED"],
  TRANSFERRING: ["VERIFYING", "ROLLING_BACK", "FAILED"],
  VERIFYING: ["REHYDRATING", "ROLLING_BACK", "FAILED"],
  REHYDRATING: ["FINALIZING", "ROLLING_BACK", "FAILED"],
  FINALIZING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  ROLLING_BACK: ["ABORTED", "FAILED"],
  ABORTED: [],
  FAILED: [],
};

// --- Migration Reason ---

/** Reason for initiating a migration. */
export type MigrationReason =
  | "agent_request"
  | "orchestrator_rebalance"
  | "node_retiring"
  | "lease_migration"
  | "security_relocation"
  | "resource_need";

/** Runtime check for MigrationReason. */
export function isMigrationReason(v: unknown): v is MigrationReason {
  return typeof v === "string" && VALID_REASONS_SET.has(v);
}

const VALID_REASONS_SET = new Set<string>([
  "agent_request",
  "orchestrator_rebalance",
  "node_retiring",
  "lease_migration",
  "security_relocation",
  "resource_need",
]);

// --- Migration Ticket ---

/** Migration ticket — tracks the full state of a single migration. */
export interface MigrationTicket {
  /** Unique migration ID (UUID v4). */
  readonly migrationId: string;

  /** Agent being migrated. */
  readonly agentId: string;

  /** Source node information. */
  readonly source: MigrationEndpoint;

  /** Target node information. */
  readonly target: MigrationEndpoint;

  /** Current migration phase. */
  phase: MigrationPhase;

  /** Current ownership holder. */
  ownershipHolder: "source" | "target";

  /** Reason for migration. */
  readonly reason: MigrationReason;

  /** Target reservation ID (null if not yet reserved). */
  reservationId: string | null;

  /** Timestamp for each phase entered. */
  timestamps: Partial<Record<MigrationPhase, number>>;

  /** Creation time (epoch ms). */
  readonly createdAt: number;

  /** Last update time (epoch ms). */
  updatedAt: number;

  /** Error info if migration failed. */
  error: MigrationError | null;
}

/** Endpoint information for source or target node. */
export interface MigrationEndpoint {
  readonly nodeId: string;
  readonly homeId: string;
  readonly endpoint: string;
}

// --- Migration Payload ---

/** Data transferred during migration. Architecture mode determines content. */
export interface MigrationPayload {
  /** Portable storage archive — always transferred. */
  portable: PortableArchive;

  /**
   * Agent identity information.
   * - P2P mode: full identity included (physical transfer)
   * - Central mode: null (identity stays central, only host mapping updated)
   */
  agentIdentity: AgentIdentityPayload | null;

  /** Work state manifest — always included. */
  workState: WorkStateManifest;
}

/** Portable storage archive info. */
export interface PortableArchive {
  /** tar.gz archive as a Buffer. */
  archive: Buffer;
  /** SHA-256 checksum of the archive. */
  checksum: string;
  /** Archive size in bytes. */
  sizeBytes: number;
}

/** Agent identity payload for P2P mode. */
export interface AgentIdentityPayload {
  agentId: string;
  role: string;
  guilds: string[];
  metadata: Record<string, unknown>;
}

// --- Work State ---

/** Manifest of git project states under /flock/work/. */
export interface WorkStateManifest {
  /** Git state for each project directory. */
  projects: WorkProject[];
  /** Manifest creation time (epoch ms). */
  capturedAt: number;
}

/** Git state of a single work project. */
export interface WorkProject {
  /** Path relative to /flock/work/ (e.g., "my-project"). */
  relativePath: string;
  /** Git remote URL. */
  remoteUrl: string;
  /** Current branch name. */
  branch: string;
  /** HEAD commit SHA. */
  commitSha: string;
  /** Uncommitted changes as patch content, or null. */
  uncommittedPatch: string | null;
  /** List of untracked files (warning only, not transferred). */
  untrackedFiles: string[];
}

// --- Transfer Manifest ---

/** Manifest describing all data to be transferred. */
export interface TransferManifest {
  /** Migration ID. */
  migrationId: string;

  /** Agent layer archive metadata. */
  agentLayer: {
    /** SHA-256 checksum of the tar.gz file. */
    checksum: string;
    /** Archive size in bytes. */
    sizeBytes: number;
    /** Snapshot timestamp (epoch ms). */
    snapshotAt: number;
  };

  /** Work state (git repos). */
  workState: WorkStateManifest;

  /** Secrets transfer strategy. */
  secretsStrategy: "transport" | "re_provision" | "none";

  /** Source base version (for target compatibility check). */
  baseVersion: string;

  /** Estimated total transfer size in bytes. */
  estimatedTotalBytes: number;
}

// --- Verification ---

/** Checksum verification result from target. */
export interface VerificationResult {
  /** Whether verification passed. */
  verified: boolean;
  /** Failure reason (when verified=false). */
  failureReason?: VerificationFailureReason;
  /** Target-computed checksum (for debugging). */
  computedChecksum?: string;
  /** Verification completion time (epoch ms). */
  verifiedAt: number;
}

/** Reasons for verification failure. */
export type VerificationFailureReason =
  | "CHECKSUM_MISMATCH"
  | "SIZE_MISMATCH"
  | "ARCHIVE_CORRUPT"
  | "BASE_VERSION_MISMATCH"
  | "DISK_FULL";

// --- Migration Errors ---

/** Structured migration error. */
export interface MigrationError {
  /** Error code. */
  code: MigrationErrorCode;
  /** Human-readable message. */
  message: string;
  /** Phase where error occurred. */
  phase: MigrationPhase;
  /** Origin of the error. */
  origin: "source" | "target";
  /** Recovery strategy. */
  recovery: RecoveryStrategy;
  /** Additional debugging info. */
  details?: Record<string, unknown>;
}

/** Migration error codes, organized by phase. */
export enum MigrationErrorCode {
  // --- Authorization (1xxx) ---
  AUTH_REJECTED = 1001,
  AUTH_TIMEOUT = 1003,

  // --- Freeze (2xxx) ---
  FREEZE_ACK_TIMEOUT = 2001,
  FREEZE_PROCESS_KILL_FAILED = 2002,
  FREEZE_INVALID_STATE = 2003,

  // --- Snapshot (3xxx) ---
  SNAPSHOT_ARCHIVE_FAILED = 3001,
  SNAPSHOT_CHECKSUM_FAILED = 3002,
  SNAPSHOT_WORK_STATE_FAILED = 3003,
  SNAPSHOT_PORTABLE_SIZE_EXCEEDED = 3004,

  // --- Transfer (4xxx) ---
  TRANSFER_NETWORK_FAILED = 4001,
  TRANSFER_TIMEOUT = 4002,
  TRANSFER_DISK_FULL = 4003,
  TRANSFER_RESERVATION_INVALID = 4004,

  // --- Verification (5xxx) ---
  VERIFY_CHECKSUM_MISMATCH = 5001,
  VERIFY_SIZE_MISMATCH = 5002,
  VERIFY_ARCHIVE_CORRUPT = 5003,
  VERIFY_BASE_VERSION_MISMATCH = 5004,
  VERIFY_ACK_TIMEOUT = 5005,

  // --- Rehydrate (6xxx) ---
  REHYDRATE_EXTRACT_FAILED = 6001,
  REHYDRATE_GIT_CLONE_FAILED = 6002,
  REHYDRATE_GIT_APPLY_FAILED = 6003,
  REHYDRATE_BASE_MOUNT_FAILED = 6004,
  REHYDRATE_SECRETS_PLACEMENT_FAILED = 6005,

  // --- Finalize (7xxx) ---
  FINALIZE_NOTIFICATION_FAILED = 7001,
  FINALIZE_REGISTRY_UPDATE_FAILED = 7002,

  // --- General (9xxx) ---
  UNKNOWN = 9001,
  MANUAL_ABORT = 9002,
  INTERNAL_STATE_INCONSISTENCY = 9003,
}

/** Recovery strategy for migration errors. */
export type RecoveryStrategy =
  | { type: "auto_rollback" }
  | { type: "retry"; maxAttempts: number; delayMs: number }
  | { type: "manual_intervention"; instructions: string }
  | { type: "abort"; cleanupRequired: boolean };

// --- Rejection Reasons ---

/** Standard migration rejection reasons from target node. */
export enum MigrationRejectionReason {
  INSUFFICIENT_DISK = "INSUFFICIENT_DISK",
  CAPACITY_EXCEEDED = "CAPACITY_EXCEEDED",
  DUPLICATE_AGENT = "DUPLICATE_AGENT",
  POLICY_VIOLATION = "POLICY_VIOLATION",
  NODE_MAINTENANCE = "NODE_MAINTENANCE",
}

// --- Retry Policy ---

/**
 * Configuration for retry behavior on migration errors.
 * Uses exponential backoff: delay = min(baseDelayMs * backoffFactor^attempt, maxDelayMs).
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts. */
  readonly maxAttempts: number;
  /** Base delay in milliseconds before first retry. */
  readonly baseDelayMs: number;
  /** Maximum delay cap in milliseconds. */
  readonly maxDelayMs?: number;
  /** Backoff multiplier (default: 2). */
  readonly backoffFactor?: number;
}

// --- System Constraints ---

/** Hard-coded system constraints enforced by plugin code. */
export const MAX_PORTABLE_SIZE_BYTES = 4 * 1024 * 1024 * 1024; // 4GB

/** Migration architecture mode. */
export type MigrationMode = "p2p" | "central";

/** System constraints interface. */
export interface SystemConstraints {
  /** Portable storage max size (4GB). */
  readonly MAX_PORTABLE_SIZE_BYTES: number;
  /** Migration mode determining agentIdentity inclusion. */
  readonly MIGRATION_MODE: MigrationMode;
}

/** Default system constraints. */
export const DEFAULT_SYSTEM_CONSTRAINTS: SystemConstraints = {
  MAX_PORTABLE_SIZE_BYTES,
  MIGRATION_MODE: "p2p",
};

// --- Audit ---

/** Migration-specific audit actions. */
export type MigrationAuditAction =
  | "initiated"
  | "authorized"
  | "rejected"
  | "frozen"
  | "snapshot_created"
  | "transfer_started"
  | "transfer_completed"
  | "verification_success"
  | "verification_failed"
  | "rehydrate_started"
  | "rehydrate_completed"
  | "rehydrate_failed"
  | "finalized"
  | "rollback"
  | "aborted";

/** Migration audit entry extending the base AuditEntry. */
export interface MigrationAuditEntry extends AuditEntry {
  /** The action is always prefixed with migration. */
  action: `migration.${MigrationAuditAction}`;
  /** Migration-specific level (always YELLOW for migration events). */
  level: AuditLevel;
  /** Migration ID. */
  migrationId: string;
  /** Current migration phase. */
  phase: MigrationPhase;
  /** Source node ID. */
  sourceNodeId: string;
  /** Target node ID. */
  targetNodeId: string;
}

// --- Migration Status Response ---

/** Response to a migration/status query. */
export interface MigrationStatusInfo {
  migrationId: string;
  phase: MigrationPhase;
  ownershipHolder: "source" | "target";
  sourceState: HomeState;
  targetState: HomeState | null;
  startedAt: number;
  lastUpdatedAt: number;
}

// --- Phase Timeout Configuration ---

/** Per-phase timeout configuration (milliseconds). */
export interface PhaseTimeouts {
  readonly REQUESTED: number;
  readonly AUTHORIZED: number;
  readonly FREEZING: number;
  readonly FROZEN: number;
  readonly SNAPSHOTTING: number;
  readonly TRANSFERRING: number;
  readonly VERIFYING: number;
  readonly REHYDRATING: number;
  readonly FINALIZING: number;
}

/** Default phase timeouts. */
export const DEFAULT_PHASE_TIMEOUTS: PhaseTimeouts = {
  REQUESTED: 60_000,       // 1 min
  AUTHORIZED: 120_000,     // 2 min
  FREEZING: 60_000,        // 1 min
  FROZEN: 300_000,         // 5 min
  SNAPSHOTTING: 600_000,   // 10 min
  TRANSFERRING: 600_000,   // 10 min
  VERIFYING: 120_000,      // 2 min
  REHYDRATING: 600_000,    // 10 min
  FINALIZING: 120_000,     // 2 min
};
