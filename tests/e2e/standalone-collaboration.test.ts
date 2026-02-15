/**
 * Standalone E2E: 3-agent collaboration with review cycle
 *
 * Tests the FULL multi-agent collaboration pipeline:
 *   1. Boot Flock standalone with 3 agents (orchestrator, coder, reviewer)
 *   2. Send ONE external message to orchestrator
 *   3. Orchestrator creates channel, posts task, adds all members
 *   4. WorkLoopScheduler auto-ticks coder → reads channel, writes code, posts completion
 *   5. WorkLoopScheduler auto-ticks reviewer → reads coder's post, reviews code via workspace_read
 *   6. Reviewer posts review feedback to channel
 *   7. Verify: 3-way conversation in channel, file written, all agents participated
 *
 * This validates the REACTION CHAIN: A posts → scheduler ticks B → B posts →
 * scheduler ticks C → C posts. All driven by a single external trigger.
 *
 * NO mocks, NO fallbacks, NO hardcoded system prompts.
 * System prompts come from production templates (assembleAgentsMd).
 *
 * Requires valid credentials in ~/.flock/auth.json.
 *
 * Run: npx vitest run tests/e2e/standalone-collaboration.test.ts
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { startFlock, type FlockInstance } from "../../src/standalone.js";
import { resolveFlockConfig } from "../../src/config.js";
import { createApiKeyResolver } from "../../src/auth/resolver.js";

const MODEL = "anthropic/claude-sonnet-4-20250514";
const getApiKey = createApiKeyResolver();

/** Tick interval for tests — fast enough for E2E, slow enough to avoid races. */
const TEST_TICK_INTERVAL_MS = 5_000;

/** Poll interval when checking for completion. */
const POLL_INTERVAL_MS = 2_000;

/** Max time to wait for each phase. */
const PHASE_TIMEOUT_MS = 120_000;

let instance: FlockInstance;
let vaultsDir: string;
let httpPort: number;
let hasCredentials = false;

// ---------------------------------------------------------------------------
// A2A HTTP helpers
// ---------------------------------------------------------------------------

async function sendA2A(
  agentId: string,
  text: string,
  timeoutMs = 120_000,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      method: "message/send",
      params: {
        message: {
          messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          role: "user",
          parts: [{ kind: "text", text }],
        },
      },
    });

    const req = http.request(
      `http://127.0.0.1:${httpPort}/flock/a2a/${agentId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(body) as Record<string, unknown>,
            });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: null });
          }
        });
      },
    );
    req.on("error", () => resolve({ status: 0, body: null }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 0, body: null });
    });
    req.write(payload);
    req.end();
  });
}

function getResponseText(body: Record<string, unknown> | null): string | null {
  const result = body?.result as Record<string, unknown> | undefined;
  const status = result?.status as Record<string, unknown> | undefined;
  const message = status?.message as Record<string, unknown> | undefined;
  const parts = message?.parts as Array<{ kind: string; text?: string }> | undefined;
  if (!parts) return null;
  return parts
    .filter((p) => p.kind === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("") || null;
}

async function pollUntil(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return condition();
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const key = await getApiKey("anthropic");
  if (!key) {
    console.warn("[e2e] No Anthropic API key — tests will be skipped");
    return;
  }
  hasCredentials = true;

  vaultsDir = mkdtempSync(join(tmpdir(), "flock-e2e-collab-"));
  mkdirSync(join(vaultsDir, "primes-project"), { recursive: true });

  httpPort = 3900 + Math.floor(Math.random() * 100);

  const config = resolveFlockConfig({
    dbBackend: "memory",
    nodeId: "e2e-node",
    vaultsBasePath: vaultsDir,
    gateway: { port: httpPort - 1, token: "e2e-token" },
    gatewayAgents: [
      { id: "orchestrator", role: "orchestrator", model: MODEL },
      { id: "coder", role: "worker", model: MODEL, archetype: "code-first-developer" },
      { id: "reviewer", role: "worker", model: MODEL, archetype: "code-reviewer" },
    ],
  });

  instance = await startFlock({
    config,
    httpPort,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
  });
}, 30_000);

afterAll(async () => {
  if (instance) await instance.stop();
  if (vaultsDir && existsSync(vaultsDir)) {
    rmSync(vaultsDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests — sequential, each phase depends on the previous
// ---------------------------------------------------------------------------

describe("3-agent collaboration E2E", { timeout: 600_000 }, () => {
  it("all 3 agents are registered", async () => {
    if (!hasCredentials) return;

    const res = await new Promise<{ status: number; body: string }>((resolve) => {
      http.get(
        `http://127.0.0.1:${httpPort}/flock/.well-known/agent-card.json`,
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      ).on("error", () => resolve({ status: 0, body: "" }));
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    const agentIds = (parsed.agents as Array<{ id: string }>).map((a) => a.id).sort();
    console.log("[e2e] registered agents:", agentIds);
    expect(agentIds).toEqual(["coder", "orchestrator", "reviewer"]);
  });

  it("orchestrator creates channel with all 3 members and posts the task (only external message)", async () => {
    if (!hasCredentials) return;

    // This is the ONLY external A2A message in the entire test.
    // The orchestrator will:
    //   1. Create a channel with coder AND reviewer as members
    //   2. Post the task specification to the channel
    // Then the scheduler drives everything else.
    const response = await sendA2A(
      "orchestrator",
      [
        "새 프로젝트를 시작해주세요.",
        "",
        '1. flock_channel_create로 "primes" 채널을 만들어주세요:',
        '   - topic: "Write a Python prime number checker"',
        '   - members: ["coder", "reviewer"]',
        "",
        "2. 채널 생성 후, flock_channel_post로 다음 작업 내용을 채널에 올려주세요:",
        "   Python으로 소수 판별 함수를 작성하세요.",
        '   함수명: is_prime(n: int) -> bool',
        "   요구사항:",
        "   - n이 2 미만이면 False",
        "   - n이 2이면 True",
        "   - n이 짝수이면 False",
        "   - sqrt(n)까지만 홀수로 나눠보기",
        '   flock_workspace_write로 "primes-project" 워크스페이스에 primes.py로 저장하세요.',
        '   파일 끝에 테스트 코드를 포함하세요:',
        '   assert is_prime(2) == True',
        '   assert is_prime(3) == True',
        '   assert is_prime(4) == False',
        '   assert is_prime(17) == True',
        '   assert is_prime(100) == False',
        '   print("All tests passed")',
        "",
        "   coder가 코드를 작성하면 reviewer가 리뷰할 것입니다.",
        "",
        "도구를 직접 호출해주세요. 설명만 하지 마세요.",
      ].join("\n"),
      120_000,
    );

    console.log("[e2e:orchestrator] HTTP status:", response.status);
    const text = getResponseText(response.body);
    console.log("[e2e:orchestrator] response:", text);

    expect(response.status).toBe(200);
    expect(text).toBeDefined();

    // Verify channel was created with all 3 members
    const channels = instance.toolDeps.channelStore.list();
    expect(channels.some((c) => c.channelId === "primes")).toBe(true);

    const primesChannel = channels.find((c) => c.channelId === "primes")!;
    console.log("[e2e:verify] channel:", JSON.stringify({
      channelId: primesChannel.channelId,
      topic: primesChannel.topic,
      members: primesChannel.members,
    }));

    expect(primesChannel.createdBy).toBe("orchestrator");
    expect(primesChannel.members).toContain("coder");
    expect(primesChannel.members).toContain("reviewer");

    const messages = instance.toolDeps.channelMessages.list({ channelId: "primes" });
    console.log(`[e2e:verify] initial messages: ${messages.length}`);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it("coder auto-ticked → writes primes.py and posts to channel", async () => {
    if (!hasCredentials) return;

    const primesPath = join(vaultsDir, "primes-project", "primes.py");

    console.log("[e2e:phase2] Waiting for coder to write primes.py...");

    // Wait for file to be written
    const fileWritten = await pollUntil(
      () => existsSync(primesPath),
      PHASE_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );

    expect(fileWritten).toBe(true);

    const code = readFileSync(primesPath, "utf-8");
    console.log("[e2e:verify] primes.py:\n" + code);

    expect(code).toContain("is_prime");
    expect(code).toContain("def ");
    expect(code.length).toBeGreaterThan(50);

    // Wait for coder to post completion message
    console.log("[e2e:phase2] Waiting for coder to post to channel...");
    const coderPosted = await pollUntil(
      () => instance.toolDeps.channelMessages
        .list({ channelId: "primes" })
        .some((m) => m.agentId === "coder"),
      60_000,
      POLL_INTERVAL_MS,
    );
    expect(coderPosted).toBe(true);

    const messages = instance.toolDeps.channelMessages.list({ channelId: "primes" });
    const coderMsgs = messages.filter((m) => m.agentId === "coder");
    console.log(`[e2e:verify] coder messages: ${coderMsgs.length}`);
    for (const m of coderMsgs) {
      console.log(`  [coder] (seq ${m.seq}): ${m.content}`);
    }
  });

  it("reviewer auto-ticked → reads code via workspace_read and posts review AFTER coder", async () => {
    if (!hasCredentials) return;

    // After coder posts to the channel, the scheduler will tick reviewer
    // on the NEXT cycle (reviewer sees coder's new message as channel activity).
    // Reviewer should:
    //   1. Read channel to see coder's completion message
    //   2. Use flock_workspace_read to read primes.py
    //   3. Post review feedback to the channel
    //
    // NOTE: reviewer may also be ticked concurrently with coder and post
    // a placeholder "waiting for code" message. That's fine — we verify
    // that a reviewer message exists AFTER coder's last message (seq-wise),
    // proving the reaction chain works.

    // Find coder's last message seq
    const coderMessages = instance.toolDeps.channelMessages
      .list({ channelId: "primes" })
      .filter((m) => m.agentId === "coder");
    const coderLastSeq = Math.max(...coderMessages.map((m) => m.seq));
    console.log(`[e2e:phase3] Coder's last message: seq ${coderLastSeq}`);
    console.log("[e2e:phase3] Waiting for reviewer to post AFTER coder (reaction chain)...");

    const reviewerReacted = await pollUntil(
      () => instance.toolDeps.channelMessages
        .list({ channelId: "primes" })
        .some((m) => m.agentId === "reviewer" && m.seq > coderLastSeq),
      PHASE_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );

    if (!reviewerReacted) {
      // Diagnostic dump
      const messages = instance.toolDeps.channelMessages.list({ channelId: "primes" });
      console.error("[e2e:phase3] TIMEOUT — reviewer did not post after coder");
      console.error("[e2e:phase3] Channel messages:", messages.length);
      for (const m of messages) {
        console.error(`  [${m.agentId}] (seq ${m.seq}): ${m.content}`);
      }
    }

    expect(reviewerReacted).toBe(true);

    const messages = instance.toolDeps.channelMessages.list({ channelId: "primes" });
    const reviewerMsgs = messages.filter((m) => m.agentId === "reviewer" && m.seq > coderLastSeq);
    console.log(`[e2e:verify] reviewer review messages (after coder): ${reviewerMsgs.length}`);
    for (const m of reviewerMsgs) {
      console.log(`  [reviewer] (seq ${m.seq}): ${m.content}`);
    }
  });

  it("primes.py produces correct output", async () => {
    if (!hasCredentials) return;

    const primesPath = join(vaultsDir, "primes-project", "primes.py");
    if (!existsSync(primesPath)) {
      console.warn("[e2e] primes.py not found — skipping");
      return;
    }

    const { execSync } = await import("node:child_process");
    let output: string;
    try {
      output = execSync(`python3 ${primesPath}`, { encoding: "utf-8", timeout: 10_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to execute primes.py: ${msg}`);
    }

    console.log("[e2e:verify] primes.py output:\n" + output);
    // The LLM may format test output differently, but the function must work.
    // If is_prime is correct, the script should exit with code 0 (no assertion error).
    // Check basic correctness from output.
    expect(output.length).toBeGreaterThan(0);
  });

  it("full conversation shows 3-agent reaction chain", async () => {
    if (!hasCredentials) return;

    const channels = instance.toolDeps.channelStore.list();
    console.log("\n[e2e:raw] ══════ Full Conversation ══════");

    for (const ch of channels) {
      const messages = instance.toolDeps.channelMessages.list({ channelId: ch.channelId });
      console.log(`\n[e2e:raw] Channel: #${ch.channelId}`);
      console.log(`[e2e:raw] Topic: ${ch.topic}`);
      console.log(`[e2e:raw] Members: ${JSON.stringify(ch.members)}`);
      console.log(`[e2e:raw] Messages: ${messages.length}`);
      console.log("[e2e:raw] ──────────────────────────────────");

      for (const msg of messages) {
        console.log(
          `[e2e:raw] [${msg.agentId}] (seq ${msg.seq}, ` +
          `${new Date(msg.timestamp).toISOString()}):`,
        );
        console.log(`[e2e:raw]   ${msg.content}`);
        console.log("[e2e:raw] ──────────────────────────────────");
      }
    }
    console.log("[e2e:raw] ══════════════════════════════════\n");

    // Verify the reaction chain: orchestrator → coder → reviewer
    const primesMessages = instance.toolDeps.channelMessages.list({ channelId: "primes" });
    expect(primesMessages.length).toBeGreaterThanOrEqual(3);

    const participants = [...new Set(primesMessages.map((m) => m.agentId))];
    console.log(`[e2e:verify] participants: ${JSON.stringify(participants)}`);

    // All 3 agents must have posted to the channel
    expect(participants).toContain("orchestrator");
    expect(participants).toContain("coder");
    expect(participants).toContain("reviewer");

    // Verify the reaction chain exists:
    // There must be a reviewer message with higher seq than a coder message,
    // proving the scheduler ticked reviewer AFTER coder posted.
    const coderSeqs = primesMessages.filter((m) => m.agentId === "coder").map((m) => m.seq);
    const reviewerSeqs = primesMessages.filter((m) => m.agentId === "reviewer").map((m) => m.seq);
    const maxCoderSeq = Math.max(...coderSeqs);
    const maxReviewerSeq = Math.max(...reviewerSeqs);
    console.log(`[e2e:verify] max seqs — coder: ${maxCoderSeq}, reviewer: ${maxReviewerSeq}`);

    // Reviewer's last message must come after coder's last message (reaction chain)
    expect(maxReviewerSeq).toBeGreaterThan(maxCoderSeq);
  });
});
