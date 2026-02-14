/**
 * Bridge outbound — Flock channel posts → external platforms.
 *
 * Triggered by the OpenClaw `after_tool_call` hook when `flock_channel_post`
 * completes successfully. If the target Flock channel has bridge mappings,
 * the message is relayed to each mapped external channel.
 *
 * Skip conditions:
 * 1. Message was bridged-in from the same platform (echo prevention)
 * 2. Caller is a `human:*` agent (already visible on the platform)
 */

import type { BridgeDeps } from "./index.js";
import type { EchoTracker } from "./index.js";

/**
 * Params extracted from the flock_channel_post tool call.
 */
export interface OutboundParams {
  channelId: string;
  message: string;
  agentId: string;
  /** Seq number returned by channelMessages.append. */
  seq?: number;
}

export interface HandleOutboundResult {
  relayed: number; // number of platforms message was sent to
  skipped: number; // number of platforms skipped (echo/human)
}

/**
 * Handle an outbound relay from a flock_channel_post to bridged platforms.
 */
export async function handleOutbound(
  deps: BridgeDeps,
  echoTracker: EchoTracker,
  params: OutboundParams,
): Promise<HandleOutboundResult> {
  const { channelId, message, agentId, seq } = params;

  // Skip if the poster is a human (already visible on the platform)
  if (agentId.startsWith("human:")) {
    return { relayed: 0, skipped: 0 };
  }

  // Find active bridge mappings for this channel
  const mappings = deps.bridgeStore.getByChannel(channelId);
  if (mappings.length === 0) {
    return { relayed: 0, skipped: 0 };
  }

  let relayed = 0;
  let skipped = 0;

  for (const mapping of mappings) {
    // Echo check: was this message bridged-in from this platform?
    if (seq !== undefined && echoTracker.wasBridgedIn(channelId, seq)) {
      skipped++;
      continue;
    }

    try {
      await deps.sendExternal(
        mapping.platform,
        mapping.externalChannelId,
        message,
        {
          accountId: mapping.accountId ?? undefined,
          displayName: agentId,
          webhookUrl: mapping.webhookUrl ?? undefined,
        },
      );
      relayed++;

      deps.logger.info(
        `[flock:bridge:out] flock/${channelId} → ${mapping.platform}/${mapping.externalChannelId} from="${agentId}"`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      deps.logger.error(
        `[flock:bridge:out] Failed to relay to ${mapping.platform}/${mapping.externalChannelId}: ${errMsg}`,
      );
      // Don't throw — continue relaying to other mappings
    }
  }

  return { relayed, skipped };
}
