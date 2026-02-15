/**
 * Core type definitions for Flock.
 */

// --- Logger ---

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

// --- Home State Machine ---

export type HomeState =
  | "UNASSIGNED"
  | "PROVISIONING"
  | "IDLE"
  | "LEASED"
  | "ACTIVE"
  | "FROZEN"
  | "MIGRATING"
  | "ERROR"
  | "RETIRED";

export interface HomeRecord {
  homeId: string; // agent_id@node_id
  agentId: string;
  nodeId: string;
  state: HomeState;
  leaseExpiresAt: number | null; // epoch ms
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface HomeTransition {
  homeId: string;
  fromState: HomeState;
  toState: HomeState;
  reason: string;
  triggeredBy: string; // agent or system
  timestamp: number;
}

// --- Audit ---

export type AuditLevel = "GREEN" | "YELLOW" | "RED";

/** Runtime check for AuditLevel (also covers TriageResult.level). */
export function isAuditLevel(v: unknown): v is AuditLevel {
  return v === "GREEN" || v === "YELLOW" || v === "RED";
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  homeId?: string;
  agentId: string;
  action: string;
  level: AuditLevel;
  detail: string;
  result?: string;
  duration?: number;
}
