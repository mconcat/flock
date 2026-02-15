/**
 * Flock Auth — credential management for standalone mode.
 *
 * Re-exports store and resolver for external use.
 */

export {
  loadAuthStore,
  saveAuthStore,
  getCredentials,
  setCredentials,
  removeCredentials,
  listProviders,
  defaultAuthStorePath,
  type AuthStore,
} from "./store.js";

export {
  createApiKeyResolver,
  type ApiKeyResolverOptions,
} from "./resolver.js";
