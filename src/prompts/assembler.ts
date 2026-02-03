/**
 * Prompt Assembler — Workspace File Assembly for OpenClaw Native Structure
 *
 * Produces individual workspace files from templates in templates/:
 * - assembleAgentsMd(role) → AGENTS.md content (agents/base.md + agents/{role}.md)
 * - loadSoulTemplate(archetype) → SOUL.md seed from soul/{archetype}.md
 * - loadTemplate(name) → Other template files (IDENTITY.md, MEMORY.md, etc.)
 * - listAvailableArchetypes() → Available soul archetype names
 *
 * The assembler no longer produces a single system prompt string.
 * It produces individual workspace files that OpenClaw manages natively.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FlockAgentRole } from "../transport/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATES_DIR = path.join(__dirname, "templates");

// ---------------------------------------------------------------------------
// Role → template file mapping
// ---------------------------------------------------------------------------

const ROLE_TEMPLATE_FILES: Partial<Record<FlockAgentRole, string>> = {
  sysadmin: "sysadmin.md",
  worker: "worker.md",
  orchestrator: "orchestrator.md",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble AGENTS.md content from agents/base.md + agents/{role}.md.
 *
 * The base template contains the universal operating protocol (principles,
 * security, communication, etc.). The role template adds role-specific
 * responsibilities and guidelines.
 *
 * "system" role gets only the base template (no role-specific file).
 *
 * Returns the concatenated content that becomes the immutable AGENTS.md
 * workspace file.
 */
export function assembleAgentsMd(role: FlockAgentRole): string {
  const basePath = path.join(TEMPLATES_DIR, "agents", "base.md");
  if (!fs.existsSync(basePath)) {
    throw new Error(`Agent base template missing: ${basePath}`);
  }
  const base = fs.readFileSync(basePath, "utf-8");

  const roleFile = ROLE_TEMPLATE_FILES[role];
  if (!roleFile) {
    // "system" role has no role-specific template — just base
    return base;
  }

  const rolePath = path.join(TEMPLATES_DIR, "agents", roleFile);
  if (!fs.existsSync(rolePath)) {
    throw new Error(`Agent role template missing: ${rolePath}`);
  }
  const roleContent = fs.readFileSync(rolePath, "utf-8");

  return base + "\n" + roleContent;
}

/**
 * Load a soul template from templates/soul/{archetype}.md.
 *
 * Returns the file content (initial SOUL.md seed), or null if the
 * archetype does not exist.
 */
export function loadSoulTemplate(archetype: string): string | null {
  const filePath = path.join(TEMPLATES_DIR, "soul", `${archetype}.md`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Load a workspace template file by name (e.g. "IDENTITY", "MEMORY",
 * "HEARTBEAT", "USER", "TOOLS").
 *
 * Returns the file content, or null if not found.
 */
export function loadTemplate(name: string): string | null {
  const filePath = path.join(TEMPLATES_DIR, `${name}.md`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * List all available soul archetype names (without .md extension).
 */
export function listAvailableArchetypes(): string[] {
  const soulDir = path.join(TEMPLATES_DIR, "soul");
  if (!fs.existsSync(soulDir)) {
    return [];
  }
  return fs
    .readdirSync(soulDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}
