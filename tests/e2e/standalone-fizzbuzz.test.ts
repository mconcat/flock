/**
 * Standalone E2E: Multi-agent FizzBuzz collaboration
 *
 * Tests the FULL standalone pipeline with real LLM calls through A2A HTTP:
 *   1. Boot Flock standalone with HTTP server (no OpenClaw)
 *   2. Send ONE A2A message to orchestrator → creates project channel + posts task
 *   3. WorkLoopScheduler auto-ticks coder → reads channel, writes FizzBuzz to workspace
 *   4. Verify: channel exists, workspace file, correct FizzBuzz output
 *
 * Only ONE message is sent externally. Everything else is driven by the
 * WorkLoopScheduler's automatic tick cycle (tickIntervalMs set to 5s for tests).
 *
 * NO mocks, NO fallbacks, NO hardcoded system prompts.
 * System prompts come from production templates (assembleAgentsMd).
 * All tool calls are autonomous — the LLM decides what to invoke.
 *
 * Requires valid credentials in ~/.flock/auth.json.
 *
 * Run: npx vitest run tests/e2e/standalone-fizzbuzz.test.ts
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

/** Max time to wait for coder to complete work via auto-tick. */
const CODER_POLL_TIMEOUT_MS = 120_000;

/** Poll interval when checking for coder's work completion. */
const POLL_INTERVAL_MS = 2_000;

let instance: FlockInstance;
let vaultsDir: string;
let httpPort: number;
let hasCredentials = false;

// ---------------------------------------------------------------------------
// A2A HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Send an A2A JSON-RPC message/send request via HTTP.
 * This exercises the full pipeline: HTTP → A2A routing → executor →
 * direct-send → resolveAgentConfig (production prompts) → SessionManager →
 * pi-ai → LLM → tool calls → response.
 */
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

/** Extract text from an A2A Task result. */
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

/**
 * Poll until a condition is met or timeout.
 * Returns true if condition was met, false on timeout.
 */
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
  return condition(); // Final check
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

  vaultsDir = mkdtempSync(join(tmpdir(), "flock-e2e-vaults-"));
  mkdirSync(join(vaultsDir, "fizzbuzz-project"), { recursive: true });

  // Use a random port to avoid collisions
  httpPort = 3900 + Math.floor(Math.random() * 100);

  const config = resolveFlockConfig({
    dbBackend: "memory",
    nodeId: "e2e-node",
    vaultsBasePath: vaultsDir,
    gateway: { port: httpPort - 1, token: "e2e-token" },
    gatewayAgents: [
      { id: "orchestrator", role: "orchestrator", model: MODEL },
      { id: "coder", role: "worker", model: MODEL, archetype: "code-first-developer" },
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
// Tests
// ---------------------------------------------------------------------------

describe("standalone fizzbuzz E2E", { timeout: 300_000 }, () => {
  it("A2A HTTP endpoint is responsive", async () => {
    if (!hasCredentials) return;

    // Agent card endpoint should respond
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
    expect(agentIds).toContain("orchestrator");
    expect(agentIds).toContain("coder");
  });

  it("orchestrator creates channel and posts the fizzbuzz task (only external message)", async () => {
    if (!hasCredentials) return;

    // This is the ONLY external A2A message sent in the entire test.
    // After this, the WorkLoopScheduler auto-ticks the coder.
    const response = await sendA2A(
      "orchestrator",
      [
        "새 프로젝트를 시작해주세요.",
        "",
        '1. flock_channel_create로 "fizzbuzz" 채널을 만들어주세요:',
        '   - topic: "Write a Python FizzBuzz program for numbers 1-30"',
        '   - members: ["coder"]',
        "",
        "2. 채널 생성 후, flock_channel_post로 다음 작업 내용을 채널에 올려주세요:",
        "   Python으로 FizzBuzz 프로그램을 작성하세요.",
        "   1부터 30까지 숫자를 출력하되:",
        "   - 3의 배수: Fizz",
        "   - 5의 배수: Buzz",
        "   - 3과 5의 공배수: FizzBuzz",
        "   - 그 외: 숫자",
        "   한 줄에 하나씩, 총 30줄.",
        '   flock_workspace_write로 "fizzbuzz-project" 워크스페이스에 fizzbuzz.py로 저장하세요.',
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

    // Verify channel was created via DB
    const channels = instance.toolDeps.channelStore.list();
    console.log("[e2e:verify] channels:", JSON.stringify(channels.map((c) => ({
      channelId: c.channelId,
      topic: c.topic,
      createdBy: c.createdBy,
      members: c.members,
    }))));
    expect(channels.some((c) => c.channelId === "fizzbuzz")).toBe(true);

    const fizzChannel = channels.find((c) => c.channelId === "fizzbuzz")!;
    expect(fizzChannel.createdBy).toBe("orchestrator");
    expect(fizzChannel.members).toContain("coder");

    // Dump raw channel messages
    const messages = instance.toolDeps.channelMessages.list({ channelId: "fizzbuzz" });
    console.log(`[e2e:verify] channel messages after orchestrator: ${messages.length}`);
    for (const msg of messages) {
      console.log(`  [${msg.agentId}] (seq ${msg.seq}): ${msg.content}`);
    }

    // Orchestrator should have posted at least one message to the channel
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].agentId).toBe("orchestrator");
  });

  it("coder auto-ticked by WorkLoopScheduler writes fizzbuzz.py to workspace", async () => {
    if (!hasCredentials) return;

    // NO manual message to coder. The WorkLoopScheduler (running at 5s intervals)
    // will detect that coder is AWAKE, build a tick message with new channel
    // activity from #fizzbuzz, and send it via A2A automatically.
    //
    // We just poll until the coder has written the file.

    const fizzbuzzPath = join(vaultsDir, "fizzbuzz-project", "fizzbuzz.py");

    console.log("[e2e:coder] Waiting for WorkLoopScheduler to auto-tick coder...");
    console.log(`[e2e:coder] Tick interval: ${TEST_TICK_INTERVAL_MS / 1000}s, poll timeout: ${CODER_POLL_TIMEOUT_MS / 1000}s`);

    const fileWritten = await pollUntil(
      () => existsSync(fizzbuzzPath),
      CODER_POLL_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );

    if (!fileWritten) {
      // Dump diagnostic info before failing
      const channels = instance.toolDeps.channelStore.list();
      const messages = instance.toolDeps.channelMessages.list({ channelId: "fizzbuzz" });
      console.error("[e2e:coder] TIMEOUT — fizzbuzz.py was not written");
      console.error("[e2e:coder] Channels:", JSON.stringify(channels.map((c) => c.channelId)));
      console.error("[e2e:coder] Messages:", messages.length);
      for (const msg of messages) {
        console.error(`  [${msg.agentId}] (seq ${msg.seq}): ${msg.content}`);
      }
    }

    expect(fileWritten).toBe(true);

    const code = readFileSync(fizzbuzzPath, "utf-8");
    console.log("[e2e:verify] fizzbuzz.py (written by auto-ticked coder):\n" + code);

    expect(code).toContain("Fizz");
    expect(code).toContain("Buzz");
    expect(code).toContain("FizzBuzz");
    expect(code.length).toBeGreaterThan(50);

    // Wait for coder to post completion message to the channel.
    // The coder might write the file first and then post — poll for the post.
    console.log("[e2e:coder] Waiting for coder to post to channel...");
    const coderPosted = await pollUntil(
      () => instance.toolDeps.channelMessages
        .list({ channelId: "fizzbuzz" })
        .some((m) => m.agentId === "coder"),
      60_000,
      POLL_INTERVAL_MS,
    );

    const messages = instance.toolDeps.channelMessages.list({ channelId: "fizzbuzz" });
    const coderMessages = messages.filter((m) => m.agentId === "coder");
    console.log(`[e2e:verify] coder channel messages: ${coderMessages.length}`);
    if (!coderPosted) {
      console.warn("[e2e:coder] Coder wrote fizzbuzz.py but did not post to channel (may still be processing)");
    }
    expect(coderMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("fizzbuzz.py produces correct output", async () => {
    if (!hasCredentials) return;

    const fizzbuzzPath = join(vaultsDir, "fizzbuzz-project", "fizzbuzz.py");
    if (!existsSync(fizzbuzzPath)) {
      console.warn("[e2e] fizzbuzz.py not found — skipping output verification");
      return;
    }

    const { execSync } = await import("node:child_process");
    let output: string;
    try {
      output = execSync(`python3 ${fizzbuzzPath}`, { encoding: "utf-8", timeout: 10_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to execute fizzbuzz.py: ${msg}`);
    }

    console.log("[e2e:verify] fizzbuzz output:\n" + output);

    const lines = output.trim().split("\n");
    expect(lines.length).toBe(30);

    // Verify specific values
    expect(lines[0]).toBe("1");
    expect(lines[1]).toBe("2");
    expect(lines[2]).toBe("Fizz");      // 3
    expect(lines[3]).toBe("4");
    expect(lines[4]).toBe("Buzz");      // 5
    expect(lines[5]).toBe("Fizz");      // 6
    expect(lines[9]).toBe("Buzz");      // 10
    expect(lines[14]).toBe("FizzBuzz"); // 15
    expect(lines[29]).toBe("FizzBuzz"); // 30
  });

  it("raw channel messages show full conversation", async () => {
    if (!hasCredentials) return;

    // Dump ALL raw messages across all channels for inspection
    const channels = instance.toolDeps.channelStore.list();
    console.log("\n[e2e:raw] ══════ Raw Channel Messages ══════");

    let totalMessages = 0;

    for (const ch of channels) {
      const messages = instance.toolDeps.channelMessages.list({ channelId: ch.channelId });
      totalMessages += messages.length;

      console.log(`\n[e2e:raw] Channel: #${ch.channelId}`);
      console.log(`[e2e:raw] Topic: ${ch.topic}`);
      console.log(`[e2e:raw] Created by: ${ch.createdBy}`);
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

    console.log(`\n[e2e:raw] Total: ${totalMessages} messages across ${channels.length} channel(s)`);
    console.log("[e2e:raw] ══════════════════════════════════\n");

    // The fizzbuzz channel must exist with messages from both agents
    expect(channels.some((c) => c.channelId === "fizzbuzz")).toBe(true);

    const fizzMessages = instance.toolDeps.channelMessages.list({ channelId: "fizzbuzz" });
    expect(fizzMessages.length).toBeGreaterThanOrEqual(2); // orchestrator task + coder report

    const participants = [...new Set(fizzMessages.map((m) => m.agentId))];
    console.log(`[e2e:verify] participants: ${JSON.stringify(participants)}`);
    expect(participants).toContain("orchestrator");
    expect(participants).toContain("coder");
  });
});
