/**
 * API Key Resolver — provides `getApiKey(provider)` callback for pi-agent-core Agent.
 *
 * Resolution order:
 *   1. OAuth credentials from ~/.flock/auth.json (auto-refreshes expired tokens)
 *   2. Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
 *
 * This plugs into Agent({ getApiKey }) and agent-loop's per-call key resolution.
 */

import {
  getOAuthApiKey,
  getEnvApiKey,
  type OAuthCredentials,
} from "@mariozechner/pi-ai";
import {
  loadAuthStore,
  saveAuthStore,
  defaultAuthStorePath,
  type AuthStore,
} from "./store.js";
import type { PluginLogger } from "../types.js";

// ---------------------------------------------------------------------------
// Provider ID mapping
// ---------------------------------------------------------------------------

/**
 * Map pi-ai provider names to auth store provider IDs.
 * pi-ai uses "anthropic", "openai", etc. as provider field in Model.
 * OAuth providers use "anthropic", "openai-codex", "github-copilot", etc.
 */
const PROVIDER_TO_OAUTH: Record<string, string[]> = {
  anthropic: ["anthropic"],
  openai: ["openai-codex"],
  "openai-codex": ["openai-codex"],
  "github-copilot": ["github-copilot"],
  google: ["google-gemini-cli", "google-antigravity"],
  "google-gemini-cli": ["google-gemini-cli"],
  "google-antigravity": ["google-antigravity"],
};

// ---------------------------------------------------------------------------
// Resolver factory
// ---------------------------------------------------------------------------

export interface ApiKeyResolverOptions {
  /** Path to auth.json. Default: ~/.flock/auth.json */
  storePath?: string;
  /** Logger for refresh/error events. */
  logger?: PluginLogger;
}

/**
 * Create a `getApiKey(provider)` function suitable for Agent({ getApiKey }).
 *
 * Tries OAuth store first (with auto-refresh), falls back to env vars.
 */
export function createApiKeyResolver(
  opts?: ApiKeyResolverOptions,
): (provider: string) => Promise<string | undefined> {
  const storePath = opts?.storePath ?? defaultAuthStorePath();
  const logger = opts?.logger;

  return async (provider: string): Promise<string | undefined> => {
    // 1. Try OAuth store
    const oauthIds = PROVIDER_TO_OAUTH[provider] ?? [provider];

    for (const oauthId of oauthIds) {
      const store = loadAuthStore(storePath);
      const cred = store.credentials[oauthId];
      if (!cred) continue;

      try {
        const result = await getOAuthApiKey(oauthId, { [oauthId]: cred });
        if (result) {
          // Persist refreshed credentials if they changed
          if (result.newCredentials !== cred) {
            const freshStore = loadAuthStore(storePath);
            freshStore.credentials[oauthId] = result.newCredentials;
            saveAuthStore(freshStore, storePath);
            logger?.debug?.(`[flock:auth] refreshed OAuth token for ${oauthId}`);
          }
          return result.apiKey;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.warn(`[flock:auth] OAuth key resolution failed for ${oauthId}: ${message}`);
        // Fall through to next candidate or env var
      }
    }

    // 2. Fallback: environment variable
    const envKey = getEnvApiKey(provider);
    if (envKey) return envKey;

    return undefined;
  };
}
