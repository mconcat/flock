import { describe, it, expect, beforeEach, vi } from "vitest";
import { createAuditLog } from "../../src/audit/log.js";
import { createMemoryDatabase } from "../../src/db/memory.js";
import type { FlockDatabase } from "../../src/db/interface.js";
import type { AuditEntry, PluginLogger } from "../../src/types.js";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    agentId: "agent-1",
    action: "test.action",
    level: "GREEN",
    detail: "Test entry",
    ...overrides,
  };
}

describe("AuditLog", () => {
  let db: FlockDatabase;
  let logger: PluginLogger;

  beforeEach(() => {
    db = createMemoryDatabase();
    logger = makeLogger();
  });

  describe("append()", () => {
    it("inserts an entry", () => {
      const log = createAuditLog({ db, logger });
      const entry = makeEntry();
      log.append(entry);

      expect(log.count()).toBe(1);
    });

    it("inserts multiple entries", () => {
      const log = createAuditLog({ db, logger });
      log.append(makeEntry({ id: "e1" }));
      log.append(makeEntry({ id: "e2" }));
      log.append(makeEntry({ id: "e3" }));

      expect(log.count()).toBe(3);
    });
  });

  describe("query()", () => {
    it("filters by agentId", () => {
      const log = createAuditLog({ db, logger });
      log.append(makeEntry({ id: "e1", agentId: "agent-1" }));
      log.append(makeEntry({ id: "e2", agentId: "agent-2" }));
      log.append(makeEntry({ id: "e3", agentId: "agent-1" }));

      const results = log.query({ agentId: "agent-1" });
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.agentId).toBe("agent-1");
      }
    });

    it("filters by level", () => {
      const log = createAuditLog({ db, logger });
      log.append(makeEntry({ id: "e1", level: "GREEN" }));
      log.append(makeEntry({ id: "e2", level: "YELLOW" }));
      log.append(makeEntry({ id: "e3", level: "RED" }));

      const yellows = log.query({ level: "YELLOW" });
      expect(yellows).toHaveLength(1);
      expect(yellows[0].level).toBe("YELLOW");
    });

    it("filters by homeId", () => {
      const log = createAuditLog({ db, logger });
      log.append(makeEntry({ id: "e1", homeId: "a1@n1" }));
      log.append(makeEntry({ id: "e2", homeId: "a2@n1" }));
      log.append(makeEntry({ id: "e3", homeId: "a1@n1" }));

      const results = log.query({ homeId: "a1@n1" });
      expect(results).toHaveLength(2);
    });
  });

  describe("recent()", () => {
    it("returns N latest entries", () => {
      const log = createAuditLog({ db, logger });
      log.append(makeEntry({ id: "e1", timestamp: 1000 }));
      log.append(makeEntry({ id: "e2", timestamp: 2000 }));
      log.append(makeEntry({ id: "e3", timestamp: 3000 }));
      log.append(makeEntry({ id: "e4", timestamp: 4000 }));
      log.append(makeEntry({ id: "e5", timestamp: 5000 }));

      const recent = log.recent(3);
      expect(recent).toHaveLength(3);
    });

    it("returns all when fewer than limit", () => {
      const log = createAuditLog({ db, logger });
      log.append(makeEntry({ id: "e1" }));
      log.append(makeEntry({ id: "e2" }));

      const recent = log.recent(10);
      expect(recent).toHaveLength(2);
    });
  });

  describe("count()", () => {
    it("returns correct count", () => {
      const log = createAuditLog({ db, logger });
      expect(log.count()).toBe(0);

      log.append(makeEntry({ id: "e1" }));
      expect(log.count()).toBe(1);

      log.append(makeEntry({ id: "e2" }));
      expect(log.count()).toBe(2);
    });
  });

  describe("RED entries", () => {
    it("triggers logger.warn on RED level", () => {
      const log = createAuditLog({ db, logger });
      log.append(makeEntry({ id: "e1", level: "RED", action: "dangerous.action" }));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("RED"),
      );
    });

    it("does not trigger logger.warn on GREEN level", () => {
      const log = createAuditLog({ db, logger });
      log.append(makeEntry({ id: "e1", level: "GREEN" }));

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("does not trigger logger.warn on YELLOW level", () => {
      const log = createAuditLog({ db, logger });
      log.append(makeEntry({ id: "e1", level: "YELLOW" }));

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
