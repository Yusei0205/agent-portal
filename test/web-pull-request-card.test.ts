/**
 * Unit tests for web/src/lib/pullRequestCard.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error — plain JS module without type declarations
import { latestPullRequestStates, describePullRequest, reviewHandoffHref, sessionPullRequestCards } from '../web/src/lib/pullRequestCard.js';

const base = { type: 'pull-request', repo: 'shop', repoId: 'r1' };
const d = (o: object, ctx?: object) => describePullRequest({ ...base, ...o }, ctx);

describe('latestPullRequestStates', () => {
  it('keeps the latest event per repo and ignores other event types', () => {
    const out = latestPullRequestStates([
      { type: 'status', payload: {} },
      { ...base, state: 'pushing' },
      { ...base, repo: 'api', repoId: 'r2', state: 'asked' },
      { ...base, state: 'opened', number: 3 },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out.find((e: any) => e.repo === 'shop').state, 'opened');
    assert.equal(out.find((e: any) => e.repo === 'api').state, 'asked');
  });
  it('reads fields from payload', () => {
    const out = latestPullRequestStates([{ type: 'pull-request', payload: { repo: 'x', state: 'pushed', branch: 'b' } }]);
    assert.equal(out[0].state, 'pushed');
    assert.equal(out[0].branch, 'b');
  });
  it('handles empty input', () => {
    assert.deepEqual(latestPullRequestStates(undefined), []);
  });
});

describe('describePullRequest', () => {
  it('asked: Inbox question and link', () => {
    const r = d({ state: 'asked', files: 5, commits: 2, inboxId: 'i' });
    assert.equal(r.tone, 'info');
    assert.equal(r.title, 'Open a pull request for shop?');
    assert.equal(r.detail, '5 files changed in 2 commit(s) in shop. Approve to push a new branch and open a pull request.');
    assert.deepEqual(r.actions, [{ kind: 'link', label: 'Open Inbox', href: '#/inbox' }]);
  });
  it('declined and available offer Create pull request', () => {
    for (const state of ['declined', 'available']) {
      const r = d({ state });
      assert.equal(r.tone, 'info');
      assert.deepEqual(r.actions, [{ kind: 'button', label: 'Create pull request' }]);
    }
  });
  it('pushing and pushed', () => {
    assert.equal(d({ state: 'pushing', branch: 'portal/x' }).tone, 'info');
    const r = d({ state: 'pushed', branch: 'portal/x' });
    assert.equal(r.tone, 'ok');
    assert.match(r.detail, /portal\/x/);
    assert.equal(r.actions.length, 0);
  });
  it('opened: link to the pull request', () => {
    const r = d({ state: 'opened', number: 42, url: 'https://h/pr/42', title: 'RLP-12: Fix' });
    assert.equal(r.tone, 'ok');
    assert.deepEqual(r.actions, [{ kind: 'link', label: 'Open pull request #42', href: 'https://h/pr/42' }]);
  });
  it('review-started adds a review link', () => {
    const r = d({ state: 'review-started', number: 42, url: 'https://h/pr/42', reviewId: 'rv 1' }, { projectId: 'p1' });
    assert.equal(r.tone, 'ok');
    assert.equal(r.actions.length, 2);
    assert.equal(r.actions[1].href, '#/p/p1/reviews/code/rv%201');
  });
  it('review-failed keeps the pull request and shows the reason', () => {
    const r = d({ state: 'review-failed', number: 42, url: 'https://h/pr/42', error: 'boom' }, { projectId: 'p1' });
    assert.equal(r.tone, 'warn');
    assert.match(r.detail, /boom/);
    assert.equal(r.actions[0].label, 'Open pull request #42');
    assert.equal(r.actions[1].href, '#/p/p1/reviews/code');
  });
  it('failed: no permission text', () => {
    const r = d({ state: 'failed', errorCode: 'no-permission', error: 'denied' });
    assert.equal(r.tone, 'danger');
    assert.equal(r.detail, 'No permission to push to shop. A GitHub token needs repo write access; CodeCommit needs GitPush and CreatePullRequest.');
    assert.deepEqual(r.actions, [{ kind: 'button', label: 'Try again' }]);
  });
  it('failed: pushed but pull request failed', () => {
    const r = d({ state: 'failed', errorCode: 'failed', branch: 'portal/x', error: 'conflict' });
    assert.equal(r.detail, 'The branch portal/x was pushed, but the pull request could not be opened: conflict');
    assert.deepEqual(r.actions, [{ kind: 'button', label: 'Try again' }]);
  });
  it('failed: not supported', () => {
    const r = d({ state: 'failed', errorCode: 'unsupported', branch: 'portal/x', provider: 'Bitbucket' });
    assert.equal(r.tone, 'warn');
    assert.equal(r.detail, 'Pull requests on Bitbucket are not supported yet. The branch portal/x was pushed.');
    assert.equal(r.actions.length, 0);
  });
  it('failed: workspace gone', () => {
    const r = d({ state: 'failed', errorCode: 'no-workspace' });
    assert.equal(r.tone, 'danger');
    assert.equal(r.detail, "The session's saved files could not be restored, so nothing was pushed.");
  });
  it('failed without a branch shows the error and Try again', () => {
    const r = d({ state: 'failed', errorCode: 'failed', error: 'push rejected' });
    assert.equal(r.detail, 'push rejected');
    assert.deepEqual(r.actions, [{ kind: 'button', label: 'Try again' }]);
  });
});


describe('live PR review handoff', () => {
  const ready = { type: 'run.event', workflowId: 'w1', eventType: 'pull-request', payload: { state: 'review-started', reviewId: 'review 1' } };
  it('opens the portal Code review after review creation for the viewed session', () => {
    assert.equal(reviewHandoffHref(ready, 'w1', 'p1'), '#/p/p1/reviews/code/review%201');
  });
  it('ignores replayed history, unrelated sessions and incomplete or failed reviews', () => {
    assert.equal(reviewHandoffHref({ type: 'pull-request', payload: ready.payload }, 'w1', 'p1'), null);
    assert.equal(reviewHandoffHref(ready, 'other', 'p1'), null);
    assert.equal(reviewHandoffHref(ready, 'w1', null), null);
    for (const payload of [{ state: 'opened' }, { state: 'review-failed' }, { state: 'review-started' }, { state: 'review-started', reviewId: ' ' }]) {
      assert.equal(reviewHandoffHref({ ...ready, payload }, 'w1', 'p1'), null);
    }
  });
});


describe('session pull request cards', () => {
  it('omits Inbox approval questions without showing stale states', () => {
    assert.deepEqual(sessionPullRequestCards([
      { ...base, state: 'available' },
      { ...base, state: 'asked', inboxId: 'inbox1' },
    ]), []);
  });
  it('keeps progress, PR links and review results visible', () => {
    for (const state of ['pushing', 'opened', 'review-started', 'review-failed', 'failed']) {
      const cards = sessionPullRequestCards([{ ...base, state }]);
      assert.equal(cards.length, 1);
      assert.equal(cards[0].state, state);
    }
  });
});
