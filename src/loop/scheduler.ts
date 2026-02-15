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
import type { A2AClient } from "../transport/client.js";
import type { AuditLog } from "../audit/log.js";
import type { PluginLogger } from "../types.js";
import { userMessage, dataPart } from "../transport/a2a-helpers.js";
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
  a2aClient: A2AClient;
  channelMessages: ChannelMessageStore;
  channelStore: ChannelStore;
  audit: AuditLog;
  logger: PluginLogger;
  /** Override the base tick interval (ms). Default: 60_000. */
  tickIntervalMs?: number;
  /** Override the slow-tick interval for SLEEP agents (ms). Default: 300_000. */
  slowTickIntervalMs?: number;
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

  /** Effective tick interval (configurable for tests). */
  private readonly tickIntervalMs: number;

  /** Effective slow-tick interval for SLEEP agents (configurable for tests). */
  private readonly slowTickIntervalMs: number;

  constructor(deps: WorkLoopSchedulerDeps) {
    this.deps = deps;
    this.tickIntervalMs = deps.tickIntervalMs ?? TICK_INTERVAL_MS;
    this.slowTickIntervalMs = deps.slowTickIntervalMs ?? SLOW_TICK_INTERVAL_MS;
  }

  /**
   * Start the tick loop. Idempotent.
   */
  start(): void {
    if (this.timer) return;
    this.running = true;

    // Check interval: half the base interval for responsive jitter handling
    const checkInterval = this.tickIntervalMs / 2;
    this.timer = setInterval(() => void this.tick(), checkInterval);

    const jitterMax = Math.min(TICK_JITTER_MS, Math.floor(this.tickIntervalMs / 6));
    this.deps.logger.info(
      `[flock:loop] Work loop scheduler started (interval: ${this.tickIntervalMs / 1000}s ± ${jitterMax / 1000}s)`,
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

    // --- Fast ticks for AWAKE agents ---
    const awakeAgents = this.deps.agentLoop.listByState("AWAKE");
    const dueAwake: AgentLoopRecord[] = [];
    for (const agent of awakeAgents) {
      // Skip agents with no tracked channels — they haven't been assigned
      // to any project yet, so ticking them wastes an LLM call.
      const trackedChannels = this.agentChannelSeqs.get(agent.agentId);
      if (!trackedChannels || trackedChannels.size === 0) {
        continue;
      }
      const jitter = this.getAgentJitter(agent.agentId);
      const nextTickAt = agent.lastTickAt + this.tickIntervalMs + jitter;
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
      const nextSlowTickAt = lastSlow + this.slowTickIntervalMs + slowJitter;
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
   * Send a tick to a single agent with retry.
   *
   * The agent continues work by making tool calls within a single turn —
   * OpenClaw handles the multi-turn tool loop internally. Three outcomes:
   *   1. Agent keeps calling tools → continuous work within this tick
   *   2. Agent returns final text → waits for next tick (~60s)
   *   3. Agent calls flock_sleep() then returns → enters SLEEP state
   *
   * On failure: retries up to TICK_MAX_RETRIES times with exponential backoff.
   * After MAX_CONSECUTIVE_FAILURES consecutive failures, auto-sleeps the agent
   * to prevent wasting resources on unreachable agents.
   */
  private async sendTick(agent: AgentLoopRecord, now: number): Promise<void> {
    const { agentLoop, a2aClient, audit, logger } = this.deps;

    // Update lastTickAt before sending (prevents double-ticks on slow responses)
    agentLoop.updateLastTick(agent.agentId, now);

    const tickMessage = this.buildTickMessage(agent);
    let delivered = false;

    for (let attempt = 0; attempt <= TICK_MAX_RETRIES; attempt++) {
      try {
        const result = await a2aClient.sendA2A(agent.agentId, {
          message: userMessage(tickMessage, [
            dataPart({ sessionRouting: { chatType: "tick", peerId: "control" } }),
          ]),
        });

        // If the agent was busy (executor caught the error), skip gracefully.
        if (result.state === "failed" && result.response.includes("already processing")) {
          logger.debug?.(`[flock:loop] Agent "${agent.agentId}" busy — skipping tick`);
          this.consecutiveFailures.delete(agent.agentId);
          return;
        }

        delivered = true;
        break;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        // If the agent is already processing a prompt, skip gracefully.
        if (errorMsg.includes("already processing")) {
          logger.debug?.(`[flock:loop] Agent "${agent.agentId}" busy — skipping tick`);
          this.consecutiveFailures.delete(agent.agentId);
          return;
        }

        logger.warn(`[flock:loop] Tick attempt ${attempt + 1}/${TICK_MAX_RETRIES + 1} failed for "${agent.agentId}": ${errorMsg}`);

        if (attempt < TICK_MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }

    if (delivered) {
      // Reset consecutive failure counter on success
      this.consecutiveFailures.delete(agent.agentId);
      logger.debug?.(`[flock:loop] Tick sent to "${agent.agentId}"`);
    } else {
      // Track consecutive failures
      const failures = (this.consecutiveFailures.get(agent.agentId) ?? 0) + 1;
      this.consecutiveFailures.set(agent.agentId, failures);

      audit.append({
        id: uniqueId("tick-err"),
        timestamp: now,
        agentId: agent.agentId,
        action: "tick-failed",
        level: "YELLOW",
        detail: `Work loop tick failed after ${TICK_MAX_RETRIES + 1} attempts (consecutive failures: ${failures})`,
        result: "error",
      });

      // Auto-sleep agent after too many consecutive failures
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
  }

  /**
   * Send a slow-tick to a SLEEP agent.
   *
   * Slow-ticks provide a channel activity summary so SLEEP agents can decide
   * whether to self-wake. The agent reviews recent channel activity and either:
   *   1. Calls flock_sleep() again → stays SLEEP (or simply returns)
   *   2. Responds / makes tool calls → indicates interest, but stays SLEEP
   *      until they explicitly call self-wake or the scheduler sees engagement
   *
   * The slow-tick message instructs the agent to call flock_channel_post if
   * they want to participate, which will naturally transition them to AWAKE
   * as they start engaging in work loop ticks.
   */
  private async sendSlowTick(agent: AgentLoopRecord, now: number): Promise<void> {
    const { a2aClient, audit, logger } = this.deps;

    this.lastSlowTickAt.set(agent.agentId, now);

    const message = this.buildSlowTickMessage(agent);
    if (!message) {
      // No channel activity to report — skip this slow-tick entirely
      logger.debug?.(`[flock:loop] No channel activity for SLEEP agent "${agent.agentId}" — skipping slow-tick`);
      return;
    }

    try {
      await a2aClient.sendA2A(agent.agentId, {
        message: userMessage(message, [
          dataPart({ sessionRouting: { chatType: "tick", peerId: "control" } }),
        ]),
      });
      logger.debug?.(`[flock:loop] Slow-tick sent to SLEEP agent "${agent.agentId}"`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`[flock:loop] Slow-tick failed for SLEEP agent "${agent.agentId}": ${errorMsg}`);

      audit.append({
        id: uniqueId("slow-tick-err"),
        timestamp: now,
        agentId: agent.agentId,
        action: "slow-tick-failed",
        level: "YELLOW",
        detail: `Slow-tick to SLEEP agent failed: ${errorMsg.slice(0, 200)}`,
        result: "error",
      });
    }
  }

  /**
   * Build the slow-tick message for a SLEEP agent.
   * Returns null if there's no channel activity to report.
   *
   * The message includes a summary of all channels the agent is a member of
   * with recent activity, and instructs the agent to self-wake if interested.
   */
  private buildSlowTickMessage(agent: AgentLoopRecord): string | null {
    const { channelStore, channelMessages } = this.deps;

    // Find all channels this agent is a member of
    const channels = channelStore.list({ member: agent.agentId, archived: false });
    if (channels.length === 0) return null;

    const channelSummaries: string[] = [];

    for (const ch of channels) {
      const totalCount = channelMessages.count(ch.channelId);
      if (totalCount === 0) continue;

      // Get recent messages (last 5) as a preview
      const allMessages = channelMessages.list({ channelId: ch.channelId });
      const recentMessages = allMessages.slice(-5);
      const preview = recentMessages.map(m =>
        `  [seq ${m.seq}] ${m.agentId}: ${m.content.slice(0, 120)}`,
      ).join("\n");

      channelSummaries.push(
        `#${ch.channelId} — ${ch.topic}\n` +
        `  Members: ${ch.members.join(", ")} | ${totalCount} total messages\n` +
        preview,
      );
    }

    if (channelSummaries.length === 0) return null;

    const sleepDuration = agent.sleptAt ? Date.now() - agent.sleptAt : 0;
    const sleepMins = Math.floor(sleepDuration / 60_000);

    const lines = [
      `[Sleep Tick — Periodic Channel Review]`,
      `State: SLEEP (${sleepMins}m)`,
      ``,
      `You are currently sleeping. Here is a summary of recent channel activity:`,
      ``,
      `--- Channel Activity Summary ---`,
      ...channelSummaries,
      `--- End Summary ---`,
      ``,
      `Review the activity above. If any discussion is relevant to your role and you can contribute:`,
      `  1. Post to the channel: flock_channel_post(channelId="...", message="...")`,
      `  2. This will automatically transition you to AWAKE state.`,
      ``,
      `If nothing requires your attention, do nothing — you will stay asleep and check again in ~5 minutes.`,
      `Do NOT wake up just to say "nothing to do". Silence is the correct response when sleeping.`,
    ];

    return lines.join("\n");
  }

  /**
   * Build the tick message content for an agent.
   * Includes: active channel updates with name/topic, general status, sleep hint.
   */
  private buildTickMessage(agent: AgentLoopRecord): string {
    const channelUpdates = this.getChannelUpdates(agent.agentId);

    const awakeDuration = Date.now() - agent.awakenedAt;
    const awakeMins = Math.floor(awakeDuration / 60_000);

    const lines: string[] = [
      `[Work Loop Tick]`,
      `State: AWAKE (${awakeMins}m)`,
    ];

    if (channelUpdates.length > 0) {
      lines.push(``);
      lines.push(`--- New Channel Activity ---`);
      for (const update of channelUpdates) {
        const header = update.topic
          ? `#${update.channelId} — ${update.topic}`
          : `#${update.channelId}`;
        lines.push(`${header} (${update.newMessages.length} new):`);
        for (const msg of update.newMessages) {
          lines.push(`  [${msg.agentId}]: ${msg.content.slice(0, 200)}`);
        }
      }
      lines.push(`--- End Channel Activity ---`);
    } else {
      lines.push(`No new channel activity since last tick.`);
    }

    lines.push(``);
    lines.push(`Continue your work. Review any new channel messages and respond if needed.`);
    lines.push(`If you have nothing to do and no pending work, call flock_sleep() to conserve resources.`);

    return lines.join("\n");
  }

  /**
   * Get channel updates for an agent since their last tick.
   * Tracks which channels the agent has seen via agentChannelSeqs.
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

    // Check all channels the agent has been tracked in
    for (const [channelId, lastSeenSeq] of seqs) {
      const newMessages = channelMessages.list({
        channelId,
        since: lastSeenSeq + 1,
      });

      if (newMessages.length > 0) {
        // Look up channel metadata for rich context
        const channel = channelStore.get(channelId);

        updates.push({
          channelId,
          topic: channel?.topic ?? "",
          newMessages: newMessages.map(m => ({
            agentId: m.agentId,
            content: m.content,
            seq: m.seq,
          })),
        });

        const maxSeq = Math.max(...newMessages.map(m => m.seq));
        seqs.set(channelId, maxSeq);
      }
    }

    return updates;
  }

  /**
   * Register that an agent is participating in a channel.
   * Called when an agent posts to or is notified about a channel.
   */
  trackChannel(agentId: string, channelId: string, currentSeq: number): void {
    if (!this.agentChannelSeqs.has(agentId)) {
      this.agentChannelSeqs.set(agentId, new Map());
    }
    const seqs = this.agentChannelSeqs.get(agentId)!;
    if (!seqs.has(channelId) || currentSeq > seqs.get(channelId)!) {
      seqs.set(channelId, currentSeq);
    }
  }

  /**
   * Request an immediate one-shot tick for an agent.
   *
   * Used when an agent is @mentioned in a channel — triggers a tick
   * so they see the new messages immediately rather than waiting for
   * the next periodic cycle.
   *
   * Key property: does NOT change agent state. A REACTIVE agent stays
   * REACTIVE, a SLEEP agent stays SLEEP. The tick is purely a one-shot
   * push through the same `tick:control` session route.
   */
  async requestImmediateTick(agentId: string): Promise<void> {
    const { agentLoop, logger } = this.deps;
    const record = agentLoop.get(agentId);
    if (!record) {
      logger.warn(`[flock:loop] requestImmediateTick: agent "${agentId}" not found in loop state`);
      return;
    }
    logger.info(`[flock:loop] Immediate tick requested for "${agentId}" (state: ${record.state})`);
    await this.sendTick(record, Date.now());
  }

  /**
   * Deterministic per-agent jitter based on agent ID hash.
   * Returns a value in [-jitterMax, +jitterMax].
   * Jitter scales with tickIntervalMs — capped at 1/6 of interval to prevent
   * jitter exceeding interval length.
   */
  private getAgentJitter(agentId: string): number {
    let hash = 0;
    for (let i = 0; i < agentId.length; i++) {
      hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
    }
    // Normalize to [-1, 1] range
    const normalized = (hash % 1000) / 1000;
    // Jitter max: TICK_JITTER_MS for default interval, but never more than 1/6 of interval
    const jitterMax = Math.min(TICK_JITTER_MS, Math.floor(this.tickIntervalMs / 6));
    return Math.floor(normalized * jitterMax);
  }
}
