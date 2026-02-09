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
 * - SLEEP agents wake only on explicit triggers (direct message, mention, flock_wake)
 */

import type { AgentLoopStore, AgentLoopRecord, ChannelMessageStore, ChannelStore } from "../db/interface.js";
import type { A2AClient } from "../transport/client.js";
import type { AuditLog } from "../audit/log.js";
import type { PluginLogger } from "../types.js";
import { userMessage } from "../transport/a2a-helpers.js";

/** Base tick interval in ms. */
const TICK_INTERVAL_MS = 60_000;

/** Max jitter applied to each tick (±). */
const TICK_JITTER_MS = 10_000;

/** Maximum concurrent tick sends to prevent overload. */
const MAX_CONCURRENT_TICKS = 4;

/* Agents continue work by making tool calls within a single turn
   (OpenClaw handles multi-turn tool loop internally). No re-tick needed. */

export interface WorkLoopSchedulerDeps {
  agentLoop: AgentLoopStore;
  a2aClient: A2AClient;
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


  constructor(deps: WorkLoopSchedulerDeps) {
    this.deps = deps;
  }

  /**
   * Start the tick loop. Idempotent.
   */
  start(): void {
    if (this.timer) return;
    this.running = true;

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
   * Main tick: iterate AWAKE agents and send ticks to those that are due.
   */
  private async tick(): Promise<void> {
    if (!this.running) return;

    const now = Date.now();
    const awakeAgents = this.deps.agentLoop.listByState("AWAKE");

    if (awakeAgents.length === 0) return;

    // Determine which agents are due for a tick (with per-agent jitter)
    const dueAgents: AgentLoopRecord[] = [];
    for (const agent of awakeAgents) {
      const jitter = this.getAgentJitter(agent.agentId);
      const nextTickAt = agent.lastTickAt + TICK_INTERVAL_MS + jitter;
      if (now >= nextTickAt) {
        dueAgents.push(agent);
      }
    }

    if (dueAgents.length === 0) return;

    this.deps.logger.debug?.(
      `[flock:loop] Ticking ${dueAgents.length} agent(s): ${dueAgents.map(a => a.agentId).join(", ")}`,
    );

    // Send ticks with concurrency limit
    const queue = [...dueAgents];
    const executing: Promise<void>[] = [];

    while (queue.length > 0 || executing.length > 0) {
      while (queue.length > 0 && executing.length < MAX_CONCURRENT_TICKS) {
        const agent = queue.shift()!;
        const promise = this.sendTick(agent, now).then(() => {
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
   * Send a tick to a single agent.
   *
   * The agent continues work by making tool calls within a single turn —
   * OpenClaw handles the multi-turn tool loop internally. Three outcomes:
   *   1. Agent keeps calling tools → continuous work within this tick
   *   2. Agent returns final text → waits for next tick (~60s)
   *   3. Agent calls flock_sleep() then returns → enters SLEEP state
   */
  private async sendTick(agent: AgentLoopRecord, now: number): Promise<void> {
    const { agentLoop, a2aClient, audit, logger } = this.deps;

    // Update lastTickAt before sending (prevents double-ticks on slow responses)
    agentLoop.updateLastTick(agent.agentId, now);

    try {
      const tickMessage = this.buildTickMessage(agent);

      await a2aClient.sendA2A(agent.agentId, {
        message: userMessage(tickMessage),
      });

      logger.debug?.(`[flock:loop] Tick sent to "${agent.agentId}"`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`[flock:loop] Tick failed for "${agent.agentId}": ${errorMsg}`);

      audit.append({
        id: `tick-err-${agent.agentId}-${now}`,
        timestamp: now,
        agentId: agent.agentId,
        action: "tick-failed",
        level: "YELLOW",
        detail: `Work loop tick failed: ${errorMsg.slice(0, 200)}`,
        result: "error",
      });
    }
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
    const existing = seqs.get(channelId) ?? 0;
    if (currentSeq > existing) {
      seqs.set(channelId, currentSeq);
    }
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
