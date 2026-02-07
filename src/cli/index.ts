#!/usr/bin/env node
/**
 * Flock CLI — Simplified installation and agent management.
 *
 * Commands:
 *   flock init              Initialize Flock in your OpenClaw setup
 *   flock add <id>          Add a new agent
 *   flock remove <id>       Remove an agent
 *   flock list              List configured agents
 *   flock status            Show Flock status
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig(): Record<string, unknown> {
  if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
  } catch {
    console.error("❌ Failed to parse openclaw.json");
    process.exit(1);
  }
}

function saveConfig(config: Record<string, unknown>): void {
  const dir = path.dirname(OPENCLAW_CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
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

function getFlockPluginPath(): string {
  // Try to find where flock is installed
  const candidates = [
    path.join(os.homedir(), ".openclaw", "extensions", "flock"),
    path.join(os.homedir(), ".openclaw", "plugins", "flock"),
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return path.join(os.homedir(), ".openclaw", "extensions", "flock");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(): Promise<void> {
  console.log("🐦 Flock Initialization\n");

  const config = loadConfig();
  const pluginPath = getFlockPluginPath();

  // Check if already initialized
  const existingFlock = (config as Record<string, unknown>).plugins &&
    ((config as Record<string, unknown>).plugins as Record<string, unknown>).entries &&
    (((config as Record<string, unknown>).plugins as Record<string, unknown>).entries as Record<string, unknown>).flock;

  if (existingFlock) {
    const proceed = await promptYN("Flock is already configured. Reconfigure?", false);
    if (!proceed) {
      console.log("Aborted.");
      return;
    }
  }

  // Ask for orchestrator model
  console.log("\n📋 Orchestrator Configuration");
  const defaultModel = "anthropic/claude-opus-4-5";
  const modelInput = await prompt(`Orchestrator model [${defaultModel}]: `);
  const orchestratorModel = modelInput || defaultModel;

  // Ask for gateway token
  const gatewayToken = (config as Record<string, unknown>).gateway &&
    ((config as Record<string, unknown>).gateway as Record<string, unknown>).token;
  let token = typeof gatewayToken === "string" ? gatewayToken : "";
  if (token) {
    const input = await prompt("Gateway token (leave empty to keep existing): ");
    if (input) {
      token = input;
    }
  } else {
    token = await prompt("Gateway token (leave empty to auto-generate): ");
    if (!token) {
      token = crypto.randomUUID().replace(/-/g, "");
      console.log(`Generated token: ${token}`);
    }
  }

  // Build config
  // 1. Ensure plugins structure
  if (!config.plugins) config.plugins = {};
  const plugins = config.plugins as Record<string, unknown>;
  if (!Array.isArray(plugins.load)) plugins.load = [];
  if (!plugins.entries) plugins.entries = {};

  // Add flock to plugins.load if not present
  const loadList = plugins.load as string[];
  if (!loadList.includes(pluginPath) && !loadList.some((p) => p.includes("flock"))) {
    loadList.push(pluginPath);
  }

  // Configure flock plugin (merge with existing to avoid wiping agents)
  const entries = plugins.entries as Record<string, unknown>;
  const existingFlock = entries.flock as Record<string, unknown> | undefined;
  const existingConfig = (existingFlock?.config ?? {}) as Record<string, unknown>;
  const existingGatewayAgents = Array.isArray(existingConfig.gatewayAgents)
    ? (existingConfig.gatewayAgents as Array<unknown>)
    : [];
  const mergedGatewayAgents = [...existingGatewayAgents];
  const hasGatewayOrchestrator = mergedGatewayAgents.some((a) => {
    if (typeof a === "string") return a === "orchestrator";
    if (typeof a === "object" && a !== null) return (a as Record<string, unknown>).id === "orchestrator";
    return false;
  });
  if (!hasGatewayOrchestrator) {
    mergedGatewayAgents.push({ id: "orchestrator", role: "orchestrator" });
  }

  entries.flock = {
    ...(existingFlock ?? {}),
    enabled: true,
    config: {
      ...existingConfig,
      dataDir: (existingConfig.dataDir as string | undefined) ?? ".flock",
      dbBackend: (existingConfig.dbBackend as string | undefined) ?? "sqlite",
      gatewayAgents: mergedGatewayAgents,
      gateway: {
        ...(existingConfig.gateway as Record<string, unknown> | undefined),
        port: (existingConfig.gateway as Record<string, unknown> | undefined)?.port ?? 3779,
        token,
      },
    },
  };

  // 2. Ensure agents structure
  if (!config.agents) config.agents = {};
  const agents = config.agents as Record<string, unknown>;
  if (!agents.list) agents.list = [];

  // Add orchestrator agent if not present, otherwise update its model
  const agentsList = agents.list as Array<Record<string, unknown>>;
  const hasOrchestrator = agentsList.some((a) => a.id === "orchestrator");
  if (!hasOrchestrator) {
    agentsList.push({
      id: "orchestrator",
      model: { primary: orchestratorModel },
      tools: { alsoAllow: ["group:plugins"] },
      workspace: `~/.openclaw/workspace-orchestrator`,
    });
  } else {
    const orchestrator = agentsList.find((a) => a.id === "orchestrator");
    if (orchestrator) {
      const model = orchestrator.model as Record<string, unknown> | undefined;
      if (model && typeof model === "object") {
        model.primary = orchestratorModel;
      } else {
        orchestrator.model = { primary: orchestratorModel };
      }
    }
  }

  // 3. Ensure gateway token is set at top level
  if (!config.gateway) config.gateway = {};
  const gw = config.gateway as Record<string, unknown>;
  gw.token = token;

  // Save
  saveConfig(config);
  console.log("\n✅ Flock initialized successfully!");
  console.log(`   Config: ${OPENCLAW_CONFIG_PATH}`);
  console.log("\n🚀 Next steps:");
  console.log("   1. Start the gateway: openclaw gateway start");
  console.log("   2. Chat with orchestrator and ask it to create worker agents");
  console.log("   3. Or run: flock add <agent-id> --role worker --model <model>");
}

async function cmdAdd(args: string[]): Promise<void> {
  const agentId = args[0];
  if (!agentId) {
    console.error("Usage: flock add <agent-id> [--role <role>] [--model <model>] [--archetype <archetype>]");
    process.exit(1);
  }

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

  // Check flock is initialized
  const flockConfig = ((config.plugins as Record<string, unknown>)?.entries as Record<string, unknown>)?.flock as Record<string, unknown> | undefined;
  if (!flockConfig) {
    console.error("❌ Flock not initialized. Run 'flock init' first.");
    process.exit(1);
  }

  if (!flockConfig.config || typeof flockConfig.config !== "object") {
    console.error("❌ Flock config is missing or invalid. Run 'flock init' first.");
    process.exit(1);
  }
  const flockInner = flockConfig.config as Record<string, unknown>;
  if (!flockInner.gatewayAgents) flockInner.gatewayAgents = [];
  const gatewayAgents = flockInner.gatewayAgents as Array<Record<string, unknown>>;

  // Check agent doesn't already exist
  if (gatewayAgents.some((a) => a.id === agentId)) {
    console.error(`❌ Agent '${agentId}' already exists in Flock config.`);
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
    const newAgent: Record<string, unknown> = {
      id: agentId,
      workspace: `~/.openclaw/workspace-${agentId}`,
      tools: {
        alsoAllow: ["group:plugins"],
        sandbox: {
          tools: {
            allow: [
              "exec", "process", "read", "write", "edit", "apply_patch",
              "image", "sessions_list", "sessions_history", "sessions_send",
              "sessions_spawn", "session_status", "flock_*",
            ],
          },
        },
      },
      sandbox: { mode: "all", scope: "agent" },
    };
    if (model) {
      newAgent.model = { primary: model };
    }
    agentsList.push(newAgent);
  } else if (model) {
    const existingModel = existingAgent.model as Record<string, unknown> | undefined;
    if (existingModel && typeof existingModel === "object") {
      existingModel.primary = model;
    } else {
      existingAgent.model = { primary: model };
    }
  }

  saveConfig(config);
  console.log(`✅ Agent '${agentId}' added successfully!`);
  console.log("   Restart the gateway to apply: openclaw gateway restart");
}

async function cmdRemove(args: string[]): Promise<void> {
  const agentId = args[0];
  if (!agentId) {
    console.error("Usage: flock remove <agent-id>");
    process.exit(1);
  }

  const config = loadConfig();
  let removedFromGateway = false;
  let removedFromAgents = false;

  // Remove from gatewayAgents
  const flockConfig = ((config.plugins as Record<string, unknown>)?.entries as Record<string, unknown>)?.flock as Record<string, unknown> | undefined;
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

  // Remove from agents.list
  if (config.agents && Array.isArray((config.agents as Record<string, unknown>).list)) {
    const agentsList = (config.agents as Record<string, unknown>).list as Array<Record<string, unknown>>;
    removedFromAgents = agentsList.some((a) => a.id === agentId);
    if (removedFromAgents) {
      (config.agents as Record<string, unknown>).list = agentsList.filter((a) => a.id !== agentId);
    }
  }

  if (!removedFromGateway && !removedFromAgents) {
    console.error(`❌ Agent '${agentId}' not found in config.`);
    process.exit(1);
  }

  saveConfig(config);
  console.log(`✅ Agent '${agentId}' removed from config.`);
  console.log("   Restart the gateway to apply: openclaw gateway restart");
}

function cmdList(): void {
  const config = loadConfig();
  const flockConfig = ((config.plugins as Record<string, unknown>)?.entries as Record<string, unknown>)?.flock as Record<string, unknown> | undefined;

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

  console.log("🐦 Flock Agents:\n");
  for (const agent of gatewayAgents) {
    const id = agent.id ?? agent;
    const role = agent.role ?? "worker";
    const archetype = agent.archetype ? ` (${agent.archetype})` : "";
    console.log(`  • ${id} — ${role}${archetype}`);
  }
}

function cmdStatus(): void {
  const config = loadConfig();
  const flockConfig = ((config.plugins as Record<string, unknown>)?.entries as Record<string, unknown>)?.flock as Record<string, unknown> | undefined;

  console.log("🐦 Flock Status\n");

  if (!flockConfig) {
    console.log("❌ Not initialized — run 'flock init'");
    return;
  }

  const enabled = (flockConfig as Record<string, unknown>).enabled;
  console.log(`Status: ${enabled ? "✅ Enabled" : "⚠️ Disabled"}`);

  const inner = flockConfig.config as Record<string, unknown> | undefined;
  if (inner) {
    console.log(`Data dir: ${inner.dataDir ?? ".flock"}`);
    console.log(`DB backend: ${inner.dbBackend ?? "memory"}`);

    const agents = inner.gatewayAgents as Array<unknown> | undefined;
    console.log(`Agents: ${agents?.length ?? 0}`);
  }

  console.log(`\nConfig path: ${OPENCLAW_CONFIG_PATH}`);
}

function showHelp(): void {
  console.log(`
🐦 Flock CLI — Multi-agent swarm orchestration

Usage:
  flock <command> [options]

Commands:
  init                    Initialize Flock in your OpenClaw setup
  add <id> [options]      Add a new agent
    --role <role>         Agent role (worker, sysadmin, orchestrator)
    --model <model>       Model to use (e.g., anthropic/claude-opus-4-5)
    --archetype <name>    Archetype template (e.g., code-reviewer, qa)
  remove <id>             Remove an agent from config
  list                    List configured agents
  status                  Show Flock configuration status
  help                    Show this help message

Examples:
  flock init
  flock add dev-code --role worker --model openai-codex/gpt-5.2 --archetype code-first-developer
  flock add reviewer --role worker --archetype code-reviewer
  flock remove dev-code
  flock list
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
