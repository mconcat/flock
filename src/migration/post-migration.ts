/**
 * Post-Migration Bootstrap — POST_MIGRATION.md lifecycle management.
 *
 * After migration, agents may leave a POST_MIGRATION.md file in their home
 * directory containing tasks to complete on first boot (resume conversations,
 * restore environment, re-provision secrets, etc.).
 *
 * This module provides simple file operations for the framework.
 * The actual processing is done by the agent LLM.
 */

import { access, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Standard filename for post-migration tasks. */
const POST_MIGRATION_FILENAME = "POST_MIGRATION.md";

/**
 * Check if POST_MIGRATION.md exists in the agent's home directory.
 *
 * @param agentHomePath - Path to the agent's home directory
 * @returns true if the file exists
 */
export async function hasPostMigrationTasks(agentHomePath: string): Promise<boolean> {
  const filePath = join(agentHomePath, POST_MIGRATION_FILENAME);
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the contents of POST_MIGRATION.md from the agent's home directory.
 *
 * @param agentHomePath - Path to the agent's home directory
 * @returns File contents as a string, or null if the file doesn't exist
 */
export async function readPostMigrationTasks(agentHomePath: string): Promise<string | null> {
  const filePath = join(agentHomePath, POST_MIGRATION_FILENAME);
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Delete POST_MIGRATION.md after the agent has processed it.
 *
 * @param agentHomePath - Path to the agent's home directory
 */
export async function clearPostMigrationTasks(agentHomePath: string): Promise<void> {
  const filePath = join(agentHomePath, POST_MIGRATION_FILENAME);
  try {
    await unlink(filePath);
  } catch {
    // File already deleted or never existed — no-op
  }
}
