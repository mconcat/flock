/**
 * Tests for agent lifecycle tools: flock_create_agent, flock_decommission_agent
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerFlockTools } from "../../src/tools/index.js";
import type { ToolDeps } from "../../src/tools/index.js";
import type { PluginApi, ToolDefinition, PluginLogger } from "../../src/types.js";
import type { FlockConfig } from "../../src/config.js";
import type { HomeManager } from "../../src/homes/manager.js";
import type { HomeProvisioner } from "../../src/homes/provisioner.js";
import type { AuditLog } from "../../src/audit/log.js";
import type { A2AServer } from "../../src/transport/server.js";
import { CardRegistry, createAgentCard, buildFlockMetadata } from "../../src/transport/agent-card.js";
import type { CreateCardParams } from "../../src/transport/agent-card.js";
import { createMemoryDatabase } from "../../src/db/memory.js";

// --- Helpers ---

function makeCardRegistry(): CardRegistry {
  const registry = new CardRegistry();

  // Register an orchestrator agent (callers need this for authorization)
  const orchestratorParams: CreateCardParams = {
    agentId: "orchestrator",
    nodeId: "node-1",
    role: "orchestrator",
    endpointUrl: "http://localhost:3779/flock/a2a/orchestrator",
  };
  registry.register("orchestrator", createAgentCard(orchestratorParams), buildFlockMetadata(orchestratorParams));

  // Register a sysadmin agent
  const sysadminParams: CreateCardParams = {
    agentId: "sysadmin",
    nodeId: "node-1",
    role: "sysadmin",
    endpointUrl: "http://localhost:3779/flock/a2a/sysadmin",
  };
  registry.register("sysadmin", createAgentCard(sysadminParams), buildFlockMetadata(sysadminParams));

  // Register a worker agent
  const workerParams: CreateCardParams = {
    agentId: "worker-1",
    nodeId: "node-1",
    role: "worker",
    name: "Worker One",
    description: "A general-purpose worker agent",
    skills: [],
    endpointUrl: "http://localhost:3779/flock/a2a/worker-1",
  };
  registry.register("worker-1", createAgentCard(workerParams), buildFlockMetadata(workerParams));

  return registry;
}

/** Collect registered tools from registerFlockTools. */
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
        // Factory pattern: call with a mock context that includes agentId
        // The actual agentId will be set per-test via params.agentId (legacy path)
        const resolved = tool({});
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

function makeA2AServer(registry: CardRegistry) {
  return {
    cardRegistry: registry,
    getAgentMeta: (agentId: string) => registry.getMeta(agentId),
    hasAgent: (agentId: string) => registry.has(agentId),
    registerAgent: vi.fn((agentId, card, meta, _executor) => {
      registry.register(agentId, card, meta);
    }),
    unregisterAgent: vi.fn((agentId: string) => {
      registry.remove(agentId);
    }),
  } as unknown as A2AServer;
}

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  const db = createMemoryDatabase();
  const registry = makeCardRegistry();
  return {
    config: {
      dataDir: "/tmp/flock-test",
      dbBackend: "memory",
      nodeId: "node-1",
      gateway: { port: 3779, token: "test-token" },
      homes: { rootDir: "/tmp/flock-homes", baseDir: "/tmp/flock-base" },
      sysadmin: { enabled: true, autoGreen: true },
      economy: { enabled: false, initialBalance: 1000 },
      topology: "peer",
      remoteNodes: [],
      testAgents: [],
      gatewayAgents: [],
    } as FlockConfig,
    homes: {
      get: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      create: vi.fn(),
      transition: vi.fn(),
      setLeaseExpiry: vi.fn(),
    } as unknown as HomeManager,
    audit: {
      append: vi.fn(),
      query: vi.fn().mockReturnValue([]),
      count: vi.fn().mockReturnValue(0),
    } as unknown as AuditLog,
    provisioner: {
      provision: vi.fn().mockReturnValue({
        homeId: "test@node-1",
        homePath: "/tmp/flock-homes/test",
        baseVersion: "1.0.0",
        directories: ["base", "node", "agent", "work", "run", "log", "audit", "secrets"],
        bindMounts: [],
      }),
      exists: vi.fn().mockReturnValue(false),
      homePath: vi.fn().mockReturnValue("/tmp/flock-homes/test"),
      cleanRuntime: vi.fn(),
      remove: vi.fn(),
    } as unknown as HomeProvisioner,
    a2aServer: makeA2AServer(registry),
    taskStore: db.tasks,
    logger: makeLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// flock_create_agent
// ---------------------------------------------------------------------------

describe("flock_create_agent", () => {
  let tool: ToolDefinition;
  let deps: ToolDeps;

  beforeEach(() => {
    deps = makeDeps();
    const tools = collectTools(deps);
    tool = tools.get("flock_create_agent")!;
    expect(tool).toBeDefined();
  });

  it("successfully creates a worker agent", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",       // caller (OpenClaw-injected)
      newAgentId: "new-worker",  // new agent to create
      role: "worker",
    });

    expect(result.details?.ok).toBe(true);
    expect(result.details?.agentId).toBe("new-worker");
    expect(result.details?.role).toBe("worker");
    expect(result.details?.nodeId).toBe("node-1");
    expect(result.content[0].text).toContain("Agent Created: new-worker");

    // Verify A2A server registration was called
    expect(deps.a2aServer!.registerAgent).toHaveBeenCalledWith(
      "new-worker",
      expect.objectContaining({ name: "new-worker" }),
      expect.objectContaining({ role: "worker", nodeId: "node-1" }),
      expect.anything(),
    );

    // Verify provisioner was called (with role/archetype options)
    expect(deps.provisioner.provision).toHaveBeenCalledWith("new-worker", "node-1", {
      role: "worker",
      archetype: undefined,
    });

    // Verify audit log
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent-create",
        level: "GREEN",
        agentId: "orchestrator",
      }),
    );
  });

  it("successfully creates a sysadmin agent", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",
      newAgentId: "new-sysadmin",
      role: "sysadmin",
    });

    expect(result.details?.ok).toBe(true);
    expect(result.details?.agentId).toBe("new-sysadmin");
    expect(result.details?.role).toBe("sysadmin");

    // Sysadmin cards have special skills (triage)
    expect(deps.a2aServer!.registerAgent).toHaveBeenCalledWith(
      "new-sysadmin",
      expect.objectContaining({
        skills: expect.arrayContaining([
          expect.objectContaining({ id: "sysadmin-triage" }),
        ]),
      }),
      expect.objectContaining({ role: "sysadmin" }),
      expect.anything(),
    );
  });

  it("rejects non-orchestrator callers (worker)", async () => {
    const result = await tool.execute("test-call", {
      agentId: "worker-1",       // caller is a worker
      newAgentId: "new-agent",
      role: "worker",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Permission denied");
    expect(result.content[0].text).toContain("worker-1");
  });

  it("rejects sysadmin callers (only orchestrator can create)", async () => {
    const result = await tool.execute("test-call", {
      agentId: "sysadmin",       // caller is a sysadmin, not orchestrator
      newAgentId: "new-agent",
      role: "worker",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Permission denied");
    expect(result.content[0].text).toContain("sysadmin");
  });

  it("rejects duplicate agent IDs", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",
      newAgentId: "worker-1",     // already exists in registry
      role: "worker",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("already exists");
    expect(result.content[0].text).toContain("worker-1");
  });

  it("rejects missing required params — no newAgentId", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",
      role: "worker",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("newAgentId is required");
  });

  it("rejects missing required params — no role", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",
      newAgentId: "new-agent",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("role must be");
  });

  it("rejects invalid agent ID format", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",
      newAgentId: "../../../etc/passwd",
      role: "worker",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("invalid");
  });

  it("uses system prompt when provided", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",
      newAgentId: "custom-agent",
      role: "worker",
      systemPrompt: "You are a custom agent.",
    });

    expect(result.details?.ok).toBe(true);
    expect(result.details?.agentId).toBe("custom-agent");
  });

  it("returns error when A2A server not initialized", async () => {
    const noServer = makeDeps({ a2aServer: undefined });
    const tools = collectTools(noServer);
    const noServerTool = tools.get("flock_create_agent")!;

    const result = await noServerTool.execute("test-call", {
      agentId: "orchestrator",
      newAgentId: "new-agent",
      role: "worker",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("A2A server not initialized");
  });

  it("returns error when gateway token not configured", async () => {
    const noToken = makeDeps({
      config: {
        dataDir: "/tmp/flock-test",
        dbBackend: "memory",
        nodeId: "node-1",
        gateway: { port: 3779, token: "" },
        homes: { rootDir: "/tmp/flock-homes", baseDir: "/tmp/flock-base" },
        sysadmin: { enabled: true, autoGreen: true },
        economy: { enabled: false, initialBalance: 1000 },
        topology: "peer",
        remoteNodes: [],
        testAgents: [],
        gatewayAgents: [],
      } as FlockConfig,
    });
    const tools = collectTools(noToken);
    const noTokenTool = tools.get("flock_create_agent")!;

    const result = await noTokenTool.execute("test-call", {
      agentId: "orchestrator",
      newAgentId: "new-agent",
      role: "worker",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Gateway token not configured");
  });

  it("returns error when logger not available", async () => {
    const noLogger = makeDeps({ logger: undefined });
    const tools = collectTools(noLogger);
    const noLoggerTool = tools.get("flock_create_agent")!;

    const result = await noLoggerTool.execute("test-call", {
      agentId: "orchestrator",
      newAgentId: "new-agent",
      role: "worker",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Logger not available");
  });

  it("succeeds even if provisioner fails (non-fatal)", async () => {
    const failingProvisioner = {
      provision: vi.fn().mockImplementation(() => { throw new Error("disk full"); }),
      exists: vi.fn().mockReturnValue(false),
      homePath: vi.fn(),
      cleanRuntime: vi.fn(),
      remove: vi.fn(),
    } as unknown as HomeProvisioner;
    const depsWithBadProvisioner = makeDeps({ provisioner: failingProvisioner });
    const tools = collectTools(depsWithBadProvisioner);
    const badProvTool = tools.get("flock_create_agent")!;

    const result = await badProvTool.execute("test-call", {
      agentId: "orchestrator",
      newAgentId: "new-worker",
      role: "worker",
    });

    expect(result.details?.ok).toBe(true);
    expect(result.details?.agentId).toBe("new-worker");
    const warnings = result.details?.warnings as string[];
    expect(warnings.some(w => w.includes("disk full"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// flock_decommission_agent
// ---------------------------------------------------------------------------

describe("flock_decommission_agent", () => {
  let tool: ToolDefinition;
  let deps: ToolDeps;

  beforeEach(() => {
    deps = makeDeps();
    const tools = collectTools(deps);
    tool = tools.get("flock_decommission_agent")!;
    expect(tool).toBeDefined();
  });

  it("successfully decommissions an agent", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",           // caller
      targetAgentId: "worker-1",     // target to decommission
      reason: "No longer needed",
    });

    expect(result.details?.ok).toBe(true);
    expect(result.details?.agentId).toBe("worker-1");
    expect(result.details?.reason).toBe("No longer needed");
    expect(result.content[0].text).toContain("Agent Decommissioned: worker-1");

    // Verify unregistration
    expect(deps.a2aServer!.unregisterAgent).toHaveBeenCalledWith("worker-1");

    // Verify audit log
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent-decommission",
        level: "YELLOW",
        agentId: "orchestrator",
      }),
    );

    // Agent should no longer exist in registry
    expect(deps.a2aServer!.hasAgent("worker-1")).toBe(false);
  });

  it("rejects non-orchestrator callers (worker)", async () => {
    const result = await tool.execute("test-call", {
      agentId: "worker-1",           // caller is a worker
      targetAgentId: "sysadmin",
      reason: "Testing",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Permission denied");
    expect(result.content[0].text).toContain("worker-1");
  });

  it("rejects sysadmin callers (only orchestrator can decommission)", async () => {
    const result = await tool.execute("test-call", {
      agentId: "sysadmin",           // caller is sysadmin, not orchestrator
      targetAgentId: "worker-1",
      reason: "Testing",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Permission denied");
    expect(result.content[0].text).toContain("sysadmin");
  });

  it("prevents self-decommissioning", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",
      targetAgentId: "orchestrator",
      reason: "Trying to decommission self",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Cannot decommission yourself");
  });

  it("rejects agent not found", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",
      targetAgentId: "nonexistent-agent",
      reason: "Doesn't exist",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("not found");
    expect(result.content[0].text).toContain("nonexistent-agent");
  });

  it("rejects missing targetAgentId", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",
      reason: "Missing target",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("targetAgentId is required");
  });

  it("rejects missing reason", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",
      targetAgentId: "worker-1",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("reason is required");
  });

  it("updates home state to RETIRED if home exists", async () => {
    const homesWithGet = {
      get: vi.fn().mockReturnValue({ homeId: "worker-1@node-1", state: "IDLE" }),
      list: vi.fn().mockReturnValue([]),
      create: vi.fn(),
      transition: vi.fn(),
      setLeaseExpiry: vi.fn(),
    } as unknown as HomeManager;
    const depsWithHome = makeDeps({ homes: homesWithGet });
    const tools = collectTools(depsWithHome);
    const toolWithHome = tools.get("flock_decommission_agent")!;

    await toolWithHome.execute("test-call", {
      agentId: "orchestrator",
      targetAgentId: "worker-1",
      reason: "Retiring the agent",
    });

    expect(homesWithGet.transition).toHaveBeenCalledWith(
      "worker-1@node-1",
      "RETIRED",
      "Retiring the agent",
      "orchestrator",
    );
  });

  it("returns error when A2A server not initialized", async () => {
    const noServer = makeDeps({ a2aServer: undefined });
    const tools = collectTools(noServer);
    const noServerTool = tools.get("flock_decommission_agent")!;

    const result = await noServerTool.execute("test-call", {
      agentId: "orchestrator",
      targetAgentId: "worker-1",
      reason: "Test",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("A2A server not initialized");
  });
});

// ---------------------------------------------------------------------------
// flock_restart_gateway
// ---------------------------------------------------------------------------

describe("flock_restart_gateway", () => {
  let tool: ToolDefinition;
  let deps: ToolDeps;

  beforeEach(() => {
    deps = makeDeps();
    const tools = collectTools(deps);
    tool = tools.get("flock_restart_gateway")!;
    expect(tool).toBeDefined();
  });

  it("allows sysadmin to restart gateway", async () => {
    // Mock process.kill to prevent actual signal
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await tool.execute("test-call", {
      agentId: "sysadmin",
    });

    expect(result.details?.ok).toBe(true);
    expect(result.content[0].text).toContain("SIGUSR1");
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");

    // Verify audit log
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "gateway-restart",
        level: "YELLOW",
        agentId: "sysadmin",
      }),
    );

    killSpy.mockRestore();
  });

  it("rejects orchestrator callers (infrastructure is sysadmin-only)", async () => {
    const result = await tool.execute("test-call", {
      agentId: "orchestrator",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Permission denied");
  });

  it("rejects worker callers", async () => {
    const result = await tool.execute("test-call", {
      agentId: "worker-1",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("Permission denied");
    expect(result.content[0].text).toContain("worker-1");
  });

  it("returns error when A2A server not initialized", async () => {
    const noServer = makeDeps({ a2aServer: undefined });
    const tools = collectTools(noServer);
    const noServerTool = tools.get("flock_restart_gateway")!;

    const result = await noServerTool.execute("test-call", {
      agentId: "sysadmin",
    });

    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("A2A server not initialized");
  });
});

// ---------------------------------------------------------------------------
// Tool registration includes lifecycle tools
// ---------------------------------------------------------------------------

describe("registerFlockTools includes lifecycle tools", () => {
  it("registers flock_create_agent, flock_decommission_agent, and flock_restart_gateway", () => {
    const deps = makeDeps();
    const tools = collectTools(deps);

    expect(tools.has("flock_create_agent")).toBe(true);
    expect(tools.has("flock_decommission_agent")).toBe(true);
    expect(tools.has("flock_restart_gateway")).toBe(true);
  });
});
