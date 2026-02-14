/**
 * Tests for archive sync — flock_channel_archive notifies bridged channels
 * and deactivates bridges.
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

describe("flock_channel_archive — bridge sync", () => {
  let db: FlockDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    db.migrate();

    // Create a Flock channel
    db.channels.insert({
      channelId: "project-alpha",
      name: "Project Alpha",
      topic: "Alpha project discussion",
      createdBy: "orchestrator",
      members: ["pm", "dev-code"],
      archived: false,
      archiveReadyMembers: [],
      archivingStartedAt: null,
      createdAt: 1000,
      updatedAt: 1000,
    });
  });

  it("sends notification and deactivates bridges on archive", async () => {
    // Create an active bridge
    db.bridges.insert({
      bridgeId: "b1",
      channelId: "project-alpha",
      platform: "discord",
      externalChannelId: "dc-111",
      accountId: null,
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      createdBy: "orchestrator",
      createdAt: 1000,
      active: true,
    });

    const sendExternal = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, sendExternal);
    const tools = collectTools(deps);
    const archiveTool = tools.get("flock_channel_archive")!;

    const result = await archiveTool.execute("call-1", {
      channelId: "project-alpha",
      force: true,
      _callerAgentId: "orchestrator",
    });

    // Channel should be archived
    expect(db.channels.get("project-alpha")?.archived).toBe(true);

    // Bridge should be deactivated
    expect(db.bridges.get("b1")?.active).toBe(false);

    // Notification sent to external channel
    expect(sendExternal).toHaveBeenCalledTimes(1);
    expect(sendExternal).toHaveBeenCalledWith(
      "discord",
      "dc-111",
      expect.stringContaining("archived"),
      expect.objectContaining({
        displayName: "Flock System",
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
      }),
    );

    // Output mentions bridge deactivation
    const output = (result as any)?.output ?? JSON.stringify(result);
    expect(output).toContain("bridge");
  });

  it("deactivates multiple bridges", async () => {
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
    db.bridges.insert({
      bridgeId: "b2",
      channelId: "project-alpha",
      platform: "slack",
      externalChannelId: "sl-222",
      accountId: null,
      webhookUrl: null,
      createdBy: "orchestrator",
      createdAt: 1000,
      active: true,
    });

    const sendExternal = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, sendExternal);
    const tools = collectTools(deps);
    const archiveTool = tools.get("flock_channel_archive")!;

    await archiveTool.execute("call-1", {
      channelId: "project-alpha",
      force: true,
      _callerAgentId: "orchestrator",
    });

    expect(db.bridges.get("b1")?.active).toBe(false);
    expect(db.bridges.get("b2")?.active).toBe(false);
    expect(sendExternal).toHaveBeenCalledTimes(2);
  });

  it("archive succeeds even if notification fails", async () => {
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

    const sendExternal = vi.fn().mockRejectedValue(new Error("webhook expired"));
    const deps = makeDeps(db, sendExternal);
    const tools = collectTools(deps);
    const archiveTool = tools.get("flock_channel_archive")!;

    const result = await archiveTool.execute("call-1", {
      channelId: "project-alpha",
      force: true,
      _callerAgentId: "orchestrator",
    });

    // Channel should still be archived
    expect(db.channels.get("project-alpha")?.archived).toBe(true);
    // Bridge should still be deactivated
    expect(db.bridges.get("b1")?.active).toBe(false);
    // Should indicate success
    const output = (result as any)?.output ?? JSON.stringify(result);
    expect(output).toContain("archived");
  });

  it("no-op when no bridges exist", async () => {
    const sendExternal = vi.fn();
    const deps = makeDeps(db, sendExternal);
    const tools = collectTools(deps);
    const archiveTool = tools.get("flock_channel_archive")!;

    await archiveTool.execute("call-1", {
      channelId: "project-alpha",
      force: true,
      _callerAgentId: "orchestrator",
    });

    expect(db.channels.get("project-alpha")?.archived).toBe(true);
    expect(sendExternal).not.toHaveBeenCalled();
  });

  it("skips already-inactive bridges", async () => {
    db.bridges.insert({
      bridgeId: "b-inactive",
      channelId: "project-alpha",
      platform: "discord",
      externalChannelId: "dc-333",
      accountId: null,
      webhookUrl: null,
      createdBy: "orchestrator",
      createdAt: 1000,
      active: false, // already inactive
    });

    const sendExternal = vi.fn();
    const deps = makeDeps(db, sendExternal);
    const tools = collectTools(deps);
    const archiveTool = tools.get("flock_channel_archive")!;

    await archiveTool.execute("call-1", {
      channelId: "project-alpha",
      force: true,
      _callerAgentId: "orchestrator",
    });

    // getByChannel only returns active bridges, so no notification sent
    expect(sendExternal).not.toHaveBeenCalled();
  });

  it("works without sendExternal (bridges deactivated only)", async () => {
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

    // No sendExternal provided — bridge should stay active (guard checks both)
    const deps = makeDeps(db, undefined);
    const tools = collectTools(deps);
    const archiveTool = tools.get("flock_channel_archive")!;

    await archiveTool.execute("call-1", {
      channelId: "project-alpha",
      force: true,
      _callerAgentId: "orchestrator",
    });

    // Channel archived
    expect(db.channels.get("project-alpha")?.archived).toBe(true);
    // Bridge stays active since sendExternal is unavailable (guard skips the whole block)
    expect(db.bridges.get("b1")?.active).toBe(true);
  });
});
