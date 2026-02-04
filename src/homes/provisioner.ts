/**
 * Home Provisioner — creates and manages home directory structures on disk.
 *
 * Handles:
 * - Directory tree creation per convention
 * - Workspace file deployment (all files into workspace/)
 * - Bind mount config generation (workspace rw + individual immutable file ro mounts)
 * - Home cleanup on retirement
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginLogger } from "../types.js";
import type { FlockConfig } from "../config.js";
import type { FlockAgentRole } from "../transport/types.js";
import { assembleAgentsMd, loadSoulTemplate, loadTemplate } from "../prompts/assembler.js";
import {
  HOME_DIRECTORIES,
  IMMUTABLE_WORKSPACE_FILES,
  CONTAINER_PATHS,
} from "./directory.js";
import { makeHomeId, validateId } from "./utils.js";

export interface ProvisionResult {
  homeId: string;
  homePath: string;
  directories: string[];
  bindMounts: BindMount[];
  workspaceFiles: string[];
  immutableFiles: string[];
}

export interface ProvisionOptions {
  /** Agent role — determines AGENTS.md content. Defaults to "worker". */
  role?: FlockAgentRole;
  /** Archetype name — determines initial SOUL.md seed. */
  archetype?: string;
}

export interface AgentInfo {
  id: string;
  role: FlockAgentRole;
  archetype?: string;
}

export interface BindMount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface HomeProvisioner {
  /** Create a new home directory structure on disk. */
  provision(agentId: string, nodeId: string, options?: ProvisionOptions): ProvisionResult;

  /**
   * Sync flock workspace files to the OpenClaw workspace directory.
   *
   * OpenClaw manages agent workspaces at ~/.openclaw/workspace-{agentId}/.
   * Flock provisions its own workspace files (AGENTS.md with role-specific
   * content, SOUL.md from archetypes, etc.) in flock homes. This method
   * ensures OpenClaw's workspace has the correct flock-assembled files.
   *
   * - Immutable files (AGENTS.md, USER.md): always overwritten
   * - Mutable files (SOUL.md, IDENTITY.md, etc.): only written if missing or
   *   still contain the generic OpenClaw default (detected by manifest tracking)
   * - BOOTSTRAP.md: removed (flock agents don't need first-run identity setup)
   *
   * @param coResidentAgents — list of all agents on this node, used to populate
   *   USER.md for sysadmin/orchestrator roles with worker information.
   */
  syncToOpenClawWorkspace(agentId: string, options?: ProvisionOptions, coResidentAgents?: AgentInfo[]): void;

  /** Check if a home exists on disk. */
  exists(agentId: string, nodeId: string): boolean;

  /** Get the host path for a home. */
  homePath(agentId: string, nodeId: string): string;

  /** Clean up runtime files (for freeze). */
  cleanRuntime(agentId: string, nodeId: string): void;

  /** Remove a home entirely (for retirement). */
  remove(agentId: string, nodeId: string): void;
}

interface ProvisionerParams {
  config: FlockConfig;
  logger: PluginLogger;
}

export function createHomeProvisioner(params: ProvisionerParams): HomeProvisioner {
  const { config, logger } = params;
  const rootDir = config.homes.rootDir;

  function assertSafeIds(agentId: string, nodeId: string): void {
    validateId(agentId, "agentId");
    validateId(nodeId, "nodeId");
  }

  function getHomePath(agentId: string, nodeId: string): string {
    // Use agentId as directory name (nodeId is implicit — we're on this node)
    return path.join(rootDir, agentId);
  }

  function provision(agentId: string, nodeId: string, options?: ProvisionOptions): ProvisionResult {
    assertSafeIds(agentId, nodeId);
    const homeId = makeHomeId(agentId, nodeId);
    const homePath = getHomePath(agentId, nodeId);
    const role: FlockAgentRole = options?.role ?? "worker";
    const archetype = options?.archetype;

    if (fs.existsSync(homePath)) {
      logger.warn(`[flock:provision] home directory already exists: ${homePath}`);
    }

    // Create all directories
    const created: string[] = [];
    for (const dir of HOME_DIRECTORIES) {
      const fullPath = path.join(homePath, dir);
      fs.mkdirSync(fullPath, { recursive: true });
      created.push(dir);
    }

    const workspacePath = path.join(homePath, "workspace");

    // --- Deploy all workspace files ---
    const workspaceFiles: string[] = [];
    const immutableFiles: string[] = [];

    // AGENTS.md — assembled from base + role templates (immutable)
    const agentsMd = assembleAgentsMd(role);
    fs.writeFileSync(path.join(workspacePath, "AGENTS.md"), agentsMd);
    workspaceFiles.push("AGENTS.md");
    immutableFiles.push("AGENTS.md");

    // USER.md — template (immutable)
    const userMd = loadTemplate("USER");
    if (userMd) {
      fs.writeFileSync(path.join(workspacePath, "USER.md"), userMd);
      workspaceFiles.push("USER.md");
      immutableFiles.push("USER.md");
    }

    // TOOLS.md — template (mutable — tools can be added dynamically)
    const toolsMd = loadTemplate("TOOLS");
    if (toolsMd) {
      fs.writeFileSync(path.join(workspacePath, "TOOLS.md"), toolsMd);
      workspaceFiles.push("TOOLS.md");
    }

    // SOUL.md — from archetype template, or generic seed (mutable)
    const soulContent = archetype
      ? (loadSoulTemplate(archetype) ?? loadTemplate("SOUL") ?? "# SOUL.md\n")
      : (loadTemplate("SOUL") ?? "# SOUL.md\n");
    if (soulContent) {
      fs.writeFileSync(path.join(workspacePath, "SOUL.md"), soulContent);
      workspaceFiles.push("SOUL.md");
    }

    // IDENTITY.md (mutable)
    const identityMd = loadTemplate("IDENTITY");
    if (identityMd) {
      fs.writeFileSync(path.join(workspacePath, "IDENTITY.md"), identityMd);
      workspaceFiles.push("IDENTITY.md");
    }

    // MEMORY.md (mutable)
    const memoryMd = loadTemplate("MEMORY");
    if (memoryMd) {
      fs.writeFileSync(path.join(workspacePath, "MEMORY.md"), memoryMd);
      workspaceFiles.push("MEMORY.md");
    }

    // HEARTBEAT.md (mutable)
    const heartbeatMd = loadTemplate("HEARTBEAT");
    if (heartbeatMd) {
      fs.writeFileSync(path.join(workspacePath, "HEARTBEAT.md"), heartbeatMd);
      workspaceFiles.push("HEARTBEAT.md");
    }

    // --- Generate bind mount config ---
    // Workspace directory is rw FIRST, then immutable files are overlaid ro on top.
    // Docker processes mounts in order, so file mounts overlay the directory mount.
    const bindMounts: BindMount[] = [
      // Workspace directory — rw so agent can modify mutable files
      { hostPath: path.join(homePath, "workspace"), containerPath: CONTAINER_PATHS.openclawWorkspace, readOnly: false },
      // Individual immutable file mounts — ro overlays on top of the rw directory
      ...immutableFiles.map((file) => ({
        hostPath: path.join(homePath, "workspace", file),
        containerPath: `${CONTAINER_PATHS.openclawWorkspace}/${file}`,
        readOnly: true,
      })),
      // Other directories
      { hostPath: path.join(homePath, "node"), containerPath: CONTAINER_PATHS.node, readOnly: false },
      { hostPath: path.join(homePath, "agent"), containerPath: CONTAINER_PATHS.agent, readOnly: false },
      { hostPath: path.join(homePath, "work"), containerPath: CONTAINER_PATHS.work, readOnly: false },
      { hostPath: path.join(homePath, "run"), containerPath: CONTAINER_PATHS.run, readOnly: false },
      { hostPath: path.join(homePath, "log"), containerPath: CONTAINER_PATHS.log, readOnly: false },
      { hostPath: path.join(homePath, "audit"), containerPath: CONTAINER_PATHS.audit, readOnly: false },
      { hostPath: path.join(homePath, "secrets"), containerPath: CONTAINER_PATHS.secrets, readOnly: false },
    ];

    logger.info(`[flock:provision] provisioned ${homeId} at ${homePath} (role: ${role}, archetype: ${archetype ?? "none"})`);

    return {
      homeId,
      homePath,
      directories: created,
      bindMounts,
      workspaceFiles,
      immutableFiles,
    };
  }

  function exists(agentId: string, nodeId: string): boolean {
    assertSafeIds(agentId, nodeId);
    return fs.existsSync(getHomePath(agentId, nodeId));
  }

  function homePath(agentId: string, nodeId: string): string {
    assertSafeIds(agentId, nodeId);
    return getHomePath(agentId, nodeId);
  }

  function cleanRuntime(agentId: string, nodeId: string): void {
    assertSafeIds(agentId, nodeId);
    const runDir = path.join(getHomePath(agentId, nodeId), "run");
    if (fs.existsSync(runDir)) {
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.mkdirSync(runDir, { recursive: true });
      logger.info(`[flock:provision] cleaned runtime for ${makeHomeId(agentId, nodeId)}`);
    }
  }

  function remove(agentId: string, nodeId: string): void {
    assertSafeIds(agentId, nodeId);
    const homePath = getHomePath(agentId, nodeId);
    if (fs.existsSync(homePath)) {
      fs.rmSync(homePath, { recursive: true, force: true });
      logger.info(`[flock:provision] removed home ${makeHomeId(agentId, nodeId)} at ${homePath}`);
    }
  }

  /**
   * Sync flock workspace files to the OpenClaw workspace directory.
   *
   * This bridges the gap between flock's provisioned workspace files and
   * OpenClaw's native workspace management. Without this, agents run with
   * OpenClaw's generic default templates instead of flock-assembled prompts.
   */
  function syncToOpenClawWorkspace(agentId: string, options?: ProvisionOptions, coResidentAgents?: AgentInfo[]): void {
    const role: FlockAgentRole = options?.role ?? "worker";
    const archetype = options?.archetype;

    // Resolve OpenClaw workspace path: ~/.openclaw/workspace-{agentId}/
    const openclawDir = path.join(os.homedir(), ".openclaw");
    const workspacePath = path.join(openclawDir, `workspace-${agentId}`);

    if (!fs.existsSync(workspacePath)) {
      // OpenClaw hasn't created the workspace yet — it will be created
      // when the agent session starts. Create it now so files are ready.
      fs.mkdirSync(workspacePath, { recursive: true });
    }

    const manifest = loadManifest(workspacePath);

    // --- Immutable files: always overwrite ---

    // AGENTS.md — assembled from base + role templates
    const agentsMd = assembleAgentsMd(role);
    fs.writeFileSync(path.join(workspacePath, "AGENTS.md"), agentsMd);
    manifest.files["AGENTS.md"] = hashContent(agentsMd);

    // USER.md — dynamic content based on role and co-resident agents
    const userMd = buildUserMd(agentId, role, config.nodeId, coResidentAgents);
    fs.writeFileSync(path.join(workspacePath, "USER.md"), userMd);
    manifest.files["USER.md"] = hashContent(userMd);

    // --- Mutable files: only write if agent hasn't customized ---

    // SOUL.md — from archetype or flock default
    const soulContent = archetype
      ? (loadSoulTemplate(archetype) ?? loadTemplate("SOUL") ?? "# SOUL.md\n")
      : (loadTemplate("SOUL") ?? "# SOUL.md\n");
    if (shouldWriteMutableFile(manifest, "SOUL.md", path.join(workspacePath, "SOUL.md"))) {
      fs.writeFileSync(path.join(workspacePath, "SOUL.md"), soulContent);
      manifest.files["SOUL.md"] = hashContent(soulContent);
    }

    // IDENTITY.md
    const identityMd = loadTemplate("IDENTITY");
    if (identityMd && shouldWriteMutableFile(manifest, "IDENTITY.md", path.join(workspacePath, "IDENTITY.md"))) {
      fs.writeFileSync(path.join(workspacePath, "IDENTITY.md"), identityMd);
      manifest.files["IDENTITY.md"] = hashContent(identityMd);
    }

    // MEMORY.md — never overwrite (append-only by nature)
    const memoryPath = path.join(workspacePath, "MEMORY.md");
    if (!fs.existsSync(memoryPath)) {
      const memoryMd = loadTemplate("MEMORY");
      if (memoryMd) {
        fs.writeFileSync(memoryPath, memoryMd);
        manifest.files["MEMORY.md"] = hashContent(memoryMd);
      }
    }

    // HEARTBEAT.md
    const heartbeatMd = loadTemplate("HEARTBEAT");
    if (heartbeatMd && shouldWriteMutableFile(manifest, "HEARTBEAT.md", path.join(workspacePath, "HEARTBEAT.md"))) {
      fs.writeFileSync(path.join(workspacePath, "HEARTBEAT.md"), heartbeatMd);
      manifest.files["HEARTBEAT.md"] = hashContent(heartbeatMd);
    }

    // TOOLS.md — only seed if missing
    const toolsPath = path.join(workspacePath, "TOOLS.md");
    if (!fs.existsSync(toolsPath)) {
      const toolsMd = loadTemplate("TOOLS");
      if (toolsMd) {
        fs.writeFileSync(toolsPath, toolsMd);
        manifest.files["TOOLS.md"] = hashContent(toolsMd);
      }
    }

    // --- Remove BOOTSTRAP.md if present ---
    // Flock agents don't need first-run identity discovery — they get their
    // identity from flock provisioning (role, archetype, SOUL.md seed).
    const bootstrapPath = path.join(workspacePath, "BOOTSTRAP.md");
    if (fs.existsSync(bootstrapPath)) {
      fs.unlinkSync(bootstrapPath);
    }

    // Save manifest
    manifest.syncedAt = Date.now();
    saveManifest(workspacePath, manifest);

    logger.info(
      `[flock:provision] synced workspace to OpenClaw: ${workspacePath} (role: ${role}, archetype: ${archetype ?? "none"})`,
    );
  }

  return { provision, exists, homePath, cleanRuntime, remove, syncToOpenClawWorkspace };
}

// ---------------------------------------------------------------------------
// Dynamic USER.md generation
// ---------------------------------------------------------------------------

function buildUserMd(
  agentId: string,
  role: FlockAgentRole,
  nodeId: string,
  coResidentAgents?: AgentInfo[],
): string {
  const lines: string[] = [
    "# USER.md — Flock Context",
    "",
    "## Human Operator",
    "",
    "The human operator owns and operates this Flock.",
    "Their explicit instructions override all agent-level decisions.",
    "",
    "## This Node",
    "",
    `- **Node ID:** ${nodeId}`,
    `- **Your Agent ID:** ${agentId}`,
    `- **Your Role:** ${role}`,
    "",
  ];

  if (coResidentAgents && coResidentAgents.length > 0) {
    // For sysadmin/orchestrator: show all agents on the node
    // For workers: show other workers (team awareness)
    const others = coResidentAgents.filter((a) => a.id !== agentId);

    if (role === "orchestrator" || role === "sysadmin") {
      const workers = others.filter((a) => a.role === "worker");
      const sysadmins = others.filter((a) => a.role === "sysadmin" || a.role === "orchestrator");

      if (workers.length > 0) {
        // Group workers by project prefix (e.g., cybros-, creep-, game-)
        const projectGroups = new Map<string, AgentInfo[]>();
        for (const w of workers) {
          const prefix = w.id.split("-")[0]; // e.g., "cybros" from "cybros-pm"
          if (!projectGroups.has(prefix)) {
            projectGroups.set(prefix, []);
          }
          projectGroups.get(prefix)!.push(w);
        }

        lines.push("## Project Teams");
        lines.push("");
        lines.push("Workers are organized by project. Each Discord channel corresponds to a project team.");
        lines.push("");

        for (const [prefix, team] of projectGroups) {
          lines.push(`### ${prefix} team`);
          for (const w of team) {
            const arch = w.archetype ? ` (${w.archetype})` : "";
            lines.push(`- **${w.id}**${arch}`);
          }
          lines.push("");
        }

        // Add instructions for orchestrator about channel-based routing
        if (role === "orchestrator") {
          lines.push("## How to Handle Requests from Discord");
          lines.push("");
          lines.push("**IMPORTANT: When you receive a request from a Discord channel, you MUST use `flock_broadcast` to relay it to the workers.**");
          lines.push("");
          lines.push("1. **Do NOT respond directly to project requests.** Your job is to relay, not to do the work.");
          lines.push("2. **Call `flock_broadcast`** with the request message. You don't need to specify the `to` parameter.");
          lines.push("   - The system automatically routes to the correct project team based on which Discord channel the message came from.");
          lines.push("3. **Example:**");
          lines.push("   - User sends \"코드베이스 분석해줘\" in a project channel");
          lines.push("   - You call: `flock_broadcast(message=\"사용자 요청: 코드베이스 분석해줘\")`");
          lines.push("   - System automatically routes to the correct team");
          lines.push("");
          lines.push("**You are a messenger, not a worker. Always broadcast to the team.**");
          lines.push("");
        }
      }

      if (sysadmins.length > 0) {
        lines.push("## Other Sysadmin/Orchestrator Agents");
        lines.push("");
        for (const s of sysadmins) {
          lines.push(`- **${s.id}** (${s.role})`);
        }
        lines.push("");
      }
    } else {
      // Worker: show teammates
      const teammates = others.filter((a) => a.role === "worker");
      if (teammates.length > 0) {
        lines.push("## Your Team (Worker Agents on This Node)");
        lines.push("");
        for (const t of teammates) {
          const arch = t.archetype ? ` (${t.archetype})` : "";
          lines.push(`- **${t.id}**${arch}`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Manifest-based sync tracking
// ---------------------------------------------------------------------------

const MANIFEST_FILENAME = ".flock-sync.json";

interface SyncManifest {
  /** Map of filename → sha256 hash of the content flock last wrote. */
  files: Record<string, string>;
  /** Timestamp of last sync. */
  syncedAt: number;
}

function loadManifest(workspacePath: string): SyncManifest {
  const manifestPath = path.join(workspacePath, MANIFEST_FILENAME);
  try {
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    }
  } catch { /* corrupted manifest — treat as empty */ }
  return { files: {}, syncedAt: 0 };
}

function saveManifest(workspacePath: string, manifest: SyncManifest): void {
  const manifestPath = path.join(workspacePath, MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function hashContent(content: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Check whether a mutable file should be overwritten.
 *
 * Uses a manifest to track what flock last wrote. Logic:
 * - File doesn't exist → write it
 * - File exists and matches the manifest hash (agent hasn't touched it) → safe to overwrite
 * - File exists but differs from manifest (agent customized it) → preserve
 * - No manifest entry (first sync of existing workspace) → overwrite
 *   (assumes existing content is OpenClaw default, not agent work)
 */
function shouldWriteMutableFile(
  manifest: SyncManifest,
  filename: string,
  filePath: string,
): boolean {
  if (!fs.existsSync(filePath)) return true;

  const lastHash = manifest.files[filename];
  if (!lastHash) {
    // First sync — no record of what was there before.
    // Overwrite: existing content is from OpenClaw defaults, not agent.
    return true;
  }

  // Compare current file content against what flock last wrote
  const currentHash = hashContent(fs.readFileSync(filePath, "utf-8"));
  if (currentHash === lastHash) {
    // Agent hasn't modified it — safe to overwrite with new template
    return true;
  }

  // Agent has customized this file — preserve their changes
  return false;
}

/**
 * Format bind mounts as Clawdbot docker bind config.
 * Returns a JSON-compatible array for `docker.binds`.
 */
export function formatBindMountsForConfig(mounts: BindMount[]): string[] {
  return mounts.map((m) => {
    const mode = m.readOnly ? "ro" : "rw";
    return `${m.hostPath}:${m.containerPath}:${mode}`;
  });
}
