/**
 * Standalone E2E: Full review cycle with PM-driven coordination
 *
 * Tests the complete agent collaboration lifecycle:
 *   Setup: Human → Orchestrator (reactive, creates channel + assembles team)
 *   Phase 1: PM coordinates build + review
 *     - PM reads kickoff, directs coder → coder writes stack.py → reviewer reviews via workspace_read
 *   Phase 2: PM coordinates iteration
 *     - Human sends follow-up to orchestrator → orchestrator posts to channel
 *     - PM reads follow-up, directs coder to update → reviewer re-reviews
 *
 * Validates:
 *   - Orchestrator is reactive (creates infrastructure, doesn't manage project)
 *   - PM drives project coordination (worker with project-manager archetype)
 *   - workspace_read: reviewer reads coder's files cross-agent
 *   - Session context across ticks: agents remember previous conversation
 *   - Multi-round reaction chain: orchestrator→PM→coder→reviewer
 *
 * Requires valid credentials in ~/.flock/auth.json.
 *
 * Run: npx vitest run tests/e2e/standalone-review-cycle.test.ts
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

const TEST_TICK_INTERVAL_MS = 5_000;
const POLL_INTERVAL_MS = 2_000;
const PHASE_TIMEOUT_MS = 120_000;

let instance: FlockInstance;
let vaultsDir: string;
let httpPort: number;
let hasCredentials = false;

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * Send A2A with retry — orchestrator may be busy processing a tick or
 * previous request. Retries until the agent responds without "already processing".
 */
async function sendA2AWithRetry(
  agentId: string,
  text: string,
  retryTimeoutMs = 60_000,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let response: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null };
  const deadline = Date.now() + retryTimeoutMs;
  while (Date.now() < deadline) {
    response = await sendA2A(agentId, text, 120_000);
    const text_ = getResponseText(response.body);
    if (response.status === 200 && text_ && !text_.includes("already processing")) {
      return response;
    }
    console.log(`[e2e] ${agentId} busy, retrying in 3s...`);
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return response;
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

  vaultsDir = mkdtempSync(join(tmpdir(), "flock-e2e-review-"));
  mkdirSync(join(vaultsDir, "stack-project"), { recursive: true });

  httpPort = 3900 + Math.floor(Math.random() * 100);

  const config = resolveFlockConfig({
    dbBackend: "memory",
    nodeId: "e2e-node",
    vaultsBasePath: vaultsDir,
    gateway: { port: httpPort - 1, token: "e2e-token" },
    gatewayAgents: [
      // Orchestrator: reactive, only creates channels/assembles teams on human request
      { id: "orchestrator", role: "orchestrator", model: MODEL },
      // PM: worker with project-manager archetype, drives project coordination
      { id: "pm", role: "worker", model: MODEL, archetype: "project-manager" },
      // Coder: writes the code
      { id: "coder", role: "worker", model: MODEL, archetype: "code-first-developer" },
      // Reviewer: reviews code via workspace_read
      { id: "reviewer", role: "worker", model: MODEL, archetype: "code-reviewer" },
    ],
  });

  instance = await startFlock({
    config,
    httpPort,
    tickIntervalMs: TEST_TICK_INTERVAL_MS,
    slowTickIntervalMs: 15_000,
  });
}, 30_000);

afterAll(async () => {
  if (instance) await instance.stop();
  if (vaultsDir && existsSync(vaultsDir)) {
    rmSync(vaultsDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests — sequential phases
// ---------------------------------------------------------------------------

describe("review cycle E2E", { timeout: 600_000 }, () => {
  let phase1MessageCount = 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1: Orchestrator sets up, PM drives build + review
  // ═══════════════════════════════════════════════════════════════════════════

  it("phase 1: human tells orchestrator to start a project", async () => {
    if (!hasCredentials) return;

    // The human (external message) tells orchestrator to create a channel and assemble a team.
    // Orchestrator is reactive — this is the only way to activate it.
    const response = await sendA2A(
      "orchestrator",
      [
        "새 프로젝트를 시작해주세요.",
        "",
        '1. flock_channel_create로 "stack" 채널을 만들어주세요:',
        '   - topic: "Implement a Python Stack class"',
        '   - members: ["pm", "coder", "reviewer"]',
        "",
        "2. flock_channel_post로 다음 킥오프 메시지를 올려주세요:",
        "   Python으로 Stack 클래스를 구현하세요.",
        "   요구사항:",
        "   - push(item): 스택에 아이템 추가",
        "   - pop(): 스택에서 아이템 제거 및 반환 (빈 스택이면 IndexError)",
        "   - peek(): 스택 맨 위 아이템 반환 (빈 스택이면 IndexError)",
        "   - is_empty(): 스택이 비었으면 True",
        "   - size(): 스택 크기 반환",
        '   flock_workspace_write로 "stack-project" 워크스페이스에 stack.py로 저장하세요.',
        "   파일 끝에 테스트 코드를 포함하세요:",
        "   s = Stack()",
        '   assert s.is_empty() == True',
        "   s.push(1); s.push(2); s.push(3)",
        '   assert s.size() == 3',
        '   assert s.peek() == 3',
        '   assert s.pop() == 3',
        '   assert s.pop() == 2',
        '   assert s.size() == 1',
        '   print("Phase 1 tests passed")',
        "",
        "   이 킥오프 메시지 이후, PM이 프로젝트를 관리할 것입니다.",
        "   orchestrator로서 당신은 이 메시지 이후 채널에 관여하지 않습니다.",
        "",
        "도구를 직접 호출해주세요.",
      ].join("\n"),
      120_000,
    );

    expect(response.status).toBe(200);
    const text = getResponseText(response.body);
    console.log("[e2e:phase1] orchestrator response:", text?.slice(0, 300));

    // Verify channel created with correct members
    const channels = instance.toolDeps.channelStore.list();
    expect(channels.some((c) => c.channelId === "stack")).toBe(true);

    const stackChannel = channels.find((c) => c.channelId === "stack")!;
    expect(stackChannel.members).toContain("pm");
    expect(stackChannel.members).toContain("coder");
    expect(stackChannel.members).toContain("reviewer");
  });

  it("phase 1: coder writes stack.py (PM-coordinated)", async () => {
    if (!hasCredentials) return;

    const stackPath = join(vaultsDir, "stack-project", "stack.py");

    console.log("[e2e:phase1] Waiting for coder to write stack.py...");
    const fileWritten = await pollUntil(
      () => existsSync(stackPath),
      PHASE_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );
    expect(fileWritten).toBe(true);

    const code = readFileSync(stackPath, "utf-8");
    console.log("[e2e:phase1] stack.py:\n" + code);

    expect(code).toContain("class Stack");
    expect(code).toContain("push");
    expect(code).toContain("pop");
    expect(code).toContain("peek");

    // Wait for coder to post completion
    console.log("[e2e:phase1] Waiting for coder channel post...");
    const coderPosted = await pollUntil(
      () => instance.toolDeps.channelMessages
        .list({ channelId: "stack" })
        .some((m) => m.agentId === "coder"),
      60_000,
      POLL_INTERVAL_MS,
    );
    expect(coderPosted).toBe(true);
  });

  it("phase 1: reviewer reads stack.py via workspace_read and posts review", async () => {
    if (!hasCredentials) return;

    const coderMessages = instance.toolDeps.channelMessages
      .list({ channelId: "stack" })
      .filter((m) => m.agentId === "coder");
    const coderLastSeq = Math.max(...coderMessages.map((m) => m.seq));

    console.log("[e2e:phase1] Waiting for reviewer to review (after coder seq", coderLastSeq, ")...");

    const reviewerReacted = await pollUntil(
      () => instance.toolDeps.channelMessages
        .list({ channelId: "stack" })
        .some((m) => m.agentId === "reviewer" && m.seq > coderLastSeq),
      PHASE_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );
    expect(reviewerReacted).toBe(true);

    const reviewerMsgs = instance.toolDeps.channelMessages
      .list({ channelId: "stack" })
      .filter((m) => m.agentId === "reviewer" && m.seq > coderLastSeq);
    console.log(`[e2e:phase1] reviewer review: ${reviewerMsgs[0].content.slice(0, 300)}`);

    // stack.py should be executable
    const stackPath = join(vaultsDir, "stack-project", "stack.py");
    const { execSync } = await import("node:child_process");
    const output = execSync(`python3 ${stackPath}`, { encoding: "utf-8", timeout: 10_000 });
    console.log("[e2e:phase1] stack.py output:", output.trim());
    expect(output).toContain("passed");

    phase1MessageCount = instance.toolDeps.channelMessages
      .list({ channelId: "stack" }).length;
    console.log(`[e2e:phase1] total messages after phase 1: ${phase1MessageCount}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 2: Follow-up (session context + iteration)
  // ═══════════════════════════════════════════════════════════════════════════

  it("phase 2: human tells orchestrator to post follow-up requirement", async () => {
    if (!hasCredentials) return;

    // Human sends follow-up to orchestrator. Orchestrator posts to channel, then steps back.
    const response = await sendA2AWithRetry(
      "orchestrator",
      [
        '기존 #stack 채널에 flock_channel_post(channelId="stack", message="...")로 다음 내용을 올려주세요.',
        "새 채널을 만들지 마세요. 기존 stack 채널을 사용하세요.",
        "",
        "추가 요구사항: Stack 클래스에 min_value() 메서드를 추가하세요.",
        "- min_value(): O(1)으로 스택의 최소값 반환 (빈 스택이면 IndexError)",
        "- 힌트: 보조 스택(_min_stack)을 사용하세요",
        "- push/pop 시 보조 스택도 함께 업데이트",
        '- 기존 stack-project/stack.py 파일을 업데이트하세요 (flock_workspace_write, workspaceId="stack-project", path="stack.py")',
        "",
        "테스트 코드도 추가해주세요:",
        "s = Stack()",
        "s.push(3); s.push(1); s.push(2)",
        'assert s.min_value() == 1',
        "s.pop()",
        'assert s.min_value() == 1',
        "s.pop()",
        'assert s.min_value() == 3',
        'print("Phase 2 tests passed")',
        "",
        "이 메시지를 올린 후 PM이 팀을 조율할 것입니다.",
        "도구를 직접 호출해주세요.",
      ].join("\n"),
    );

    expect(response.status).toBe(200);
    const text = getResponseText(response.body);
    console.log("[e2e:phase2] orchestrator response:", text?.slice(0, 300));

    // Verify orchestrator posted to channel
    const newMessages = instance.toolDeps.channelMessages
      .list({ channelId: "stack" })
      .filter((m) => m.seq > phase1MessageCount);
    console.log(`[e2e:phase2] new messages after orchestrator: ${newMessages.length}`);
    expect(newMessages.some((m) => m.agentId === "orchestrator")).toBe(true);
  });

  it("phase 2: coder updates stack.py with min_value (session context)", async () => {
    if (!hasCredentials) return;

    const stackPath = join(vaultsDir, "stack-project", "stack.py");

    console.log("[e2e:phase2] Waiting for coder to update stack.py with min_value...");

    const fileUpdated = await pollUntil(
      () => {
        if (!existsSync(stackPath)) return false;
        const code = readFileSync(stackPath, "utf-8");
        return code.includes("min_value") || code.includes("min_stack") || code.includes("_min");
      },
      PHASE_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );

    expect(fileUpdated).toBe(true);

    const updatedCode = readFileSync(stackPath, "utf-8");
    console.log("[e2e:phase2] updated stack.py:\n" + updatedCode);

    expect(updatedCode).toContain("class Stack");
    expect(updatedCode).toContain("push");
    expect(updatedCode).toContain("pop");

    // Wait for coder to post about the update
    console.log("[e2e:phase2] Waiting for coder to post update to channel...");
    const coderPostedUpdate = await pollUntil(
      () => {
        const msgs = instance.toolDeps.channelMessages
          .list({ channelId: "stack" })
          .filter((m) => m.agentId === "coder" && m.seq > phase1MessageCount);
        return msgs.length > 0;
      },
      60_000,
      POLL_INTERVAL_MS,
    );
    expect(coderPostedUpdate).toBe(true);
  });

  it("phase 2: reviewer posts second review after coder's update", async () => {
    if (!hasCredentials) return;

    const coderUpdateMsgs = instance.toolDeps.channelMessages
      .list({ channelId: "stack" })
      .filter((m) => m.agentId === "coder" && m.seq > phase1MessageCount);
    const coderUpdateSeq = Math.max(...coderUpdateMsgs.map((m) => m.seq));

    console.log("[e2e:phase2] Waiting for reviewer's second review (after coder seq", coderUpdateSeq, ")...");

    const reviewerReacted = await pollUntil(
      () => instance.toolDeps.channelMessages
        .list({ channelId: "stack" })
        .some((m) => m.agentId === "reviewer" && m.seq > coderUpdateSeq),
      PHASE_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );
    expect(reviewerReacted).toBe(true);

    const reviewerMsgs = instance.toolDeps.channelMessages
      .list({ channelId: "stack" })
      .filter((m) => m.agentId === "reviewer" && m.seq > coderUpdateSeq);
    console.log(`[e2e:phase2] reviewer second review: ${reviewerMsgs[0].content.slice(0, 300)}`);
  });

  it("phase 2: updated stack.py executes correctly", async () => {
    if (!hasCredentials) return;

    const stackPath = join(vaultsDir, "stack-project", "stack.py");
    if (!existsSync(stackPath)) {
      console.warn("[e2e] stack.py not found — skipping");
      return;
    }

    const { execSync } = await import("node:child_process");
    let output: string;
    try {
      output = execSync(`python3 ${stackPath}`, { encoding: "utf-8", timeout: 10_000 });
    } catch (err) {
      const code = readFileSync(stackPath, "utf-8");
      console.error("[e2e:phase2] stack.py that failed:\n" + code);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to execute stack.py: ${msg}`);
    }

    console.log("[e2e:phase2] stack.py output:\n" + output);
    expect(output.toLowerCase()).toContain("passed");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Verification
  // ═══════════════════════════════════════════════════════════════════════════

  it("full conversation shows PM-driven multi-round collaboration", async () => {
    if (!hasCredentials) return;

    const messages = instance.toolDeps.channelMessages.list({ channelId: "stack" });

    console.log("\n[e2e:raw] ══════ Full #stack Conversation ══════");
    console.log(`[e2e:raw] Total messages: ${messages.length}`);
    for (const msg of messages) {
      console.log(`[e2e:raw] [${msg.agentId}] (seq ${msg.seq}):`);
      console.log(`[e2e:raw]   ${msg.content.slice(0, 200)}`);
      console.log("[e2e:raw] ──────────────────────────────────");
    }
    console.log("[e2e:raw] ══════════════════════════════════\n");

    // All 4 agents should have participated
    const participants = [...new Set(messages.map((m) => m.agentId))];
    expect(participants).toContain("orchestrator");
    expect(participants).toContain("coder");
    expect(participants).toContain("reviewer");

    // Orchestrator should have posted sparingly (kickoff + follow-up only)
    const orchestratorCount = messages.filter((m) => m.agentId === "orchestrator").length;
    console.log(`[e2e:verify] orchestrator messages: ${orchestratorCount} (should be minimal, ~2)`);

    // PM should have participated in coordination (if present in conversation)
    const pmCount = messages.filter((m) => m.agentId === "pm").length;
    console.log(`[e2e:verify] pm messages: ${pmCount}`);

    // Coder and reviewer should have posted multiple times
    const coderCount = messages.filter((m) => m.agentId === "coder").length;
    const reviewerCount = messages.filter((m) => m.agentId === "reviewer").length;
    console.log(`[e2e:verify] coder: ${coderCount}, reviewer: ${reviewerCount}`);

    expect(coderCount).toBeGreaterThanOrEqual(2);
    expect(reviewerCount).toBeGreaterThanOrEqual(2);

    // Total messages should be substantial
    expect(messages.length).toBeGreaterThanOrEqual(6);
  });
});
