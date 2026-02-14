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
  TaskUpdateFields,
  AgentLoopStore,
  AgentLoopRecord,
  AgentLoopState,
  BridgeStore,
  BridgeMapping,
  BridgePlatform,
  BridgeFilter,
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

function createMemoryChannelStore(): ChannelStore {
  const store = new Map<string, ChannelRecord>();

  return {
    insert(record) {
      store.set(record.channelId, {
        ...record,
        members: [...record.members],
        archiveReadyMembers: [...record.archiveReadyMembers],
      });
    },
    update(channelId, fields) {
      const existing = store.get(channelId);
      if (!existing) throw new Error(`channel not found: ${channelId}`);
      if (fields.name !== undefined) existing.name = fields.name;
      if (fields.topic !== undefined) existing.topic = fields.topic;
      if (fields.members !== undefined) existing.members = [...fields.members];
      if (fields.archived !== undefined) existing.archived = fields.archived;
      if (fields.archiveReadyMembers !== undefined) existing.archiveReadyMembers = [...fields.archiveReadyMembers];
      if (fields.archivingStartedAt !== undefined) existing.archivingStartedAt = fields.archivingStartedAt;
      if (fields.updatedAt !== undefined) existing.updatedAt = fields.updatedAt;
    },
    get(channelId) {
      const record = store.get(channelId);
      return record
        ? { ...record, members: [...record.members], archiveReadyMembers: [...record.archiveReadyMembers] }
        : null;
    },
    list(filter?: ChannelFilter) {
      let results = Array.from(store.values());
      if (filter?.channelId) results = results.filter(r => r.channelId === filter.channelId);
      if (filter?.createdBy) results = results.filter(r => r.createdBy === filter.createdBy);
      if (filter?.archived !== undefined) results = results.filter(r => r.archived === filter.archived);
      if (filter?.member) results = results.filter(r => r.members.includes(filter.member!));
      if (filter?.limit) results = results.slice(0, filter.limit);
      return results.map(r => ({ ...r, members: [...r.members], archiveReadyMembers: [...r.archiveReadyMembers] }));
    },
    delete(channelId) {
      store.delete(channelId);
    },
  };
}

function createMemoryChannelMessageStore(): ChannelMessageStore {
  const channels = new Map<string, ChannelMessage[]>();

  return {
    append(msg: Omit<ChannelMessage, "seq">): number {
      const list = channels.get(msg.channelId) ?? [];
      const seq = list.length + 1;
      list.push({ ...msg, seq });
      channels.set(msg.channelId, list);
      return seq;
    },
    list(filter: ChannelMessageFilter): ChannelMessage[] {
      const list = channels.get(filter.channelId) ?? [];
      const since = filter.since ?? 0;
      const limit = filter.limit ?? 1000;
      return list.filter(m => m.seq >= since).slice(0, limit);
    },
    count(channelId: string): number {
      return (channels.get(channelId) ?? []).length;
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
      if (state === "SLEEP" || state === "REACTIVE") {
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

function createMemoryBridgeStore(): BridgeStore {
  const store = new Map<string, BridgeMapping>();

  return {
    insert(record) {
      store.set(record.bridgeId, { ...record });
    },
    get(bridgeId) {
      const record = store.get(bridgeId);
      return record ? { ...record } : null;
    },
    getByChannel(channelId) {
      return Array.from(store.values())
        .filter(r => r.channelId === channelId && r.active)
        .map(r => ({ ...r }));
    },
    getByExternal(platform: BridgePlatform, externalChannelId: string) {
      for (const r of store.values()) {
        if (r.platform === platform && r.externalChannelId === externalChannelId) {
          return { ...r };
        }
      }
      return null;
    },
    list(filter?: BridgeFilter) {
      let results = Array.from(store.values());
      if (filter?.channelId) results = results.filter(r => r.channelId === filter.channelId);
      if (filter?.platform) results = results.filter(r => r.platform === filter.platform);
      if (filter?.active !== undefined) results = results.filter(r => r.active === filter.active);
      if (filter?.limit) results = results.slice(0, filter.limit);
      return results.map(r => ({ ...r }));
    },
    update(bridgeId, fields) {
      const existing = store.get(bridgeId);
      if (!existing) throw new Error(`bridge not found: ${bridgeId}`);
      if (fields.active !== undefined) existing.active = fields.active;
      if (fields.webhookUrl !== undefined) existing.webhookUrl = fields.webhookUrl;
    },
    delete(bridgeId) {
      store.delete(bridgeId);
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
    channels: createMemoryChannelStore(),
    channelMessages: createMemoryChannelMessageStore(),
    agentLoop: createMemoryAgentLoopStore(),
    bridges: createMemoryBridgeStore(),
    migrate() { /* no-op */ },
    close() { /* no-op */ },
  };
}
