/**
 * Cost estimates for runs the engine does not price itself (cancelled or stopped by the time
 * limit). Prices: https://platform.claude.com/docs/en/about-claude/pricing (read 2026-11-04).
 *
 * The table used to price models by family only, so Haiku 4.5 got Haiku 5.5's price (a tenth of
 * its own), Opus 4.5 and later got Opus 4.1's (three times theirs), and Fable got Sonnet's.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, priceFor, parseModel } from '../server/agent/pricing.ts';

const M = 1_000_000;
const close = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${what}: ${actual} != ${expected}`);

describe('pricing: the version is read from every model ID form', () => {
  it('Haiku 4.5 in API, dated, Vertex and Bedrock form costs $1 / $5', () => {
    for (const id of [
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5@20251001',
      'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      'anthropic.claude-haiku-4-5',
    ]) {
      assert.deepEqual(parseModel(id), { family: 'haiku', version: 4.5 }, id);
      const p = priceFor(id);
      assert.deepEqual([p.input, p.output, p.cacheRead, p.cacheWrite], [1, 5, 0.1, 1.25], id);
    }
  });

  it('a date after a major version is not read as a minor version', () => {
    assert.deepEqual(parseModel('claude-opus-4-20250514'), { family: 'opus', version: 4 });
    assert.deepEqual(parseModel('claude-sonnet-4-20250514'), { family: 'sonnet', version: 4 });
    assert.deepEqual(parseModel('claude-opus-4-1-20250805'), { family: 'opus', version: 4.1 });
  });

  it('older names (claude-3-5-haiku) and Mythos are understood', () => {
    assert.deepEqual(parseModel('claude-3-5-haiku-20241022'), { family: 'haiku', version: 3.5 });
    assert.deepEqual(parseModel('anthropic.claude-3-7-sonnet-20250219-v1:0'), { family: 'sonnet', version: 3.7 });
    assert.deepEqual(parseModel('claude-mythos-5-1'), { family: 'fable', version: 5.1 });
  });

  it('a bare alias uses the portal\'s alias default (4.5); an unknown ID uses Sonnet 4.5', () => {
    assert.deepEqual(parseModel('haiku'), { family: 'haiku', version: 4.5 });
    assert.deepEqual(parseModel('sonnet'), { family: 'sonnet', version: 4.5 });
    assert.deepEqual(parseModel('Claude Opus'), { family: 'opus', version: 4.5 });
    assert.deepEqual(parseModel('bedrock-default'), { family: 'sonnet', version: 4.5 });
    assert.deepEqual(parseModel(null), { family: 'sonnet', version: 4.5 });
  });
});

describe('pricing: per-version prices match the published table', () => {
  const cases: Array<[string, [number, number, number, number]]> = [
    // id, [input, output, cache read, 5m cache write] per MTok
    ['claude-fable-5-1', [10, 50, 0.25, 12.5]],
    ['claude-fable-5', [10, 50, 1, 12.5]],
    ['claude-opus-5-5', [4, 20, 0.2, 5]],
    ['claude-opus-5', [5, 25, 0.5, 6.25]],
    ['claude-opus-4-8', [5, 25, 0.5, 6.25]],
    ['claude-opus-4-5-20251101', [5, 25, 0.5, 6.25]],
    ['claude-opus-4-1-20250805', [15, 75, 1.5, 18.75]],
    ['claude-opus-4-20250514', [15, 75, 1.5, 18.75]],
    ['claude-sonnet-5-5', [2, 10, 0.1, 2.5]],
    ['claude-sonnet-5', [2, 10, 0.2, 2.5]],
    ['claude-sonnet-4-6', [3, 15, 0.3, 3.75]],
    ['claude-sonnet-4-5-20250929', [3, 15, 0.3, 3.75]],
    ['claude-haiku-5-5', [0.1, 0.5, 0.01, 0.125]],
    ['claude-haiku-4-5', [1, 5, 0.1, 1.25]],
    ['claude-3-5-haiku-20241022', [0.8, 4, 0.08, 1]],
  ];
  for (const [id, [input, output, cacheRead, cacheWrite]] of cases) {
    it(id, () => {
      const p = priceFor(id);
      assert.deepEqual([p.input, p.output, p.cacheRead, p.cacheWrite], [input, output, cacheRead, cacheWrite]);
    });
  }
});

describe('pricing: estimateCost', () => {
  it('prices every token kind', () => {
    // Haiku 4.5: 1,000 in, 200 out, 5,000 cache read, 300 cache write
    const usd = estimateCost('claude-haiku-4-5', { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 });
    close(usd, (1000 * 1 + 200 * 5 + 5000 * 0.1 + 300 * 1.25) / M, 'haiku 4.5');
  });

  it('Haiku 4.5 is no longer priced as Haiku 5.5 (seen live: 10x too low)', () => {
    const u = { input_tokens: 20, output_tokens: 6, cache_read_input_tokens: 26_084, cache_creation_input_tokens: 6_000 };
    const h45 = estimateCost('global.anthropic.claude-haiku-4-5-20251001-v1:0', u);
    const h55 = estimateCost('claude-haiku-5-5', u);
    close(h45, h55 * 10, 'Haiku 4.5 costs ten times Haiku 5.5 at every token kind');
  });

  it('Haiku 5.5 charges the higher price only for a request whose prompt is over 100K tokens', () => {
    const short = estimateCost('claude-haiku-5-5', { input_tokens: 1000, cache_read_input_tokens: 99_000, output_tokens: 100 });
    close(short, (1000 * 0.1 + 99_000 * 0.01 + 100 * 0.5) / M, 'at 100K');
    const long = estimateCost('claude-haiku-5-5', { input_tokens: 1000, cache_read_input_tokens: 99_001, output_tokens: 100 });
    close(long, (1000 * 0.5 + 99_001 * 0.05 + 100 * 2.5) / M, 'over 100K');
    // Other models have no length tier.
    const sonnet = estimateCost('claude-sonnet-4-5', { input_tokens: 500_000 });
    close(sonnet, 500_000 * 3 / M, 'sonnet 4.5 long prompt');
  });

  it('Bedrock regional profiles cost 10% more from the 4.5 models on; global and older models do not', () => {
    const u = { input_tokens: 1_000_000 };
    close(estimateCost('global.anthropic.claude-sonnet-4-5-20250929-v1:0', u), 3, 'global');
    close(estimateCost('apac.anthropic.claude-sonnet-4-5-20250929-v1:0', u), 3.3, 'apac');
    close(estimateCost('us.anthropic.claude-haiku-4-5-20251001-v1:0', u), 1.1, 'us');
    close(estimateCost('us.anthropic.claude-opus-4-1-20250805-v1:0', u), 15, 'pre-4.5 keeps its price');
  });

  it('returns 0 without usage', () => {
    assert.equal(estimateCost('claude-haiku-4-5', null), 0);
    assert.equal(estimateCost('claude-haiku-4-5', undefined), 0);
  });
});
