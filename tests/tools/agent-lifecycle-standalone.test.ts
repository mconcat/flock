import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createStandaloneCreateAgentTool,
  createStandaloneDecommissionAgentTool,
  createStandaloneRestartTool,
} from "../../src/tools/agent-lifecycle-standalone.js";
import type { ToolDeps } from "../../src/tools/index.js";
import type { SessionSendFn } from "../../src/transport/executor.js";
import { createMockA2AServer } from "../helpers/mock-a2a-server.js";

function makeDeps(overrides?: Partial<ToolDeps>): ToolDeps {
  return {
    config: {
      dataDir: ".flock",
      dbBackend: "memory",
      topology: "peer",
      nodeId: "test-node",
      remoteNodes: [],
      homes: { rootDir: "/tmp/homes", baseDir: "/tmp/base" },
      sysadmin: { enabled: false, autoGreen: true },
      economy: { enabled: false, initialBalance: 1000 },
      testAgents: [],
      gatewayAgents: [],
      orchestratorIds: [],
      gateway: { port: 3779, token: "test" },
      vaultsBasePath: "/tmp/vaults",
    },
    homes: {
      create: () => { throw new Error("not implemented"); },
      get: () => null,
      list: () => [],
      transition: vi.fn(),
      history: () => [],
    } as ToolDeps["homes"],
    audit: {
      append: vi.fn(),
      query: () => [],
      recent: () => [],
    } as ToolDeps["audit"],
    provisioner: {
      provision: () => { throw new Error("not implemented"); },
      syncToOpenClawWorkspace: () => {},
    } as ToolDeps["provisioner"],
    a2aServer: createMockA2AServer({ "orchestrator-1": { role: "orchestrator" } }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

const mockSessionSend: SessionSendFn = vi.fn().mockResolvedValue("ok");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createStandaloneCreateAgentTool", () => {
  let tmpDir: string;
  const origEnv = process.env.FLOCK_CONFIG;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flock-lifecycle-test-"));
    const configPath = path.join(tmpDir, "flock.json");
    fs.writeFileSync(configPath, JSON.stringify({ gatewayAgents: [] }));
    process.env.FLOCK_CONFIG = configPath;
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.FLOCK_CONFIG = origEnv;
    } else {
      delete process.env.FLOCK_CONFIG;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates an agent when called by orchestrator", async () => {
    const deps = makeDeps();
    const tool = createStandaloneCreateAgentTool(deps, mockSessionSend);

    const result = await tool.execute("call-1", {
      _callerAgentId: "orchestrator-1",
      newAgentId: "new-worker",
      role: "worker",
    });

    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Agent Created: new-worker");
    expect(deps.a2aServer!.hasAgent("new-worker")).toBe(true);
  });

  it("rejects non-orchestrator callers", async () => {
    const deps = makeDeps();
    const tool = createStandaloneCreateAgentTool(deps, mockSessionSend);

    const result = await tool.execute("call-1", {
      _callerAgentId: "random-worker",
      newAgentId: "new-agent",
      role: "worker",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Permission denied");
  });

  it("rejects invalid agent ID", async () => {
    const deps = makeDeps();
    const tool = createStandaloneCreateAgentTool(deps, mockSessionSend);

    const result = await tool.execute("call-1", {
      _callerAgentId: "orchestrator-1",
      newAgentId: "../escape",
      role: "worker",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text.toLowerCase()).toContain("invalid");
  });

  it("persists to flock.json", async () => {
    const deps = makeDeps();
    const tool = createStandaloneCreateAgentTool(deps, mockSessionSend);

    await tool.execute("call-1", {
      _callerAgentId: "orchestrator-1",
      newAgentId: "persist-agent",
      role: "sysadmin",
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const config = JSON.parse(fs.readFileSync(process.env.FLOCK_CONFIG!, "utf-8"));
    expect(config.gatewayAgents).toHaveLength(1);
    expect(config.gatewayAgents[0].id).toBe("persist-agent");
    expect(config.gatewayAgents[0].role).toBe("sysadmin");
    expect(config.gatewayAgents[0].model).toBe("anthropic/claude-sonnet-4-20250514");
  });
});

describe("createStandaloneDecommissionAgentTool", () => {
  it("decommissions an existing agent", async () => {
    const a2a = createMockA2AServer({
      "orchestrator-1": { role: "orchestrator" },
      "victim": { role: "worker" },
    });
    const deps = makeDeps({ a2aServer: a2a });
    const tool = createStandaloneDecommissionAgentTool(deps);

    const result = await tool.execute("call-1", {
      _callerAgentId: "orchestrator-1",
      targetAgentId: "victim",
      reason: "no longer needed",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Decommissioned: victim");
    expect(a2a.hasAgent("victim")).toBe(false);
  });

  it("rejects self-decommission", async () => {
    const deps = makeDeps();
    const tool = createStandaloneDecommissionAgentTool(deps);

    const result = await tool.execute("call-1", {
      _callerAgentId: "orchestrator-1",
      targetAgentId: "orchestrator-1",
      reason: "test",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Cannot decommission yourself");
  });
});

describe("createStandaloneRestartTool", () => {
  it("rejects non-sysadmin callers", async () => {
    const deps = makeDeps();
    const tool = createStandaloneRestartTool(deps);

    const result = await tool.execute("call-1", {
      _callerAgentId: "orchestrator-1",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Permission denied");
  });

  it("allows sysadmin callers", async () => {
    const a2a = createMockA2AServer({
      "sysadmin-1": { role: "sysadmin" },
    });
    const deps = makeDeps({ a2aServer: a2a });
    const tool = createStandaloneRestartTool(deps);

    // Mock process.kill to prevent actual signal
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);

    const result = await tool.execute("call-1", {
      _callerAgentId: "sysadmin-1",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("restart initiated");

    killSpy.mockRestore();
  });
});
