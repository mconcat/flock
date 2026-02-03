import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createMemoryDatabase } from "../../src/db/memory.js";
import { createSqliteDatabase } from "../../src/db/sqlite.js";
import type { FlockDatabase } from "../../src/db/interface.js";
import type { HomeRecord, HomeTransition, AuditEntry } from "../../src/types.js";

function makeHome(overrides: Partial<HomeRecord> = {}): HomeRecord {
  const now = Date.now();
  return {
    homeId: "agent-1@node-1",
    agentId: "agent-1",
    nodeId: "node-1",
    state: "UNASSIGNED",
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    metadata: {},
    ...overrides,
  };
}

function makeTransition(overrides: Partial<HomeTransition> = {}): HomeTransition {
  return {
    homeId: "agent-1@node-1",
    fromState: "UNASSIGNED",
    toState: "PROVISIONING",
    reason: "starting",
    triggeredBy: "system",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeAudit(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    agentId: "agent-1",
    action: "test.action",
    level: "GREEN",
    detail: "Test audit entry",
    ...overrides,
  };
}

// Parameterized tests for both backends
describe.each([
  { name: "Memory", createDb: () => ({ db: createMemoryDatabase(), cleanup: () => {} }) },
  {
    name: "SQLite",
    createDb: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flock-db-test-"));
      const db = createSqliteDatabase(tmpDir);
      db.migrate();
      return { db, cleanup: () => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } };
    },
  },
])("$name backend", ({ createDb }) => {
  let db: FlockDatabase;
  let cleanup: () => void;

  beforeEach(() => {
    const result = createDb();
    db = result.db;
    cleanup = result.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  describe("HomeStore", () => {
    it("insert and get", () => {
      const home = makeHome();
      db.homes.insert(home);

      const retrieved = db.homes.get("agent-1@node-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.homeId).toBe("agent-1@node-1");
      expect(retrieved!.agentId).toBe("agent-1");
      expect(retrieved!.state).toBe("UNASSIGNED");
    });

    it("get returns null for nonexistent", () => {
      expect(db.homes.get("nonexistent")).toBeNull();
    });

    it("update state", () => {
      db.homes.insert(makeHome());
      db.homes.update("agent-1@node-1", { state: "PROVISIONING", updatedAt: Date.now() });

      const updated = db.homes.get("agent-1@node-1");
      expect(updated!.state).toBe("PROVISIONING");
    });

    it("update leaseExpiresAt", () => {
      db.homes.insert(makeHome());
      const expiry = Date.now() + 60000;
      db.homes.update("agent-1@node-1", { leaseExpiresAt: expiry });

      const updated = db.homes.get("agent-1@node-1");
      expect(updated!.leaseExpiresAt).toBe(expiry);
    });

    it("list all homes", () => {
      db.homes.insert(makeHome({ homeId: "a1@n1", agentId: "a1" }));
      db.homes.insert(makeHome({ homeId: "a2@n1", agentId: "a2" }));
      db.homes.insert(makeHome({ homeId: "a3@n2", agentId: "a3", nodeId: "n2" }));

      const all = db.homes.list();
      expect(all).toHaveLength(3);
    });

    it("list with nodeId filter", () => {
      db.homes.insert(makeHome({ homeId: "a1@n1", agentId: "a1", nodeId: "n1" }));
      db.homes.insert(makeHome({ homeId: "a2@n2", agentId: "a2", nodeId: "n2" }));

      const filtered = db.homes.list({ nodeId: "n1" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].nodeId).toBe("n1");
    });

    it("list with state filter", () => {
      db.homes.insert(makeHome({ homeId: "a1@n1", agentId: "a1", state: "IDLE" }));
      db.homes.insert(makeHome({ homeId: "a2@n1", agentId: "a2", state: "UNASSIGNED" }));

      const idle = db.homes.list({ state: "IDLE" });
      expect(idle).toHaveLength(1);
      expect(idle[0].state).toBe("IDLE");
    });

    it("delete home", () => {
      db.homes.insert(makeHome());
      db.homes.delete("agent-1@node-1");
      expect(db.homes.get("agent-1@node-1")).toBeNull();
    });
  });

  describe("TransitionStore", () => {
    it("insert and list transitions", () => {
      db.transitions.insert(makeTransition({ timestamp: 1000 }));
      db.transitions.insert(makeTransition({
        fromState: "PROVISIONING",
        toState: "IDLE",
        reason: "ready",
        timestamp: 2000,
      }));

      const all = db.transitions.list();
      expect(all).toHaveLength(2);
    });

    it("list with homeId filter", () => {
      db.transitions.insert(makeTransition({ homeId: "a1@n1", timestamp: 1000 }));
      db.transitions.insert(makeTransition({ homeId: "a2@n1", timestamp: 2000 }));

      const filtered = db.transitions.list({ homeId: "a1@n1" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].homeId).toBe("a1@n1");
    });

    it("list with since filter", () => {
      db.transitions.insert(makeTransition({ timestamp: 1000 }));
      db.transitions.insert(makeTransition({ timestamp: 2000 }));
      db.transitions.insert(makeTransition({ timestamp: 3000 }));

      const recent = db.transitions.list({ since: 2000 });
      expect(recent.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("AuditStore", () => {
    it("insert and query", () => {
      const entry = makeAudit();
      db.audit.insert(entry);

      const results = db.audit.query();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(entry.id);
    });

    it("query with agentId filter", () => {
      db.audit.insert(makeAudit({ id: "a1", agentId: "agent-1" }));
      db.audit.insert(makeAudit({ id: "a2", agentId: "agent-2" }));

      const filtered = db.audit.query({ agentId: "agent-1" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].agentId).toBe("agent-1");
    });

    it("query with level filter", () => {
      db.audit.insert(makeAudit({ id: "a1", level: "GREEN" }));
      db.audit.insert(makeAudit({ id: "a2", level: "RED" }));

      const reds = db.audit.query({ level: "RED" });
      expect(reds).toHaveLength(1);
      expect(reds[0].level).toBe("RED");
    });

    it("count with no filter", () => {
      db.audit.insert(makeAudit({ id: "a1" }));
      db.audit.insert(makeAudit({ id: "a2" }));
      db.audit.insert(makeAudit({ id: "a3" }));

      expect(db.audit.count()).toBe(3);
    });

    it("count with filter", () => {
      db.audit.insert(makeAudit({ id: "a1", level: "GREEN" }));
      db.audit.insert(makeAudit({ id: "a2", level: "RED" }));
      db.audit.insert(makeAudit({ id: "a3", level: "GREEN" }));

      expect(db.audit.count({ level: "RED" })).toBe(1);
      expect(db.audit.count({ level: "GREEN" })).toBe(2);
    });

    it("count returns 0 for empty store", () => {
      expect(db.audit.count()).toBe(0);
    });
  });
});
