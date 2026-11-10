/**
 * Long jobs on the AgentCore job runtime: which jobs go there, the fallback to Lambda, and the runner's own
 * /invocations and /ping.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerBackgroundJob, runInBackground, _setLambdaInvoker, runningJobCount, useLambdaInvoke } from '../server/background-jobs.ts';
import { _setJobRuntimeInvoker, runsOnJobRuntime, jobRuntimeJobs, jobSessionId, DEFAULT_JOB_RUNTIME_JOBS } from '../server/job-runtime.ts';
import { handleJobInvocation, handleJobRunnerPing } from '../server/scheduled-jobs.ts';

const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/agentPortalJobRunner-abc';
const seen: Array<Record<string, unknown>> = [];
let release: (() => void) | null = null;
registerBackgroundJob('scan-run', async (args) => { seen.push(args); });
registerBackgroundJob('slow-job', async () => { await new Promise<void>((r) => { release = r; }); });
registerBackgroundJob('quick-job', async (args) => { seen.push(args); });

const KEYS = ['AWS_LAMBDA_FUNCTION_NAME', 'PORTAL_ORIGIN_SECRET', 'PORTAL_JOB_RUNTIME_ARN', 'PORTAL_JOB_RUNTIME_JOBS', 'PORTAL_JOB_RUNNER', 'PORTAL_JOB_RUNTIME_FALLBACK'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  seen.length = 0;
  _setLambdaInvoker(null);
  _setJobRuntimeInvoker(null);
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('which jobs go to the job runtime', () => {
  it('none, unless a runtime is configured', () => {
    delete process.env.PORTAL_JOB_RUNTIME_ARN;
    assert.equal(runsOnJobRuntime('scan-run'), false);
  });

  it('the long batch jobs, but not agent runs or quick jobs, by default', () => {
    process.env.PORTAL_JOB_RUNTIME_ARN = ARN;
    delete process.env.PORTAL_JOB_RUNTIME_JOBS;
    for (const j of DEFAULT_JOB_RUNTIME_JOBS) assert.equal(runsOnJobRuntime(j), true, j);
    assert.equal(runsOnJobRuntime('execute-run'), false);
    assert.equal(runsOnJobRuntime('repo-sync'), false);
  });

  it('PORTAL_JOB_RUNTIME_JOBS replaces the list', () => {
    process.env.PORTAL_JOB_RUNTIME_ARN = ARN;
    process.env.PORTAL_JOB_RUNTIME_JOBS = 'execute-run, scan-run';
    assert.deepEqual([...jobRuntimeJobs()].sort(), ['execute-run', 'scan-run']);
    assert.equal(runsOnJobRuntime('execute-run'), true);
    assert.equal(runsOnJobRuntime('test-run'), false);
  });

  it('a name with + is added to the default list', () => {
    process.env.PORTAL_JOB_RUNTIME_ARN = ARN;
    process.env.PORTAL_JOB_RUNTIME_JOBS = '+execute-run';
    assert.equal(runsOnJobRuntime('execute-run'), true);
    assert.equal(runsOnJobRuntime('scan-run'), true);
    assert.equal(runsOnJobRuntime('repo-sync'), false);
  });

  it('never inside the runtime itself', () => {
    process.env.PORTAL_JOB_RUNTIME_ARN = ARN;
    process.env.PORTAL_JOB_RUNNER = '1';
    assert.equal(runsOnJobRuntime('scan-run'), false);
  });

  it('every job gets its own session id of 33 or more characters', () => {
    const a = jobSessionId('scan-run');
    assert.ok(a.length >= 33, a);
    assert.notEqual(a, jobSessionId('scan-run'));
  });
});

describe('runInBackground with a job runtime', () => {
  it('starts the job on the runtime with its secret, and not here or on Lambda', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'agent-portal';
    process.env.PORTAL_ORIGIN_SECRET = 's3cret';
    process.env.PORTAL_JOB_RUNTIME_ARN = ARN;
    const sent: Array<{ arn: string; sessionId: string; payload: Record<string, unknown> }> = [];
    _setJobRuntimeInvoker(async (arn, sessionId, payload) => { sent.push({ arn, sessionId, payload }); });
    const lambdaSent: unknown[] = [];
    _setLambdaInvoker(async (p) => { lambdaSent.push(p); });
    await runInBackground('scan-run', { id: 'x' });
    await wait();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].arn, ARN);
    assert.deepEqual(sent[0].payload, { job: 'scan-run', args: { id: 'x' }, secret: 's3cret' });
    assert.equal(lambdaSent.length, 0);
    assert.equal(seen.length, 0);
  });

  it('a job that is not on the list still uses Lambda', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'agent-portal';
    process.env.PORTAL_ORIGIN_SECRET = 's3cret';
    process.env.PORTAL_JOB_RUNTIME_ARN = ARN;
    _setJobRuntimeInvoker(async () => { assert.fail('should not use the runtime'); });
    const lambdaSent: Array<Record<string, unknown>> = [];
    _setLambdaInvoker(async (p) => { lambdaSent.push(p); });
    await runInBackground('quick-job', { n: 1 });
    assert.equal(lambdaSent.length, 1);
    assert.equal(lambdaSent[0].job, 'quick-job');
  });

  it('falls back to a Lambda invocation when the runtime cannot be reached', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'agent-portal';
    process.env.PORTAL_ORIGIN_SECRET = 's3cret';
    process.env.PORTAL_JOB_RUNTIME_ARN = ARN;
    _setJobRuntimeInvoker(async () => { throw new Error('HTTP 503'); });
    const lambdaSent: Array<Record<string, unknown>> = [];
    _setLambdaInvoker(async (p) => { lambdaSent.push(p); });
    await runInBackground('scan-run', { id: 'y' });
    assert.equal(lambdaSent.length, 1);
    assert.equal(lambdaSent[0].job, 'scan-run');
  });

  it('with PORTAL_JOB_RUNTIME_FALLBACK=none a runtime failure is raised and Lambda is not used', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'agent-portal';
    process.env.PORTAL_ORIGIN_SECRET = 's3cret';
    process.env.PORTAL_JOB_RUNTIME_ARN = ARN;
    process.env.PORTAL_JOB_RUNTIME_FALLBACK = 'none';
    _setJobRuntimeInvoker(async () => { throw new Error('HTTP 503'); });
    _setLambdaInvoker(async () => { assert.fail('must not fall back to Lambda'); });
    await assert.rejects(runInBackground('scan-run', { id: 'q' }), /could not start scan-run.*HTTP 503/);
  });

  it('inside the runtime a job started by a job runs in that process', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'agent-portal-jobs';
    process.env.PORTAL_ORIGIN_SECRET = 's3cret';
    process.env.PORTAL_JOB_RUNTIME_ARN = ARN;
    process.env.PORTAL_JOB_RUNNER = '1';
    _setJobRuntimeInvoker(async () => { assert.fail('the runtime must not start another runtime'); });
    _setLambdaInvoker(async () => { assert.fail('the runtime must not invoke Lambda'); });
    assert.equal(useLambdaInvoke(), false);
    await runInBackground('scan-run', { id: 'z' });
    await wait();
    assert.deepEqual(seen, [{ id: 'z' }]);
  });
});

describe('the runtime side', () => {
  const SECRET = 'runner-secret';
  const server = http.createServer((req, res) => {
    if (req.url === '/ping') handleJobRunnerPing(res); else void handleJobInvocation(req, res, SECRET);
  });
  let base = '';
  const status = async () => ((await (await fetch(`${base}/ping`)).json()) as { status: string }).status;
  const post = (body: unknown) => fetch(`${base}/invocations`, { method: 'POST', body: JSON.stringify(body) });

  it('starts', async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  it('answers 202 at once, reports HealthyBusy while the job runs, then Healthy', async () => {
    assert.equal(await status(), 'Healthy');
    const r = await post({ job: 'slow-job', args: {}, secret: SECRET });
    assert.equal(r.status, 202);
    await wait();
    assert.equal(runningJobCount(), 1);
    assert.equal(await status(), 'HealthyBusy');
    release?.();
    await wait(60);
    assert.equal(runningJobCount(), 0);
    assert.equal(await status(), 'Healthy');
  });

  it('runs the named job with its args', async () => {
    const r = await post({ job: 'quick-job', args: { a: 1 }, secret: SECRET });
    assert.equal(r.status, 202);
    await wait(60);
    assert.deepEqual(seen, [{ a: 1 }]);
  });

  it('rejects a wrong secret, an unknown job, a bad body and a GET, and runs nothing', async () => {
    assert.equal((await post({ job: 'quick-job', args: {}, secret: 'nope' })).status, 403);
    assert.equal((await post({ job: 'quick-job', args: {} })).status, 403);
    assert.equal((await post({ job: 'rm-rf', args: {}, secret: SECRET })).status, 400);
    assert.equal((await fetch(`${base}/invocations`, { method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await fetch(`${base}/invocations`)).status, 403);
    await wait(40);
    assert.equal(seen.length, 0);
  });

  it('stops', () => { server.close(); });
});
