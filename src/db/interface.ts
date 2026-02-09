/**
 * Database interface — backend-agnostic storage abstraction.
 *
 * All persistence goes through this interface. Implementations:
 * - SQLite (default, built-in)
 * - PostgreSQL (future)
 * - SaaS/API-backed (future)
 * - In-memory (testing)
 */

import type {
  HomeRecord,
  HomeState,
  HomeTransition,
  AuditEntry,
  AuditLevel,
} from "../types.js";

// --- Query filters ---

export interface HomeFilter {
  homeId?: string;
  agentId?: string;
  nodeId?: string;
  state?: HomeState;
  limit?: number;
}

export interface TransitionFilter {
  homeId?: string;
  triggeredBy?: string;
  since?: number;
  limit?: number;
}

export interface AuditFilter {
  homeId?: string;
  agentId?: string;
  action?: string;
  level?: AuditLevel;
  since?: number;
  limit?: number;
}

// --- Task store types ---

/** Task lifecycle states, aligned with A2A task state machine. */
export type TaskState =
  | "submitted"
  | "accepted"
  | "rejected"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

/** Valid task states as a readonly array for runtime validation. */
export const TASK_STATES = [
  "submitted", "accepted", "rejected", "working",
  "input-required", "completed", "failed", "canceled",
] as const;

/** Runtime check for TaskState. */
export function isTaskState(v: unknown): v is TaskState {
  return typeof v === "string" && VALID_TASK_STATES.has(v);
}

const VALID_TASK_STATES = new Set<string>(TASK_STATES);

/** Persistent record of an inter-agent task. */
export interface TaskRecord {
  taskId: string;
  contextId: string;
  fromAgentId: string;
  toAgentId: string;
  state: TaskState;
  messageType: string;
  summary: string;
  payload: string;
  responseText: string | null;
  responsePayload: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/** Filter criteria for querying tasks. */
export interface TaskFilter {
  taskId?: string;
  fromAgentId?: string;
  toAgentId?: string;
  state?: TaskState;
  messageType?: string;
  since?: number;
  limit?: number;
}

/** Updatable fields on a TaskRecord. */
export type TaskUpdateFields = Partial<Pick<TaskRecord, "state" | "responseText" | "responsePayload" | "updatedAt" | "completedAt">>;

export interface TaskStore {
  insert(record: TaskRecord): void;
  update(taskId: string, fields: TaskUpdateFields): void;
  get(taskId: string): TaskRecord | null;
  list(filter?: TaskFilter): TaskRecord[];
  count(filter?: TaskFilter): number;
}

// --- Channel store (named conversation spaces with membership) ---

/** A persistent channel with name, topic, and membership. */
export interface ChannelRecord {
  channelId: string;       // human-readable, e.g. "project-logging-lib"
  name: string;            // display name
  topic: string;           // purpose description (injected into agent prompts)
  createdBy: string;       // agent ID or "human:username"
  members: string[];       // agent IDs + human identifiers
  archived: boolean;       // true = read-only
  createdAt: number;       // epoch ms
  updatedAt: number;       // epoch ms
}

export interface ChannelFilter {
  channelId?: string;
  createdBy?: string;
  archived?: boolean;
  member?: string;         // filter channels containing this member
  limit?: number;
}

export interface ChannelStore {
  insert(record: ChannelRecord): void;
  update(channelId: string, fields: Partial<Pick<ChannelRecord, "name" | "topic" | "members" | "archived" | "updatedAt">>): void;
  get(channelId: string): ChannelRecord | null;
  list(filter?: ChannelFilter): ChannelRecord[];
  delete(channelId: string): void;
}

// --- Channel message store (shared history within channels) ---

/** A single message in a channel. */
export interface ChannelMessage {
  channelId: string;
  seq: number;         // auto-incrementing sequence within channel
  agentId: string;     // who sent this message
  content: string;     // message text
  timestamp: number;   // epoch ms
}

export interface ChannelMessageFilter {
  channelId: string;
  since?: number;      // seq number to start from
  limit?: number;
}

export interface ChannelMessageStore {
  /** Append a message to a channel. Returns the assigned seq number. */
  append(msg: Omit<ChannelMessage, "seq">): number;
  /** Get messages in a channel, ordered by seq. */
  list(filter: ChannelMessageFilter): ChannelMessage[];
  /** Count messages in a channel. */
  count(channelId: string): number;
}

// --- Agent loop state (work loop AWAKE/SLEEP) ---

/** Agent work loop state. */
export type AgentLoopState = "AWAKE" | "SLEEP";

/** Persistent record of an agent's work loop state. */
export interface AgentLoopRecord {
  agentId: string;
  state: AgentLoopState;
  lastTickAt: number;         // epoch ms — last tick sent
  awakenedAt: number;         // epoch ms — when agent last woke up
  sleptAt: number | null;     // epoch ms — when agent last went to sleep
  sleepReason: string | null; // reason agent gave for sleeping
}

export interface AgentLoopStore {
  /** Initialize an agent's loop state. Idempotent (no-op if already exists). */
  init(agentId: string, state: AgentLoopState): void;
  /** Get the loop state of an agent. */
  get(agentId: string): AgentLoopRecord | null;
  /** Update loop state (AWAKE or SLEEP). */
  setState(agentId: string, state: AgentLoopState, reason?: string): void;
  /** Update the last tick timestamp. */
  updateLastTick(agentId: string, timestamp: number): void;
  /** List all agents in a given state. */
  listByState(state: AgentLoopState): AgentLoopRecord[];
  /** List all agents. */
  listAll(): AgentLoopRecord[];
}

// --- Store interfaces (one per domain) ---

export interface HomeStore {
  insert(record: HomeRecord): void;
  update(homeId: string, fields: Partial<Pick<HomeRecord, "state" | "leaseExpiresAt" | "updatedAt" | "metadata">>): void;
  get(homeId: string): HomeRecord | null;
  list(filter?: HomeFilter): HomeRecord[];
  delete(homeId: string): void;
}

export interface TransitionStore {
  insert(entry: HomeTransition): void;
  list(filter?: TransitionFilter): HomeTransition[];
}

export interface AuditStore {
  insert(entry: AuditEntry): void;
  query(filter?: AuditFilter): AuditEntry[];
  count(filter?: AuditFilter): number;
}

// --- Unified database backend ---

export interface FlockDatabase {
  readonly backend: string; // "sqlite" | "postgres" | "memory" | ...

  homes: HomeStore;
  transitions: TransitionStore;
  audit: AuditStore;
  tasks: TaskStore;
  channels: ChannelStore;
  channelMessages: ChannelMessageStore;
  agentLoop: AgentLoopStore;

  /** Run all stores' schema migrations. */
  migrate(): void;

  /** Graceful shutdown (close connections, flush buffers). */
  close(): void;
}
