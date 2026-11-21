/**
 * The browser's live-update connection (web/src/lib/realtime.js): the token lasts an hour, so a page left open longer must
 * get a new one before it subscribes to a new run's channel, and a refused subscribe is retried with a fresh token.
 * (Before this, such a page showed no updates for runs that started after the hour while the runs went on.)
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

type Sent = Record<string, any>;

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: Sent[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string, public protocols: string[]) { FakeSocket.all.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.onclose?.(); }
  receive(msg: Sent): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
let seq = 0;

type Realtime = { subscribeChannel: (channel: string, fn: (e: unknown) => void) => () => void };

async function freshModule(): Promise<Realtime> {
  seq += 1;
  // @ts-ignore a plain JavaScript module (no declaration file); the query string gives each test its own copy and state
  return import(`../web/src/lib/realtime.js?case=${seq}`);
}

describe('realtime subscriptions on a long-open page', () => {
  let tokens = 0;
  const saved = { fetch: globalThis.fetch, ws: (globalThis as any).WebSocket };

  beforeEach(() => {
    FakeSocket.all = [];
    tokens = 0;
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    (globalThis as any).WebSocket = FakeSocket;
    globalThis.fetch = (async () => {
      tokens += 1;
      return { ok: true, json: async () => ({ enabled: true, httpDomain: 'http.example', realtimeDomain: 'rt.example', token: `T${tokens}`, expiresIn: 3600 }) };
    }) as any;
  });

  afterEach(() => {
    mock.timers.reset();
    globalThis.fetch = saved.fetch;
    (globalThis as any).WebSocket = saved.ws;
  });

  async function connected(rt: Realtime, channel: string): Promise<FakeSocket> {
    rt.subscribeChannel(channel, () => undefined);
    await flush(); await flush();
    const socket = FakeSocket.all[0];
    socket.onopen?.();
    socket.receive({ type: 'connection_ack' });
    await flush(); await flush();
    return socket;
  }

  const subscribes = (s: FakeSocket): Sent[] => s.sent.filter((m) => m.type === 'subscribe');

  it('subscribes to the first channel with the token it connected with', async () => {
    const rt = await freshModule();
    const socket = await connected(rt, '/project/p1');
    assert.equal(subscribes(socket).length, 1);
    assert.equal(subscribes(socket)[0].authorization.Authorization, 'T1');
  });

  it('gets a new token before subscribing to a new run channel after the first one is close to expiring', async () => {
    const rt = await freshModule();
    const socket = await connected(rt, '/project/p1');
    mock.timers.tick(3500 * 1000); // 58 minutes later: inside the 5-minute renewal window
    rt.subscribeChannel('/run/r2', () => undefined);
    await flush(); await flush();
    const run = subscribes(socket).find((m) => m.channel === '/run/r2');
    assert.ok(run, 'the new channel was subscribed');
    assert.equal(run!.authorization.Authorization, 'T2', 'with a renewed token, not the hour-old one');
  });

  it('retries a refused subscribe with a new token, and stops after a few tries', async () => {
    const rt = await freshModule();
    const socket = await connected(rt, '/project/p1');
    rt.subscribeChannel('/run/r3', () => undefined);
    await flush(); await flush();
    const first = subscribes(socket).find((m) => m.channel === '/run/r3')!;
    assert.equal(first.authorization.Authorization, 'T1');

    socket.receive({ type: 'subscribe_error', id: first.id, errors: [{ errorType: 'UnauthorizedException' }] });
    mock.timers.tick(2000);
    await flush(); await flush();
    const again = subscribes(socket).filter((m) => m.channel === '/run/r3');
    assert.equal(again.length, 2, 'asked again');
    assert.equal(again[1].authorization.Authorization, 'T2', 'with a fresh token');

    // A channel that is always refused is not retried for ever.
    for (let i = 0; i < 12; i += 1) {
      const last = subscribes(socket).filter((m) => m.channel === '/run/r3').pop()!;
      socket.receive({ type: 'subscribe_error', id: last.id });
      mock.timers.tick(10_000);
      await flush(); await flush();
    }
    assert.ok(subscribes(socket).filter((m) => m.channel === '/run/r3').length <= 7, 'gives up after a few tries');
  });

  it('delivers events for a channel once subscribed, and forgets a channel that was unsubscribed before the token came back', async () => {
    const rt = await freshModule();
    const got: unknown[] = [];
    const socket = await connected(rt, '/project/p1');
    const un = rt.subscribeChannel('/run/r4', (e: unknown) => got.push(e));
    await flush(); await flush();
    const sub = subscribes(socket).find((m) => m.channel === '/run/r4')!;
    socket.receive({ type: 'subscribe_success', id: sub.id });
    socket.receive({ type: 'data', id: sub.id, event: JSON.stringify({ type: 'run.event', n: 1 }) });
    assert.deepEqual(got, [{ type: 'run.event', n: 1 }]);
    un();
    socket.receive({ type: 'data', id: sub.id, event: JSON.stringify({ n: 2 }) });
    assert.equal(got.length, 1, 'nothing after unsubscribe');
  });
});
