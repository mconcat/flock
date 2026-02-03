/**
 * Agent Card Update Logic
 *
 * Allows agents to update their own A2A Agent Cards as they
 * develop specializations. Supports immutable card merging
 * and skill extraction from archetype templates.
 */

import type { AgentCard, AgentSkill } from "@a2a-js/sdk";

// --- Card update params ---

export interface CardUpdateParams {
  /** Updated agent name. */
  name?: string;
  /** Updated agent description. */
  description?: string;
  /** Replacement skill set (replaces entirely, not merged). */
  skills?: AgentSkill[];
}

// --- Immutable card merge ---

/**
 * Create an updated card by merging updates into an existing card.
 * Returns a new AgentCard (immutable — original is not modified).
 *
 * - `name` and `description` are replaced if provided.
 * - `skills` replaces the entire skill set if provided (the agent
 *   decides its full skill list, not a delta).
 * - All other card fields are preserved as-is.
 */
export function mergeCardUpdate(existing: AgentCard, updates: CardUpdateParams): AgentCard {
  return {
    ...existing,
    ...(updates.name !== undefined && { name: updates.name }),
    ...(updates.description !== undefined && { description: updates.description }),
    ...(updates.skills !== undefined && { skills: updates.skills }),
  };
}

// --- Archetype skill extraction ---

/**
 * Generate initial card skills from an archetype template.
 *
 * Parses the archetype markdown's "Starting Knowledge" and
 * "Starting Focus" sections to create AgentSkill entries.
 * Uses the archetype name as a tag prefix for namespacing
 * (e.g., "qa-edge-case-analysis", "qa-test-design").
 */
export function skillsFromArchetype(archetype: string, archetypeContent: string): AgentSkill[] {
  const prefix = archetype.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const skills: AgentSkill[] = [];

  // Extract "Starting Focus" as a single high-level skill
  const focusContent = extractSection(archetypeContent, "Starting Focus");
  if (focusContent) {
    const focusText = focusContent.trim();
    skills.push({
      id: `${prefix}-focus`,
      name: `${archetype} Focus`,
      description: focusText,
      tags: [prefix, "focus"],
    });
  }

  // Extract "Starting Knowledge" bullet items as individual skills
  const knowledgeContent = extractSection(archetypeContent, "Starting Knowledge");
  if (knowledgeContent) {
    const items = parseBulletItems(knowledgeContent);
    for (const item of items) {
      const id = skillIdFromText(prefix, item.label);
      skills.push({
        id,
        name: item.label,
        description: item.description,
        tags: [prefix, "knowledge"],
      });
    }
  }

  return skills;
}

// --- Internal helpers ---

interface BulletItem {
  label: string;
  description: string;
}

/**
 * Extract a markdown section by heading name.
 * Returns the content between "## <heading>" and the next "##" heading (or EOF).
 */
function extractSection(content: string, heading: string): string | null {
  // Match "## <heading>" (case-insensitive, ignoring leading whitespace)
  const pattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "im");
  const match = pattern.exec(content);
  if (!match) return null;

  const startIdx = match.index + match[0].length;
  // Find the next ## heading
  const nextHeading = content.indexOf("\n## ", startIdx);
  const endIdx = nextHeading === -1 ? content.length : nextHeading;
  return content.slice(startIdx, endIdx);
}

/**
 * Parse markdown bullet items in the format:
 *   - **Label**: Description text
 *   - Label: Description text
 *   - Just a description
 */
function parseBulletItems(content: string): BulletItem[] {
  const items: BulletItem[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Match lines starting with "- "
    if (!trimmed.startsWith("- ")) continue;

    const text = trimmed.slice(2).trim();
    if (!text) continue;

    // Try "**Label**: description" pattern
    const boldMatch = /^\*\*(.+?)\*\*\s*[:—–-]\s*(.+)$/.exec(text);
    if (boldMatch) {
      items.push({ label: boldMatch[1].trim(), description: boldMatch[2].trim() });
      continue;
    }

    // Try "Label: description" pattern (with colon separator)
    const colonMatch = /^([^:]+):\s+(.+)$/.exec(text);
    if (colonMatch && colonMatch[1].length < 60) {
      items.push({ label: colonMatch[1].trim(), description: colonMatch[2].trim() });
      continue;
    }

    // Bare item — use first few words as label, full text as description
    const words = text.split(/\s+/);
    const label = words.slice(0, 4).join(" ");
    items.push({ label, description: text });
  }

  return items;
}

/**
 * Generate a kebab-case skill ID from a prefix and label text.
 * e.g., ("qa", "Edge case awareness") → "qa-edge-case-awareness"
 */
function skillIdFromText(prefix: string, text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 50);
  return `${prefix}-${slug}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
