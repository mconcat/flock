import { describe, it, expect } from "vitest";
import { discordMessageToInbound } from "../../src/bridge/discord-client.js";

describe("discordMessageToInbound", () => {
  const baseMsg = {
    author: { bot: false, username: "testuser", id: "123456789" },
    content: "hello flock",
    channelId: "channel-1",
    createdTimestamp: 1700000000000,
  };

  it("converts a regular message to InboundEvent + InboundContext", () => {
    const result = discordMessageToInbound(baseMsg);
    expect(result).not.toBeNull();
    expect(result!.event.from).toBe("testuser");
    expect(result!.event.content).toBe("hello flock");
    expect(result!.event.timestamp).toBe(1700000000000);
    expect(result!.ctx.channelId).toBe("discord");
    expect(result!.ctx.conversationId).toBe("channel-1");
  });

  it("returns null for bot messages", () => {
    const msg = { ...baseMsg, author: { ...baseMsg.author, bot: true } };
    expect(discordMessageToInbound(msg)).toBeNull();
  });

  it("returns null for empty content", () => {
    const msg = { ...baseMsg, content: "   " };
    expect(discordMessageToInbound(msg)).toBeNull();
  });

  it("includes author ID in metadata", () => {
    const result = discordMessageToInbound(baseMsg);
    expect(result!.event.metadata?.authorId).toBe("123456789");
  });
});
