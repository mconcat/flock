/**
 * Integration test: async roundtrip flock_message → flock_tasks
 *
 * Tests the full async flow an agent experiences:
 *   1. Agent A calls flock_message → gets { taskId, state: "submitted" }
 *   2. Background: A2A sends message → Agent B's executor processes → TaskStore updated
 *   3. Agent A calls flock_tasks → sees state: "completed" with response
 *
 * No mocks — all real implementations: A2AServer, A2AClient, createFlockExecutor,
 * in-memory TaskStore, AuditLog, and tool execute functions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { A2AServer } from "../../src/transport/server.js";
import { createA2AClient } from "../../src/transport/client.js";
import type { A2AClient } from "../../src/transport/client.js";
import { createWorkerCard } from "../../src/transport/agent-card.js";
import { createFlockExecutor } from "../../src/transport/executor.js";
import type { SessionSendFn } from "../../src/transport/executor.js";
import { createMemoryDatabase } from "../../src/db/memory.js";
import { createAuditLog } from "../../src/audit/log.js";
import { resolveFlockConfig } from "../../src/config.js";
import { createFlockTools } from "../../src/tools/index.js";
import type { ToolDeps } from "../../src/tools/index.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { PluginLogger } from "../../src/types.js";
import type { TaskStore } from "../../src/db/interface.js";
import type { FlockDatabase } from "../../src/db/interface.js";
import type { HomeManager } from "../../src/homes/manager.js";
import type { HomeProvisioner } from "../../src/homes/provisioner.js";

// --- Helpers ---

function makeLogger(): PluginLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

/** Build tools map from createFlockTools. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildToolsMap(deps: ToolDeps): Map<string, AgentTool<any>> {
  const toolArray = createFlockTools(deps);
  const tools = new Map<string, AgentTool<any>>();
  for (const t of toolArray) tools.set(t.name, t);
  return tools;
}

/** Minimal HomeManager stub — tools under test don't touch homes. */
function stubHomeManager(): HomeManager {
  return {
    create: () => { throw new Error("not implemented"); },
    get: () => null,
    list: () => [],
    transition: () => { throw new Error("not implemented"); },
    renew: () => { throw new Error("not implemented"); },
    release: () => { throw new Error("not implemented"); },
    getTransitions: () => [],
  };
}

/** Minimal HomeProvisioner stub — tools under test don't provision. */
function stubProvisioner(): HomeProvisioner {
  return {
    provision: () => { throw new Error("not implemented"); },
    exists: () => false,
    retire: () => { throw new Error("not implemented"); },
  };
}

/** Poll until a condition is met or timeout. */
async function pollUntil(
  check: () => boolean,
  intervalMs = 50,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

// --- SessionSend implementations (real functions, no mocks) ---

/** Agent B processes the request and returns a recognizable result. */
const agentBHappyPath: SessionSendFn = async (_agentId, message) => {
  return `Result from B: 2+2=4 (received: ${message.slice(0, 40)})`;
};

/** Agent B is offline — throws on every call. */
const agentBOffline: SessionSendFn = async () => {
  throw new Error("Agent B is offline");
};

/** Agent B that counts invocations for concurrency tests. */
function agentBWithCounter(): { sessionSend: SessionSendFn; getCount: () => number } {
  let callCount = 0;
  return {
    sessionSend: async (_agentId, message) => {
      callCount++;
      return `Response #${callCount} for: ${message.slice(0, 30)}`;
    },
    getCount: () => callCount,
  };
}

/** Agent A — exists in the swarm but won't receive messages in these tests. */
const agentASessionSend: SessionSendFn = async (_agentId, message) => {
  return `Agent A echo: ${message.slice(0, 50)}`;
};

// --- Test context ---

interface TestContext {
  a2aServer: A2AServer;
  a2aClient: A2AClient;
  db: FlockDatabase;
  taskStore: TaskStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Map<string, AgentTool<any>>;
}

function setupTestEnv(sessionSendB: SessionSendFn): TestContext {
  const logger = makeLogger();
  const a2aServer = new A2AServer({ basePath: "/flock", logger });

  // Register agent-a with a real executor
  const { card: cardA, meta: metaA } = createWorkerCard(
    "agent-a",
    "test-node",
    "http://localhost/flock/a2a/agent-a",
  );
  const executorA = createFlockExecutor({
    flockMeta: metaA,
    sessionSend: agentASessionSend,
    logger,
    responseTimeoutMs: 5000,
  });
  a2aServer.registerAgent("agent-a", cardA, metaA, executorA);

  // Register agent-b with the provided sessionSend
  const { card: cardB, meta: metaB } = createWorkerCard(
    "agent-b",
    "test-node",
    "http://localhost/flock/a2a/agent-b",
  );
  const executorB = createFlockExecutor({
    flockMeta: metaB,
    sessionSend: sessionSendB,
    logger,
    responseTimeoutMs: 5000,
  });
  a2aServer.registerAgent("agent-b", cardB, metaB, executorB);

  // A2A client talks to local server (in-process, no HTTP)
  const a2aClient = createA2AClient({ localServer: a2aServer, logger });

  // In-memory database and task store
  const db = createMemoryDatabase();
  const taskStore = db.tasks;
  const audit = createAuditLog({ db, logger });
  const config = resolveFlockConfig({ nodeId: "test-node", dbBackend: "memory" });

  const deps: ToolDeps = {
    config,
    homes: stubHomeManager(),
    audit,
    provisioner: stubProvisioner(),
    a2aClient,
    a2aServer,
    taskStore,
  };
  const tools = buildToolsMap(deps);

  return {
    a2aServer,
    a2aClient,
    db,
    taskStore,
    tools,
  };
}

// --- Tests ---

describe("async roundtrip: flock_message → flock_tasks", () => {
  let ctx: TestContext;

  describe("happy path", () => {
    beforeEach(() => {
      ctx = setupTestEnv(agentBHappyPath);
    });

    it("flock_message returns immediately with taskId and submitted state", async () => {
      const messageTool = ctx.tools.get("flock_message")!;
      const result = await messageTool.execute(
        "test-call-id",
        { agentId: "agent-a", to: "agent-b", message: "calculate 2+2" },
      );

      expect(result.details?.ok).toBe(true);
      expect(result.details).toBeDefined();
      expect(result.details!.state).toBe("submitted");
      expect(result.details!.to).toBe("agent-b");
      expect(typeof result.details!.taskId).toBe("string");
    });

    it("task is visible in submitted state right after flock_message returns", async () => {
      const messageTool = ctx.tools.get("flock_message")!;
      const tasksTool = ctx.tools.get("flock_tasks")!;

      const sendResult = await messageTool.execute(
        "test-call-id",
        { agentId: "agent-a", to: "agent-b", message: "calculate 2+2" },
      );
      const taskId = sendResult.details!.taskId as string;

      // Immediately check TaskStore — should be submitted before background completes
      const record = ctx.taskStore.get(taskId);
      expect(record).not.toBeNull();
      expect(record!.state).toBe("submitted");
      expect(record!.fromAgentId).toBe("agent-a");
      expect(record!.toAgentId).toBe("agent-b");

      // flock_tasks should list it for agent-a
      const tasksResult = await tasksTool.execute(
        "test-call-id",
        { agentId: "agent-a", direction: "sent" },
      );
      expect(tasksResult.details?.ok).toBe(true);
      const tasks = tasksResult.details!.tasks as Array<{ taskId: string; state: string }>;
      const found = tasks.find((t) => t.taskId === taskId);
      expect(found).toBeDefined();
    });

    it("full roundtrip: flock_message → wait → flock_tasks shows completed with response", async () => {
      const messageTool = ctx.tools.get("flock_message")!;
      const tasksTool = ctx.tools.get("flock_tasks")!;

      // Step 1: send message
      const sendResult = await messageTool.execute(
        "test-call-id",
        { agentId: "agent-a", to: "agent-b", message: "calculate 2+2" },
      );
      expect(sendResult.details?.ok).toBe(true);
      const taskId = sendResult.details!.taskId as string;

      // Step 2: wait for background A2A call to complete
      await pollUntil(() => {
        const record = ctx.taskStore.get(taskId);
        return record !== null && record.state === "completed";
      });

      // Step 3: query via flock_tasks
      const tasksResult = await tasksTool.execute(
        "test-call-id",
        { agentId: "agent-a", direction: "sent" },
      );
      expect(tasksResult.details?.ok).toBe(true);

      const tasks = tasksResult.details!.tasks as Array<{
        taskId: string;
        state: string;
        responseText: string | null;
        toAgentId: string;
      }>;
      const completed = tasks.find((t) => t.taskId === taskId);
      expect(completed).toBeDefined();
      expect(completed!.state).toBe("completed");
      expect(completed!.toAgentId).toBe("agent-b");
      expect(completed!.responseText).toContain("Result from B: 2+2=4");
    });

    it("completed task has correct timestamps", async () => {
      const messageTool = ctx.tools.get("flock_message")!;
      const beforeSend = Date.now();

      const sendResult = await messageTool.execute(
        "test-call-id",
        { agentId: "agent-a", to: "agent-b", message: "calculate 2+2" },
      );
      const taskId = sendResult.details!.taskId as string;

      await pollUntil(() => {
        const record = ctx.taskStore.get(taskId);
        return record !== null && record.state === "completed";
      });

      const record = ctx.taskStore.get(taskId)!;
      expect(record.createdAt).toBeGreaterThanOrEqual(beforeSend);
      expect(record.completedAt).not.toBeNull();
      expect(record.completedAt!).toBeGreaterThanOrEqual(record.createdAt);
      expect(record.updatedAt).toBeGreaterThanOrEqual(record.createdAt);
    });
  });

  describe("failed delivery", () => {
    beforeEach(() => {
      ctx = setupTestEnv(agentBOffline);
    });

    it("task transitions to failed when agent-b's executor throws", async () => {
      const messageTool = ctx.tools.get("flock_message")!;
      const tasksTool = ctx.tools.get("flock_tasks")!;

      const sendResult = await messageTool.execute(
        "test-call-id",
        { agentId: "agent-a", to: "agent-b", message: "calculate 2+2" },
      );
      expect(sendResult.details?.ok).toBe(true);
      const taskId = sendResult.details!.taskId as string;

      // Wait for the background promise to settle with failure
      await pollUntil(() => {
        const record = ctx.taskStore.get(taskId);
        return record !== null && record.state === "failed";
      });

      // flock_tasks should show the failure
      const tasksResult = await tasksTool.execute(
        "test-call-id",
        { agentId: "agent-a", direction: "sent", state: "failed" },
      );
      expect(tasksResult.details?.ok).toBe(true);

      const tasks = tasksResult.details!.tasks as Array<{
        taskId: string;
        state: string;
        responseText: string | null;
      }>;
      const failed = tasks.find((t) => t.taskId === taskId);
      expect(failed).toBeDefined();
      expect(failed!.state).toBe("failed");
    });
  });

  describe("unknown target agent", () => {
    beforeEach(() => {
      ctx = setupTestEnv(agentBHappyPath);
    });

    it("task transitions to failed when target agent does not exist", async () => {
      const messageTool = ctx.tools.get("flock_message")!;

      const sendResult = await messageTool.execute(
        "test-call-id",
        { agentId: "agent-a", to: "nonexistent-agent", message: "hello" },
      );
      expect(sendResult.details?.ok).toBe(true);
      const taskId = sendResult.details!.taskId as string;

      // Background A2A call to nonexistent agent should fail
      await pollUntil(() => {
        const record = ctx.taskStore.get(taskId);
        return record !== null && record.state === "failed";
      });

      const record = ctx.taskStore.get(taskId)!;
      expect(record.state).toBe("failed");
      expect(record.responseText).toContain("nonexistent-agent");
    });
  });

  describe("validation errors", () => {
    beforeEach(() => {
      ctx = setupTestEnv(agentBHappyPath);
    });

    it("rejects missing 'to' parameter", async () => {
      const messageTool = ctx.tools.get("flock_message")!;
      const result = await messageTool.execute(
        "test-call-id",
        { agentId: "agent-a", to: "", message: "hello" },
      );
      expect(result.details?.ok).toBe(false);
      expect(result.content[0].text).toContain("to");
    });

    it("rejects missing 'message' parameter", async () => {
      const messageTool = ctx.tools.get("flock_message")!;
      const result = await messageTool.execute(
        "test-call-id",
        { agentId: "agent-a", to: "agent-b", message: "" },
      );
      expect(result.details?.ok).toBe(false);
      expect(result.content[0].text).toContain("message");
    });
  });

  describe("multiple concurrent messages", () => {
    let counter: { sessionSend: SessionSendFn; getCount: () => number };

    beforeEach(() => {
      counter = agentBWithCounter();
      ctx = setupTestEnv(counter.sessionSend);
    });

    it("tracks multiple tasks independently", async () => {
      const messageTool = ctx.tools.get("flock_message")!;
      const tasksTool = ctx.tools.get("flock_tasks")!;

      // Send three messages concurrently
      const [r1, r2, r3] = await Promise.all([
        messageTool.execute("test-call-id-1", { agentId: "agent-a", to: "agent-b", message: "task 1" }),
        messageTool.execute("test-call-id-2", { agentId: "agent-a", to: "agent-b", message: "task 2" }),
        messageTool.execute("test-call-id-3", { agentId: "agent-a", to: "agent-b", message: "task 3" }),
      ]);

      const taskIds = [
        r1.details!.taskId as string,
        r2.details!.taskId as string,
        r3.details!.taskId as string,
      ];

      // All should have unique task IDs
      const uniqueIds = new Set(taskIds);
      expect(uniqueIds.size).toBe(3);

      // Wait for all to complete
      await pollUntil(() => {
        return taskIds.every((id) => {
          const record = ctx.taskStore.get(id);
          return record !== null && (record.state === "completed" || record.state === "failed");
        });
      });

      // All should be completed
      const tasksResult = await tasksTool.execute(
        "test-call-id",
        { agentId: "agent-a", direction: "sent" },
      );
      const tasks = tasksResult.details!.tasks as Array<{ taskId: string; state: string }>;
      for (const taskId of taskIds) {
        const task = tasks.find((t) => t.taskId === taskId);
        expect(task).toBeDefined();
        expect(task!.state).toBe("completed");
      }

      // Agent B's sessionSend was actually called 3 times
      expect(counter.getCount()).toBe(3);
    });
  });

  describe("flock_tasks direction filters", () => {
    beforeEach(() => {
      ctx = setupTestEnv(agentBHappyPath);
    });

    it("'sent' only returns tasks sent by the calling agent", async () => {
      const messageTool = ctx.tools.get("flock_message")!;
      const tasksTool = ctx.tools.get("flock_tasks")!;

      await messageTool.execute(
        "test-call-id",
        { agentId: "agent-a", to: "agent-b", message: "from A" },
      );

      // agent-a sees it as "sent"
      const sentResult = await tasksTool.execute(
        "test-call-id",
        { agentId: "agent-a", direction: "sent" },
      );
      const sentTasks = sentResult.details!.tasks as Array<{ fromAgentId: string }>;
      expect(sentTasks.length).toBeGreaterThanOrEqual(1);
      expect(sentTasks.every((t) => t.fromAgentId === "agent-a")).toBe(true);

      // agent-b sees it as "received"
      const receivedResult = await tasksTool.execute(
        "test-call-id",
        { agentId: "agent-b", direction: "received" },
      );
      const receivedTasks = receivedResult.details!.tasks as Array<{ toAgentId: string }>;
      expect(receivedTasks.length).toBeGreaterThanOrEqual(1);
      expect(receivedTasks.every((t) => t.toAgentId === "agent-b")).toBe(true);
    });
  });

  describe("flock_task_respond flow", () => {
    it("agent-b can respond to an input-required task", async () => {
      ctx = setupTestEnv(agentBHappyPath);

      const messageTool = ctx.tools.get("flock_message")!;
      const taskRespondTool = ctx.tools.get("flock_task_respond")!;

      // Step 1: Agent A sends a message
      const sendResult = await messageTool.execute(
        "test-call-id",
        { agentId: "agent-a", to: "agent-b", message: "need clarification on something" },
      );
      const taskId = sendResult.details!.taskId as string;

      // Wait for it to settle (so we have a valid task record)
      await pollUntil(() => {
        const record = ctx.taskStore.get(taskId);
        return record !== null && record.state !== "submitted";
      });

      // Manually set state to input-required to simulate agent-b requesting input
      ctx.taskStore.update(taskId, { state: "input-required", updatedAt: Date.now() });

      // Step 2: Agent B responds to the input-required task
      const respondResult = await taskRespondTool.execute(
        "test-call-id",
        { agentId: "agent-b", taskId, response: "Here is the clarification you asked for" },
      );

      expect(respondResult.details?.ok).toBe(true);

      // Task should now be in "working" state
      const record = ctx.taskStore.get(taskId)!;
      expect(record.state).toBe("working");
      expect(record.responseText).toBe("Here is the clarification you asked for");
    });

    it("rejects respond from wrong agent", async () => {
      ctx = setupTestEnv(agentBHappyPath);

      const messageTool = ctx.tools.get("flock_message")!;
      const taskRespondTool = ctx.tools.get("flock_task_respond")!;

      const sendResult = await messageTool.execute(
        "test-call-id",
        { agentId: "agent-a", to: "agent-b", message: "do something" },
      );
      const taskId = sendResult.details!.taskId as string;

      await pollUntil(() => {
        const record = ctx.taskStore.get(taskId);
        return record !== null && record.state !== "submitted";
      });

      ctx.taskStore.update(taskId, { state: "input-required", updatedAt: Date.now() });

      // Agent A (not the recipient) tries to respond — should fail
      const respondResult = await taskRespondTool.execute(
        "test-call-id",
        { agentId: "agent-a", taskId, response: "I'm not agent-b" },
      );
      expect(respondResult.details?.ok).toBe(false);
      expect(respondResult.content[0].text).toContain("Permission denied");
    });

    it("rejects respond when task is not input-required", async () => {
      ctx = setupTestEnv(agentBHappyPath);

      const messageTool = ctx.tools.get("flock_message")!;
      const taskRespondTool = ctx.tools.get("flock_task_respond")!;

      const sendResult = await messageTool.execute(
        "test-call-id",
        { agentId: "agent-a", to: "agent-b", message: "do something" },
      );
      const taskId = sendResult.details!.taskId as string;

      // Wait for completion
      await pollUntil(() => {
        const record = ctx.taskStore.get(taskId);
        return record !== null && record.state === "completed";
      });

      // Try to respond to a completed task — should fail
      const respondResult = await taskRespondTool.execute(
        "test-call-id",
        { agentId: "agent-b", taskId, response: "too late" },
      );
      expect(respondResult.details?.ok).toBe(false);
      expect(respondResult.content[0].text).toContain("not \"input-required\"");
    });
  });
});
