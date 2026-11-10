/**
 * Claude model pricing (USD per million tokens), Anthropic's standard first-party rates.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (read 2026-11-04).
 *
 * Used only to estimate a run's cost when the engine does not report its own total, which
 * happens when a run is cancelled or stopped by its time limit. The engine's total_cost_usd
 * is authoritative when present. Estimate per model reply (one request): Haiku 5.5's price
 * depends on each request's prompt length, so pricing a whole run's totals would be wrong.
 *
 * Prices differ between versions of the same family (Haiku 4.5 is 10x Haiku 5.5; Opus 4.5 is a
 * third of Opus 4.1), so the version is read from the model ID in any of its forms:
 * claude-haiku-4-5, claude-haiku-4-5-20251001, claude-haiku-4-5@20251001 (Vertex),
 * global.anthropic.claude-haiku-4-5-20251001-v1:0 (Bedrock), claude-3-5-haiku-20241022.
 */

// ── Price table ───────────────────────────────────────────────────────────────

export interface ModelPrice {
  input: number;
  output: number;
  /** Cache hits and refreshes. */
  cacheRead: number;
  /** 5-minute cache writes (Claude Code's default). 1-hour writes cost more; usage doesn't say which. */
  cacheWrite: number;
  /** Claude Haiku 5.5 charges more for a request whose prompt exceeds this many tokens. */
  longThreshold?: number;
  long?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

type Family = 'fable' | 'opus' | 'sonnet' | 'haiku';

/**
 * Prices by family, from the newest version down. A model uses the first row whose version is
 * at or below its own, so a row covers every version up to the next row (Opus 4.5 to 5 share a
 * price). A version older than every row uses the oldest row.
 */
const PRICES: Record<Family, Array<{ from: number; price: ModelPrice }>> = {
  // Claude Mythos is priced as Claude Fable of the same version.
  fable: [
    { from: 5.1, price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 } },
    { from: 5, price: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  ],
  opus: [
    { from: 5.5, price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
    { from: 4.5, price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }, // 4.5, 4.6, 4.7, 4.8, 5
    { from: 3, price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } }, // 4, 4.1
  ],
  sonnet: [
    { from: 5.5, price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
    { from: 5, price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
    { from: 3, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, // 4, 4.5, 4.6
  ],
  haiku: [
    {
      from: 5.5,
      price: {
        input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
        longThreshold: 100_000,
        long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
      },
    },
    { from: 4.5, price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
    { from: 3.5, price: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
  ],
};

/**
 * Version assumed when an ID names only the family ('sonnet', 'haiku', 'opus'): the portal
 * resolves those aliases to the 4.5 models (MODEL_DEFAULTS in server/models.ts).
 */
const ALIAS_VERSION: Record<Family, number> = { fable: 5.1, opus: 4.5, sonnet: 4.5, haiku: 4.5 };

/** Unknown model IDs are priced as the portal's default model, Claude Sonnet 4.5. */
const FALLBACK: { family: Family; version: number } = { family: 'sonnet', version: 4.5 };

/** Bedrock and Google Cloud regional endpoints cost 10% more than global ones, from the 4.5 models on. */
const REGIONAL_PREMIUM = 1.1;
/** Bedrock geographic inference profiles (regional). `global.` and bare in-Region IDs are left at standard rates. */
const REGIONAL_PREFIX = /^(us|eu|apac|jp|au|ca|us-gov)\.anthropic\./;

// ── Model resolution ──────────────────────────────────────────────────────────

export interface ResolvedModel {
  family: Family;
  version: number;
}

/** Family and version from a model ID, or the fallback when the ID names no Claude family. */
export function parseModel(model: string | undefined | null): ResolvedModel {
  const m = (model ?? '').toLowerCase();

  // claude-opus-4-5, claude-opus-4-5-20251101, claude-opus-4-20250514 (no minor: an 8-digit date
  // follows), claude-opus-4-5@20251101, global.anthropic.claude-opus-4-5-20251101-v1:0
  const current = /claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2})(?![\d]))?/.exec(m);
  if (current) {
    const family = current[1] === 'mythos' ? 'fable' : (current[1] as Family);
    return { family, version: Number(current[2]) + (current[3] ? Number(current[3]) / 10 : 0) };
  }
  // Older naming: claude-3-5-haiku-20241022, claude-3-7-sonnet-20250219, claude-3-opus-20240229
  const legacy = /claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)/.exec(m);
  if (legacy) {
    return { family: legacy[3] as Family, version: Number(legacy[1]) + (legacy[2] ? Number(legacy[2]) / 10 : 0) };
  }
  // A bare alias or label: 'sonnet', 'Claude Haiku'
  for (const family of ['fable', 'opus', 'sonnet', 'haiku'] as const) {
    if (m.includes(family)) return { family, version: ALIAS_VERSION[family] };
  }
  if (m.includes('mythos')) return { family: 'fable', version: ALIAS_VERSION.fable };
  return { ...FALLBACK };
}

/** Standard per-million-token prices for a model ID (before any regional premium). */
export function priceFor(model: string | undefined | null): ModelPrice {
  const { family, version } = parseModel(model);
  const rows = PRICES[family];
  // Versions are tenths (4.5, 5.1): compare with a small tolerance for float error.
  const row = rows.find((r) => version + 1e-9 >= r.from) ?? rows[rows.length - 1];
  return row.price;
}

// ── Usage types ───────────────────────────────────────────────────────────────

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// ── Cost estimation ───────────────────────────────────────────────────────────

/**
 * Estimated cost in USD of one request (one model reply) from its token counts and model ID.
 * Returns 0 if usage is null/undefined. Sum it per reply for a run; see the note at the top.
 */
export function estimateCost(model: string | undefined | null, u: TokenUsage | null | undefined): number {
  if (!u) return 0;
  let p: ModelPrice = priceFor(model);
  const promptTokens =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  if (p.longThreshold && p.long && promptTokens > p.longThreshold) {
    p = { ...p, ...p.long };
  }
  const usd = (
    (u.input_tokens ?? 0) * p.input +
    (u.output_tokens ?? 0) * p.output +
    (u.cache_read_input_tokens ?? 0) * p.cacheRead +
    (u.cache_creation_input_tokens ?? 0) * p.cacheWrite
  ) / 1_000_000;
  const { version } = parseModel(model);
  const regional = REGIONAL_PREFIX.test((model ?? '').toLowerCase()) && version >= 4.5 - 1e-9;
  return regional ? usd * REGIONAL_PREMIUM : usd;
}
