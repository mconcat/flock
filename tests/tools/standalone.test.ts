import { describe, it, expect } from "vitest";
import { buildStandaloneTools } from "../../src/tools/standalone.js";
import type { ToolDeps } from "../../src/tools/index.js";
import type { ToolDefinition, ToolResultOC } from "../../src/types.js";

function makeMockDeps(): ToolDeps {
  return {
    config: {
      dataDir: ".flock",
      dbBackend: "memory",
      topology: "peer",
      nodeId: "local",
      remoteNodes: [],
      homes: { rootDir: "/tmp/homes", baseDir: "/tmp/base" },
      sysadmin: { enabled: false, autoGreen: true },
      economy: { enabled: false, initialBalance: 1000 },
      testAgents: [],
      gatewayAgents: [],
      orchestratorIds: [],
      gateway: { port: 3779, token: "" },
      vaultsBasePath: "/tmp/vaults",
    },
    // These are unused by simpleTool — typed stubs for ToolDeps interface.
    homes: {
      create: () => { throw new Error("not implemented"); },
      get: () => null,
      list: () => [],
      transition: () => { throw new Error("not implemented"); },
      history: () => [],
    } as ToolDeps["homes"],
    audit: {
      append: () => {},
      query: () => [],
      recent: () => [],
    } as ToolDeps["audit"],
    provisioner: {
      provision: () => { throw new Error("not implemented"); },
      syncToOpenClawWorkspace: () => {},
    } as ToolDeps["provisioner"],
  };
}

function simpleTool(name: string): (deps: ToolDeps) => ToolDefinition {
  return (_deps) => ({
    name,
    description: `Test tool ${name}`,
    parameters: { type: "object", properties: {} },
    async execute(_id, params): Promise<ToolResultOC> {
      return {
        content: [{ type: "text", text: `called ${name} by ${params._callerAgentId}` }],
      };
    },
  });
}

describe("buildStandaloneTools", () => {
  it("converts ToolDefinitions to AgentTools", () => {
    const tools = buildStandaloneTools(
      makeMockDeps(),
      "agent-1",
      [simpleTool("tool_a"), simpleTool("tool_b")],
    );
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("tool_a");
    expect(tools[1].name).toBe("tool_b");
  });

  it("injects agentId into tool calls", async () => {
    const tools = buildStandaloneTools(
      makeMockDeps(),
      "my-agent",
      [simpleTool("test_tool")],
    );
    const result = await tools[0].execute("call-1", {});
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { type: "text"; text: string }).text).toBe(
      "called test_tool by my-agent",
    );
  });

  it("handles empty creators array", () => {
    const tools = buildStandaloneTools(makeMockDeps(), "agent-1", []);
    expect(tools).toEqual([]);
  });

  it("handles creators that return arrays", () => {
    const multiCreator = (_deps: ToolDeps): ToolDefinition[] => [
      {
        name: "multi_a",
        description: "A",
        parameters: { type: "object", properties: {} },
        async execute(): Promise<ToolResultOC> {
          return { content: [{ type: "text", text: "a" }] };
        },
      },
      {
        name: "multi_b",
        description: "B",
        parameters: { type: "object", properties: {} },
        async execute(): Promise<ToolResultOC> {
          return { content: [{ type: "text", text: "b" }] };
        },
      },
    ];

    const tools = buildStandaloneTools(
      makeMockDeps(),
      "agent-1",
      [multiCreator],
    );
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("multi_a");
    expect(tools[1].name).toBe("multi_b");
  });
});
