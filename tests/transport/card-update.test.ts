import { describe, it, expect, beforeEach } from "vitest";
import { mergeCardUpdate, skillsFromArchetype } from "../../src/transport/card-update.js";
import type { CardUpdateParams } from "../../src/transport/card-update.js";
import {
  createAgentCard,
  buildFlockMetadata,
  createWorkerCard,
  CardRegistry,
} from "../../src/transport/agent-card.js";
import type { CreateCardParams } from "../../src/transport/agent-card.js";
import type { AgentCard, AgentSkill } from "@a2a-js/sdk";

// --- Fixtures ---

const baseParams: CreateCardParams = {
  agentId: "test-agent",
  nodeId: "node-1",
  role: "worker",
  endpointUrl: "http://localhost:3000/flock/a2a/test-agent",
  skills: [
    { id: "coding", name: "Coding", description: "Writes code", tags: ["dev"] },
  ],
};

function makeCard(): AgentCard {
  return createAgentCard(baseParams);
}

const SAMPLE_QA_ARCHETYPE = `# Archetype Template — QA

> **Archetype**: Quality Assurance

## Starting Focus

You approach work through the lens of quality. Your instinct is to ask: "What could go wrong?"

## Initial Dispositions

- **Edge case awareness**: You naturally think about boundary conditions.
- **Skeptical by default**: When someone says "it works," you think "under what conditions?"

## Starting Knowledge

- Testing strategies: unit, integration, end-to-end, regression, smoke, exploratory.
- Bug reporting: clear reproduction steps, expected vs. actual behavior, severity/priority assessment.
- Quality metrics: coverage, defect density, escape rate — what they measure and what they don't.
- Test design: equivalence partitioning, boundary value analysis, decision tables, state transitions.

## Growth Directions

- **Performance testing** — load, stress, endurance, scalability.
`;

// --- mergeCardUpdate ---

describe("mergeCardUpdate", () => {
  it("preserves all fields when updates are empty", () => {
    const card = makeCard();
    const updated = mergeCardUpdate(card, {});

    expect(updated.name).toBe(card.name);
    expect(updated.description).toBe(card.description);
    expect(updated.url).toBe(card.url);
    expect(updated.version).toBe(card.version);
    expect(updated.skills).toEqual(card.skills);
    expect(updated.capabilities).toEqual(card.capabilities);
    expect(updated.provider).toEqual(card.provider);
  });

  it("does not mutate the original card", () => {
    const card = makeCard();
    const originalName = card.name;
    mergeCardUpdate(card, { name: "New Name" });
    expect(card.name).toBe(originalName);
  });

  it("applies name change", () => {
    const card = makeCard();
    const updated = mergeCardUpdate(card, { name: "Specialized Agent" });

    expect(updated.name).toBe("Specialized Agent");
    expect(updated.description).toBe(card.description);
    expect(updated.skills).toEqual(card.skills);
  });

  it("applies description change", () => {
    const card = makeCard();
    const updated = mergeCardUpdate(card, { description: "Now with extra powers" });

    expect(updated.description).toBe("Now with extra powers");
    expect(updated.name).toBe(card.name);
  });

  it("applies name and description together", () => {
    const card = makeCard();
    const updated = mergeCardUpdate(card, {
      name: "QA Expert",
      description: "Specialized in edge cases",
    });

    expect(updated.name).toBe("QA Expert");
    expect(updated.description).toBe("Specialized in edge cases");
    expect(updated.url).toBe(card.url);
  });

  it("replaces skills entirely when provided", () => {
    const card = makeCard();
    const newSkills: AgentSkill[] = [
      { id: "testing", name: "Testing", description: "Runs tests", tags: ["qa"] },
      { id: "review", name: "Code Review", description: "Reviews code", tags: ["qa"] },
    ];
    const updated = mergeCardUpdate(card, { skills: newSkills });

    expect(updated.skills).toHaveLength(2);
    expect(updated.skills![0].id).toBe("testing");
    expect(updated.skills![1].id).toBe("review");
    // Original skills gone
    expect(updated.skills!.find((s) => s.id === "coding")).toBeUndefined();
  });

  it("allows setting skills to empty array", () => {
    const card = makeCard();
    const updated = mergeCardUpdate(card, { skills: [] });
    expect(updated.skills).toEqual([]);
  });
});

// --- skillsFromArchetype ---

describe("skillsFromArchetype", () => {
  it("extracts focus skill from Starting Focus section", () => {
    const skills = skillsFromArchetype("QA", SAMPLE_QA_ARCHETYPE);
    const focus = skills.find((s) => s.id === "qa-focus");

    expect(focus).toBeDefined();
    expect(focus!.name).toBe("QA Focus");
    expect(focus!.description).toContain("quality");
    expect(focus!.tags).toContain("qa");
    expect(focus!.tags).toContain("focus");
  });

  it("extracts knowledge skills from Starting Knowledge section", () => {
    const skills = skillsFromArchetype("QA", SAMPLE_QA_ARCHETYPE);
    const knowledgeSkills = skills.filter((s) => s.tags?.includes("knowledge"));

    expect(knowledgeSkills.length).toBe(4);
    // Check that known items are present
    const names = knowledgeSkills.map((s) => s.name);
    expect(names).toContain("Testing strategies");
    expect(names).toContain("Bug reporting");
    expect(names).toContain("Quality metrics");
    expect(names).toContain("Test design");
  });

  it("uses archetype name as tag prefix", () => {
    const skills = skillsFromArchetype("QA", SAMPLE_QA_ARCHETYPE);
    for (const skill of skills) {
      expect(skill.tags).toContain("qa");
      expect(skill.id).toMatch(/^qa-/);
    }
  });

  it("handles multi-word archetype names", () => {
    const skills = skillsFromArchetype("Deep Researcher", SAMPLE_QA_ARCHETYPE);
    for (const skill of skills) {
      expect(skill.id).toMatch(/^deep-researcher-/);
      expect(skill.tags).toContain("deep-researcher");
    }
  });

  it("returns empty array for content with no matching sections", () => {
    const skills = skillsFromArchetype("QA", "# No relevant sections here\n\nJust text.");
    expect(skills).toEqual([]);
  });

  it("includes descriptions for knowledge skills", () => {
    const skills = skillsFromArchetype("QA", SAMPLE_QA_ARCHETYPE);
    const testing = skills.find((s) => s.name === "Testing strategies");

    expect(testing).toBeDefined();
    expect(testing!.description).toContain("unit");
    expect(testing!.description).toContain("integration");
  });
});

// --- CardRegistry.updateCard ---

describe("CardRegistry.updateCard", () => {
  let registry: CardRegistry;

  beforeEach(() => {
    registry = new CardRegistry();
    const card = createAgentCard(baseParams);
    const meta = buildFlockMetadata(baseParams);
    registry.register("test-agent", card, meta);
  });

  it("updates an existing agent's card", () => {
    const ok = registry.updateCard("test-agent", { name: "Updated Agent" });
    expect(ok).toBe(true);

    const card = registry.get("test-agent");
    expect(card).not.toBeNull();
    expect(card!.name).toBe("Updated Agent");
  });

  it("returns false for unknown agent", () => {
    const ok = registry.updateCard("nonexistent", { name: "Nope" });
    expect(ok).toBe(false);
  });

  it("preserves metadata after update", () => {
    registry.updateCard("test-agent", { description: "New desc" });
    const meta = registry.getMeta("test-agent");
    expect(meta).not.toBeNull();
    expect(meta!.role).toBe("worker");
    expect(meta!.homeId).toBe("test-agent@node-1");
  });

  it("replaces skills via updateCard", () => {
    const newSkills: AgentSkill[] = [
      { id: "qa-testing", name: "QA Testing", description: "Tests things", tags: ["qa"] },
    ];
    registry.updateCard("test-agent", { skills: newSkills });

    const card = registry.get("test-agent");
    expect(card!.skills).toHaveLength(1);
    expect(card!.skills![0].id).toBe("qa-testing");
  });

  it("card is discoverable by new skill tag after update", () => {
    registry.updateCard("test-agent", {
      skills: [{ id: "security", name: "Security", description: "Sec", tags: ["security"] }],
    });

    const found = registry.findBySkill("security");
    expect(found).toHaveLength(1);
    expect(found[0].agentId).toBe("test-agent");

    // Old tag no longer matches
    const oldFound = registry.findBySkill("dev");
    expect(oldFound).toHaveLength(0);
  });
});

// --- createWorkerCard with archetype ---

describe("createWorkerCard with archetype", () => {
  it("generates skills from archetype when no explicit skills given", () => {
    const { card, meta } = createWorkerCard(
      "qa-agent",
      "node-1",
      "http://localhost:3000",
      [],
      "QA",
      SAMPLE_QA_ARCHETYPE,
    );

    expect(card.skills!.length).toBeGreaterThan(0);
    expect(card.skills!.some((s) => s.tags?.includes("qa"))).toBe(true);
    expect(card.description).toContain("QA");
    expect(meta.role).toBe("worker");
  });

  it("prefers explicit skills over archetype skills", () => {
    const explicit: AgentSkill[] = [
      { id: "custom", name: "Custom Skill", description: "My skill", tags: ["custom"] },
    ];
    const { card } = createWorkerCard(
      "qa-agent",
      "node-1",
      "http://localhost:3000",
      explicit,
      "QA",
      SAMPLE_QA_ARCHETYPE,
    );

    expect(card.skills).toHaveLength(1);
    expect(card.skills![0].id).toBe("custom");
  });

  it("works without archetype (backward compatible)", () => {
    const { card } = createWorkerCard("worker-1", "node-1", "http://localhost:3000");
    expect(card.skills).toEqual([]);
    expect(card.description).toContain("worker");
  });
});
