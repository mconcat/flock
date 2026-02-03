import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rehydrate } from "../../../src/migration/rehydrate.js";
import type { MigrationPayload, WorkStateManifest } from "../../../src/migration/types.js";
import { MigrationErrorCode } from "../../../src/migration/types.js";
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

describe("Rehydrate", () => {
  let testDir: string;
  let sourceHomeDir: string;
  let targetHomeDir: string;
  let targetWorkDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "flock-rehydrate-test-"));
    sourceHomeDir = join(testDir, "source-home");
    targetHomeDir = join(testDir, "target-home");
    targetWorkDir = join(testDir, "target-work");

    // Create source home with agent subdirs
    await mkdir(join(sourceHomeDir, "toolkit"), { recursive: true });
    await mkdir(join(sourceHomeDir, "playbooks"), { recursive: true });
    await mkdir(join(sourceHomeDir, "knowledge", "active"), { recursive: true });
    await mkdir(join(sourceHomeDir, "knowledge", "archive"), { recursive: true });

    await writeFile(join(sourceHomeDir, "toolkit", "tool-1.ts"), "export const tool1 = true;");
    await writeFile(join(sourceHomeDir, "playbooks", "main.md"), "# Main Playbook");
    await writeFile(join(sourceHomeDir, "knowledge", "active", "notes.md"), "# Notes");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** Create a tar.gz archive from the source home directory. */
  async function createTestArchive(): Promise<Buffer> {
    const archivePath = join(testDir, "test-archive.tar.gz");
    await execFileAsync("tar", ["czf", archivePath, "-C", sourceHomeDir, "."]);
    return readFile(archivePath);
  }

  /** Compute SHA-256 of a buffer. */
  function computeChecksum(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
  }

  /** Create a basic MigrationPayload from the source home. */
  async function createTestPayload(
    workState?: WorkStateManifest,
  ): Promise<MigrationPayload> {
    const archive = await createTestArchive();
    return {
      portable: {
        archive,
        checksum: computeChecksum(archive),
        sizeBytes: archive.length,
      },
      agentIdentity: {
        agentId: "agent-1",
        role: "worker",
        guilds: ["default"],
        metadata: {},
      },
      workState: workState ?? { projects: [], capturedAt: Date.now() },
    };
  }

  describe("basic extraction", () => {
    it("extracts archive to target home path", async () => {
      const payload = await createTestPayload();
      const result = await rehydrate(payload, targetHomeDir, makeLogger());

      expect(result.success).toBe(true);
      expect(result.homePath).toBe(targetHomeDir);
      expect(result.completedAt).toBeGreaterThan(0);

      // Verify extracted files
      const toolContent = await readFile(join(targetHomeDir, "toolkit", "tool-1.ts"), "utf-8");
      expect(toolContent).toBe("export const tool1 = true;");

      const playbookContent = await readFile(join(targetHomeDir, "playbooks", "main.md"), "utf-8");
      expect(playbookContent).toBe("# Main Playbook");
    });

    it("preserves directory structure", async () => {
      const payload = await createTestPayload();
      await rehydrate(payload, targetHomeDir, makeLogger());

      // All expected directories should exist
      const dirs = [
        "toolkit",
        "playbooks",
        "knowledge/active",
        "knowledge/archive",
      ];

      for (const dir of dirs) {
        const dirStat = await stat(join(targetHomeDir, dir));
        expect(dirStat.isDirectory()).toBe(true);
      }
    });

    it("warns about missing expected directories", async () => {
      // Create archive without knowledge/archive
      const minimalSourceDir = join(testDir, "minimal-source");
      await mkdir(join(minimalSourceDir, "toolkit"), { recursive: true });
      await writeFile(join(minimalSourceDir, "toolkit", "tool.ts"), "tool");

      const archivePath = join(testDir, "minimal.tar.gz");
      await execFileAsync("tar", ["czf", archivePath, "-C", minimalSourceDir, "."]);
      const archive = await readFile(archivePath);

      const payload: MigrationPayload = {
        portable: {
          archive,
          checksum: computeChecksum(archive),
          sizeBytes: archive.length,
        },
        agentIdentity: null,
        workState: { projects: [], capturedAt: Date.now() },
      };

      const result = await rehydrate(payload, targetHomeDir, makeLogger());

      expect(result.success).toBe(true);
      // Should have warnings about missing dirs
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.includes("missing"))).toBe(true);
    });
  });

  describe("work state restoration", () => {
    it("clones git repos from work state manifest", async () => {
      // Create a bare git repo to clone from
      const bareRepo = join(testDir, "bare-repo.git");
      await mkdir(bareRepo, { recursive: true });
      await execFileAsync("git", ["init", "--bare"], { cwd: bareRepo });

      // Create a temp repo, add a file, push to bare
      const tempRepo = join(testDir, "temp-repo");
      await mkdir(tempRepo, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: tempRepo });
      await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: tempRepo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: tempRepo });
      await writeFile(join(tempRepo, "README.md"), "# Test Repo");
      await execFileAsync("git", ["add", "."], { cwd: tempRepo });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: tempRepo });
      await execFileAsync("git", ["remote", "add", "origin", bareRepo], { cwd: tempRepo });

      // Get the default branch name
      const { stdout: branchOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tempRepo });
      const branch = branchOut.trim();
      await execFileAsync("git", ["push", "origin", branch], { cwd: tempRepo });

      // Get commit SHA
      const { stdout: shaOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tempRepo });
      const commitSha = shaOut.trim();

      const workState: WorkStateManifest = {
        projects: [{
          relativePath: "my-project",
          remoteUrl: bareRepo,
          branch,
          commitSha,
          uncommittedPatch: null,
          untrackedFiles: [],
        }],
        capturedAt: Date.now(),
      };

      const payload = await createTestPayload(workState);
      const result = await rehydrate(payload, targetHomeDir, makeLogger(), targetWorkDir);

      expect(result.success).toBe(true);

      // Verify cloned repo exists
      const clonedReadme = await readFile(join(targetWorkDir, "my-project", "README.md"), "utf-8");
      expect(clonedReadme).toBe("# Test Repo");

      // Verify it's a git repo
      const gitStat = await stat(join(targetWorkDir, "my-project", ".git"));
      expect(gitStat.isDirectory()).toBe(true);
    });

    it("warns when HEAD diverges from expected commit", async () => {
      // Create a bare repo with two commits
      const bareRepo = join(testDir, "diverge-repo.git");
      await mkdir(bareRepo, { recursive: true });
      await execFileAsync("git", ["init", "--bare"], { cwd: bareRepo });

      const tempRepo = join(testDir, "diverge-temp");
      await mkdir(tempRepo, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: tempRepo });
      await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: tempRepo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: tempRepo });
      await writeFile(join(tempRepo, "file.txt"), "v1");
      await execFileAsync("git", ["add", "."], { cwd: tempRepo });
      await execFileAsync("git", ["commit", "-m", "v1"], { cwd: tempRepo });
      const { stdout: branchOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tempRepo });
      const branch = branchOut.trim();
      await execFileAsync("git", ["remote", "add", "origin", bareRepo], { cwd: tempRepo });
      await execFileAsync("git", ["push", "origin", branch], { cwd: tempRepo });

      // Add second commit
      await writeFile(join(tempRepo, "file.txt"), "v2");
      await execFileAsync("git", ["add", "."], { cwd: tempRepo });
      await execFileAsync("git", ["commit", "-m", "v2"], { cwd: tempRepo });
      await execFileAsync("git", ["push", "origin", branch], { cwd: tempRepo });

      // Use the first commit SHA (which won't match HEAD after clone)
      const { stdout: shaOut } = await execFileAsync("git", ["rev-parse", "HEAD~1"], { cwd: tempRepo });
      const oldCommitSha = shaOut.trim();

      const workState: WorkStateManifest = {
        projects: [{
          relativePath: "diverged-project",
          remoteUrl: bareRepo,
          branch,
          commitSha: oldCommitSha, // This won't match HEAD
          uncommittedPatch: null,
          untrackedFiles: [],
        }],
        capturedAt: Date.now(),
      };

      const payload = await createTestPayload(workState);
      const result = await rehydrate(payload, targetHomeDir, makeLogger(), targetWorkDir);

      expect(result.success).toBe(true);
      expect(result.warnings.some((w) => w.includes("diverged"))).toBe(true);
    });

    it("skips projects without remote URL", async () => {
      const workState: WorkStateManifest = {
        projects: [{
          relativePath: "local-only",
          remoteUrl: "",
          branch: "main",
          commitSha: "abc123",
          uncommittedPatch: null,
          untrackedFiles: [],
        }],
        capturedAt: Date.now(),
      };

      const payload = await createTestPayload(workState);
      const result = await rehydrate(payload, targetHomeDir, makeLogger(), targetWorkDir);

      expect(result.success).toBe(true);
      // Warning about skipping
      expect(result.warnings.some((w) => w.includes("no remote URL"))).toBe(true);
    });
  });

  describe("error handling", () => {
    it("returns failure for invalid archive", async () => {
      const payload: MigrationPayload = {
        portable: {
          archive: Buffer.from("not a tar.gz file"),
          checksum: "fake",
          sizeBytes: 17,
        },
        agentIdentity: null,
        workState: { projects: [], capturedAt: Date.now() },
      };

      const result = await rehydrate(payload, targetHomeDir, makeLogger());

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(MigrationErrorCode.REHYDRATE_EXTRACT_FAILED);
      expect(result.error!.phase).toBe("REHYDRATING");
      expect(result.error!.origin).toBe("target");
    });

    it("returns failure for git clone of nonexistent repo", async () => {
      const workState: WorkStateManifest = {
        projects: [{
          relativePath: "bad-project",
          remoteUrl: "/nonexistent/repo.git",
          branch: "main",
          commitSha: "abc",
          uncommittedPatch: null,
          untrackedFiles: [],
        }],
        capturedAt: Date.now(),
      };

      const payload = await createTestPayload(workState);
      const result = await rehydrate(payload, targetHomeDir, makeLogger(), targetWorkDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(MigrationErrorCode.REHYDRATE_GIT_CLONE_FAILED);
    });
  });

  describe("path traversal protection", () => {
    it("rejects projects with path traversal in relativePath", async () => {
      const workState: WorkStateManifest = {
        projects: [{
          relativePath: "../../etc/evil",
          remoteUrl: "https://example.com/repo.git",
          branch: "main",
          commitSha: "abc123",
          uncommittedPatch: null,
          untrackedFiles: [],
        }],
        capturedAt: Date.now(),
      };

      const payload = await createTestPayload(workState);
      const result = await rehydrate(payload, targetHomeDir, makeLogger(), targetWorkDir);

      // Should succeed (path traversal is a warning, project is skipped)
      expect(result.success).toBe(true);
      expect(result.warnings.some((w) => w.includes("Path traversal detected"))).toBe(true);
    });

    it("allows safe relative paths", async () => {
      // Create a bare repo
      const bareRepo = join(testDir, "safe-repo.git");
      await mkdir(bareRepo, { recursive: true });
      await execFileAsync("git", ["init", "--bare"], { cwd: bareRepo });

      const tempRepo = join(testDir, "safe-temp");
      await mkdir(tempRepo, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: tempRepo });
      await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: tempRepo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: tempRepo });
      await writeFile(join(tempRepo, "file.txt"), "safe");
      await execFileAsync("git", ["add", "."], { cwd: tempRepo });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: tempRepo });
      const { stdout: branchOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tempRepo });
      const branch = branchOut.trim();
      await execFileAsync("git", ["remote", "add", "origin", bareRepo], { cwd: tempRepo });
      await execFileAsync("git", ["push", "origin", branch], { cwd: tempRepo });
      const { stdout: shaOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tempRepo });

      const workState: WorkStateManifest = {
        projects: [{
          relativePath: "safe-project",
          remoteUrl: bareRepo,
          branch,
          commitSha: shaOut.trim(),
          uncommittedPatch: null,
          untrackedFiles: [],
        }],
        capturedAt: Date.now(),
      };

      const payload = await createTestPayload(workState);
      const result = await rehydrate(payload, targetHomeDir, makeLogger(), targetWorkDir);

      expect(result.success).toBe(true);
      expect(result.warnings.every((w) => !w.includes("Path traversal"))).toBe(true);
    });
  });

  describe("warnings", () => {
    it("warns about untracked files", async () => {
      // Create a bare repo
      const bareRepo = join(testDir, "warn-repo.git");
      await mkdir(bareRepo, { recursive: true });
      await execFileAsync("git", ["init", "--bare"], { cwd: bareRepo });

      const tempRepo = join(testDir, "warn-temp");
      await mkdir(tempRepo, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: tempRepo });
      await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: tempRepo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: tempRepo });
      await writeFile(join(tempRepo, "file.txt"), "content");
      await execFileAsync("git", ["add", "."], { cwd: tempRepo });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: tempRepo });
      const { stdout: branchOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tempRepo });
      const branch = branchOut.trim();
      await execFileAsync("git", ["remote", "add", "origin", bareRepo], { cwd: tempRepo });
      await execFileAsync("git", ["push", "origin", branch], { cwd: tempRepo });

      const { stdout: shaOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tempRepo });

      const workState: WorkStateManifest = {
        projects: [{
          relativePath: "warn-project",
          remoteUrl: bareRepo,
          branch,
          commitSha: shaOut.trim(),
          uncommittedPatch: null,
          untrackedFiles: ["local-file.txt", "another-local.txt"],
        }],
        capturedAt: Date.now(),
      };

      const payload = await createTestPayload(workState);
      const result = await rehydrate(payload, targetHomeDir, makeLogger(), targetWorkDir);

      expect(result.success).toBe(true);
      expect(result.warnings.some((w) => w.includes("untracked"))).toBe(true);
    });
  });
});
