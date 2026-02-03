import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadSysadminProtocol,
  getSysadminPrompt,
  deploySysadminProtocol,
  PROTOCOL_VERSION,
} from "../../src/sysadmin/loader.js";

describe("sysadmin/loader", () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flock-sysadmin-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  describe("loadSysadminProtocol()", () => {
    it("loads all 3 documents", () => {
      const protocol = loadSysadminProtocol();

      expect(protocol.version).toBe(PROTOCOL_VERSION);
      expect(protocol.triageProtocol).toBeTruthy();
      expect(typeof protocol.triageProtocol).toBe("string");
      expect(protocol.agentKnowledge).toBeTruthy();
      expect(typeof protocol.agentKnowledge).toBe("string");
      expect(protocol.metaGovernance).toBeTruthy();
      expect(typeof protocol.metaGovernance).toBe("string");
    });

    it("returns non-empty content for each document", () => {
      const protocol = loadSysadminProtocol();
      expect(protocol.triageProtocol.length).toBeGreaterThan(10);
      expect(protocol.agentKnowledge.length).toBeGreaterThan(10);
      expect(protocol.metaGovernance.length).toBeGreaterThan(10);
    });
  });

  describe("getSysadminPrompt()", () => {
    it("returns combined prompt with version", () => {
      const prompt = getSysadminPrompt();

      expect(prompt).toContain(PROTOCOL_VERSION);
      expect(prompt).toContain("Sysadmin Protocol");

      // Should contain content from all 3 documents
      const protocol = loadSysadminProtocol();
      expect(prompt).toContain(protocol.triageProtocol);
      expect(prompt).toContain(protocol.agentKnowledge);
      expect(prompt).toContain(protocol.metaGovernance);
    });

    it("separates sections with dividers", () => {
      const prompt = getSysadminPrompt();
      expect(prompt).toContain("---");
    });
  });

  describe("deploySysadminProtocol()", () => {
    it("writes files to target dir", () => {
      const targetDir = path.join(makeTmpDir(), "sysadmin");
      deploySysadminProtocol(targetDir);

      expect(fs.existsSync(path.join(targetDir, "VERSION"))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, "triage-protocol.md"))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, "agent-knowledge.md"))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, "meta-governance.md"))).toBe(true);
    });

    it("writes correct version", () => {
      const targetDir = path.join(makeTmpDir(), "sysadmin");
      deploySysadminProtocol(targetDir);

      const version = fs.readFileSync(path.join(targetDir, "VERSION"), "utf-8");
      expect(version).toBe(PROTOCOL_VERSION);
    });

    it("creates target directory if it does not exist", () => {
      const targetDir = path.join(makeTmpDir(), "deep", "nested", "sysadmin");
      expect(fs.existsSync(targetDir)).toBe(false);

      deploySysadminProtocol(targetDir);
      expect(fs.existsSync(targetDir)).toBe(true);
    });

    it("deployed content matches loaded protocol", () => {
      const targetDir = path.join(makeTmpDir(), "sysadmin");
      deploySysadminProtocol(targetDir);

      const protocol = loadSysadminProtocol();
      const triageContent = fs.readFileSync(path.join(targetDir, "triage-protocol.md"), "utf-8");
      expect(triageContent).toBe(protocol.triageProtocol);
    });
  });
});
