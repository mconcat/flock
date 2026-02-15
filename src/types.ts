/**
 * Type definitions for Flock plugin.
 * Minimal interface to avoid tight coupling with Clawdbot internals.
 */

// --- Plugin API (subset of what Clawdbot provides) ---

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

export interface PluginApi {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  source: string;
  config: Record<string, unknown>;
  pluginConfig: Record<string, unknown>;
  logger: PluginLogger;
  registerTool(tool: ToolDefinition | ((ctx: Record<string, unknown>) => ToolDefinition | ToolDefinition[] | null | undefined), opts?: { optional?: boolean }): void;
  registerGatewayMethod(method: string, handler: GatewayHandler): void;
  registerHttpRoute(params: { path: string; handler: HttpHandler }): void;
}

/**
 * OpenClaw-compatible tool definition.
 *
 * execute() signature matches OpenClaw's pi-coding-agent ToolDefinition:
 *   execute(toolCallId, params, signal?, onUpdate?)
 *
 * Return format must include `content` array for the LLM:
 *   { content: [{ type: "text", text: "..." }] }
 */
/**
 * @deprecated Use AgentTool from pi-agent-core instead.
 * Kept for backward compatibility with plugin mode (register(api)).
 */
export interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (data: unknown) => void,
  ): Promise<ToolResultOC>;
}

/**
 * OpenClaw-compatible tool result. Must have `content` array.
 *
 * @deprecated Use AgentToolResult from pi-agent-core instead.
 * Kept for backward compatibility with plugin mode (register(api)).
 * The content type is widened to accept pi-ai's TextContent | ImageContent
 * so that AgentToolResult is structurally assignable to ToolResultOC.
 */
export interface ToolResultOC {
  content: Array<{ type: "text"; text: string; textSignature?: string } | { type: "image"; data: string; mimeType: string }>;
  details?: Record<string, unknown>;
}

/** Legacy Flock tool result (used internally, converted to ToolResultOC for OpenClaw). */
export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
  data?: Record<string, unknown>;
}

/** Convert a Flock ToolResult to OpenClaw-compatible format. */
export function toOCResult(result: ToolResult): ToolResultOC {
  const text = result.ok
    ? result.output ?? JSON.stringify(result.data ?? { ok: true }, null, 2)
    : result.error ?? "Unknown error";
  return {
    content: [{ type: "text", text }],
    details: { ok: result.ok, ...(result.data ?? {}) },
  };
}

export interface ToolContext {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  config: Record<string, unknown>;
}

export type GatewayHandler = (
  params: Record<string, unknown>,
  context: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type HttpHandler = (
  req: { method: string; url: string; body?: unknown },
  res: { json(data: unknown): void; status(code: number): unknown },
) => Promise<void>;

// --- Home State Machine ---

export type HomeState =
  | "UNASSIGNED"
  | "PROVISIONING"
  | "IDLE"
  | "LEASED"
  | "ACTIVE"
  | "FROZEN"
  | "MIGRATING"
  | "ERROR"
  | "RETIRED";

export interface HomeRecord {
  homeId: string; // agent_id@node_id
  agentId: string;
  nodeId: string;
  state: HomeState;
  leaseExpiresAt: number | null; // epoch ms
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface HomeTransition {
  homeId: string;
  fromState: HomeState;
  toState: HomeState;
  reason: string;
  triggeredBy: string; // agent or system
  timestamp: number;
}

// --- Audit ---

export type AuditLevel = "GREEN" | "YELLOW" | "RED";

/** Runtime check for AuditLevel (also covers TriageResult.level). */
export function isAuditLevel(v: unknown): v is AuditLevel {
  return v === "GREEN" || v === "YELLOW" || v === "RED";
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  homeId?: string;
  agentId: string;
  action: string;
  level: AuditLevel;
  detail: string;
  result?: string;
  duration?: number;
}

// Note: Sysadmin request/receipt types are now modeled as A2A Tasks
// with FlockTaskMetadata and TriageResult in src/transport/types.ts
