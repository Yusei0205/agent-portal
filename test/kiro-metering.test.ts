/**
 * Reading Kiro's credits from its `_kiro.dev/metadata` notification (the runner's and the portal's copy of the rule): the sum of the
 * credit entries; nothing for a frame without them; a unit that is not credits is never added in; bad values are skipped.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { creditsFromMetadata } from '../kiro-runner/src/metering.ts';
import { meteredCredits } from '../server/agent/kiro.ts';

const credit = (value: unknown) => ({ unit: 'credit', unitPlural: 'credits', value });

for (const [name, read] of [['runner', creditsFromMetadata], ['portal (local ACP)', meteredCredits]] as const) {
  describe(`credits from a Kiro metadata frame — ${name}`, () => {
    it('adds the per-call entries of the turn', () => {
      assert.ok(Math.abs((read({ meteringUsage: [credit(0.1), credit(0.25), credit(0.018139567827529027)] }) as number) - 0.368139567827529) < 1e-12);
      assert.equal(read({ sessionId: 's', contextUsagePercentage: 0.7, turnDurationMs: 1948, meteringUsage: [credit(2)] }), 2);
    });
    it('a frame with no entries has no credits (null, not 0, so a running total is not reset)', () => {
      assert.equal(read({ contextUsagePercentage: 0.4 }), null);
      assert.equal(read({ meteringUsage: [] }), null);
      assert.equal(read(null), null);
      assert.equal(read(undefined), null);
      assert.equal(read({ meteringUsage: 'x' }), null);
    });
    it('a legitimate 0-credit turn is 0, not "nothing"', () => {
      assert.equal(read({ meteringUsage: [credit(0)] }), 0);
    });
    it('only credits are added: another unit, bad or negative values are skipped', () => {
      assert.equal(read({ meteringUsage: [credit(1), { unit: 'token', unitPlural: 'tokens', value: 5000 }] }), 1);
      assert.equal(read({ meteringUsage: [credit('abc'), credit(-1), credit(Number.NaN), null, 'x', credit(0.5)] }), 0.5);
      assert.equal(read({ meteringUsage: [{ unit: 'token', unitPlural: 'tokens', value: 5000 }] }), null);
      // The plural alone, or the singular alone, is enough to know it is a credit.
      assert.equal(read({ meteringUsage: [{ unitPlural: 'credits', value: 1 }, { unit: 'credit', value: 2 }] }), 3);
    });
  });
}
