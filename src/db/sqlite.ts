/**
 * SQLite database backend using better-sqlite3.
 * Synchronous API — fits Clawdbot's plugin model.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type {
  HomeRecord,
  HomeState,
  HomeTransition,
  AuditEntry,
  AuditLevel,
} from "../types.js";
import type {
  FlockDatabase,
  HomeStore,
  TransitionStore,
  AuditStore,
  TaskStore,
  ChannelStore,
  ChannelRecord,
  ChannelFilter,
  ChannelMessageStore,
  ChannelMessage,
  ChannelMessageFilter,
  HomeFilter,
  TransitionFilter,
  AuditFilter,
  TaskFilter,
  TaskRecord,
  TaskState,
  TaskUpdateFields,
  AgentLoopStore,
  AgentLoopRecord,
  AgentLoopState,
} from "./interface.js";
import { isTaskState } from "./interface.js";

// --- Schema ---

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS homes (
  homeId TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  nodeId TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'UNASSIGNED',
  leaseExpiresAt INTEGER,
  metadata TEXT DEFAULT '{}',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_homes_nodeId ON homes(nodeId);
CREATE INDEX IF NOT EXISTS idx_homes_state ON homes(state);
CREATE INDEX IF NOT EXISTS idx_homes_agentId ON homes(agentId);

CREATE TABLE IF NOT EXISTS home_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homeId TEXT NOT NULL,
  fromState TEXT NOT NULL,
  toState TEXT NOT NULL,
  reason TEXT NOT NULL,
  triggeredBy TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transitions_homeId ON home_transitions(homeId);
CREATE INDEX IF NOT EXISTS idx_transitions_timestamp ON home_transitions(timestamp);

CREATE TABLE IF NOT EXISTS audit_entries (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  homeId TEXT,
  agentId TEXT NOT NULL,
  action TEXT NOT NULL,
  level TEXT NOT NULL,
  detail TEXT NOT NULL,
  result TEXT,
  duration INTEGER
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_entries(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_agentId ON audit_entries(agentId);
CREATE INDEX IF NOT EXISTS idx_audit_level ON audit_entries(level);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_entries(action);

CREATE TABLE IF NOT EXISTS tasks (
  taskId TEXT PRIMARY KEY,
  contextId TEXT NOT NULL,
  fromAgentId TEXT NOT NULL,
  toAgentId TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'submitted',
  messageType TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  responseText TEXT,
  responsePayload TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  completedAt INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_fromAgentId ON tasks(fromAgentId);
CREATE INDEX IF NOT EXISTS idx_tasks_toAgentId ON tasks(toAgentId);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_messageType ON tasks(messageType);
CREATE INDEX IF NOT EXISTS idx_tasks_createdAt ON tasks(createdAt);

CREATE TABLE IF NOT EXISTS channels (
  channelId TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  createdBy TEXT NOT NULL,
  members TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_createdBy ON channels(createdBy);
CREATE INDEX IF NOT EXISTS idx_channels_archived ON channels(archived);

CREATE TABLE IF NOT EXISTS channel_messages (
  channelId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  agentId TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (channelId, seq)
);
CREATE INDEX IF NOT EXISTS idx_channel_messages_channelId ON channel_messages(channelId);

CREATE TABLE IF NOT EXISTS agent_loop_states (
  agentId TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'AWAKE',
  lastTickAt INTEGER NOT NULL,
  awakenedAt INTEGER NOT NULL,
  sleptAt INTEGER,
  sleepReason TEXT
);
CREATE INDEX IF NOT EXISTS idx_loop_state ON agent_loop_states(state);
`;

// --- Row types (what SQLite returns) ---

interface HomeRow {
  homeId: string;
  agentId: string;
  nodeId: string;
  state: string;
  leaseExpiresAt: number | null;
  metadata: string;
  createdAt: number;
  updatedAt: number;
}

interface TransitionRow {
  id: number;
  homeId: string;
  fromState: string;
  toState: string;
  reason: string;
  triggeredBy: string;
  timestamp: number;
}

interface AuditRow {
  id: string;
  timestamp: number;
  homeId: string | null;
  agentId: string;
  action: string;
  level: string;
  detail: string;
  result: string | null;
  duration: number | null;
}

interface TaskRow {
  taskId: string;
  contextId: string;
  fromAgentId: string;
  toAgentId: string;
  state: string;
  messageType: string;
  summary: string;
  payload: string;
  responseText: string | null;
  responsePayload: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface CountRow {
  count: number;
}

// --- Conversions ---

function safeParseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function rowToHome(row: HomeRow): HomeRecord {
  return {
    homeId: row.homeId,
    agentId: row.agentId,
    nodeId: row.nodeId,
    state: row.state as HomeState,
    leaseExpiresAt: row.leaseExpiresAt,
    metadata: safeParseJson(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToTransition(row: TransitionRow): HomeTransition {
  return {
    homeId: row.homeId,
    fromState: row.fromState as HomeState,
    toState: row.toState as HomeState,
    reason: row.reason,
    triggeredBy: row.triggeredBy,
    timestamp: row.timestamp,
  };
}

function rowToAudit(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    homeId: row.homeId ?? undefined,
    agentId: row.agentId,
    action: row.action,
    level: row.level as AuditLevel,
    detail: row.detail,
    result: row.result ?? undefined,
    duration: row.duration ?? undefined,
  };
}

function rowToTask(row: TaskRow): TaskRecord {
  const state = isTaskState(row.state) ? row.state : "submitted";
  return {
    taskId: row.taskId,
    contextId: row.contextId,
    fromAgentId: row.fromAgentId,
    toAgentId: row.toAgentId,
    state,
    messageType: row.messageType,
    summary: row.summary,
    payload: row.payload,
    responseText: row.responseText,
    responsePayload: row.responsePayload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

// --- Store implementations ---

function createSqliteHomeStore(db: Database.Database): HomeStore {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO homes (homeId, agentId, nodeId, state, leaseExpiresAt, metadata, createdAt, updatedAt)
      VALUES (@homeId, @agentId, @nodeId, @state, @leaseExpiresAt, @metadata, @createdAt, @updatedAt)
    `),
    get: db.prepare(`SELECT * FROM homes WHERE homeId = ?`),
    delete: db.prepare(`DELETE FROM homes WHERE homeId = ?`),
  };

  return {
    insert(record) {
      stmts.insert.run({
        homeId: record.homeId,
        agentId: record.agentId,
        nodeId: record.nodeId,
        state: record.state,
        leaseExpiresAt: record.leaseExpiresAt,
        metadata: JSON.stringify(record.metadata),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    },

    update(homeId, fields) {
      const sets: string[] = [];
      const values: Record<string, unknown> = { homeId };

      if (fields.state !== undefined) {
        sets.push("state = @state");
        values.state = fields.state;
      }
      if (fields.leaseExpiresAt !== undefined) {
        sets.push("leaseExpiresAt = @leaseExpiresAt");
        values.leaseExpiresAt = fields.leaseExpiresAt;
      }
      if (fields.updatedAt !== undefined) {
        sets.push("updatedAt = @updatedAt");
        values.updatedAt = fields.updatedAt;
      }
      if (fields.metadata !== undefined) {
        sets.push("metadata = @metadata");
        values.metadata = JSON.stringify(fields.metadata);
      }

      if (sets.length === 0) return;
      db.prepare(`UPDATE homes SET ${sets.join(", ")} WHERE homeId = @homeId`).run(values);
    },

    get(homeId) {
      const row = stmts.get.get(homeId) as HomeRow | undefined;
      return row ? rowToHome(row) : null;
    },

    list(filter?: HomeFilter) {
      const conditions: string[] = [];
      const values: Record<string, unknown> = {};

      if (filter?.homeId) {
        conditions.push("homeId = @homeId");
        values.homeId = filter.homeId;
      }
      if (filter?.agentId) {
        conditions.push("agentId = @agentId");
        values.agentId = filter.agentId;
      }
      if (filter?.nodeId) {
        conditions.push("nodeId = @nodeId");
        values.nodeId = filter.nodeId;
      }
      if (filter?.state) {
        conditions.push("state = @state");
        values.state = filter.state;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      if (filter?.limit) {
        values._limit = Math.floor(filter.limit);
      }
      const limitClause = filter?.limit ? "LIMIT @_limit" : "";
      const sql = `SELECT * FROM homes ${where} ORDER BY createdAt ASC ${limitClause}`;

      const rows = db.prepare(sql).all(values) as HomeRow[];
      return rows.map(rowToHome);
    },

    delete(homeId) {
      stmts.delete.run(homeId);
    },
  };
}

function createSqliteTransitionStore(db: Database.Database): TransitionStore {
  const insertStmt = db.prepare(`
    INSERT INTO home_transitions (homeId, fromState, toState, reason, triggeredBy, timestamp)
    VALUES (@homeId, @fromState, @toState, @reason, @triggeredBy, @timestamp)
  `);

  return {
    insert(entry) {
      insertStmt.run({
        homeId: entry.homeId,
        fromState: entry.fromState,
        toState: entry.toState,
        reason: entry.reason,
        triggeredBy: entry.triggeredBy,
        timestamp: entry.timestamp,
      });
    },

    list(filter?: TransitionFilter) {
      const conditions: string[] = [];
      const values: Record<string, unknown> = {};

      if (filter?.homeId) {
        conditions.push("homeId = @homeId");
        values.homeId = filter.homeId;
      }
      if (filter?.triggeredBy) {
        conditions.push("triggeredBy = @triggeredBy");
        values.triggeredBy = filter.triggeredBy;
      }
      if (filter?.since) {
        conditions.push("timestamp >= @since");
        values.since = filter.since;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      if (filter?.limit) {
        values._limit = Math.floor(filter.limit);
      }
      const limitClause = filter?.limit ? "LIMIT @_limit" : "";
      const sql = `SELECT * FROM home_transitions ${where} ORDER BY timestamp ASC ${limitClause}`;

      const rows = db.prepare(sql).all(values) as TransitionRow[];
      return rows.map(rowToTransition);
    },
  };
}

function createSqliteAuditStore(db: Database.Database): AuditStore {
  const insertStmt = db.prepare(`
    INSERT INTO audit_entries (id, timestamp, homeId, agentId, action, level, detail, result, duration)
    VALUES (@id, @timestamp, @homeId, @agentId, @action, @level, @detail, @result, @duration)
  `);

  return {
    insert(entry) {
      insertStmt.run({
        id: entry.id,
        timestamp: entry.timestamp,
        homeId: entry.homeId ?? null,
        agentId: entry.agentId,
        action: entry.action,
        level: entry.level,
        detail: entry.detail,
        result: entry.result ?? null,
        duration: entry.duration ?? null,
      });
    },

    query(filter?: AuditFilter) {
      const conditions: string[] = [];
      const values: Record<string, unknown> = {};

      if (filter?.homeId) {
        conditions.push("homeId = @homeId");
        values.homeId = filter.homeId;
      }
      if (filter?.agentId) {
        conditions.push("agentId = @agentId");
        values.agentId = filter.agentId;
      }
      if (filter?.action) {
        conditions.push("action = @action");
        values.action = filter.action;
      }
      if (filter?.level) {
        conditions.push("level = @level");
        values.level = filter.level;
      }
      if (filter?.since) {
        conditions.push("timestamp >= @since");
        values.since = filter.since;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      if (filter?.limit) {
        values._limit = Math.floor(filter.limit);
      }
      const limitClause = filter?.limit ? "LIMIT @_limit" : "";
      const sql = `SELECT * FROM audit_entries ${where} ORDER BY timestamp DESC ${limitClause}`;

      const rows = db.prepare(sql).all(values) as AuditRow[];
      return rows.map(rowToAudit);
    },

    count(filter?: AuditFilter) {
      const conditions: string[] = [];
      const values: Record<string, unknown> = {};

      if (filter?.agentId) {
        conditions.push("agentId = @agentId");
        values.agentId = filter.agentId;
      }
      if (filter?.level) {
        conditions.push("level = @level");
        values.level = filter.level;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const sql = `SELECT COUNT(*) as count FROM audit_entries ${where}`;

      const row = db.prepare(sql).get(values) as CountRow;
      return row.count;
    },
  };
}

function createSqliteTaskStore(db: Database.Database): TaskStore {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO tasks (taskId, contextId, fromAgentId, toAgentId, state, messageType, summary, payload, responseText, responsePayload, createdAt, updatedAt, completedAt)
      VALUES (@taskId, @contextId, @fromAgentId, @toAgentId, @state, @messageType, @summary, @payload, @responseText, @responsePayload, @createdAt, @updatedAt, @completedAt)
    `),
    get: db.prepare(`SELECT * FROM tasks WHERE taskId = ?`),
  };

  return {
    insert(record) {
      stmts.insert.run({
        taskId: record.taskId,
        contextId: record.contextId,
        fromAgentId: record.fromAgentId,
        toAgentId: record.toAgentId,
        state: record.state,
        messageType: record.messageType,
        summary: record.summary,
        payload: record.payload,
        responseText: record.responseText,
        responsePayload: record.responsePayload,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        completedAt: record.completedAt,
      });
    },

    update(taskId, fields: TaskUpdateFields) {
      const sets: string[] = [];
      const values: Record<string, unknown> = { taskId };

      if (fields.state !== undefined) {
        sets.push("state = @state");
        values.state = fields.state;
      }
      if (fields.responseText !== undefined) {
        sets.push("responseText = @responseText");
        values.responseText = fields.responseText;
      }
      if (fields.responsePayload !== undefined) {
        sets.push("responsePayload = @responsePayload");
        values.responsePayload = fields.responsePayload;
      }
      if (fields.updatedAt !== undefined) {
        sets.push("updatedAt = @updatedAt");
        values.updatedAt = fields.updatedAt;
      }
      if (fields.completedAt !== undefined) {
        sets.push("completedAt = @completedAt");
        values.completedAt = fields.completedAt;
      }

      if (sets.length === 0) return;
      db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE taskId = @taskId`).run(values);
    },

    get(taskId) {
      const row = stmts.get.get(taskId) as TaskRow | undefined;
      return row ? rowToTask(row) : null;
    },

    list(filter?: TaskFilter) {
      const conditions: string[] = [];
      const values: Record<string, unknown> = {};

      if (filter?.taskId) {
        conditions.push("taskId = @taskId");
        values.taskId = filter.taskId;
      }
      if (filter?.fromAgentId) {
        conditions.push("fromAgentId = @fromAgentId");
        values.fromAgentId = filter.fromAgentId;
      }
      if (filter?.toAgentId) {
        conditions.push("toAgentId = @toAgentId");
        values.toAgentId = filter.toAgentId;
      }
      if (filter?.state) {
        conditions.push("state = @state");
        values.state = filter.state;
      }
      if (filter?.messageType) {
        conditions.push("messageType = @messageType");
        values.messageType = filter.messageType;
      }
      if (filter?.since) {
        conditions.push("createdAt >= @since");
        values.since = filter.since;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      if (filter?.limit) {
        values._limit = Math.floor(filter.limit);
      }
      const limitClause = filter?.limit ? "LIMIT @_limit" : "";
      const sql = `SELECT * FROM tasks ${where} ORDER BY createdAt DESC ${limitClause}`;

      const rows = db.prepare(sql).all(values) as TaskRow[];
      return rows.map(rowToTask);
    },

    count(filter?: TaskFilter) {
      const conditions: string[] = [];
      const values: Record<string, unknown> = {};

      if (filter?.fromAgentId) {
        conditions.push("fromAgentId = @fromAgentId");
        values.fromAgentId = filter.fromAgentId;
      }
      if (filter?.toAgentId) {
        conditions.push("toAgentId = @toAgentId");
        values.toAgentId = filter.toAgentId;
      }
      if (filter?.state) {
        conditions.push("state = @state");
        values.state = filter.state;
      }
      if (filter?.messageType) {
        conditions.push("messageType = @messageType");
        values.messageType = filter.messageType;
      }
      if (filter?.since) {
        conditions.push("createdAt >= @since");
        values.since = filter.since;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const sql = `SELECT COUNT(*) as count FROM tasks ${where}`;

      const row = db.prepare(sql).get(values) as CountRow;
      return row.count;
    },
  };
}

// --- Channel store ---

interface ChannelRow {
  channelId: string;
  name: string;
  topic: string;
  createdBy: string;
  members: string;     // JSON array
  archived: number;    // 0 or 1
  createdAt: number;
  updatedAt: number;
}

function safeParseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToChannel(row: ChannelRow): ChannelRecord {
  return {
    channelId: row.channelId,
    name: row.name,
    topic: row.topic,
    createdBy: row.createdBy,
    members: safeParseJsonArray(row.members),
    archived: row.archived === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function createSqliteChannelStore(db: Database.Database): ChannelStore {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO channels (channelId, name, topic, createdBy, members, archived, createdAt, updatedAt)
      VALUES (@channelId, @name, @topic, @createdBy, @members, @archived, @createdAt, @updatedAt)
    `),
    get: db.prepare(`SELECT * FROM channels WHERE channelId = ?`),
    delete: db.prepare(`DELETE FROM channels WHERE channelId = ?`),
  };

  return {
    insert(record) {
      stmts.insert.run({
        channelId: record.channelId,
        name: record.name,
        topic: record.topic,
        createdBy: record.createdBy,
        members: JSON.stringify(record.members),
        archived: record.archived ? 1 : 0,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    },

    update(channelId, fields) {
      const sets: string[] = [];
      const values: Record<string, unknown> = { channelId };

      if (fields.name !== undefined) {
        sets.push("name = @name");
        values.name = fields.name;
      }
      if (fields.topic !== undefined) {
        sets.push("topic = @topic");
        values.topic = fields.topic;
      }
      if (fields.members !== undefined) {
        sets.push("members = @members");
        values.members = JSON.stringify(fields.members);
      }
      if (fields.archived !== undefined) {
        sets.push("archived = @archived");
        values.archived = fields.archived ? 1 : 0;
      }
      if (fields.updatedAt !== undefined) {
        sets.push("updatedAt = @updatedAt");
        values.updatedAt = fields.updatedAt;
      }

      if (sets.length === 0) return;
      db.prepare(`UPDATE channels SET ${sets.join(", ")} WHERE channelId = @channelId`).run(values);
    },

    get(channelId) {
      const row = stmts.get.get(channelId) as ChannelRow | undefined;
      return row ? rowToChannel(row) : null;
    },

    list(filter?: ChannelFilter) {
      const conditions: string[] = [];
      const values: Record<string, unknown> = {};

      if (filter?.channelId) {
        conditions.push("channelId = @channelId");
        values.channelId = filter.channelId;
      }
      if (filter?.createdBy) {
        conditions.push("createdBy = @createdBy");
        values.createdBy = filter.createdBy;
      }
      if (filter?.archived !== undefined) {
        conditions.push("archived = @archived");
        values.archived = filter.archived ? 1 : 0;
      }
      if (filter?.member) {
        // Search JSON array for member presence
        conditions.push("members LIKE @memberPattern");
        values.memberPattern = `%"${filter.member}"%`;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      if (filter?.limit) {
        values._limit = Math.floor(filter.limit);
      }
      const limitClause = filter?.limit ? "LIMIT @_limit" : "";
      const sql = `SELECT * FROM channels ${where} ORDER BY createdAt ASC ${limitClause}`;

      const rows = db.prepare(sql).all(values) as ChannelRow[];
      return rows.map(rowToChannel);
    },

    delete(channelId) {
      stmts.delete.run(channelId);
    },
  };
}

// --- Channel message store ---

function createSqliteChannelMessageStore(db: Database.Database): ChannelMessageStore {
  const stmts = {
    nextSeq: db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 as next FROM channel_messages WHERE channelId = ?`),
    insert: db.prepare(`INSERT INTO channel_messages (channelId, seq, agentId, content, timestamp) VALUES (@channelId, @seq, @agentId, @content, @timestamp)`),
    list: db.prepare(`SELECT * FROM channel_messages WHERE channelId = @channelId AND seq >= @since ORDER BY seq ASC LIMIT @limit`),
    count: db.prepare(`SELECT COUNT(*) as count FROM channel_messages WHERE channelId = ?`),
  };

  return {
    append(msg: Omit<ChannelMessage, "seq">): number {
      const row = stmts.nextSeq.get(msg.channelId) as { next: number };
      const seq = row.next;
      stmts.insert.run({ ...msg, seq });
      return seq;
    },
    list(filter: ChannelMessageFilter): ChannelMessage[] {
      return stmts.list.all({
        channelId: filter.channelId,
        since: filter.since ?? 0,
        limit: filter.limit ?? 1000,
      }) as ChannelMessage[];
    },
    count(channelId: string): number {
      const row = stmts.count.get(channelId) as { count: number };
      return row.count;
    },
  };
}

// --- Agent loop state store ---

interface AgentLoopRow {
  agentId: string;
  state: string;
  lastTickAt: number;
  awakenedAt: number;
  sleptAt: number | null;
  sleepReason: string | null;
}

function rowToAgentLoop(row: AgentLoopRow): AgentLoopRecord {
  return {
    agentId: row.agentId,
    state: (row.state === "AWAKE" || row.state === "SLEEP") ? row.state : "AWAKE",
    lastTickAt: row.lastTickAt,
    awakenedAt: row.awakenedAt,
    sleptAt: row.sleptAt,
    sleepReason: row.sleepReason,
  };
}

function createSqliteAgentLoopStore(db: Database.Database): AgentLoopStore {
  const stmts = {
    get: db.prepare(`SELECT * FROM agent_loop_states WHERE agentId = ?`),
    insert: db.prepare(`
      INSERT OR IGNORE INTO agent_loop_states (agentId, state, lastTickAt, awakenedAt, sleptAt, sleepReason)
      VALUES (@agentId, @state, @lastTickAt, @awakenedAt, @sleptAt, @sleepReason)
    `),
    setState: db.prepare(`
      UPDATE agent_loop_states
      SET state = @state, sleptAt = @sleptAt, sleepReason = @sleepReason, awakenedAt = @awakenedAt
      WHERE agentId = @agentId
    `),
    updateLastTick: db.prepare(`UPDATE agent_loop_states SET lastTickAt = @lastTickAt WHERE agentId = @agentId`),
    listByState: db.prepare(`SELECT * FROM agent_loop_states WHERE state = ?`),
    listAll: db.prepare(`SELECT * FROM agent_loop_states ORDER BY agentId`),
  };

  return {
    init(agentId: string, state: AgentLoopState): void {
      const now = Date.now();
      // INSERT OR IGNORE for new agents
      stmts.insert.run({
        agentId,
        state,
        lastTickAt: now,
        awakenedAt: now,
        sleptAt: null,
        sleepReason: null,
      });
      // Always reset to the requested state on init (handles gateway restart)
      stmts.setState.run({
        agentId,
        state,
        sleptAt: null,
        sleepReason: null,
        awakenedAt: now,
      });
    },

    get(agentId: string): AgentLoopRecord | null {
      const row = stmts.get.get(agentId) as AgentLoopRow | undefined;
      return row ? rowToAgentLoop(row) : null;
    },

    setState(agentId: string, state: AgentLoopState, reason?: string): void {
      const now = Date.now();
      stmts.setState.run({
        agentId,
        state,
        sleptAt: state === "SLEEP" ? now : null,
        sleepReason: state === "SLEEP" ? (reason ?? null) : null,
        awakenedAt: state === "AWAKE" ? now : (stmts.get.get(agentId) as AgentLoopRow | undefined)?.awakenedAt ?? now,
      });
    },

    updateLastTick(agentId: string, timestamp: number): void {
      stmts.updateLastTick.run({ agentId, lastTickAt: timestamp });
    },

    listByState(state: AgentLoopState): AgentLoopRecord[] {
      const rows = stmts.listByState.all(state) as AgentLoopRow[];
      return rows.map(rowToAgentLoop);
    },

    listAll(): AgentLoopRecord[] {
      const rows = stmts.listAll.all() as AgentLoopRow[];
      return rows.map(rowToAgentLoop);
    },
  };
}

// --- Database factory ---

export function createSqliteDatabase(dataDir: string): FlockDatabase {
  // Ensure data directory exists
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, "flock.db");
  const db = new Database(dbPath);

  // Performance pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  let homes: HomeStore | null = null;
  let transitions: TransitionStore | null = null;
  let audit: AuditStore | null = null;
  let tasks: TaskStore | null = null;
  let channels: ChannelStore | null = null;
  let channelMessages: ChannelMessageStore | null = null;
  let agentLoop: AgentLoopStore | null = null;

  return {
    backend: "sqlite",

    get homes() {
      if (!homes) homes = createSqliteHomeStore(db);
      return homes;
    },
    get transitions() {
      if (!transitions) transitions = createSqliteTransitionStore(db);
      return transitions;
    },
    get audit() {
      if (!audit) audit = createSqliteAuditStore(db);
      return audit;
    },
    get tasks() {
      if (!tasks) tasks = createSqliteTaskStore(db);
      return tasks;
    },
    get channels() {
      if (!channels) channels = createSqliteChannelStore(db);
      return channels;
    },
    get channelMessages() {
      if (!channelMessages) channelMessages = createSqliteChannelMessageStore(db);
      return channelMessages;
    },
    get agentLoop() {
      if (!agentLoop) agentLoop = createSqliteAgentLoopStore(db);
      return agentLoop;
    },

    migrate() {
      db.exec(SCHEMA_SQL);
      homes = null;
      transitions = null;
      audit = null;
      tasks = null;
      channels = null;
      channelMessages = null;
      agentLoop = null;
    },

    close() {
      db.close();
    },
  };
}
