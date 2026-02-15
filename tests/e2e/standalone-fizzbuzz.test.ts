/**
 * Standalone E2E: Multi-agent FizzBuzz collaboration
 *
 * Tests the FULL standalone pipeline with real LLM calls:
 *   1. Boot Flock standalone (no OpenClaw)
 *   2. Planner agent creates a channel and posts the FizzBuzz task
 *   3. Coder agent reads the channel and writes FizzBuzz to workspace
 *   4. Verify: channel messages exist, workspace file contains correct FizzBuzz
 *
 * NO mocks, NO fallbacks — real LLM calls via pi-ai.
 * Requires valid credentials in ~/.flock/auth.json.
 *
 * Run: npx vitest run tests/e2e/standalone-fizzbuzz.test.ts
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFlock, type FlockInstance } from "../../src/standalone.js";
import { resolveFlockConfig } from "../../src/config.js";
import { createApiKeyResolver } from "../../src/auth/resolver.js";
import { createFlockTools } from "../../src/tools/index.js";
import { createWorkspaceTools } from "../../src/tools/workspace.js";
import { createTriageDecisionTool } from "../../src/sysadmin/triage-tool.js";
import type { AgentSessionConfig } from "../../src/session/manager.js";

const MODEL = "anthropic/claude-sonnet-4-20250514";
const getApiKey = createApiKeyResolver();

let instance: FlockInstance;
let vaultsDir: string;
let hasCredentials = false;

beforeAll(async () => {
  const key = await getApiKey("anthropic");
  if (!key) {
    console.warn("[e2e] No Anthropic API key — tests will be skipped");
    return;
  }
  hasCredentials = true;

  vaultsDir = mkdtempSync(join(tmpdir(), "flock-e2e-vaults-"));
  mkdirSync(join(vaultsDir, "fizzbuzz-project"), { recursive: true });

  const config = resolveFlockConfig({
    dbBackend: "memory",
    nodeId: "e2e-node",
    vaultsBasePath: vaultsDir,
    gateway: { port: 3899, token: "e2e-token" },
    gatewayAgents: [
      { id: "planner", role: "orchestrator", model: MODEL },
      { id: "coder", role: "worker", model: MODEL },
    ],
  });

  instance = await startFlock({ config, noHttp: true });
}, 30_000);

afterAll(async () => {
  if (instance) await instance.stop();
  if (vaultsDir && existsSync(vaultsDir)) {
    rmSync(vaultsDir, { recursive: true, force: true });
  }
});

function buildAgentConfig(systemPrompt: string): AgentSessionConfig {
  const deps = instance.toolDeps;
  const flockTools = createFlockTools(deps);
  const workspaceTools = deps.vaultsBasePath
    ? createWorkspaceTools({ ...deps, vaultsBasePath: deps.vaultsBasePath })
    : [];
  return {
    model: MODEL,
    systemPrompt,
    tools: [...flockTools, ...workspaceTools, createTriageDecisionTool()],
    getApiKey,
  };
}

describe("standalone fizzbuzz E2E", { timeout: 120_000 }, () => {
  it("planner creates channel and posts the fizzbuzz task", async () => {
    if (!hasCredentials) return;

    const config = buildAgentConfig(
      `You are a planner agent that coordinates multi-agent work using Flock tools.

Do the following NOW using your tools:
1. Call flock_channel_create with channelId "fizzbuzz", topic "Write FizzBuzz in Python", members ["planner","coder"], and a message describing the task.
2. The task: "Write a Python program that prints FizzBuzz for numbers 1-30. Rules: multiples of 3 → Fizz, multiples of 5 → Buzz, both → FizzBuzz, else the number. Save the file as fizzbuzz.py in the fizzbuzz-project workspace using flock_workspace_write."

After the tool call succeeds, say "CHANNEL_CREATED".
Do NOT explain what you would do. Actually call the tool.`,
    );

    const result = await instance.sessionManager.send(
      "planner",
      "Create the fizzbuzz channel now and post the task for the coder.",
      config,
    );

    console.log("[e2e:planner] response:", result.text?.slice(0, 300));
    expect(result.text).toBeDefined();

    // Verify channel exists
    const channelList = createFlockTools(instance.toolDeps).find(t => t.name === "flock_channel_list")!;
    const listResult = await channelList.execute("verify-channels", {});
    console.log("[e2e:verify] channels:", JSON.stringify(listResult.details).slice(0, 500));
    expect(listResult.details.ok).toBe(true);

    const channels = (listResult.details as Record<string, unknown>).channels as Array<{ channelId: string }>;
    expect(channels.some((c) => c.channelId === "fizzbuzz")).toBe(true);
  });

  it("coder reads channel and writes fizzbuzz.py to workspace", async () => {
    if (!hasCredentials) return;

    const config = buildAgentConfig(
      `You are a coder agent. You read tasks from channels and write code to workspaces.

Do the following NOW using your tools:
1. Call flock_channel_read with channelId "fizzbuzz" to read your task.
2. Write a Python FizzBuzz program for 1-30:
   - Multiples of 3: print "Fizz"
   - Multiples of 5: print "Buzz"
   - Multiples of both 3 and 5: print "FizzBuzz"
   - Otherwise: print the number
   One output per line, 30 lines total.
3. Call flock_workspace_write with workspace "fizzbuzz-project", path "fizzbuzz.py", and the Python code as content.
4. After writing, say "CODE_WRITTEN".

Do NOT explain. Actually call the tools.`,
    );

    const result = await instance.sessionManager.send(
      "coder",
      "Read the fizzbuzz channel for your task, write the Python code, and save it to the workspace.",
      config,
    );

    console.log("[e2e:coder] response:", result.text?.slice(0, 300));
    expect(result.text).toBeDefined();

    // Verify file was written
    const fizzbuzzPath = join(vaultsDir, "fizzbuzz-project", "fizzbuzz.py");
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

    // Execute the Python code and verify output
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
});
