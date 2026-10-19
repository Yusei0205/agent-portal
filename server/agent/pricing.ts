/**
 * Claude API list prices in USD per million tokens (platform.claude.com pricing page, October 2026).
 * Used for per-node estimates; the SDK's own total_cost_usd is used for run totals when available.
 */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Haiku 5.5 charges more once a single prompt exceeds this many tokens. */
  longThreshold?: number;
  long?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export const PRICES: Record<string, Price> = {
  haiku: {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longThreshold: 100_000,
    long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  sonnet: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  fable: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

export function tierOf(model: string | undefined | null): 'haiku' | 'sonnet' | 'opus' | 'fable' {
  const m = (model || '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  return 'sonnet';
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function estimateCost(model: string | undefined | null, u: Usage | undefined | null): number {
  if (!u) return 0;
  let p: Price = PRICES[tierOf(model)];
  const promptTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  if (p.longThreshold && p.long && promptTokens > p.longThreshold) p = { ...p, ...p.long };
  return (
    ((u.input_tokens || 0) * p.input +
      (u.output_tokens || 0) * p.output +
      (u.cache_read_input_tokens || 0) * p.cacheRead +
      (u.cache_creation_input_tokens || 0) * p.cacheWrite) /
    1_000_000
  );
}
