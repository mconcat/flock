/**
 * Work Loop Scheduler
 *
 * Drives the agent work loop. AWAKE agents receive periodic "tick" messages
 * via A2A, giving them a chance to continue work, check channels, and decide
 * whether to sleep.
 *
 * Design:
 * - Global tick interval: 60s ± 10s jitter (prevents synchronized ticks)
 * - AWAKE agents get ticked; SLEEP agents are skipped
 * - Each tick sends an A2A message with context (new channel messages, etc.)
 * - Agents control their own SLEEP transition via flock_sleep tool
 * - SLEEP agents receive slow-ticks (~5 min) and self-wake by posting; also wake on @mention or DM
 */

import type { AgentLoopStore, AgentLoopRecord, ChannelMessageStore, ChannelStore } from "../db/interface.js";
import type { SessionSendFn } from "../transport/gateway-send.js";
import type { AuditLog } from "../audit/log.js";
import type { PluginLogger } from "../types.js";
import { uniqueId } from "../utils/id.js";

/** Base tick interval for AWAKE agents (ms). */
const TICK_INTERVAL_MS = 60_000;

/** Slow-tick interval for SLEEP agents (ms). 5 minutes. */
const SLOW_TICK_INTERVAL_MS = 300_000;

/** Max jitter applied to each tick (±). */
const TICK_JITTER_MS = 10_000;

/** Max jitter for slow-ticks (±). */
const SLOW_TICK_JITTER_MS = 60_000;

/** Maximum concurrent tick sends to prevent overload. */
const MAX_CONCURRENT_TICKS = 4;

/** Max retry attempts per tick send. */
const TICK_MAX_RETRIES = 2;

/** Consecutive tick failures before auto-sleeping an agent. */
const MAX_CONSECUTIVE_FAILURES = 3;

/* Agents continue work by making tool calls within a single turn
   (OpenClaw handles multi-turn tool loop internally). No re-tick needed. */

export interface WorkLoopSchedulerDeps {
  agentLoop: AgentLoopStore;
  /** Send a message to an agent's OpenClaw session. */
  sessionSend: SessionSendFn;
  channelMessages: ChannelMessageStore;
  channelStore: ChannelStore;
  audit: AuditLog;
  logger: PluginLogger;
}

export class WorkLoopScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private deps: WorkLoopSchedulerDeps;

  /** Track which channels each agent last saw (agentId → channelId → lastSeenSeq). */
  private agentChannelSeqs = new Map<string, Map<string, number>>();

  /** Track consecutive tick failures per agent for auto-sleep on unreachable agents. */
  private consecutiveFailures = new Map<string, number>();

  /** Track last slow-tick time per SLEEP agent (in-memory, not persisted). */
  private lastSlowTickAt = new Map<string, number>();

  /** Timestamp when start() was called — used for startup grace period. */
  private startedAt = 0;

  constructor(deps: WorkLoopSchedulerDeps) {
    this.deps = deps;
  }

  /**
   * Start the tick loop. Idempotent.
   */
  /** Grace period after start() before first tick — lets gateway finish booting.
   *  Needs to be generous: OpenClaw may build UI assets (~80s) before listening. */
  static readonly STARTUP_GRACE_MS = 90_000;

  start(): void {
    if (this.timer) return;
    this.running = true;
    this.startedAt = Date.now();

    // Check interval: half the base interval for responsive jitter handling
    const checkInterval = TICK_INTERVAL_MS / 2;
    this.timer = setInterval(() => void this.tick(), checkInterval);

    this.deps.logger.info(
      `[flock:loop] Work loop scheduler started (interval: ${TICK_INTERVAL_MS / 1000}s ± ${TICK_JITTER_MS / 1000}s)`,
    );
  }

  /**
   * Stop the tick loop. Idempotent.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.deps.logger.info(`[flock:loop] Work loop scheduler stopped`);
  }

  /**
   * Main tick: iterate AWAKE agents (fast tick) and SLEEP agents (slow tick).
   */
  private async tick(): Promise<void> {
    if (!this.running) return;

    const now = Date.now();

    // Skip ticks during startup grace period — gateway may not be ready yet.
    if (now - this.startedAt < WorkLoopScheduler.STARTUP_GRACE_MS) {
      return;
    }

    // --- Fast ticks for AWAKE agents ---
    const awakeAgents = this.deps.agentLoop.listByState("AWAKE");
    const dueAwake: AgentLoopRecord[] = [];
    for (const agent of awakeAgents) {
      const jitter = this.getAgentJitter(agent.agentId);
      const nextTickAt = agent.lastTickAt + TICK_INTERVAL_MS + jitter;
      if (now >= nextTickAt) {
        dueAwake.push(agent);
      }
    }

    // --- Slow ticks for SLEEP agents ---
    const sleepAgents = this.deps.agentLoop.listByState("SLEEP");
    const dueSleep: AgentLoopRecord[] = [];
    for (const agent of sleepAgents) {
      const lastSlow = this.lastSlowTickAt.get(agent.agentId) ?? 0;
      const jitter = this.getAgentJitter(agent.agentId);
      const slowJitter = Math.floor((jitter / TICK_JITTER_MS) * SLOW_TICK_JITTER_MS);
      const nextSlowTickAt = lastSlow + SLOW_TICK_INTERVAL_MS + slowJitter;
      if (now >= nextSlowTickAt) {
        dueSleep.push(agent);
      }
    }

    if (dueAwake.length === 0 && dueSleep.length === 0) return;

    if (dueAwake.length > 0) {
      this.deps.logger.debug?.(
        `[flock:loop] Ticking ${dueAwake.length} AWAKE agent(s): ${dueAwake.map(a => a.agentId).join(", ")}`,
      );
    }
    if (dueSleep.length > 0) {
      this.deps.logger.debug?.(
        `[flock:loop] Slow-ticking ${dueSleep.length} SLEEP agent(s): ${dueSleep.map(a => a.agentId).join(", ")}`,
      );
    }

    // Send ticks with concurrency limit (AWAKE first, then SLEEP)
    const queue: Array<{ agent: AgentLoopRecord; isSlow: boolean }> = [
      ...dueAwake.map(agent => ({ agent, isSlow: false })),
      ...dueSleep.map(agent => ({ agent, isSlow: true })),
    ];
    const executing: Promise<void>[] = [];

    while (queue.length > 0 || executing.length > 0) {
      while (queue.length > 0 && executing.length < MAX_CONCURRENT_TICKS) {
        const { agent, isSlow } = queue.shift()!;
        const tickFn = isSlow
          ? this.sendSlowTick(agent, now)
          : this.sendTick(agent, now);
        const promise = tickFn.then(() => {
          executing.splice(executing.indexOf(promise), 1);
        });
        executing.push(promise);
      }
      if (executing.length > 0) {
        await Promise.race(executing);
      }
    }
  }

  /**
   * Send per-channel ticks to an AWAKE agent.
   *
   * Each channel the agent belongs to that has new messages gets its own
   * tick message sent to a per-channel session:
   *   `agent:{agentId}:flock:channel:{channelId}`
   *
   * This gives each channel an isolated conversation thread — tool calls,
   * thinking, and context stay within the channel's scope, like a normal
   * assistant session.
   *
   * If no channels have updates, sends a brief "no activity" message to
   * the control session so the agent can decide to sleep.
   *
   * On failure: retries up to TICK_MAX_RETRIES times with exponential backoff.
   * After MAX_CONSECUTIVE_FAILURES consecutive failures, auto-sleeps the agent.
   */
  private async sendTick(agent: AgentLoopRecord, now: number): Promise<void> {
    const { agentLoop, sessionSend, audit, logger } = this.deps;

    // Update lastTickAt before sending (prevents double-ticks on slow responses)
    agentLoop.updateLastTick(agent.agentId, now);

    const channelUpdates = this.getChannelUpdates(agent.agentId);

    if (channelUpdates.length === 0) {
      // No channel activity — send a brief control message so the agent can sleep
      const controlMessage = this.buildNoActivityMessage(agent);
      await this.deliverMessage(agent, controlMessage, `agent:${agent.agentId}:flock:tick:control`, now);
      return;
    }

    // Send a separate tick to each channel with updates
    for (const update of channelUpdates) {
      const tickMessage = this.buildChannelTickMessage(agent, update);
      const sessionKey = `agent:${agent.agentId}:flock:channel:${update.channelId}`;
      // Fire each channel tick independently; don't let one channel failure block others
      await this.deliverMessage(agent, tickMessage, sessionKey, now);
    }
  }

  /**
   * Deliver a message to an agent session with retry and failure tracking.
   */
  private async deliverMessage(
    agent: AgentLoopRecord,
    message: string,
    sessionKey: string,
    now: number,
  ): Promise<boolean> {
    const { agentLoop, sessionSend, audit, logger } = this.deps;
    let delivered = false;

    for (let attempt = 0; attempt <= TICK_MAX_RETRIES; attempt++) {
      try {
        await sessionSend(agent.agentId, message, sessionKey);
        delivered = true;
        break;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn(`[flock:loop] Tick attempt ${attempt + 1}/${TICK_MAX_RETRIES + 1} failed for "${agent.agentId}" [${sessionKey}]: ${errorMsg}`);

        if (attempt < TICK_MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }

    if (delivered) {
      this.consecutiveFailures.delete(agent.agentId);
      logger.debug?.(`[flock:loop] Tick sent to "${agent.agentId}" [${sessionKey}]`);
    } else {
      const failures = (this.consecutiveFailures.get(agent.agentId) ?? 0) + 1;
      this.consecutiveFailures.set(agent.agentId, failures);

      audit.append({
        id: uniqueId("tick-err"),
        timestamp: now,
        agentId: agent.agentId,
        action: "tick-failed",
        level: "YELLOW",
        detail: `Tick failed [${sessionKey}] after ${TICK_MAX_RETRIES + 1} attempts (consecutive: ${failures})`,
        result: "error",
      });

      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        logger.warn(
          `[flock:loop] Agent "${agent.agentId}" unreachable for ${failures} consecutive ticks — auto-sleeping`,
        );
        agentLoop.setState(agent.agentId, "SLEEP", `Auto-slept: unreachable for ${failures} consecutive ticks`);
        this.consecutiveFailures.delete(agent.agentId);

        audit.append({
          id: uniqueId("auto-sleep"),
          timestamp: now,
          agentId: agent.agentId,
          action: "agent-auto-sleep",
          level: "YELLOW",
          detail: `Agent auto-slept after ${failures} consecutive tick failures — gateway session likely unavailable`,
          result: "completed",
        });
      }
    }

    return delivered;
  }

  /**
   * Send per-channel slow-ticks to a SLEEP agent.
   *
   * Each channel with recent activity gets its own slow-tick sent to the
   * channel's dedicated session. This maintains the per-channel isolation:
   * the SLEEP agent reviews each channel independently and can respond
   * within the appropriate session context.
   */
  private async sendSlowTick(agent: AgentLoopRecord, now: number): Promise<void> {
    const { channelStore, channelMessages, logger } = this.deps;

    this.lastSlowTickAt.set(agent.agentId, now);

    const channels = channelStore.list({ member: agent.agentId, archived: false });
    if (channels.length === 0) {
      logger.debug?.(`[flock:loop] No channels for SLEEP agent "${agent.agentId}" — skipping slow-tick`);
      return;
    }

    let sentCount = 0;
    for (const ch of channels) {
      const totalCount = channelMessages.count(ch.channelId);
      if (totalCount === 0) continue;

      const message = this.buildSlowTickChannelMessage(agent, ch, channelMessages);
      const sessionKey = `agent:${agent.agentId}:flock:channel:${ch.channelId}`;
      const delivered = await this.deliverMessage(agent, message, sessionKey, now);
      if (delivered) sentCount++;
    }

    if (sentCount === 0) {
      logger.debug?.(`[flock:loop] No channel activity for SLEEP agent "${agent.agentId}" — skipping slow-tick`);
    }
  }

  /**
   * Build a slow-tick message for a single channel.
   * Includes recent message preview so the SLEEP agent can decide whether to engage.
   */
  private buildSlowTickChannelMessage(
    agent: AgentLoopRecord,
    channel: { channelId: string; topic?: string; members: string[] },
    channelMessages: ChannelMessageStore,
  ): string {
    const sleepDuration = agent.sleptAt ? Date.now() - agent.sleptAt : 0;
    const sleepMins = Math.floor(sleepDuration / 60_000);

    const totalCount = channelMessages.count(channel.channelId);
    const allMessages = channelMessages.list({ channelId: channel.channelId });
    const recentMessages = allMessages.slice(-5);
    const preview = recentMessages.map(m =>
      `  [seq ${m.seq}] ${m.agentId}: ${m.content}`,
    ).join("\n");

    const header = channel.topic
      ? `#${channel.channelId} — ${channel.topic}`
      : `#${channel.channelId}`;

    const lines = [
      `[Sleep Tick — Channel Review]`,
      `State: SLEEP (${sleepMins}m)`,
      `Channel: ${header}`,
      `Members: ${channel.members.join(", ")} | ${totalCount} total messages`,
      ``,
      `You are currently sleeping. Recent activity in this channel:`,
      ``,
      preview,
      ``,
      `If this discussion is relevant to your role and you can contribute:`,
      `  Post to the channel: flock_channel_post(channelId="${channel.channelId}", message="...")`,
      `  This will automatically transition you to AWAKE state.`,
      ``,
      `If nothing requires your attention, do nothing — silence means stay asleep.`,
    ];

    return lines.join("\n");
  }

  /**
   * Build a tick message for a single channel.
   * Each channel gets its own session, so the message only contains
   * that channel's updates — no cross-channel pollution.
   */
  private buildChannelTickMessage(
    agent: AgentLoopRecord,
    update: { channelId: string; topic: string; newMessages: Array<{ agentId: string; content: string; seq: number }> },
  ): string {
    const awakeDuration = Date.now() - agent.awakenedAt;
    const awakeMins = Math.floor(awakeDuration / 60_000);

    const header = update.topic
      ? `#${update.channelId} — ${update.topic}`
      : `#${update.channelId}`;

    const lines: string[] = [
      `[Work Loop Tick — Channel Update]`,
      `State: AWAKE (${awakeMins}m)`,
      `Channel: ${header}`,
      ``,
      `--- New Messages (${update.newMessages.length}) ---`,
    ];

    for (const msg of update.newMessages) {
      lines.push(`  [${msg.agentId}]: ${msg.content}`);
    }

    lines.push(`--- End Messages ---`);
    lines.push(``);
    lines.push(`Continue your work in this channel. Review the new messages and respond if needed.`);
    lines.push(`Post your responses with: flock_channel_post(channelId="${update.channelId}", message="...")`);
    lines.push(`If you have nothing to do, call flock_sleep() to conserve resources.`);

    return lines.join("\n");
  }

  /**
   * Build a brief no-activity message for the control session.
   * Sent when an AWAKE agent has no channel updates — lets them decide to sleep.
   */
  private buildNoActivityMessage(agent: AgentLoopRecord): string {
    const awakeDuration = Date.now() - agent.awakenedAt;
    const awakeMins = Math.floor(awakeDuration / 60_000);

    const lines = [
      `[Work Loop Tick]`,
      `State: AWAKE (${awakeMins}m)`,
      `No new channel activity since last tick.`,
      ``,
      `If you have nothing to do and no pending work, call flock_sleep() to conserve resources.`,
    ];

    return lines.join("\n");
  }

  /**
   * Get channel updates for an agent since their last tick.
   *
   * Discovers channels from DB (via membership query) rather than relying
   * on an in-memory registration map. This ensures agents see new channels
   * they've been added to, even if the channel was created by a different
   * plugin instance or before this scheduler started.
   *
   * For newly discovered channels (not yet in agentChannelSeqs), lastSeenSeq
   * starts at 0 so all existing messages are included as "new".
   */
  private getChannelUpdates(agentId: string): Array<{
    channelId: string;
    topic: string;
    newMessages: Array<{ agentId: string; content: string; seq: number }>;
  }> {
    const { channelMessages, channelStore } = this.deps;
    const updates: Array<{
      channelId: string;
      topic: string;
      newMessages: Array<{ agentId: string; content: string; seq: number }>;
    }> = [];

    if (!this.agentChannelSeqs.has(agentId)) {
      this.agentChannelSeqs.set(agentId, new Map());
    }
    const seqs = this.agentChannelSeqs.get(agentId)!;

    // Query DB for all non-archived channels this agent is a member of.
    const channels = channelStore.list({ member: agentId, archived: false });

    for (const ch of channels) {
      // For channels not yet tracked, start at 0 so all messages appear new.
      const lastSeenSeq = seqs.get(ch.channelId) ?? 0;

      const newMessages = channelMessages.list({
        channelId: ch.channelId,
        since: lastSeenSeq + 1,
      });

      if (newMessages.length > 0) {
        updates.push({
          channelId: ch.channelId,
          topic: ch.topic ?? "",
          newMessages: newMessages.map(m => ({
            agentId: m.agentId,
            content: m.content,
            seq: m.seq,
          })),
        });

        const maxSeq = Math.max(...newMessages.map(m => m.seq));
        seqs.set(ch.channelId, maxSeq);
      }
    }

    return updates;
  }

  /**
   * Request an immediate tick for an agent, optionally scoped to a channel.
   *
   * If channelId is provided, sends a per-channel tick to that channel's
   * session only. If omitted, sends ticks to all channels with pending updates
   * (same as a regular periodic tick, but bypasses startup grace + schedule).
   *
   * Key property: does NOT change agent state. A SLEEP agent stays SLEEP,
   * an AWAKE agent stays AWAKE. The tick is purely a one-shot push.
   */
  async requestImmediateTick(agentId: string, channelId?: string): Promise<void> {
    const { agentLoop, logger } = this.deps;
    const record = agentLoop.get(agentId);
    if (!record) {
      logger.warn(`[flock:loop] requestImmediateTick: agent "${agentId}" not found in loop state`);
      return;
    }

    if (channelId) {
      logger.info(`[flock:loop] Immediate tick requested for "${agentId}" in channel "${channelId}"`);
      // Build update for the specific channel
      const update = this.getChannelUpdate(agentId, channelId);
      if (update) {
        const tickMessage = this.buildChannelTickMessage(record, update);
        const sessionKey = `agent:${agentId}:flock:channel:${channelId}`;
        await this.deliverMessage(record, tickMessage, sessionKey, Date.now());
      }
    } else {
      logger.info(`[flock:loop] Immediate tick requested for "${agentId}" (all channels)`);
      await this.sendTick(record, Date.now());
    }
  }

  /**
   * Get updates for a single channel for a specific agent.
   * Returns null if the channel has no new messages.
   */
  private getChannelUpdate(agentId: string, channelId: string): {
    channelId: string;
    topic: string;
    newMessages: Array<{ agentId: string; content: string; seq: number }>;
  } | null {
    const { channelMessages, channelStore } = this.deps;

    const channel = channelStore.get(channelId);
    if (!channel || !channel.members.includes(agentId)) return null;

    if (!this.agentChannelSeqs.has(agentId)) {
      this.agentChannelSeqs.set(agentId, new Map());
    }
    const seqs = this.agentChannelSeqs.get(agentId)!;
    const lastSeenSeq = seqs.get(channelId) ?? 0;

    const newMessages = channelMessages.list({
      channelId,
      since: lastSeenSeq + 1,
    });

    if (newMessages.length === 0) return null;

    const maxSeq = Math.max(...newMessages.map(m => m.seq));
    seqs.set(channelId, maxSeq);

    return {
      channelId,
      topic: channel.topic ?? "",
      newMessages: newMessages.map(m => ({
        agentId: m.agentId,
        content: m.content,
        seq: m.seq,
      })),
    };
  }

  /**
   * Deterministic per-agent jitter based on agent ID hash.
   * Returns a value in [-TICK_JITTER_MS, +TICK_JITTER_MS].
   */
  private getAgentJitter(agentId: string): number {
    let hash = 0;
    for (let i = 0; i < agentId.length; i++) {
      hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
    }
    // Normalize to [-1, 1] range
    const normalized = (hash % 1000) / 1000;
    return Math.floor(normalized * TICK_JITTER_MS);
  }
}
