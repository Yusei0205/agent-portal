/**
 * Live events keep their order: the server sends a channel's events one request after another (they were sent in parallel
 * and arrived scrambled), and the browser keeps a run's events sorted by id.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { publishToChannel, flushRealtime, _setBatchPublisher } from '../server/realtime.ts';
// @ts-expect-error: plain JS module without type declarations
import { insertRunEvent } from '../web/src/lib/runEventOrder.js';

const saved = process.env.PORTAL_EVENTS_HTTP_DOMAIN;
afterEach(() => {
  _setBatchPublisher(null);
  if (saved === undefined) delete process.env.PORTAL_EVENTS_HTTP_DOMAIN; else process.env.PORTAL_EVENTS_HTTP_DOMAIN = saved;
});

describe('server: publishing keeps the order of a channel', () => {
  it('delivers 40 events across several flushes in the order they were published, even when requests take different times', async () => {
    process.env.PORTAL_EVENTS_HTTP_DOMAIN = 'events.test';
    const delivered: number[] = [];
    let running = 0;
    let maxRunning = 0;
    _setBatchPublisher(async (_channel, events) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      // Earlier requests are slower: sent in parallel they would finish last.
      await new Promise((r) => setTimeout(r, 30 - Math.min(25, delivered.length)));
      for (const e of events) delivered.push((JSON.parse(e) as { n: number }).n);
      running -= 1;
    });
    for (let n = 0; n < 40; n++) {
      publishToChannel('/run/r1', { n });
      if (n % 8 === 7) await new Promise((r) => setTimeout(r, 60)); // lets a flush start while the previous one may still be running
    }
    await flushRealtime();
    // flushRealtime waits for in-flight flushes; give a queued one time to finish
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(delivered, Array.from({ length: 40 }, (_, n) => n));
    assert.equal(maxRunning, 1, 'one request at a time per channel');
  });

  it('channels do not wait for each other', async () => {
    process.env.PORTAL_EVENTS_HTTP_DOMAIN = 'events.test';
    let running = 0;
    let maxRunning = 0;
    _setBatchPublisher(async () => {
      running += 1; maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 40));
      running -= 1;
    });
    publishToChannel('/run/a', { n: 1 });
    publishToChannel('/run/b', { n: 1 });
    await flushRealtime();
    assert.equal(maxRunning, 2);
  });
});

describe('browser: insertRunEvent', () => {
  const ids = (list: Array<{ id?: number }>) => list.map((e) => e.id);

  it('puts events in id order whatever order they arrive in', () => {
    let list: Array<{ id?: number }> = [];
    for (const id of [3, 1, 2, 5, 4, 6]) list = insertRunEvent(list, { id });
    assert.deepEqual(ids(list), [1, 2, 3, 4, 5, 6]);
  });

  it('appends in the common case and puts an event without an id last', () => {
    let list: Array<{ id?: number }> = [{ id: 1 }, { id: 2 }];
    list = insertRunEvent(list, { id: 3 });
    list = insertRunEvent(list, {});
    list = insertRunEvent(list, { id: 4 });
    assert.deepEqual(ids(list), [1, 2, 3, undefined, 4]);
  });

  it('accepts ids that arrive as strings and does not change the original array', () => {
    const original = [{ id: 1 }, { id: 3 }];
    const next = insertRunEvent(original, { id: '2' });
    assert.deepEqual(original, [{ id: 1 }, { id: 3 }]);
    assert.deepEqual(next.map((e: { id: number | string }) => Number(e.id)), [1, 2, 3]);
  });
});
