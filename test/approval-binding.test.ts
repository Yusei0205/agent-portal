/**
 * Approvals are bound to the exact call a person saw: its fingerprint, the whole command, "always allow" per host for
 * WebFetch, an expiry, one answer only, and a push that is refused when the working copy changed after the request.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  pid = (await c.post('/api/projects', { name: 'Approvals' })).project.id;
  await c.put('/api/settings', { provider: { mode: 'anthropic' } });
  await c.post('/api/settings/secrets/anthropic.api_key', { value: 'sk-ant-approval-binding-test' });
});

after(() => srv.close());

const pendingApproval = (runId: string, n: number) =>
  waitFor(async () => {
    const list = (await c.get(`/api/runs/${runId}`)).inputs.filter((i: any) => i.type === 'approval');
    return list.length >= n && list[n - 1].status === 'pending' ? list[n - 1] : null;
  }, `approval ${n}`);

const finished = (runId: string) =>
  waitFor(async () => {
    const r = await c.get(`/api/runs/${runId}`);
    return ['completed', 'failed', 'stopped'].includes(r.run.status) ? r : null;
  }, 'the run to finish');

test('an approval shows the whole command and allows only the exact call it shows', async () => {
  const { run } = await startSingleRun(c, pid, { prompt: 'Check approvals [approvals]' });

  const first = await pendingApproval(run.id, 1);
  assert.equal(first.payload.input.command.length, 5005, 'the command is shown whole, not cut at 4,000 characters');
  assert.match(first.payload.inputHash, /^[0-9a-f]{64}$/);
  assert.equal(first.payload.rememberScope, 'command');
  const noHash = await c.req('POST', `/api/inputs/${first.id}/answer`, { decision: 'allow' });
  assert.equal(noHash.status, 409);
  assert.match(noHash.data.error, /not the tool call you reviewed/);
  const otherHash = await c.req('POST', `/api/inputs/${first.id}/answer`, { decision: 'allow', inputHash: '0'.repeat(64) });
  assert.equal(otherHash.status, 409);
  await c.post(`/api/inputs/${first.id}/answer`, { decision: 'allow', inputHash: first.payload.inputHash });

  // WebFetch: "always allow" covers that host, not every address.
  const fetch1 = await pendingApproval(run.id, 2);
  assert.equal(fetch1.payload.rememberScope, 'host');
  assert.equal(fetch1.payload.rememberLabel, 'docs.example.com');
  await c.post(`/api/inputs/${fetch1.id}/answer`, { decision: 'allow', remember: true, inputHash: fetch1.payload.inputHash });
  const fetch3 = await pendingApproval(run.id, 3);
  assert.equal(fetch3.payload.input.url, 'https://evil.example.net/x', 'the same host went through; another host asks again');
  await c.post(`/api/inputs/${fetch3.id}/answer`, { decision: 'deny', message: 'not that site' });

  const done = await finished(run.id);
  assert.equal(done.run.status, 'completed');
  const call = calls().at(-1);
  assert.equal(call.longBash.behavior, 'allow');
  assert.equal(call.longBash.updatedInput.command.length, 5005, 'the call that runs is the one the server held');
  assert.equal(call.fetch1.behavior, 'allow');
  assert.equal(call.fetch2.behavior, 'allow');
  assert.equal(call.fetch3.behavior, 'deny');
  assert.equal(call.huge.behavior, 'deny');
  assert.match(call.huge.message, /too long for a person to review/);
  assert.equal(done.inputs.filter((i: any) => i.type === 'approval').length, 3, 'the remembered host and the unreviewable command asked nobody');
});

test('one answer wins; the other is told someone answered', async () => {
  const { createInput } = await import('../server/agent/runner.ts');
  const { one } = await import('../server/db.ts');
  const userId = one<{ id: string }>("SELECT id FROM users WHERE email = 'admin@example.com'")!.id;
  const input = createInput({ projectId: pid, runId: null, type: 'approval', toolName: 'Bash', payload: { toolName: 'Bash', input: { command: 'ls' }, inputHash: 'h1' }, userId });
  const [a, b] = await Promise.all([
    c.req('POST', `/api/inputs/${input.id}/answer`, { decision: 'allow', inputHash: 'h1' }),
    c.req('POST', `/api/inputs/${input.id}/answer`, { decision: 'deny' }),
  ]);
  const [winner, loser] = [a, b].sort((x, y) => x.status - y.status);
  assert.equal(winner.status, 200);
  assert.ok([400, 409].includes(loser.status), `the second answer is refused (${loser.status} ${JSON.stringify(loser.data)})`);
  assert.equal(one<{ status: string }>('SELECT status FROM inputs WHERE id = ?', input.id)!.status, 'answered');
});

test('a question or approval nobody answers ends, and the agent carries on', async () => {
  await c.put('/api/settings', { agents: { approvalExpiryMinutes: 0.02 } }); // 1.2 seconds
  try {
    const { run } = await startSingleRun(c, pid, { prompt: 'Wait for people [expiry]' });
    const done = await waitFor(
      async () => {
        const r = await c.get(`/api/runs/${run.id}`);
        return ['completed', 'failed', 'stopped'].includes(r.run.status) ? r : null;
      },
      'the run to finish after both expire',
      30_000,
    );
    assert.equal(done.run.status, 'completed');
    const call = calls().at(-1);
    assert.equal(call.expiredBash.behavior, 'deny');
    assert.match(call.expiredBash.message, /Nobody answered within 0.02 minutes, so this was declined/);
    assert.deepEqual(call.expiredQuestion.updatedInput.answers, {});
    assert.match(call.expiredQuestion.updatedInput.response, /Choose the most reasonable option/);
    const inputs = done.inputs;
    assert.equal(inputs.length, 2);
    for (const i of inputs) {
      assert.equal(i.status, 'expired');
      assert.ok(i.expires_at, 'the expiry is stored');
    }
    const late = await c.req('POST', `/api/inputs/${inputs[0].id}/answer`, { decision: 'allow', inputHash: inputs[0].payload.inputHash });
    assert.equal(late.status, 409);
    assert.match(late.data.error, /Nobody answered this in time/);
    assert.ok(done.events.some((e: any) => e.type === 'portal:input_expired'));
  } finally {
    await c.put('/api/settings', { agents: { approvalExpiryMinutes: 60 } });
  }
});

test('a push is refused when the working copy changed after the agents asked', async () => {
  await c.put('/api/settings', { provider: { mode: 'demo' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bound-push-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  try {
    const { repo } = await c.post(`/api/projects/${pid}/repos`, { localPath: dir, name: 'bound-push' });
    await waitFor(async () => ((await c.get(`/api/projects/${pid}/repos`)).repos.find((r: any) => r.id === repo.id).status === 'ready' ? true : null), 'clone');
    const w = (await c.post(`/api/projects/${pid}/workflows`, { goal: 'Ship it [demo-iterations: 1] [demo-push] [demo-branch: feature/bound-push]', repoId: repo.id, model: 'haiku', pushMode: 'ask' })).workflow;
    const waiting = await waitFor(async () => {
      const d = await c.get(`/api/workflows/${w.id}`);
      return d.workflow.pending_push && !d.driving ? d : null;
    }, 'the push request');
    assert.match(waiting.workflow.pending_push.tree, /:[0-9a-f]{40}$/, 'the working copy content is recorded');

    // Someone changes the working copy before the push is allowed.
    const runRow = (await c.get(`/api/runs/${waiting.workflow.pending_push.runId}`)).run;
    const slug = (await c.get(`/api/projects/${pid}`)).project.slug;
    const extra = path.join(srv.dataDir, 'projects', slug, runRow.worktree, 'late-change.txt');
    fs.writeFileSync(extra, 'not reviewed\n');
    const refused = await c.req('POST', `/api/workflows/${w.id}/push/allow`, {});
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /working copy changed after the agents asked/);

    // Back to what was asked: now it goes through.
    fs.rmSync(extra);
    const allowed = await c.post(`/api/workflows/${w.id}/push/allow`, {});
    assert.equal(allowed.push.ok, true, JSON.stringify(allowed.push));
  } finally {
    await c.put('/api/settings', { provider: { mode: 'anthropic' } });
  }
});
