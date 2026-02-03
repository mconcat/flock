/**
 * TaskStore tests — parameterized for Memory and SQLite backends.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createMemoryDatabase } from "../../src/db/memory.js";
import { createSqliteDatabase } from "../../src/db/sqlite.js";
import type { FlockDatabase, TaskRecord, TaskState } from "../../src/db/interface.js";
import { isTaskState, TASK_STATES } from "../../src/db/interface.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = Date.now();
  return {
    taskId: `task-${now}-${Math.random().toString(36).slice(2, 6)}`,
    contextId: `ctx-${now}`,
    fromAgentId: "agent-sender",
    toAgentId: "agent-receiver",
    state: "submitted",
    messageType: "task",
    summary: "Test task",
    payload: JSON.stringify({ type: "task", summary: "Test task" }),
    responseText: null,
    responsePayload: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

describe.each([
  { name: "Memory", createDb: () => ({ db: createMemoryDatabase(), cleanup: () => {} }) },
  {
    name: "SQLite",
    createDb: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flock-task-test-"));
      const db = createSqliteDatabase(tmpDir);
      db.migrate();
      return { db, cleanup: () => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } };
    },
  },
])("$name TaskStore", ({ createDb }) => {
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

  describe("insert and get", () => {
    it("inserts and retrieves a task", () => {
      const task = makeTask({ taskId: "task-123" });
      db.tasks.insert(task);

      const retrieved = db.tasks.get("task-123");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.taskId).toBe("task-123");
      expect(retrieved!.fromAgentId).toBe("agent-sender");
      expect(retrieved!.toAgentId).toBe("agent-receiver");
      expect(retrieved!.state).toBe("submitted");
      expect(retrieved!.messageType).toBe("task");
      expect(retrieved!.summary).toBe("Test task");
    });

    it("returns null for nonexistent task", () => {
      expect(db.tasks.get("nonexistent")).toBeNull();
    });
  });

  describe("update", () => {
    it("updates state", () => {
      db.tasks.insert(makeTask({ taskId: "task-upd" }));
      db.tasks.update("task-upd", { state: "working", updatedAt: Date.now() });

      const updated = db.tasks.get("task-upd");
      expect(updated!.state).toBe("working");
    });

    it("updates responseText and responsePayload", () => {
      db.tasks.insert(makeTask({ taskId: "task-resp" }));
      const now = Date.now();
      db.tasks.update("task-resp", {
        state: "completed",
        responseText: "Done!",
        responsePayload: JSON.stringify({ outcome: "completed", summary: "Done!" }),
        updatedAt: now,
        completedAt: now,
      });

      const updated = db.tasks.get("task-resp");
      expect(updated!.state).toBe("completed");
      expect(updated!.responseText).toBe("Done!");
      expect(updated!.responsePayload).toContain("completed");
      expect(updated!.completedAt).toBe(now);
    });

    it("throws on nonexistent task (memory)", () => {
      // Only memory store throws; SQLite silently no-ops
      if (db.backend === "memory") {
        expect(() => db.tasks.update("nope", { state: "working" })).toThrow("task not found");
      }
    });

    it("no-op when no fields provided", () => {
      db.tasks.insert(makeTask({ taskId: "task-noop" }));
      db.tasks.update("task-noop", {});
      const unchanged = db.tasks.get("task-noop");
      expect(unchanged!.state).toBe("submitted");
    });
  });

  describe("list", () => {
    it("lists all tasks", () => {
      db.tasks.insert(makeTask({ taskId: "t1", createdAt: 1000 }));
      db.tasks.insert(makeTask({ taskId: "t2", createdAt: 2000 }));
      db.tasks.insert(makeTask({ taskId: "t3", createdAt: 3000 }));

      const all = db.tasks.list();
      expect(all).toHaveLength(3);
    });

    it("lists ordered by createdAt descending", () => {
      db.tasks.insert(makeTask({ taskId: "t-old", createdAt: 1000 }));
      db.tasks.insert(makeTask({ taskId: "t-new", createdAt: 3000 }));
      db.tasks.insert(makeTask({ taskId: "t-mid", createdAt: 2000 }));

      const all = db.tasks.list();
      expect(all[0].taskId).toBe("t-new");
      expect(all[1].taskId).toBe("t-mid");
      expect(all[2].taskId).toBe("t-old");
    });

    it("filters by fromAgentId", () => {
      db.tasks.insert(makeTask({ taskId: "t1", fromAgentId: "alice" }));
      db.tasks.insert(makeTask({ taskId: "t2", fromAgentId: "bob" }));

      const filtered = db.tasks.list({ fromAgentId: "alice" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].fromAgentId).toBe("alice");
    });

    it("filters by toAgentId", () => {
      db.tasks.insert(makeTask({ taskId: "t1", toAgentId: "alice" }));
      db.tasks.insert(makeTask({ taskId: "t2", toAgentId: "bob" }));

      const filtered = db.tasks.list({ toAgentId: "bob" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].toAgentId).toBe("bob");
    });

    it("filters by state", () => {
      db.tasks.insert(makeTask({ taskId: "t1", state: "completed" }));
      db.tasks.insert(makeTask({ taskId: "t2", state: "failed" }));
      db.tasks.insert(makeTask({ taskId: "t3", state: "completed" }));

      const completed = db.tasks.list({ state: "completed" });
      expect(completed).toHaveLength(2);
      expect(completed.every((t) => t.state === "completed")).toBe(true);
    });

    it("filters by messageType", () => {
      db.tasks.insert(makeTask({ taskId: "t1", messageType: "task" }));
      db.tasks.insert(makeTask({ taskId: "t2", messageType: "review" }));
      db.tasks.insert(makeTask({ taskId: "t3", messageType: "task" }));

      const tasks = db.tasks.list({ messageType: "task" });
      expect(tasks).toHaveLength(2);
    });

    it("filters by since", () => {
      db.tasks.insert(makeTask({ taskId: "t1", createdAt: 1000 }));
      db.tasks.insert(makeTask({ taskId: "t2", createdAt: 2000 }));
      db.tasks.insert(makeTask({ taskId: "t3", createdAt: 3000 }));

      const recent = db.tasks.list({ since: 2000 });
      expect(recent).toHaveLength(2);
    });

    it("respects limit", () => {
      db.tasks.insert(makeTask({ taskId: "t1", createdAt: 1000 }));
      db.tasks.insert(makeTask({ taskId: "t2", createdAt: 2000 }));
      db.tasks.insert(makeTask({ taskId: "t3", createdAt: 3000 }));

      const limited = db.tasks.list({ limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it("limit returns newest tasks, not oldest", () => {
      db.tasks.insert(makeTask({ taskId: "t-old", createdAt: 1000 }));
      db.tasks.insert(makeTask({ taskId: "t-mid", createdAt: 2000 }));
      db.tasks.insert(makeTask({ taskId: "t-new", createdAt: 3000 }));

      const limited = db.tasks.list({ limit: 2 });
      expect(limited).toHaveLength(2);
      expect(limited[0].taskId).toBe("t-new");
      expect(limited[1].taskId).toBe("t-mid");
    });

    it("combines multiple filters", () => {
      db.tasks.insert(makeTask({ taskId: "t1", fromAgentId: "alice", state: "completed", createdAt: 1000 }));
      db.tasks.insert(makeTask({ taskId: "t2", fromAgentId: "alice", state: "failed", createdAt: 2000 }));
      db.tasks.insert(makeTask({ taskId: "t3", fromAgentId: "bob", state: "completed", createdAt: 3000 }));

      const filtered = db.tasks.list({ fromAgentId: "alice", state: "completed" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].taskId).toBe("t1");
    });
  });

  describe("count", () => {
    it("counts all tasks", () => {
      db.tasks.insert(makeTask({ taskId: "t1" }));
      db.tasks.insert(makeTask({ taskId: "t2" }));
      expect(db.tasks.count()).toBe(2);
    });

    it("counts with filter", () => {
      db.tasks.insert(makeTask({ taskId: "t1", state: "completed" }));
      db.tasks.insert(makeTask({ taskId: "t2", state: "failed" }));
      db.tasks.insert(makeTask({ taskId: "t3", state: "completed" }));

      expect(db.tasks.count({ state: "completed" })).toBe(2);
      expect(db.tasks.count({ state: "failed" })).toBe(1);
    });

    it("returns 0 for empty store", () => {
      expect(db.tasks.count()).toBe(0);
    });

    it("counts with since filter", () => {
      db.tasks.insert(makeTask({ taskId: "t1", createdAt: 1000 }));
      db.tasks.insert(makeTask({ taskId: "t2", createdAt: 2000 }));
      db.tasks.insert(makeTask({ taskId: "t3", createdAt: 3000 }));

      expect(db.tasks.count({ since: 2000 })).toBe(2);
    });
  });

  describe("error paths", () => {
    it("duplicate taskId insertion (sqlite constraint violation)", () => {
      const task1 = makeTask({ taskId: "duplicate-task" });
      const task2 = makeTask({ taskId: "duplicate-task", summary: "Different summary" });

      db.tasks.insert(task1);

      if (db.backend === "sqlite") {
        // SQLite should throw a constraint error for duplicate primary key
        expect(() => db.tasks.insert(task2)).toThrow();
      } else {
        // Memory backend overwrites silently
        db.tasks.insert(task2);
        const retrieved = db.tasks.get("duplicate-task");
        expect(retrieved!.summary).toBe("Different summary");
      }
    });

    it("invalid state values are handled gracefully", () => {
      // Test updating to an invalid state - should be rejected or sanitized
      const task = makeTask({ taskId: "invalid-state-test" });
      db.tasks.insert(task);

      // Create a TaskRecord with invalid state to test runtime validation
      const invalidTask = makeTask({ 
        taskId: "invalid-from-start", 
        state: "totally-invalid" as any 
      });

      if (db.backend === "sqlite") {
        // SQLite stores as TEXT but should validate on retrieval
        db.tasks.insert(invalidTask);
        const retrieved = db.tasks.get("invalid-from-start");
        // SQLite implementation uses isTaskState() to validate and defaults to "submitted"
        expect(retrieved!.state).toBe("submitted");
      } else {
        // Memory backend stores whatever is provided
        db.tasks.insert(invalidTask);
        const retrieved = db.tasks.get("invalid-from-start");
        expect(retrieved!.state).toBe("totally-invalid");
      }

      // Update with invalid state
      if (db.backend === "memory") {
        // Memory allows any string
        db.tasks.update("invalid-state-test", { state: "bad-state" as any });
        const updated = db.tasks.get("invalid-state-test");
        expect(updated!.state).toBe("bad-state");
      }
      // SQLite update doesn't validate - it just stores the string
    });

    it("concurrent update conflicts", async () => {
      const task = makeTask({ taskId: "concurrent-test" });
      db.tasks.insert(task);

      // Simulate two rapid updates
      const update1 = { state: "working" as const, updatedAt: Date.now() };
      const update2 = { state: "completed" as const, updatedAt: Date.now() + 1 };

      // Both should succeed, but last one wins (no atomic compare-and-swap)
      db.tasks.update("concurrent-test", update1);
      db.tasks.update("concurrent-test", update2);

      const final = db.tasks.get("concurrent-test");
      expect(final!.state).toBe("completed");
    });

    it("edge cases: empty strings and null values", () => {
      const edgeTask = makeTask({
        taskId: "edge-case-test",
        summary: "", // Empty string
        payload: "", // Empty string
      });

      db.tasks.insert(edgeTask);
      const retrieved = db.tasks.get("edge-case-test");
      expect(retrieved!.summary).toBe("");
      expect(retrieved!.payload).toBe("");

      // Test updating with null values (should work for nullable fields)
      db.tasks.update("edge-case-test", {
        responseText: null,
        responsePayload: null,
        completedAt: null,
      });

      const updated = db.tasks.get("edge-case-test");
      expect(updated!.responseText).toBeNull();
      expect(updated!.responsePayload).toBeNull();
      expect(updated!.completedAt).toBeNull();
    });

    it("edge cases: very long strings", () => {
      const longString = "x".repeat(100000); // 100KB string
      const longTask = makeTask({
        taskId: "long-string-test",
        summary: longString,
        payload: longString,
      });

      // Should handle large strings without error
      db.tasks.insert(longTask);
      const retrieved = db.tasks.get("long-string-test");
      expect(retrieved!.summary.length).toBe(100000);
      expect(retrieved!.payload.length).toBe(100000);

      // Test updating with long response
      const longResponse = "y".repeat(50000);
      db.tasks.update("long-string-test", {
        responseText: longResponse,
        responsePayload: longResponse,
      });

      const updated = db.tasks.get("long-string-test");
      expect(updated!.responseText!.length).toBe(50000);
      expect(updated!.responsePayload!.length).toBe(50000);
    });

    it("update nonexistent task behavior", () => {
      if (db.backend === "memory") {
        // Memory throws error for nonexistent task
        expect(() => db.tasks.update("does-not-exist", { state: "working" })).toThrow("task not found");
      } else {
        // SQLite silently does nothing for nonexistent task
        expect(() => db.tasks.update("does-not-exist", { state: "working" })).not.toThrow();
        expect(db.tasks.get("does-not-exist")).toBeNull();
      }
    });
  });
});

describe("isTaskState", () => {
  it("returns true for valid states", () => {
    for (const state of TASK_STATES) {
      expect(isTaskState(state)).toBe(true);
    }
  });

  it("returns false for invalid values", () => {
    expect(isTaskState("invalid")).toBe(false);
    expect(isTaskState("")).toBe(false);
    expect(isTaskState(42)).toBe(false);
    expect(isTaskState(null)).toBe(false);
    expect(isTaskState(undefined)).toBe(false);
  });
});
