/**
 * Migration Snapshot — archive creation and verification.
 *
 * Creates tar.gz snapshots of the agent's portable storage (/flock/agent/),
 * collects work state manifests from git repos, and verifies archive integrity.
 *
 * Enforces the 4GB portable size limit (MAX_PORTABLE_SIZE_BYTES).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, lstat, readdir, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PluginLogger } from "../types.js";
import type {
  WorkStateManifest,
  WorkProject,
  VerificationResult,
  MigrationError,
} from "./types.js";
import { MAX_PORTABLE_SIZE_BYTES, MigrationErrorCode } from "./types.js";

const execFileAsync = promisify(execFile);

// --- Snapshot Result ---

/** Result of creating a snapshot. */
export interface SnapshotResult {
  /** Path to the tar.gz archive. */
  archivePath: string;
  /** SHA-256 checksum of the archive. */
  checksum: string;
  /** Archive size in bytes. */
  sizeBytes: number;
  /** Work state manifest. */
  workState: WorkStateManifest;
}

// --- Public Functions ---

/**
 * Create a snapshot of the agent's portable storage.
 *
 * Archives the contents of homePath into a tar.gz file,
 * computes SHA-256 checksum, and collects work state.
 *
 * @param homePath - Path to the agent's home directory (portable storage)
 * @param migrationId - Migration ID for naming the archive
 * @param tmpDir - Temporary directory for staging
 * @param logger - Logger instance
 * @param workDir - Optional path to work directory for WorkStateManifest
 * @returns Snapshot result with archive path, checksum, and size
 * @throws MigrationSnapshotError if archive creation fails or size exceeds 4GB
 */
export async function createSnapshot(
  homePath: string,
  migrationId: string,
  tmpDir: string,
  logger: PluginLogger,
  workDir?: string,
): Promise<SnapshotResult> {
  const archiveDir = join(tmpDir, migrationId);
  await mkdir(archiveDir, { recursive: true });

  const archivePath = join(archiveDir, "agent-layer.tar.gz");

  // Check source directory size before archiving
  const sourceSize = await getDirectorySize(homePath);
  if (sourceSize > MAX_PORTABLE_SIZE_BYTES) {
    throw createSnapshotError(
      MigrationErrorCode.SNAPSHOT_PORTABLE_SIZE_EXCEEDED,
      `Portable storage size (${sourceSize} bytes) exceeds 4GB limit (${MAX_PORTABLE_SIZE_BYTES} bytes)`,
      { sizeBytes: sourceSize, limitBytes: MAX_PORTABLE_SIZE_BYTES },
    );
  }

  // Create tar.gz archive
  logger.info(`[flock:migration:snapshot] Creating archive from ${homePath}`);
  try {
    await execFileAsync("tar", ["czf", archivePath, "-C", homePath, "."]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw createSnapshotError(
      MigrationErrorCode.SNAPSHOT_ARCHIVE_FAILED,
      `Failed to create archive: ${msg}`,
    );
  }

  // Get archive size and enforce limit
  const archiveStat = await stat(archivePath);
  const sizeBytes = archiveStat.size;

  // Compute SHA-256 checksum
  logger.info(`[flock:migration:snapshot] Computing checksum for ${archivePath}`);
  const checksum = await computeSha256(archivePath);

  // Collect work state manifest
  const workState = workDir
    ? await collectWorkState(workDir, logger)
    : { projects: [], capturedAt: Date.now() };

  logger.info(
    `[flock:migration:snapshot] Snapshot created: ${sizeBytes} bytes, checksum=${checksum.slice(0, 16)}…`,
  );

  return { archivePath, checksum, sizeBytes, workState };
}

/**
 * Collect work state manifest from git repositories.
 *
 * Scans the work directory for git repos and records their state.
 *
 * @param workDir - Path to the work directory
 * @param logger - Logger instance
 * @returns WorkStateManifest with project states
 */
export async function collectWorkState(
  workDir: string,
  logger: PluginLogger,
): Promise<WorkStateManifest> {
  const projects: WorkProject[] = [];

  let entries: string[];
  try {
    entries = await readdir(workDir);
  } catch {
    // Work directory doesn't exist or is empty
    logger.info(`[flock:migration:snapshot] No work directory at ${workDir}`);
    return { projects: [], capturedAt: Date.now() };
  }

  for (const entry of entries) {
    const projectPath = join(workDir, entry);
    const gitDir = join(projectPath, ".git");

    // Check if this is a git repo
    try {
      await stat(gitDir);
    } catch {
      continue; // Not a git repo
    }

    try {
      const project = await collectGitProject(projectPath, entry);
      projects.push(project);
      logger.info(`[flock:migration:snapshot] Collected git state for ${entry}: ${project.branch}@${project.commitSha.slice(0, 8)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[flock:migration:snapshot] Failed to collect git state for ${entry}: ${msg}`);
    }
  }

  return { projects, capturedAt: Date.now() };
}

/**
 * Verify a snapshot archive against an expected checksum.
 *
 * @param archivePath - Path to the tar.gz archive
 * @param expectedChecksum - Expected SHA-256 checksum
 * @returns VerificationResult indicating success or failure
 */
export async function verifySnapshot(
  archivePath: string,
  expectedChecksum: string,
): Promise<VerificationResult> {
  const now = Date.now();

  // Compute actual checksum
  let computedChecksum: string;
  try {
    computedChecksum = await computeSha256(archivePath);
  } catch {
    return {
      verified: false,
      failureReason: "ARCHIVE_CORRUPT",
      verifiedAt: now,
    };
  }

  // Compare checksums
  if (computedChecksum !== expectedChecksum) {
    return {
      verified: false,
      failureReason: "CHECKSUM_MISMATCH",
      computedChecksum,
      verifiedAt: now,
    };
  }

  // Verify archive integrity (tar -tzf)
  try {
    await execFileAsync("tar", ["tzf", archivePath]);
  } catch {
    return {
      verified: false,
      failureReason: "ARCHIVE_CORRUPT",
      computedChecksum,
      verifiedAt: now,
    };
  }

  return {
    verified: true,
    computedChecksum,
    verifiedAt: now,
  };
}

// --- Internal Helpers ---

/**
 * Compute SHA-256 checksum of a file using streaming to avoid OOM on large files.
 *
 * @param filePath - Path to the file
 * @returns Hex-encoded SHA-256 hash
 */
export async function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Get the total size of a directory (recursive).
 * Uses lstat to avoid following symlinks (prevents infinite loops).
 *
 * @param dirPath - Path to the directory
 * @returns Total size in bytes
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const entryPath = join(dirPath, entry);
    const entryStat = await lstat(entryPath);

    // Skip symlinks to prevent infinite loops
    if (entryStat.isSymbolicLink()) {
      continue;
    }

    if (entryStat.isDirectory()) {
      totalSize += await getDirectorySize(entryPath);
    } else {
      totalSize += entryStat.size;
    }
  }

  return totalSize;
}

/**
 * Collect git project state from a single directory.
 *
 * @param projectPath - Absolute path to the project
 * @param relativePath - Relative path for the manifest
 * @returns WorkProject with git state
 */
async function collectGitProject(
  projectPath: string,
  relativePath: string,
): Promise<WorkProject> {
  const gitOpts = { cwd: resolve(projectPath) };

  // Get remote URL
  let remoteUrl = "";
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], gitOpts);
    remoteUrl = stdout.trim();
  } catch {
    // No remote configured
  }

  // Get current branch
  const { stdout: branchOut } = await execFileAsync(
    "git", ["rev-parse", "--abbrev-ref", "HEAD"], gitOpts,
  );
  const branch = branchOut.trim();

  // Get HEAD commit SHA
  const { stdout: shaOut } = await execFileAsync(
    "git", ["rev-parse", "HEAD"], gitOpts,
  );
  const commitSha = shaOut.trim();

  // Get uncommitted changes as patch
  let uncommittedPatch: string | null = null;
  try {
    const { stdout: diffOut } = await execFileAsync("git", ["diff", "HEAD"], gitOpts);
    if (diffOut.trim().length > 0) {
      uncommittedPatch = diffOut;
    }
  } catch {
    // No diff available
  }

  // Get untracked files
  const untrackedFiles: string[] = [];
  try {
    const { stdout: untrackedOut } = await execFileAsync(
      "git", ["ls-files", "--others", "--exclude-standard"], gitOpts,
    );
    const lines = untrackedOut.trim().split("\n").filter(Boolean);
    untrackedFiles.push(...lines);
  } catch {
    // Ignore
  }

  return {
    relativePath,
    remoteUrl,
    branch,
    commitSha,
    uncommittedPatch,
    untrackedFiles,
  };
}

// --- Error Helper ---

/** Typed error class for snapshot operations. */
export class MigrationSnapshotError extends Error {
  readonly code: MigrationErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: MigrationErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MigrationSnapshotError";
    this.code = code;
    this.details = details ?? {};
  }

  /** Convert to a MigrationError structure. */
  toMigrationError(): MigrationError {
    return {
      code: this.code,
      message: this.message,
      phase: "SNAPSHOTTING",
      origin: "source",
      recovery: this.code === MigrationErrorCode.SNAPSHOT_PORTABLE_SIZE_EXCEEDED
        ? { type: "abort", cleanupRequired: false }
        : { type: "retry", maxAttempts: 2, delayMs: 5000 },
      details: this.details,
    };
  }
}

/** Create a MigrationSnapshotError. */
function createSnapshotError(
  code: MigrationErrorCode,
  message: string,
  details?: Record<string, unknown>,
): MigrationSnapshotError {
  return new MigrationSnapshotError(code, message, details);
}
