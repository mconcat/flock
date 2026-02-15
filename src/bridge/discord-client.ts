/**
 * Standalone Discord bridge client.
 *
 * Replaces OpenClaw's `message_received` and `after_tool_call` hooks
 * with direct discord.js event handling.
 *
 * In plugin mode, OpenClaw provides:
 *   - api.on("message_received") → inbound messages
 *   - api.on("after_tool_call") → outbound relay trigger
 *   - api.runtime.channel.discord.sendMessageDiscord → bot API send
 *
 * In standalone mode, this module provides:
 *   - Discord.js client.on("messageCreate") → inbound messages
 *   - Direct outbound call after flock_channel_post (no hook needed)
 *   - sendViaWebhook() or Discord.js client for sending
 */

import type { BridgeDeps, SendExternalFn } from "./index.js";
import type { BridgePlatform } from "../db/interface.js";
import type { PluginLogger } from "../types.js";
import { sendViaWebhook } from "./discord-webhook.js";

/**
 * Configuration for the standalone Discord bridge.
 */
export interface DiscordBridgeConfig {
  /** Discord bot token. */
  botToken: string;
  /** Logger instance. */
  logger: PluginLogger;
}

/**
 * Build a SendExternalFn that sends messages to Discord.
 *
 * Uses webhooks when available (per-agent display names), falls back
 * to the bot API via discord.js Client.
 *
 * This replaces the OpenClaw runtime's `sendMessageDiscord` dependency.
 */
export function createDiscordSendExternal(config: DiscordBridgeConfig): SendExternalFn {
  const { logger } = config;

  // Lazy-load discord.js only when actually needed (it's a heavy import).
  // The client is created on first use and reused.
  let clientPromise: Promise<DiscordClient> | null = null;

  interface DiscordClient {
    sendMessage(channelId: string, text: string): Promise<void>;
    destroy(): Promise<void>;
  }

  async function getClient(): Promise<DiscordClient> {
    if (!clientPromise) {
      clientPromise = (async () => {
        // Dynamic import to avoid requiring discord.js as a hard dependency
        const { Client, GatewayIntentBits } = await import("discord.js");
        const client = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
          ],
        });

        await client.login(config.botToken);
        logger.info("[flock:discord-bridge] bot client logged in");

        return {
          async sendMessage(channelId: string, text: string): Promise<void> {
            const channel = await client.channels.fetch(channelId);
            if (channel && "send" in channel && typeof channel.send === "function") {
              await channel.send(text);
            } else {
              throw new Error(`Channel ${channelId} not found or not a text channel`);
            }
          },
          async destroy(): Promise<void> {
            client.destroy();
          },
        };
      })();
    }
    return clientPromise;
  }

  return async (
    platform: BridgePlatform,
    externalChannelId: string,
    text: string,
    opts?: { accountId?: string; displayName?: string; webhookUrl?: string },
  ): Promise<void> => {
    if (platform !== "discord") {
      logger.warn(`[flock:discord-bridge] unsupported platform "${platform}" — only discord is supported`);
      return;
    }

    if (opts?.webhookUrl) {
      // Preferred: webhook with per-agent display name
      await sendViaWebhook(opts.webhookUrl, text, opts.displayName);
    } else {
      // Fallback: bot API (single identity, prefix with agent name)
      const prefixed = opts?.displayName ? `**[${opts.displayName}]** ${text}` : text;
      const client = await getClient();
      await client.sendMessage(externalChannelId, prefixed);
    }
  };
}

/**
 * Inbound event shape matching what handleInbound expects.
 * Produced from discord.js messageCreate events.
 */
export interface DiscordInboundEvent {
  from: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Context shape matching what handleInbound expects.
 */
export interface DiscordInboundContext {
  channelId: string;
  accountId?: string;
  conversationId: string;
}

/**
 * Convert a discord.js message to Flock's InboundEvent + InboundContext.
 *
 * Returns null if the message should be ignored (bot messages, empty content).
 */
export function discordMessageToInbound(msg: {
  author: { bot: boolean; username: string; id: string };
  content: string;
  channelId: string;
  createdTimestamp: number;
  client?: { user?: { id: string } };
}): { event: DiscordInboundEvent; ctx: DiscordInboundContext } | null {
  // Ignore bot messages (including self)
  if (msg.author.bot) return null;

  // Ignore empty messages
  if (!msg.content.trim()) return null;

  return {
    event: {
      from: msg.author.username,
      content: msg.content,
      timestamp: msg.createdTimestamp,
      metadata: { authorId: msg.author.id },
    },
    ctx: {
      channelId: "discord",
      conversationId: msg.channelId,
    },
  };
}
