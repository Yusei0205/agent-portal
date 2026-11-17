import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { run as dbRun } from '../server/db.ts';
import { addRunLifecycleHook, fireRunLifecycleHook } from '../server/agent/runner.ts';
import { registerSessionIntake } from '../server/autofix/session-intake.ts';
import { getAutofixFindingsRepository } from '../server/repositories/autofix-findings.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { saveAutofixPolicy } from '../server/autofix/policy.ts';
import { RECOVERY_PREFIX, MAX_AUTO_RECOVERIES } from '../server/workflows/recovery.ts';
import { now } from '../server/util.ts';

let projectId = '';
let seq = 0;
const tick = () => new Promise((r) => setTimeout(r, 60));
const findings = () => getAutofixFindingsRepository().list(projectId, { limit: 50 });

async function makeFailedRun(error = 'boom: tests exploded', stop = ''): Promise<{ wf: string; run: string }> {
  const repo = getSessionsRepository();
  const wf = `wf-hook-${++seq}`; const run = `run-hook-${seq}`;
  await repo.createWorkflow({
    id: wf, project_id: projectId, goal: 'g', status: 'failed', engine: 'claude-code', trust_tools: 0, lead_agent: null, workspace_id: null,
    output_files_enabled: 0, repo_ids: '[]', iteration_count: 0, max_iterations: 1, credential_id: null, model: '',
    created_by: null, created_at: now(), updated_at: now(),
  });
  await repo.createRun({ id: run, workflow_id: wf, status: 'failed', started_at: now(), finished_at: now(), cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: now() });
  await repo.updateRun(run, { error, stop_reason: stop } as never);
  return { wf, run };
}
async function addHuman(wf: string, body: string): Promise<void> {
  await getSessionsRepository().appendWorkflowEvent({ workflow_id: wf, kind: 'human', body, data: '{}', created_at: now() });
}

before(async () => {
  const { baseUrl } = await createTestServer();
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@hk.test', password: 'adminpassword1', name: 'A' } });
  const cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@hk.test', password: 'adminpassword1' } })).cookie ?? '';
  projectId = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'Hooks' }, cookie })).body as { project: { id: string } }).project.id;
});
after(() => cleanup());
beforeEach(async () => {
  dbRun('DELETE FROM autofix_findings');
  await saveAutofixPolicy(projectId, { mode: 'propose' });
});

describe('run lifecycle hooks', () => {
  it('two hooks both fire for one event', () => {
    const seen: string[] = [];
    const u1 = addRunLifecycleHook((_w, _r, e) => { seen.push(`a:${e}`); });
    const u2 = addRunLifecycleHook((_w, _r, e) => { seen.push(`b:${e}`); });
    fireRunLifecycleHook('w', 'r', 'done');
    u1(); u2();
    assert.deepEqual(seen, ['a:done', 'b:done']);
  });

  it('one hook throwing does not stop the other', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const seen: string[] = [];
    const u1 = addRunLifecycleHook(() => { throw new Error('sync boom'); });
    const u2 = addRunLifecycleHook(async () => { throw new Error('async boom'); });
    const u3 = addRunLifecycleHook((_w, _r, e) => { seen.push(e); });
    fireRunLifecycleHook('w', 'r', 'failed');
    await tick();
    u1(); u2(); u3();
    process.off('unhandledRejection', onUnhandled);
    assert.deepEqual(seen, ['failed']);
    assert.equal(unhandled.length, 0);
  });

  it('the unsubscribe function removes the hook', () => {
    let n = 0;
    const off = addRunLifecycleHook(() => { n++; });
    fireRunLifecycleHook('w', 'r', 'start');
    off();
    fireRunLifecycleHook('w', 'r', 'start');
    assert.equal(n, 1);
  });
});

describe('session_failed intake', () => {
  let off: () => void;
  before(() => { off = registerSessionIntake(); });
  after(() => off());

  it('a failed ordinary session creates a session_failed finding', async () => {
    const { wf, run } = await makeFailedRun('boom: Bearer abcdef1234567890abcdef');
    fireRunLifecycleHook(wf, run, 'failed', { cutOff: false });
    await tick();
    const all = await findings();
    assert.equal(all.length, 1);
    assert.equal(all[0].source, 'session_failed');
    assert.equal(all[0].kind, 'session');
    assert.equal(all[0].severity, 'medium');
    assert.equal(all[0].status, 'new');
    assert.ok(!all[0].evidence.includes('abcdef1234567890abcdef'));
  });

  it('policy off suppresses the finding', async () => {
    await saveAutofixPolicy(projectId, { mode: 'off' });
    const { wf, run } = await makeFailedRun();
    fireRunLifecycleHook(wf, run, 'failed');
    await tick();
    assert.equal((await findings())[0].status, 'suppressed');
  });

  it('a failed auto-fix session does not', async () => {
    const repo = getAutofixFindingsRepository();
    const { finding } = await repo.upsertByFingerprint({
      project_id: projectId, source: 'ci_failed', kind: 'tests', fingerprint: 'fp-x', severity: 'low', evidence: 'e', repo_id: null, branch: 'main', commit_sha: null,
    });
    const { wf, run } = await makeFailedRun();
    await repo.transition(finding.id, ['new'], { status: 'fixing', workflow_id: wf });
    fireRunLifecycleHook(wf, run, 'failed');
    await tick();
    assert.equal((await findings()).filter((f) => f.source === 'session_failed').length, 0);
  });

  it('a failure that recovery is continuing does not, and the same failure after the recovery cap does', async () => {
    const { wf, run } = await makeFailedRun('ACP error: kiro-cli process exited');
    await addHuman(wf, 'please do the thing');
    fireRunLifecycleHook(wf, run, 'failed', { cutOff: true });
    await tick();
    assert.equal((await findings()).length, 0, 'recovery will continue');

    for (let i = 0; i < MAX_AUTO_RECOVERIES; i++) await addHuman(wf, `${RECOVERY_PREFIX} Continue where you left off`);
    fireRunLifecycleHook(wf, run, 'failed', { cutOff: true });
    await tick();
    assert.equal((await findings()).length, 1, 'recovery cap reached');
  });
});
