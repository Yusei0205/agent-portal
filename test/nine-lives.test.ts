/** The dashboard core's nine lives ring: which lives are lit for each state, its label and the pixel clover. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module without type declarations
import { lifeDots, coreLabel, CLOVER_PIXELS, LIVES } from '../web/src/lib/nine-lives.js';

const count = (dots: string[], kind: string) => dots.filter((d) => d === kind).length;

describe('lifeDots', () => {
  it('always gives nine lives', () => {
    assert.equal(LIVES, 9);
    for (const s of ['idle', 'running', 'success', 'failed', 'bogus']) assert.equal(lifeDots(s, 0).length, 9);
  });
  it('idle: one walking life, the rest off', () => {
    const d = lifeDots('idle');
    assert.equal(count(d, 'walk'), 1);
    assert.equal(count(d, 'off'), 8);
  });
  it('running: one life per running agent, capped at nine; 3 when the count is unknown or zero', () => {
    assert.equal(count(lifeDots('running', 2), 'on'), 2);
    assert.equal(count(lifeDots('running', 9), 'on'), 9);
    assert.equal(count(lifeDots('running', 40), 'on'), 9);
    assert.equal(count(lifeDots('running'), 'on'), 3);
    assert.equal(count(lifeDots('running', 0), 'on'), 3);
    assert.equal(count(lifeDots('running', -4), 'on'), 3);
    assert.equal(count(lifeDots('running', 2.7), 'on'), 2);
    assert.deepEqual(lifeDots('running', 2).slice(0, 2), ['on', 'on']);
  });
  it('success lights all nine; failed shows one red life', () => {
    assert.equal(count(lifeDots('success'), 'on'), 9);
    const f = lifeDots('failed');
    assert.equal(count(f, 'bad'), 1);
    assert.equal(f[2], 'bad');
    assert.equal(count(f, 'off'), 8);
  });
  it('an unknown state is idle', () => {
    assert.deepEqual(lifeDots('bogus'), lifeDots('idle'));
  });
});

describe('coreLabel', () => {
  it('says what the core shows', () => {
    assert.equal(coreLabel('idle'), 'AI core: idle');
    assert.equal(coreLabel('running', 1), 'AI core: 1 agent running');
    assert.equal(coreLabel('running', 3), 'AI core: 3 agents running');
    assert.equal(coreLabel('running'), 'AI core: agents are running');
    assert.equal(coreLabel('success'), 'AI core: the last run succeeded');
    assert.equal(coreLabel('failed'), 'AI core: a run failed');
  });
});

describe('CLOVER_PIXELS', () => {
  it('is an 11x11 clover with four leaves of equal size and a five-pixel gold centre', () => {
    const byPart: Record<string, number> = {};
    for (const p of CLOVER_PIXELS as Array<{ x: number; y: number; part: string }>) {
      assert.ok(p.x >= 0 && p.x < 11 && p.y >= 0 && p.y < 11);
      byPart[p.part] = (byPart[p.part] ?? 0) + 1;
    }
    assert.equal(byPart.centre, 5);
    assert.ok(byPart.l1 > 10);
    assert.equal(byPart.l1, byPart.l2);
    assert.equal(byPart.l2, byPart.l3);
    assert.equal(byPart.l3, byPart.l4);
  });
});
