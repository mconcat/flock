#!/usr/bin/env node
/**
 * Flock CLI — Standalone multi-agent swarm orchestration.
 *
 * Commands:
 *   flock init              Install OpenClaw, build, and configure Flock
 *   flock start             Start the Flock gateway
 *   flock stop              Stop the running gateway
 *   flock add <id>          Add a new agent
 *   flock remove <id>       Remove an agent
 *   flock list              List configured agents
 *   flock status            Show Flock status
 *   flock update            Update bundled OpenClaw to latest
 */

import { execSync, spawn as cpSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths — everything lives under ~/.flock/
// ---------------------------------------------------------------------------

const FLOCK_HOME = path.join(os.homedir(), ".flock");
const OPENCLAW_DIR = path.join(FLOCK_HOME, "openclaw");
const CONFIG_PATH = path.join(FLOCK_HOME, "config.json");
const DATA_DIR = path.join(FLOCK_HOME, "data");
const EXTENSIONS_DIR = path.join(FLOCK_HOME, "extensions");
const WORKSPACES_DIR = path.join(FLOCK_HOME, "workspaces");
const PID_FILE = path.join(FLOCK_HOME, "gateway.pid");

const FLOCK_REPO = "https://github.com/openclaw/openclaw.git";
const FLOCK_BRANCH = "main";

/** Tools allowed inside sandbox containers. Shared by all sandboxed agents. */
const SANDBOX_TOOL_ALLOW = [
  "exec", "process", "read", "write", "edit", "apply_patch",
  "image", "sessions_list", "sessions_history", "sessions_send",
  "sessions_spawn", "session_status", "flock_*",
];

// Nix shared store — content-addressed package sharing across sandbox containers
const NIX_COMPOSE = path.join(FLOCK_HOME, "docker-compose.nix.yml");
const NIX_VOLUME = "flock-nix";
const NIX_CONTAINER = "flock-nix-daemon";
const NIX_PROFILE_BASE = "/nix/var/nix/profiles/per-agent";
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig(): Record<string, unknown> {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    console.error("Failed to parse config.json");
    process.exit(1);
  }
}

function saveConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptYN(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return prompt(`${question} ${hint}: `).then((ans) => {
    if (!ans) return defaultYes;
    return ans.toLowerCase().startsWith("y");
  });
}

function run(cmd: string, opts?: { cwd?: string; silent?: boolean }): void {
  const stdio = opts?.silent ? "pipe" : "inherit";
  execSync(cmd, { cwd: opts?.cwd, stdio, env: process.env });
}

function getFlockPluginDir(): string {
  // The Flock plugin's dist/ directory (where this CLI lives)
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function isInitialized(): boolean {
  return fs.existsSync(CONFIG_PATH) && fs.existsSync(path.join(OPENCLAW_DIR, "openclaw.mjs"));
}

function requireInit(): void {
  if (!isInitialized()) {
    console.error("Flock is not initialized. Run 'flock init' first.");
    process.exit(1);
  }
}

function getFlockConfig(config: Record<string, unknown>): Record<string, unknown> | null {
  return ((config.plugins as Record<string, unknown>)?.entries as Record<string, unknown>)
    ?.flock as Record<string, unknown> | null;
}

function getGatewayPid(): number | null {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;
  try {
    process.kill(pid, 0); // check if process exists
    return pid;
  } catch {
    // Process not running — clean up stale PID file
    fs.unlinkSync(PID_FILE);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Nix helpers
// ---------------------------------------------------------------------------

/** Check if Docker is available on this machine. */
function hasDocker(): boolean {
  try {
    execSync("docker info", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Check if the flock-nix-daemon container is running. */
function isNixDaemonRunning(): boolean {
  try {
    const out = execSync(
      `docker inspect -f "{{.State.Running}}" ${NIX_CONTAINER}`,
      { stdio: "pipe", encoding: "utf-8" },
    );
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Extract shared bind mounts from config that the Nix daemon should also have.
 * Sandbox containers get binds like "/tmp/flock-e2e/shared:/tmp/shared".
 * The Nix daemon needs these too so sysadmin can compile/place files there
 * via `docker exec flock-nix-daemon`.
 */
function getSharedBindsFromConfig(): string[] {
  if (!fs.existsSync(CONFIG_PATH)) return [];
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const agents = config.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const sandbox = defaults?.sandbox as Record<string, unknown> | undefined;
    const docker = sandbox?.docker as Record<string, unknown> | undefined;
    const binds = docker?.binds as string[] | undefined;
    if (!binds) return [];
    // Include bind mounts but skip the nix volume (already in compose)
    return binds.filter(b => !b.startsWith(`${NIX_VOLUME}:`));
  } catch {
    return [];
  }
}

/** Write the docker-compose.nix.yml file. Returns the content string. */
function generateNixCompose(): string {
  const extraBinds = getSharedBindsFromConfig();
  const volumeLines = [`      - ${NIX_VOLUME}:/nix`];
  for (const bind of extraBinds) {
    volumeLines.push(`      - ${bind}`);
  }
  const content = `services:
  nix-daemon:
    image: nixos/nix:latest
    container_name: ${NIX_CONTAINER}
    command: ["nix-daemon"]
    volumes:
${volumeLines.join("\n")}
    restart: unless-stopped

volumes:
  ${NIX_VOLUME}:
    name: ${NIX_VOLUME}
`;
  fs.writeFileSync(NIX_COMPOSE, content, "utf-8");
  return content;
}

/** Start the nix-daemon container, restarting if compose config changed. */
function ensureNixDaemon(): void {
  const existing = fs.existsSync(NIX_COMPOSE)
    ? fs.readFileSync(NIX_COMPOSE, "utf-8")
    : "";
  const updated = generateNixCompose();

  if (isNixDaemonRunning() && updated === existing) return;

  console.log("Starting Nix daemon...");
  run(`docker compose -f "${NIX_COMPOSE}" up -d`);
}

/** Stop the nix-daemon container. */
function stopNixDaemon(): void {
  if (!fs.existsSync(NIX_COMPOSE)) return;
  if (!isNixDaemonRunning()) return;
  console.log("Stopping Nix daemon...");
  run(`docker compose -f "${NIX_COMPOSE}" down`);
}

/** Create a per-agent Nix profile directory inside the daemon container. */
function createNixProfile(agentId: string): void {
  if (!isNixDaemonRunning()) return;
  try {
    execSync(
      `docker exec ${NIX_CONTAINER} mkdir -p ${NIX_PROFILE_BASE}/${agentId}`,
      { stdio: "pipe" },
    );
  } catch {
    // Non-fatal — profile will be created on first nix install
  }
}

/** Returns the PATH value for a sandboxed agent with Nix profile bin prepended. */
function nixAgentPath(agentId: string): string {
  return `${NIX_PROFILE_BASE}/${agentId}/bin:${DEFAULT_PATH}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(): Promise<void> {
  console.log("Flock Initialization\n");

  // 1. Create directory structure
  for (const dir of [FLOCK_HOME, DATA_DIR, EXTENSIONS_DIR, WORKSPACES_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 2. Clone or update OpenClaw
  if (fs.existsSync(path.join(OPENCLAW_DIR, ".git"))) {
    console.log("Updating bundled OpenClaw...");
    run(`git pull`, { cwd: OPENCLAW_DIR });
  } else {
    console.log(`Cloning OpenClaw (${FLOCK_BRANCH})...`);
    run(`git clone --branch ${FLOCK_BRANCH} --depth 1 ${FLOCK_REPO} "${OPENCLAW_DIR}"`);
  }

  // 3. Install dependencies and build
  console.log("Installing dependencies...");
  run("npm install --no-fund --no-audit", { cwd: OPENCLAW_DIR });
  console.log("Building OpenClaw...");
  run("npm run build", { cwd: OPENCLAW_DIR });

  // 4. Symlink Flock plugin into extensions/
  const flockPluginDir = getFlockPluginDir();
  const symlinkTarget = path.join(EXTENSIONS_DIR, "flock");
  if (fs.existsSync(symlinkTarget)) {
    fs.rmSync(symlinkTarget, { recursive: true, force: true });
  }
  fs.symlinkSync(flockPluginDir, symlinkTarget, "dir");
  console.log(`Linked plugin: ${symlinkTarget} -> ${flockPluginDir}`);

  // 5. Configure
  const config = fs.existsSync(CONFIG_PATH) ? loadConfig() : {};

  // Check if already has config — merge rather than overwrite
  const existingFlock = getFlockConfig(config);
  if (existingFlock) {
    const proceed = await promptYN("Flock is already configured. Reconfigure?", false);
    if (!proceed) {
      console.log("\nDone! OpenClaw updated, config preserved.");
      return;
    }
  }

  // Ask for orchestrator model
  console.log("\nOrchestrator Configuration");
  const defaultModel = "anthropic/claude-opus-4-5";
  const modelInput = await prompt(`Orchestrator model [${defaultModel}]: `);
  const orchestratorModel = modelInput || defaultModel;

  // Generate gateway token
  const existingToken = ((config.gateway as Record<string, unknown>)?.auth as Record<string, unknown>)?.token;
  let token = typeof existingToken === "string" ? existingToken : "";
  if (token) {
    const input = await prompt("Gateway token (leave empty to keep existing): ");
    if (input) token = input;
  } else {
    token = await prompt("Gateway token (leave empty to auto-generate): ");
    if (!token) {
      token = crypto.randomUUID().replace(/-/g, "");
      console.log(`Generated token: ${token}`);
    }
  }

  // Build config — merge with existing to avoid wiping agents
  const existingFlockConfig = (existingFlock?.config ?? {}) as Record<string, unknown>;
  const existingGatewayAgents = Array.isArray(existingFlockConfig.gatewayAgents)
    ? (existingFlockConfig.gatewayAgents as Array<unknown>)
    : [];
  const mergedGatewayAgents = [...existingGatewayAgents];
  // Ensure orchestrator and sysadmin exist — these are system-essential agents
  for (const sysAgent of [
    { id: "orchestrator", role: "orchestrator" },
    { id: "sysadmin", role: "sysadmin" },
  ]) {
    const exists = mergedGatewayAgents.some((a) => {
      if (typeof a === "string") return a === sysAgent.id;
      if (typeof a === "object" && a !== null) return (a as Record<string, unknown>).id === sysAgent.id;
      return false;
    });
    if (!exists) {
      mergedGatewayAgents.push(sysAgent);
    }
  }

  // Plugins section
  if (!config.plugins) config.plugins = {};
  const plugins = config.plugins as Record<string, unknown>;
  plugins.load = { paths: [symlinkTarget] };
  if (!plugins.entries) plugins.entries = {};
  (plugins.entries as Record<string, unknown>).flock = {
    ...(existingFlock ?? {}),
    enabled: true,
    config: {
      ...existingFlockConfig,
      dataDir: DATA_DIR,
      dbBackend: "sqlite",
      gatewayAgents: mergedGatewayAgents,
      gateway: {
        ...(existingFlockConfig.gateway as Record<string, unknown> | undefined),
        port: (existingFlockConfig.gateway as Record<string, unknown> | undefined)?.port ?? 3779,
        token,
      },
    },
  };

  // Agents section
  if (!config.agents) config.agents = {};
  const agents = config.agents as Record<string, unknown>;
  if (!agents.list) agents.list = [];
  const agentsList = agents.list as Array<Record<string, unknown>>;
  const hasAgentOrchestrator = agentsList.some((a) => a.id === "orchestrator");
  if (!hasAgentOrchestrator) {
    agentsList.push({
      id: "orchestrator",
      model: { primary: orchestratorModel },
      tools: {
        alsoAllow: ["group:plugins"],
        sandbox: { tools: { allow: [...SANDBOX_TOOL_ALLOW] } },
      },
      workspace: path.join(WORKSPACES_DIR, "orchestrator"),
      sandbox: {
        mode: "all",
        scope: "agent",
        docker: {
          binds: [
            `${WORKSPACES_DIR}:/flock/workspaces`,
            `${path.join(FLOCK_HOME, "agents")}:/flock/agents`,
          ],
          env: { PATH: nixAgentPath("orchestrator") },
        },
      },
    });
  } else {
    const orch = agentsList.find((a) => a.id === "orchestrator");
    if (orch) {
      const model = orch.model as Record<string, unknown> | undefined;
      if (model && typeof model === "object") model.primary = orchestratorModel;
      else orch.model = { primary: orchestratorModel };
    }
  }

  // Sysadmin — unsandboxed, full host access for infrastructure management (nix, docker)
  const hasAgentSysadmin = agentsList.some((a) => a.id === "sysadmin");
  if (!hasAgentSysadmin) {
    agentsList.push({
      id: "sysadmin",
      model: { primary: orchestratorModel },
      tools: {
        alsoAllow: ["group:plugins"],
      },
      workspace: path.join(WORKSPACES_DIR, "sysadmin"),
      sandbox: { mode: "off" },
    });
  }

  // Global sandbox defaults — Nix volume bind for all sandboxed agents.
  // OpenClaw concatenates agents.defaults.sandbox.docker.binds with per-agent binds.
  if (!agents.defaults || typeof agents.defaults !== "object") agents.defaults = {};
  const agentDefaults = agents.defaults as Record<string, unknown>;
  if (!agentDefaults.sandbox || typeof agentDefaults.sandbox !== "object") {
    agentDefaults.sandbox = {};
  }
  const defaultSandbox = agentDefaults.sandbox as Record<string, unknown>;
  if (!defaultSandbox.docker || typeof defaultSandbox.docker !== "object") {
    defaultSandbox.docker = {};
  }
  const defaultDocker = defaultSandbox.docker as Record<string, unknown>;
  if (!Array.isArray(defaultDocker.binds)) defaultDocker.binds = [];
  const defaultBinds = defaultDocker.binds as string[];
  const nixBind = `${NIX_VOLUME}:/nix:ro`;
  if (!defaultBinds.includes(nixBind)) defaultBinds.push(nixBind);

  // Gateway auth
  if (!config.gateway) config.gateway = {};
  const gw = config.gateway as Record<string, unknown>;
  if (!gw.auth || typeof gw.auth !== "object") gw.auth = {};
  (gw.auth as Record<string, unknown>).token = token;

  // Enable chatCompletions endpoint (required for curl-based interaction)
  if (!gw.http || typeof gw.http !== "object") gw.http = {};
  const gwHttp = gw.http as Record<string, unknown>;
  if (!gwHttp.endpoints || typeof gwHttp.endpoints !== "object") gwHttp.endpoints = {};
  const endpoints = gwHttp.endpoints as Record<string, unknown>;
  if (!endpoints.chatCompletions || typeof endpoints.chatCompletions !== "object") {
    endpoints.chatCompletions = {};
  }
  (endpoints.chatCompletions as Record<string, unknown>).enabled = true;

  // Global sandbox tool policy — fallback for agents without per-agent override.
  // Plugin tools (flock_*) run server-side but still need to be in the allow list
  // for sandbox agents to see them.
  if (!config.tools || typeof config.tools !== "object") config.tools = {};
  const toolsSection = config.tools as Record<string, unknown>;
  if (!toolsSection.sandbox || typeof toolsSection.sandbox !== "object") toolsSection.sandbox = {};
  const toolsSandbox = toolsSection.sandbox as Record<string, unknown>;
  if (!toolsSandbox.tools) {
    toolsSandbox.tools = { allow: [...SANDBOX_TOOL_ALLOW] };
  }

  saveConfig(config);

  // Nix shared store — generate compose file and start daemon
  generateNixCompose();
  if (hasDocker()) {
    ensureNixDaemon();
    createNixProfile("orchestrator");
    console.log("Nix shared store ready.");
  } else {
    console.log("Docker not available — Nix daemon will start with 'flock start'.");
  }

  console.log("\nFlock initialized successfully!");
  console.log(`   Home:   ${FLOCK_HOME}`);
  console.log(`   Config: ${CONFIG_PATH}`);
  console.log(`   Data:   ${DATA_DIR}`);
  console.log("\nNext steps:");
  console.log("   1. flock start");
  console.log("   2. Chat with orchestrator and ask it to create worker agents");
  console.log("   3. Or run: flock add <agent-id> --role worker --model <model>");
}

async function cmdStart(): Promise<void> {
  requireInit();

  const existingPid = getGatewayPid();
  if (existingPid) {
    console.log(`Gateway is already running (PID ${existingPid}).`);
    return;
  }

  // Ensure Nix daemon is running before starting gateway
  if (fs.existsSync(NIX_COMPOSE) && hasDocker()) {
    ensureNixDaemon();
  }

  console.log("Starting Flock gateway...");

  const child: ChildProcess = cpSpawn("node", ["openclaw.mjs", "gateway", "run"], {
    cwd: OPENCLAW_DIR,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: CONFIG_PATH,
      OPENCLAW_STATE_DIR: FLOCK_HOME,
    },
    stdio: "inherit",
    detached: false,
  });

  if (child.pid) {
    fs.writeFileSync(PID_FILE, String(child.pid), "utf-8");
  }

  child.on("exit", (code) => {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    if (code && code !== 0) {
      console.error(`Gateway exited with code ${code}`);
    }
  });

  // Forward signals
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      child.kill(sig);
    });
  }

  // Keep the parent alive while the child runs
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
}

function cmdStop(): void {
  const pid = getGatewayPid();
  if (!pid) {
    console.log("No running gateway found.");
    return;
  }

  process.kill(pid, "SIGTERM");
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  console.log(`Gateway stopped (PID ${pid}).`);

  // Stop Nix daemon
  stopNixDaemon();
}

async function cmdUpdate(): Promise<void> {
  requireInit();

  console.log("Updating bundled OpenClaw...");
  run("git pull", { cwd: OPENCLAW_DIR });

  console.log("Installing dependencies...");
  run("npm install --no-fund --no-audit", { cwd: OPENCLAW_DIR });

  console.log("Building...");
  run("npm run build", { cwd: OPENCLAW_DIR });

  // Update Nix daemon image
  if (fs.existsSync(NIX_COMPOSE) && hasDocker()) {
    console.log("Updating Nix daemon...");
    run(`docker compose -f "${NIX_COMPOSE}" pull`);
  }

  // Show version
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(OPENCLAW_DIR, "package.json"), "utf-8"));
    console.log(`\nUpdated to OpenClaw ${pkg.version}`);
  } catch {
    console.log("\nUpdate complete.");
  }
}

async function cmdAdd(args: string[]): Promise<void> {
  const agentId = args[0];
  if (!agentId) {
    console.error("Usage: flock add <agent-id> [--role <role>] [--model <model>] [--archetype <archetype>]");
    process.exit(1);
  }

  requireInit();

  // Parse options
  let role = "worker";
  let model = "";
  let archetype = "";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--role" && args[i + 1]) {
      role = args[++i];
    } else if (args[i] === "--model" && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === "--archetype" && args[i + 1]) {
      archetype = args[++i];
    }
  }

  const config = loadConfig();

  const flockConfig = getFlockConfig(config);
  if (!flockConfig?.config) {
    console.error("Flock config is missing. Run 'flock init' first.");
    process.exit(1);
  }
  const flockInner = flockConfig.config as Record<string, unknown>;
  if (!flockInner.gatewayAgents) flockInner.gatewayAgents = [];
  const gatewayAgents = flockInner.gatewayAgents as Array<Record<string, unknown>>;

  if (gatewayAgents.some((a) => a.id === agentId)) {
    console.error(`Agent '${agentId}' already exists.`);
    process.exit(1);
  }

  // Add to gatewayAgents
  const agentEntry: Record<string, unknown> = { id: agentId };
  if (role !== "worker") agentEntry.role = role;
  if (archetype) agentEntry.archetype = archetype;
  gatewayAgents.push(agentEntry);

  // Add to agents.list
  if (!config.agents) config.agents = {};
  const agents = config.agents as Record<string, unknown>;
  if (!agents.list) agents.list = [];
  const agentsList = agents.list as Array<Record<string, unknown>>;

  const existingAgent = agentsList.find((a) => a.id === agentId);
  if (!existingAgent) {
    const isSysadmin = role === "sysadmin";
    const newAgent: Record<string, unknown> = {
      id: agentId,
      workspace: path.join(WORKSPACES_DIR, agentId),
      tools: {
        alsoAllow: ["group:plugins"],
        sandbox: { tools: { allow: [...SANDBOX_TOOL_ALLOW] } },
      },
      ...(isSysadmin
        ? { sandbox: { mode: "off" } }
        : {
            sandbox: {
              mode: "all",
              scope: "agent",
              docker: {
                env: { PATH: nixAgentPath(agentId) },
              },
            },
          }),
    };
    if (model) newAgent.model = { primary: model };
    agentsList.push(newAgent);
  } else if (model) {
    const existingModel = existingAgent.model as Record<string, unknown> | undefined;
    if (existingModel && typeof existingModel === "object") existingModel.primary = model;
    else existingAgent.model = { primary: model };
  }

  saveConfig(config);

  // Create per-agent Nix profile directory
  if (role !== "sysadmin" && hasDocker()) {
    createNixProfile(agentId);
  }

  console.log(`Agent '${agentId}' added.`);
  console.log("   Restart the gateway to apply: flock stop && flock start");
}

async function cmdRemove(args: string[]): Promise<void> {
  const agentId = args[0];
  if (!agentId) {
    console.error("Usage: flock remove <agent-id>");
    process.exit(1);
  }

  requireInit();
  const config = loadConfig();
  let removedFromGateway = false;
  let removedFromAgents = false;

  const flockConfig = getFlockConfig(config);
  if (flockConfig?.config) {
    const inner = flockConfig.config as Record<string, unknown>;
    if (Array.isArray(inner.gatewayAgents)) {
      const gatewayAgents = inner.gatewayAgents as Array<unknown>;
      removedFromGateway = gatewayAgents.some((a) => {
        if (typeof a === "string") return a === agentId;
        if (typeof a === "object" && a !== null) return (a as Record<string, unknown>).id === agentId;
        return false;
      });
      if (removedFromGateway) {
        inner.gatewayAgents = gatewayAgents.filter((a) => {
          if (typeof a === "string") return a !== agentId;
          if (typeof a === "object" && a !== null) return (a as Record<string, unknown>).id !== agentId;
          return true;
        });
      }
    }
  }

  if (config.agents && Array.isArray((config.agents as Record<string, unknown>).list)) {
    const agentsList = (config.agents as Record<string, unknown>).list as Array<Record<string, unknown>>;
    removedFromAgents = agentsList.some((a) => a.id === agentId);
    if (removedFromAgents) {
      (config.agents as Record<string, unknown>).list = agentsList.filter((a) => a.id !== agentId);
    }
  }

  if (!removedFromGateway && !removedFromAgents) {
    console.error(`Agent '${agentId}' not found.`);
    process.exit(1);
  }

  saveConfig(config);
  console.log(`Agent '${agentId}' removed.`);
  console.log("   Restart the gateway to apply: flock stop && flock start");
}

function cmdList(): void {
  requireInit();
  const config = loadConfig();
  const flockConfig = getFlockConfig(config);

  if (!flockConfig) {
    console.log("Flock not configured. Run 'flock init' first.");
    return;
  }

  const inner = flockConfig.config as Record<string, unknown> | undefined;
  const gatewayAgents = inner?.gatewayAgents as Array<Record<string, unknown>> | undefined;

  if (!gatewayAgents || gatewayAgents.length === 0) {
    console.log("No agents configured.");
    return;
  }

  console.log("Flock Agents:\n");
  for (const agent of gatewayAgents) {
    const id = agent.id ?? agent;
    const role = agent.role ?? "worker";
    const archetype = agent.archetype ? ` (${agent.archetype})` : "";
    console.log(`  ${id} — ${role}${archetype}`);
  }
}

function cmdStatus(): void {
  console.log("Flock Status\n");

  if (!isInitialized()) {
    console.log("Not initialized — run 'flock init'");
    return;
  }

  const config = loadConfig();
  const flockConfig = getFlockConfig(config);
  const inner = (flockConfig?.config ?? {}) as Record<string, unknown>;

  // OpenClaw version
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(OPENCLAW_DIR, "package.json"), "utf-8"));
    console.log(`OpenClaw:  ${pkg.version}`);
  } catch {
    console.log("OpenClaw:  unknown");
  }

  // Gateway status
  const pid = getGatewayPid();
  console.log(`Gateway:   ${pid ? `running (PID ${pid})` : "stopped"}`);

  // Nix daemon status
  if (fs.existsSync(NIX_COMPOSE)) {
    const nixRunning = hasDocker() && isNixDaemonRunning();
    console.log(`Nix:       ${nixRunning ? "running" : "stopped"}`);
  }

  // Config info
  const agents = inner.gatewayAgents as Array<unknown> | undefined;
  console.log(`Agents:    ${agents?.length ?? 0}`);
  console.log(`Data dir:  ${inner.dataDir ?? DATA_DIR}`);
  console.log(`Config:    ${CONFIG_PATH}`);
  console.log(`Home:      ${FLOCK_HOME}`);
}

function showHelp(): void {
  console.log(`
Flock CLI — Standalone multi-agent swarm orchestration

Usage:
  flock <command> [options]

Commands:
  init                    Set up Flock (installs OpenClaw, builds, configures)
  start                   Start the gateway
  stop                    Stop the gateway
  update                  Update bundled OpenClaw to latest
  add <id> [options]      Add a new agent
    --role <role>         Agent role (worker, sysadmin, orchestrator)
    --model <model>       Model to use (e.g., anthropic/claude-opus-4-5)
    --archetype <name>    Archetype template (e.g., code-reviewer, qa)
  remove <id>             Remove an agent
  list                    List configured agents
  status                  Show Flock status
  help                    Show this help message

Examples:
  flock init
  flock start
  flock add dev-code --model anthropic/claude-sonnet-4-5 --archetype code-first-developer
  flock add reviewer --archetype code-reviewer
  flock list
  flock stop
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "init":
      await cmdInit();
      break;
    case "start":
      await cmdStart();
      break;
    case "stop":
      cmdStop();
      break;
    case "update":
      await cmdUpdate();
      break;
    case "add":
      await cmdAdd(args.slice(1));
      break;
    case "remove":
    case "rm":
      await cmdRemove(args.slice(1));
      break;
    case "list":
    case "ls":
      cmdList();
      break;
    case "status":
      cmdStatus();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
