/**
 * Session memory and stop rules: each iteration sees what the last ones did (the progress file), and the loop spec's
 * declared stop rules (maxConsecutiveFailures, stagnationWindow, requireVerification) are honoured.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootServer, Client, waitFor, type TestServer } from './client.ts';
import { sameReport, stagnated } from '../server/guardrails.ts';

process.env.PORTAL_SDK_MODULE = pathToFileURL(path.join(import.meta.dirname, 'fake-sdk.mjs')).href;

let srv: TestServer;
let c: Client;
let pid: string;
const calls = () => (globalThis as any).__fakeSdkCalls as any[];

before(async () => {
  srv = await bootServer();
  c = new Client(srv.base);
  await c.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'a-long-password-1' });
  pid = (await c.post('/api/projects', { name: 'Loops' })).project.id;
  await c.put('/api/settings', { provider: { mode: 'anthropic' }, budget: { monthlyUsd: null } });
  await c.post('/api/settings/secrets/anthropic.api_key', { value: 'sk-ant-loop-memory-test' });
});

after(() => srv.close());

const settled = (id: string, wanted: string[]) =>
  waitFor(
    async () => {
      const d = await c.get(`/api/workflows/${id}`);
      return wanted.includes(d.workflow.status) && !d.driving ? d : null;
    },
    `the session to be ${wanted.join(' or ')}`,
    30_000,
  );

/** Start a session from a loop spec with these stop rules (and checks), the way a trigger would. */
async function fromSpec(goal: string, stopRules: Record<string, unknown>, verification: unknown[] = []) {
  (globalThis as any).__fakeLoopCount = 0;
  const spec = (await c.post(`/api/projects/${pid}/loop-specs`, { name: `Spec ${goal.slice(0, 20)} ${Date.now()}`, triggerKind: 'manual', goalTemplate: goal, stopRules, verification })).spec;
  const run = await c.post(`/api/projects/${pid}/loop-specs/${spec.id}/run`, {});
  return String(run.workflow?.id ?? run.id);
}

test('reworded reports still count as the same; the window is at least two', () => {
  assert.ok(sameReport('Still working on the refund rules, nothing new yet', 'still working on refund rules - nothing new yet'));
  assert.ok(!sameReport('Fixed test A; next fix test B', 'Fixed test B; next fix test C'), 'real progress differs');
  assert.ok(stagnated(['Still working on the refund rules, nothing new yet', 'Still working on refund rules, nothing new yet', 'still working on the refund rules nothing new yet']));
  assert.ok(stagnated(['a b c d', 'x', 'x'], 2));
  assert.ok(!stagnated(['x'], 1), 'a window of one would stop every session after its first iteration');
  assert.ok(stagnated(['x', 'x'], 1));
});

test('each iteration is told what the last ones did, from the progress file', async () => {
  (globalThis as any).__fakeLoopCount = 0;
  const w = (await c.post(`/api/projects/${pid}/workflows`, { goal: 'Do the steps [loop]', playground: true, maxIterations: 5 })).workflow;
  const done = await settled(w.id, ['done', 'blocked', 'failed', 'paused']);
  assert.equal(done.workflow.status, 'done');
  const prompts = calls()
    .filter((x) => String(x.promptMessages[0]?.message?.content ?? '').includes('Do the steps [loop]'))
    .map((x) => String(x.promptMessages[0].message.content));
  assert.equal(prompts.length, 3);
  assert.doesNotMatch(prompts[0], /## Progress so far/);
  assert.match(prompts[2], /## Progress so far\s+## Iteration 1 [^\n]*\s+Step 1 done\s+## Iteration 2 [^\n]*\s+Step 2 done/);
});

test('maxConsecutiveFailures from the loop spec', async () => {
  const id = await fromSpec('Break [loop-fail]', { maxIterations: 5, maxConsecutiveFailures: 1 });
  const d = await settled(id, ['failed', 'blocked', 'done', 'paused']);
  assert.equal(d.workflow.status, 'failed');
  assert.match(d.workflow.stop_reason, /^A run failed/);
  assert.equal(d.runs.length, 1, 'one failure was enough');
});

test('stagnationWindow from the loop spec, with reworded reports', async () => {
  const id = await fromSpec('Spin [loop-same]', { maxIterations: 6, stagnationWindow: 2 });
  const d = await settled(id, ['blocked', 'failed', 'done', 'paused']);
  assert.equal(d.workflow.status, 'blocked');
  assert.match(d.workflow.stop_reason, /not making progress/);
  assert.equal(d.runs.length, 2);
});

test('requireVerification: false accepts "done" over a failing check; the default does not', async () => {
  const failing = [{ step: 'check', cmd: 'node -e "process.exit(1)"', timeout: 60 }];
  const lenient = await fromSpec('Finish [loop-done]', { maxIterations: 3, requireVerification: false }, failing);
  const a = await settled(lenient, ['done', 'blocked', 'failed', 'paused']);
  assert.equal(a.workflow.status, 'done');

  const strict = await fromSpec('Finish strictly [loop-done]', { maxIterations: 2 }, failing);
  const b = await settled(strict, ['done', 'blocked', 'failed', 'paused']);
  assert.notEqual(b.workflow.status, 'done', 'the failing check keeps it going');
  assert.ok(b.events.some((e: any) => /reported done, but the check failed/.test(e.body)));
});
