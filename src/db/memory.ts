/**
 * In-memory database backend.
 * For testing and development. No persistence.
 */

import type {
  HomeRecord,
  HomeTransition,
  AuditEntry,
} from "../types.js";
import type {
  FlockDatabase,
  HomeStore,
  TransitionStore,
  AuditStore,
  TaskStore,
  ThreadMessageStore,
  ThreadMessage,
  ThreadMessageFilter,
  HomeFilter,
  TransitionFilter,
  AuditFilter,
  TaskFilter,
  TaskRecord,
  TaskUpdateFields,
  AgentLoopStore,
  AgentLoopRecord,
  AgentLoopState,
} from "./interface.js";

function matchesFilter<T>(record: T, filter: object | undefined): boolean {
  if (!filter) return true;
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null) continue;
    if (key === "limit" || key === "since") continue;
    if ((record as Record<string, unknown>)[key] !== value) return false;
  }
  return true;
}

function applyTimestamp<T extends { timestamp: number }>(
  records: T[],
  since?: number,
): T[] {
  if (!since) return records;
  return records.filter((r) => r.timestamp >= since);
}

function applyLimit<T>(records: T[], limit?: number): T[] {
  if (!limit) return records;
  return records.slice(-limit);
}

function createMemoryHomeStore(): HomeStore {
  const store = new Map<string, HomeRecord>();

  return {
    insert(record) {
      store.set(record.homeId, { ...record });
    },
    update(homeId, fields) {
      const existing = store.get(homeId);
      if (!existing) throw new Error(`home not found: ${homeId}`);
      Object.assign(existing, fields);
    },
    get(homeId) {
      const record = store.get(homeId);
      return record ? { ...record } : null;
    },
    list(filter?: HomeFilter) {
      let results = Array.from(store.values());
      results = results.filter((r) => matchesFilter(r, filter));
      return applyLimit(results, filter?.limit);
    },
    delete(homeId) {
      store.delete(homeId);
    },
  };
}

function createMemoryTransitionStore(): TransitionStore {
  const entries: HomeTransition[] = [];

  return {
    insert(entry) {
      entries.push({ ...entry });
    },
    list(filter?: TransitionFilter) {
      let results = entries.filter((r) => matchesFilter(r, filter));
      results = applyTimestamp(results, filter?.since);
      return applyLimit(results, filter?.limit);
    },
  };
}

function createMemoryAuditStore(): AuditStore {
  const entries: AuditEntry[] = [];

  return {
    insert(entry) {
      entries.push({ ...entry });
    },
    query(filter?: AuditFilter) {
      let results = entries.filter((r) => matchesFilter(r, filter));
      results = applyTimestamp(results, filter?.since);
      return applyLimit(results, filter?.limit);
    },
    count(filter?: AuditFilter) {
      if (!filter) return entries.length;
      return entries.filter((r) => matchesFilter(r, filter)).length;
    },
  };
}

function createMemoryTaskStore(): TaskStore {
  const store = new Map<string, TaskRecord>();

  return {
    insert(record) {
      store.set(record.taskId, { ...record });
    },
    update(taskId, fields: TaskUpdateFields) {
      const existing = store.get(taskId);
      if (!existing) throw new Error(`task not found: ${taskId}`);
      if (fields.state !== undefined) existing.state = fields.state;
      if (fields.responseText !== undefined) existing.responseText = fields.responseText;
      if (fields.responsePayload !== undefined) existing.responsePayload = fields.responsePayload;
      if (fields.updatedAt !== undefined) existing.updatedAt = fields.updatedAt;
      if (fields.completedAt !== undefined) existing.completedAt = fields.completedAt;
    },
    get(taskId) {
      const record = store.get(taskId);
      return record ? { ...record } : null;
    },
    list(filter?: TaskFilter) {
      let results = Array.from(store.values());
      results = results.filter((r) => matchesFilter(r, filter));
      if (filter?.since) {
        results = results.filter((r) => r.createdAt >= filter.since!);
      }
      // Sort by createdAt descending (newest first)
      results.sort((a, b) => b.createdAt - a.createdAt);
      if (filter?.limit) {
        return results.slice(0, filter.limit);
      }
      return results;
    },
    count(filter?: TaskFilter) {
      if (!filter) return store.size;
      let results = Array.from(store.values());
      results = results.filter((r) => matchesFilter(r, filter));
      if (filter.since) {
        results = results.filter((r) => r.createdAt >= filter.since!);
      }
      return results.length;
    },
  };
}

function createMemoryThreadMessageStore(): ThreadMessageStore {
  const threads = new Map<string, ThreadMessage[]>();

  return {
    append(msg: Omit<ThreadMessage, "seq">): number {
      const list = threads.get(msg.threadId) ?? [];
      const seq = list.length + 1;
      list.push({ ...msg, seq });
      threads.set(msg.threadId, list);
      return seq;
    },
    list(filter: ThreadMessageFilter): ThreadMessage[] {
      const list = threads.get(filter.threadId) ?? [];
      const since = filter.since ?? 0;
      const limit = filter.limit ?? 1000;
      return list.filter(m => m.seq >= since).slice(0, limit);
    },
    count(threadId: string): number {
      return (threads.get(threadId) ?? []).length;
    },
  };
}

function createMemoryAgentLoopStore(): AgentLoopStore {
  const store = new Map<string, AgentLoopRecord>();

  return {
    init(agentId: string, state: AgentLoopState): void {
      const now = Date.now();
      // Always reset to requested state on init (handles restart)
      store.set(agentId, {
        agentId,
        state,
        lastTickAt: now,
        awakenedAt: now,
        sleptAt: null,
        sleepReason: null,
      });
    },

    get(agentId: string): AgentLoopRecord | null {
      const record = store.get(agentId);
      return record ? { ...record } : null;
    },

    setState(agentId: string, state: AgentLoopState, reason?: string): void {
      const existing = store.get(agentId);
      if (!existing) return;
      const now = Date.now();
      existing.state = state;
      if (state === "SLEEP") {
        existing.sleptAt = now;
        existing.sleepReason = reason ?? null;
      } else {
        existing.awakenedAt = now;
        existing.sleptAt = null;
        existing.sleepReason = null;
      }
    },

    updateLastTick(agentId: string, timestamp: number): void {
      const existing = store.get(agentId);
      if (existing) existing.lastTickAt = timestamp;
    },

    listByState(state: AgentLoopState): AgentLoopRecord[] {
      return Array.from(store.values()).filter(r => r.state === state);
    },

    listAll(): AgentLoopRecord[] {
      return Array.from(store.values());
    },
  };
}

export function createMemoryDatabase(): FlockDatabase {
  return {
    backend: "memory",
    homes: createMemoryHomeStore(),
    transitions: createMemoryTransitionStore(),
    audit: createMemoryAuditStore(),
    tasks: createMemoryTaskStore(),
    threadMessages: createMemoryThreadMessageStore(),
    agentLoop: createMemoryAgentLoopStore(),
    migrate() { /* no-op */ },
    close() { /* no-op */ },
  };
}
