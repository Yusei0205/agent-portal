/**
 * Fixes from the review of refactor/core-model:
 *  1. Generic webhooks require a signature.
 *  2. Deletes stay inside the run's folder for every run (trusted ones included).
 *  3. Untrusted runs check the blocked-command lists before any approval; "remember" covers one command.
 *  4. Agents read only inside their project folder (an admin setting can relax this).
 *  5. A resumed iteration stores its own cost, not the session's running total.
 *  6. The person's and the project's monthly caps apply to every run.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootServer, Client, waitFor, type TestServer, startSingleRun, startSingleRunReq } from './client.ts';
import { outsideDeleteReason, isInsideDir } from '../server/guardrails.ts';

process.env.PORTAL_SDK_MODULE = pathToFileURL(path.join(import.meta.dirname, 'fake-sdk.mjs')).href;

let srv: TestServer;
let c: Client;
let pid: string;
const lastCall = () => ((globalThis as any).__fakeSdkCalls as any[]).at(-1);

before(async () => {
  srv = await bootServer();
  c = new Client(srv.base);
  await c.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'a-long-password-1' });
  pid = (await c.post('/api/projects', { name: 'Review fixes' })).project.id;
  await c.put('/api/settings', { provider: { mode: 'anthropic' }, budget: { monthlyUsd: null } });
  await c.post('/api/settings/secrets/anthropic.api_key', { value: 'sk-ant-test-key-0000000000' });
});

after(() => srv.close());

async function runEnded(runId: string): Promise<any> {
  return waitFor(async () => {
    const r = await c.get(`/api/runs/${runId}`);
    return ['completed', 'failed', 'stopped'].includes(r.run.status) ? r.run : null;
  }, `run ${runId} to end`);
}

/* ------------------------------------------------------------------ */
/* 2. The delete check itself                                          */
/* ------------------------------------------------------------------ */

test('delete check: only paths inside the run folder may be deleted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-del-'));
  const project = path.join(root, 'projects', 'p');
  const run = path.join(project, 'work', 'r_1');
  const home = path.join(root, 'home');
  const check = (cmd: string) => outsideDeleteReason(cmd, run, { cwd: project, home });

  for (const ok of [
    'rm -rf work/r_1/build',
    'cd work/r_1 && rm -rf build',
    `rm -f "${path.join(run, 'a file.txt')}"`,
    'rm -rf work/r_1/*.o',
    "find work/r_1 -name '*.tmp' -delete",
    'git -C work/r_1/repo clean -fdx',
    'cd work/r_1 && git clean -fdx',
    'npm test && echo rm is a word here',
    'ls -la',
  ]) {
    assert.equal(check(ok), null, `allowed: ${ok}`);
  }
  for (const bad of [
    'rm -rf docs',
    'rm -rf ./*',
    'rm -rf *',
    'rm -rf work/r_1',
    'rm -rf work/r_1/../../..',
    'rm -rf ~/notes',
    'rm -rf $HOME/notes',
    'rm -rf "$TARGET"',
    'rm -rf $(pwd)/x',
    `rm -rf ${path.join(root, 'elsewhere')}`,
    'cd .. && rm -rf p',
    'cd "$SOMEWHERE" && rm -rf build',
    'find .. -name "*.md" -delete',
    'git clean -fdx',
    'ls | xargs rm',
    'sudo rm -rf /',
    'FOO=1 /bin/rm -rf docs',
    'rmdir docs/md',
    'npm test; rm -rf .claude',
  ]) {
    assert.ok(check(bad), `refused: ${bad}`);
  }
  assert.match(check('rm -rf docs')!, /only delete inside this run's folder/);
  assert.ok(isInsideDir(project, run) && !isInsideDir(run, project));
});

test('delete check: Git Bash paths on Windows map to drive letters', { skip: process.platform !== 'win32' }, () => {
  const run = path.join(os.tmpdir(), 'portal-del-win', 'work', 'r_1');
  const gitBash = run.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
  const check = (cmd: string) => outsideDeleteReason(cmd, run, { cwd: path.dirname(path.dirname(run)), home: os.homedir(), platform: 'win32' });
  assert.equal(check(`rm -rf ${gitBash}/build`), null);
  assert.ok(check('rm -rf /c/Windows/Temp/x'));
  assert.ok(check('rd /s /q C:\\Windows\\Temp\\x'));
});

/* ------------------------------------------------------------------ */
/* 1. Webhook signatures                                               */
/* ------------------------------------------------------------------ */

test('a generic webhook without a signature is refused', async () => {
  const { spec } = await c.post(`/api/projects/${pid}/loop-specs`, { name: 'Hook', triggerKind: 'webhook', goalTemplate: 'Handle {{event}}' });
  const secret = spec.trigger_config.secret;
  const url = `${srv.base}/api/loop-specs/${spec.id}/webhook`;
  const body = JSON.stringify({ event: 'deploy finished' });
  const unsigned = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(unsigned.status, 401, 'no signature, no session');
  const wrong = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'nope').update(body).digest('hex') },
    body,
  });
  assert.equal(wrong.status, 401);
  const signed = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex') },
    body,
  });
  assert.equal(signed.status, 200);
  const { workflowId } = (await signed.json()) as any;
  assert.ok(workflowId);
  await c.post(`/api/workflows/${workflowId}/stop`).catch(() => undefined);
  await c.del(`/api/projects/${pid}/loop-specs/${spec.id}`).catch(() => undefined);
});

/* ------------------------------------------------------------------ */
/* 2-4. Guards on real-provider runs                                   */
/* ------------------------------------------------------------------ */

const UNTRUSTED = {
  readInside: 'allow',
  readOutside: 'deny',
  readEscape: 'deny',
  grepOutside: 'deny',
  globAbsolute: 'deny',
  globRelative: 'allow',
  rmInRunFolder: 'allow',
  cdThenRm: 'allow',
  rmProjectDocs: 'deny',
  rmEverything: 'deny',
  rmHome: 'deny',
  findDelete: 'deny',
  sudo: 'deny',
  curlShell: 'deny',
  terraform: 'deny',
  npmTest: 'allow',
};

test('guards: reads stay in the project, deletes in the run folder, blocked commands never reach an approval', async () => {
  const { run } = await startSingleRun(c, pid, { prompt: '[guards] untrusted' });
  await runEnded(run.id);
  assert.deepEqual(lastCall().guards, UNTRUSTED);
});

test('guards in a trusted session: deletes outside the run folder are still refused', async () => {
  const { run } = await startSingleRun(c, pid, { prompt: '[guards] trusted', trustTools: true });
  await runEnded(run.id);
  assert.deepEqual(lastCall().guards, {
    ...UNTRUSTED,
    // Trust all tools lifts the untrusted list (sudo, curl | sh), but not the always-blocked one or the delete check.
    sudo: 'allow',
    curlShell: 'allow',
  });
});

test('an admin can let agents read outside the project', async () => {
  await c.put('/api/settings', { agents: { allowReadsOutsideProject: true } });
  try {
    const { run } = await startSingleRun(c, pid, { prompt: '[guards] relaxed reads' });
    await runEnded(run.id);
    const g = lastCall().guards;
    assert.equal(g.readOutside, 'allow');
    assert.equal(g.rmProjectDocs, 'deny', 'the delete check does not depend on the read setting');
  } finally {
    await c.put('/api/settings', { agents: { allowReadsOutsideProject: false } });
  }
  assert.equal((await c.get('/api/settings')).agents.allowReadsOutsideProject, false);
});

test('approving a shell command covers that exact command only', async () => {
  const { run } = await startSingleRun(c, pid, { prompt: '[bash-remember] run the tests', permissionMode: 'default' });
  const first = await waitFor(async () => (await c.get(`/api/runs/${run.id}`)).inputs.find((i: any) => i.status === 'pending'), 'the first approval');
  assert.equal(first.payload.input.command, 'npm test');
  assert.equal(first.payload.rememberScope, 'command');
  await c.post(`/api/inputs/${first.id}/answer`, { decision: 'allow', remember: true });
  // The second `npm test` runs without asking; `curl` still asks.
  const next = await waitFor(async () => (await c.get(`/api/runs/${run.id}`)).inputs.find((i: any) => i.status === 'pending'), 'the next approval');
  assert.equal(next.payload.input.command, 'curl https://example.com');
  await c.post(`/api/inputs/${next.id}/answer`, { decision: 'deny' });
  await runEnded(run.id);
  const call = lastCall();
  assert.equal(call.bash2.behavior, 'allow');
  assert.equal(call.bash3.behavior, 'deny');
  assert.equal((await c.get(`/api/runs/${run.id}`)).inputs.length, 2, 'only two approvals were asked for');
});

/* ------------------------------------------------------------------ */
/* 5. Costs of resumed iterations                                      */
/* ------------------------------------------------------------------ */

test('a resumed iteration counts only its own spend, so the session total is right', async () => {
  const { workflow, run } = await startSingleRun(c, pid, { prompt: '[metered] first' });
  const first = await runEnded(run.id);
  assert.equal(first.cost_usd, 0.05);
  assert.equal(first.input_tokens, 1000 + 3000 + 500 + 400, 'subagent and cache tokens included');
  assert.equal(first.output_tokens, 250);

  // A follow-up message starts iteration 2, which resumes the SDK session; its result reports 0.08 in total.
  await waitFor(async () => !(await c.get(`/api/workflows/${workflow.id}`)).driving, 'the first iteration to settle');
  await c.post(`/api/workflows/${workflow.id}/messages`, { body: '[metered] again' });
  const second = await waitFor(async () => {
    const w = (await c.get(`/api/workflows/${workflow.id}`)).workflow;
    if (!w.last_run_id || w.last_run_id === run.id) return null;
    const r = await c.get(`/api/runs/${w.last_run_id}`);
    return r.run.status === 'completed' ? r.run : null;
  }, 'iteration 2');
  assert.equal(second.cost_usd, 0.03, 'not the session total of 0.08');
  assert.equal(second.input_tokens, 7900 - 4900);
  assert.equal(second.output_tokens, 400 - 250);
  const w = await waitFor(async () => {
    const d = await c.get(`/api/workflows/${workflow.id}`);
    return d.driving ? null : d.workflow;
  }, 'the session to settle');
  assert.equal(Number(w.spent_usd.toFixed(4)), 0.08, 'session spend is 0.05 + 0.03, not 0.05 + 0.08');
});

/* ------------------------------------------------------------------ */
/* 6. Personal and project monthly caps                                */
/* ------------------------------------------------------------------ */

test("the person's and the project's monthly caps stop new runs", async () => {
  const { run: exec } = await import('../server/db.ts');
  const me = (await c.get('/api/auth/me')).user;
  // This month the admin has already spent at least $0.08 (the session above).
  exec('UPDATE users SET monthly_budget_usd = ? WHERE id = ?', 0.05, me.id);
  try {
    const refused = await startSingleRunReq(c, pid, { prompt: 'one more' });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /personal monthly budget/);
  } finally {
    exec('UPDATE users SET monthly_budget_usd = NULL WHERE id = ?', me.id);
  }
  exec('UPDATE projects SET monthly_budget_usd = ? WHERE id = ?', 0.05, pid);
  try {
    const refused = await startSingleRunReq(c, pid, { prompt: 'one more' });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /project's monthly budget/);
  } finally {
    exec('UPDATE projects SET monthly_budget_usd = NULL WHERE id = ?', pid);
  }
  const allowed = await startSingleRunReq(c, pid, { prompt: '[metered] after the caps were lifted' });
  assert.equal(allowed.status, 200);
});
