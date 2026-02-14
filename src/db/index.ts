/**
 * Database factory — creates the appropriate backend based on config.
 */

export type { FlockDatabase, HomeStore, TransitionStore, AuditStore, TaskStore, ChannelStore, ChannelRecord, ChannelFilter, ChannelMessageStore, ChannelMessage, ChannelMessageFilter, HomeFilter, TransitionFilter, AuditFilter, TaskFilter, TaskRecord, TaskState, TaskUpdateFields, AgentLoopStore, AgentLoopRecord, AgentLoopState, BridgeStore, BridgeMapping, BridgePlatform, BridgeFilter } from "./interface.js";
export { TASK_STATES, isTaskState } from "./interface.js";
export { createMemoryDatabase } from "./memory.js";
export { createSqliteDatabase } from "./sqlite.js";
export type { DatabaseBackend } from "../config.js";

import type { FlockConfig } from "../config.js";
import type { FlockDatabase } from "./interface.js";
import { createMemoryDatabase } from "./memory.js";
import { createSqliteDatabase } from "./sqlite.js";

export function createDatabase(config: FlockConfig): FlockDatabase {
  const backend = config.dbBackend ?? "memory";

  switch (backend) {
    case "memory":
      return createMemoryDatabase();

    case "sqlite":
      return createSqliteDatabase(config.dataDir);

    case "postgres":
      // TODO: import { createPostgresDatabase } from "./postgres.js"
      throw new Error("postgres backend not yet implemented");

    default:
      throw new Error(`unknown database backend: ${backend}`);
  }
}
