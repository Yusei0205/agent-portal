import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleScheduledEvent, isJobName, JOBS } from '../server/scheduled-jobs.ts';

const SECRET = 'test-origin-secret';
let calls = 0;
(JOBS as Record<string, () => Promise<void>>)['idle-stop'] = async () => { calls += 1; };

const server = http.createServer((req, res) => { void handleScheduledEvent(req, res, SECRET); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const post = (body: unknown, raw = false) =>
  fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? String(body) : JSON.stringify(body) });

test('valid secret runs the job', async () => {
  const r = await post({ job: 'idle-stop', secret: SECRET });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { job: string }).job, 'idle-stop');
  assert.equal(calls, 1);
});

test('wrong or missing secret is rejected and runs nothing', async () => {
  assert.equal((await post({ job: 'idle-stop', secret: 'nope' })).status, 403);
  assert.equal((await post({ job: 'idle-stop' })).status, 403);
  assert.equal(calls, 1);
});

test('unknown job and malformed body are rejected', async () => {
  assert.equal((await post({ job: 'rm-rf', secret: SECRET })).status, 400);
  assert.equal((await post('not json', true)).status, 400);
});

test('only POST is accepted and a missing server secret closes the endpoint', async () => {
  assert.equal((await fetch(base)).status, 403);
  const closed = http.createServer((req, res) => { void handleScheduledEvent(req, res, undefined); });
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const port = (closed.address() as AddressInfo).port;
  const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ job: 'idle-stop', secret: '' }) });
  assert.equal(r.status, 403);
  closed.close();
});

test('job names are whitelisted', () => {
  assert.equal(isJobName('idle-stop'), true);
  assert.equal(isJobName('constructor'), false);
  assert.equal(isJobName(undefined), false);
});
