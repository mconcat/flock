/**
 * Tests for Phase 2 tools: flock_discover, flock_history, flock_tasks, flock_task_respond
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerFlockTools } from "../../src/tools/index.js";
import type { ToolDeps } from "../../src/tools/index.js";
import type { PluginApi, ToolDefinition, ToolResultOC } from "../../src/types.js";
import type { FlockConfig } from "../../src/config.js";
import type { HomeManager } from "../../src/homes/manager.js";
import type { HomeProvisioner } from "../../src/homes/provisioner.js";
import type { AuditLog } from "../../src/audit/log.js";
import type { A2AClient } from "../../src/transport/client.js";
import type { A2AServer } from "../../src/transport/server.js";
import type { TaskStore, TaskRecord } from "../../src/db/interface.js";
import { createMemoryDatabase } from "../../src/db/memory.js";
import { CardRegistry } from "../../src/transport/agent-card.js";
import { createAgentCard, buildFlockMetadata } from "../../src/transport/agent-card.js";
import type { CreateCardParams } from "../../src/transport/agent-card.js";

// --- Helpers ---

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

function makeCardRegistry(): CardRegistry {
  const registry = new CardRegistry();

  const workerParams: CreateCardParams = {
    agentId: "worker-1",
    nodeId: "node-1",
    role: "worker",
    name: "Worker One",
    description: "A general-purpose worker agent",
    skills: [
      { id: "skill-impl", name: "Implementation", description: "Can implement features", tags: ["implement", "develop", "build"] },
    ],
    endpointUrl: "http://localhost:3000/flock/a2a/worker-1",
  };
  registry.register("worker-1", createAgentCard(workerParams), buildFlockMetadata(workerParams));

  const worker2Params: CreateCardParams = {
    agentId: "worker-2",
    nodeId: "node-1",
    role: "worker",
    name: "Worker Two",
    description: "A review specialist",
    skills: [
      { id: "skill-review", name: "Code Review", description: "Can review code", tags: ["review", "verify"] },
    ],
    endpointUrl: "http://localhost:3000/flock/a2a/worker-2",
  };
  registry.register("worker-2", createAgentCard(worker2Params), buildFlockMetadata(worker2Params));

  const sysadminParams: CreateCardParams = {
    agentId: "sysadmin",
    nodeId: "node-1",
    role: "sysadmin",
    endpointUrl: "http://localhost:3000/flock/a2a/sysadmin",
  };
  registry.register("sysadmin", createAgentCard(sysadminParams), buildFlockMetadata(sysadminParams));

  return registry;
}

// Collect registered tools from registerFlockTools
function collectTools(deps: ToolDeps): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const api: PluginApi = {
    id: "flock",
    source: "test",
    config: {},
    pluginConfig: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool(tool: ToolDefinition | ((ctx: Record<string, unknown>) => ToolDefinition | ToolDefinition[] | null | undefined)) {
      if (typeof tool === "function") {
        const resolved = tool({ agentId: "test-agent" });
        if (resolved) {
          const list = Array.isArray(resolved) ? resolved : [resolved];
          for (const t of list) tools.set(t.name, t);
        }
      } else {
        tools.set(tool.name, tool);
      }
    },
    registerGatewayMethod: vi.fn(),
    registerHttpRoute: vi.fn(),
  };
  registerFlockTools(api, deps);
  return tools;
}

function makeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  const db = createMemoryDatabase();
  return {
    config: { dataDir: "/tmp/flock-test", dbBackend: "memory" } as FlockConfig,
    homes: { get: vi.fn(), list: vi.fn(), create: vi.fn(), transition: vi.fn(), setLeaseExpiry: vi.fn() } as unknown as HomeManager,
    audit: { append: vi.fn(), query: vi.fn().mockReturnValue([]), count: vi.fn().mockReturnValue(0) } as unknown as AuditLog,
    provisioner: {} as HomeProvisioner,
    a2aClient: {
      sendA2A: vi.fn().mockResolvedValue({
        taskId: "mock-task-id",
        state: "completed",
        response: "Mock response",
        artifacts: [],
        raw: { kind: "task", id: "mock-task-id", contextId: "mock-ctx", status: { state: "completed" } },
      }),
    } as unknown as A2AClient,
    a2aServer: { cardRegistry: makeCardRegistry() } as unknown as A2AServer,
    taskStore: db.tasks,
    ...overrides,
  };
}

// --- flock_discover ---

describe("flock_discover", () => {
  let tool: ToolDefinition;
  let deps: ToolDeps;

  beforeEach(() => {
    deps = makeDeps();
    const tools = collectTools(deps);
    tool = tools.get("flock_discover")!;
    expect(tool).toBeDefined();
  });

  it("lists all agents without filters", async () => {
    const result = await tool.execute("test-call-id", {});
    expect(result.details?.ok).toBe(true);
    expect(result.details?.agents).toBeDefined();
    const agents = result.details!.agents as Array<{ agentId: string }>;
    expect(agents).toHaveLength(3); // worker-1, worker-2, sysadmin
  });

  it("filters by role=worker", async () => {
    const result = await tool.execute("test-call-id", { role: "worker" });
    expect(result.details?.ok).toBe(true);
    const agents = result.details!.agents as Array<{ agentId: string; role: string }>;
    expect(agents).toHaveLength(2);
    expect(agents.every((a) => a.role === "worker")).toBe(true);
  });

  it("filters by role=sysadmin", async () => {
    const result = await tool.execute("test-call-id", { role: "sysadmin" });
    expect(result.details?.ok).toBe(true);
    const agents = result.details!.agents as Array<{ agentId: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe("sysadmin");
  });

  it("filters by skill tag", async () => {
    const result = await tool.execute("test-call-id", { skill: "review" });
    expect(result.details?.ok).toBe(true);
    const agents = result.details!.agents as Array<{ agentId: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe("worker-2");
  });

  it("filters by free-text query", async () => {
    const result = await tool.execute("test-call-id", { query: "review specialist" });
    expect(result.details?.ok).toBe(true);
    const agents = result.details!.agents as Array<{ agentId: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe("worker-2");
  });

  it("returns empty for non-matching query", async () => {
    const result = await tool.execute("test-call-id", { query: "nonexistent-zzz" });
    expect(result.details?.ok).toBe(true);
    const agents = result.details!.agents as Array<{ agentId: string }>;
    expect(agents).toHaveLength(0);
  });

  it("respects limit", async () => {
    const result = await tool.execute("test-call-id", { limit: 1 });
    expect(result.details?.ok).toBe(true);
    const agents = result.details!.agents as Array<{ agentId: string }>;
    expect(agents).toHaveLength(1);
  });

  it("includes task stats when TaskStore has data", async () => {
    // Seed some completed tasks
    deps.taskStore!.insert(makeTask({ taskId: "t1", toAgentId: "worker-1", state: "completed" }));
    deps.taskStore!.insert(makeTask({ taskId: "t2", toAgentId: "worker-1", state: "completed" }));
    deps.taskStore!.insert(makeTask({ taskId: "t3", toAgentId: "worker-1", state: "failed" }));

    const result = await tool.execute("test-call-id", { role: "worker" });
    expect(result.details?.ok).toBe(true);
    const agents = result.details!.agents as Array<{ agentId: string; stats?: { completed: number; failed: number; total: number } }>;
    const w1 = agents.find((a) => a.agentId === "worker-1");
    expect(w1?.stats).toBeDefined();
    expect(w1!.stats!.completed).toBe(2);
    expect(w1!.stats!.failed).toBe(1);
    expect(w1!.stats!.total).toBe(3);
  });

  it("returns error when A2A not initialized", async () => {
    const noServer = makeDeps({ a2aServer: undefined });
    const tools = collectTools(noServer);
    const noServerTool = tools.get("flock_discover")!;
    const result = await noServerTool.execute("test-call-id", {});
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("A2A transport not initialized");
  });
});

// --- flock_history ---

describe("flock_history", () => {
  let tool: ToolDefinition;
  let deps: ToolDeps;

  beforeEach(() => {
    deps = makeDeps();
    const tools = collectTools(deps);
    tool = tools.get("flock_history")!;
    expect(tool).toBeDefined();

    // Seed tasks
    deps.taskStore!.insert(makeTask({ taskId: "h1", fromAgentId: "alice", toAgentId: "bob", state: "completed", messageType: "task", createdAt: 1000 }));
    deps.taskStore!.insert(makeTask({ taskId: "h2", fromAgentId: "bob", toAgentId: "charlie", state: "failed", messageType: "review", createdAt: 2000 }));
    deps.taskStore!.insert(makeTask({ taskId: "h3", fromAgentId: "alice", toAgentId: "charlie", state: "completed", messageType: "info", createdAt: 3000 }));
  });

  it("returns all history without filters", async () => {
    const result = await tool.execute("test-call-id", {});
    expect(result.details?.ok).toBe(true);
    const tasks = result.details!.tasks as Array<{ taskId: string }>;
    expect(tasks).toHaveLength(3);
  });

  it("filters by agentId (bidirectional)", async () => {
    const result = await tool.execute("test-call-id", { agentId: "bob" });
    expect(result.details?.ok).toBe(true);
    const tasks = result.details!.tasks as Array<{ taskId: string }>;
    // bob is fromAgentId in h2 and toAgentId in h1
    expect(tasks).toHaveLength(2);
  });

  it("filters by messageType", async () => {
    const result = await tool.execute("test-call-id", { messageType: "review" });
    expect(result.details?.ok).toBe(true);
    const tasks = result.details!.tasks as Array<{ taskId: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe("h2");
  });

  it("filters by state", async () => {
    const result = await tool.execute("test-call-id", { state: "completed" });
    expect(result.details?.ok).toBe(true);
    const tasks = result.details!.tasks as Array<{ taskId: string }>;
    expect(tasks).toHaveLength(2);
  });

  it("rejects invalid state", async () => {
    const result = await tool.execute("test-call-id", { state: "bogus" });
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Invalid state");
  });

  it("respects limit", async () => {
    const result = await tool.execute("test-call-id", { limit: 1 });
    expect(result.details?.ok).toBe(true);
    const tasks = result.details!.tasks as Array<{ taskId: string }>;
    expect(tasks).toHaveLength(1);
  });

  it("returns error when task store not available", async () => {
    const noStore = makeDeps({ taskStore: undefined });
    const tools = collectTools(noStore);
    const noStoreTool = tools.get("flock_history")!;
    const result = await noStoreTool.execute("test-call-id", {});
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Task store not available");
  });

  it("returns empty message when no results", async () => {
    const freshDeps = makeDeps();
    const tools = collectTools(freshDeps);
    const freshTool = tools.get("flock_history")!;
    const result = await freshTool.execute("test-call-id", { state: "canceled" });
    expect(result.details?.ok).toBe(true);
    expect(result.content[0].text).toContain("No task history found");
  });
});

// --- flock_tasks ---

describe("flock_tasks", () => {
  let tool: ToolDefinition;
  let deps: ToolDeps;

  beforeEach(() => {
    deps = makeDeps();
    const tools = collectTools(deps);
    tool = tools.get("flock_tasks")!;
    expect(tool).toBeDefined();

    // Seed tasks with "test-agent" as the caller
    deps.taskStore!.insert(makeTask({ taskId: "s1", fromAgentId: "test-agent", toAgentId: "worker-1", state: "completed", createdAt: 1000 }));
    deps.taskStore!.insert(makeTask({ taskId: "s2", fromAgentId: "test-agent", toAgentId: "worker-2", state: "working", createdAt: 2000 }));
    deps.taskStore!.insert(makeTask({ taskId: "r1", fromAgentId: "worker-1", toAgentId: "test-agent", state: "input-required", createdAt: 3000 }));
    // A task between other agents (should not appear)
    deps.taskStore!.insert(makeTask({ taskId: "o1", fromAgentId: "worker-1", toAgentId: "worker-2", state: "completed", createdAt: 4000 }));
  });

  it("lists all tasks for the caller (default: all)", async () => {
    const result = await tool.execute("test-call-id", { agentId: "test-agent" });
    expect(result.details?.ok).toBe(true);
    const tasks = result.details!.tasks as Array<{ taskId: string }>;
    expect(tasks).toHaveLength(3); // s1, s2, r1
    expect(tasks.map((t) => t.taskId).sort()).toEqual(["r1", "s1", "s2"]);
  });

  it("lists only sent tasks", async () => {
    const result = await tool.execute("test-call-id", { direction: "sent", agentId: "test-agent" });
    expect(result.details?.ok).toBe(true);
    const tasks = result.details!.tasks as Array<{ taskId: string }>;
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.taskId).sort()).toEqual(["s1", "s2"]);
  });

  it("lists only received tasks", async () => {
    const result = await tool.execute("test-call-id", { direction: "received", agentId: "test-agent" });
    expect(result.details?.ok).toBe(true);
    const tasks = result.details!.tasks as Array<{ taskId: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe("r1");
  });

  it("filters by state", async () => {
    const result = await tool.execute("test-call-id", { state: "working", agentId: "test-agent" });
    expect(result.details?.ok).toBe(true);
    const tasks = result.details!.tasks as Array<{ taskId: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe("s2");
  });

  it("rejects invalid state", async () => {
    const result = await tool.execute("test-call-id", { state: "bogus", agentId: "test-agent" });
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Invalid state");
  });

  it("respects limit", async () => {
    const result = await tool.execute("test-call-id", { limit: 1, agentId: "test-agent" });
    expect(result.details?.ok).toBe(true);
    const tasks = result.details!.tasks as Array<{ taskId: string }>;
    expect(tasks).toHaveLength(1);
  });

  it("returns empty when no tasks", async () => {
    const result = await tool.execute("test-call-id", { agentId: "nobody" });
    expect(result.details?.ok).toBe(true);
    expect(result.content[0].text).toContain("No tasks found");
  });

  it("returns error when task store not available", async () => {
    const noStore = makeDeps({ taskStore: undefined });
    const tools = collectTools(noStore);
    const noStoreTool = tools.get("flock_tasks")!;
    const result = await noStoreTool.execute("test-call-id", {});
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Task store not available");
  });
});

// --- flock_task_respond ---

describe("flock_task_respond", () => {
  let tool: ToolDefinition;
  let deps: ToolDeps;

  beforeEach(() => {
    deps = makeDeps();
    const tools = collectTools(deps);
    tool = tools.get("flock_task_respond")!;
    expect(tool).toBeDefined();
  });

  it("responds to an input-required task", async () => {
    deps.taskStore!.insert(makeTask({
      taskId: "ir-task",
      fromAgentId: "worker-1",
      toAgentId: "test-agent",
      state: "input-required",
    }));

    const result = await tool.execute(
      "test-call-id",
      { taskId: "ir-task", response: "Here is the clarification you needed.", agentId: "test-agent" }
    );
    expect(result.details?.ok).toBe(true);
    expect(result.content[0].text).toContain("Response recorded");
    expect(result.details?.state).toBe("working");

    // Verify the task was updated
    const updated = deps.taskStore!.get("ir-task");
    expect(updated!.state).toBe("working");
    expect(updated!.responseText).toBe("Here is the clarification you needed.");
  });

  it("rejects when taskId is missing", async () => {
    const result = await tool.execute(
      "test-call-id",
      { response: "Something", agentId: "test-agent" }
    );
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("taskId is required");
  });

  it("rejects when response is missing", async () => {
    const result = await tool.execute(
      "test-call-id",
      { taskId: "ir-task", agentId: "test-agent" }
    );
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("response is required");
  });

  it("rejects when task not found", async () => {
    const result = await tool.execute(
      "test-call-id",
      { taskId: "nonexistent", response: "Hi", agentId: "test-agent" }
    );
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Task not found");
  });

  it("rejects when task is addressed to someone else", async () => {
    deps.taskStore!.insert(makeTask({
      taskId: "other-task",
      fromAgentId: "worker-1",
      toAgentId: "worker-2",
      state: "input-required",
    }));

    const result = await tool.execute(
      "test-call-id",
      { taskId: "other-task", response: "Hi", agentId: "test-agent" }
    );
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Permission denied");
    expect(result.content[0].text).toContain("worker-2");
  });

  it("rejects when task is not in input-required state", async () => {
    deps.taskStore!.insert(makeTask({
      taskId: "working-task",
      fromAgentId: "worker-1",
      toAgentId: "test-agent",
      state: "working",
    }));

    const result = await tool.execute(
      "test-call-id",
      { taskId: "working-task", response: "Hi", agentId: "test-agent" }
    );
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain('"working"');
    expect(result.content[0].text).toContain("input-required");
  });

  it("returns error when task store not available", async () => {
    const noStore = makeDeps({ taskStore: undefined });
    const tools = collectTools(noStore);
    const noStoreTool = tools.get("flock_task_respond")!;
    const result = await noStoreTool.execute(
      "test-call-id",
      { taskId: "x", response: "y" }
    );
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Task store not available");
  });

  it("sends A2A follow-up to the original requester", async () => {
    const sendA2AMock = vi.fn().mockResolvedValue({
      taskId: "followup-task",
      state: "completed",
      response: "OK",
      artifacts: [],
      raw: { kind: "task", id: "followup-task", contextId: "ctx", status: { state: "completed" } },
    });
    const localDeps = makeDeps({
      a2aClient: { sendA2A: sendA2AMock } as unknown as A2AClient,
    });
    const tools = collectTools(localDeps);
    const localTool = tools.get("flock_task_respond")!;

    localDeps.taskStore!.insert(makeTask({
      taskId: "ir-followup",
      fromAgentId: "worker-1",
      toAgentId: "test-agent",
      state: "input-required",
    }));

    await localTool.execute(
      "test-call-id",
      { taskId: "ir-followup", response: "Here is the info you needed.", agentId: "test-agent" }
    );

    // Verify A2A follow-up was sent to the original requester (fromAgentId)
    expect(sendA2AMock).toHaveBeenCalledWith(
      "worker-1",
      expect.objectContaining({ message: expect.anything() }),
    );
  });

  it("succeeds even without A2A client (no follow-up sent)", async () => {
    const noClientDeps = makeDeps({ a2aClient: undefined });
    const tools = collectTools(noClientDeps);
    const noClientTool = tools.get("flock_task_respond")!;

    noClientDeps.taskStore!.insert(makeTask({
      taskId: "ir-no-client",
      fromAgentId: "worker-1",
      toAgentId: "test-agent",
      state: "input-required",
    }));

    const result = await noClientTool.execute(
      "test-call-id",
      { taskId: "ir-no-client", response: "My response", agentId: "test-agent" }
    );

    expect(result.details?.ok).toBe(true);
    expect(result.details?.state).toBe("working");
  });

  it("records audit entry on success", async () => {
    deps.taskStore!.insert(makeTask({
      taskId: "audit-task",
      fromAgentId: "worker-1",
      toAgentId: "test-agent",
      state: "input-required",
    }));

    await tool.execute(
      "test-call-id",
      { taskId: "audit-task", response: "Answered", agentId: "test-agent" }
    );

    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task-respond",
        level: "GREEN",
      }),
    );
  });
});

// --- flock_message (async) ---

describe("flock_message (async)", () => {
  let tool: ToolDefinition;
  let deps: ToolDeps;
  let sendA2AMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendA2AMock = vi.fn().mockResolvedValue({
      taskId: "a2a-task-id",
      state: "completed",
      response: "Task completed successfully",
      artifacts: [],
      raw: { kind: "task", id: "a2a-task-id", contextId: "ctx", status: { state: "completed" } },
    });
    deps = makeDeps({
      a2aClient: {
        sendA2A: sendA2AMock,
      } as unknown as A2AClient,
    });
    const tools = collectTools(deps);
    tool = tools.get("flock_message")!;
    expect(tool).toBeDefined();
  });

  it("returns immediately with submitted state (non-blocking)", async () => {
    const result = await tool.execute(
      "test-call-id",
      {
        to: "worker-1",
        message: "How do I do X?",
        agentId: "test-agent"
      }
    );

    expect(result.details?.ok).toBe(true);
    expect(result.details?.state).toBe("submitted");
    expect(result.details?.taskId).toBeTypeOf("string");
    expect(result.details?.to).toBe("worker-1");
    expect(result.content[0].text).toContain("submitted");
    expect(result.content[0].text).toContain("flock_tasks");
  });

  it("records task in TaskStore as submitted", async () => {
    // Use a pending promise so the background .then() doesn't fire during this test
    sendA2AMock.mockReturnValueOnce(new Promise(() => {}));

    const result = await tool.execute(
      "test-call-id",
      {
        to: "worker-1",
        message: "How do I do X?",
        agentId: "test-agent"
      }
    );

    const taskId = result.details!.taskId as string;
    const task = deps.taskStore!.get(taskId);
    expect(task).not.toBeNull();
    expect(task!.state).toBe("submitted");
    expect(task!.fromAgentId).toBe("test-agent");
    expect(task!.toAgentId).toBe("worker-1");
    expect(task!.messageType).toBe("message");
  });

  it("fires A2A sendA2A in the background", async () => {
    await tool.execute(
      "test-call-id",
      {
        to: "worker-1",
        message: "How do I do X?",
        agentId: "test-agent"
      }
    );

    expect(sendA2AMock).toHaveBeenCalledWith(
      "worker-1",
      expect.objectContaining({ message: expect.anything() }),
    );
  });

  it("updates TaskStore to completed when background A2A succeeds", async () => {
    const result = await tool.execute(
      "test-call-id",
      {
        to: "worker-1",
        message: "How do I do X?",
        agentId: "test-agent"
      }
    );

    const taskId = result.details!.taskId as string;

    // Flush microtask queue so the background .then() runs
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    const task = deps.taskStore!.get(taskId);
    expect(task!.state).toBe("completed");
    expect(task!.responseText).toBe("Task completed successfully");
    expect(task!.completedAt).toBeTypeOf("number");
  });

  it("updates TaskStore to failed when background A2A rejects", async () => {
    sendA2AMock.mockRejectedValueOnce(new Error("network timeout"));

    const result = await tool.execute(
      "test-call-id",
      {
        to: "worker-1",
        message: "How do I do X?",
        agentId: "test-agent"
      }
    );

    expect(result.details?.ok).toBe(true); // Still returns ok — fire-and-forget
    expect(result.details?.state).toBe("submitted");

    const taskId = result.details!.taskId as string;

    // Flush microtask queue so the background .catch() runs
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    const task = deps.taskStore!.get(taskId);
    expect(task!.state).toBe("failed");
    expect(task!.responseText).toContain("network timeout");
  });

  it("returns error when A2A transport not initialized", async () => {
    const noTransport = makeDeps({ a2aClient: undefined, a2aServer: undefined });
    const tools = collectTools(noTransport);
    const noTool = tools.get("flock_message")!;

    const result = await noTool.execute(
      "test-call-id",
      { to: "worker-1", message: "Help me", agentId: "test-agent" }
    );

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("A2A transport not initialized");
  });

  it("returns error when required params missing", async () => {
    const result = await tool.execute(
      "test-call-id",
      { message: "No target specified", agentId: "test-agent" }
    );

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("'to' is required");
  });

  it("attaches contextData as A2A DataPart", async () => {
    await tool.execute(
      "test-call-id",
      {
        to: "worker-1",
        message: "Process this data",
        contextData: { fileId: "abc-123", priority: "high" },
        agentId: "test-agent"
      }
    );

    expect(sendA2AMock).toHaveBeenCalledWith(
      "worker-1",
      expect.objectContaining({
        message: expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({ kind: "data", data: expect.objectContaining({ fileId: "abc-123" }) }),
          ]),
        }),
      }),
    );
  });
});

// --- Tool registration ---

describe("registerFlockTools", () => {
  it("registers all 11 tools including Phase 2 tools", () => {
    const deps = makeDeps();
    const tools = collectTools(deps);

    // Phase 1 tools
    expect(tools.has("flock_status")).toBe(true);
    expect(tools.has("flock_lease")).toBe(true);
    expect(tools.has("flock_audit")).toBe(true);
    expect(tools.has("flock_provision")).toBe(true);
    expect(tools.has("flock_sysadmin_protocol")).toBe(true);
    expect(tools.has("flock_sysadmin_request")).toBe(true);
    expect(tools.has("flock_message")).toBe(true);

    // Phase 2 tools — channel-based
    expect(tools.has("flock_channel_create")).toBe(true);
    expect(tools.has("flock_channel_post")).toBe(true);
    expect(tools.has("flock_channel_read")).toBe(true);
    expect(tools.has("flock_channel_list")).toBe(true);
    expect(tools.has("flock_assign_members")).toBe(true);
    expect(tools.has("flock_channel_archive")).toBe(true);
    expect(tools.has("flock_discover")).toBe(true);
    expect(tools.has("flock_history")).toBe(true);
    expect(tools.has("flock_tasks")).toBe(true);
    expect(tools.has("flock_task_respond")).toBe(true);
    expect(tools.has("flock_update_card")).toBe(true);
    expect(tools.has("flock_bridge")).toBe(true);

    expect(tools.has("flock_archive_ready")).toBe(true);

    expect(tools.size).toBe(25); // 24 + flock_archive_ready (archive protocol readiness)
  });
});
