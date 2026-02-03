/**
 * Work Loop Scheduler
 *
 * Drives the agent work loop. AWAKE agents receive periodic "tick" messages
 * via A2A, giving them a chance to continue work, check threads, and decide
 * whether to sleep.
 *
 * Design:
 * - Global tick interval: 60s ± 10s jitter (prevents synchronized ticks)
 * - AWAKE agents get ticked; SLEEP agents are skipped
 * - Each tick sends an A2A message with context (new thread messages, etc.)
 * - Agents control their own SLEEP transition via flock_sleep tool
 * - SLEEP agents wake only on explicit triggers (direct message, mention, flock_wake)
 */

import type { AgentLoopStore, AgentLoopRecord, ThreadMessageStore } from "../db/interface.js";
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

export interface WorkLoopSchedulerDeps {
  agentLoop: AgentLoopStore;
  a2aClient: A2AClient;
  threadMessages: ThreadMessageStore;
  audit: AuditLog;
  logger: PluginLogger;
}

export class WorkLoopScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private deps: WorkLoopSchedulerDeps;

  /** Track which threads each agent last saw (agentId → threadId → lastSeenSeq). */
  private agentThreadSeqs = new Map<string, Map<string, number>>();

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
   */
  private async sendTick(agent: AgentLoopRecord, now: number): Promise<void> {
    const { agentLoop, a2aClient, audit, logger } = this.deps;

    // Update lastTickAt before sending (prevents double-ticks on slow responses)
    agentLoop.updateLastTick(agent.agentId, now);

    try {
      const tickMessage = this.buildTickMessage(agent);

      // Fire-and-forget: send tick without waiting for response processing
      // The agent's response (if any) will flow through normal A2A channels
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
   * Includes: active thread updates, general status, sleep hint.
   */
  private buildTickMessage(agent: AgentLoopRecord): string {
    const { threadMessages } = this.deps;

    // Collect new thread messages since last tick
    const threadUpdates = this.getThreadUpdates(agent.agentId);

    const awakeDuration = Date.now() - agent.awakenedAt;
    const awakeMins = Math.floor(awakeDuration / 60_000);

    const lines: string[] = [
      `[Work Loop Tick]`,
      `State: AWAKE (${awakeMins}m)`,
    ];

    if (threadUpdates.length > 0) {
      lines.push(``);
      lines.push(`--- New Thread Activity ---`);
      for (const update of threadUpdates) {
        lines.push(`Thread ${update.threadId} (${update.newMessages.length} new):`);
        for (const msg of update.newMessages) {
          lines.push(`  [${msg.agentId}]: ${msg.content.slice(0, 200)}`);
        }
      }
      lines.push(`--- End Thread Activity ---`);
    } else {
      lines.push(`No new thread activity since last tick.`);
    }

    lines.push(``);
    lines.push(`Continue your work. Review any new thread messages and respond if needed.`);
    lines.push(`If you have nothing to do and no pending work, call flock_sleep() to conserve resources.`);

    return lines.join("\n");
  }

  /**
   * Get thread updates for an agent since their last tick.
   * Tracks which threads the agent has seen via agentThreadSeqs.
   */
  private getThreadUpdates(agentId: string): Array<{
    threadId: string;
    newMessages: Array<{ agentId: string; content: string; seq: number }>;
  }> {
    const { threadMessages } = this.deps;
    const updates: Array<{
      threadId: string;
      newMessages: Array<{ agentId: string; content: string; seq: number }>;
    }> = [];

    // Get the agent's tracked thread seqs
    if (!this.agentThreadSeqs.has(agentId)) {
      this.agentThreadSeqs.set(agentId, new Map());
    }
    const seqs = this.agentThreadSeqs.get(agentId)!;

    // We need to know which threads this agent participates in.
    // For now, check all threads the agent has ever posted to.
    // This is a pragmatic approach — we can optimize later with a participation index.
    // For efficiency, we only check threads where the agent has a tracked seq.
    for (const [threadId, lastSeenSeq] of seqs) {
      const newMessages = threadMessages.list({
        threadId,
        since: lastSeenSeq + 1,
      });

      if (newMessages.length > 0) {
        updates.push({
          threadId,
          newMessages: newMessages.map(m => ({
            agentId: m.agentId,
            content: m.content,
            seq: m.seq,
          })),
        });

        // Update the last seen seq
        const maxSeq = Math.max(...newMessages.map(m => m.seq));
        seqs.set(threadId, maxSeq);
      }
    }

    return updates;
  }

  /**
   * Register that an agent is participating in a thread.
   * Called when an agent posts to or is notified about a thread.
   */
  trackThread(agentId: string, threadId: string, currentSeq: number): void {
    if (!this.agentThreadSeqs.has(agentId)) {
      this.agentThreadSeqs.set(agentId, new Map());
    }
    const seqs = this.agentThreadSeqs.get(agentId)!;
    // Only update if this is a newer seq than what we have
    const existing = seqs.get(threadId) ?? 0;
    if (currentSeq > existing) {
      seqs.set(threadId, currentSeq);
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
