import { describe, it, expect, beforeEach } from "vitest";
import {
  createAgentCard,
  createSysadminCard,
  createWorkerCard,
  buildFlockMetadata,
  CardRegistry,
} from "../../src/transport/agent-card.js";
import type { CreateCardParams } from "../../src/transport/agent-card.js";
import type { AgentSkill } from "@a2a-js/sdk";

describe("agent-card", () => {
  const baseParams: CreateCardParams = {
    agentId: "test-agent",
    nodeId: "node-1",
    role: "worker",
    endpointUrl: "http://localhost:3000/flock/a2a/test-agent",
  };

  describe("createAgentCard()", () => {
    it("returns valid AgentCard with all required fields", () => {
      const card = createAgentCard(baseParams);

      expect(card.name).toBe("test-agent");
      expect(card.description).toContain("worker");
      expect(card.url).toBe("http://localhost:3000/flock/a2a/test-agent");
      expect(card.version).toBeTruthy();
      expect(card.protocolVersion).toBeTruthy();
      expect(card.defaultInputModes).toContain("text/plain");
      expect(card.defaultOutputModes).toContain("text/plain");
      expect(card.capabilities).toBeDefined();
      expect(card.skills).toBeDefined();
      expect(card.provider).toBeDefined();
      expect(card.provider?.organization).toBe("flock");
    });

    it("uses custom name and description when provided", () => {
      const card = createAgentCard({
        ...baseParams,
        name: "My Agent",
        description: "A custom description",
      });
      expect(card.name).toBe("My Agent");
      expect(card.description).toBe("A custom description");
    });

    it("includes custom skills for worker role", () => {
      const customSkill: AgentSkill = {
        id: "coding",
        name: "Code Generation",
        description: "Writes code",
        tags: ["coding", "dev"],
      };
      const card = createAgentCard({ ...baseParams, skills: [customSkill] });
      expect(card.skills).toHaveLength(1);
      expect(card.skills![0].id).toBe("coding");
    });

    it("prepends triage skill for sysadmin role", () => {
      const card = createAgentCard({ ...baseParams, role: "sysadmin" });
      expect(card.skills!.length).toBeGreaterThanOrEqual(1);
      expect(card.skills![0].id).toBe("sysadmin-triage");
    });
  });

  describe("createSysadminCard()", () => {
    it("includes triage and health skills", () => {
      const { card, meta } = createSysadminCard("node-1", "http://localhost:3000");
      const skillIds = card.skills!.map((s) => s.id);
      expect(skillIds).toContain("sysadmin-triage");
      expect(skillIds).toContain("sysadmin-health");
      expect(meta.role).toBe("sysadmin");
    });

    it("includes correct metadata", () => {
      const { meta } = createSysadminCard("node-1", "http://localhost:3000");
      expect(meta.nodeId).toBe("node-1");
      expect(meta.homeId).toBe("sysadmin@node-1");
    });
  });

  describe("createWorkerCard()", () => {
    it("creates worker card with custom skills", () => {
      const skills: AgentSkill[] = [
        { id: "research", name: "Research", description: "Does research", tags: ["research"] },
      ];
      const { card, meta } = createWorkerCard("worker-1", "node-1", "http://localhost:3000", skills);
      expect(card.skills).toHaveLength(1);
      expect(card.skills![0].id).toBe("research");
      expect(meta.role).toBe("worker");
      expect(meta.homeId).toBe("worker-1@node-1");
    });

    it("works with no skills", () => {
      const { card } = createWorkerCard("worker-2", "node-1", "http://localhost:3000");
      expect(card.skills).toEqual([]);
    });
  });

  describe("buildFlockMetadata()", () => {
    it("returns correct metadata", () => {
      const meta = buildFlockMetadata(baseParams);
      expect(meta.role).toBe("worker");
      expect(meta.nodeId).toBe("node-1");
      expect(meta.homeId).toBe("test-agent@node-1");
    });
  });

  describe("CardRegistry", () => {
    let registry: CardRegistry;

    beforeEach(() => {
      registry = new CardRegistry();
    });

    it("register and get", () => {
      const card = createAgentCard(baseParams);
      const meta = buildFlockMetadata(baseParams);
      registry.register("test-agent", card, meta);

      const retrieved = registry.get("test-agent");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("test-agent");
    });

    it("get returns null for unknown agent", () => {
      expect(registry.get("nonexistent")).toBeNull();
    });

    it("getMeta returns metadata", () => {
      const card = createAgentCard(baseParams);
      const meta = buildFlockMetadata(baseParams);
      registry.register("test-agent", card, meta);

      const retrieved = registry.getMeta("test-agent");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.role).toBe("worker");
      expect(retrieved!.homeId).toBe("test-agent@node-1");
    });

    it("getMeta returns null for unknown agent", () => {
      expect(registry.getMeta("nonexistent")).toBeNull();
    });

    it("list returns all entries", () => {
      const card1 = createAgentCard(baseParams);
      const meta1 = buildFlockMetadata(baseParams);
      const params2: CreateCardParams = { ...baseParams, agentId: "agent-2" };
      const card2 = createAgentCard(params2);
      const meta2 = buildFlockMetadata(params2);

      registry.register("test-agent", card1, meta1);
      registry.register("agent-2", card2, meta2);

      const all = registry.list();
      expect(all).toHaveLength(2);
    });

    it("remove deletes an agent", () => {
      const card = createAgentCard(baseParams);
      const meta = buildFlockMetadata(baseParams);
      registry.register("test-agent", card, meta);

      expect(registry.has("test-agent")).toBe(true);
      const removed = registry.remove("test-agent");
      expect(removed).toBe(true);
      expect(registry.has("test-agent")).toBe(false);
      expect(registry.get("test-agent")).toBeNull();
    });

    it("remove returns false for unknown agent", () => {
      expect(registry.remove("nonexistent")).toBe(false);
    });

    it("has returns correct boolean", () => {
      expect(registry.has("test-agent")).toBe(false);
      const card = createAgentCard(baseParams);
      const meta = buildFlockMetadata(baseParams);
      registry.register("test-agent", card, meta);
      expect(registry.has("test-agent")).toBe(true);
    });

    it("findBySkill finds agents with matching skill tag", () => {
      const sysParams: CreateCardParams = {
        ...baseParams,
        agentId: "sysadmin-1",
        role: "sysadmin",
      };
      const card = createAgentCard(sysParams);
      const meta = buildFlockMetadata(sysParams);
      registry.register("sysadmin-1", card, meta);

      const workerCard = createAgentCard(baseParams);
      const workerMeta = buildFlockMetadata(baseParams);
      registry.register("test-agent", workerCard, workerMeta);

      const found = registry.findBySkill("sysadmin");
      expect(found.length).toBeGreaterThanOrEqual(1);
      expect(found[0].agentId).toBe("sysadmin-1");
    });

    it("findBySkill returns empty for unknown tag", () => {
      const card = createAgentCard(baseParams);
      const meta = buildFlockMetadata(baseParams);
      registry.register("test-agent", card, meta);

      expect(registry.findBySkill("nonexistent-tag")).toHaveLength(0);
    });

    it("findByRole finds agents by Flock role", () => {
      const sysParams: CreateCardParams = {
        ...baseParams,
        agentId: "sys-1",
        role: "sysadmin",
      };
      registry.register("sys-1", createAgentCard(sysParams), buildFlockMetadata(sysParams));
      registry.register("test-agent", createAgentCard(baseParams), buildFlockMetadata(baseParams));

      const sysadmins = registry.findByRole("sysadmin");
      expect(sysadmins).toHaveLength(1);
      expect(sysadmins[0].meta.role).toBe("sysadmin");

      const workers = registry.findByRole("worker");
      expect(workers).toHaveLength(1);
      expect(workers[0].meta.role).toBe("worker");
    });
  });
});
