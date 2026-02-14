/**
 * Tests for bridge inbound handler — external platform messages → Flock channels.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDatabase } from "../../src/db/memory.js";
import { EchoTracker } from "../../src/bridge/index.js";
import type { BridgeDeps } from "../../src/bridge/index.js";
import { handleInbound, extractMentionedAgents, normalizeUsername } from "../../src/bridge/inbound.js";
import type { InboundEvent, InboundContext } from "../../src/bridge/inbound.js";
import type { FlockDatabase } from "../../src/db/interface.js";
import { createAuditLog } from "../../src/audit/log.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeBridgeDeps(db: FlockDatabase): BridgeDeps {
  const logger = makeLogger();
  return {
    bridgeStore: db.bridges,
    channelStore: db.channels,
    channelMessages: db.channelMessages,
    audit: createAuditLog({ db, logger }),
    logger,
    sendExternal: vi.fn(),
    agentLoop: db.agentLoop,
  };
}

describe("handleInbound", () => {
  let db: FlockDatabase;
  let deps: BridgeDeps;
  let echoTracker: EchoTracker;

  beforeEach(() => {
    db = createMemoryDatabase();
    db.migrate();
    deps = makeBridgeDeps(db);
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

    // Create a bridge mapping
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

  it("bridges inbound message to Flock channel", () => {
    const event: InboundEvent = { from: "alice", content: "Hello from Discord!", timestamp: 2000 };
    const ctx: InboundContext = { channelId: "discord", conversationId: "dc-channel-999" };

    const result = handleInbound(deps, echoTracker, event, ctx);

    expect(result.bridged).toBe(true);
    expect(result.flockChannelId).toBe("project-alpha");
    expect(result.seq).toBe(1);

    // Verify message was appended
    const messages = db.channelMessages.list({ channelId: "project-alpha" });
    expect(messages).toHaveLength(1);
    expect(messages[0].agentId).toBe("human:alice");
    expect(messages[0].content).toBe("Hello from Discord!");
  });

  it("marks message as bridged-in for echo prevention", () => {
    const event: InboundEvent = { from: "bob", content: "Test" };
    const ctx: InboundContext = { channelId: "discord", conversationId: "dc-channel-999" };

    const result = handleInbound(deps, echoTracker, event, ctx);

    expect(echoTracker.wasBridgedIn("project-alpha", result.seq!)).toBe(true);
  });

  it("auto-adds human member to channel", () => {
    const event: InboundEvent = { from: "charlie", content: "Hi" };
    const ctx: InboundContext = { channelId: "discord", conversationId: "dc-channel-999" };

    handleInbound(deps, echoTracker, event, ctx);

    const channel = db.channels.get("project-alpha")!;
    expect(channel.members).toContain("human:charlie");
  });

  it("does not duplicate existing human member", () => {
    // Add human:alice to members first
    const ch = db.channels.get("project-alpha")!;
    db.channels.update("project-alpha", { members: [...ch.members, "human:alice"] });

    const event: InboundEvent = { from: "alice", content: "Again" };
    const ctx: InboundContext = { channelId: "discord", conversationId: "dc-channel-999" };

    handleInbound(deps, echoTracker, event, ctx);

    const updated = db.channels.get("project-alpha")!;
    const aliceCount = updated.members.filter(m => m === "human:alice").length;
    expect(aliceCount).toBe(1);
  });

  it("skips when conversationId is missing", () => {
    const event: InboundEvent = { from: "alice", content: "test" };
    const ctx: InboundContext = { channelId: "discord" }; // no conversationId

    const result = handleInbound(deps, echoTracker, event, ctx);
    expect(result.bridged).toBe(false);
  });

  it("skips when platform is not discord or slack", () => {
    const event: InboundEvent = { from: "alice", content: "test" };
    const ctx: InboundContext = { channelId: "telegram", conversationId: "dc-channel-999" };

    const result = handleInbound(deps, echoTracker, event, ctx);
    expect(result.bridged).toBe(false);
  });

  it("skips when no bridge mapping exists", () => {
    const event: InboundEvent = { from: "alice", content: "test" };
    const ctx: InboundContext = { channelId: "discord", conversationId: "unknown-channel" };

    const result = handleInbound(deps, echoTracker, event, ctx);
    expect(result.bridged).toBe(false);
  });

  it("skips when bridge is paused (inactive)", () => {
    db.bridges.update("bridge-1", { active: false });

    const event: InboundEvent = { from: "alice", content: "test" };
    const ctx: InboundContext = { channelId: "discord", conversationId: "dc-channel-999" };

    const result = handleInbound(deps, echoTracker, event, ctx);
    expect(result.bridged).toBe(false);
  });

  it("skips when Flock channel is archived", () => {
    db.channels.update("project-alpha", { archived: true });

    const event: InboundEvent = { from: "alice", content: "test" };
    const ctx: InboundContext = { channelId: "discord", conversationId: "dc-channel-999" };

    const result = handleInbound(deps, echoTracker, event, ctx);
    expect(result.bridged).toBe(false);
  });

  it("handles Slack platform messages", () => {
    // Create Slack bridge
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

    const event: InboundEvent = { from: "dave", content: "From Slack!" };
    const ctx: InboundContext = { channelId: "slack", conversationId: "sl-channel-555" };

    const result = handleInbound(deps, echoTracker, event, ctx);
    expect(result.bridged).toBe(true);

    const messages = db.channelMessages.list({ channelId: "project-alpha" });
    expect(messages).toHaveLength(1);
    expect(messages[0].agentId).toBe("human:dave");
  });

  // --- @mention detection + agent wake ---

  it("wakes SLEEP agent when @mentioned in inbound message", () => {
    // Put dev-code to sleep
    db.agentLoop.init("dev-code", "SLEEP");

    const event: InboundEvent = { from: "alice", content: "Hey @dev-code can you fix the bug?" };
    const ctx: InboundContext = { channelId: "discord", conversationId: "dc-channel-999" };

    handleInbound(deps, echoTracker, event, ctx);

    const loopState = db.agentLoop.get("dev-code");
    expect(loopState?.state).toBe("AWAKE");
  });

  it("does not wake already AWAKE agent", () => {
    db.agentLoop.init("dev-code", "AWAKE");

    const event: InboundEvent = { from: "alice", content: "@dev-code check this" };
    const ctx: InboundContext = { channelId: "discord", conversationId: "dc-channel-999" };

    handleInbound(deps, echoTracker, event, ctx);

    // Should still be AWAKE (no error, no change)
    expect(db.agentLoop.get("dev-code")?.state).toBe("AWAKE");
  });

  it("wakes multiple mentioned agents", () => {
    db.agentLoop.init("pm", "SLEEP");
    db.agentLoop.init("dev-code", "SLEEP");

    const event: InboundEvent = { from: "alice", content: "@pm and @dev-code please review" };
    const ctx: InboundContext = { channelId: "discord", conversationId: "dc-channel-999" };

    handleInbound(deps, echoTracker, event, ctx);

    expect(db.agentLoop.get("pm")?.state).toBe("AWAKE");
    expect(db.agentLoop.get("dev-code")?.state).toBe("AWAKE");
  });

  it("ignores @mention for non-member agents", () => {
    db.agentLoop.init("unknown-agent", "SLEEP");

    const event: InboundEvent = { from: "alice", content: "@unknown-agent help" };
    const ctx: InboundContext = { channelId: "discord", conversationId: "dc-channel-999" };

    handleInbound(deps, echoTracker, event, ctx);

    // Not a member of the channel, so not woken
    expect(db.agentLoop.get("unknown-agent")?.state).toBe("SLEEP");
  });
});

describe("extractMentionedAgents", () => {
  it("extracts single mention", () => {
    const result = extractMentionedAgents("Hey @dev-code fix this", ["pm", "dev-code", "human:alice"]);
    expect(result).toEqual(["dev-code"]);
  });

  it("extracts multiple mentions", () => {
    const result = extractMentionedAgents("@pm @dev-code review", ["pm", "dev-code"]);
    expect(result).toEqual(["pm", "dev-code"]);
  });

  it("ignores human: members", () => {
    const result = extractMentionedAgents("@human:alice hello", ["human:alice", "dev-code"]);
    expect(result).toEqual([]);
  });

  it("returns empty for no mentions", () => {
    const result = extractMentionedAgents("no mentions here", ["pm", "dev-code"]);
    expect(result).toEqual([]);
  });

  it("returns empty for empty members", () => {
    const result = extractMentionedAgents("@dev-code hello", []);
    expect(result).toEqual([]);
  });

  it("handles case-insensitive mentions", () => {
    const result = extractMentionedAgents("Hey @DEV-CODE help", ["dev-code"]);
    expect(result).toEqual(["dev-code"]);
  });
});

describe("normalizeUsername", () => {
  it("lowercases usernames", () => {
    expect(normalizeUsername("Alice")).toBe("alice");
    expect(normalizeUsername("DEV-CODE")).toBe("dev-code");
  });

  it("strips special characters", () => {
    expect(normalizeUsername("alice#1234")).toBe("alice1234");
    expect(normalizeUsername("user@name")).toBe("username");
    expect(normalizeUsername("hello world")).toBe("helloworld");
  });

  it("keeps allowed characters (alphanumeric, dash, underscore, dot)", () => {
    expect(normalizeUsername("alice_2024")).toBe("alice_2024");
    expect(normalizeUsername("dev-code")).toBe("dev-code");
    expect(normalizeUsername("user.name")).toBe("user.name");
  });

  it("collapses repeated separators", () => {
    expect(normalizeUsername("a--b")).toBe("a-b");
    expect(normalizeUsername("a..b")).toBe("a.b");
    expect(normalizeUsername("a__b")).toBe("a_b");
  });

  it("trims leading/trailing separators", () => {
    expect(normalizeUsername("-alice-")).toBe("alice");
    expect(normalizeUsername(".bob.")).toBe("bob");
    expect(normalizeUsername("_charlie_")).toBe("charlie");
  });

  it("returns 'unknown' for empty/null/undefined", () => {
    expect(normalizeUsername("")).toBe("unknown");
    expect(normalizeUsername(null)).toBe("unknown");
    expect(normalizeUsername(undefined)).toBe("unknown");
  });

  it("returns 'unknown' when all chars are stripped", () => {
    expect(normalizeUsername("!@#$%")).toBe("unknown");
  });
});
