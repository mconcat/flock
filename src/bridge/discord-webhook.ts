/**
 * Discord API utilities for the Flock bridge.
 *
 * - createChannelWebhook: creates a webhook in a Discord channel (one-time)
 * - sendViaWebhook: sends a message through a webhook with custom username
 * - createDiscordChannel: creates a text channel in a Discord guild
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";

export interface WebhookCreateResult {
  webhookUrl: string;
  webhookId: string;
}

/**
 * Create a webhook in a Discord channel using the bot token.
 * Requires the bot to have MANAGE_WEBHOOKS permission in the channel.
 */
export async function createChannelWebhook(
  botToken: string,
  channelId: string,
  name: string = "Flock Bridge",
): Promise<WebhookCreateResult> {
  const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/webhooks`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook creation failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { id: string; token: string };
  return {
    webhookUrl: `${DISCORD_API_BASE}/webhooks/${data.id}/${data.token}`,
    webhookId: data.id,
  };
}

/**
 * Send a message through a Discord webhook with an optional custom username.
 * The webhook URL is self-authenticating (contains the token).
 */
export async function sendViaWebhook(
  webhookUrl: string,
  content: string,
  username?: string,
): Promise<void> {
  const body: Record<string, unknown> = { content };
  if (username) body.username = username;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook send failed (${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Channel management
// ---------------------------------------------------------------------------

export interface ChannelCreateResult {
  channelId: string;
  channelName: string;
}

/**
 * Create a text channel in a Discord guild.
 * Requires the bot to have MANAGE_CHANNELS permission in the guild.
 */
export async function createDiscordChannel(
  botToken: string,
  guildId: string,
  name: string,
  opts?: { topic?: string; categoryId?: string },
): Promise<ChannelCreateResult> {
  // Normalize to Discord channel name format (lowercase, dashes, no special chars)
  const normalized = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const body: Record<string, unknown> = {
    name: normalized || "flock-channel",
    type: 0, // GUILD_TEXT
  };
  if (opts?.topic) body.topic = opts.topic;
  if (opts?.categoryId) body.parent_id = opts.categoryId;

  const res = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord channel creation failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { id: string; name: string };
  return {
    channelId: data.id,
    channelName: data.name,
  };
}
