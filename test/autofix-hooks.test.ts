import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { run as dbRun } from '../server/db.ts';
import { addRunLifecycleHook, fireRunLifecycleHook } from '../server/agent/runner.ts';
import { registerSessionIntake } from '../server/autofix/session-intake.ts';
import { getAutofixFindingsRepository } from '../server/repositories/autofix-findings.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { saveAutofixPolicy } from '../server/autofix/policy.ts';
import { _drainPipelineForTest } from '../server/autofix/pipeline.ts';
import { RECOVERY_PREFIX, MAX_AUTO_RECOVERIES } from '../server/workflows/recovery.ts';
import { now } from '../server/util.ts';
import { getLoopSpecsRepository } from '../server/repositories/loop-specs.ts';
import { fireLoopSpec } from '../server/loop-triggers.ts';
import type { RunLifecycleDetail } from '../server/agent/runner.ts';

let projectId = '';
let adminId = '';
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
  adminId = String((((await fetchJson(baseUrl, '/api/auth/state', { cookie })).body as Record<string, unknown>).user as Record<string, unknown>).id);
});
after(() => cleanup());
beforeEach(async () => {
  dbRun('DELETE FROM autofix_findings');
  await saveAutofixPolicy(projectId, { mode: 'propose', verify: { command: 'npm test', quick_commands: [] } });
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
    fireRunLifecycleHook(wf, run, 'failed', { recovering: false });
    await tick();
    const all = await findings();
    assert.equal(all.length, 1);
    assert.equal(all[0].source, 'session_failed');
    assert.equal(all[0].kind, 'session');
    assert.equal(all[0].severity, 'medium');
    // A failed session never starts a fix session (pipeline.ts AUTOFIX_HUMAN_SOURCES); 'session' is not in the default classes.
    await _drainPipelineForTest();
    assert.equal((await findings())[0].status, 'suppressed');
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

  it('a failure the runner says is being recovered does not create a finding; the same failure not recovered does', async () => {
    const { wf, run } = await makeFailedRun('ACP error: kiro-cli process exited');
    fireRunLifecycleHook(wf, run, 'failed', { recovering: true });
    await tick();
    assert.equal((await findings()).length, 0);
    fireRunLifecycleHook(wf, run, 'failed', { recovering: false });
    await tick();
    assert.equal((await findings()).length, 1);
  });

  it('the intake does not read human events itself', async () => {
    const { wf, run } = await makeFailedRun('ACP error: kiro-cli process exited');
    const repo = getSessionsRepository();
    const orig = repo.listHumanWorkflowEvents.bind(repo);
    let reads = 0;
    (repo as { listHumanWorkflowEvents: unknown }).listHumanWorkflowEvents = (...a: Parameters<typeof orig>) => { reads++; return orig(...a); };
    try {
      for (let i = 0; i < MAX_AUTO_RECOVERIES; i++) await addHuman(wf, `${RECOVERY_PREFIX} Continue`);
      fireRunLifecycleHook(wf, run, 'failed', { recovering: true });
      await tick();
    } finally { (repo as { listHumanWorkflowEvents: unknown }).listHumanWorkflowEvents = orig; }
    assert.equal(reads, 0);
    assert.equal((await findings()).length, 0);
  });

  it('different error messages give different findings; the same message with other timestamps and ids gives one', async () => {
    const a = await makeFailedRun('Tool crashed at 2026-01-01T10:00:00Z id deadbeef12345678');
    const b = await makeFailedRun('Tool crashed at 2026-02-02T11:11:11Z id 0123456789abcdef');
    const c = await makeFailedRun('Totally different failure');
    for (const x of [a, b, c]) { fireRunLifecycleHook(x.wf, x.run, 'failed', { recovering: false }); await tick(); }
    const all = await findings();
    assert.equal(all.length, 2);
    const same = all.find((f) => f.evidence.includes('Tool crashed'))!;
    assert.equal(same.occurrences, 2);
    const other = all.find((f) => f.evidence.includes('Totally different'))!;
    assert.ok(other.evidence.includes(c.wf) && other.evidence.includes(c.run));
  });

  async function skipCase(over: { kind?: string; noProject?: boolean; review?: boolean }): Promise<number> {
    const { wf, run } = await makeFailedRun();
    if (over.kind) dbRun('UPDATE p6_workflows SET kind = ? WHERE id = ?', over.kind, wf);
    if (over.noProject) dbRun('UPDATE p6_workflows SET project_id = NULL WHERE id = ?', wf);
    fireRunLifecycleHook(wf, run, 'failed', { recovering: false });
    await tick();
    return (await findings()).length;
  }
  it('skips review sessions, automation workflows and workflows without a project', async () => {
    assert.equal(await skipCase({ kind: 'review' }), 0);
    assert.equal(await skipCase({ kind: 'automation' }), 0);
    assert.equal(await skipCase({ noProject: true }), 0);
    assert.equal(await skipCase({}), 1, 'control: an ordinary session still creates one');
  });
});

describe('loop sessions', () => {
  it("a loop session's 'done' hook fires after the loop has decided, and says whether the loop ended", async () => {
    const spec = await getLoopSpecsRepository().createSpec({
      id: `spec-hook-${Date.now()}`, project_id: projectId, name: 'one iteration', description: null, trigger_type: 'manual', trigger_config: '{}',
      goal_template: 'Say hello', rules: null, stop_config: '{}', max_iterations: 1, enabled: 1, is_builtin: 0, created_at: now(),
    });
    const seen: Array<{ event: string; detail?: RunLifecycleDetail; status: string }> = [];
    let wfId = '';
    const off = addRunLifecycleHook(async (w, _r, event, detail) => {
      if (w !== wfId) return;
      const status = String((await getSessionsRepository().getWorkflowById(w))?.status);
      seen.push({ event, detail, status });
    });
    try {
      const r = await fireLoopSpec(spec, { source: 'manual', userId: adminId, engine: 'demo' });
      assert.equal(r.ok, true, JSON.stringify(r));
      wfId = (r as { workflowId: string }).workflowId;
      for (let i = 0; i < 300 && !seen.some((s) => s.event === 'done'); i++) await new Promise((res) => setTimeout(res, 50));
    } finally { off(); }
    const done = seen.find((s) => s.event === 'done');
    assert.ok(done, JSON.stringify(seen));
    assert.equal(done.detail?.loopEnded, true, 'one iteration of one: the loop stopped');
    assert.notEqual(done.status, 'running');
  });
});
