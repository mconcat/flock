/**
 * Standalone E2E: Multi-agent FizzBuzz collaboration
 *
 * Tests the FULL standalone pipeline with real LLM calls through A2A HTTP:
 *   1. Boot Flock standalone with HTTP server (no OpenClaw)
 *   2. Send A2A message to orchestrator → creates project channel + posts task
 *   3. Send A2A tick to coder → reads channel, writes FizzBuzz to workspace
 *   4. Verify: channel exists, workspace file, correct FizzBuzz output
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
      { id: "orchestrator", role: "orchestrator", model: MODEL, archetype: "project-manager" },
      { id: "coder", role: "worker", model: MODEL, archetype: "code-first-developer" },
    ],
  });

  instance = await startFlock({ config, httpPort });
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

  it("orchestrator creates channel and posts the fizzbuzz task", async () => {
    if (!hasCredentials) return;

    // Send A2A message to orchestrator — production system prompt is used
    // automatically by resolveAgentConfig → assembleAgentsMd("orchestrator").
    // The orchestrator decides autonomously which tools to call.
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
    console.log("[e2e:orchestrator] response:", text?.slice(0, 500));

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
      console.log(`  [${msg.agentId}] (seq ${msg.seq}): ${msg.content.slice(0, 300)}`);
    }

    // Orchestrator should have posted at least one message to the channel
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].agentId).toBe("orchestrator");
  });

  it("coder reads channel and writes fizzbuzz.py to workspace", async () => {
    if (!hasCredentials) return;

    // Build a tick message that mirrors what WorkLoopScheduler.buildTickMessage()
    // would produce. Includes any channel messages that exist, plus the channel
    // topic as context.
    //
    // NOTE: WorkLoopScheduler is not yet wired into standalone.ts.
    // This tick is manually sent via A2A HTTP — same transport the
    // scheduler uses internally via a2aClient.sendA2A.
    const channelMessages = instance.toolDeps.channelMessages.list({ channelId: "fizzbuzz" });
    const fizzChannel = instance.toolDeps.channelStore.get("fizzbuzz");
    const topic = fizzChannel?.topic ?? "FizzBuzz project";

    const tickLines: string[] = [
      "[Work Loop Tick]",
      "State: AWAKE (0m)",
      "",
    ];

    if (channelMessages.length > 0) {
      tickLines.push("--- New Channel Activity ---");
      tickLines.push(`#fizzbuzz — ${topic} (${channelMessages.length} new):`);
      for (const msg of channelMessages) {
        tickLines.push(`  [${msg.agentId}]: ${msg.content.slice(0, 300)}`);
      }
      tickLines.push("--- End Channel Activity ---");
    } else {
      // No messages posted yet — include the channel topic as context.
      // In production, the scheduler would show "No new channel activity"
      // but the agent can still read channels using flock_channel_read.
      tickLines.push("--- New Channels ---");
      tickLines.push(`#fizzbuzz — ${topic} (you are a member)`);
      tickLines.push("--- End New Channels ---");
    }

    tickLines.push("");
    tickLines.push(
      "Continue your work. Read the #fizzbuzz channel using flock_channel_read " +
      "for your task details, then complete the work.",
    );

    const response = await sendA2A("coder", tickLines.join("\n"), 120_000);

    console.log("[e2e:coder] HTTP status:", response.status);
    const text = getResponseText(response.body);
    console.log("[e2e:coder] response:", text?.slice(0, 500));

    expect(response.status).toBe(200);
    expect(text).toBeDefined();

    // Verify file was written to workspace
    const fizzbuzzPath = join(vaultsDir, "fizzbuzz-project", "fizzbuzz.py");
    console.log("[e2e:verify] checking workspace path:", fizzbuzzPath);
    expect(existsSync(fizzbuzzPath)).toBe(true);

    const code = readFileSync(fizzbuzzPath, "utf-8");
    console.log("[e2e:verify] fizzbuzz.py:\n" + code);

    expect(code).toContain("Fizz");
    expect(code).toContain("Buzz");
    expect(code).toContain("FizzBuzz");
    expect(code.length).toBeGreaterThan(50);
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
