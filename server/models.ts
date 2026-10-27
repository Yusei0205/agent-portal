/**
 * Model resolution — resolves alias names (sonnet / haiku / opus) to actual
 * model IDs, with optional overrides stored in settings.
 */

import type { DatabaseSync } from 'node:sqlite';
import { getSetting } from './settings.ts';
import { getDb } from './db.ts';

// ── Defaults ──────────────────────────────────────────────────────────────────

export const MODEL_DEFAULTS: Record<string, string> = {
  sonnet: 'claude-sonnet-4-5',
  haiku: 'claude-haiku-4-5',
  opus: 'claude-opus-4-5',
};

// ── Resolvers ─────────────────────────────────────────────────────────────────

/**
 * Resolve an alias to a concrete model ID.
 * Returns the custom override from settings when set, otherwise MODEL_DEFAULTS[alias].
 */
export function resolveModel(
  alias: 'sonnet' | 'haiku' | 'opus',
  db?: DatabaseSync,
): string {
  const d = db ?? getDb();
  const override = getSetting(d, `model.${alias}`);
  if (override && override.trim()) return override.trim();
  return MODEL_DEFAULTS[alias];
}

/**
 * Returns the current resolved model IDs for all three aliases.
 */
export function getModelVersions(db?: DatabaseSync): Record<string, string> {
  const d = db ?? getDb();
  return {
    sonnet: resolveModel('sonnet', d),
    haiku: resolveModel('haiku', d),
    opus: resolveModel('opus', d),
  };
}
