/** The cat companion's pure parts: preferences, mood mapping and reaction gate, roaming brain. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module without type declarations
import { DEFAULT_CAT_PREFS, loadCatPrefs, saveCatPrefs } from '../web/src/lib/cat-prefs.js';
// @ts-expect-error — plain JS module without type declarations
import { moodForEvent, createReactionGate, trackRunning, isWorking, pickMotion, roamPaused } from '../web/src/lib/cat-mood.js';
// @ts-expect-error — plain JS module without type declarations
import { roamAllowed, initialBrain, nextBrainStep, clampX, WALK_SPEED_PX_S } from '../web/src/lib/cat-brain.js';

function memStorage(initial?: string) {
  let v: string | null = initial ?? null;
  return {
    getItem: () => v,
    setItem: (_k: string, val: string) => { v = val; },
    removeItem: () => { v = null; },
  } as unknown as Storage;
}
const throwing = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
} as unknown as Storage;

describe('cat prefs', () => {
  it('defaults with empty storage', () => {
    assert.deepEqual(loadCatPrefs(memStorage()), DEFAULT_CAT_PREFS);
  });
  it('reads valid prefs', () => {
    assert.deepEqual(loadCatPrefs(memStorage('{"mode":"hidden","x":0.4,"bottom":30}')), { mode: 'hidden', x: 0.4, bottom: 30 });
  });
  it('falls back on garbage JSON and fixes bad fields', () => {
    assert.deepEqual(loadCatPrefs(memStorage('{nope')), DEFAULT_CAT_PREFS);
    assert.deepEqual(loadCatPrefs(memStorage('null')), DEFAULT_CAT_PREFS);
    assert.deepEqual(loadCatPrefs(memStorage('{"mode":"dance","x":7,"bottom":-5}')), { mode: 'roam', x: 1, bottom: 0 });
    assert.deepEqual(loadCatPrefs(memStorage('{"mode":"sit","x":"a","bottom":9999}')), { mode: 'sit', x: null, bottom: 400 });
  });
  it('survives a storage that throws', () => {
    assert.deepEqual(loadCatPrefs(throwing), DEFAULT_CAT_PREFS);
    assert.doesNotThrow(() => saveCatPrefs({ mode: 'sit', x: 0.5, bottom: 20 }, throwing));
  });
  it('round-trips', () => {
    const s = memStorage();
    saveCatPrefs({ mode: 'sit', x: 0.25, bottom: 44 }, s);
    assert.deepEqual(loadCatPrefs(s), { mode: 'sit', x: 0.25, bottom: 44 });
  });
});

describe('moodForEvent', () => {
  const ctx = { projectId: 'p1' };
  it('maps the four reacting events', () => {
    assert.deepEqual(moodForEvent({ type: 'workflow.updated', status: 'done', workflowId: 'w1' }, ctx),
      { animation: 'celebrate', text: 'A session finished.', href: '#/p/p1/sessions/w1' });
    assert.deepEqual(moodForEvent({ type: 'workflow.updated', status: 'failed', workflowId: 'w1' }, ctx),
      { animation: 'worried', text: 'A session failed.', href: '#/p/p1/sessions/w1' });
    assert.deepEqual(moodForEvent({ type: 'workflow.updated', status: 'blocked', workflowId: 'w1' }, ctx),
      { animation: 'alert', text: 'A session is blocked and needs you.', href: '#/p/p1/sessions/w1' });
    assert.deepEqual(moodForEvent({ type: 'inbox.created', itemType: 'blocked' }, ctx),
      { animation: 'alert', text: 'Something needs you in the Inbox.', href: '#/inbox' });
  });
  it('links to the Inbox when a workflow event has no workflowId', () => {
    assert.equal(moodForEvent({ type: 'workflow.updated', status: 'done' }, ctx)?.href, '#/inbox');
  });
  it('ignores everything else', () => {
    assert.equal(moodForEvent({ type: 'workflow.updated', status: 'running' }, ctx), null);
    assert.equal(moodForEvent({ type: 'workflow.updated', status: 'paused' }, ctx), null);
    assert.equal(moodForEvent({ type: 'workflow.updated' }, ctx), null);
    assert.equal(moodForEvent({ type: 'run.event' }, ctx), null);
    assert.equal(moodForEvent({ type: 'pipeline.run' }, ctx), null);
    assert.equal(moodForEvent({ status: 'done' }, ctx), null);
    assert.equal(moodForEvent(null, ctx), null);
  });
  it('inbox.created reacts even without an itemType', () => {
    assert.equal(moodForEvent({ type: 'inbox.created' }, ctx)?.animation, 'alert');
  });
});

describe('createReactionGate', () => {
  it('allows one per gap, never while hidden, and hidden does not consume', () => {
    const gate = createReactionGate(20000);
    assert.equal(gate(1000, true), false);
    assert.equal(gate(1000, false), true);
    assert.equal(gate(6000, false), false);
    assert.equal(gate(21000, false), true);
    const g2 = createReactionGate(20000);
    assert.equal(g2(0, false), true);
    assert.equal(g2(30000, true), false);
    assert.equal(g2(30001, false), true);
  });
  it('a burst of ten allows exactly one', () => {
    const gate = createReactionGate();
    let n = 0;
    for (let i = 0; i < 10; i++) if (gate(1000 + i * 100, false)) n++;
    assert.equal(n, 1);
  });
});

describe('roaming brain', () => {
  const ok = { width: 601, reducedMotion: false, typing: false, dialogOpen: false };
  it('roamAllowed', () => {
    assert.equal(roamAllowed(ok), true);
    assert.equal(roamAllowed({ ...ok, width: 600 }), false);
    assert.equal(roamAllowed({ ...ok, reducedMotion: true }), false);
    assert.equal(roamAllowed({ ...ok, typing: true }), false);
    assert.equal(roamAllowed({ ...ok, dialogOpen: true }), false);
  });
  const bounds = { min: 0, max: 1000 };
  it('walks inside the bounds for distance / speed, then sits at the target', () => {
    const s0 = initialBrain(500, 0);
    assert.equal(s0.phase, 'sit');
    assert.equal(s0.until, 3000);
    const walk = nextBrainStep(s0, 3000, () => 0.9, bounds);
    assert.equal(walk.phase, 'walk');
    assert.ok(walk.targetX >= 0 && walk.targetX <= 1000);
    const dist = Math.abs(walk.targetX - 500);
    assert.ok(dist >= 60 && dist <= 200);
    assert.ok(Math.abs(walk.until - 3000 - (dist / WALK_SPEED_PX_S) * 1000) < 1e-6);
    const sit = nextBrainStep(walk, walk.until, () => 0.5, bounds);
    assert.equal(sit.phase, 'sit');
    assert.equal(sit.x, walk.targetX);
    assert.equal(sit.until, walk.until + 3000 + 2500);
  });
  it('turns away from the edges', () => {
    assert.equal(nextBrainStep(initialBrain(0, 0), 0, () => 0.1, bounds).dir, 1);
    assert.equal(nextBrainStep(initialBrain(1000, 0), 0, () => 0.9, bounds).dir, -1);
    assert.ok(nextBrainStep(initialBrain(1000, 0), 0, () => 0.9, bounds).targetX < 1000);
  });
  it('clampX', () => {
    assert.equal(clampX(-5, bounds), 0);
    assert.equal(clampX(5000, bounds), 1000);
    assert.equal(clampX(300, bounds), 300);
    assert.equal(clampX(300, { min: 10, max: 4 }), 10);
  });
});

describe('working tracker', () => {
  const ev = (status: string, workflowId?: string, type = 'workflow.updated') => ({ type, status, workflowId });
  it('running adds, every other status removes', () => {
    let s: ReadonlySet<string> = new Set();
    assert.equal(isWorking(s), false);
    s = trackRunning(s, ev('running', 'a'));
    assert.equal(isWorking(s), true);
    s = trackRunning(s, ev('running', 'b'));
    assert.equal(s.size, 2);
    for (const [status, id] of [['done', 'a'], ['failed', 'b']]) s = trackRunning(s, ev(status, id));
    assert.equal(isWorking(s), false);
    for (const status of ['blocked', 'stopped', 'paused', 'cancelled']) {
      s = trackRunning(new Set(['x']), ev('running', 'x'));
      s = trackRunning(s, ev(status, 'x'));
      assert.equal(s.size, 0, status);
    }
    assert.equal(trackRunning(new Set(), ev('pending', 'p')).has('p'), true);
  });
  it('keeps working while another session still runs', () => {
    let s: ReadonlySet<string> = trackRunning(trackRunning(new Set(), ev('running', 'a')), ev('running', 'b'));
    s = trackRunning(s, ev('done', 'a'));
    assert.equal(isWorking(s), true);
  });
  it('returns the same set when nothing changes, and ignores other events', () => {
    const s: ReadonlySet<string> = new Set(['a']);
    assert.equal(trackRunning(s, ev('running', 'a')), s);
    assert.equal(trackRunning(s, ev('done', 'zzz')), s);
    assert.equal(trackRunning(s, ev('done')), s);
    assert.equal(trackRunning(s, ev('done', 'a', 'inbox.created')), s);
    assert.equal(trackRunning(s, null), s);
    assert.equal(trackRunning(s, { type: 'workflow.updated', workflowId: 'a' }), s);
  });
  it('does not mutate its input', () => {
    const s = new Set(['a']);
    const n = trackRunning(s, ev('done', 'a'));
    assert.equal(s.size, 1);
    assert.equal(n.size, 0);
  });
  it('pickMotion: reactions win, then walking, wave, working, idle; working stops roaming', () => {
    assert.equal(pickMotion({ working: true }), 'working');
    assert.equal(pickMotion({}), 'idle');
    assert.equal(pickMotion({ working: true, reaction: 'celebrate' }), 'celebrate');
    assert.equal(pickMotion({ working: true, reaction: 'alert', hovered: true }), 'alert');
    assert.equal(pickMotion({ working: true, hovered: true }), 'wave');
    assert.equal(pickMotion({ walking: true }), 'walk');
    assert.equal(roamPaused(true), true);
    assert.equal(roamPaused(false), false);
  });
});
