/**
 * Agent Card Factory
 *
 * Creates and manages A2A Agent Cards for Flock agents.
 * Each agent (worker or sysadmin) gets a card describing its
 * capabilities, skills, and communication endpoint.
 *
 * Flock-specific metadata (role, nodeId, homeId) is stored in
 * the CardRegistry alongside the card, not embedded in the card
 * itself (the A2A SDK AgentCard type doesn't have an extension field).
 */

import type { AgentCard, AgentSkill } from "@a2a-js/sdk";
import type {
  FlockAgentRole,
  FlockCardMetadata,
  CardRegistryEntry,
} from "./types.js";
import type { CardUpdateParams } from "./card-update.js";
import { mergeCardUpdate, skillsFromArchetype } from "./card-update.js";

// --- Card creation ---

export interface CreateCardParams {
  agentId: string;
  nodeId: string;
  role: FlockAgentRole;
  name?: string;
  description?: string;
  skills?: AgentSkill[];
  endpointUrl: string;
}

/**
 * Create an A2A Agent Card for a Flock agent.
 */
export function createAgentCard(params: CreateCardParams): AgentCard {
  const {
    agentId,
    nodeId,
    role,
    name = agentId,
    description = `Flock ${role} agent: ${agentId}`,
    skills = [],
    endpointUrl,
  } = params;

  // Sysadmin always has the triage skill
  const allSkills = role === "sysadmin"
    ? [SYSADMIN_TRIAGE_SKILL, ...skills]
    : skills;

  return {
    name,
    description,
    url: endpointUrl,
    version: "0.2.0",
    protocolVersion: "0.2.6",
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    skills: allSkills,
    provider: {
      organization: "flock",
      url: endpointUrl,
    },
  };
}

/** Build FlockCardMetadata from creation params. */
export function buildFlockMetadata(params: CreateCardParams): FlockCardMetadata {
  return {
    role: params.role,
    nodeId: params.nodeId,
    homeId: `${params.agentId}@${params.nodeId}`,
  };
}

/**
 * Create an Agent Card for the sysadmin agent on a given node.
 */
export function createSysadminCard(nodeId: string, endpointUrl: string, agentId = "sysadmin"): { card: AgentCard; meta: FlockCardMetadata } {
  const params: CreateCardParams = {
    agentId,
    nodeId,
    role: "sysadmin",
    name: agentId,
    description: `Node sysadmin for ${nodeId}. Handles system requests, triage (GREEN/YELLOW/RED), and security enforcement.`,
    endpointUrl,
    skills: [SYSADMIN_HEALTH_SKILL],
  };
  return { card: createAgentCard(params), meta: buildFlockMetadata(params) };
}

/**
 * Create an Agent Card for the orchestrator agent.
 * The orchestrator manages channels, assigns agents, and monitors swarm health.
 * It does NOT have sysadmin/triage capabilities.
 */
export function createOrchestratorCard(nodeId: string, endpointUrl: string, agentId = "orchestrator"): { card: AgentCard; meta: FlockCardMetadata } {
  const params: CreateCardParams = {
    agentId,
    nodeId,
    role: "orchestrator",
    name: agentId,
    description: `Flock orchestrator for ${nodeId}. Manages channels, assigns agents to channels, monitors swarm health, and relays human operator requests.`,
    endpointUrl,
    skills: [ORCHESTRATOR_CHANNEL_SKILL, ORCHESTRATOR_LIFECYCLE_SKILL],
  };
  return { card: createAgentCard(params), meta: buildFlockMetadata(params) };
}

/**
 * Create an Agent Card for a worker agent.
 *
 * When `archetype` and `archetypeContent` are provided, initial skills
 * are extracted from the archetype template and a richer description
 * is generated.  Explicit `skills` still take precedence.
 */
export function createWorkerCard(
  agentId: string,
  nodeId: string,
  endpointUrl: string,
  skills: AgentSkill[] = [],
  archetype?: string,
  archetypeContent?: string,
): { card: AgentCard; meta: FlockCardMetadata } {
  let resolvedSkills = skills;
  let description: string | undefined;

  if (archetype && archetypeContent) {
    // Only use archetype skills when no explicit skills were provided
    if (skills.length === 0) {
      resolvedSkills = skillsFromArchetype(archetype, archetypeContent);
    }
    description = `Flock worker agent (${archetype}): ${agentId}`;
  }

  const params: CreateCardParams = {
    agentId,
    nodeId,
    role: "worker",
    skills: resolvedSkills,
    description,
    endpointUrl,
  };
  return { card: createAgentCard(params), meta: buildFlockMetadata(params) };
}

// --- Predefined skills ---

const SYSADMIN_TRIAGE_SKILL: AgentSkill = {
  id: "sysadmin-triage",
  name: "System Request Triage",
  description:
    "Evaluates system-level requests with autonomous classification: " +
    "WHITE (no triage — general questions, conversation), " +
    "GREEN (auto-execute), YELLOW (execute with review), " +
    "or RED (human approval required). " +
    "Send natural language requests describing what you need and why.",
  tags: ["sysadmin", "triage", "security", "system"],
  examples: [
    "Install Node.js 22 LTS for web development project",
    "Need to open port 3000 for local dev server",
    "Clone repo from github.com/org/project into /flock/work/",
  ],
};

const SYSADMIN_HEALTH_SKILL: AgentSkill = {
  id: "sysadmin-health",
  name: "Node Health Check",
  description: "Reports node resource status (CPU, memory, disk, GPU).",
  tags: ["sysadmin", "monitoring", "health"],
};

const ORCHESTRATOR_CHANNEL_SKILL: AgentSkill = {
  id: "orchestrator-channels",
  name: "Channel Management",
  description:
    "Creates and manages channels for projects, features, and issues. " +
    "Assigns agents to channels based on expertise and A2A Card profiles. " +
    "Archives channels when work is complete.",
  tags: ["orchestrator", "channels", "management"],
  examples: [
    "Create a channel for the logging library project with PM, dev, and reviewer",
    "Add QA to the project-logging channel",
    "Archive the completed project channel",
  ],
};

const ORCHESTRATOR_LIFECYCLE_SKILL: AgentSkill = {
  id: "orchestrator-lifecycle",
  name: "Agent Lifecycle Management",
  description:
    "Creates and decommissions agents on human operator request. " +
    "Manages agent fleet composition and monitors swarm health.",
  tags: ["orchestrator", "lifecycle", "agents"],
  examples: [
    "Create a new code reviewer agent with the reviewer archetype",
    "Decommission an idle agent that is no longer needed",
  ],
};

// --- Card Registry (in-memory for Phase 1) ---

/**
 * Stores Agent Cards + Flock metadata together.
 * Metadata is kept alongside the card since the A2A AgentCard type
 * doesn't support arbitrary extension fields.
 */
export class CardRegistry {
  private entries = new Map<string, CardRegistryEntry & { meta: FlockCardMetadata }>();

  register(agentId: string, card: AgentCard, meta: FlockCardMetadata): void {
    const now = Date.now();
    this.entries.set(agentId, {
      agentId,
      card,
      meta,
      registeredAt: now,
      lastSeen: now,
    });
  }

  get(agentId: string): AgentCard | null {
    const entry = this.entries.get(agentId);
    if (!entry) return null;
    entry.lastSeen = Date.now();
    return entry.card;
  }

  getMeta(agentId: string): FlockCardMetadata | null {
    return this.entries.get(agentId)?.meta ?? null;
  }

  getEntry(agentId: string): (CardRegistryEntry & { meta: FlockCardMetadata }) | null {
    return this.entries.get(agentId) ?? null;
  }

  list(): Array<CardRegistryEntry & { meta: FlockCardMetadata }> {
    return Array.from(this.entries.values());
  }

  remove(agentId: string): boolean {
    return this.entries.delete(agentId);
  }

  has(agentId: string): boolean {
    return this.entries.has(agentId);
  }

  /** Update an existing agent's card. Returns false if agent not found. */
  updateCard(agentId: string, updates: CardUpdateParams): boolean {
    const entry = this.entries.get(agentId);
    if (!entry) return false;
    entry.card = mergeCardUpdate(entry.card, updates);
    entry.lastSeen = Date.now();
    return true;
  }

  /** Find agents by skill tag. */
  findBySkill(tag: string): Array<CardRegistryEntry & { meta: FlockCardMetadata }> {
    return this.list().filter((entry) =>
      entry.card.skills?.some((s) => s.tags?.includes(tag)),
    );
  }

  /** Find agents by Flock role. */
  findByRole(role: FlockAgentRole): Array<CardRegistryEntry & { meta: FlockCardMetadata }> {
    return this.list().filter((entry) => entry.meta.role === role);
  }
}
