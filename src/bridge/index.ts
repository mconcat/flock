/**
 * Bridge core — shared types and echo-loop tracking.
 *
 * The bridge connects Flock channels to external platforms (Discord/Slack).
 * This module provides the dependency interface and an in-memory echo tracker
 * to prevent infinite message relays.
 */

import type { BridgeStore, BridgePlatform, ChannelStore, ChannelMessageStore, AgentLoopStore } from "../db/interface.js";
import type { AuditLog } from "../audit/log.js";
import type { PluginLogger } from "../types.js";
import type { WorkLoopScheduler } from "../loop/scheduler.js";

export interface BridgeDeps {
  bridgeStore: BridgeStore;
  channelStore: ChannelStore;
  channelMessages: ChannelMessageStore;
  audit: AuditLog;
  logger: PluginLogger;
  /** Platform-specific send function — delegates to OpenClaw runtime or Discord webhooks. */
  sendExternal: SendExternalFn;
  /** Agent loop store — used for @mention-triggered wake of SLEEP agents. */
  agentLoop?: AgentLoopStore;
  /** Work loop scheduler — used for immediate tick on @mention of REACTIVE agents. */
  scheduler?: WorkLoopScheduler;
}

export type SendExternalFn = (
  platform: BridgePlatform,
  externalChannelId: string,
  text: string,
  opts?: {
    accountId?: string;
    /** Agent display name — Discord webhooks use this as the sender username. */
    displayName?: string;
    /** Discord webhook URL — if set, sends via webhook instead of bot API. */
    webhookUrl?: string;
  },
) => Promise<void>;

// --- Echo-loop tracking ---

/** TTL for echo entries (ms). */
const ECHO_TTL_MS = 30_000;

interface EchoEntry {
  expiresAt: number;
}

/**
 * Tracks which (channelId, seq) pairs were bridged inbound from an external
 * platform. The outbound handler checks this before relaying to prevent
 * echoing a message back to the platform it came from.
 */
export class EchoTracker {
  private entries = new Map<string, EchoEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic cleanup every 60s to prevent unbounded growth
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    // Allow Node to exit without waiting for this timer
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  /** Mark a message as bridged inbound from an external platform. */
  markBridgedIn(channelId: string, seq: number): void {
    this.entries.set(`${channelId}:${seq}`, { expiresAt: Date.now() + ECHO_TTL_MS });
  }

  /** Check if a message was bridged inbound (should NOT be relayed outbound). */
  wasBridgedIn(channelId: string, seq: number): boolean {
    const key = `${channelId}:${seq}`;
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** Remove expired entries. */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(key);
    }
  }

  /** Stop the cleanup timer. */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
