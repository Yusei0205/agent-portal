/**
 * Claude model pricing (USD per million tokens).
 * Source: platform.claude.ai pricing page, October 2026.
 *
 * Used to estimate cost per run when the SDK does not report a total_cost_usd.
 * The SDK's own total_cost_usd is authoritative when present.
 */

// ── Price table ───────────────────────────────────────────────────────────────

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Haiku 3.5/5 charges more once the prompt exceeds this many tokens. */
  longThreshold?: number;
  long?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const PRICES: Record<string, ModelPrice> = {
  haiku: {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longThreshold: 100_000,
    long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
};

// ── Tier resolution ───────────────────────────────────────────────────────────

export function tierOf(model: string | undefined | null): 'haiku' | 'sonnet' | 'opus' {
  const m = (model ?? '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('opus')) return 'opus';
  return 'sonnet';
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
 * Estimate cost in USD from token counts and model name.
 * Returns 0 if usage is null/undefined.
 */
export function estimateCost(model: string | undefined | null, u: TokenUsage | null | undefined): number {
  if (!u) return 0;
  let p: ModelPrice = PRICES[tierOf(model)];
  const promptTokens =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  if (p.longThreshold && p.long && promptTokens > p.longThreshold) {
    p = { ...p, ...p.long };
  }
  return (
    (u.input_tokens ?? 0) * p.input +
    (u.output_tokens ?? 0) * p.output +
    (u.cache_read_input_tokens ?? 0) * p.cacheRead +
    (u.cache_creation_input_tokens ?? 0) * p.cacheWrite
  ) / 1_000_000;
}
