import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqliteDatabase } from "../../src/db/sqlite.js";
import type { FlockDatabase } from "../../src/db/interface.js";

describe("SQLite Backend", () => {
  let db: FlockDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flock-test-"));
    db = createSqliteDatabase(tmpDir);
    db.migrate();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("HomeStore", () => {
    it("inserts and retrieves a home", () => {
      db.homes.insert({
        homeId: "a@n",
        agentId: "a",
        nodeId: "n",
        state: "UNASSIGNED",
        leaseExpiresAt: null,
        metadata: { tier: 1 },
        createdAt: 1000,
        updatedAt: 1000,
      });

      const home = db.homes.get("a@n");
      expect(home).not.toBeNull();
      expect(home!.agentId).toBe("a");
      expect(home!.state).toBe("UNASSIGNED");
      expect(home!.metadata).toEqual({ tier: 1 });
    });

    it("updates fields", () => {
      db.homes.insert({
        homeId: "a@n",
        agentId: "a",
        nodeId: "n",
        state: "UNASSIGNED",
        leaseExpiresAt: null,
        metadata: {},
        createdAt: 1000,
        updatedAt: 1000,
      });

      db.homes.update("a@n", { state: "LEASED", leaseExpiresAt: 9999, updatedAt: 2000 });

      const home = db.homes.get("a@n");
      expect(home!.state).toBe("LEASED");
      expect(home!.leaseExpiresAt).toBe(9999);
      expect(home!.updatedAt).toBe(2000);
    });

    it("lists with filters", () => {
      db.homes.insert({ homeId: "a@n1", agentId: "a", nodeId: "n1", state: "IDLE", leaseExpiresAt: null, metadata: {}, createdAt: 1, updatedAt: 1 });
      db.homes.insert({ homeId: "b@n1", agentId: "b", nodeId: "n1", state: "LEASED", leaseExpiresAt: null, metadata: {}, createdAt: 2, updatedAt: 2 });
      db.homes.insert({ homeId: "c@n2", agentId: "c", nodeId: "n2", state: "IDLE", leaseExpiresAt: null, metadata: {}, createdAt: 3, updatedAt: 3 });

      expect(db.homes.list()).toHaveLength(3);
      expect(db.homes.list({ nodeId: "n1" })).toHaveLength(2);
      expect(db.homes.list({ state: "IDLE" })).toHaveLength(2);
      expect(db.homes.list({ nodeId: "n1", state: "IDLE" })).toHaveLength(1);
      expect(db.homes.list({ limit: 2 })).toHaveLength(2);
    });

    it("deletes a home", () => {
      db.homes.insert({ homeId: "a@n", agentId: "a", nodeId: "n", state: "IDLE", leaseExpiresAt: null, metadata: {}, createdAt: 1, updatedAt: 1 });
      db.homes.delete("a@n");
      expect(db.homes.get("a@n")).toBeNull();
    });
  });

  describe("TransitionStore", () => {
    it("inserts and lists transitions", () => {
      db.transitions.insert({ homeId: "a@n", fromState: "UNASSIGNED", toState: "PROVISIONING", reason: "setup", triggeredBy: "system", timestamp: 100 });
      db.transitions.insert({ homeId: "a@n", fromState: "PROVISIONING", toState: "IDLE", reason: "done", triggeredBy: "system", timestamp: 200 });
      db.transitions.insert({ homeId: "b@n", fromState: "UNASSIGNED", toState: "PROVISIONING", reason: "setup", triggeredBy: "system", timestamp: 300 });

      expect(db.transitions.list()).toHaveLength(3);
      expect(db.transitions.list({ homeId: "a@n" })).toHaveLength(2);
      expect(db.transitions.list({ since: 150 })).toHaveLength(2);
      expect(db.transitions.list({ limit: 1 })).toHaveLength(1);
    });
  });

  describe("AuditStore", () => {
    it("inserts and queries audit entries", () => {
      db.audit.insert({ id: "1", timestamp: 100, agentId: "a", action: "home.create", level: "GREEN", detail: "created" });
      db.audit.insert({ id: "2", timestamp: 200, agentId: "a", action: "home.transition", level: "YELLOW", detail: "frozen" });
      db.audit.insert({ id: "3", timestamp: 300, agentId: "b", action: "home.create", level: "GREEN", detail: "created" });

      expect(db.audit.query()).toHaveLength(3);
      expect(db.audit.query({ agentId: "a" })).toHaveLength(2);
      expect(db.audit.query({ level: "GREEN" })).toHaveLength(2);
      expect(db.audit.query({ level: "YELLOW" })).toHaveLength(1);
      expect(db.audit.count()).toBe(3);
      expect(db.audit.count({ agentId: "a" })).toBe(2);
    });
  });

  describe("Persistence", () => {
    it("survives close and reopen", () => {
      db.homes.insert({ homeId: "a@n", agentId: "a", nodeId: "n", state: "ACTIVE", leaseExpiresAt: null, metadata: {}, createdAt: 1, updatedAt: 1 });
      db.audit.insert({ id: "1", timestamp: 100, agentId: "a", action: "test", level: "GREEN", detail: "test" });

      db.close();

      // Reopen
      const db2 = createSqliteDatabase(tmpDir);
      db2.migrate();

      expect(db2.homes.get("a@n")).not.toBeNull();
      expect(db2.homes.get("a@n")!.state).toBe("ACTIVE");
      expect(db2.audit.count()).toBe(1);

      db2.close();
    });
  });
});
