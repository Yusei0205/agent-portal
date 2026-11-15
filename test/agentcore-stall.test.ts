/**
 * A connection to a runner that is dropped without a word (a NAT gateway forgets a quiet connection after 350 seconds and tells neither end)
 * must not leave the portal waiting for ever. The runner writes a keepalive comment line every 20 seconds; the portal treats a minute and
 * a half of silence after the first one as a lost connection, ends the turn with a reason, and keeps working with runners that send none.
 *
 * The real stream reader runs here, against a local server that plays the runner.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { invokeAgentCore, AgentCoreStallError, _setAgentCoreEndpointOverride } from '../server/agent/kiro-agentcore.ts';
import { startKeepalive, KEEPALIVE_MS } from '../agent-runner/src/sse-keepalive.ts';

const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/stallTest-abc123';
const ev = (o: object): string => `data: ${JSON.stringify(o)}\n\n`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the portal against a runner that goes quiet', () => {
  let server: http.Server;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = () => {};
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'PORTAL_AGENTCORE_STALL_MS', 'AWS_PROFILE']) saved[k] = process.env[k];
    process.env.AWS_ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret-for-the-stall-test';
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_PROFILE;
    process.env.PORTAL_AGENTCORE_STALL_MS = '300'; // the real limit is 90 s: the rule is the same, only faster
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    _setAgentCoreEndpointOverride(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });
  after(async () => {
    _setAgentCoreEndpointOverride(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  });
  beforeEach(() => { handler = () => {}; });

  const sse = (res: http.ServerResponse): void => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); };
  const collect = async (signal?: AbortSignal): Promise<{ events: Array<Record<string, unknown>>; error: unknown; ms: number }> => {
    const events: Array<Record<string, unknown>> = [];
    const t0 = Date.now();
    try {
      for await (const e of invokeAgentCore(ARN, 'sess-1', { mode: 'kiro-run', runId: 'r1' }, signal)) events.push(e as unknown as Record<string, unknown>);
      return { events, error: null, ms: Date.now() - t0 };
    } catch (error) {
      return { events, error, ms: Date.now() - t0 };
    }
  };

  it('a runner that sends keepalives and then goes silent is a lost connection: the turn ends with a reason, and the runner is hung up on', async () => {
    let clientGone = false;
    handler = (req, res) => {
      sse(res);
      res.write(': keepalive\n\n');
      res.write(ev({ type: 'text', text: 'working on it' }));
      req.on('close', () => { clientGone = true; });
      // ...and then nothing, with the connection left open: what a dropped connection looks like from here.
    };
    const r = await collect();
    assert.ok(r.error instanceof AgentCoreStallError, `expected a stall error, got ${String(r.error)}`);
    assert.match((r.error as Error).message, /Lost contact with the runner/);
    assert.match((r.error as Error).message, /send a message to carry on/);
    assert.deepEqual(r.events.map((e) => e.text), ['working on it'], 'what arrived before is kept');
    assert.ok(r.ms < 3_000, `ended in ${r.ms} ms, not left waiting`);
    await sleep(100);
    assert.equal(clientGone, true, 'the portal closed its end');
  });

  it('a run that is quiet but alive (keepalives keep coming) is never cut off', async () => {
    handler = async (_req, res) => {
      sse(res);
      res.write(ev({ type: 'text', text: 'start' }));
      for (let i = 0; i < 14; i++) { res.write(': keepalive\n\n'); await sleep(70); } // a second, far past the 300 ms limit
      res.write(ev({ type: 'text', text: 'done' }));
      res.end();
    };
    const r = await collect();
    assert.equal(r.error, null);
    assert.deepEqual(r.events.map((e) => e.text), ['start', 'done']);
    assert.ok(r.ms >= 900, 'it really did stay quiet for longer than the stall limit');
  });

  it('a runner from before keepalives is left alone however long a quiet stretch is (nothing to judge by)', async () => {
    handler = async (_req, res) => {
      sse(res);
      res.write(ev({ type: 'text', text: 'one' }));
      await sleep(900); // three times the limit, and no keepalive was ever seen
      res.write(ev({ type: 'text', text: 'two' }));
      res.end();
    };
    const r = await collect();
    assert.equal(r.error, null, String(r.error));
    assert.deepEqual(r.events.map((e) => e.text), ['one', 'two']);
  });

  it('a stream that ends normally is not reported as a stall, and Stop still ends a silent one', async () => {
    handler = (_req, res) => { sse(res); res.write(': keepalive\n\n'); res.write(ev({ type: 'text', text: 'hi' })); res.end(); };
    const ok = await collect();
    assert.equal(ok.error, null);
    assert.equal(ok.events.length, 1);

    handler = (_req, res) => { sse(res); res.write(': keepalive\n\n'); }; // silent, but the person presses Stop first
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 80);
    const stopped = await collect(ctrl.signal);
    assert.ok(stopped.error && (stopped.error as Error).name === 'AbortError', `Stop is a stop, not a stall: ${String(stopped.error)}`);
  });
});

describe('the runners keep their stream awake', () => {
  const fakeResponse = () => {
    const bus = new EventEmitter();
    const out: string[] = [];
    const res = { writableEnded: false, write: (s: string) => { out.push(s); return true; }, on: (e: 'close', f: () => void) => bus.on(e, f) };
    return { res, out, close: () => bus.emit('close') };
  };

  it('writes a comment line on a timer, and stops when asked, when the response closes, or when it has ended', async () => {
    const a = fakeResponse();
    const stop = startKeepalive(a.res, 20);
    await sleep(110);
    assert.ok(a.out.length >= 3, `lines written: ${a.out.length}`);
    assert.ok(a.out.every((s) => s === ': keepalive\n\n'), 'a comment line, which the portal reads as "still here" and not as an event');
    stop();
    const n = a.out.length;
    await sleep(60);
    assert.equal(a.out.length, n, 'nothing after stop');

    const b = fakeResponse();
    startKeepalive(b.res, 20);
    await sleep(50);
    b.close();
    const m = b.out.length;
    await sleep(60);
    assert.equal(b.out.length, m, 'nothing after the response closed');

    const c = fakeResponse();
    startKeepalive(c.res, 20);
    c.res.writableEnded = true;
    await sleep(60);
    assert.equal(c.out.length, 0, 'never writes to a finished response');
    assert.ok(KEEPALIVE_MS <= 30_000 && KEEPALIVE_MS * 10 < 350_000, 'well inside the 350 s a NAT gateway waits before it forgets a quiet connection');
  });

  it('the three runners carry the same helper (they cannot share source files), and each one starts it on its run stream', () => {
    const copies = ['agent-runner', 'kiro-runner', 'codex-runner'].map((d) => fs.readFileSync(`${d}/src/sse-keepalive.ts`, 'utf8').replace(/\r\n/g, '\n'));
    assert.equal(copies[1], copies[0]);
    assert.equal(copies[2], copies[0]);
    for (const f of ['agent-runner/src/index.ts', 'kiro-runner/src/index.ts', 'codex-runner/src/service.ts']) {
      const src = fs.readFileSync(f, 'utf8');
      assert.match(src, /import \{ startKeepalive \} from '\.\/sse-keepalive\.(js|ts)'/, f);
      assert.match(src, /startKeepalive\(res\)/, f);
    }
  });
});
