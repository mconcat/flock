/**
 * Flock Auth Store — persists OAuth credentials at ~/.flock/auth.json.
 *
 * Uses pi-ai's OAuth providers for login/refresh flows.
 * This is the standalone equivalent of OpenClaw's auth-profiles system,
 * deliberately kept simpler (no multi-profile, no billing backoff).
 *
 * Storage format:
 *   { version: 1, credentials: { [providerId]: OAuthCredentials } }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { OAuthCredentials } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthStore {
  version: 1;
  credentials: Record<string, OAuthCredentials>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const AUTH_STORE_VERSION = 1;

/** Default auth store path: ~/.flock/auth.json */
export function defaultAuthStorePath(): string {
  return join(homedir(), ".flock", "auth.json");
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/**
 * Load the auth store from disk. Returns empty store if file doesn't exist.
 */
export function loadAuthStore(storePath?: string): AuthStore {
  const filepath = storePath ?? defaultAuthStorePath();
  if (!existsSync(filepath)) {
    return { version: AUTH_STORE_VERSION, credentials: {} };
  }

  const raw = readFileSync(filepath, "utf-8");
  const parsed: unknown = JSON.parse(raw);

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    (parsed as AuthStore).version !== AUTH_STORE_VERSION
  ) {
    // Incompatible version — start fresh
    return { version: AUTH_STORE_VERSION, credentials: {} };
  }

  const store = parsed as AuthStore;

  // Ensure credentials is an object
  if (typeof store.credentials !== "object" || store.credentials === null) {
    store.credentials = {};
  }

  return store;
}

/**
 * Save the auth store to disk. Creates parent directories if needed.
 */
export function saveAuthStore(store: AuthStore, storePath?: string): void {
  const filepath = storePath ?? defaultAuthStorePath();
  const dir = dirname(filepath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(filepath, JSON.stringify(store, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Get credentials for a specific provider.
 */
export function getCredentials(
  store: AuthStore,
  providerId: string,
): OAuthCredentials | undefined {
  return store.credentials[providerId];
}

/**
 * Set credentials for a specific provider and persist.
 */
export function setCredentials(
  providerId: string,
  credentials: OAuthCredentials,
  storePath?: string,
): void {
  const store = loadAuthStore(storePath);
  store.credentials[providerId] = credentials;
  saveAuthStore(store, storePath);
}

/**
 * Remove credentials for a specific provider and persist.
 */
export function removeCredentials(
  providerId: string,
  storePath?: string,
): boolean {
  const store = loadAuthStore(storePath);
  if (!(providerId in store.credentials)) return false;
  delete store.credentials[providerId];
  saveAuthStore(store, storePath);
  return true;
}

/**
 * List all stored provider IDs.
 */
export function listProviders(storePath?: string): string[] {
  const store = loadAuthStore(storePath);
  return Object.keys(store.credentials);
}
