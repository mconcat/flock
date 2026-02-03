import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hasPostMigrationTasks,
  readPostMigrationTasks,
  clearPostMigrationTasks,
} from "../../../src/migration/post-migration.js";

describe("PostMigration", () => {
  let testDir: string;
  let agentHome: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "flock-post-migration-test-"));
    agentHome = join(testDir, "agent-home");
    await mkdir(agentHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("hasPostMigrationTasks", () => {
    it("returns false when POST_MIGRATION.md does not exist", async () => {
      const result = await hasPostMigrationTasks(agentHome);
      expect(result).toBe(false);
    });

    it("returns true when POST_MIGRATION.md exists", async () => {
      await writeFile(join(agentHome, "POST_MIGRATION.md"), "# Tasks\n- Resume chat with agent-2");

      const result = await hasPostMigrationTasks(agentHome);
      expect(result).toBe(true);
    });

    it("returns false for nonexistent directory", async () => {
      const result = await hasPostMigrationTasks("/nonexistent/path");
      expect(result).toBe(false);
    });
  });

  describe("readPostMigrationTasks", () => {
    it("returns null when POST_MIGRATION.md does not exist", async () => {
      const result = await readPostMigrationTasks(agentHome);
      expect(result).toBeNull();
    });

    it("returns file contents when POST_MIGRATION.md exists", async () => {
      const content = "# Post-Migration Tasks\n\n- Resume conversation with agent-2\n- Re-provision API keys\n";
      await writeFile(join(agentHome, "POST_MIGRATION.md"), content);

      const result = await readPostMigrationTasks(agentHome);
      expect(result).toBe(content);
    });

    it("returns null for nonexistent directory", async () => {
      const result = await readPostMigrationTasks("/nonexistent/path");
      expect(result).toBeNull();
    });
  });

  describe("clearPostMigrationTasks", () => {
    it("deletes POST_MIGRATION.md when it exists", async () => {
      await writeFile(join(agentHome, "POST_MIGRATION.md"), "# Tasks");

      await clearPostMigrationTasks(agentHome);

      const exists = await hasPostMigrationTasks(agentHome);
      expect(exists).toBe(false);
    });

    it("does not throw when POST_MIGRATION.md does not exist", async () => {
      // Should not throw
      await clearPostMigrationTasks(agentHome);
    });

    it("does not throw for nonexistent directory", async () => {
      await clearPostMigrationTasks("/nonexistent/path");
    });
  });

  describe("full lifecycle", () => {
    it("has → read → clear lifecycle works end-to-end", async () => {
      // Initially no tasks
      expect(await hasPostMigrationTasks(agentHome)).toBe(false);
      expect(await readPostMigrationTasks(agentHome)).toBeNull();

      // Agent writes POST_MIGRATION.md
      const content = "# Resume Tasks\n- Contact agent-2 about project X\n- Install dependencies\n";
      await writeFile(join(agentHome, "POST_MIGRATION.md"), content);

      // Framework detects it
      expect(await hasPostMigrationTasks(agentHome)).toBe(true);

      // Framework reads it
      const read = await readPostMigrationTasks(agentHome);
      expect(read).toBe(content);

      // Agent processes tasks, framework clears
      await clearPostMigrationTasks(agentHome);

      // Verify cleaned up
      expect(await hasPostMigrationTasks(agentHome)).toBe(false);
      expect(await readPostMigrationTasks(agentHome)).toBeNull();
    });
  });
});
