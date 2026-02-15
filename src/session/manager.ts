/**
 * Session Manager — manages per-agent pi-agent-core Agent instances.
 *
 * In standalone mode, Flock manages its own LLM sessions instead of
 * delegating to OpenClaw's gateway. Each agent gets an Agent instance
 * with its own message history, tools, and model config.
 *
 * This replaces:
 *   - OpenClaw's session management (per-agent message history)
 *   - gateway-send.ts (HTTP relay to OpenClaw's /v1/chat/completions)
 *   - OpenClaw's system prompt resolution (workspace files)
 */

import { Agent, type AgentOptions } from "@mariozechner/pi-agent-core";
import {
  getModel,
  getProviders,
  getModels,
  type Model,
  type Message,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type KnownProvider,
} from "@mariozechner/pi-ai";
import type { AgentMessage, AgentTool, AgentEvent, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { PluginLogger } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSessionConfig {
  /** LLM model string, e.g. "anthropic/claude-opus-4-5". */
  model: string;
  /** System prompt assembled by Flock's prompt assembler. */
  systemPrompt: string;
  /** Tools available to this agent. */
  tools: AgentTool[];
  /** Thinking/reasoning level. Default: "off". */
  thinkingLevel?: ThinkingLevel;
  /** API key resolver. If not set, uses environment variables. */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  /** Max messages to keep in context before truncation. Default: 100. */
  maxContextMessages?: number;
}

export interface SessionSendResult {
  /** The text response from the agent. */
  text: string | null;
  /** Events emitted during the agent run. */
  events: AgentEvent[];
}

// ---------------------------------------------------------------------------
// Default message converter
// ---------------------------------------------------------------------------

/**
 * Default convertToLlm — filters AgentMessages to LLM-compatible Messages.
 * Passes through user/assistant/toolResult messages as-is.
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter((m): m is Message => {
    if (typeof m !== "object" || m === null) return false;
    const role = (m as { role?: string }).role;
    return role === "user" || role === "assistant" || role === "toolResult";
  });
}

/**
 * Default context transform — trims old messages when context grows too large.
 */
function createContextTrimmer(maxMessages: number) {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    if (messages.length <= maxMessages) return messages;
    // Keep the most recent messages, preserving system-relevant context
    return messages.slice(-maxMessages);
  };
}

// ---------------------------------------------------------------------------
// Session Manager
// ---------------------------------------------------------------------------

export class SessionManager {
  private agents = new Map<string, Agent>();
  private configs = new Map<string, AgentSessionConfig>();
  private logger: PluginLogger;

  constructor(logger: PluginLogger) {
    this.logger = logger;
  }

  /**
   * Parse a model string like "anthropic/claude-opus-4-5" into a pi-ai Model.
   */
  /**
   * Parse a model string and resolve it to a pi-ai Model.
   * Validates provider at runtime against known providers.
   */
  private resolveModel(modelStr: string): Model<string> {
    const slashIdx = modelStr.indexOf("/");
    if (slashIdx === -1) {
      throw new Error(`Invalid model format "${modelStr}" — expected "provider/model-id"`);
    }
    const provider = modelStr.slice(0, slashIdx);
    const modelId = modelStr.slice(slashIdx + 1);

    // Validate provider exists at runtime
    const knownProviders = getProviders();
    if (!knownProviders.includes(provider as KnownProvider)) {
      throw new Error(
        `Unknown provider "${provider}" — known providers: ${knownProviders.join(", ")}`,
      );
    }

    // Validate model exists for this provider
    const models = getModels(provider as KnownProvider);
    const model = models.find((m) => m.id === modelId);
    if (!model) {
      const available = models.map((m) => m.id).join(", ");
      throw new Error(
        `Unknown model "${modelId}" for provider "${provider}" — available: ${available}`,
      );
    }

    return model;
  }

  /**
   * Get or create an Agent instance for the given agent ID.
   */
  getOrCreate(agentId: string, config: AgentSessionConfig): Agent {
    const existing = this.agents.get(agentId);
    if (existing) {
      // Update config if changed (tools, system prompt, etc.)
      const prevConfig = this.configs.get(agentId);
      if (prevConfig?.systemPrompt !== config.systemPrompt) {
        existing.setSystemPrompt(config.systemPrompt);
      }
      if (prevConfig?.model !== config.model) {
        existing.setModel(this.resolveModel(config.model));
      }
      if (prevConfig?.thinkingLevel !== config.thinkingLevel) {
        existing.setThinkingLevel(config.thinkingLevel ?? "off");
      }
      // Always update tools (they may have new deps)
      existing.setTools(config.tools);
      this.configs.set(agentId, config);
      return existing;
    }

    const maxCtx = config.maxContextMessages ?? 100;

    const opts: AgentOptions = {
      initialState: {
        systemPrompt: config.systemPrompt,
        model: this.resolveModel(config.model),
        thinkingLevel: config.thinkingLevel ?? "off",
        tools: config.tools,
        messages: [],
        isStreaming: false,
        streamMessage: null,
        pendingToolCalls: new Set(),
      },
      convertToLlm: defaultConvertToLlm,
      transformContext: createContextTrimmer(maxCtx),
      getApiKey: config.getApiKey,
    };

    const agent = new Agent(opts);
    this.agents.set(agentId, agent);
    this.configs.set(agentId, config);
    this.logger.info(`[flock:session] created session for agent "${agentId}" (model: ${config.model})`);
    return agent;
  }

  /**
   * Send a message to an agent and wait for the response.
   * This is the standalone equivalent of gateway-send.
   */
  async send(agentId: string, message: string, config: AgentSessionConfig): Promise<SessionSendResult> {
    const agent = this.getOrCreate(agentId, config);
    const events: AgentEvent[] = [];

    const unsubscribe = agent.subscribe((event) => {
      events.push(event);
    });

    try {
      await agent.prompt(message);
      await agent.waitForIdle();
    } finally {
      unsubscribe();
    }

    // Extract text response from the last assistant message
    const state = agent.state;
    const lastAssistant = [...state.messages]
      .reverse()
      .find((m): m is Message & { role: "assistant" } => {
        return (m as { role?: string }).role === "assistant";
      });

    let text: string | null = null;
    if (lastAssistant) {
      const textParts = (lastAssistant.content as (TextContent | ThinkingContent | ToolCall)[])
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text);
      text = textParts.length > 0 ? textParts.join("") : null;
    }

    return { text, events };
  }

  /**
   * Check if a session exists for the given agent ID.
   */
  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Get the Agent instance for an agent, or undefined.
   */
  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get the current config for an agent, or undefined.
   */
  getConfig(agentId: string): AgentSessionConfig | undefined {
    return this.configs.get(agentId);
  }

  /**
   * Clear the message history for an agent.
   */
  clearHistory(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.clearMessages();
      this.logger.info(`[flock:session] cleared history for "${agentId}"`);
    }
  }

  /**
   * Destroy a session entirely.
   */
  destroy(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.abort();
      agent.reset();
    }
    this.agents.delete(agentId);
    this.configs.delete(agentId);
    this.logger.info(`[flock:session] destroyed session for "${agentId}"`);
  }

  /**
   * Destroy all sessions.
   */
  destroyAll(): void {
    for (const [id] of this.agents) {
      this.destroy(id);
    }
  }

  /**
   * List all active session agent IDs.
   */
  listAgents(): string[] {
    return [...this.agents.keys()];
  }
}
