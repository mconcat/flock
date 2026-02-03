import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createSnapshot,
  collectWorkState,
  verifySnapshot,
  computeSha256,
  MigrationSnapshotError,
} from "../../../src/migration/snapshot.js";
import { MigrationErrorCode, MAX_PORTABLE_SIZE_BYTES } from "../../../src/migration/types.js";
import type { PluginLogger } from "../../../src/types.js";

const execFileAsync = promisify(execFile);

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("Snapshot", () => {
  let testDir: string;
  let homeDir: string;
  let workDir: string;
  let snapshotTmpDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "flock-snapshot-test-"));
    homeDir = join(testDir, "home");
    workDir = join(testDir, "work");
    snapshotTmpDir = join(testDir, "tmp");

    // Create home directory with agent subdirs
    await mkdir(join(homeDir, "toolkit"), { recursive: true });
    await mkdir(join(homeDir, "playbooks"), { recursive: true });
    await mkdir(join(homeDir, "knowledge", "active"), { recursive: true });
    await mkdir(join(homeDir, "knowledge", "archive"), { recursive: true });

    // Create some files in home
    await writeFile(join(homeDir, "toolkit", "tool-1.ts"), "export const tool1 = true;");
    await writeFile(join(homeDir, "playbooks", "main.md"), "# Main Playbook\nDo stuff.");
    await writeFile(
      join(homeDir, "knowledge", "active", "notes.md"),
      "# Notes\nSome knowledge.",
    );

    await mkdir(snapshotTmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("createSnapshot", () => {
    it("creates a tar.gz archive with correct checksum", async () => {
      const result = await createSnapshot(
        homeDir,
        "mig-test-1",
        snapshotTmpDir,
        makeLogger(),
      );

      expect(result.archivePath).toContain("agent-layer.tar.gz");
      expect(result.checksum).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.workState.projects).toHaveLength(0); // No workDir provided
    });

    it("archive can be extracted and contains original files", async () => {
      const result = await createSnapshot(
        homeDir,
        "mig-test-2",
        snapshotTmpDir,
        makeLogger(),
      );

      // Extract the archive
      const extractDir = join(testDir, "extracted");
      await mkdir(extractDir, { recursive: true });
      await execFileAsync("tar", ["xzf", result.archivePath, "-C", extractDir]);

      // Verify files exist
      const toolContent = await readFile(join(extractDir, "toolkit", "tool-1.ts"), "utf-8");
      expect(toolContent).toBe("export const tool1 = true;");

      const playbookContent = await readFile(join(extractDir, "playbooks", "main.md"), "utf-8");
      expect(playbookContent).toContain("# Main Playbook");
    });

    it("includes work state when workDir is provided", async () => {
      // Create a git repo in workDir
      await mkdir(join(workDir, "my-project"), { recursive: true });
      await execFileAsync("git", ["init"], { cwd: join(workDir, "my-project") });
      await execFileAsync("git", ["config", "user.email", "test@test.com"], {
        cwd: join(workDir, "my-project"),
      });
      await execFileAsync("git", ["config", "user.name", "Test"], {
        cwd: join(workDir, "my-project"),
      });
      await writeFile(join(workDir, "my-project", "README.md"), "# My Project");
      await execFileAsync("git", ["add", "."], { cwd: join(workDir, "my-project") });
      await execFileAsync("git", ["commit", "-m", "initial"], {
        cwd: join(workDir, "my-project"),
      });

      const result = await createSnapshot(
        homeDir,
        "mig-test-3",
        snapshotTmpDir,
        makeLogger(),
        workDir,
      );

      expect(result.workState.projects).toHaveLength(1);
      expect(result.workState.projects[0].relativePath).toBe("my-project");
      expect(result.workState.projects[0].commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(result.workState.capturedAt).toBeGreaterThan(0);
    });
  });

  describe("4GB size limit enforcement", () => {
    it("MigrationSnapshotError has correct code for size exceeded", () => {
      const err = new MigrationSnapshotError(
        MigrationErrorCode.SNAPSHOT_PORTABLE_SIZE_EXCEEDED,
        "Size exceeded",
        { sizeBytes: 5_000_000_000, limitBytes: MAX_PORTABLE_SIZE_BYTES },
      );

      expect(err.code).toBe(MigrationErrorCode.SNAPSHOT_PORTABLE_SIZE_EXCEEDED);
      expect(err.name).toBe("MigrationSnapshotError");
      expect(err.details.sizeBytes).toBe(5_000_000_000);

      const migError = err.toMigrationError();
      expect(migError.code).toBe(MigrationErrorCode.SNAPSHOT_PORTABLE_SIZE_EXCEEDED);
      expect(migError.phase).toBe("SNAPSHOTTING");
      expect(migError.recovery.type).toBe("abort");
    });

    it("MAX_PORTABLE_SIZE_BYTES is exactly 4GB", () => {
      expect(MAX_PORTABLE_SIZE_BYTES).toBe(4 * 1024 * 1024 * 1024);
      expect(MAX_PORTABLE_SIZE_BYTES).toBe(4_294_967_296);
    });
  });

  describe("collectWorkState", () => {
    it("collects git state from work directory", async () => {
      await mkdir(join(workDir, "project-a"), { recursive: true });
      await execFileAsync("git", ["init"], { cwd: join(workDir, "project-a") });
      await execFileAsync("git", ["config", "user.email", "test@test.com"], {
        cwd: join(workDir, "project-a"),
      });
      await execFileAsync("git", ["config", "user.name", "Test"], {
        cwd: join(workDir, "project-a"),
      });
      await writeFile(join(workDir, "project-a", "file.txt"), "hello");
      await execFileAsync("git", ["add", "."], { cwd: join(workDir, "project-a") });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: join(workDir, "project-a") });

      const manifest = await collectWorkState(workDir, makeLogger());

      expect(manifest.projects).toHaveLength(1);
      const project = manifest.projects[0];
      expect(project.relativePath).toBe("project-a");
      expect(project.branch).toMatch(/^(main|master)$/);
      expect(project.commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(project.uncommittedPatch).toBeNull();
      expect(project.untrackedFiles).toHaveLength(0);
    });

    it("detects uncommitted changes", async () => {
      await mkdir(join(workDir, "project-b"), { recursive: true });
      await execFileAsync("git", ["init"], { cwd: join(workDir, "project-b") });
      await execFileAsync("git", ["config", "user.email", "test@test.com"], {
        cwd: join(workDir, "project-b"),
      });
      await execFileAsync("git", ["config", "user.name", "Test"], {
        cwd: join(workDir, "project-b"),
      });
      await writeFile(join(workDir, "project-b", "file.txt"), "hello");
      await execFileAsync("git", ["add", "."], { cwd: join(workDir, "project-b") });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: join(workDir, "project-b") });

      // Make an uncommitted change
      await writeFile(join(workDir, "project-b", "file.txt"), "hello world");

      const manifest = await collectWorkState(workDir, makeLogger());
      const project = manifest.projects[0];
      expect(project.uncommittedPatch).not.toBeNull();
      expect(project.uncommittedPatch).toContain("hello world");
    });

    it("detects untracked files", async () => {
      await mkdir(join(workDir, "project-c"), { recursive: true });
      await execFileAsync("git", ["init"], { cwd: join(workDir, "project-c") });
      await execFileAsync("git", ["config", "user.email", "test@test.com"], {
        cwd: join(workDir, "project-c"),
      });
      await execFileAsync("git", ["config", "user.name", "Test"], {
        cwd: join(workDir, "project-c"),
      });
      await writeFile(join(workDir, "project-c", "tracked.txt"), "tracked");
      await execFileAsync("git", ["add", "."], { cwd: join(workDir, "project-c") });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: join(workDir, "project-c") });

      // Add untracked file
      await writeFile(join(workDir, "project-c", "untracked.txt"), "untracked");

      const manifest = await collectWorkState(workDir, makeLogger());
      const project = manifest.projects[0];
      expect(project.untrackedFiles).toContain("untracked.txt");
    });

    it("skips non-git directories", async () => {
      await mkdir(join(workDir, "not-a-repo"), { recursive: true });
      await writeFile(join(workDir, "not-a-repo", "file.txt"), "not git");

      const manifest = await collectWorkState(workDir, makeLogger());
      expect(manifest.projects).toHaveLength(0);
    });

    it("returns empty manifest for missing work directory", async () => {
      const manifest = await collectWorkState("/nonexistent/path", makeLogger());
      expect(manifest.projects).toHaveLength(0);
      expect(manifest.capturedAt).toBeGreaterThan(0);
    });
  });

  describe("verifySnapshot", () => {
    it("returns verified=true for matching checksum", async () => {
      const result = await createSnapshot(
        homeDir,
        "mig-verify-1",
        snapshotTmpDir,
        makeLogger(),
      );

      const verification = await verifySnapshot(result.archivePath, result.checksum);
      expect(verification.verified).toBe(true);
      expect(verification.computedChecksum).toBe(result.checksum);
      expect(verification.verifiedAt).toBeGreaterThan(0);
    });

    it("returns verified=false for mismatched checksum", async () => {
      const result = await createSnapshot(
        homeDir,
        "mig-verify-2",
        snapshotTmpDir,
        makeLogger(),
      );

      const wrongChecksum = "0".repeat(64);
      const verification = await verifySnapshot(result.archivePath, wrongChecksum);
      expect(verification.verified).toBe(false);
      expect(verification.failureReason).toBe("CHECKSUM_MISMATCH");
      expect(verification.computedChecksum).toBe(result.checksum);
    });

    it("returns ARCHIVE_CORRUPT for non-existent file", async () => {
      const verification = await verifySnapshot("/nonexistent/file.tar.gz", "abc");
      expect(verification.verified).toBe(false);
      expect(verification.failureReason).toBe("ARCHIVE_CORRUPT");
    });

    it("returns ARCHIVE_CORRUPT for invalid tar.gz", async () => {
      const fakePath = join(testDir, "fake.tar.gz");
      await writeFile(fakePath, "this is not a tar.gz file");

      const checksum = await computeSha256(fakePath);
      const verification = await verifySnapshot(fakePath, checksum);
      expect(verification.verified).toBe(false);
      expect(verification.failureReason).toBe("ARCHIVE_CORRUPT");
    });
  });

  describe("computeSha256 (streaming)", () => {
    it("computes correct SHA-256 hash", async () => {
      const testFile = join(testDir, "test-hash.txt");
      await writeFile(testFile, "hello world");

      const hash = await computeSha256(testFile);
      // SHA-256 of "hello world" is well-known
      expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    });

    it("returns 64-char hex string", async () => {
      const testFile = join(testDir, "test-hash-2.txt");
      await writeFile(testFile, "test content");

      const hash = await computeSha256(testFile);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("handles large files without OOM (streaming)", async () => {
      // Create a 10MB test file to verify streaming works
      const testFile = join(testDir, "large-file.bin");
      const chunk = Buffer.alloc(1024 * 1024, "A"); // 1MB
      const { createWriteStream } = await import("node:fs");
      const stream = createWriteStream(testFile);
      for (let i = 0; i < 10; i++) {
        stream.write(chunk);
      }
      await new Promise<void>((resolve) => stream.end(resolve));

      const hash = await computeSha256(testFile);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("rejects for nonexistent file", async () => {
      await expect(computeSha256("/nonexistent/file.txt")).rejects.toThrow();
    });
  });
});
