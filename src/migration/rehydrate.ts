/**
 * Migration Rehydrate — target-side restoration of agent state.
 *
 * Extracts the portable storage archive, clones git repositories,
 * applies uncommitted patches, and verifies directory structure.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, mkdir, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PluginLogger } from "../types.js";
import type { MigrationPayload, WorkProject, MigrationError } from "./types.js";
import { MigrationErrorCode } from "./types.js";

const execFileAsync = promisify(execFile);

// --- Rehydrate Result ---

/** Result of a rehydration attempt. */
export interface RehydrateResult {
  /** Whether rehydration succeeded. */
  success: boolean;
  /** Path to the restored home directory. */
  homePath: string;
  /** Error details if rehydration failed. */
  error?: MigrationError;
  /** Warnings (non-fatal issues). */
  warnings: string[];
  /** Completion time (epoch ms). */
  completedAt: number;
}

// --- Expected directory structure (from AGENT_SUBDIRS) ---

/** Expected subdirectories in the agent layer. */
const AGENT_SUBDIRS = [
  "toolkit",
  "playbooks",
  "knowledge/active",
  "knowledge/archive",
] as const;

// --- Public Functions ---

/**
 * Rehydrate an agent on the target node.
 *
 * Extracts the portable storage archive, clones git repos from the
 * work state manifest, applies uncommitted patches, and verifies
 * the restored directory structure.
 *
 * @param payload - Migration payload with archive and work state
 * @param targetHomePath - Path where the agent's home should be created
 * @param logger - Logger instance
 * @param targetWorkDir - Optional path for restoring work state (git repos)
 * @returns RehydrateResult with success/failure info
 */
export async function rehydrate(
  payload: MigrationPayload,
  targetHomePath: string,
  logger: PluginLogger,
  targetWorkDir?: string,
): Promise<RehydrateResult> {
  const warnings: string[] = [];
  const now = Date.now();

  // Step 1: Create target directory
  logger.info(`[flock:migration:rehydrate] Creating target home at ${targetHomePath}`);
  try {
    await mkdir(targetHomePath, { recursive: true });
  } catch (err) {
    return failResult(
      targetHomePath,
      MigrationErrorCode.REHYDRATE_EXTRACT_FAILED,
      `Failed to create target directory: ${errorMessage(err)}`,
      now,
    );
  }

  // Step 2: Write archive to temp file and extract
  logger.info(`[flock:migration:rehydrate] Extracting agent layer archive`);
  const extractResult = await extractArchive(payload.portable.archive, targetHomePath);
  if (!extractResult.success) {
    return failResult(
      targetHomePath,
      MigrationErrorCode.REHYDRATE_EXTRACT_FAILED,
      extractResult.error,
      now,
    );
  }

  // Step 3: Verify directory structure
  logger.info(`[flock:migration:rehydrate] Verifying directory structure`);
  const structureWarnings = await verifyDirectoryStructure(targetHomePath);
  warnings.push(...structureWarnings);

  // Step 4: Restore work state (git repos)
  if (targetWorkDir && payload.workState.projects.length > 0) {
    logger.info(`[flock:migration:rehydrate] Restoring ${payload.workState.projects.length} work projects`);
    await mkdir(targetWorkDir, { recursive: true });

    for (const project of payload.workState.projects) {
      const projectResult = await restoreWorkProject(project, targetWorkDir, logger);
      if (!projectResult.success) {
        // Git clone failure is fatal
        if (projectResult.fatal) {
          return failResult(
            targetHomePath,
            MigrationErrorCode.REHYDRATE_GIT_CLONE_FAILED,
            projectResult.error,
            now,
          );
        }
        // Non-fatal issues become warnings
        warnings.push(projectResult.error);
      }
      warnings.push(...projectResult.warnings);
    }
  }

  logger.info(`[flock:migration:rehydrate] Rehydration complete with ${warnings.length} warning(s)`);

  return {
    success: true,
    homePath: targetHomePath,
    warnings,
    completedAt: Date.now(),
  };
}

// --- Internal Helpers ---

/** Extract a tar.gz archive buffer into a target directory. */
async function extractArchive(
  archive: Buffer,
  targetPath: string,
): Promise<{ success: boolean; error: string }> {
  try {
    // Write archive to a temporary file in the target directory
    const tmpArchivePath = join(targetPath, ".migration-archive.tar.gz");

    await writeFile(tmpArchivePath, archive);

    try {
      await execFileAsync("tar", ["xzf", tmpArchivePath, "-C", targetPath]);
    } finally {
      // Clean up temp archive file
      try {
        await unlink(tmpArchivePath);
      } catch {
        // Best effort cleanup
      }
    }

    return { success: true, error: "" };
  } catch (err) {
    return { success: false, error: `Archive extraction failed: ${errorMessage(err)}` };
  }
}

/** Verify expected directory structure exists in the extracted agent layer. */
async function verifyDirectoryStructure(homePath: string): Promise<string[]> {
  const warnings: string[] = [];

  for (const subdir of AGENT_SUBDIRS) {
    const dirPath = join(homePath, subdir);
    try {
      const dirStat = await stat(dirPath);
      if (!dirStat.isDirectory()) {
        warnings.push(`Expected directory at ${subdir} but found a file`);
      }
    } catch {
      warnings.push(`Expected directory missing: ${subdir}`);
    }
  }

  return warnings;
}

/** Result of restoring a single work project. */
interface RestoreProjectResult {
  success: boolean;
  fatal: boolean;
  error: string;
  warnings: string[];
}

/** Clone and restore a single git work project. */
async function restoreWorkProject(
  project: WorkProject,
  workDir: string,
  logger: PluginLogger,
): Promise<RestoreProjectResult> {
  const projectPath = resolve(join(workDir, project.relativePath));
  const resolvedWorkDir = resolve(workDir);
  const warnings: string[] = [];

  // Path traversal check — ensure project path stays inside workDir
  if (!projectPath.startsWith(resolvedWorkDir + "/") && projectPath !== resolvedWorkDir) {
    return {
      success: false,
      fatal: false,
      error: `Path traversal detected, skipping project: ${project.relativePath}`,
      warnings: [],
    };
  }

  // Skip if no remote URL
  if (!project.remoteUrl) {
    return {
      success: false,
      fatal: false,
      error: `Project ${project.relativePath} has no remote URL, skipping clone`,
      warnings: [],
    };
  }

  // Step 1: git clone
  logger.info(`[flock:migration:rehydrate] Cloning ${project.remoteUrl} → ${project.relativePath}`);
  try {
    await execFileAsync("git", ["clone", project.remoteUrl, projectPath]);
  } catch (err) {
    return {
      success: false,
      fatal: true,
      error: `Git clone failed for ${project.relativePath}: ${errorMessage(err)}`,
      warnings: [],
    };
  }

  // Step 2: git checkout branch
  const gitOpts = { cwd: projectPath };
  try {
    await execFileAsync("git", ["checkout", project.branch], gitOpts);
  } catch (err) {
    warnings.push(`Failed to checkout branch ${project.branch}: ${errorMessage(err)}`);
  }

  // Step 3: Verify HEAD matches expected commit
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], gitOpts);
    const currentSha = stdout.trim();
    if (currentSha !== project.commitSha) {
      warnings.push(
        `HEAD diverged for ${project.relativePath}: expected ${project.commitSha.slice(0, 8)}, ` +
        `got ${currentSha.slice(0, 8)}`,
      );
    }
  } catch (err) {
    warnings.push(`Failed to verify HEAD for ${project.relativePath}: ${errorMessage(err)}`);
  }

  // Step 4: Apply uncommitted patch if present
  if (project.uncommittedPatch) {
    logger.info(`[flock:migration:rehydrate] Applying uncommitted patch for ${project.relativePath}`);
    try {
      await applyPatch(projectPath, project.uncommittedPatch);
    } catch (err) {
      // Patch apply failure: non-fatal warning
      warnings.push(
        `Failed to apply uncommitted patch for ${project.relativePath}: ${errorMessage(err)}`,
      );
    }
  }

  // Step 5: Warn about untracked files
  if (project.untrackedFiles.length > 0) {
    warnings.push(
      `Project ${project.relativePath} had ${project.untrackedFiles.length} untracked file(s) that were not transferred`,
    );
  }

  return { success: true, fatal: false, error: "", warnings };
}

/** Apply a git patch to a project directory via stdin pipe. */
async function applyPatch(projectPath: string, patchContent: string): Promise<void> {
  const patchFile = join(projectPath, ".migration-patch.diff");
  try {
    await writeFile(patchFile, patchContent);
    await execFileAsync("git", ["apply", patchFile], { cwd: projectPath });
  } finally {
    try {
      await unlink(patchFile);
    } catch {
      // Best effort cleanup
    }
  }
}

/** Create a failure RehydrateResult. */
function failResult(
  homePath: string,
  code: MigrationErrorCode,
  message: string,
  startedAt: number,
): RehydrateResult {
  return {
    success: false,
    homePath,
    error: {
      code,
      message,
      phase: "REHYDRATING",
      origin: "target",
      recovery: code === MigrationErrorCode.REHYDRATE_GIT_CLONE_FAILED
        ? { type: "retry", maxAttempts: 2, delayMs: 10_000 }
        : { type: "auto_rollback" },
    },
    warnings: [],
    completedAt: Date.now(),
  };
}

/** Safely extract error message from an unknown error value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
