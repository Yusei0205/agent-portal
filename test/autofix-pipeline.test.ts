/**
 * Auto-fix pipeline: a finding starts one loop session with the verify command as its check, and the session's end decides the
 * finding's next status. Most tests stub fireLoopSpec (the Demo engine never ends with a status line or a failing check); one test
 * starts a real Demo session.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { run as dbRun, all, one } from '../server/db.ts';
import { recordFinding } from '../server/autofix/intake.ts';
import { fireRunLifecycleHook } from '../server/agent/runner.ts';
import { getAutofixFindingsRepository } from '../server/repositories/autofix-findings.ts';
import type { AutofixFinding, UpsertFindingInput } from '../server/repositories/autofix-findings.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { getGitReposRepository } from '../server/repositories/git-repos.ts';
import { getLoopSpecsRepository } from '../server/repositories/loop-specs.ts';
import type { LoopSpecRecord } from '../server/repositories/loop-specs.ts';
import { saveAutofixPolicy, getAutofixPolicy, setPaused } from '../server/autofix/policy.ts';
import type { FireOptions, FireResult } from '../server/loop-triggers.ts';
import { fillGoal } from '../server/loop-triggers.ts';
import { newLoopState, readLoopState, afterRun } from '../server/workflows/loop.ts';
import { cancelRun } from '../server/workflows/controls.ts';
import {
  processFinding, processNew, onFixSessionEnded, maybeProcess, cannotReproduce, _setFireLoopSpec, _drainPipelineForTest,
} from '../server/autofix/pipeline.ts';
import { now } from '../server/util.ts';

let baseUrl = '';
let cookie = '';
let adminId = '';
let projectId = '';
let repoId = '';
let seq = 0;

const repo = () => getAutofixFindingsRepository();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeProject(name: string): Promise<string> {
  return ((await fetchJson(baseUrl, '/api/projects', { body: { name }, cookie })).body as { project: { id: string } }).project.id;
}

async function newFinding(over: Partial<UpsertFindingInput> = {}, pid = projectId): Promise<AutofixFinding> {
  const { finding } = await repo().upsertByFingerprint({
    project_id: pid, source: 'ci_failed', kind: 'tests', fingerprint: `fp-${++seq}-${Date.now()}`, severity: 'medium',
    evidence: 'FAIL test/widgets.test.ts: expected 2, got 3', repo_id: repoId, branch: 'main', commit_sha: 'abc123', ...over,
  });
  return finding;
}

function inboxItems(pid = projectId): Array<{ type: string; payload: Record<string, unknown>; workflow_id: string | null }> {
  return all<{ type: string; payload: string; workflow_id: string | null }>('SELECT * FROM p6_inbox WHERE project_id = ? ORDER BY created_at', pid)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

// ── fireLoopSpec stub ────────────────────────────────────────────────────────

type Call = { spec: LoopSpecRecord; opts: FireOptions; workflowId?: string };
let calls: Call[] = [];
let nextResult: FireResult | null = null;

/** Records the call; unless a result is queued, creates the session record the real fireLoopSpec would create (without running it). */
async function stubFire(spec: LoopSpecRecord, opts: FireOptions): Promise<FireResult> {
  const call: Call = { spec, opts };
  calls.push(call);
  if (nextResult) { const r = nextResult; nextResult = null; return r; }
  const id = `wf-pipe-${++seq}`;
  const goal = fillGoal(spec.goal_template, opts.vars ?? {});
  const sessions = getSessionsRepository();
  await sessions.createWorkflow({
    id, project_id: opts.projectId!, goal, status: 'running', engine: opts.engine ?? 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
    output_files_enabled: 0, repo_ids: JSON.stringify(opts.repoIds ?? []), iteration_count: 0, max_iterations: spec.max_iterations, credential_id: null,
    model: '', created_by: opts.runAs ?? null, created_at: now(), updated_at: now(),
  });
  await sessions.updateWorkflow(id, { loop_state: newLoopState({}, { checks: opts.checks }) });
  call.workflowId = id;
  return { ok: true, workflowId: id, runId: `lr-${seq}`, goal, run: {} as never };
}

/** A finished run of the session with a cost, as the runner leaves it. */
async function addRun(workflowId: string, cost: number): Promise<string> {
  const id = `run-pipe-${++seq}`;
  await getSessionsRepository().createRun({
    id, workflow_id: workflowId, status: 'done', started_at: now(), finished_at: now(), cost_usd: cost, input_tokens: 0, output_tokens: 0, created_at: now(),
  });
  return id;
}

/** Ends the session as the loop would: the final workflow status and the last check result. */
async function endSession(workflowId: string, status: string, lastCheck: { ok: boolean; output: string } | null): Promise<void> {
  const sessions = getSessionsRepository();
  const w = (await sessions.getWorkflowById(workflowId))!;
  const state = readLoopState(w)!;
  state.lastCheck = lastCheck;
  state.summaries = [...state.summaries, lastCheck?.ok ? 'Fixed the off-by-one in widgets.' : 'Tried a fix; tests still fail.'];
  await sessions.updateWorkflow(workflowId, { status, loop_state: JSON.stringify(state) });
}

before(async () => {
  ({ baseUrl } = await createTestServer());
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@pipe.test', password: 'adminpassword1', name: 'A' } });
  cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@pipe.test', password: 'adminpassword1' } })).cookie ?? '';
  adminId = String((((await fetchJson(baseUrl, '/api/auth/state', { cookie })).body as Record<string, unknown>).user as Record<string, unknown>).id);
  projectId = await makeProject('Pipeline');
  repoId = 'repo-pipe-1';
  await getGitReposRepository().create({
    id: repoId, project_id: projectId, name: 'widgets', url: 'https://github.com/acme/widgets.git', provider: 'github', status: 'pending',
    default_branch: 'main', identity: null, last_synced_at: null, last_error: null, created_at: now(), connection_id: null,
  });
});
after(async () => {
  _setFireLoopSpec(null);
  await cleanup();
});
beforeEach(async () => {
  dbRun('DELETE FROM autofix_findings WHERE project_id = ?', projectId);
  dbRun('DELETE FROM p6_inbox WHERE project_id = ?', projectId);
  calls = []; nextResult = null;
  _setFireLoopSpec(stubFire);
  await setPaused(projectId, false);
  await saveAutofixPolicy(projectId, {
    mode: 'propose', engine: 'demo', verify: { command: 'npm test', quick_commands: ['npm run lint'] }, run_as: adminId,
  }, { actorId: adminId, isAdmin: true });
});
afterEach(async () => { await _drainPipelineForTest(); });

describe('the seeded spec', () => {
  it('builtin-autofix-ci is a webhook spec for ci_failed findings with the verify command in its goal', async () => {
    const spec = (await getLoopSpecsRepository().getSpecById('builtin-autofix-ci'))!;
    assert.ok(spec);
    assert.equal(spec.trigger_type, 'webhook');
    assert.deepEqual(JSON.parse(spec.trigger_config), { finding_kind: 'ci_failed', maxPerHour: 12 });
    assert.deepEqual(JSON.parse(spec.stop_config), { maxIterations: 4, budgetUsd: 2 });
    assert.equal(spec.max_iterations, 4);
    for (const v of ['{{kind}}', '{{branch}}', '{{evidence}}', '{{verify_command}}']) assert.ok(spec.goal_template.includes(v), v);
    assert.match(spec.goal_template, /cannot reproduce/);
    assert.match(spec.goal_template, /\.github\/workflows/);
  });
});

describe('processFinding', () => {
  it("a triaged finding starts one session with the verify command as its loop check and becomes 'fixing' with workflow_id set", async () => {
    const f = await newFinding();
    await processFinding(f.id);
    assert.equal(calls.length, 1);
    const { spec, opts, workflowId } = calls[0];
    assert.equal(spec.id, 'builtin-autofix-ci');
    assert.equal(opts.source, 'webhook');
    assert.equal(opts.projectId, projectId);
    assert.equal(opts.runAs, adminId);
    assert.equal(opts.engine, 'demo');
    assert.deepEqual(opts.repoIds, [repoId]);
    assert.deepEqual(opts.checks, [{ step: 'verify', cmd: 'npm test' }, { step: 'quick 1', cmd: 'npm run lint' }]);
    assert.equal(opts.vars?.verify_command, 'npm test');
    assert.equal(opts.vars?.kind, 'tests');
    assert.equal(opts.vars?.branch, 'main');
    assert.match(String(opts.vars?.evidence), /expected 2, got 3/);
    const got = (await repo().getById(f.id))!;
    assert.equal(got.status, 'fixing');
    assert.equal(got.workflow_id, workflowId);
    const w = (await getSessionsRepository().getWorkflowById(workflowId!))!;
    assert.match(String(w.goal), /npm test/);
    assert.deepEqual(readLoopState(w)?.checks?.map((c) => c.cmd), ['npm test', 'npm run lint']);
    // Processing it again starts nothing more.
    await processFinding(f.id);
    assert.equal(calls.length, 1);
  });

  it('a deferred or suppressed triage result starts nothing', async () => {
    await setPaused(projectId, true);
    const deferred = await newFinding();
    await processFinding(deferred.id);
    assert.equal((await repo().getById(deferred.id))!.status, 'new');
    await setPaused(projectId, false);

    const suppressed = await newFinding({ kind: 'deploy' });
    await processFinding(suppressed.id);
    assert.equal((await repo().getById(suppressed.id))!.status, 'suppressed');

    const cooling = await newFinding();
    await repo().transition(cooling.id, ['new'], { status: 'new', cooldown_until: new Date(Date.now() + 600_000).toISOString() });
    await processFinding(cooling.id);
    assert.equal((await repo().getById(cooling.id))!.status, 'new');
    assert.equal(calls.length, 0);
  });

  it('a finding at the attempt limit goes to needs_human with a blocked inbox item', async () => {
    const f = await newFinding();
    await repo().transition(f.id, ['new'], { status: 'new', attempts: 2 });
    await processFinding(f.id);
    assert.equal((await repo().getById(f.id))!.status, 'needs_human');
    assert.equal(calls.length, 0);
    const items = inboxItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'blocked');
    assert.equal(items[0].payload.kind, 'autofix');
  });

  it("a 409 from fireLoopSpec leaves the finding 'new'", async () => {
    const f = await newFinding();
    nextResult = { ok: false, status: 409, reason: 'The previous session of this spec is still running.' };
    await processFinding(f.id);
    let got = (await repo().getById(f.id))!;
    assert.equal(got.status, 'new');
    assert.equal(got.attempts, 0);
    assert.equal(got.workflow_id, null);
    nextResult = { ok: false, status: 429, reason: 'hourly limit' };
    await processFinding(f.id);
    got = (await repo().getById(f.id))!;
    assert.equal(got.status, 'new');
    assert.equal(got.attempts, 0);
  });

  it('another error from fireLoopSpec counts an attempt and leaves the finding new', async () => {
    const f = await newFinding();
    nextResult = { ok: false, status: 400, reason: 'This loop spec is disabled.' };
    await processFinding(f.id);
    const got = (await repo().getById(f.id))!;
    assert.equal(got.status, 'new');
    assert.equal(got.attempts, 1);
  });

  it("a 403 (run_as lost edit access) moves the finding to needs_human with a 'blocked' inbox item", async () => {
    const f = await newFinding();
    nextResult = { ok: false, status: 403, reason: 'The person who set this trigger up no longer has edit access to the project.' };
    await processFinding(f.id);
    assert.equal((await repo().getById(f.id))!.status, 'needs_human');
    const items = inboxItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'blocked');
    assert.equal(items[0].payload.kind, 'autofix');
    assert.equal(items[0].payload.reason, 'the run_as user has no edit access to this project');
  });

  it('a finding with no verify command configured stays new and starts nothing', async () => {
    // Saving refuses mode != off without a command, so write the stored document directly (an older policy could hold this).
    const { getDb } = await import('../server/db.ts');
    const { setSetting } = await import('../server/settings.ts');
    const stored = await getAutofixPolicy(projectId);
    await setSetting(getDb(), `autofix.policy.${projectId}`, JSON.stringify({ ...stored, verify: { command: '', quick_commands: [] } }));
    const f = await newFinding();
    await processFinding(f.id);
    assert.equal((await repo().getById(f.id))!.status, 'new');
    assert.equal(calls.length, 0);
  });

  it("maybeProcess does nothing when the policy mode is 'off'", async () => {
    const f = await newFinding();
    await saveAutofixPolicy(projectId, { mode: 'off' }, { actorId: adminId, isAdmin: true });
    await maybeProcess(f.id);
    assert.equal(calls.length, 0);
    assert.equal((await repo().getById(f.id))!.status, 'new');
  });
});

describe('cannot reproduce detection', () => {
  const finalMessage = [
    'I ran `npm test` first, as asked. All 214 tests pass on this branch, including test/widgets.test.ts, so the failure from CI',
    'does not happen here. I changed nothing.',
    '',
    'WORKFLOW_STATUS {"state":"blocked","summary":"cannot reproduce: npm test passed (214 tests, 0 failures)","next":"","needs":"a person to look at the failure"}',
  ].join('\n');

  it('reads the summary of the final status line', async () => {
    const { parseStatus } = await import('../server/loop-iteration.ts');
    assert.equal(cannotReproduce(parseStatus(finalMessage)?.summary), true);
    assert.equal(cannotReproduce('Cannot reproduce: the check passes'), true);
    assert.equal(cannotReproduce('Fixed the off-by-one; npm test passes now'), false);
    assert.equal(cannotReproduce(''), false);
    assert.equal(cannotReproduce(undefined), false);
  });

  it("a session that reports \"cannot reproduce\" ends needs_human with a 'blocked' inbox item whose payload.kind is 'autofix'", async () => {
    const f = await newFinding();
    await processFinding(f.id);
    const wf = calls[0].workflowId!;
    const runId = await addRun(wf, 0.4);
    // The loop reads the agent's final message and stops the session (state "blocked").
    const decision = await afterRun(wf, { result: finalMessage, failed: false, runId, checkPassed: true });
    assert.equal(decision?.action, 'stop');
    fireRunLifecycleHook(wf, runId, 'done', { loopEnded: true });
    await _drainPipelineForTest();
    const got = (await repo().getById(f.id))!;
    assert.equal(got.status, 'needs_human');
    assert.equal(got.attempts, 0);
    assert.ok(Math.abs(got.cost_usd - 0.4) < 1e-9, String(got.cost_usd));
    const items = inboxItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'blocked');
    assert.equal(items[0].payload.kind, 'autofix');
    assert.equal(items[0].workflow_id, wf);
  });
});

describe('onFixSessionEnded', () => {
  it("a session whose last loop check failed counts an attempt and returns the finding to 'new'", async () => {
    const f = await newFinding();
    await processFinding(f.id);
    const wf = calls[0].workflowId!;
    await addRun(wf, 0.25);
    await endSession(wf, 'paused', { ok: false, output: 'FAIL test/widgets.test.ts' });
    const before = Date.now();
    await onFixSessionEnded(wf);
    const got = (await repo().getById(f.id))!;
    assert.equal(got.status, 'new');
    assert.equal(got.attempts, 1);
    assert.ok(Math.abs(got.cost_usd - 0.25) < 1e-9);
    const cool = Date.parse(String(got.cooldown_until));
    assert.ok(cool >= before + 59 * 60_000 && cool <= Date.now() + 61 * 60_000, String(got.cooldown_until));
    // The cooldown keeps it from being picked up again right away.
    assert.equal(calls.length, 1);
  });

  it('a session that failed counts an attempt too', async () => {
    const f = await newFinding();
    await processFinding(f.id);
    const wf = calls[0].workflowId!;
    await endSession(wf, 'failed', null);
    await onFixSessionEnded(wf);
    const got = (await repo().getById(f.id))!;
    assert.equal(got.status, 'new');
    assert.equal(got.attempts, 1);
  });

  it('a failed attempt that reaches max_attempts goes straight to needs_human with a blocked inbox item', async () => {
    const f = await newFinding();
    await repo().transition(f.id, ['new'], { status: 'new', attempts: 1 }); // max_attempts is 2
    await processFinding(f.id);
    const wf = calls[0].workflowId!;
    await endSession(wf, 'paused', { ok: false, output: 'FAIL' });
    await onFixSessionEnded(wf);
    const got = (await repo().getById(f.id))!;
    assert.equal(got.status, 'needs_human');
    assert.equal(got.attempts, 2);
    const items = inboxItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'blocked');
    assert.equal(items[0].payload.kind, 'autofix');
    assert.equal(items[0].payload.reason, 'attempt limit reached');
  });

  it("a session that ends with checks passing while its change is being delivered leaves the finding 'fixing' for the PR step", async () => {
    const f = await newFinding();
    await processFinding(f.id);
    const wf = calls[0].workflowId!;
    await addRun(wf, 0.1);
    // The PR gate (delivery.ts) records the fix branch while the run is still open.
    await repo().transition(f.id, ['fixing'], { status: 'fixing', fix_branch: 'autofix/tests-12345678' });
    await endSession(wf, 'done', { ok: true, output: 'verify: ok' });
    await onFixSessionEnded(wf);
    const got = (await repo().getById(f.id))!;
    assert.equal(got.status, 'fixing');
    assert.equal(got.workflow_id, wf);
    assert.equal(got.attempts, 0);
    assert.ok(Math.abs(got.cost_usd - 0.1) < 1e-9);
    assert.equal(inboxItems().length, 0);
  });

  it("a session that ends with checks passing but reported no repository change goes to needs_human ('fix produced no changes')", async () => {
    const f = await newFinding();
    await processFinding(f.id);
    const wf = calls[0].workflowId!;
    await addRun(wf, 0.1);
    await endSession(wf, 'done', { ok: true, output: 'verify: ok' });
    await onFixSessionEnded(wf);
    const got = (await repo().getById(f.id))!;
    assert.equal(got.status, 'needs_human');
    assert.equal(got.attempts, 0);
    const items = inboxItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'blocked');
    assert.equal(items[0].payload.reason, 'fix produced no changes');
  });

  it('a pull-request event of the session also counts as delivery under way', async () => {
    const f = await newFinding();
    await processFinding(f.id);
    const wf = calls[0].workflowId!;
    const runId = await addRun(wf, 0);
    dbRun(`INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?,?,?,?)`, runId, 'pull-request', JSON.stringify({ repo: 'widgets', repoId, state: 'asked' }), now());
    await endSession(wf, 'done', { ok: true, output: 'verify: ok' });
    await onFixSessionEnded(wf);
    assert.equal((await repo().getById(f.id))!.status, 'fixing');
  });

  it('a new fix session clears a fix branch left from an earlier attempt', async () => {
    const f = await newFinding();
    dbRun('UPDATE autofix_findings SET fix_branch = ? WHERE id = ?', 'autofix/tests-old', f.id);
    await processFinding(f.id);
    assert.equal((await repo().getById(f.id))!.fix_branch, null);
  });

  it('the run hook ignores an iteration after which the loop goes on, and a failure recovery is continuing', async () => {
    const f = await newFinding();
    await processFinding(f.id);
    const wf = calls[0].workflowId!;
    await endSession(wf, 'running', { ok: false, output: 'FAIL' });
    fireRunLifecycleHook(wf, 'r1', 'done', { loopEnded: false });
    fireRunLifecycleHook(wf, 'r2', 'failed', { recovering: true, loopEnded: true });
    await _drainPipelineForTest();
    assert.equal((await repo().getById(f.id))!.status, 'fixing');
  });

  it('a cancelled session returns the finding to new without counting an attempt', async () => {
    const f = await newFinding();
    await processFinding(f.id);
    const wf = calls[0].workflowId!;
    fireRunLifecycleHook(wf, 'r1', 'cancelled');
    await _drainPipelineForTest();
    const got = (await repo().getById(f.id))!;
    assert.equal(got.status, 'new');
    assert.equal(got.attempts, 0);
  });

  it('when a session ends, a finding that was held back by the previous session (409) is started', async () => {
    const a = await newFinding();
    await processFinding(a.id);
    const b = await newFinding({ evidence: 'FAIL lint: unused variable x' });
    nextResult = { ok: false, status: 409, reason: 'The previous session of this spec is still running.' };
    await processFinding(b.id);
    assert.equal((await repo().getById(b.id))!.status, 'new');
    const wf = calls[0].workflowId!;
    await endSession(wf, 'done', { ok: true, output: 'ok' });
    await onFixSessionEnded(wf);
    const got = (await repo().getById(b.id))!;
    assert.equal(got.status, 'fixing');
    assert.equal(calls.length, 3);
  });

  it('processNew starts the oldest new findings of the project', async () => {
    const a = await newFinding();
    const b = await newFinding({ source: 'session_failed', kind: 'session' });
    await processNew(projectId);
    assert.equal((await repo().getById(a.id))!.status, 'fixing');
    assert.equal(calls.length, 1, 'only findings with a fixer spec start a session');
    // A failed session never starts a fix session; 'session' is not in the default classes, so triage suppresses it.
    assert.equal((await repo().getById(b.id))!.status, 'suppressed');
  });
});

describe('held-back findings', () => {
  let otherProject = '';
  before(async () => { otherProject = await makeProject('Pipeline B'); });
  beforeEach(async () => {
    dbRun('DELETE FROM autofix_findings WHERE project_id = ?', otherProject);
    await saveAutofixPolicy(otherProject, {
      mode: 'propose', engine: 'demo', verify: { command: 'npm test', quick_commands: [] }, run_as: adminId,
    }, { actorId: adminId, isAdmin: true });
  });

  it("another project's finding held back by the portal-wide spec (409) is retried when a session ends", async () => {
    const a = await newFinding();
    await processFinding(a.id);
    const b = await newFinding({ repo_id: null, branch: null }, otherProject);
    nextResult = { ok: false, status: 409, reason: 'The previous session of this spec is still running.' };
    await processFinding(b.id);
    assert.equal((await repo().getById(b.id))!.status, 'new');
    const wf = calls[0].workflowId!;
    await endSession(wf, 'done', { ok: true, output: 'ok' });
    await onFixSessionEnded(wf);
    assert.equal((await repo().getById(b.id))!.status, 'fixing');
    assert.equal(calls[calls.length - 1].opts.projectId, otherProject);
  });

  it('a repeat delivery for an existing new finding retries it', async () => {
    const candidate = { repoFullName: 'acme/widgets', branch: 'main', headSha: 'abc', source: 'ci_failed' as const, kind: 'tests', severity: 'medium' as const, errorText: 'unit failure' };
    nextResult = { ok: false, status: 429, reason: 'hourly limit' };
    const first = await recordFinding(projectId, candidate, 'FAIL unit');
    await _drainPipelineForTest();
    assert.equal(first.created, true);
    assert.equal((await repo().getById(first.finding.id))!.status, 'new');
    assert.equal(calls.length, 1);
    await recordFinding(projectId, candidate, 'FAIL unit again');
    await _drainPipelineForTest();
    assert.equal((await repo().getById(first.finding.id))!.status, 'fixing');
    assert.equal(calls.length, 2);
  });

  it('two concurrent processFinding / maybeProcess calls start exactly one session', async () => {
    const f = await newFinding();
    await Promise.all([processFinding(f.id), maybeProcess(f.id), processFinding(f.id)]);
    assert.equal(calls.length, 1);
    assert.equal((await repo().getById(f.id))!.status, 'fixing');
  });

  it('a missing fixer spec is warned about once and leaves the finding new', async () => {
    const row = one<Record<string, unknown>>("SELECT * FROM p10_loop_specs WHERE id = 'builtin-autofix-ci'")!;
    dbRun("DELETE FROM p10_loop_specs WHERE id = 'builtin-autofix-ci'");
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    try {
      const f = await newFinding();
      await processFinding(f.id);
      await processFinding(f.id);
      assert.equal((await repo().getById(f.id))!.status, 'new');
    } finally {
      console.warn = orig;
      const cols = Object.keys(row);
      dbRun(`INSERT INTO p10_loop_specs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...(cols.map((c) => row[c]) as never[]));
    }
    assert.equal(warnings.filter((w) => w.includes('builtin-autofix-ci')).length, 1, JSON.stringify(warnings));
    assert.equal(calls.length, 0);
  });
});

describe('with the Demo engine', () => {
  it('starts a real loop session as run_as with the verify command as its check', async () => {
    _setFireLoopSpec(null);
    const pid = await makeProject('Pipeline demo');
    await saveAutofixPolicy(pid, { mode: 'propose', engine: 'demo', verify: { command: 'echo verify-ok', quick_commands: [] }, run_as: adminId }, { actorId: adminId, isAdmin: true });
    const f = await newFinding({ repo_id: null, branch: null }, pid);
    await processFinding(f.id);
    const got = (await repo().getById(f.id))!;
    assert.equal(got.status, 'fixing');
    assert.ok(got.workflow_id);
    const w = (await getSessionsRepository().getWorkflowById(got.workflow_id!))!;
    assert.equal(w.engine, 'demo');
    assert.equal(w.created_by, adminId);
    assert.equal(Number(w.trust_tools), 0);
    assert.deepEqual(readLoopState(w)?.checks, [{ step: 'verify', cmd: 'echo verify-ok' }]);
    assert.match(String(w.goal), /echo verify-ok/);

    // Stopping the session hands the finding back without counting an attempt.
    for (let i = 0; i < 100; i++) {
      const active = await getSessionsRepository().getActiveRun(w.id);
      if (active && cancelRun(active.id)) break;
      await sleep(50);
    }
    let after: AutofixFinding | null = null;
    for (let i = 0; i < 100; i++) {
      await _drainPipelineForTest();
      after = await repo().getById(f.id);
      if (after?.status !== 'fixing') break;
      await sleep(50);
    }
    assert.equal(after?.status, 'new');
    assert.equal(after?.attempts, 0);
  });
});
