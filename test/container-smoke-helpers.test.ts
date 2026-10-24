/**
 * Unit tests for pure helper functions in scripts/container-smoke.mjs.
 *
 * These functions are exported from the smoke script so they can be tested
 * without Docker running.  No I/O, no spawning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import lets TypeScript compile while the .mjs file stays plain JS.
// @ts-expect-error — plain .mjs has no type declarations; the exported pure functions are tested here.
const smoke = await import('../scripts/container-smoke.mjs');

test('makeRunId: returns a project name and a volume name with distinct short suffixes', () => {
  const { project, volume } = smoke.makeRunId();
  assert.match(project, /^smoke-[a-z0-9]{6}$/);
  assert.match(volume, /^smoke-data-[a-z0-9]{6}$/);
  // Each call returns a different suffix.
  const { project: p2 } = smoke.makeRunId();
  assert.notEqual(project, p2);
});

test('parseSseChunk: empty string yields no messages', () => {
  assert.deepEqual(smoke.parseSseChunk(''), []);
});

test('parseSseChunk: a single data-only block', () => {
  const chunk = 'data: {"hello":"world"}\n\n';
  const msgs = smoke.parseSseChunk(chunk);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].event, 'message');
  assert.equal(msgs[0].data, '{"hello":"world"}');
});

test('parseSseChunk: event + data block', () => {
  const chunk = 'event: tool.install.progress\ndata: {"line":"Installing…"}\n\n';
  const msgs = smoke.parseSseChunk(chunk);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].event, 'tool.install.progress');
  assert.equal(msgs[0].data, '{"line":"Installing…"}');
});

test('parseSseChunk: multiple blocks', () => {
  const chunk = [
    'event: a\ndata: 1\n',
    '\n',
    'event: b\ndata: 2\n',
    '\n',
  ].join('');
  const msgs = smoke.parseSseChunk(chunk);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].event, 'a');
  assert.equal(msgs[1].event, 'b');
});

test('parseSseChunk: block with no event defaults to "message"', () => {
  const chunk = 'data: hello\n\n';
  const msgs = smoke.parseSseChunk(chunk);
  assert.equal(msgs[0].event, 'message');
});

test('extractWorkBranch: returns branch string from push response', () => {
  assert.equal(smoke.extractWorkBranch({ branch: 'agent/smoke-run', pushed: true }), 'agent/smoke-run');
  assert.equal(smoke.extractWorkBranch({}), null);
  assert.equal(smoke.extractWorkBranch(null), null);
  assert.equal(smoke.extractWorkBranch(undefined), null);
});

test('isTerminalStatus: identifies completed, failed, stopped', () => {
  assert.equal(smoke.isTerminalStatus('completed'), true);
  assert.equal(smoke.isTerminalStatus('failed'), true);
  assert.equal(smoke.isTerminalStatus('stopped'), true);
  assert.equal(smoke.isTerminalStatus('running'), false);
  assert.equal(smoke.isTerminalStatus('queued'), false);
  assert.equal(smoke.isTerminalStatus('waiting'), false);
  assert.equal(smoke.isTerminalStatus(undefined), false);
  assert.equal(smoke.isTerminalStatus(''), false);
});
