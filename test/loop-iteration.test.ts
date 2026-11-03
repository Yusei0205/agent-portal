/**
 * Loop iteration logic: status parsing, stagnation (harness PR 1.7: loose matching, window of at least 2), the stop
 * rules that take effect (maxConsecutiveFailures, stagnationWindow, requireVerification), the next prompt and the
 * progress record.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStatus, sameReport, stagnated, nextStep, composeIterationPrompt, addProgress, recentProgressText,
  type LoopState,
} from '../server/loop-iteration.ts';

const base = (over: Partial<LoopState> = {}): LoopState => ({
  iteration: 1, maxIterations: 8, failures: 0, summaries: [], status: null, runFailed: false, checkPassed: null, ...over,
});

describe('parseStatus', () => {
  it('reads the last status line', () => {
    const s = parseStatus('work\nWORKFLOW_STATUS {"state":"continue","summary":"a"}\nmore\nWORKFLOW_STATUS {"state":"done","summary":"b"}');
    assert.equal(s?.state, 'done');
    assert.equal(s?.summary, 'b');
  });
  it('ignores an unknown state or bad JSON', () => {
    assert.equal(parseStatus('WORKFLOW_STATUS {"state":"maybe"}'), null);
    assert.equal(parseStatus('WORKFLOW_STATUS {nope}'), null);
    assert.equal(parseStatus(null), null);
  });
});

describe('stagnation', () => {
  it('counts small rewording as the same report', () => {
    assert.equal(sameReport('Fixed the login bug in auth.ts and added a test for it', 'Fixed the login bug in auth.ts and added a test for it.'), true);
    assert.equal(sameReport('Fixed A, next B', 'Fixed B, next C'), false);
  });
  it('needs a full window of the same report', () => {
    assert.equal(stagnated(['x y z', 'x y z']), false);
    assert.equal(stagnated(['x y z', 'x y z', 'x y z']), true);
  });
  it('a window of 1 is raised to 2 so a session is not stopped after its first iteration', () => {
    assert.equal(stagnated(['same thing'], 1), false);
    assert.equal(stagnated(['same thing here', 'same thing here'], 1), true);
  });
  it('real progress is not stagnation', () => {
    assert.equal(stagnated(['fixed A, next B', 'fixed B, next C', 'fixed C, next D']), false);
  });
});

describe('nextStep', () => {
  it('stops after maxConsecutiveFailures failed runs in a row (default 2)', () => {
    assert.equal(nextStep(base({ runFailed: true, failures: 1 })).action, 'continue');
    const d = nextStep(base({ runFailed: true, failures: 2 }));
    assert.equal(d.action, 'stop');
    assert.equal(nextStep(base({ runFailed: true, failures: 2 }), { maxConsecutiveFailures: 3 }).action, 'continue');
    assert.equal(nextStep(base({ runFailed: true, failures: 3 }), { maxConsecutiveFailures: 3 }).action, 'stop');
  });
  it('stops when the agent is done', () => {
    const d = nextStep(base({ status: { state: 'done', summary: 'all good', next: '', needs: '' } }));
    assert.deepEqual([d.action, (d as { outcome?: string }).outcome], ['stop', 'done']);
  });
  it('a failing check keeps the loop going unless the rules accept done without passing checks', () => {
    const status = { state: 'done' as const, summary: 'done', next: '', needs: '' };
    assert.equal(nextStep(base({ status, checkPassed: false })).action, 'continue');
    assert.equal(nextStep(base({ status, checkPassed: false }), { requireVerification: false }).action, 'stop');
  });
  it('stops as blocked with what the agent needs', () => {
    const d = nextStep(base({ status: { state: 'blocked', summary: '', next: '', needs: 'the API key' } }));
    assert.equal(d.action, 'stop');
    assert.match(d.reason, /API key/);
  });
  it('stops on stagnation using the declared window', () => {
    const summaries = ['no change here', 'no change here', 'no change here'];
    assert.equal(nextStep(base({ summaries })).action, 'stop');
    assert.equal(nextStep(base({ summaries }), { stagnationWindow: 4 }).action, 'continue');
  });
  it('stops at the iteration limit, when the budget is gone, and at the time limit', () => {
    assert.equal(nextStep(base({ iteration: 8 })).action, 'stop');
    assert.equal(nextStep(base({ budgetLeftUsd: 0 })).action, 'stop');
    assert.equal(nextStep(base({ minutesElapsed: 61 }), { wallClockMinutes: 60 }).action, 'stop');
    assert.equal(nextStep(base({ minutesElapsed: 10 }), { wallClockMinutes: 60 }).action, 'continue');
  });
  it('goes on when nothing says stop', () => {
    assert.equal(nextStep(base({ status: { state: 'continue', summary: 'half way', next: 'rest', needs: '' } })).action, 'continue');
  });
});

describe('prompt and progress', () => {
  it('the prompt carries the goal, the recent progress, new instructions and the reporting line', () => {
    const p = composeIterationPrompt({
      goal: 'Fix the bug', iteration: 2, maxIterations: 5, progress: '- Iteration 1: found the cause',
      instructions: ['also update the docs'], check: { ok: false, output: 'test failed' }, budgetLeftUsd: 3.2,
    });
    assert.match(p, /Fix the bug/);
    assert.match(p, /Progress so far[\s\S]*found the cause/);
    assert.match(p, /also update the docs/);
    assert.match(p, /FAILED/);
    assert.match(p, /WORKFLOW_STATUS/);
    assert.match(p, /Iteration 2 of at most 5/);
  });
  it('keeps only the newest progress entries and the last three in the prompt text', () => {
    let entries: ReturnType<typeof addProgress> = [];
    for (let i = 1; i <= 25; i++) entries = addProgress(entries, { iteration: i, summary: `did step ${i}`, at: 't' }, 20);
    assert.equal(entries.length, 20);
    assert.equal(entries[0].iteration, 6);
    const text = recentProgressText(entries, 3);
    assert.match(text, /step 25/);
    assert.match(text, /step 23/);
    assert.doesNotMatch(text, /step 22/);
  });
  it('the same iteration written twice replaces its entry', () => {
    const e = addProgress(addProgress([], { iteration: 1, summary: 'a', at: 't' }), { iteration: 1, summary: 'b', at: 't' });
    assert.deepEqual(e.map((x) => x.summary), ['b']);
  });
});
