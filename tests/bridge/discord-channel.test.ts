/**
 * Tests for createDiscordChannel — Discord channel creation via REST API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDiscordChannel } from "../../src/bridge/discord-webhook.js";

describe("createDiscordChannel", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates a text channel with correct API call", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "ch-999", name: "project-alpha" }),
    }) as any;

    const result = await createDiscordChannel("my-token", "guild-123", "project-alpha", {
      topic: "Alpha project discussion",
    });

    expect(result).toEqual({ channelId: "ch-999", channelName: "project-alpha" });

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://discord.com/api/v10/guilds/guild-123/channels");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers.Authorization).toBe("Bot my-token");

    const body = JSON.parse(call[1].body);
    expect(body.name).toBe("project-alpha");
    expect(body.type).toBe(0);
    expect(body.topic).toBe("Alpha project discussion");
    expect(body.parent_id).toBeUndefined();
  });

  it("includes categoryId as parent_id", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "ch-888", name: "my-channel" }),
    }) as any;

    await createDiscordChannel("token", "guild-1", "my-channel", {
      categoryId: "cat-42",
    });

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.parent_id).toBe("cat-42");
  });

  it("normalizes channel name to Discord format", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "ch-1", name: "hello-world-test" }),
    }) as any;

    await createDiscordChannel("token", "guild-1", "Hello World!@#Test");

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.name).toBe("hello-worldtest");
  });

  it("uses fallback name for empty normalized result", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "ch-1", name: "flock-channel" }),
    }) as any;

    await createDiscordChannel("token", "guild-1", "!@#$%");

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.name).toBe("flock-channel");
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Missing Permissions",
    }) as any;

    await expect(
      createDiscordChannel("token", "guild-1", "test-channel"),
    ).rejects.toThrow("Discord channel creation failed (403): Missing Permissions");
  });

  it("omits topic and parent_id when not provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "ch-1", name: "test" }),
    }) as any;

    await createDiscordChannel("token", "guild-1", "test");

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.topic).toBeUndefined();
    expect(body.parent_id).toBeUndefined();
  });
});
