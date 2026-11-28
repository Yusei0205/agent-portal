import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module shared with the web app
import { shortenTitle, sessionTitle, hasOwnTitle, SHORT_TITLE_MAX } from '../web/src/lib/session-title.js';

describe('short session titles', () => {
  it('uses the title the user set, as it is', () => {
    assert.equal(sessionTitle({ id: 'abcdef123', title: ' Fix login ', goal: 'a long goal' }), 'Fix login');
    assert.equal(hasOwnTitle({ title: 'x' }), true);
    assert.equal(hasOwnTitle({ title: '  ', goal: 'g' }), false);
  });
  it('without a title takes the first line of the goal, cut at a word', () => {
    const goal = 'Add a usage panel to the session status bar that shows the plan limits\nsecond line';
    const t = sessionTitle({ id: 'abcdef123', goal });
    assert.ok(t.length <= SHORT_TITLE_MAX, t);
    assert.ok(t.endsWith('…'));
    assert.ok(!t.includes('\n'));
    assert.equal(shortenTitle('Short one'), 'Short one');
  });
  it('falls back to the session id', () => {
    assert.equal(sessionTitle({ id: 'abcdef1234' }), 'Session abcdef12');
  });
});
