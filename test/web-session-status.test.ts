import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module shared with the web app
import { sessionStatusPill, statusCounts } from '../web/src/lib/session-status.js';

describe('session status', () => {
  it('names each state and has no pill for an unknown one', () => {
    assert.deepEqual(sessionStatusPill({ status: 'running' }), { label: 'Running', tone: 'live' });
    assert.deepEqual(sessionStatusPill({ status: 'done' }), { label: 'Completed', tone: 'ok' });
    assert.deepEqual(sessionStatusPill({ status: 'failed' }), { label: 'Failed', tone: 'bad' });
    assert.equal(sessionStatusPill({ status: 'weird' }), null);
    assert.equal(sessionStatusPill(null), null);
  });
  it('counts running (including starting) and failed sessions', () => {
    assert.deepEqual(statusCounts([{ status: 'running' }, { status: 'pending' }, { status: 'failed' }, { status: 'done' }]), { running: 2, failed: 1 });
    assert.deepEqual(statusCounts(undefined), { running: 0, failed: 0 });
  });
});

// @ts-expect-error plain JS module shared with the web app
import { runElapsedMs, parseMemoryNote, appendMemoryNote, parseShellCommand } from '../web/src/lib/session-status.js';

describe('run elapsed time', () => {
  it('is the span of a finished run and runs up to now for a running one', () => {
    assert.equal(runElapsedMs({ started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:24Z' }), 84_000);
    assert.equal(runElapsedMs({ started_at: '2026-01-01T00:00:00Z', finished_at: null }, Date.parse('2026-01-01T00:00:10Z')), 10_000);
    assert.equal(runElapsedMs({ started_at: null }), null);
    assert.equal(runElapsedMs(null), null);
  });
});

describe('# memory notes and ! shell commands', () => {
  it('"#note" is a memory note; headings and double hashes are ordinary messages', () => {
    assert.equal(parseMemoryNote('#always use pnpm'), 'always use pnpm');
    assert.equal(parseMemoryNote('# A heading'), null);
    assert.equal(parseMemoryNote('## sub'), null);
    assert.equal(parseMemoryNote('no hash'), null);
    assert.equal(parseMemoryNote('#'), null);
  });
  it('adds the note as a bullet at the end of the guide', () => {
    assert.equal(appendMemoryNote('', 'use pnpm'), '- use pnpm\n');
    assert.equal(appendMemoryNote('# Guide\n\nText\n\n', 'use pnpm'), '# Guide\n\nText\n- use pnpm\n');
    assert.equal(appendMemoryNote('x', 'a\nb'), 'x\n- a b\n');
  });
  it('"!cmd" is a shell command; a lone "!" is not', () => {
    assert.equal(parseShellCommand('!ls -la'), 'ls -la');
    assert.equal(parseShellCommand('! git status'), 'git status');
    assert.equal(parseShellCommand('!'), null);
    assert.equal(parseShellCommand('hello!'), null);
  });
});
