/** The cat panel's assistant helpers: when to ask the model, what history to send, how errors read. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module without type declarations
import { shouldAsk, trimHistory, describeAssistantError } from '../web/src/lib/cat-assistant.js';

describe('shouldAsk', () => {
  it('asks when nothing matched and the text is long enough', () => {
    assert.equal(shouldAsk({ kind: 'none' }, 'why did my build fail'), true);
  });
  it('keeps navigating on an exact match', () => {
    assert.equal(shouldAsk({ kind: 'action' }, 'inbox'), false);
    assert.equal(shouldAsk({ kind: 'page' }, 'why did my build fail'), false);
  });
  it('does not ask for under 3 characters', () => {
    assert.equal(shouldAsk({ kind: 'none' }, 'hi'), false);
    assert.equal(shouldAsk({ kind: 'none' }, 'hey'), true);
  });
});

describe('trimHistory', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, role: i % 2 === 0 ? 'me' : 'cat', text: `m${i}` }));
  it('returns the last 8 messages in order, as role and text only', () => {
    const out = trimHistory(twelve);
    assert.equal(out.length, 8);
    assert.deepEqual(out.map((m: { text: string }) => m.text), ['m4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11']);
    assert.deepEqual(Object.keys(out[0]).sort(), ['role', 'text']);
  });
  it('excludes notices, pending and error messages', () => {
    const out = trimHistory([
      { id: 1, role: 'me', text: 'a' },
      { id: 2, role: 'cat', text: 'notice', href: '#/inbox' },
      { id: 3, role: 'cat', text: '', pending: true },
      { id: 4, role: 'cat', text: 'oops', error: true },
      { id: 5, role: 'cat', text: 'b' },
    ]);
    assert.deepEqual(out.map((m: { text: string }) => m.text), ['a', 'b']);
  });
  it('excludes a question flagged as unanswered after a failed request', () => {
    const out = trimHistory([{ id: 1, role: 'me', text: 'q1', error: true }, { id: 2, role: 'cat', text: 'oops', error: true }, { id: 3, role: 'me', text: 'q2' }]);
    assert.deepEqual(out.map((m: { text: string }) => m.text), ['q2']);
  });
  it('cuts long text to 600 characters', () => {
    const out = trimHistory([{ id: 1, role: 'me', text: 'x'.repeat(2000) }]);
    assert.equal(out[0].text.length, 600);
  });
  it('excludes the greeting (id 0)', () => {
    const out = trimHistory([{ id: 0, role: 'cat', text: 'Meow!' }, { id: 1, role: 'me', text: 'q' }]);
    assert.deepEqual(out.map((m: { text: string }) => m.text), ['q']);
  });
});

describe('describeAssistantError', () => {
  it('words each code', () => {
    assert.equal(describeAssistantError({ status: 402, data: { code: 'no_sign_in' } }), 'Connect a sign-in in Agent sign-ins to chat with me.');
    assert.equal(describeAssistantError({ status: 429, data: { code: 'rate_limited' } }), "That's a lot of questions at once. Try again in a minute.");
    assert.equal(describeAssistantError({ status: 400, data: { code: 'too_long' } }), "That's too long for me. Try a shorter question.");
    assert.equal(describeAssistantError({ status: 502, data: { code: 'failed' } }), 'I couldn\'t answer that just now. Please try again.');
  });
  it('falls back for anything else', () => {
    assert.equal(describeAssistantError({ status: 500 }), "I couldn't answer that just now. Please try again.");
    assert.equal(describeAssistantError({}), "I couldn't answer that just now. Please try again.");
  });
});
