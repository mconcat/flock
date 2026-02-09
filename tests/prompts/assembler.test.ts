import { describe, it, expect } from "vitest";
import {
  assembleAgentsMd,
  loadSoulTemplate,
  loadTemplate,
  listAvailableArchetypes,
} from "../../src/prompts/assembler.js";

describe("assembleAgentsMd", () => {
  it("returns content containing base protocol markers", () => {
    const content = assembleAgentsMd("worker");
    // From agents/base.md
    expect(content).toContain("AGENTS.md");
    expect(content).toContain("Flock Agent Operating Protocol");
  });

  it("sysadmin role includes sysadmin-specific content", () => {
    const content = assembleAgentsMd("sysadmin");
    // Must contain base
    expect(content).toContain("Flock Agent Operating Protocol");
    // Must contain sysadmin role content
    expect(content).toContain("Your Role: Sysadmin");
    expect(content).toContain("Triage");
  });

  it("worker role includes worker-specific content", () => {
    const content = assembleAgentsMd("worker");
    // Must contain base
    expect(content).toContain("Flock Agent Operating Protocol");
    // Must contain worker role content
    expect(content).toContain("Your Role: Worker");
    expect(content).toContain("Task Execution");
  });

  it("orchestrator role includes orchestrator-specific content", () => {
    const content = assembleAgentsMd("orchestrator");
    // Must contain base
    expect(content).toContain("Flock Agent Operating Protocol");
    // Must contain orchestrator role content
    expect(content).toContain("Your Role: Orchestrator");
    expect(content).toContain("Core Responsibilities");
  });

  it("system role returns only base content (no role-specific file)", () => {
    const content = assembleAgentsMd("system");
    // Must contain base
    expect(content).toContain("Flock Agent Operating Protocol");
    // Must NOT contain role-specific content
    expect(content).not.toContain("Your Role: Sysadmin");
    expect(content).not.toContain("Your Role: Worker");
    expect(content).not.toContain("Your Role: Orchestrator");
  });

  it("base content appears before role content", () => {
    const content = assembleAgentsMd("worker");
    const baseIdx = content.indexOf("Flock Agent Operating Protocol");
    const roleIdx = content.indexOf("Your Role: Worker");
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(baseIdx).toBeLessThan(roleIdx);
  });
});

describe("loadSoulTemplate", () => {
  it("returns content for code-first-developer archetype", () => {
    const content = loadSoulTemplate("code-first-developer");
    expect(content).not.toBeNull();
    expect(content).toContain("Code-First Developer");
  });

  it("returns content for production-first-developer archetype", () => {
    const content = loadSoulTemplate("production-first-developer");
    expect(content).not.toBeNull();
    expect(content).toContain("Production-First Developer");
  });

  it("returns content for code-reviewer archetype", () => {
    const content = loadSoulTemplate("code-reviewer");
    expect(content).not.toBeNull();
    expect(content).toContain("Code Reviewer");
  });

  it("returns content for qa archetype", () => {
    const content = loadSoulTemplate("qa");
    expect(content).not.toBeNull();
    expect(content).toContain("Quality Assurance");
  });

  it("returns null for a non-existing archetype", () => {
    const content = loadSoulTemplate("nonexistent-archetype-xyz");
    expect(content).toBeNull();
  });
});

describe("loadTemplate", () => {
  it("loads IDENTITY template", () => {
    const content = loadTemplate("IDENTITY");
    expect(content).not.toBeNull();
    expect(content).toContain("Agent ID");
  });

  it("loads MEMORY template", () => {
    const content = loadTemplate("MEMORY");
    expect(content).not.toBeNull();
    expect(content).toContain("MEMORY.md");
  });

  it("loads HEARTBEAT template", () => {
    const content = loadTemplate("HEARTBEAT");
    expect(content).not.toBeNull();
    expect(content).toContain("HEARTBEAT.md");
  });

  it("loads USER template", () => {
    const content = loadTemplate("USER");
    expect(content).not.toBeNull();
    expect(content).toContain("USER.md");
  });

  it("loads TOOLS template", () => {
    const content = loadTemplate("TOOLS");
    expect(content).not.toBeNull();
    expect(content).toContain("TOOLS.md");
  });

  it("returns null for non-existing template", () => {
    const content = loadTemplate("NONEXISTENT");
    expect(content).toBeNull();
  });
});

describe("listAvailableArchetypes", () => {
  it("returns a sorted list of archetype names", () => {
    const archetypes = listAvailableArchetypes();
    expect(archetypes).toBeInstanceOf(Array);
    expect(archetypes.length).toBeGreaterThan(0);
    // Known archetypes from the soul/ directory
    expect(archetypes).toContain("code-first-developer");
    expect(archetypes).toContain("production-first-developer");
    expect(archetypes).toContain("code-reviewer");
    expect(archetypes).toContain("qa");
    expect(archetypes).toContain("deep-researcher");
    expect(archetypes).toContain("ideation");
    expect(archetypes).toContain("product-developer");
    expect(archetypes).toContain("project-manager");
    expect(archetypes).toContain("security-adviser");
    // Should not include .md extensions
    for (const name of archetypes) {
      expect(name).not.toContain(".md");
    }
  });

  it("returns archetypes in sorted order", () => {
    const archetypes = listAvailableArchetypes();
    const sorted = [...archetypes].sort();
    expect(archetypes).toEqual(sorted);
  });
});
