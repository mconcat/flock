/**
 * Tests for archive protocol — graceful wind-down before channel archival.
 *
 * Flow: flock_channel_archive (start protocol) → agents call flock_archive_ready
 *       → all agent members ready → auto-archive.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDatabase } from "../../src/db/memory.js";
import { registerFlockTools } from "../../src/tools/index.js";
import type { ToolDeps } from "../../src/tools/index.js";
import type { FlockConfig } from "../../src/config.js";
import type { HomeManager } from "../../src/homes/manager.js";
import type { HomeProvisioner } from "../../src/homes/provisioner.js";
import type { AuditLog } from "../../src/audit/log.js";
import type { PluginApi, ToolDefinition } from "../../src/types.js";
import type { FlockDatabase } from "../../src/db/interface.js";

/**
 * collectTools wraps tools with a specific agentId.
 * wrapToolWithAgentId in the production code overrides _callerAgentId from the
 * session context, so we must create different tool sets per agent.
 */
function collectTools(deps: ToolDeps, agentId = "test-agent"): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const api: PluginApi = {
    id: "flock",
    source: "test",
    config: {},
    pluginConfig: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool(tool: ToolDefinition | ((ctx: Record<string, unknown>) => ToolDefinition | ToolDefinition[] | null | undefined)) {
      if (typeof tool === "function") {
        const resolved = tool({ agentId });
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

/** Get a specific tool with a given agentId injected as _callerAgentId. */
function getToolAs(deps: ToolDeps, toolName: string, agentId: string): ToolDefinition {
  return collectTools(deps, agentId).get(toolName)!;
}

function makeDeps(db: FlockDatabase, sendExternal?: any): ToolDeps {
  return {
    config: { dataDir: "/tmp/flock-test", dbBackend: "memory" } as FlockConfig,
    homes: { get: vi.fn(), list: vi.fn(), create: vi.fn(), transition: vi.fn(), setLeaseExpiry: vi.fn() } as unknown as HomeManager,
    audit: { append: vi.fn(), query: vi.fn().mockReturnValue([]), count: vi.fn().mockReturnValue(0) } as unknown as AuditLog,
    provisioner: {} as HomeProvisioner,
    channelStore: db.channels,
    channelMessages: db.channelMessages,
    bridgeStore: db.bridges,
    sendExternal,
  };
}

describe("archive protocol", () => {
  let db: FlockDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    db.migrate();

    db.channels.insert({
      channelId: "project-alpha",
      name: "Project Alpha",
      topic: "Alpha project discussion",
      createdBy: "orchestrator",
      members: ["pm", "dev-code", "human:alice"],
      archived: false,
      archiveReadyMembers: [],
      archivingStartedAt: null,
      createdAt: 1000,
      updatedAt: 1000,
    });
  });

  it("starts archive protocol (default, no force)", async () => {
    const deps = makeDeps(db);
    const archiveTool = getToolAs(deps, "flock_channel_archive", "orchestrator");

    const result = await archiveTool.execute("call-1", {
      channelId: "project-alpha",
    });

    // Channel should NOT be archived yet
    const channel = db.channels.get("project-alpha")!;
    expect(channel.archived).toBe(false);
    expect(channel.archivingStartedAt).toBeTypeOf("number");
    expect(channel.archiveReadyMembers).toEqual([]);

    // System message posted
    const msgs = db.channelMessages.list({ channelId: "project-alpha" });
    expect(msgs.some(m => m.content.includes("Archive protocol started"))).toBe(true);

    // Output mentions archive_ready
    const output = (result as any)?.output ?? JSON.stringify(result);
    expect(output).toContain("archive_ready");
  });

  it("returns status when already archiving", async () => {
    const deps = makeDeps(db);
    const archiveTool = getToolAs(deps, "flock_channel_archive", "orchestrator");

    await archiveTool.execute("call-1", { channelId: "project-alpha" });

    // Call again — should return status, not restart
    const result = await archiveTool.execute("call-2", { channelId: "project-alpha" });

    const output = (result as any)?.output ?? JSON.stringify(result);
    expect(output).toContain("already in progress");
  });

  it("force=true archives immediately", async () => {
    const deps = makeDeps(db);
    const archiveTool = getToolAs(deps, "flock_channel_archive", "orchestrator");

    await archiveTool.execute("call-1", {
      channelId: "project-alpha",
      force: true,
    });

    expect(db.channels.get("project-alpha")?.archived).toBe(true);
  });

  it("flock_archive_ready signals readiness", async () => {
    const deps = makeDeps(db);
    const archiveTool = getToolAs(deps, "flock_channel_archive", "orchestrator");
    const readyToolPm = getToolAs(deps, "flock_archive_ready", "pm");

    await archiveTool.execute("call-1", { channelId: "project-alpha" });

    await readyToolPm.execute("call-2", { channelId: "project-alpha" });

    const channel = db.channels.get("project-alpha")!;
    expect(channel.archiveReadyMembers).toContain("pm");
    expect(channel.archived).toBe(false); // not all ready yet
  });

  it("duplicate ready signal is no-op", async () => {
    const deps = makeDeps(db);
    const archiveTool = getToolAs(deps, "flock_channel_archive", "orchestrator");
    const readyToolPm = getToolAs(deps, "flock_archive_ready", "pm");

    await archiveTool.execute("call-1", { channelId: "project-alpha" });
    await readyToolPm.execute("call-2", { channelId: "project-alpha" });

    const result = await readyToolPm.execute("call-3", { channelId: "project-alpha" });

    const output = (result as any)?.output ?? JSON.stringify(result);
    expect(output).toContain("already signaled");
    expect(db.channels.get("project-alpha")!.archiveReadyMembers).toEqual(["pm"]);
  });

  it("auto-archives when all agent members are ready", async () => {
    const deps = makeDeps(db);
    const archiveTool = getToolAs(deps, "flock_channel_archive", "orchestrator");
    const readyToolPm = getToolAs(deps, "flock_archive_ready", "pm");
    const readyToolDev = getToolAs(deps, "flock_archive_ready", "dev-code");

    await archiveTool.execute("call-1", { channelId: "project-alpha" });

    // pm signals ready
    await readyToolPm.execute("call-2", { channelId: "project-alpha" });
    expect(db.channels.get("project-alpha")!.archived).toBe(false);

    // dev-code signals ready — all agents now ready (human:alice excluded)
    const result = await readyToolDev.execute("call-3", { channelId: "project-alpha" });

    expect(db.channels.get("project-alpha")!.archived).toBe(true);
    const output = (result as any)?.output ?? JSON.stringify(result);
    expect(output).toContain("archived");
  });

  it("human members excluded from readiness check", async () => {
    // Channel with only one agent member + one human
    db.channels.insert({
      channelId: "small-ch",
      name: "Small",
      topic: "test",
      createdBy: "orchestrator",
      members: ["dev-code", "human:bob"],
      archived: false,
      archiveReadyMembers: [],
      archivingStartedAt: null,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const deps = makeDeps(db);
    const archiveTool = getToolAs(deps, "flock_channel_archive", "orchestrator");
    const readyToolDev = getToolAs(deps, "flock_archive_ready", "dev-code");

    await archiveTool.execute("call-1", { channelId: "small-ch" });

    // Only dev-code needs to signal — human:bob doesn't count
    await readyToolDev.execute("call-2", { channelId: "small-ch" });

    expect(db.channels.get("small-ch")!.archived).toBe(true);
  });

  it("rejects non-member archive_ready", async () => {
    const deps = makeDeps(db);
    const archiveTool = getToolAs(deps, "flock_channel_archive", "orchestrator");
    const readyToolOutsider = getToolAs(deps, "flock_archive_ready", "outsider-agent");

    await archiveTool.execute("call-1", { channelId: "project-alpha" });

    const result = await readyToolOutsider.execute("call-2", { channelId: "project-alpha" });

    const output = (result as any)?.output ?? JSON.stringify(result);
    expect(output).toContain("not a member");
  });

  it("rejects archive_ready on active (non-archiving) channel", async () => {
    const deps = makeDeps(db);
    const readyToolPm = getToolAs(deps, "flock_archive_ready", "pm");

    const result = await readyToolPm.execute("call-1", { channelId: "project-alpha" });

    const output = (result as any)?.output ?? JSON.stringify(result);
    expect(output).toContain("not in archive protocol");
  });

  it("bridge sync on auto-archive via protocol", async () => {
    db.bridges.insert({
      bridgeId: "b1",
      channelId: "project-alpha",
      platform: "discord",
      externalChannelId: "dc-111",
      accountId: null,
      webhookUrl: null,
      createdBy: "orchestrator",
      createdAt: 1000,
      active: true,
    });

    const sendExternal = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, sendExternal);
    const archiveTool = getToolAs(deps, "flock_channel_archive", "orchestrator");
    const readyToolPm = getToolAs(deps, "flock_archive_ready", "pm");
    const readyToolDev = getToolAs(deps, "flock_archive_ready", "dev-code");

    await archiveTool.execute("call-1", { channelId: "project-alpha" });

    // Bridge not deactivated during archiving phase
    expect(db.bridges.get("b1")?.active).toBe(true);

    await readyToolPm.execute("call-2", { channelId: "project-alpha" });
    await readyToolDev.execute("call-3", { channelId: "project-alpha" });

    // Now archived — bridge should be deactivated
    expect(db.bridges.get("b1")?.active).toBe(false);
    expect(sendExternal).toHaveBeenCalledTimes(1);
    expect(sendExternal).toHaveBeenCalledWith(
      "discord",
      "dc-111",
      expect.stringContaining("archived"),
      expect.objectContaining({ displayName: "Flock System" }),
    );
  });

  it("posting still works during archiving phase", async () => {
    const deps = makeDeps(db);
    const archiveTool = getToolAs(deps, "flock_channel_archive", "orchestrator");
    const postTool = getToolAs(deps, "flock_channel_post", "pm");

    await archiveTool.execute("call-1", { channelId: "project-alpha" });

    // Should succeed — channel is archiving but not yet archived
    const result = await postTool.execute("call-2", {
      channelId: "project-alpha",
      message: "My review summary",
    });

    const output = (result as any)?.output ?? JSON.stringify(result);
    expect(output).not.toContain("archived (read-only)");
  });
});
