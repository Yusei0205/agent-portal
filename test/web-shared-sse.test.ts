/**
 * Live updates on the local portal (web/src/lib/events.js) share one EventSource per stream.
 *
 * The local portal speaks HTTP/1.1, where the browser keeps at most six connections to one host across all tabs. The
 * session page used to open a project stream per component (page, cat, flow strip, agents), which with the global and
 * run streams used every connection, so the file explorer's request was never sent and spun forever.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

class FakeEventSource {
  static all: FakeEventSource[] = [];
  closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeEventSource.all.push(this); }
  close(): void { this.closed = true; }
  emit(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
  get open(): boolean { return !this.closed; }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
let seq = 0;

type Events = {
  subscribeProject: (id: string, fn: (e: any) => void) => () => void;
  subscribeGlobal: (fn: (e: any) => void) => () => void;
  _sharedStreamCount: () => number;
};

async function freshModule(): Promise<Events> {
  seq += 1;
  // @ts-ignore a plain JavaScript module (no declaration file); the query string gives each test its own state
  return import(`../web/src/lib/events.js?case=${seq}`);
}

describe('shared live-update streams', () => {
  const saved = { fetch: globalThis.fetch, es: (globalThis as any).EventSource };

  beforeEach(() => {
    FakeEventSource.all = [];
    (globalThis as any).EventSource = FakeEventSource;
    // The local portal has no AppSync, so the page falls back to Server-Sent Events.
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ enabled: false }) })) as any;
  });

  afterEach(() => {
    mock.timers.reset();
    globalThis.fetch = saved.fetch;
    (globalThis as any).EventSource = saved.es;
  });

  it('opens one connection for many subscribers to the same project and fans events out to all of them', async () => {
    const ev = await freshModule();
    const got: string[] = [];
    const offs = ['page', 'cat', 'flow', 'agents'].map((name) => ev.subscribeProject('p1', (e) => got.push(`${name}:${e.type}`)));
    ev.subscribeGlobal(() => undefined);
    await flush();

    const open = FakeEventSource.all.filter((s) => s.open);
    assert.equal(open.length, 2, 'one project stream and one global stream');
    const project = open.find((s) => s.url.includes('/projects/p1/events'))!;
    project.emit({ type: 'workflow.updated' });
    assert.deepEqual(got.sort(), ['agents:workflow.updated', 'cat:workflow.updated', 'flow:workflow.updated', 'page:workflow.updated']);

    offs[0]();
    offs[1]();
    offs[2]();
    assert.equal(project.closed, false, 'still open while one subscriber is left');
    offs[3]();
    assert.equal(project.closed, true, 'closed once the last subscriber leaves');
    assert.equal(ev._sharedStreamCount(), 1);
  });

  it('reconnects the shared stream after an error and keeps delivering to every subscriber', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const ev = await freshModule();
    const got: number[] = [];
    ev.subscribeProject('p2', () => got.push(1));
    ev.subscribeProject('p2', () => got.push(2));
    await flush();
    assert.equal(FakeEventSource.all.length, 1);

    FakeEventSource.all[0].onerror?.();
    assert.equal(FakeEventSource.all[0].closed, true);
    mock.timers.tick(3000);
    assert.equal(FakeEventSource.all.length, 2);
    FakeEventSource.all[1].emit({ type: 'x' });
    assert.deepEqual(got.sort(), [1, 2]);
  });

  it('one failing listener does not stop the others', async () => {
    const ev = await freshModule();
    const got: string[] = [];
    ev.subscribeProject('p3', () => { throw new Error('boom'); });
    ev.subscribeProject('p3', (e) => got.push(e.type));
    await flush();
    const errors = mock.method(console, 'error', () => undefined);
    FakeEventSource.all[0].emit({ type: 'ok' });
    errors.mock.restore();
    assert.deepEqual(got, ['ok']);
  });
});
