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
import * as fs from "node:fs";
import * as path from "node:path";

/** Base tick interval in ms. */
const TICK_INTERVAL_MS = 60_000;

/** Max jitter applied to each tick (±). */
const TICK_JITTER_MS = 10_000;

/** Maximum concurrent tick sends to prevent overload. */
const MAX_CONCURRENT_TICKS = 1;

/** Delay between sequential tick sends (ms) to prevent lock contention. */
const TICK_DELAY_MS = 3_000;

/** Lock file age threshold (ms) - locks older than this are considered stale. */
const STALE_LOCK_THRESHOLD_MS = 60_000;

/* Agents continue work by making tool calls within a single turn
   (OpenClaw handles multi-turn tool loop internally). No re-tick needed. */

export interface WorkLoopSchedulerDeps {
  agentLoop: AgentLoopStore;
  a2aClient: A2AClient;
  threadMessages: ThreadMessageStore;
  audit: AuditLog;
  logger: PluginLogger;
  /** Base directory for agent data (for stale lock cleanup). */
  agentsDir?: string;
}

export class WorkLoopScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private deps: WorkLoopSchedulerDeps;
  /** Guard to prevent overlapping tick cycles. */
  private tickInProgress = false;

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

    // Prevent overlapping tick cycles - if previous cycle is still running, skip
    if (this.tickInProgress) {
      this.deps.logger.debug?.(`[flock:loop] Skipping tick - previous cycle still in progress`);
      return;
    }

    this.tickInProgress = true;
    try {
      await this.doTick();
    } finally {
      this.tickInProgress = false;
    }
  }

  /**
   * Actual tick implementation.
   */
  private async doTick(): Promise<void> {
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

    // Clean stale locks before ticking to prevent cascading failures
    this.cleanStaleLocks();

    // Send ticks sequentially with delays to prevent lock contention
    for (const agent of dueAgents) {
      await this.sendTick(agent, now);
      // Add delay between ticks to let locks settle
      if (dueAgents.indexOf(agent) < dueAgents.length - 1) {
        await this.delay(TICK_DELAY_MS);
      }
    }
  }

  /**
   * Delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clean up stale lock files that are older than STALE_LOCK_THRESHOLD_MS.
   * This prevents deadlocks from crashed processes leaving locks behind.
   */
  private cleanStaleLocks(): void {
    const { agentsDir, logger } = this.deps;
    if (!agentsDir) return;

    try {
      const now = Date.now();
      const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const agentDir of agentDirs) {
        const sessionsDir = path.join(agentsDir, agentDir, "sessions");
        if (!fs.existsSync(sessionsDir)) continue;

        const files = fs.readdirSync(sessionsDir);
        for (const file of files) {
          if (!file.endsWith(".lock")) continue;

          const lockPath = path.join(sessionsDir, file);
          try {
            const stat = fs.statSync(lockPath);
            const age = now - stat.mtimeMs;
            if (age > STALE_LOCK_THRESHOLD_MS) {
              fs.unlinkSync(lockPath);
              logger.info(`[flock:loop] Cleaned stale lock: ${lockPath} (age: ${Math.floor(age / 1000)}s)`);
            }
          } catch {
            // Lock file may have been deleted by another process
          }
        }
      }
    } catch (err) {
      logger.debug?.(`[flock:loop] Error cleaning stale locks: ${err}`);
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
