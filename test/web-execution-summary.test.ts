/**
 * The Execution View's numbers: task list, tool calls, files changed, time.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module shared with the web app
import { summarizeExecution, latestTodos, fileOfToolCall } from '../web/src/lib/execution-summary.js';

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const call = (id: string, name: string, input: unknown, s: number, end?: { s: number; status?: string }) => ({
  id, type: 'tool-start', created_at: at(s), payload: { toolName: name, toolInput: input },
  _end: end ? { type: 'tool-end', created_at: at(end.s), payload: { status: end.status ?? 'ok' } } : null,
});

describe('summarizeExecution', () => {
  const events = [
    { id: 'a', type: 'assistant-text', created_at: at(0), payload: { text: 'hi' } },
    call('1', 'Read', { file_path: 'src/a.ts' }, 1, { s: 2 }),
    call('2', 'Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }, 3, { s: 5 }),
    call('3', 'Edit', { file_path: 'src/b.ts' }, 6, { s: 7 }),
    call('4', 'Edit', { file_path: 'src/a.ts' }, 8, { s: 9 }),
    call('5', 'Bash', { command: 'npm test' }, 10, { s: 20, status: 'failed' }),
    call('6', 'Bash', 'npm run build', 21),
  ];
  const sum = summarizeExecution(events);

  it('counts calls by state', () => {
    assert.deepEqual(sum.counts, { total: 6, running: 1, failed: 1, done: 4 });
  });
  it('measures duration of finished calls only, and the whole span', () => {
    assert.equal(sum.calls[1].durationMs, 2000);
    assert.equal(sum.calls[5].durationMs, null);
    assert.equal(sum.elapsedMs, 21_000);
  });
  it('groups by tool, most used first', () => {
    assert.deepEqual(sum.byTool.map((t: { name: string; count: number }) => [t.name, t.count]), [['Edit', 3], ['Bash', 2], ['Read', 1]]);
    assert.equal(sum.byTool.find((t: { name: string }) => t.name === 'Bash').failed, 1);
  });
  it('lists files that were written (not just read), most edited first', () => {
    assert.deepEqual(sum.files, [{ path: 'src/a.ts', edits: 2 }, { path: 'src/b.ts', edits: 1 }]);
  });
  it('is empty and safe with no events', () => {
    const e = summarizeExecution([]);
    assert.deepEqual(e.counts, { total: 0, running: 0, failed: 0, done: 0 });
    assert.equal(e.elapsedMs, null);
    assert.equal(e.todos, null);
  });
});

describe('latestTodos', () => {
  it('reads the newest TodoWrite list', () => {
    const events = [
      call('1', 'TodoWrite', { todos: [{ content: 'old', status: 'pending' }] }, 1),
      call('2', 'TodoWrite', { todos: [
        { content: 'Plan', status: 'completed' }, { content: 'Build', status: 'in_progress' }, { content: 'Test', status: 'pending' },
      ] }, 2),
    ];
    assert.deepEqual(latestTodos(events), {
      items: [{ text: 'Plan', status: 'done' }, { text: 'Build', status: 'active' }, { text: 'Test', status: 'pending' }],
      done: 1, total: 3,
    });
  });
  it('accepts the input as a JSON string and ignores other tools', () => {
    assert.equal(latestTodos([call('1', 'Bash', { command: 'ls' }, 1)]), null);
    const t = latestTodos([call('1', 'TodoWrite', JSON.stringify({ todos: [{ content: 'A', status: 'done' }] }), 1)]);
    assert.equal(t?.done, 1);
  });
});

describe('fileOfToolCall', () => {
  it('finds the file of write tools and nothing for the rest', () => {
    assert.equal(fileOfToolCall('Write', { file_path: 'a.md' }), 'a.md');
    assert.equal(fileOfToolCall('str_replace_editor', { path: 'b.ts' }), 'b.ts');
    assert.equal(fileOfToolCall('Edit', '{"filePath":"c.ts"}'), 'c.ts');
    assert.equal(fileOfToolCall('Read', { file_path: 'a.md' }), '');
    assert.equal(fileOfToolCall('Edit', 'not json'), '');
  });
});
