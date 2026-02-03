import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createHomeProvisioner,
  formatBindMountsForConfig,
} from "../../src/homes/provisioner.js";
import type { BindMount } from "../../src/homes/provisioner.js";
import type { FlockConfig } from "../../src/config.js";
import type { PluginLogger } from "../../src/types.js";
import {
  HOME_DIRECTORIES,
  IMMUTABLE_WORKSPACE_FILES,
  MUTABLE_WORKSPACE_FILES,
  CONTAINER_PATHS,
} from "../../src/homes/directory.js";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("HomeProvisioner", () => {
  let tmpDir: string;
  let config: FlockConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flock-provisioner-test-"));
    config = {
      dataDir: path.join(tmpDir, "data"),
      dbBackend: "memory",
      homes: {
        rootDir: path.join(tmpDir, "homes"),
        baseDir: path.join(tmpDir, "data", "base"),
      },
      sysadmin: { enabled: true, autoGreen: true },
      economy: { enabled: false, initialBalance: 1000 },
    } as FlockConfig;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("provision()", () => {
    it("creates directory tree", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      const result = provisioner.provision("agent-1", "node-1");

      expect(result.homeId).toBe("agent-1@node-1");
      expect(result.homePath).toBe(path.join(config.homes.rootDir, "agent-1"));

      // Verify all directories were created
      for (const dir of HOME_DIRECTORIES) {
        const fullPath = path.join(result.homePath, dir);
        expect(fs.existsSync(fullPath)).toBe(true);
      }
    });

    it("includes workspace directory but no sandbox directory", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      const result = provisioner.provision("agent-1", "node-1");

      expect(fs.existsSync(path.join(result.homePath, "workspace"))).toBe(true);
      expect(fs.existsSync(path.join(result.homePath, "sandbox"))).toBe(false);
    });

    it("does not create old base/ directory", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      const result = provisioner.provision("agent-1", "node-1");

      // Old /flock/base/ structure is gone
      expect(fs.existsSync(path.join(result.homePath, "base"))).toBe(false);
    });

    it("deploys immutable workspace files (AGENTS.md, USER.md) and mutable TOOLS.md", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      const result = provisioner.provision("agent-1", "node-1");

      const workspacePath = path.join(result.homePath, "workspace");

      // AGENTS.md must exist and contain base protocol content
      const agentsMd = fs.readFileSync(path.join(workspacePath, "AGENTS.md"), "utf-8");
      expect(agentsMd).toContain("Flock Agent Operating Protocol");

      // USER.md and TOOLS.md should exist
      expect(fs.existsSync(path.join(workspacePath, "USER.md"))).toBe(true);
      expect(fs.existsSync(path.join(workspacePath, "TOOLS.md"))).toBe(true);

      expect(result.workspaceFiles).toContain("AGENTS.md");
      expect(result.workspaceFiles).toContain("USER.md");
      expect(result.workspaceFiles).toContain("TOOLS.md");

      // Immutable files: only AGENTS.md and USER.md (TOOLS.md is mutable — agents add local notes)
      expect(result.immutableFiles).toContain("AGENTS.md");
      expect(result.immutableFiles).toContain("USER.md");
      expect(result.immutableFiles).not.toContain("TOOLS.md");
    });

    it("AGENTS.md includes worker role content by default", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      const result = provisioner.provision("agent-1", "node-1");

      const agentsMd = fs.readFileSync(
        path.join(result.homePath, "workspace", "AGENTS.md"),
        "utf-8",
      );
      // Default role is "worker"
      expect(agentsMd).toContain("Your Role: Worker");
    });

    it("AGENTS.md includes sysadmin role when specified", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      const result = provisioner.provision("agent-1", "node-1", { role: "sysadmin" });

      const agentsMd = fs.readFileSync(
        path.join(result.homePath, "workspace", "AGENTS.md"),
        "utf-8",
      );
      expect(agentsMd).toContain("Your Role: Sysadmin");
      expect(agentsMd).toContain("Triage");
    });

    it("deploys mutable seed files to workspace", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      const result = provisioner.provision("agent-1", "node-1");

      const workspacePath = path.join(result.homePath, "workspace");
      expect(fs.existsSync(path.join(workspacePath, "SOUL.md"))).toBe(true);
      expect(fs.existsSync(path.join(workspacePath, "IDENTITY.md"))).toBe(true);
      expect(fs.existsSync(path.join(workspacePath, "MEMORY.md"))).toBe(true);
      expect(fs.existsSync(path.join(workspacePath, "HEARTBEAT.md"))).toBe(true);

      // Mutable files should be in workspaceFiles but NOT in immutableFiles
      expect(result.workspaceFiles).toContain("SOUL.md");
      expect(result.workspaceFiles).toContain("IDENTITY.md");
      expect(result.workspaceFiles).toContain("MEMORY.md");
      expect(result.workspaceFiles).toContain("HEARTBEAT.md");

      expect(result.immutableFiles).not.toContain("SOUL.md");
      expect(result.immutableFiles).not.toContain("IDENTITY.md");
      expect(result.immutableFiles).not.toContain("MEMORY.md");
      expect(result.immutableFiles).not.toContain("HEARTBEAT.md");
    });

    it("uses archetype for SOUL.md when specified", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      const result = provisioner.provision("agent-1", "node-1", {
        archetype: "code-first-developer",
      });

      const soulMd = fs.readFileSync(
        path.join(result.homePath, "workspace", "SOUL.md"),
        "utf-8",
      );
      expect(soulMd).toContain("Code-First Developer");
    });

    it("does not create symlinks in workspace", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      const result = provisioner.provision("agent-1", "node-1");

      const workspacePath = path.join(result.homePath, "workspace");
      // All files should be regular files, no symlinks
      for (const file of [...IMMUTABLE_WORKSPACE_FILES, ...MUTABLE_WORKSPACE_FILES]) {
        const filePath = path.join(workspacePath, file);
        if (fs.existsSync(filePath)) {
          const stat = fs.lstatSync(filePath);
          expect(stat.isSymbolicLink()).toBe(false);
        }
      }
    });

    it("returns bind mounts with workspace rw + individual immutable file ro mounts", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      const result = provisioner.provision("agent-1", "node-1");

      expect(result.bindMounts.length).toBeGreaterThan(0);

      // Workspace directory should be the FIRST mount and read-write
      const workspaceMount = result.bindMounts[0];
      expect(workspaceMount.containerPath).toBe(CONTAINER_PATHS.openclawWorkspace);
      expect(workspaceMount.readOnly).toBe(false);

      // Individual immutable file mounts should follow — each read-only
      for (const file of IMMUTABLE_WORKSPACE_FILES) {
        const fileMount = result.bindMounts.find(
          (m) => m.containerPath === `${CONTAINER_PATHS.openclawWorkspace}/${file}`,
        );
        expect(fileMount).toBeDefined();
        expect(fileMount!.readOnly).toBe(true);
        expect(fileMount!.hostPath).toBe(
          path.join(result.homePath, "workspace", file),
        );
      }

      // No sandbox mount should exist
      const sandboxMount = result.bindMounts.find(
        (m) => m.containerPath === "/workspace",
      );
      expect(sandboxMount).toBeUndefined();

      // work should still be read-write
      const workMount = result.bindMounts.find(
        (m) => m.containerPath === CONTAINER_PATHS.work,
      );
      expect(workMount).toBeDefined();
      expect(workMount!.readOnly).toBe(false);
    });

    it("immutable file mounts come after workspace directory mount", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      const result = provisioner.provision("agent-1", "node-1");

      // Find the workspace directory mount index
      const workspaceDirIndex = result.bindMounts.findIndex(
        (m) => m.containerPath === CONTAINER_PATHS.openclawWorkspace,
      );
      expect(workspaceDirIndex).toBe(0);

      // All immutable file mounts should come after the directory mount
      for (const file of IMMUTABLE_WORKSPACE_FILES) {
        const fileIndex = result.bindMounts.findIndex(
          (m) => m.containerPath === `${CONTAINER_PATHS.openclawWorkspace}/${file}`,
        );
        expect(fileIndex).toBeGreaterThan(workspaceDirIndex);
      }
    });
  });

  describe("exists()", () => {
    it("returns false when home does not exist", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      expect(provisioner.exists("nonexistent", "node-1")).toBe(false);
    });

    it("returns true after provisioning", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      provisioner.provision("agent-1", "node-1");
      expect(provisioner.exists("agent-1", "node-1")).toBe(true);
    });
  });

  describe("homePath()", () => {
    it("returns path under rootDir", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      const p = provisioner.homePath("agent-1", "node-1");
      expect(p).toBe(path.join(config.homes.rootDir, "agent-1"));
    });
  });

  describe("cleanRuntime()", () => {
    it("removes run/ contents but keeps directory", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      provisioner.provision("agent-1", "node-1");

      // Create some runtime files
      const runDir = path.join(config.homes.rootDir, "agent-1", "run");
      fs.writeFileSync(path.join(runDir, "pid"), "12345");
      fs.writeFileSync(path.join(runDir, "socket"), "test");
      expect(fs.readdirSync(runDir).length).toBe(2);

      provisioner.cleanRuntime("agent-1", "node-1");

      expect(fs.existsSync(runDir)).toBe(true);
      expect(fs.readdirSync(runDir)).toHaveLength(0);
    });
  });

  describe("formatBindMountsForConfig()", () => {
    it("returns correct docker bind mount strings", () => {
      const mounts: BindMount[] = [
        { hostPath: "/host/workspace", containerPath: "~/.openclaw/workspace", readOnly: false },
        { hostPath: "/host/workspace/AGENTS.md", containerPath: "~/.openclaw/workspace/AGENTS.md", readOnly: true },
      ];

      const formatted = formatBindMountsForConfig(mounts);
      expect(formatted).toEqual([
        "/host/workspace:~/.openclaw/workspace:rw",
        "/host/workspace/AGENTS.md:~/.openclaw/workspace/AGENTS.md:ro",
      ]);
    });

    it("handles empty array", () => {
      expect(formatBindMountsForConfig([])).toEqual([]);
    });
  });

  describe("input validation", () => {
    it("rejects invalid agentId", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      expect(() => provisioner.provision("../evil", "node-1")).toThrow(/invalid/);
    });

    it("rejects invalid nodeId", () => {
      const provisioner = createHomeProvisioner({ config, logger: makeLogger() });
      expect(() => provisioner.provision("agent-1", "no de")).toThrow(/invalid/);
    });
  });
});
