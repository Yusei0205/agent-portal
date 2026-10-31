/**
 * Limits inside a run: a spend cap per run (and a session's remaining budget per iteration), a working-time limit
 * that pauses while a person is asked, thinking effort and a fallback model, cache tokens kept apart, a priced
 * estimate for runs that end without a result, and delegated sessions spending from their parent's budget.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootServer, Client, waitFor, startSingleRun, type TestServer } from './client.ts';

process.env.PORTAL_SDK_MODULE = pathToFileURL(path.join(import.meta.dirname, 'fake-sdk.mjs')).href;

let srv: TestServer;
let c: Client;
let pid: string;
const calls = () => (globalThis as any).__fakeSdkCalls as any[];

before(async () => {
  srv = await bootServer();
  c = new Client(srv.base);
  await c.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'a-long-password-1' });
  pid = (await c.post('/api/projects', { name: 'Limits' })).project.id;
  await c.put('/api/settings', { provider: { mode: 'anthropic' }, budget: { monthlyUsd: null } });
  await c.post('/api/settings/secrets/anthropic.api_key', { value: 'sk-ant-run-limits-test' });
});

after(() => srv.close());

const ended = (runId: string, timeoutMs = 20_000) =>
  waitFor(
    async () => {
      const r = await c.get(`/api/runs/${runId}`);
      return ['completed', 'failed', 'stopped'].includes(r.run.status) ? r : null;
    },
    'the run to end',
    timeoutMs,
  );

test('defaults: $5 per run, the session budget per iteration, task tools allowed, cache tokens kept apart', async () => {
  const s = await c.get('/api/settings');
  assert.equal(s.agents.maxBudgetUsdPerRun, 5);
  assert.equal(s.agents.runTimeoutMinutes, 60);
  const { run } = await startSingleRun(c, pid, { prompt: 'Count [metered]' });
  const done = await ended(run.id);
  const o = calls().at(-1).options;
  assert.equal(o.maxBudgetUsd, 5, 'a single run has $25, so the $5 cap applies');
  assert.equal(o.effort, undefined);
  assert.equal(o.fallbackModel, undefined);
  for (const t of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TodoWrite']) assert.ok(o.allowedTools.includes(t), t);
  assert.equal(done.run.cache_read_tokens, 3000);
  assert.equal(done.run.cache_write_tokens, 500);
  assert.equal(done.run.input_tokens, 1000 + 3000 + 500 + 400, 'input still includes the cache parts');

  // A small session budget wins over the cap, less 10% headroom.
  const small = await startSingleRun(c, pid, { prompt: 'Count again [metered]', budgetUsd: 2 });
  await ended(small.run.id);
  assert.equal(calls().at(-1).options.maxBudgetUsd, 1.8);
});

test('effort and a fallback model reach the engine; bad values are refused', async () => {
  await c.put('/api/settings', { agents: { effort: 'high', fallbackModel: 'haiku' } });
  try {
    const { run } = await startSingleRun(c, pid, { prompt: 'Think [metered]' });
    await ended(run.id);
    const o = calls().at(-1).options;
    assert.equal(o.effort, 'high');
    assert.equal(o.fallbackModel, 'haiku');
    for (const bad of [{ effort: 'ultra' }, { fallbackModel: 'gpt-5' }, { maxBudgetUsdPerRun: -1 }, { runTimeoutMinutes: 0 }]) {
      assert.equal((await c.req('PUT', '/api/settings', { agents: bad })).status, 400, JSON.stringify(bad));
    }
    const none = await c.put('/api/settings', { agents: { maxBudgetUsdPerRun: null, runTimeoutMinutes: '' } });
    assert.equal(none.agents.maxBudgetUsdPerRun, null);
    assert.equal(none.agents.runTimeoutMinutes, null);
  } finally {
    await c.put('/api/settings', { agents: { effort: '', fallbackModel: '', maxBudgetUsdPerRun: 5, runTimeoutMinutes: 60 } });
  }
});

test('reaching its budget stops a run, it does not fail it', async () => {
  const { run } = await startSingleRun(c, pid, { prompt: 'Spend [budget]' });
  const done = await ended(run.id);
  assert.equal(done.run.status, 'stopped');
  assert.match(done.run.error, /Stopped at this run's budget of \$5/);
  assert.equal(done.run.cost_usd, 5.02, 'what it spent is recorded');
  assert.equal(done.run.meta.budgetUsd, 5);
});

test('the time limit stops a run, and a run without a result is priced from what it used', async () => {
  await c.put('/api/settings', { agents: { runTimeoutMinutes: 0.02 } }); // 1.2 seconds
  try {
    const { run } = await startSingleRun(c, pid, { prompt: 'Big job [spend-then-hang]' });
    const done = await ended(run.id);
    assert.equal(done.run.status, 'stopped');
    assert.match(done.run.error, /worked for more than 1 seconds, the time limit per run/);
    const { estimateCost } = await import('../server/agent/pricing.ts');
    const expected =
      estimateCost('claude-sonnet-5-5', { input_tokens: 100000, output_tokens: 20000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 }) +
      estimateCost('claude-haiku-5-5', { input_tokens: 10000, output_tokens: 1000 });
    assert.ok(expected > 0);
    assert.equal(done.run.cost_usd, Number(expected.toFixed(6)), 'priced from usage, the subagent included');
    assert.equal(done.run.meta.costEstimated, true);
    assert.equal(done.run.cache_read_tokens, 50000);
  } finally {
    await c.put('/api/settings', { agents: { runTimeoutMinutes: 60 } });
  }
});

test('waiting for a person does not use up the working time', async () => {
  await c.put('/api/settings', { agents: { runTimeoutMinutes: 0.02 } }); // 1.2 seconds of work
  try {
    const { run } = await startSingleRun(c, pid, { prompt: 'Ask first [ask-slowly]' });
    const q = await waitFor(async () => (await c.get(`/api/runs/${run.id}`)).inputs.find((i: any) => i.status === 'pending'), 'the question');
    await new Promise((r) => setTimeout(r, 2500)); // longer than the limit, while waiting
    await c.post(`/api/inputs/${q.id}/answer`, { answers: { 'Which size?': 'small' } });
    const done = await ended(run.id);
    assert.equal(done.run.status, 'completed', done.run.error ?? '');
  } finally {
    await c.put('/api/settings', { agents: { runTimeoutMinutes: 60 } });
  }
});

test('a delegated session spends from what its parent has left', async () => {
  const { childBudget } = await import('../server/workflows/delegation.ts');
  const { run: exec, one } = await import('../server/db.ts');
  const parent = (await c.post(`/api/projects/${pid}/workflows`, { goal: 'Parent', playground: true, start: false, budgetUsd: 5 })).workflow;
  const row = () => one<any>('SELECT * FROM workflows WHERE id = ?', parent.id);
  assert.equal(childBudget(row()), 5);
  exec('UPDATE workflows SET spent_usd = 1 WHERE id = ?', parent.id);
  assert.equal(childBudget(row()), 4);
  // A running child that may still spend $3 leaves $1 for the next one.
  const child = (await c.post(`/api/projects/${pid}/workflows`, { goal: 'Child', playground: true, start: false, budgetUsd: 3 })).workflow;
  exec("UPDATE workflows SET parent_id = ?, status = 'running' WHERE id = ?", parent.id, child.id);
  assert.equal(childBudget(row()), 1);
  exec("UPDATE workflows SET status = 'done' WHERE id = ?", child.id);
  assert.equal(childBudget(row()), 4, 'a finished child no longer counts');
});
