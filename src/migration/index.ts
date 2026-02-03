/**
 * Migration Engine — module exports.
 *
 * Re-exports all public types, interfaces, and factory functions
 * for the migration subsystem.
 */

// --- Types ---
export type {
  MigrationPhase,
  MigrationReason,
  MigrationTicket,
  MigrationEndpoint,
  MigrationPayload,
  PortableArchive,
  AgentIdentityPayload,
  WorkStateManifest,
  WorkProject,
  TransferManifest,
  VerificationResult,
  VerificationFailureReason,
  MigrationError,
  RecoveryStrategy,
  MigrationMode,
  SystemConstraints,
  MigrationAuditEntry,
  MigrationAuditAction,
  MigrationStatusInfo,
  PhaseTimeouts,
  RetryPolicy,
} from "./types.js";

export {
  MigrationErrorCode,
  MigrationRejectionReason,
  MIGRATION_PHASES,
  VALID_PHASE_TRANSITIONS,
  TERMINAL_PHASES,
  MAX_PORTABLE_SIZE_BYTES,
  DEFAULT_SYSTEM_CONSTRAINTS,
  DEFAULT_PHASE_TIMEOUTS,
  isMigrationPhase,
  isMigrationReason,
  isTerminalPhase,
} from "./types.js";

// --- Ticket Store ---
export type {
  MigrationTicketStore,
  CreateTicketParams,
  TicketUpdateFields,
  TicketFilter,
  TicketStoreParams,
} from "./ticket-store.js";

export { createTicketStore } from "./ticket-store.js";

// --- Snapshot ---
export type { SnapshotResult } from "./snapshot.js";

export {
  createSnapshot,
  collectWorkState,
  verifySnapshot,
  computeSha256,
  MigrationSnapshotError,
} from "./snapshot.js";

// --- Rehydrate ---
export type { RehydrateResult } from "./rehydrate.js";

export { rehydrate } from "./rehydrate.js";

// --- Retry ---
export {
  withRetry,
  getRetryPolicy,
  RETRY_NETWORK,
  RETRY_LOCAL,
} from "./retry.js";

// --- Handlers ---
export type {
  MigrationHandlerContext,
  MigrationHandler,
  MigrationHandlerMap,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
} from "./handlers.js";

export { createMigrationHandlers } from "./handlers.js";

// --- Engine ---
export type {
  MigrationEngine,
  MigrationEngineConfig,
} from "./engine.js";

export {
  createMigrationEngine,
  MigrationEngineError,
} from "./engine.js";

// --- Registry Hooks ---
export { onMigrationComplete } from "./registry-hooks.js";

// --- Frozen Guard ---
export type { FrozenGuardResult } from "./frozen-guard.js";

export { checkFrozenStatus } from "./frozen-guard.js";

// --- Post-Migration ---
export {
  hasPostMigrationTasks,
  readPostMigrationTasks,
  clearPostMigrationTasks,
} from "./post-migration.js";

// --- Orchestrator ---
export type {
  MigrationTransport,
  MigrationOrchestratorConfig,
  OrchestratorResult,
  MigrationOrchestrator,
} from "./orchestrator.js";

export { createMigrationOrchestrator } from "./orchestrator.js";

// --- A2A Transport ---
export type { DispatchResponse, HandlerDispatch } from "./a2a-transport.js";
export { createLocalDispatch, createHttpDispatch, createA2ATransport } from "./a2a-transport.js";
