/**
 * Flock A2A Transport Types
 *
 * Re-exports core A2A SDK types and defines Flock-specific extensions.
 * All agent communication flows through A2A — this module provides
 * the type foundation.
 */

// --- Re-export core A2A types ---
export type {
  AgentCard,
  AgentSkill,
  AgentCapabilities,
  Task,
  TaskState,
  TaskStatus,
  Message,
  TextPart,
  FilePart,
  DataPart,
  Part,
  Artifact,
  MessageSendParams,
  TaskQueryParams,
  TaskIdParams,
} from "@a2a-js/sdk";

// --- Flock-specific agent roles ---

/** Agent roles within the Flock system. */
export type FlockAgentRole = "sysadmin" | "worker" | "system" | "orchestrator";

/** Flock-specific metadata embedded in Agent Card's metadata field. */
export interface FlockCardMetadata {
  /** Agent's role in the Flock system. */
  role: FlockAgentRole;
  /** Node this agent resides on. */
  nodeId: string;
  /** Home ID (agentId@nodeId). */
  homeId: string;
  /** Trust level (0-100, starts at 50). */
  trustLevel?: number;
  /** Guilds this agent belongs to. */
  guilds?: string[];
}

/** Flock-specific task metadata embedded in A2A DataPart. */
export interface FlockTaskMetadata {
  /** What kind of Flock operation this represents. */
  flockType: "sysadmin-request" | "worker-task" | "review" | "system-op";
  /** Urgency level. */
  urgency?: "low" | "normal" | "high";
  /** Related project. */
  project?: string;
  /** Requesting agent's home ID. */
  fromHome?: string;
  /** Expected triage level (sysadmin requests). */
  expectedLevel?: "GREEN" | "YELLOW" | "RED";
}

/** Result of a sysadmin triage decision. */
export interface TriageResult {
  level: "GREEN" | "YELLOW" | "RED";
  action: string;
  reasoning: string;
  riskFactors?: string[];
  requiresHumanApproval?: boolean;
}

// --- Transport configuration ---

export interface TransportConfig {
  /** Port for the A2A HTTP server. 0 = auto-assign. */
  port: number;
  /** Hostname to bind to. */
  host: string;
  /** Base path for A2A endpoints. */
  basePath: string;
}

export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  port: 0,
  host: "127.0.0.1",
  basePath: "/flock",
};

// --- Agent Card registry entry ---

export interface CardRegistryEntry {
  agentId: string;
  card: import("@a2a-js/sdk").AgentCard;
  registeredAt: number;
  lastSeen: number;
}
