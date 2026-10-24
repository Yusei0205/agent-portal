import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootServer, Client, waitFor, type TestServer, startSingleRun, startSingleRunReq } from './client.ts';

// Exercise the real-provider path against a recording fake of the Agent SDK.
process.env.PORTAL_SDK_MODULE = pathToFileURL(path.join(import.meta.dirname, 'fake-sdk.mjs')).href;
process.env.PORTAL_SHOULD_NOT_LEAK = 'nope';

let srv: TestServer;
let c: Client;
let pid: string;
const calls = () => (globalThis as any).__fakeSdkCalls as any[];

before(async () => {
  srv = await bootServer();
  c = new Client(srv.base);
  await c.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'a-long-password-1' });
  pid = (await c.post('/api/projects', { name: 'SDK check' })).project.id;
});

after(() => srv.close());

test('Anthropic provider: options, environment, guard, questions, approvals and stream close', async () => {
  await c.put('/api/settings', { provider: { mode: 'anthropic' } });
  const noKey = await startSingleRunReq(c, pid, { prompt: 'Build it' });
  // The run starts, then fails because no key is stored.
  const failed = await waitFor(async () => {
    const w = (await c.get(`/api/workflows/${noKey.data.workflow.id}`)).workflow;
    if (!w.last_run_id) return null;
    const r = await c.get(`/api/runs/${w.last_run_id}`);
    return r.run.status === 'failed' ? r : null;
  }, 'missing-key failure');
  assert.match(failed.run.error, /Anthropic API key/);

  await c.post('/api/settings/secrets/anthropic.api_key', { value: 'sk-ant-real-looking-key-1234' });
  const { run } = await startSingleRun(c, pid, { prompt: 'Pick a database for refunds' });
  const q = await waitFor(async () => (await c.get(`/api/runs/${run.id}`)).inputs.find((i: any) => i.type === 'question' && i.status === 'pending'), 'question');
  await c.post(`/api/inputs/${q.id}/answer`, { answers: { 'Which database?': 'Postgres' } });
  const ap = await waitFor(async () => (await c.get(`/api/runs/${run.id}`)).inputs.find((i: any) => i.type === 'approval' && i.status === 'pending'), 'approval');
  assert.equal(ap.payload.input.command, 'npm test');
  await c.post(`/api/inputs/${ap.id}/answer`, { decision: 'deny', message: 'not now' });
  const done = await waitFor(async () => {
    const r = await c.get(`/api/runs/${run.id}`);
    return r.run.status === 'completed' ? r : null;
  }, 'completion');

  const call = calls().at(-1);
  const o = call.options;
  assert.ok(o.cwd.endsWith(path.join('projects', 'sdk-check')));
  assert.deepEqual(o.settingSources, ['project']);
  assert.equal(o.model, 'sonnet');
  assert.equal(o.permissionMode, 'default');
  assert.equal(o.systemPrompt.type, 'preset');
  assert.match(o.systemPrompt.append, /AskUserQuestion/);
  assert.ok(o.allowedTools.includes('Read') && !o.allowedTools.includes('Write') && !o.allowedTools.includes('AskUserQuestion'));
  assert.equal(o.env.ANTHROPIC_API_KEY, 'sk-ant-real-looking-key-1234');
  assert.ok(o.env.CLAUDE_CONFIG_DIR.endsWith('claude-home'));
  assert.equal(o.env.PORTAL_SHOULD_NOT_LEAK, undefined);
  assert.equal(o.env.PORTAL_SECRET_KEY, undefined);
  assert.equal(o.env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.ok(o.env.PATH, 'PATH is kept');

  assert.match(call.promptMessages[0].message.content, /Pick a database for refunds/);
  assert.match(call.promptMessages[0].message.content, /Read CLAUDE\.md first/);
  assert.equal(call.guardOutside.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(call.guardRead, {});
  assert.deepEqual(call.questionResult.updatedInput.answers, { 'Which database?': 'Postgres' });
  assert.equal(call.bashResult.behavior, 'deny');
  assert.match(call.bashResult.message, /not now/);
  assert.equal(call.inputClosed, true, 'input stream closes after the result');

  assert.equal(done.run.cost_usd, 0.0123);
  assert.equal(done.run.session_id, 'sess-1');
  assert.ok(done.events.some((e: any) => e.type === 'hook:SubagentStart'));
});

test('Bedrock provider: AWS keys from secrets, single-shot options', async () => {
  await c.put('/api/settings', { provider: { mode: 'bedrock', models: { haiku: 'global.anthropic.claude-haiku-5-5' } }, aws: { region: 'ap-southeast-1', auth: 'keys' } });
  await c.post('/api/settings/secrets/aws.access_key_id', { value: 'AKIAEXAMPLEEXAMPLE12' });
  await c.post('/api/settings/secrets/aws.secret_access_key', { value: 'secret/example/key/value' });
  const t = await c.post('/api/settings/test');
  assert.equal(t.ok, true);
  const o = calls().at(-1).options;
  assert.equal(o.env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(o.env.AWS_REGION, 'ap-southeast-1');
  assert.equal(o.env.AWS_ACCESS_KEY_ID, 'AKIAEXAMPLEEXAMPLE12');
  assert.equal(o.env.AWS_SECRET_ACCESS_KEY, 'secret/example/key/value');
  assert.equal(o.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'global.anthropic.claude-haiku-5-5');
  assert.equal(o.env.ANTHROPIC_API_KEY, undefined, 'Anthropic key is not sent to Bedrock runs');
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.maxTurns, 1);
  assert.equal(typeof o.systemPrompt, 'string');
  const usage = await c.get('/api/usage');
  assert.ok(usage.totalUsd > 0.012, 'real runs count toward the budget');
});

test('budget cap blocks new runs once used up', async () => {
  await c.put('/api/settings', { budget: { monthlyUsd: 0.01 } });
  const r = await startSingleRunReq(c, pid, { prompt: 'One more' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /budget/);
});
