/**
 * Shared model-list cache state.
 *
 * Kept in its own module so that server/settings.ts and server/sso.ts can call
 * clearModelListCache() without importing server/models.ts (which itself imports
 * server/settings.ts, which would create a circular dependency).
 */

/** Evict the model-list cache. Call whenever AWS credentials or provider settings change. */
export function clearModelListCache(): void {
  modelListCacheRef.value = null;
}

/** The actual cache slot — written by models.ts, read/evicted here. `key` is the mode, or mode:project for a project's own account. */
export const modelListCacheRef: { value: { at: number; mode: string; key?: string; models: unknown[] } | null } =
  { value: null };
