/**
 * A list read from an eventually consistent index can leave out something created a moment ago: the page keeps what it
 * knows exists until the server's list has it, and reads again a few times after a change.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module without type declarations
import { createFreshList, createSettledReload } from '../web/src/lib/fresh-list.js';

type Item = { id: string; title?: string };
const ids = (list: Item[]) => list.map((i) => i.id);

describe('fresh list', () => {
  it('puts a just-created item on top until the server list has it', () => {
    const fresh = createFreshList(60_000, () => 1000);
    fresh.add({ id: 'new', title: 'New' });
    assert.deepEqual(ids(fresh.merge([{ id: 'a' }, { id: 'b' }])), ['new', 'a', 'b']);
    assert.deepEqual(ids(fresh.merge([{ id: 'a' }])), ['new', 'a'], 'still kept on the next read');
    const caught: Item[] = fresh.merge([{ id: 'new', title: 'From server' }, { id: 'a' }]);
    assert.deepEqual(ids(caught), ['new', 'a']);
    assert.equal(caught[0].title, 'From server', 'the server copy wins once it is listed');
    assert.deepEqual(ids(fresh.merge([{ id: 'a' }])), ['a'], 'and it is forgotten after that');
  });

  it('gives up after the time limit, and forgets deleted items', () => {
    let t = 0;
    const fresh = createFreshList(60_000, () => t);
    fresh.add({ id: 'x' }); fresh.add({ id: 'gone' });
    fresh.remove('gone');
    assert.deepEqual(ids(fresh.merge([])), ['x']);
    t = 61_000;
    assert.deepEqual(fresh.merge([]), [], 'a session that never appeared is not shown for ever');
  });

  it('reads again after each delay, and restarting replaces the waiting reads', async () => {
    let n = 0;
    const reload = createSettledReload(() => { n++; }, [5, 15, 30]);
    reload();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(n, 3);
    reload(); reload();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(n, 6, 'restarting does not double the reads');
    reload(); reload.cancel();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(n, 6);
  });
});
