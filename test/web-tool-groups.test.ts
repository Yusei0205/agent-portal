import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module shared with the web app
import { groupToolRuns, groupStats, lastPlanId } from '../web/src/lib/tool-groups.js';

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const tool = (id: string, name: string, s: number, end?: { s: number; status?: string }, input: unknown = {}) => ({
  id, type: 'tool-start', created_at: at(s), payload: { toolName: name, toolInput: input },
  _end: end ? { type: 'tool-end', created_at: at(end.s), payload: { status: end.status ?? 'ok' } } : null,
});
const text = (id: string, s: number) => ({ id, type: 'assistant-text', created_at: at(s), payload: { text: 'x' } });

describe('groupToolRuns', () => {
  it('groups two or more tool calls in a row and leaves a lone call alone', () => {
    const out = groupToolRuns([text('a', 0), tool('1', 'Read', 1, { s: 2 }), tool('2', 'Bash', 3, { s: 4 }), text('b', 5), tool('3', 'Read', 6, { s: 7 }), text('c', 8)]);
    assert.deepEqual(out.map((e: { type: string }) => e.type), ['assistant-text', 'tool-group', 'assistant-text', 'tool-start', 'assistant-text']);
    assert.equal(out[1].calls.length, 2);
    assert.equal(out[1].id, 'group:1');
  });
  it('turns a task-list update into a plan card that breaks the group', () => {
    const plan = tool('p', 'TodoWrite', 3, { s: 3 }, { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }] });
    const out = groupToolRuns([tool('1', 'Read', 1), tool('2', 'Read', 2), plan, tool('4', 'Bash', 4), tool('5', 'Bash', 5)]);
    assert.deepEqual(out.map((e: { type: string }) => e.type), ['tool-group', 'tool-start', 'tool-group']);
    assert.deepEqual(out[1]._plan, { items: [{ text: 'A', status: 'done' }, { text: 'B', status: 'pending' }], done: 1, total: 2 });
    assert.equal(lastPlanId(out), 'p');
  });
  it('is empty-safe and finds no plan when there is none', () => {
    assert.deepEqual(groupToolRuns([]), []);
    assert.equal(lastPlanId(groupToolRuns([text('a', 0)])), null);
  });
});

describe('groupStats', () => {
  it('counts failed and running, and times a finished group', () => {
    const s = groupStats([tool('1', 'Read', 1, { s: 2 }), tool('2', 'Read', 3, { s: 9 }), tool('3', 'Bash', 10, { s: 12, status: 'failed' })]);
    assert.equal(s.total, 3);
    assert.equal(s.failed, 1);
    assert.equal(s.running, 0);
    assert.equal(s.durationMs, 11_000);
    assert.deepEqual(s.names, [{ name: 'Read', count: 2 }, { name: 'Bash', count: 1 }]);
  });
  it('has no duration while a call is still running', () => {
    const s = groupStats([tool('1', 'Read', 1, { s: 2 }), tool('2', 'Bash', 3)]);
    assert.equal(s.running, 1);
    assert.equal(s.durationMs, null);
  });
});
