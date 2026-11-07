/** web/src/lib/approvalState.js — an answered approval shows its answer after a reload, not the buttons. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error — plain JS module without type declarations
import { approvalStates } from '../web/src/lib/approvalState.js';

describe('approvalStates', () => {
  it('records answers, expiries and ended turns', () => {
    const { resolutions, endedRuns } = approvalStates([
      { type: 'approval-request', run_id: 'r1', payload: { inputId: 'a' } },
      { type: 'approval-resolved', run_id: 'r1', payload: { inputId: 'a', status: 'approved', allowAll: true, by: 'Ann' } },
      { type: 'approval-request', run_id: 'r1', payload: { inputId: 'b' } },
      { type: 'approval-resolved', run_id: 'r1', payload: { inputId: 'b', status: 'denied' } },
      { type: 'approval-request', run_id: 'r1', payload: { inputId: 'c' } },
      { type: 'approval-expired', run_id: 'r1', payload: { inputId: 'c', minutes: 30 } },
      { type: 'run-complete', run_id: 'r1', payload: {} },
      { type: 'approval-request', payload: { inputId: 'd' } }, // live stream of the current run: no run_id
    ], 'r2');
    assert.deepEqual(resolutions.get('a'), { status: 'approved', allowAll: true, by: 'Ann' });
    assert.deepEqual(resolutions.get('b'), { status: 'denied', allowAll: false, by: null });
    assert.equal(resolutions.get('c')?.status, 'expired');
    assert.equal(resolutions.has('d'), false, 'still waiting');
    assert.ok(endedRuns.has('r1'));
    assert.ok(!endedRuns.has('r2'), 'the current turn is still going');
  });

  it('a stream event without run_id that ends the turn ends the current run', () => {
    const { endedRuns } = approvalStates([{ type: 'run-failed', payload: { error: 'x' } }], 'r9');
    assert.ok(endedRuns.has('r9'));
  });

  it('an answer wins over a later expiry note', () => {
    const { resolutions } = approvalStates([
      { type: 'approval-resolved', payload: { inputId: 'a', status: 'approved' } },
      { type: 'approval-expired', payload: { inputId: 'a' } },
    ], null);
    assert.equal(resolutions.get('a')?.status, 'approved');
  });

  it('copes with nothing', () => {
    const { resolutions, endedRuns } = approvalStates(undefined, null);
    assert.equal(resolutions.size, 0);
    assert.equal(endedRuns.size, 0);
  });
});
