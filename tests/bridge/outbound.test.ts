/**
 * Tests for bridge outbound handler — Flock channel posts → external platforms.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDatabase } from "../../src/db/memory.js";
import { EchoTracker } from "../../src/bridge/index.js";
import type { BridgeDeps } from "../../src/bridge/index.js";
import { handleOutbound } from "../../src/bridge/outbound.js";
import type { FlockDatabase } from "../../src/db/interface.js";
import { createAuditLog } from "../../src/audit/log.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeBridgeDeps(db: FlockDatabase, sendExternal?: any): BridgeDeps {
  const logger = makeLogger();
  return {
    bridgeStore: db.bridges,
    channelStore: db.channels,
    channelMessages: db.channelMessages,
    audit: createAuditLog({ db, logger }),
    logger,
    sendExternal: sendExternal ?? vi.fn(),
  };
}

describe("handleOutbound", () => {
  let db: FlockDatabase;
  let echoTracker: EchoTracker;

  beforeEach(() => {
    db = createMemoryDatabase();
    db.migrate();
    echoTracker = new EchoTracker();

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

    // Create a Discord bridge mapping (no webhook — prefix fallback)
    db.bridges.insert({
      bridgeId: "bridge-1",
      channelId: "project-alpha",
      platform: "discord",
      externalChannelId: "dc-channel-999",
      accountId: null,
      webhookUrl: null,
      createdBy: "orchestrator",
      createdAt: 1000,
      active: true,
    });
  });

  it("relays agent message with displayName and no formatting", async () => {
    const sendExternal = vi.fn();
    const deps = makeBridgeDeps(db, sendExternal);

    const result = await handleOutbound(deps, echoTracker, {
      channelId: "project-alpha",
      message: "Task completed!",
      agentId: "dev-code",
      seq: 5,
    });

    expect(result.relayed).toBe(1);
    expect(result.skipped).toBe(0);
    // Outbound now passes raw message + opts (formatting is sendExternal's job)
    expect(sendExternal).toHaveBeenCalledWith(
      "discord",
      "dc-channel-999",
      "Task completed!",
      { accountId: undefined, displayName: "dev-code", webhookUrl: undefined },
    );
  });

  it("passes webhookUrl from bridge mapping when present", async () => {
    // Create bridge with webhook
    db.bridges.insert({
      bridgeId: "bridge-wh",
      channelId: "project-alpha",
      platform: "slack",
      externalChannelId: "sl-channel-555",
      accountId: null,
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      createdBy: "orchestrator",
      createdAt: 1000,
      active: true,
    });

    const sendExternal = vi.fn();
    const deps = makeBridgeDeps(db, sendExternal);

    await handleOutbound(deps, echoTracker, {
      channelId: "project-alpha",
      message: "Hello",
      agentId: "pm",
      seq: 1,
    });

    // Should be called twice (discord bridge + slack bridge)
    expect(sendExternal).toHaveBeenCalledTimes(2);
    // Slack call should include webhookUrl
    const slackCall = sendExternal.mock.calls.find((c: any[]) => c[0] === "slack");
    expect(slackCall?.[3]?.webhookUrl).toBe("https://discord.com/api/webhooks/123/abc");
  });

  it("skips human: agent messages (already visible on platform)", async () => {
    const sendExternal = vi.fn();
    const deps = makeBridgeDeps(db, sendExternal);

    const result = await handleOutbound(deps, echoTracker, {
      channelId: "project-alpha",
      message: "I said this on Discord",
      agentId: "human:alice",
      seq: 5,
    });

    expect(result.relayed).toBe(0);
    expect(sendExternal).not.toHaveBeenCalled();
  });

  it("skips echo-tracked messages (bridged-in)", async () => {
    const sendExternal = vi.fn();
    const deps = makeBridgeDeps(db, sendExternal);

    // Mark seq 5 as bridged-in from Discord
    echoTracker.markBridgedIn("project-alpha", 5);

    const result = await handleOutbound(deps, echoTracker, {
      channelId: "project-alpha",
      message: "Hello from Discord",
      agentId: "dev-code",
      seq: 5,
    });

    expect(result.skipped).toBe(1);
    expect(result.relayed).toBe(0);
    expect(sendExternal).not.toHaveBeenCalled();
  });

  it("returns zero when no bridge mappings exist", async () => {
    const sendExternal = vi.fn();
    const deps = makeBridgeDeps(db, sendExternal);

    const result = await handleOutbound(deps, echoTracker, {
      channelId: "nonexistent-channel",
      message: "Hello",
      agentId: "dev-code",
    });

    expect(result.relayed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(sendExternal).not.toHaveBeenCalled();
  });

  it("passes accountId from bridge mapping", async () => {
    db.bridges.insert({
      bridgeId: "bridge-2",
      channelId: "ch-with-account",
      platform: "slack",
      externalChannelId: "sl-channel-555",
      accountId: "bot-account-1",
      webhookUrl: null,
      createdBy: "orchestrator",
      createdAt: 1000,
      active: true,
    });
    db.channels.insert({
      channelId: "ch-with-account",
      name: "With Account",
      topic: "",
      createdBy: "orchestrator",
      members: [],
      archived: false,
      archiveReadyMembers: [],
      archivingStartedAt: null,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const sendExternal = vi.fn();
    const deps = makeBridgeDeps(db, sendExternal);

    await handleOutbound(deps, echoTracker, {
      channelId: "ch-with-account",
      message: "Slack message",
      agentId: "pm",
    });

    expect(sendExternal).toHaveBeenCalledWith(
      "slack",
      "sl-channel-555",
      "Slack message",
      { accountId: "bot-account-1", displayName: "pm", webhookUrl: undefined },
    );
  });

  it("continues relaying to other platforms if one fails", async () => {
    // Add a second bridge (Slack) to the same channel
    db.bridges.insert({
      bridgeId: "bridge-slack",
      channelId: "project-alpha",
      platform: "slack",
      externalChannelId: "sl-channel-555",
      accountId: null,
      webhookUrl: null,
      createdBy: "orchestrator",
      createdAt: 1000,
      active: true,
    });

    const sendExternal = vi.fn()
      .mockRejectedValueOnce(new Error("Discord unavailable"))
      .mockResolvedValueOnce(undefined);

    const deps = makeBridgeDeps(db, sendExternal);

    const result = await handleOutbound(deps, echoTracker, {
      channelId: "project-alpha",
      message: "Test resilience",
      agentId: "dev-code",
      seq: 10,
    });

    expect(sendExternal).toHaveBeenCalledTimes(2);
    expect(result.relayed).toBe(1);
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("relays when seq is undefined (no echo check possible)", async () => {
    const sendExternal = vi.fn();
    const deps = makeBridgeDeps(db, sendExternal);

    const result = await handleOutbound(deps, echoTracker, {
      channelId: "project-alpha",
      message: "No seq provided",
      agentId: "pm",
      // seq: undefined
    });

    expect(result.relayed).toBe(1);
    expect(sendExternal).toHaveBeenCalled();
  });
});
