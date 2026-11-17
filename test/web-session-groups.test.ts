import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module shared with the web app
import { groupSessions, parseStarred, toggleStarred, statusBucket } from '../web/src/lib/session-groups.js';

const day = (iso: string) => (iso || '').slice(0, 10);
const w = (id: string, status: string, engine = 'kiro', updated_at = '2026-11-17T10:00:00Z') => ({ id, status, engine, updated_at });

describe('session groups', () => {
  // newest first, as the list comes from the server
  const list = [w('a', 'running'), w('c', 'failed'), w('b', 'done', 'codex', '2026-11-16T10:00:00Z'), w('d', 'done', 'kiro', '2026-11-16T09:00:00Z')];

  it('groups by day with active sessions first', () => {
    const g = groupSessions(list, { dayLabel: day });
    assert.deepEqual(g.map((x: any) => x.label), ['Active', '2026-11-17', '2026-11-16']);
    assert.deepEqual(g[2].items.map((x: any) => x.id), ['b', 'd']);
  });

  it('puts starred sessions in their own group on top and not again below', () => {
    const g = groupSessions(list, { dayLabel: day, starred: ['b', 'zzz'] });
    assert.equal(g[0].label, 'Starred');
    assert.deepEqual(g[0].items.map((x: any) => x.id), ['b']);
    assert.equal(g.flatMap((x: any) => x.items).filter((x: any) => x.id === 'b').length, 1);
  });

  it('groups by status in a fixed order and treats paused as stopped', () => {
    const g = groupSessions([...list, w('e', 'paused')], { mode: 'status', dayLabel: day });
    assert.deepEqual(g.map((x: any) => x.label), ['Running', 'Failed', 'Completed', 'Stopped']);
    assert.equal(statusBucket(w('x', 'pending')).key, 'running');
  });

  it('groups by engine, sorted by name', () => {
    const g = groupSessions(list, { mode: 'engine', dayLabel: day, engineLabel: (e: string) => e.toUpperCase() });
    assert.deepEqual(g.map((x: any) => x.label), ['CODEX', 'KIRO']);
  });

  it('reads and toggles the stored star list safely', () => {
    assert.deepEqual(parseStarred('["a","b"]'), ['a', 'b']);
    assert.deepEqual(parseStarred('{"a":1}'), []);
    assert.deepEqual(parseStarred('not json'), []);
    assert.deepEqual(parseStarred(null), []);
    assert.deepEqual(toggleStarred(['a'], 'b'), ['a', 'b']);
    assert.deepEqual(toggleStarred(['a', 'b'], 'a'), ['b']);
  });
});
