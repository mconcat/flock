/**
 * Audit Log — thin wrapper over the database audit store.
 *
 * Provides the same interface as before but delegates to FlockDatabase.
 * Adds RED-level warning logging.
 */

import type { AuditEntry, PluginLogger } from "../types.js";
import type { FlockDatabase, AuditFilter } from "../db/index.js";

export interface AuditLog {
  append(entry: AuditEntry): void;
  query(filter: AuditFilter): AuditEntry[];
  recent(limit?: number): AuditEntry[];
  count(): number;
}

interface AuditLogParams {
  db: FlockDatabase;
  logger: PluginLogger;
}

export function createAuditLog(params: AuditLogParams): AuditLog {
  const { db, logger } = params;

  function append(entry: AuditEntry): void {
    db.audit.insert(entry);

    if (entry.level === "RED") {
      logger.warn(`[flock:audit] RED: ${entry.action} by ${entry.agentId} — ${entry.detail}`);
    }
  }

  function query(filter: AuditFilter): AuditEntry[] {
    return db.audit.query(filter);
  }

  function recent(limit = 50): AuditEntry[] {
    return db.audit.query({ limit });
  }

  function count(): number {
    return db.audit.count();
  }

  return { append, query, recent, count };
}
