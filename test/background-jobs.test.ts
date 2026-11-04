/**
 * Background jobs: local setImmediate, Lambda self-invoke, inline fallback, and dispatch from /internal/events.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  registerBackgroundJob, runInBackground, _setLambdaInvoker, hasBackgroundJob,
} from '../server/background-jobs.ts';
import { handleScheduledEvent } from '../server/scheduled-jobs.ts';

const seen: Array<Record<string, unknown>> = [];
registerBackgroundJob('test-job', async (args) => { seen.push(args); });

const savedEnv = { fn: process.env.AWS_LAMBDA_FUNCTION_NAME, sec: process.env.PORTAL_ORIGIN_SECRET };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  seen.length = 0;
  _setLambdaInvoker(null);
  for (const [k, v] of [['AWS_LAMBDA_FUNCTION_NAME', savedEnv.fn], ['PORTAL_ORIGIN_SECRET', savedEnv.sec]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('runInBackground', () => {
  it('runs the handler locally after the caller returns', async () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    await runInBackground('test-job', { n: 1 });
    assert.equal(seen.length, 0, 'not run synchronously');
    await wait();
    assert.deepEqual(seen, [{ n: 1 }]);
  });

  it('on Lambda it invokes itself with the job, args and secret instead of running here', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'agent-portal';
    process.env.PORTAL_ORIGIN_SECRET = 's3cret';
    const sent: Array<Record<string, unknown>> = [];
    _setLambdaInvoker(async (p) => { sent.push(p); });
    await runInBackground('test-job', { id: 'x' });
    await wait();
    assert.deepEqual(sent, [{ job: 'test-job', args: { id: 'x' }, secret: 's3cret' }]);
    assert.equal(seen.length, 0);
  });

  it('falls back to running inline when the self-invoke fails', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'agent-portal';
    process.env.PORTAL_ORIGIN_SECRET = 's3cret';
    _setLambdaInvoker(async () => { throw new Error('throttled'); });
    await runInBackground('test-job', { id: 'y' });
    assert.deepEqual(seen, [{ id: 'y' }]);
  });

  it('rejects unknown jobs', async () => {
    await assert.rejects(() => runInBackground('nope', {}), /Unknown background job/);
    assert.equal(hasBackgroundJob('nope'), false);
    assert.equal(hasBackgroundJob('test-job'), true);
  });
});

describe('/internal/events dispatches registered background jobs', () => {
  const server = http.createServer((req, res) => { void handleScheduledEvent(req, res, 'sek'); });
  let base = '';
  const post = (body: unknown) => fetch(base, { method: 'POST', body: JSON.stringify(body) });

  it('runs the job with its args when the secret matches, and refuses otherwise', async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ok = await post({ job: 'test-job', args: { id: 'z' }, secret: 'sek' });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen, [{ id: 'z' }]);
    assert.equal((await post({ job: 'test-job', args: {}, secret: 'bad' })).status, 403);
    assert.equal(seen.length, 1);
    server.close();
  });
});
