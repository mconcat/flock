import { describe, it, expect } from "vitest";
import { toAgentTool, toAgentTools } from "../src/tool-adapter.js";
import type { ToolDefinition, ToolResultOC } from "../src/types.js";

function makeTool(overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: "test_tool",
    description: "A test tool",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message" },
      },
      required: ["message"],
    },
    async execute(_toolCallId, params): Promise<ToolResultOC> {
      return {
        content: [{ type: "text", text: `echo: ${params.message}` }],
        details: { received: params },
      };
    },
    ...overrides,
  };
}

describe("toAgentTool", () => {
  it("preserves name and description", () => {
    const tool = makeTool({ name: "my_tool", description: "Does things" });
    const agentTool = toAgentTool(tool);
    expect(agentTool.name).toBe("my_tool");
    expect(agentTool.description).toBe("Does things");
  });

  it("uses label from ToolDefinition if present", () => {
    const tool = makeTool({ label: "My Tool Label" });
    const agentTool = toAgentTool(tool);
    expect(agentTool.label).toBe("My Tool Label");
  });

  it("falls back to name for label", () => {
    const tool = makeTool({ name: "fallback_name" });
    delete (tool as Record<string, unknown>).label;
    const agentTool = toAgentTool(tool);
    expect(agentTool.label).toBe("fallback_name");
  });

  it("converts parameters to TypeBox schema", () => {
    const tool = makeTool();
    const agentTool = toAgentTool(tool);
    // The schema should preserve the JSON Schema structure
    const schema = agentTool.parameters as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
  });

  it("execute returns AgentToolResult format", async () => {
    const tool = makeTool();
    const agentTool = toAgentTool(tool);
    const result = await agentTool.execute("call-1", { message: "hello" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { type: "text"; text: string }).text).toBe("echo: hello");
    expect(result.details).toEqual({ received: { message: "hello" } });
  });

  it("handles missing details in ToolResultOC", async () => {
    const tool = makeTool({
      async execute(): Promise<ToolResultOC> {
        return { content: [{ type: "text", text: "no details" }] };
      },
    });
    const agentTool = toAgentTool(tool);
    const result = await agentTool.execute("call-2", {});
    expect(result.details).toEqual({});
  });

  it("passes signal through to underlying tool", async () => {
    let receivedSignal: AbortSignal | undefined;
    const tool = makeTool({
      async execute(_id, _params, signal): Promise<ToolResultOC> {
        receivedSignal = signal;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const agentTool = toAgentTool(tool);
    const controller = new AbortController();
    await agentTool.execute("call-3", {}, controller.signal);
    expect(receivedSignal).toBe(controller.signal);
  });

  it("handles null/undefined params gracefully", async () => {
    const tool = makeTool({
      async execute(_id, params): Promise<ToolResultOC> {
        return { content: [{ type: "text", text: JSON.stringify(params) }] };
      },
    });
    const agentTool = toAgentTool(tool);
    // pi-agent-core may pass undefined/null params for tools with no parameters
    const result = await agentTool.execute("call-4", undefined as unknown);
    expect(result.content[0].type).toBe("text");
  });
});

describe("toAgentTools", () => {
  it("converts array of ToolDefinitions", () => {
    const tools = [
      makeTool({ name: "tool_a" }),
      makeTool({ name: "tool_b" }),
    ];
    const agentTools = toAgentTools(tools);
    expect(agentTools).toHaveLength(2);
    expect(agentTools[0].name).toBe("tool_a");
    expect(agentTools[1].name).toBe("tool_b");
  });

  it("handles empty array", () => {
    expect(toAgentTools([])).toEqual([]);
  });
});
