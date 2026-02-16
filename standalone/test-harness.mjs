#!/usr/bin/env node
/**
 * Flock Standalone CLI — Full Workflow E2E Test
 *
 * Tests the COMPLETE user-facing lifecycle including multi-agent collaboration:
 *
 * Phase 1: flock init   — Clone OpenClaw, build, generate config
 * Phase 2: Patch config — Gateway network settings, E2E sandbox paths, preserve nix binds
 * Phase 3: flock add    — Add architect + coder (sysadmin created by init)
 * Phase 4: flock start  — Start the gateway in background
 * Phase 5: Verify       — Plugin loaded, agents registered, nix-daemon running
 * Phase 6: Workflow      — Rust FizzBuzz via Nix (the real test)
 *   6a: Send project request via chat completions (user path)
 *   6b: Verify channel created in DB (sysadmin + architect + coder)
 *   6c: Verify channel members
 *   6d: Wait for agent activity — sysadmin installs rustc, coder compiles + runs
 *   6e: Dump all channel messages
 *   6f: Verify Rust source file
 *   6g: Verify output file content matches FizzBuzz
 *   6h: Verify rustc was installed in coder's nix profile
 *   6i: Verify sandbox containers were created
 * Phase 7: CLI          — flock list, flock status
 * Phase 8: flock stop   — Stop gateway + nix-daemon
 *
 * Requires: SETUP_TOKEN (Claude Code subscription token) or pre-existing auth-profiles.json.
 * Exits 0 on success, 1 on failure.
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

// ============================================================
// Configuration
// ============================================================

const HOME = process.env.HOME || "/root";
const FLOCK_HOME = path.join(HOME, ".flock");
const CONFIG_PATH = path.join(FLOCK_HOME, "config.json");
const PID_FILE = path.join(FLOCK_HOME, "gateway.pid");
const AUTH_PROFILE_PATH = path.join(FLOCK_HOME, "agents", "main", "agent", "auth-profiles.json");
const DB_PATH = path.join(FLOCK_HOME, "data", "flock.db");

const GATEWAY_PORT = 3779;
const GATEWAY_TOKEN = "test-token-standalone";
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

const MAX_STARTUP_WAIT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 300_000; // 5 min for LLM calls
const POLL_INTERVAL_MS = 2000;

// Workflow constants
const CHANNEL_NAME = "fizzbuzz-project";
// Shared bind mount — identical path on host and inside E2E container so that
// sandbox containers (sibling containers on host daemon) see the same files.
const SHARED_DIR = "/tmp/flock-e2e/shared";
// Inside sandbox containers, /shared is bind-mounted from SHARED_DIR.
// IMPORTANT: Must NOT be under /tmp — sandbox containers use tmpfs at /tmp
// which shadows any bind mounts to subdirectories of /tmp.
const SANDBOX_SHARED = "/shared";
// Rust source file and compiled output — agents write source, compile, run, save output
const SOURCE_PATH = `${SHARED_DIR}/fizzbuzz.rs`;
const SANDBOX_SOURCE_PATH = `${SANDBOX_SHARED}/fizzbuzz.rs`;
const OUTPUT_PATH = `${SHARED_DIR}/fizzbuzz_output.txt`;
const SANDBOX_OUTPUT_PATH = `${SANDBOX_SHARED}/fizzbuzz_output.txt`;
const CHANNEL_POLL_TIMEOUT_MS = 120_000;  // 2 min to create channel
const WORKFLOW_TIMEOUT_MS = 900_000;       // 15 min (extra time for nix package download)

let gatewayProcess = null;
let passed = 0;
let failed = 0;

// ============================================================
// Utilities
// ============================================================

function log(msg) {
  console.log(`[standalone-e2e] ${msg}`);
}

function verbose(msg) {
  if (process.env.E2E_VERBOSE) {
    console.log(`[verbose] ${msg}`);
  }
}

function assert(condition, name, details = "") {
  if (condition) {
    passed++;
    log(`  ✅ ${name}`);
    if (details && process.env.E2E_VERBOSE) verbose(`     ${details}`);
  } else {
    failed++;
    log(`  ❌ ${name}`);
    if (details) log(`     ${details}`);
  }
  return condition;
}

/**
 * Clean up sandbox containers and Nix daemon from previous (or current) runs.
 * Sandbox containers are sibling containers on the HOST Docker daemon — they
 * survive `docker compose down` and must be explicitly removed.
 */
function cleanupSandboxContainers() {
  // Remove all OpenClaw sandbox containers
  const ps = execCapture(
    'docker ps -a --filter label=openclaw.sandbox=1 --format "{{.Names}}"'
  );
  if (ps.ok && ps.output.trim()) {
    const containers = ps.output.trim().split("\n").filter(Boolean);
    if (containers.length > 0) {
      log(`  Removing ${containers.length} sandbox container(s)...`);
      execCapture(`docker rm -f ${containers.join(" ")}`);
    }
  }
  // Remove Nix daemon if running
  execCapture("docker rm -f flock-nix-daemon");
}

function execCapture(cmd, opts = {}) {
  try {
    return {
      ok: true,
      output: execSync(cmd, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 300_000,
        ...opts,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      output: (err.stderr || "") + (err.stdout || "") + (err.message || ""),
    };
  }
}

async function httpGet(urlPath) {
  return new Promise((resolve) => {
    const req = http.get(`${GATEWAY_URL}${urlPath}`, {
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on("error", () => resolve({ status: 0, body: null }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, body: null }); });
  });
}

async function httpPost(urlPath, data, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(data);
    const req = http.request(
      `${GATEWAY_URL}${urlPath}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${GATEWAY_TOKEN}`,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, body });
          }
        });
      },
    );
    req.on("error", (err) => {
      verbose(`HTTP error for ${urlPath}: ${err.message}`);
      resolve({ status: 0, body: null });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      verbose(`HTTP timeout for ${urlPath}`);
      resolve({ status: 0, body: null });
    });
    req.write(payload);
    req.end();
  });
}

function hasAuth() {
  // Auth can come from:
  // 1. auth-profiles.json file (created by OpenClaw onboarding or setupAuthProfiles())
  // 2. SETUP_TOKEN env var (will be written to auth-profiles.json after init)
  if (fs.existsSync(AUTH_PROFILE_PATH)) return "auth-profiles.json";
  if (process.env.SETUP_TOKEN) return "env:SETUP_TOKEN (will write auth-profiles.json after init)";
  return null;
}

/**
 * Create auth-profiles.json from SETUP_TOKEN.
 *
 * Setup tokens (sk-ant-oat01-*) are Claude Code subscription tokens.
 * They must be stored as type:"token" in auth-profiles.json so OpenClaw
 * routes them through the subscription auth flow, not regular API billing.
 *
 * Path: ~/.flock/agents/main/agent/auth-profiles.json
 * (resolveStateDir → OPENCLAW_STATE_DIR → ~/.flock/)
 */
function setupAuthProfiles() {
  if (fs.existsSync(AUTH_PROFILE_PATH)) {
    log("  auth-profiles.json already exists — skipping");
    return;
  }

  const token = process.env.SETUP_TOKEN?.trim();
  if (!token) {
    log("  No SETUP_TOKEN — skipping auth-profiles.json creation");
    return;
  }

  // Create directory structure: ~/.flock/agents/main/agent/
  const authDir = path.dirname(AUTH_PROFILE_PATH);
  fs.mkdirSync(authDir, { recursive: true });

  // Write auth-profiles.json with proper token type
  const authStore = {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "token",
        provider: "anthropic",
        token: token,
      },
    },
  };
  fs.writeFileSync(AUTH_PROFILE_PATH, JSON.stringify(authStore, null, 2), "utf-8");
  log(`  Created auth-profiles.json from SETUP_TOKEN (type: token)`);
  log(`  Path: ${AUTH_PROFILE_PATH}`);
}

/** Query SQLite DB and return raw output. */
function dbRaw(sql) {
  const result = execCapture(`sqlite3 "${DB_PATH}" "${sql}"`);
  return result.ok ? result.output.trim() : "";
}

// ============================================================
// Phase 1: flock init
// ============================================================

async function testFlockInit() {
  log("\n═══ Phase 1: flock init ═══");

  if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }

  const result = await new Promise((resolve) => {
    const child = spawn("flock", ["init"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME },
    });

    let stdout = "";
    let stderr = "";
    let promptsAnswered = 0;

    child.stdout.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      verbose(`init: ${text.trim()}`);

      if (text.includes("Orchestrator model") && promptsAnswered === 0) {
        child.stdin.write("anthropic/claude-opus-4-6\n");
        promptsAnswered++;
        verbose("  → answered model prompt");
      } else if (text.includes("Gateway token") && promptsAnswered === 1) {
        child.stdin.write(GATEWAY_TOKEN + "\n");
        promptsAnswered++;
        verbose("  → answered token prompt");
        setTimeout(() => child.stdin.end(), 500);
      } else if (text.includes("Reconfigure?")) {
        child.stdin.write("y\n");
        verbose("  → answered reconfigure prompt");
      }
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (process.env.E2E_VERBOSE) process.stderr.write(d);
    });

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGTERM");
        resolve({ code: -1, stdout, stderr: stderr + "\n[TIMEOUT]" });
      }
    }, 600_000);
  });

  assert(result.code === 0, "flock init exits with code 0",
    `Exit code: ${result.code}, stderr: ${result.stderr.slice(-500)}`);

  assert(fs.existsSync(CONFIG_PATH), "Config file created at ~/.flock/config.json");

  const openclawMjs = path.join(FLOCK_HOME, "openclaw", "openclaw.mjs");
  assert(fs.existsSync(openclawMjs), "OpenClaw build exists (openclaw.mjs)");

  const symlinkPath = path.join(FLOCK_HOME, "extensions", "flock");
  assert(fs.existsSync(symlinkPath), "Flock plugin symlink exists in extensions/");

  if (fs.existsSync(CONFIG_PATH)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    assert(config?.plugins?.entries?.flock?.enabled === true, "Flock plugin is enabled in config");
    assert(config?.gateway?.auth?.token === GATEWAY_TOKEN, "Gateway token matches what we provided");

    const agents = config?.agents?.list || [];
    const orchestrator = agents.find(a => a.id === "orchestrator");
    assert(orchestrator?.model?.primary === "anthropic/claude-opus-4-6", "Orchestrator model set to opus");

    return config;
  }

  return {};
}

// ============================================================
// Phase 2: Patch config for E2E
// ============================================================

function patchConfig(config) {
  log("\n═══ Phase 2: Patch config for E2E ═══");

  // Gateway network config — E2E-specific (port, bind, auth mode)
  if (!config.gateway) config.gateway = {};
  config.gateway.port = GATEWAY_PORT;
  config.gateway.mode = "local";
  config.gateway.bind = "lan";
  if (!config.gateway.auth) config.gateway.auth = {};
  config.gateway.auth.mode = "token";
  config.gateway.auth.token = GATEWAY_TOKEN;
  log("  + gateway port/mode/bind/auth");

  // NOTE: chatCompletions endpoint and tools.sandbox.tools.allow are now set
  // by `flock init` natively. No need to patch them here.

  // Sandbox defaults — E2E-specific paths.
  // Uses shared bind mount path /tmp/flock-e2e so sandbox sibling containers
  // (via host Docker socket) resolve volume paths correctly.
  // IMPORTANT: Merge with existing config to preserve nix bind (flock-nix:/nix:ro)
  // that was set by `flock init`.
  if (!config.agents) config.agents = {};
  const existingDefaults = config.agents.defaults || {};
  const existingSandbox = existingDefaults.sandbox || {};
  const existingBinds = existingSandbox.docker?.binds || [];
  config.agents.defaults = {
    ...existingDefaults,
    sandbox: {
      ...existingSandbox,
      mode: "non-main",
      workspaceRoot: "/tmp/flock-e2e/sandboxes",
      docker: {
        ...(existingSandbox.docker || {}),
        binds: [...existingBinds, `${SHARED_DIR}:${SANDBOX_SHARED}`],
      },
    },
  };
  log("  + agents.defaults.sandbox = non-main (merged binds, workspaceRoot for E2E)");
  verbose(`  Final sandbox binds: ${JSON.stringify([...existingBinds, `${SHARED_DIR}:${SANDBOX_SHARED}`])}`);

  // Ensure 'main' default agent exists (required by OpenClaw)
  const agentsList = config.agents.list || [];
  if (!agentsList.find(a => a.id === "main")) {
    agentsList.unshift({ id: "main", default: true });
    log("  + added 'main' default agent");
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  log("  Config saved");

  return config;
}

// ============================================================
// Phase 3: flock add (architect + coder)
// ============================================================

async function testFlockAddAgents() {
  log("\n═══ Phase 3: flock add (architect + coder) ═══");
  log("  (orchestrator + sysadmin already created by flock init)");

  // Verify sysadmin was created by init
  const preConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const preAgents = preConfig?.agents?.list || [];
  assert(preAgents.some(a => a.id === "sysadmin"), "sysadmin created by flock init");

  // Verify sysadmin has sandbox mode off (unsandboxed, full host access)
  const sysadminAgent = preAgents.find(a => a.id === "sysadmin");
  if (sysadminAgent) {
    assert(
      sysadminAgent.sandbox?.mode === "off",
      "sysadmin has sandbox mode 'off' (unsandboxed)",
      `Got: ${JSON.stringify(sysadminAgent.sandbox)}`
    );
  }

  // Add architect
  const archResult = execCapture("flock add architect --model anthropic/claude-opus-4-6");
  assert(archResult.ok, "flock add architect succeeds", archResult.output.trim());

  // Add coder
  const coderResult = execCapture("flock add coder --model anthropic/claude-opus-4-6");
  assert(coderResult.ok, "flock add coder succeeds", coderResult.output.trim());

  // Verify config
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const gatewayAgents = config?.plugins?.entries?.flock?.config?.gatewayAgents || [];
  assert(gatewayAgents.some(a => a.id === "sysadmin"), "sysadmin in gatewayAgents");
  assert(gatewayAgents.some(a => a.id === "architect" || a === "architect"), "architect in gatewayAgents");
  assert(gatewayAgents.some(a => a.id === "coder" || a === "coder"), "coder in gatewayAgents");

  const agentsList = config?.agents?.list || [];
  assert(agentsList.some(a => a.id === "sysadmin"), "sysadmin in agents.list");
  assert(agentsList.some(a => a.id === "architect"), "architect in agents.list");
  assert(agentsList.some(a => a.id === "coder"), "coder in agents.list");

  // Verify coder has nix PATH in env
  const coderAgent = agentsList.find(a => a.id === "coder");
  if (coderAgent) {
    const coderPath = coderAgent.sandbox?.docker?.env?.PATH || "";
    assert(
      coderPath.includes("/nix/var/nix/profiles/per-agent/coder/bin"),
      "coder PATH includes nix profile",
      coderPath
    );
  }
}

// ============================================================
// Phase 4: flock start
// ============================================================

async function testFlockStart() {
  log("\n═══ Phase 4: flock start ═══");

  // Debug: dump sandbox-related config
  const preStartConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  verbose(`Config sandbox defaults: ${JSON.stringify(preStartConfig?.agents?.defaults?.sandbox)}`);
  for (const agent of preStartConfig?.agents?.list || []) {
    verbose(`Agent ${agent.id} sandbox: ${JSON.stringify(agent.sandbox || "(inherits defaults)")}`);
  }

  gatewayProcess = spawn("flock", ["start"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME },
  });

  let stdout = "";
  let stderr = "";
  gatewayProcess.stdout.on("data", (d) => {
    stdout += d.toString();
    if (process.env.E2E_VERBOSE) process.stdout.write(d);
  });
  gatewayProcess.stderr.on("data", (d) => {
    stderr += d.toString();
    if (process.env.E2E_VERBOSE) process.stderr.write(d);
  });

  gatewayProcess.on("exit", (code) => {
    if (code !== null && code !== 0) {
      log(`  Gateway process exited with code ${code}`);
    }
  });

  assert(gatewayProcess.pid > 0, "flock start spawned successfully");

  log("  Waiting for gateway to become healthy...");
  const start = Date.now();
  let healthy = false;

  while (Date.now() - start < MAX_STARTUP_WAIT_MS) {
    const res = await httpGet("/health");
    if (res.status === 200) {
      healthy = true;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  assert(healthy, `Gateway healthy (took ${elapsed}s)`,
    healthy ? "" : `stderr: ${stderr.slice(-500)}`);

  if (!healthy) {
    log("  Last stderr:\n" + stderr.slice(-1000));
    log("  Last stdout:\n" + stdout.slice(-1000));
  }

  return { healthy };
}

// ============================================================
// Phase 5: Plugin & agent verification
// ============================================================

async function testPluginLoaded() {
  log("\n═══ Phase 5: Plugin & Agent Verification ═══");

  await sleep(3000);

  const agentCard = await httpGet("/flock/.well-known/agent-card.json");
  assert(agentCard.status === 200, "Flock agent-card endpoint responds");

  if (agentCard.status === 200) {
    const agents = agentCard.body?.agents || [];
    const agentIds = agents.map(a => a.id || a.name).sort();
    log(`  Registered agents: ${JSON.stringify(agentIds)}`);

    assert(agents.length >= 4, `At least 4 agents registered (got ${agents.length})`);
    assert(agentIds.includes("orchestrator"), "orchestrator registered");
    assert(agentIds.includes("sysadmin"), "sysadmin registered");
    assert(agentIds.includes("architect"), "architect registered");
    assert(agentIds.includes("coder"), "coder registered");
  }

  const health = await httpGet("/health");
  assert(health.status === 200, "GET /health returns 200");

  // Verify Nix daemon container is running
  log("\n  ── Nix Daemon Verification ──────────────────────");
  const nixCheck = execCapture('docker inspect -f "{{.State.Running}}" flock-nix-daemon');
  assert(
    nixCheck.ok && nixCheck.output.trim() === "true",
    "Nix daemon container is running",
    nixCheck.ok ? nixCheck.output.trim() : nixCheck.output.slice(-200)
  );

  // Verify nix volume exists
  const volCheck = execCapture("docker volume inspect flock-nix");
  assert(volCheck.ok, "flock-nix Docker volume exists");

  // Check orchestrator nix profile was created
  const profileCheck = execCapture(
    "docker exec flock-nix-daemon ls /nix/var/nix/profiles/per-agent/orchestrator"
  );
  assert(profileCheck.ok, "Orchestrator nix profile directory exists");

  log("  ─────────────────────────────────────────────────");
}

// ============================================================
// Phase 6: Multi-Agent Workflow
// ============================================================

async function testWorkflow() {
  log("\n═══ Phase 6: Multi-Agent Workflow (Rust + Nix) ═══");

  if (!fs.existsSync(AUTH_PROFILE_PATH)) {
    log("  ❌ FATAL: No auth-profiles.json — cannot run workflow test.");
    log("     Pass SETUP_TOKEN=sk-ant-oat01-... to create it automatically.");
    failed++;
    return;
  }

  // --- 6a: Ensure shared output directory (clean previous run artifacts) ---
  if (fs.existsSync(SHARED_DIR)) {
    fs.rmSync(SHARED_DIR, { recursive: true });
  }
  fs.mkdirSync(SHARED_DIR, { recursive: true });
  log("  Shared directory: " + SHARED_DIR);

  // --- 6b: Send project request to orchestrator via chat completions ---
  log("  Sending project request to orchestrator...");

  const prompt = `당신은 Flock 도구를 사용하여 멀티 에이전트 팀을 조율하는 오케스트레이터입니다.

다음 단계를 정확하게 수행하세요:

1. flock_channel_create를 다음 파라미터로 호출하세요:
   - channelId: "${CHANNEL_NAME}"
   - topic: "Rust로 FizzBuzz 프로그램 작성 — Nix로 설치한 rustc로 컴파일"
   - members: ["sysadmin", "architect", "coder"]
   - message: (아래 작업 내용 전체를 메시지로 전달)

채널에 올릴 작업 내용:
"""
프로젝트: Rust로 FizzBuzz (컴파일)

1부터 30까지 FizzBuzz를 출력하는 Rust 프로그램을 작성하고, 컴파일하고, 실행한 뒤, 결과를 파일에 저장하세요.

규칙:
- 3의 배수: "Fizz" 출력
- 5의 배수: "Buzz" 출력
- 3과 5의 공배수: "FizzBuzz" 출력
- 그 외: 숫자를 문자열로 출력

한 줄에 하나씩, 총 30줄이어야 합니다.

작업 순서 — 반드시 이 순서대로 진행:

1단계 (sysadmin): coder 에이전트용 Rust 컴파일러를 Nix로 설치.
exec로 다음 명령어를 정확히 실행:
  docker exec flock-nix-daemon nix profile install --profile /nix/var/nix/profiles/per-agent/coder nixpkgs#rustc nixpkgs#gcc
coder에게 rustc와 링커 접근 권한을 줍니다. 완료되면 확인 메시지를 남기세요.

2단계 (architect): 간단한 Rust FizzBuzz 설계를 제시.
최대한 심플하게 — main() 함수 안에 for 루프, println!, if/else if/else만.

3단계 (coder): Rust 소스 파일을 작성하고, 컴파일하고, 실행.
exec로 다음 명령어를 모두 실행:
  mkdir -p ${SANDBOX_SHARED}
  cat > ${SANDBOX_SOURCE_PATH} << 'RUSTEOF'
  (fizzbuzz.rs 코드)
  RUSTEOF
  rustc ${SANDBOX_SOURCE_PATH} -o ${SANDBOX_SHARED}/fizzbuzz
  ${SANDBOX_SHARED}/fizzbuzz > ${SANDBOX_OUTPUT_PATH}

중요: ${SANDBOX_OUTPUT_PATH}에 정확히 30줄의 FizzBuzz 출력이 있어야 합니다.
"""

2. 채널 생성 후, 수행한 내용을 확인해주세요.

직접 코드를 작성하지 마세요. 채널을 통해 에이전트들에게 위임하세요.`;

  const response = await httpPost("/v1/chat/completions", {
    model: "orchestrator",
    messages: [{ role: "user", content: prompt }],
  }, REQUEST_TIMEOUT_MS);

  const chatOk = assert(response.status === 200, "Orchestrator accepts project request (HTTP 200)",
    `Status: ${response.status}, Body preview: ${JSON.stringify(response.body)?.slice(0, 300)}`);

  if (!chatOk) {
    log("  Cannot continue workflow — orchestrator request failed.");
    return;
  }

  // Log orchestrator's response
  const orchResponse = response.body?.choices?.[0]?.message?.content || "";
  verbose(`Orchestrator response:\n${orchResponse.slice(0, 500)}`);
  log(`  Orchestrator responded (${orchResponse.length} chars)`);

  // --- 6c: Verify channel created in DB ---
  log("  Polling for channel creation in DB...");
  let channelFound = false;
  const channelStart = Date.now();

  while (Date.now() - channelStart < CHANNEL_POLL_TIMEOUT_MS) {
    const row = dbRaw(`SELECT channelId FROM channels WHERE channelId='${CHANNEL_NAME}' OR name='${CHANNEL_NAME}'`);
    if (row) {
      channelFound = true;
      break;
    }
    await sleep(3000);
  }

  if (!assert(channelFound, `Channel "${CHANNEL_NAME}" exists in DB`)) {
    log("  Cannot continue — channel was not created.");
    log("  Orchestrator may not have called flock_channel_create.");
    log("  Orchestrator response: " + orchResponse.slice(0, 500));

    // Dump all channels for debugging
    const allChannels = dbRaw("SELECT channelId, name FROM channels");
    log("  All channels in DB: " + (allChannels || "(none)"));
    return;
  }

  // --- 6d: Verify channel members ---
  const membersJson = dbRaw(`SELECT members FROM channels WHERE channelId='${CHANNEL_NAME}'`);
  let members = [];
  try { members = JSON.parse(membersJson); } catch { /* empty */ }
  log(`  Channel members: ${JSON.stringify(members)}`);

  assert(members.includes("architect"), "architect is a channel member");
  assert(members.includes("coder"), "coder is a channel member");

  // --- 6e: Wait for agent activity (messages + output file) ---
  log("  Waiting for agents to collaborate (Rust + Nix workflow)...");
  log("  (Work loop ~60s ticks — sysadmin installs rustc, coder compiles + runs)");

  const workStart = Date.now();
  let lastMsgCount = 0;
  let lastActivityAt = Date.now();
  let outputFound = false;

  while (Date.now() - workStart < WORKFLOW_TIMEOUT_MS) {
    // Check message count
    const countStr = dbRaw(
      `SELECT COUNT(*) FROM channel_messages WHERE channelId='${CHANNEL_NAME}'`
    );
    const msgCount = parseInt(countStr, 10) || 0;

    if (msgCount > lastMsgCount) {
      lastMsgCount = msgCount;
      lastActivityAt = Date.now();
      log(`  ... ${msgCount} messages in channel`);
    }

    // Check if output file exists (the final deliverable)
    if (fs.existsSync(OUTPUT_PATH)) {
      outputFound = true;
      log(`  ... output file detected at ${OUTPUT_PATH}`);
      // Give a few more seconds for any final messages
      await sleep(5000);
      break;
    }

    // Also log source file detection as progress indicator
    if (fs.existsSync(SOURCE_PATH) && !outputFound) {
      verbose(`  ... Rust source file detected at ${SOURCE_PATH}`);
    }

    // Check for idle: >180s with no new messages AND at least 3 agent messages
    // (need sysadmin + architect + coder participation, so higher threshold)
    const uniqueAgents = dbRaw(
      `SELECT COUNT(DISTINCT agentId) FROM channel_messages WHERE channelId='${CHANNEL_NAME}'`
    );
    const agentCount = parseInt(uniqueAgents, 10) || 0;

    if (msgCount >= 4 && agentCount >= 3 && (Date.now() - lastActivityAt > 180_000)) {
      log("  Channel idle for 3 minutes with 3+ agents participated.");
      break;
    }

    await sleep(15_000);
  }

  const workElapsed = Math.round((Date.now() - workStart) / 1000);
  log(`  Workflow waited ${workElapsed}s total`);

  // Final message count
  const finalCount = dbRaw(
    `SELECT COUNT(*) FROM channel_messages WHERE channelId='${CHANNEL_NAME}'`
  );
  assert(parseInt(finalCount, 10) >= 3, `Channel has messages (got ${finalCount})`,
    "Expected at least 3 messages (orchestrator task + sysadmin + coder)");

  // Check which agents participated
  const participants = dbRaw(
    `SELECT DISTINCT agentId FROM channel_messages WHERE channelId='${CHANNEL_NAME}'`
  );
  const participantList = participants ? participants.split("\n").filter(Boolean) : [];
  log(`  Participants: ${JSON.stringify(participantList)}`);
  assert(participantList.length >= 2, `Multiple agents participated (got ${participantList.length})`);

  // --- 6f: Dump all channel messages ---
  log("\n  ── Channel Messages ──────────────────────────────");
  const allMessages = dbRaw(
    `SELECT agentId, substr(content, 1, 300) FROM channel_messages WHERE channelId='${CHANNEL_NAME}' ORDER BY seq`
  );
  if (allMessages) {
    for (const line of allMessages.split("\n")) {
      if (!line.trim()) continue;
      const sep = line.indexOf("|");
      const agent = line.slice(0, sep);
      const content = line.slice(sep + 1);
      log(`  [${agent}] ${content.slice(0, 200)}${content.length > 200 ? "..." : ""}`);
    }
  } else {
    log("  (no messages found)");
  }
  log("  ─────────────────────────────────────────────────");

  // --- 6g: Verify Rust source file exists ---
  const sourceFound = fs.existsSync(SOURCE_PATH);
  if (sourceFound) {
    const sourceContent = fs.readFileSync(SOURCE_PATH, "utf-8");
    log(`  Rust source (${sourceContent.length} bytes):`);
    for (const line of sourceContent.split("\n").slice(0, 15)) {
      log(`    ${line}`);
    }
    if (sourceContent.split("\n").length > 15) log("    ...");
    assert(sourceContent.includes("fn main"), "Rust source contains fn main()");
  }
  // Source file is nice-to-have but not strictly required — the output file is the deliverable
  log(`  Rust source file: ${sourceFound ? "found" : "not found (may have been compiled in temp)"}`);

  // --- 6h: Verify output file exists and content is correct ---
  if (!outputFound) {
    // One last check
    outputFound = fs.existsSync(OUTPUT_PATH);
  }

  if (!assert(outputFound, `Output file created at ${OUTPUT_PATH}`)) {
    log("  Agents did not produce the output file.");
    log("  This means either:");
    log("    - sysadmin didn't install rustc");
    log("    - coder didn't compile the program");
    log("    - coder didn't run the compiled binary");
    log("  Check the channel messages above to diagnose.");
    return;
  }

  const output = fs.readFileSync(OUTPUT_PATH, "utf-8").trim();
  const lines = output.split("\n");

  log(`  Output file content (${output.length} bytes, ${lines.length} lines):`);
  for (const line of lines.slice(0, 10)) {
    log(`    ${line}`);
  }
  if (lines.length > 10) log("    ...");

  // Build expected output
  const expected = [];
  for (let i = 1; i <= 30; i++) {
    if (i % 15 === 0) expected.push("FizzBuzz");
    else if (i % 3 === 0) expected.push("Fizz");
    else if (i % 5 === 0) expected.push("Buzz");
    else expected.push(String(i));
  }

  assert(lines.length === 30, `Output has 30 lines (got ${lines.length})`);

  let correctLines = 0;
  let firstMismatch = null;
  for (let i = 0; i < 30; i++) {
    if (lines[i]?.trim() === expected[i]) {
      correctLines++;
    } else if (!firstMismatch) {
      firstMismatch = `Line ${i + 1}: expected "${expected[i]}", got "${lines[i]?.trim()}"`;
    }
  }

  assert(correctLines === 30, `All 30 FizzBuzz lines correct (got ${correctLines}/30)`,
    firstMismatch || "");

  if (correctLines < 30 && correctLines > 0) {
    log("  Partial output (first 10 lines):");
    lines.slice(0, 10).forEach((l, i) => {
      const mark = l.trim() === expected[i] ? "✓" : "✗";
      log(`    ${mark} ${l.trim()} (expected: ${expected[i]})`);
    });
  }

  // --- 6i: Verify Nix was actually used ---
  log("\n  ── Nix Verification ──────────────────────────────");

  // Check that rustc is now in the coder's nix profile
  const rustcCheck = execCapture(
    "docker exec flock-nix-daemon ls /nix/var/nix/profiles/per-agent/coder/bin/rustc"
  );
  assert(rustcCheck.ok, "rustc is installed in coder's nix profile",
    rustcCheck.ok ? "" : "sysadmin may not have installed rustc via nix");

  log("  ─────────────────────────────────────────────────");

  // --- 6j: Verify sandbox containers were created ---
  log("\n  ── Sandbox Verification ──────────────────────────");
  const dockerPs = execCapture(
    'docker ps -a --filter label=openclaw.sandbox=1 --format "{{.Names}}  {{.Status}}"'
  );
  if (dockerPs.ok) {
    const containers = dockerPs.output.trim().split("\n").filter(Boolean);
    for (const c of containers) {
      log(`  sandbox container: ${c}`);
    }
    assert(containers.length >= 1,
      `Sandbox containers created (got ${containers.length})`,
      "Proves agents ran inside Docker isolation");
  } else {
    assert(false, "docker ps succeeds", dockerPs.output.slice(-200));
  }
  log("  ─────────────────────────────────────────────────");
}

// ============================================================
// Phase 7: CLI commands
// ============================================================

async function testCliCommands() {
  log("\n═══ Phase 7: CLI Commands ═══");

  const listResult = execCapture("flock list");
  assert(listResult.ok, "flock list succeeds");
  assert(listResult.output.includes("orchestrator"), "flock list shows orchestrator", listResult.output.trim());
  assert(listResult.output.includes("sysadmin"), "flock list shows sysadmin", listResult.output.trim());
  assert(listResult.output.includes("architect"), "flock list shows architect", listResult.output.trim());
  assert(listResult.output.includes("coder"), "flock list shows coder", listResult.output.trim());

  const statusResult = execCapture("flock status");
  assert(statusResult.ok, "flock status succeeds");
  assert(statusResult.output.includes("running"), "flock status shows gateway running", statusResult.output.trim());
}

// ============================================================
// Phase 8: flock stop
// ============================================================

async function testFlockStop() {
  log("\n═══ Phase 8: flock stop ═══");

  const result = execCapture("flock stop");
  assert(result.ok, "flock stop succeeds", result.output.trim());

  await sleep(3000);

  const healthCheck = await httpGet("/health");
  assert(healthCheck.status === 0, "Gateway no longer responding after stop");

  assert(!fs.existsSync(PID_FILE), "PID file cleaned up");

  // Verify nix-daemon was also stopped (flock stop calls stopNixDaemon)
  const nixCheck = execCapture('docker inspect -f "{{.State.Running}}" flock-nix-daemon');
  const nixStopped = !nixCheck.ok || nixCheck.output.trim() !== "true";
  assert(nixStopped, "Nix daemon container stopped after flock stop");
}

// ============================================================
// Main
// ============================================================

async function main() {
  log("═══════════════════════════════════════════════════════");
  log("  Flock Standalone CLI — Full Workflow E2E Test");
  log("═══════════════════════════════════════════════════════\n");

  log(`HOME:       ${HOME}`);
  log(`FLOCK_HOME: ${FLOCK_HOME}`);
  const authSource = hasAuth();
  log(`Auth:       ${authSource || "NOT available"}`);
  log(`Verbose:    ${process.env.E2E_VERBOSE ? "yes" : "no (set E2E_VERBOSE=1 for details)"}`);
  log("");

  if (!authSource) {
    log("❌ FATAL: LLM credentials required for workflow test.");
    log("   Pass SETUP_TOKEN=sk-ant-oat01-... (Claude Code subscription token)");
    log("   This test does NOT skip — it requires real LLM calls.");
    process.exit(1);
  }

  try {
    // Pre-cleanup: remove stale sandbox containers from previous runs
    log("Cleaning up stale containers from previous runs...");
    cleanupSandboxContainers();

    // Phase 1: Init
    const config = await testFlockInit();

    // Phase 1.5: Create auth-profiles.json from SETUP_TOKEN
    // Must happen after init (creates ~/.flock/) but before start (agents need auth)
    setupAuthProfiles();

    // Phase 2: Patch config
    patchConfig(config);

    // Phase 3: Add agents
    await testFlockAddAgents();

    // Phase 4: Start gateway
    const { healthy } = await testFlockStart();

    if (!healthy) {
      log("\n⚠️  Gateway failed to start — cannot run workflow test.");
      process.exit(1);
    }

    // Phase 5: Plugin check
    await testPluginLoaded();

    // Phase 6: THE REAL TEST — multi-agent workflow
    await testWorkflow();

    // Phase 7: CLI commands
    await testCliCommands();

    // Phase 8: Stop
    await testFlockStop();

    log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);

    if (failed > 0) {
      log("\n❌ Some tests failed.");
    } else {
      log("\n✅ All workflow E2E tests passed!");
    }

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    log(`\nFatal error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  } finally {
    if (gatewayProcess && !gatewayProcess.killed) {
      try {
        gatewayProcess.kill("SIGTERM");
      } catch {
        // already dead
      }
    }
    // Post-cleanup: remove sandbox containers from this run
    log("Cleaning up sandbox containers...");
    cleanupSandboxContainers();
  }
}

main();
