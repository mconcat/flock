/**
 * Bridge inbound — external platform messages → Flock channels.
 *
 * Registered as an OpenClaw `message_received` hook. When a message arrives
 * on a Discord/Slack channel that has a bridge mapping, the message is
 * appended to the corresponding Flock channel as `human:{username}`.
 *
 * The seq is marked in the EchoTracker so the outbound handler knows
 * not to relay it back to the originating platform.
 */

import type { BridgeDeps } from "./index.js";
import type { EchoTracker } from "./index.js";
import type { BridgePlatform } from "../db/interface.js";

/**
 * Hook event shape from OpenClaw's `message_received` hook.
 * See openclaw/src/plugins/types.ts PluginHookMessageReceivedEvent.
 */
export interface InboundEvent {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Hook context from OpenClaw's `message_received` hook.
 * See openclaw/src/plugins/types.ts PluginHookMessageContext.
 */
export interface InboundContext {
  /** Platform name: "discord" | "slack". */
  channelId: string;
  /** Bot account ID (optional). */
  accountId?: string;
  /** External channel/conversation ID. */
  conversationId?: string;
}

export interface HandleInboundResult {
  bridged: boolean;
  flockChannelId?: string;
  seq?: number;
}

/**
 * Handle an inbound message from Discord/Slack.
 * Returns whether the message was bridged into a Flock channel.
 */
export function handleInbound(
  deps: BridgeDeps,
  echoTracker: EchoTracker,
  event: InboundEvent,
  ctx: InboundContext,
): HandleInboundResult {
  const platform = ctx.channelId as BridgePlatform;
  const externalChannelId = ctx.conversationId;

  if (!externalChannelId) {
    return { bridged: false };
  }

  // Only handle discord/slack platforms
  if (platform !== "discord" && platform !== "slack") {
    return { bridged: false };
  }

  // Look up bridge mapping
  const mapping = deps.bridgeStore.getByExternal(platform, externalChannelId);
  if (!mapping || !mapping.active) {
    return { bridged: false };
  }

  // Verify the Flock channel still exists and isn't archived
  const channel = deps.channelStore.get(mapping.channelId);
  if (!channel || channel.archived) {
    deps.logger.warn(
      `[flock:bridge:in] Bridge ${mapping.bridgeId} targets missing/archived channel "${mapping.channelId}"`,
    );
    return { bridged: false };
  }

  // Derive human identity from the event "from" field
  const agentId = `human:${normalizeUsername(event.from)}`;

  // Append message to Flock channel
  const seq = deps.channelMessages.append({
    channelId: mapping.channelId,
    agentId,
    content: event.content,
    timestamp: event.timestamp ?? Date.now(),
  });

  // Mark as bridged-in so outbound handler skips it
  echoTracker.markBridgedIn(mapping.channelId, seq);

  // Auto-add human member to channel if not already present
  if (!channel.members.includes(agentId)) {
    const updatedMembers = [...channel.members, agentId];
    deps.channelStore.update(mapping.channelId, {
      members: updatedMembers,
      updatedAt: Date.now(),
    });
  }

  // @mention detection: wake SLEEP agents, trigger immediate tick for REACTIVE agents
  if (deps.agentLoop) {
    const mentioned = extractMentionedAgents(event.content, channel.members);
    for (const mentionedId of mentioned) {
      const loopState = deps.agentLoop.get(mentionedId);
      if (!loopState) continue;

      if (loopState.state === "SLEEP") {
        deps.agentLoop.setState(mentionedId, "AWAKE", `mentioned by ${agentId} via ${platform} bridge`);
        deps.logger.info(
          `[flock:bridge:in] woke agent "${mentionedId}" (mentioned by ${agentId} in ${platform}/${externalChannelId})`,
        );
      }

      // Trigger immediate tick for mentioned agents (both newly-woken SLEEP and REACTIVE)
      if (deps.scheduler) {
        deps.scheduler.requestImmediateTick(mentionedId).catch((err) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          deps.logger.warn(`[flock:bridge:in] Immediate tick for "${mentionedId}" failed: ${errorMsg}`);
        });
      }
    }
  }

  deps.logger.info(
    `[flock:bridge:in] ${platform}/${externalChannelId} → flock/${mapping.channelId} seq=${seq} from="${agentId}"`,
  );

  return { bridged: true, flockChannelId: mapping.channelId, seq };
}

/**
 * Extract agent IDs mentioned in a message via @agentId patterns.
 * Only returns IDs that are actual channel members (excluding human: members).
 */
export function extractMentionedAgents(content: string, members: string[]): string[] {
  const agentMembers = members.filter(m => !m.startsWith("human:"));
  if (agentMembers.length === 0) return [];

  const mentioned: string[] = [];
  for (const agentId of agentMembers) {
    // Match @agentId at word boundaries (case-insensitive)
    const pattern = new RegExp(`@${escapeRegex(agentId)}\\b`, "i");
    if (pattern.test(content)) {
      mentioned.push(agentId);
    }
  }
  return mentioned;
}

/**
 * Normalize a platform username into a stable human: participant ID.
 * Lowercases, strips unsafe chars, collapses separators, and falls back to "unknown".
 */
export function normalizeUsername(raw: string | undefined | null): string {
  if (!raw) return "unknown";
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .replace(/[._-]{2,}/g, m => m[0])
    .replace(/^[._-]+|[._-]+$/g, "");
  return normalized || "unknown";
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
