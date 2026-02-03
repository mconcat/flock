/**
 * Sysadmin Protocol Loader
 *
 * Loads and deploys the sysadmin prompt documents:
 * - triage-protocol.md — GREEN/YELLOW/RED classification guidance
 * - agent-knowledge.md — how to track and use agent-specific knowledge
 * - meta-governance.md — when and how to update the protocol itself
 *
 * These are prompt documents, not code. The sysadmin bot reads and follows them
 * using its own judgment — there is no programmatic classification engine.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROTOCOL_VERSION = "v0.2.0";

export interface SysadminProtocol {
  version: string;
  triageProtocol: string;
  agentKnowledge: string;
  metaGovernance: string;
}

const PROTOCOL_FILES = {
  triageProtocol: "triage-protocol.md",
  agentKnowledge: "agent-knowledge.md",
  metaGovernance: "meta-governance.md",
} as const;

/**
 * Load the sysadmin protocol documents from the bundled source.
 */
export function loadSysadminProtocol(): SysadminProtocol {
  return {
    version: PROTOCOL_VERSION,
    triageProtocol: readBundledFile(PROTOCOL_FILES.triageProtocol),
    agentKnowledge: readBundledFile(PROTOCOL_FILES.agentKnowledge),
    metaGovernance: readBundledFile(PROTOCOL_FILES.metaGovernance),
  };
}

/**
 * Deploy sysadmin protocol to a target directory.
 * Typically deployed to the sysadmin agent's home at /flock/base/sysadmin/.
 */
export function deploySysadminProtocol(targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });

  const protocol = loadSysadminProtocol();

  fs.writeFileSync(path.join(targetDir, "VERSION"), protocol.version);
  fs.writeFileSync(path.join(targetDir, PROTOCOL_FILES.triageProtocol), protocol.triageProtocol);
  fs.writeFileSync(path.join(targetDir, PROTOCOL_FILES.agentKnowledge), protocol.agentKnowledge);
  fs.writeFileSync(path.join(targetDir, PROTOCOL_FILES.metaGovernance), protocol.metaGovernance);
}

/**
 * Get the combined protocol as a single prompt string.
 * Useful for injecting into an agent's system prompt or context.
 */
export function getSysadminPrompt(): string {
  const protocol = loadSysadminProtocol();

  return [
    `# Sysadmin Protocol ${protocol.version}`,
    "",
    protocol.triageProtocol,
    "",
    "---",
    "",
    protocol.agentKnowledge,
    "",
    "---",
    "",
    protocol.metaGovernance,
  ].join("\n");
}

function readBundledFile(filename: string): string {
  const filePath = path.join(__dirname, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Sysadmin protocol file missing: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf-8");
}
