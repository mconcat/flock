/**
 * Tests for executor TaskStore integration.
 * Verifies the executor records task lifecycle in TaskStore.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFlockExecutor } from "../../src/transport/executor.js";
import type { FlockCardMetadata } from "../../src/transport/types.js";
import type { PluginLogger } from "../../src/types.js";
import type { AuditLog } from "../../src/audit/log.js";
import type { TaskStore } from "../../src/db/interface.js";
import { createMemoryDatabase } from "../../src/db/memory.js";
import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeAudit(): AuditLog {
  return {
    append: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0),
  } as unknown as AuditLog;
}

function makeEventBus(): ExecutionEventBus & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    publish(event: unknown) {
      events.push(event);
    },
    finished() {},
  };
}

function makeRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    taskId: "test-task-123",
    contextId: "test-ctx-123",
    userMessage: {
      kind: "message",
      messageId: "msg-1",
      role: "user",
      parts: [{ kind: "text", text: "Hello worker" }],
    },
    ...overrides,
  };
}

const workerMeta: FlockCardMetadata = {
  role: "worker",
  nodeId: "test-node",
  homeId: "worker-1@test-node",
};

describe("Executor with TaskStore", () => {
  let taskStore: TaskStore;
  let logger: PluginLogger;
  let audit: AuditLog;

  beforeEach(() => {
    const db = createMemoryDatabase();
    taskStore = db.tasks;
    logger = makeLogger();
    audit = makeAudit();
  });

  it("records submitted → working → completed lifecycle", async () => {
    const sessionSend = vi.fn().mockResolvedValue("Task done!");

    const executor = createFlockExecutor({
      flockMeta: workerMeta,
      sessionSend,
      audit,
      taskStore,
      logger,
    });

    const ctx = makeRequestContext();
    const eventBus = makeEventBus();

    await executor.execute(ctx, eventBus);

    // Verify the task record exists and is completed
    const record = taskStore.get("test-task-123");
    expect(record).not.toBeNull();
    expect(record!.taskId).toBe("test-task-123");
    expect(record!.contextId).toBe("test-ctx-123");
    expect(record!.toAgentId).toBe("worker-1");
    expect(record!.state).toBe("completed");
    expect(record!.responseText).toBe("Task done!");
    expect(record!.completedAt).not.toBeNull();
    expect(record!.completedAt! >= record!.createdAt).toBe(true);
  });

  it("records submitted → working → failed lifecycle on error", async () => {
    const sessionSend = vi.fn().mockRejectedValue(new Error("Session timeout"));

    const executor = createFlockExecutor({
      flockMeta: workerMeta,
      sessionSend,
      audit,
      taskStore,
      logger,
    });

    const ctx = makeRequestContext({ taskId: "fail-task" });
    const eventBus = makeEventBus();

    await executor.execute(ctx, eventBus);

    const record = taskStore.get("fail-task");
    expect(record).not.toBeNull();
    expect(record!.state).toBe("failed");
    expect(record!.responseText).toContain("Session timeout");
    expect(record!.completedAt).not.toBeNull();
  });

  it("records canceled state on cancelTask", async () => {
    const sessionSend = vi.fn().mockResolvedValue("ok");

    const executor = createFlockExecutor({
      flockMeta: workerMeta,
      sessionSend,
      audit,
      taskStore,
      logger,
    });

    // First create a task record
    taskStore.insert({
      taskId: "cancel-task",
      contextId: "ctx-1",
      fromAgentId: "requester",
      toAgentId: "worker-1",
      state: "working",
      messageType: "a2a-message",
      summary: "test",
      payload: "{}",
      responseText: null,
      responsePayload: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
    });

    const eventBus = makeEventBus();
    await executor.cancelTask!("cancel-task", eventBus);

    const record = taskStore.get("cancel-task");
    expect(record).not.toBeNull();
    expect(record!.state).toBe("canceled");
    expect(record!.completedAt).not.toBeNull();
  });

  it("works without taskStore (no crash)", async () => {
    const sessionSend = vi.fn().mockResolvedValue("Task done!");

    const executor = createFlockExecutor({
      flockMeta: workerMeta,
      sessionSend,
      audit,
      logger,
      // No taskStore
    });

    const ctx = makeRequestContext();
    const eventBus = makeEventBus();

    // Should not throw
    await executor.execute(ctx, eventBus);

    // Verify the event was published
    expect(eventBus.events.length).toBeGreaterThan(0);
  });

  it("records fromAgentId from task metadata", async () => {
    const sessionSend = vi.fn().mockResolvedValue("Done");

    const executor = createFlockExecutor({
      flockMeta: workerMeta,
      sessionSend,
      audit,
      taskStore,
      logger,
    });

    // Send with DataPart containing fromHome
    const ctx = makeRequestContext({
      taskId: "meta-task",
      userMessage: {
        kind: "message",
        messageId: "msg-2",
        role: "user",
        parts: [
          { kind: "text", text: "Do something" },
          { kind: "data", data: { flockType: "worker-task", fromHome: "requester-agent" } },
        ],
      },
    });

    const eventBus = makeEventBus();
    await executor.execute(ctx, eventBus);

    const record = taskStore.get("meta-task");
    expect(record).not.toBeNull();
    expect(record!.fromAgentId).toBe("requester-agent");
  });
});
