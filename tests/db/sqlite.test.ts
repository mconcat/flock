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

  describe("ChannelStore", () => {
    it("inserts and retrieves a channel", () => {
      db.channels.insert({
        channelId: "project-logging",
        name: "project-logging",
        topic: "TypeScript structured logging library",
        createdBy: "pm-alpha",
        members: ["pm-alpha", "dev-code", "qa-tester"],
        archived: false,
        archiveReadyMembers: [],
        archivingStartedAt: null,
        createdAt: 1000,
        updatedAt: 1000,
      });

      const ch = db.channels.get("project-logging");
      expect(ch).not.toBeNull();
      expect(ch!.channelId).toBe("project-logging");
      expect(ch!.topic).toBe("TypeScript structured logging library");
      expect(ch!.members).toEqual(["pm-alpha", "dev-code", "qa-tester"]);
      expect(ch!.archived).toBe(false);
    });

    it("updates fields", () => {
      db.channels.insert({
        channelId: "ch-1",
        name: "ch-1",
        topic: "original topic",
        createdBy: "a",
        members: ["a", "b"],
        archived: false,
        archiveReadyMembers: [],
        archivingStartedAt: null,
        createdAt: 1000,
        updatedAt: 1000,
      });

      db.channels.update("ch-1", {
        topic: "updated topic",
        members: ["a", "b", "c"],
        archived: true,
        updatedAt: 2000,
      });

      const ch = db.channels.get("ch-1");
      expect(ch!.topic).toBe("updated topic");
      expect(ch!.members).toEqual(["a", "b", "c"]);
      expect(ch!.archived).toBe(true);
      expect(ch!.updatedAt).toBe(2000);
    });

    it("lists with filters", () => {
      db.channels.insert({ channelId: "ch-1", name: "ch-1", topic: "t1", createdBy: "a", members: ["a", "b"], archived: false, archiveReadyMembers: [], archivingStartedAt: null, createdAt: 1, updatedAt: 1 });
      db.channels.insert({ channelId: "ch-2", name: "ch-2", topic: "t2", createdBy: "b", members: ["b", "c"], archived: false, archiveReadyMembers: [], archivingStartedAt: null, createdAt: 2, updatedAt: 2 });
      db.channels.insert({ channelId: "ch-3", name: "ch-3", topic: "t3", createdBy: "a", members: ["a"], archived: true, archiveReadyMembers: [], archivingStartedAt: null, createdAt: 3, updatedAt: 3 });

      expect(db.channels.list()).toHaveLength(3);
      expect(db.channels.list({ createdBy: "a" })).toHaveLength(2);
      expect(db.channels.list({ archived: false })).toHaveLength(2);
      expect(db.channels.list({ archived: true })).toHaveLength(1);
      expect(db.channels.list({ member: "a" })).toHaveLength(2);
      expect(db.channels.list({ member: "b" })).toHaveLength(2);
      expect(db.channels.list({ member: "c" })).toHaveLength(1);
      expect(db.channels.list({ limit: 1 })).toHaveLength(1);
    });

    it("deletes a channel", () => {
      db.channels.insert({ channelId: "ch-1", name: "ch-1", topic: "t", createdBy: "a", members: ["a"], archived: false, archiveReadyMembers: [], archivingStartedAt: null, createdAt: 1, updatedAt: 1 });
      db.channels.delete("ch-1");
      expect(db.channels.get("ch-1")).toBeNull();
    });
  });

  describe("ChannelMessageStore", () => {
    it("appends and lists messages", () => {
      const seq1 = db.channelMessages.append({ channelId: "ch-1", agentId: "a", content: "hello", timestamp: 100 });
      const seq2 = db.channelMessages.append({ channelId: "ch-1", agentId: "b", content: "hi", timestamp: 200 });
      const seq3 = db.channelMessages.append({ channelId: "ch-1", agentId: "a", content: "bye", timestamp: 300 });

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(seq3).toBe(3);

      const msgs = db.channelMessages.list({ channelId: "ch-1" });
      expect(msgs).toHaveLength(3);
      expect(msgs[0].agentId).toBe("a");
      expect(msgs[0].content).toBe("hello");
      expect(msgs[2].seq).toBe(3);
    });

    it("supports delta reading with since", () => {
      db.channelMessages.append({ channelId: "ch-1", agentId: "a", content: "m1", timestamp: 100 });
      db.channelMessages.append({ channelId: "ch-1", agentId: "b", content: "m2", timestamp: 200 });
      db.channelMessages.append({ channelId: "ch-1", agentId: "a", content: "m3", timestamp: 300 });

      const delta = db.channelMessages.list({ channelId: "ch-1", since: 3 });
      expect(delta).toHaveLength(1);
      expect(delta[0].content).toBe("m3");
    });

    it("counts messages per channel", () => {
      db.channelMessages.append({ channelId: "ch-1", agentId: "a", content: "m1", timestamp: 100 });
      db.channelMessages.append({ channelId: "ch-1", agentId: "b", content: "m2", timestamp: 200 });
      db.channelMessages.append({ channelId: "ch-2", agentId: "a", content: "m3", timestamp: 300 });

      expect(db.channelMessages.count("ch-1")).toBe(2);
      expect(db.channelMessages.count("ch-2")).toBe(1);
      expect(db.channelMessages.count("ch-nonexistent")).toBe(0);
    });

    it("isolates messages across channels", () => {
      db.channelMessages.append({ channelId: "ch-1", agentId: "a", content: "in ch-1", timestamp: 100 });
      db.channelMessages.append({ channelId: "ch-2", agentId: "b", content: "in ch-2", timestamp: 200 });

      const ch1 = db.channelMessages.list({ channelId: "ch-1" });
      const ch2 = db.channelMessages.list({ channelId: "ch-2" });

      expect(ch1).toHaveLength(1);
      expect(ch1[0].content).toBe("in ch-1");
      expect(ch2).toHaveLength(1);
      expect(ch2[0].content).toBe("in ch-2");
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

  describe("AgentLoopStore", () => {
    it("initializes agent with AWAKE state", () => {
      db.agentLoop.init("agent-1", "AWAKE");
      const record = db.agentLoop.get("agent-1");
      expect(record).not.toBeNull();
      expect(record!.state).toBe("AWAKE");
      expect(record!.sleptAt).toBeNull();
    });

    it("initializes agent with REACTIVE state", () => {
      db.agentLoop.init("sysadmin", "REACTIVE");
      const record = db.agentLoop.get("sysadmin");
      expect(record).not.toBeNull();
      expect(record!.state).toBe("REACTIVE");
    });

    it("setState to REACTIVE sets sleptAt and preserves awakenedAt", () => {
      db.agentLoop.init("agent-1", "AWAKE");
      const before = db.agentLoop.get("agent-1")!;
      const originalAwakenedAt = before.awakenedAt;

      db.agentLoop.setState("agent-1", "REACTIVE", "sysadmin mode");
      const after = db.agentLoop.get("agent-1")!;
      expect(after.state).toBe("REACTIVE");
      expect(after.sleptAt).not.toBeNull();
      expect(after.sleepReason).toBe("sysadmin mode");
      expect(after.awakenedAt).toBe(originalAwakenedAt);
    });

    it("setState from REACTIVE to AWAKE clears sleptAt", () => {
      db.agentLoop.init("agent-1", "REACTIVE");
      db.agentLoop.setState("agent-1", "AWAKE");
      const record = db.agentLoop.get("agent-1")!;
      expect(record.state).toBe("AWAKE");
      expect(record.sleptAt).toBeNull();
      expect(record.sleepReason).toBeNull();
    });

    it("listByState returns only agents in requested state", () => {
      db.agentLoop.init("worker-1", "AWAKE");
      db.agentLoop.init("worker-2", "AWAKE");
      db.agentLoop.init("sysadmin", "REACTIVE");
      db.agentLoop.setState("worker-2", "SLEEP");

      const awake = db.agentLoop.listByState("AWAKE");
      expect(awake.map(r => r.agentId)).toEqual(["worker-1"]);

      const sleeping = db.agentLoop.listByState("SLEEP");
      expect(sleeping.map(r => r.agentId)).toEqual(["worker-2"]);

      const reactive = db.agentLoop.listByState("REACTIVE");
      expect(reactive.map(r => r.agentId)).toEqual(["sysadmin"]);
    });

    it("REACTIVE agents are excluded from AWAKE and SLEEP lists", () => {
      db.agentLoop.init("sysadmin", "REACTIVE");

      expect(db.agentLoop.listByState("AWAKE")).toHaveLength(0);
      expect(db.agentLoop.listByState("SLEEP")).toHaveLength(0);
      expect(db.agentLoop.listByState("REACTIVE")).toHaveLength(1);
    });

    it("listAll includes all states", () => {
      db.agentLoop.init("worker", "AWAKE");
      db.agentLoop.init("sysadmin", "REACTIVE");

      const all = db.agentLoop.listAll();
      expect(all).toHaveLength(2);
      expect(all.map(r => r.state).sort()).toEqual(["AWAKE", "REACTIVE"]);
    });
  });
});
