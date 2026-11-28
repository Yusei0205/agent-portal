/**
 * Closing the loop: CI results and PR closings on a fix branch move the finding on. Green CI on the PR head resolves it, red CI
 * counts an attempt and starts one retry on the same branch (or, at the limit, asks a person), a merged PR resolves it and a PR closed
 * without merging dismisses it with a cooldown. Late, duplicate or unrelated events change nothing. fireLoopSpec is stubbed.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { run as dbRun, all } from '../server/db.ts';
import { getAutofixFindingsRepository } from '../server/repositories/autofix-findings.ts';
import type { AutofixFinding, UpsertFindingInput } from '../server/repositories/autofix-findings.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { getGitReposRepository } from '../server/repositories/git-repos.ts';
import type { LoopSpecRecord } from '../server/repositories/loop-specs.ts';
import { saveAutofixPolicy, setPaused, DEFAULT_POLICY } from '../server/autofix/policy.ts';
import type { FireOptions, FireResult } from '../server/loop-triggers.ts';
import { fillGoal } from '../server/loop-triggers.ts';
import { newLoopState } from '../server/workflows/loop.ts';
import { recordFinding } from '../server/autofix/intake.ts';
import { _setEvidenceFetcher, _drainIntakeForTest } from '../server/autofix/webhook.ts';
import {
  applyCiResult, applyPrClosed, _setFireLoopSpec, _setPreviousFilesLister, _drainPipelineForTest,
} from '../server/autofix/pipeline.ts';
import { fixBranchName } from '../server/autofix/delivery.ts';
import { now } from '../server/util.ts';

let baseUrl = '';
let cookie = '';
let adminId = '';
let projectId = '';
let secret = '';
const repoId = 'repo-loop-1';
let seq = 0;

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const repo = () => getAutofixFindingsRepository();
const get = async (id: string): Promise<AutofixFinding> => (await repo().getById(id))!;

function inboxItems(): Array<{ type: string; payload: Record<string, unknown> }> {
  return all<{ type: string; payload: string }>('SELECT * FROM p6_inbox WHERE project_id = ? ORDER BY created_at', projectId)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

type Call = { spec: LoopSpecRecord; opts: FireOptions; goal: string };
let calls: Call[] = [];

async function stubFire(spec: LoopSpecRecord, opts: FireOptions): Promise<FireResult> {
  const id = `wf-loop-${++seq}`;
  const goal = fillGoal(spec.goal_template, opts.vars ?? {});
  calls.push({ spec, opts, goal });
  const sessions = getSessionsRepository();
  await sessions.createWorkflow({
    id, project_id: opts.projectId!, goal, status: 'running', engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
    output_files_enabled: 0, repo_ids: JSON.stringify(opts.repoIds ?? []), iteration_count: 0, max_iterations: spec.max_iterations, credential_id: null,
    model: '', created_by: opts.runAs ?? null, created_at: now(), updated_at: now(),
  });
  await sessions.updateWorkflow(id, { loop_state: newLoopState({}, { checks: opts.checks }) });
  return { ok: true, workflowId: id, runId: `lr-${seq}`, goal, run: {} as never };
}

/** A finding whose fix PR is open on its fix branch, pushed at HEAD. */
async function prOpen(over: Partial<UpsertFindingInput> = {}, patch: Partial<AutofixFinding> = {}): Promise<AutofixFinding> {
  const { finding } = await repo().upsertByFingerprint({
    project_id: projectId, source: 'ci_failed', kind: 'tests', fingerprint: `ab12cd34${++seq}x${Date.now()}`, severity: 'medium',
    evidence: 'FAIL test/widgets.test.ts: expected 2, got 3', repo_id: repoId, branch: 'main', commit_sha: 'c0ffee', ...over,
  });
  const branch = fixBranchName(finding.kind, finding.fingerprint);
  assert.ok(await repo().transition(finding.id, ['new'], {
    status: 'pr_open', workflow_id: `wf-first-${seq}`, fix_branch: branch, pr_branch: branch, pr_number: 42,
    pr_url: 'https://github.com/acme/widgets/pull/42', pr_head_sha: HEAD, ...patch,
  }));
  return get(finding.id);
}

const ci = (f: AutofixFinding, conclusion: 'success' | 'failure', headSha = HEAD, workflowName = 'CI / tests') => ({
  type: 'ci_result' as const, repoFullName: 'acme/widgets', branch: f.fix_branch!, conclusion, headSha, workflowName, runId: 77,
});
const closed = (f: AutofixFinding, merged: boolean, prNumber = 42) => ({
  type: 'pr_closed' as const, repoFullName: 'acme/widgets', branch: f.fix_branch!, merged, prNumber,
});
const redEvidence = async () => 'FAIL test/widgets.test.ts on the fix branch: expected 3, got 4\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const sign = (body: string): string => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
async function deliver(body: string, event: string): Promise<number> {
  const r = await fetch(`${baseUrl}/api/hooks/autofix/${projectId}`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sign(body) },
  });
  await _drainIntakeForTest();
  await _drainPipelineForTest();
  return r.status;
}
const fx = (n: string): string => fs.readFileSync(new URL(`./fixtures/github/${n}.json`, import.meta.url), 'utf8');

before(async () => {
  ({ baseUrl } = await createTestServer());
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@loop.test', password: 'adminpassword1', name: 'A' } });
  cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@loop.test', password: 'adminpassword1' } })).cookie ?? '';
  adminId = String((((await fetchJson(baseUrl, '/api/auth/state', { cookie })).body as Record<string, unknown>).user as Record<string, unknown>).id);
  projectId = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'Loop' }, cookie })).body as { project: { id: string } }).project.id;
  await getGitReposRepository().create({
    id: repoId, project_id: projectId, name: 'widgets', url: 'https://github.com/acme/widgets.git', provider: 'github', status: 'ready',
    default_branch: 'main', identity: null, last_synced_at: null, last_error: null, created_at: now(), connection_id: null,
  });
  const rot = await fetchJson(baseUrl, `/api/projects/${projectId}/autofix/webhook-secret`, { method: 'POST', body: {}, cookie });
  secret = (rot.body as { secret: string }).secret;
});
after(async () => {
  _setFireLoopSpec(null);
  _setPreviousFilesLister(null);
  _setEvidenceFetcher();
  await cleanup();
});
beforeEach(async () => {
  dbRun('DELETE FROM autofix_findings WHERE project_id = ?', projectId);
  dbRun('DELETE FROM p6_inbox WHERE project_id = ?', projectId);
  calls = [];
  _setFireLoopSpec(stubFire);
  _setPreviousFilesLister(async () => ['src/widgets.ts', 'test/widgets.test.ts']);
  _setEvidenceFetcher(redEvidence);
  await setPaused(projectId, false);
  await saveAutofixPolicy(projectId, {
    mode: 'propose', engine: 'demo', verify: { command: 'npm test', quick_commands: [] }, run_as: adminId,
    limits: { ...DEFAULT_POLICY.limits, max_attempts: 2, cooldown_minutes: 60 },
  }, { actorId: adminId, isAdmin: true });
});
afterEach(async () => { await _drainPipelineForTest(); });

describe('CI results on the fix branch', () => {
  it('green CI on the fix branch moves pr_open to resolved', async () => {
    const f = await prOpen();
    await applyCiResult(projectId, ci(f, 'success'));
    assert.equal((await get(f.id)).status, 'resolved');
    assert.equal(calls.length, 0);
  });

  it('a success for an older commit than the PR head does not resolve it', async () => {
    const f = await prOpen();
    await applyCiResult(projectId, ci(f, 'success', OLD));
    assert.equal((await get(f.id)).status, 'pr_open');
  });

  it('a success of a workflow of another kind (lint for a tests fix) does not resolve it', async () => {
    const f = await prOpen();
    await applyCiResult(projectId, ci(f, 'success', HEAD, 'CI / eslint'));
    assert.equal((await get(f.id)).status, 'pr_open');
  });

  it('red CI counts an attempt and, below max_attempts, starts one retry session whose goal includes the previous diff', async () => {
    const f = await prOpen();
    await applyCiResult(projectId, ci(f, 'failure'), { evidence: redEvidence });
    await _drainPipelineForTest();
    assert.equal(calls.length, 1);
    const prev = String(calls[0].opts.vars?.previous_attempt);
    assert.match(prev, /expected 3, got 4/);
    assert.match(prev, /src\/widgets\.ts/);
    assert.match(prev, /#42/);
    assert.ok(prev.includes(f.fix_branch!), 'names the fix branch to continue on');
    assert.doesNotMatch(prev, /ghp_abcdefghij/);
    assert.ok(prev.length <= 4000);
    assert.ok(calls[0].goal.includes(prev), 'the seeded goal template carries {{previous_attempt}}');
    assert.match(calls[0].goal, /expected 2, got 3/);
    const got = await get(f.id);
    assert.equal(got.status, 'fixing');
    assert.equal(got.attempts, 1);
    assert.equal(got.pr_branch, f.fix_branch, 'the retry keeps the PR branch to push to');
    assert.equal(got.pr_number, 42);
    assert.equal(got.fix_branch, null);
    assert.equal(got.cooldown_until, null);
  });

  it('previous_attempt is capped at 4000 characters and keeps the tail of the CI output', async () => {
    const f = await prOpen();
    await applyCiResult(projectId, ci(f, 'failure'), { evidence: async () => `${'noise line\n'.repeat(2000)}THE REAL ERROR AT THE END` });
    await _drainPipelineForTest();
    const prev = String(calls[0].opts.vars?.previous_attempt);
    assert.ok(prev.length <= 4000, String(prev.length));
    assert.match(prev, /THE REAL ERROR AT THE END/);
  });

  it('a first attempt passes an empty-attempt note, not a raw placeholder', async () => {
    const { processFinding } = await import('../server/autofix/pipeline.ts');
    const { finding } = await repo().upsertByFingerprint({
      project_id: projectId, source: 'ci_failed', kind: 'tests', fingerprint: `first-${++seq}`, severity: 'medium',
      evidence: 'boom', repo_id: repoId, branch: 'main', commit_sha: null,
    });
    await processFinding(finding.id);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].goal, /\{\{previous_attempt\}\}/);
    assert.match(String(calls[0].opts.vars?.previous_attempt), /none/i);
  });

  it('a duplicate red event while the retry is running starts no second session', async () => {
    const f = await prOpen();
    await applyCiResult(projectId, ci(f, 'failure'), { evidence: redEvidence });
    await _drainPipelineForTest();
    assert.equal(calls.length, 1);
    await applyCiResult(projectId, ci(f, 'failure'), { evidence: redEvidence });
    await _drainPipelineForTest();
    assert.equal(calls.length, 1);
    const got = await get(f.id);
    assert.equal(got.status, 'fixing');
    assert.equal(got.attempts, 1);
  });

  it('red CI at max_attempts moves the finding to needs_human and creates a blocked inbox item', async () => {
    const f = await prOpen({}, { attempts: 1 });
    await applyCiResult(projectId, ci(f, 'failure'), { evidence: redEvidence });
    await _drainPipelineForTest();
    const got = await get(f.id);
    assert.equal(got.status, 'needs_human');
    assert.equal(got.attempts, 2);
    assert.equal(calls.length, 0);
    const items = inboxItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'blocked');
    assert.equal(items[0].payload.kind, 'autofix');
    assert.equal(items[0].payload.reason, 'attempt limit reached');
    assert.equal(items[0].payload.findingId, f.id);
  });

  it("no retry starts while auto-fix is off or paused: the finding waits as 'new' with the attempt counted", async () => {
    await saveAutofixPolicy(projectId, { mode: 'off' }, { actorId: adminId, isAdmin: true });
    const off = await prOpen();
    await applyCiResult(projectId, ci(off, 'failure'), { evidence: redEvidence });
    await _drainPipelineForTest();
    assert.equal(calls.length, 0);
    assert.equal((await get(off.id)).status, 'new');
    assert.equal((await get(off.id)).attempts, 1);

    await saveAutofixPolicy(projectId, { mode: 'propose' }, { actorId: adminId, isAdmin: true });
    await setPaused(projectId, true);
    const paused = await prOpen();
    await applyCiResult(projectId, ci(paused, 'failure'), { evidence: redEvidence });
    await _drainPipelineForTest();
    assert.equal(calls.length, 0);
    assert.equal((await get(paused.id)).status, 'new');
    assert.match(String((await get(paused.id)).previous_attempt), /expected 3, got 4/);
  });

  it('a red result for an older commit than the PR head is ignored', async () => {
    const f = await prOpen();
    await applyCiResult(projectId, ci(f, 'failure', OLD), { evidence: redEvidence });
    await _drainPipelineForTest();
    assert.equal((await get(f.id)).status, 'pr_open');
    assert.equal((await get(f.id)).attempts, 0);
    assert.equal(calls.length, 0);
  });
});

describe('PR closed', () => {
  it('a merged PR resolves the finding', async () => {
    const f = await prOpen();
    await applyPrClosed(projectId, closed(f, true));
    assert.equal((await get(f.id)).status, 'resolved');
  });

  it('a PR closed without merging moves it to dismissed and sets cooldown_until to now plus cooldown_minutes', async () => {
    const f = await prOpen();
    const t0 = Date.now();
    await applyPrClosed(projectId, closed(f, false));
    const got = await get(f.id);
    assert.equal(got.status, 'dismissed');
    const until = Date.parse(got.cooldown_until!);
    assert.ok(until >= t0 + 60 * 60_000 - 1000 && until <= Date.now() + 60 * 60_000 + 1000, got.cooldown_until!);
  });

  it('a recurrence of the same failure during the cooldown is not proposed again (recordFinding counts it only)', async () => {
    await setPaused(projectId, true); // so the first delivery stays 'new' without a session
    const candidate = {
      repoFullName: 'acme/widgets', branch: 'main', headSha: 'd'.repeat(40), source: 'ci_failed' as const, kind: 'tests',
      severity: 'medium' as const, errorText: 'CI / tests failure', runId: 5,
    };
    const { finding } = await recordFinding(projectId, candidate, 'FAIL once');
    await setPaused(projectId, false);
    const branch = fixBranchName(finding.kind, finding.fingerprint);
    assert.ok(await repo().transition(finding.id, ['new'], { status: 'pr_open', fix_branch: branch, pr_branch: branch, pr_number: 42, pr_head_sha: HEAD }));
    await applyPrClosed(projectId, closed(await get(finding.id), false));
    assert.equal((await get(finding.id)).status, 'dismissed');
    await recordFinding(projectId, candidate, 'FAIL again');
    await _drainPipelineForTest();
    const got = await get(finding.id);
    assert.equal(got.status, 'dismissed');
    assert.equal(got.occurrences, 2);
    assert.equal(calls.length, 0);
  });

  it('a closing of another PR number with the same head branch changes nothing', async () => {
    const f = await prOpen();
    await applyPrClosed(projectId, closed(f, true, 99));
    assert.equal((await get(f.id)).status, 'pr_open');
  });
});

describe('PR closed after green CI or during a retry', () => {
  /** A finding made through intake (so a recurrence matches its fingerprint), with its fix PR #42 open. */
  async function viaIntake(): Promise<{ f: AutofixFinding; candidate: Parameters<typeof recordFinding>[1] }> {
    await setPaused(projectId, true);
    const candidate = {
      repoFullName: 'acme/widgets', branch: 'main', headSha: 'd'.repeat(40), source: 'ci_failed' as const, kind: 'tests',
      severity: 'medium' as const, errorText: `CI / tests failure ${++seq}`, runId: 5,
    };
    const { finding } = await recordFinding(projectId, candidate, 'FAIL once');
    await setPaused(projectId, false);
    const branch = fixBranchName(finding.kind, finding.fingerprint);
    assert.ok(await repo().transition(finding.id, ['new'], {
      status: 'pr_open', fix_branch: branch, pr_branch: branch, pr_number: 42, pr_url: 'https://github.com/acme/widgets/pull/42', pr_head_sha: HEAD,
    }));
    return { f: await get(finding.id), candidate };
  }

  it('green then closed without merging: dismissed with the cooldown, and a recurrence during it is not proposed', async () => {
    const { f, candidate } = await viaIntake();
    await applyCiResult(projectId, ci(f, 'success'));
    assert.equal((await get(f.id)).status, 'resolved');
    const t0 = Date.now();
    await applyPrClosed(projectId, closed(f, false));
    const got = await get(f.id);
    assert.equal(got.status, 'dismissed');
    assert.ok(Date.parse(got.cooldown_until!) >= t0 + 60 * 60_000 - 1000);
    assert.equal(got.pr_branch, null);
    assert.equal(got.pr_head_sha, null);
    assert.equal(got.pr_number, 42, 'kept for history');
    await recordFinding(projectId, candidate, 'FAIL again');
    await _drainPipelineForTest();
    assert.equal((await get(f.id)).status, 'dismissed');
    assert.equal(calls.length, 0);
  });

  it('green then merged: resolved with the PR branch cleared, and a later recurrence starts fresh (no retry of the old PR)', async () => {
    const { f, candidate } = await viaIntake();
    await applyCiResult(projectId, ci(f, 'success'));
    await applyPrClosed(projectId, closed(f, true));
    const got = await get(f.id);
    assert.equal(got.status, 'resolved');
    assert.equal(got.pr_branch, null);
    assert.equal(got.pr_head_sha, null);
    assert.equal(got.pr_number, 42);
    await recordFinding(projectId, candidate, 'FAIL after the merge');
    await _drainPipelineForTest();
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].opts.vars?.previous_attempt), /^None/);
    const reopened = await get(f.id);
    assert.equal(reopened.status, 'fixing');
    const { autofixPrPlan } = await import('../server/autofix/delivery.ts');
    const plan = (await autofixPrPlan(reopened.workflow_id!, 'run-x'))!;
    assert.equal(plan.reuseBranch, undefined);
    assert.equal(plan.existingPr, undefined);
    assert.equal(plan.branchStem, fixBranchName(f.kind, f.fingerprint));
  });

  it('a closed event with another PR number is ignored, also after green CI', async () => {
    const f = await prOpen();
    await applyCiResult(projectId, ci(f, 'success'));
    await applyPrClosed(projectId, closed(f, false, 99));
    await applyPrClosed(projectId, closed(f, true, 99));
    const got = await get(f.id);
    assert.equal(got.status, 'resolved');
    assert.equal(got.pr_branch, f.pr_branch);
  });

  it('the PR closed while its retry runs: the finding is dismissed (found by pr_branch) and the session delivers nothing for it', async () => {
    const f = await prOpen();
    const branch = f.fix_branch!;
    await applyCiResult(projectId, ci(f, 'failure'), { evidence: redEvidence });
    await _drainPipelineForTest();
    assert.equal((await get(f.id)).status, 'fixing');
    await applyPrClosed(projectId, { type: 'pr_closed', repoFullName: 'acme/widgets', branch, merged: false, prNumber: 42 });
    const got = await get(f.id);
    assert.equal(got.status, 'dismissed');
    assert.ok(got.cooldown_until);
    const { autofixPrPlan } = await import('../server/autofix/delivery.ts');
    assert.equal(await autofixPrPlan(got.workflow_id!, 'run-x'), null, 'no auto-fix delivery for a dismissed finding');
  });

  it('three concurrent red events count one attempt and start one session', async () => {
    const f = await prOpen();
    await Promise.all([1, 2, 3].map(() => applyCiResult(projectId, ci(f, 'failure'), { evidence: redEvidence })));
    await _drainPipelineForTest();
    const got = await get(f.id);
    assert.equal(got.attempts, 1);
    assert.equal(calls.length, 1);
    assert.equal(got.status, 'fixing');
  });

  it('a retry is counted against max_open_prs for other findings, but not blocked by its own PR', async () => {
    await saveAutofixPolicy(projectId, { limits: { ...DEFAULT_POLICY.limits, max_attempts: 3, max_open_prs: 1 } }, { actorId: adminId, isAdmin: true });
    const f = await prOpen();
    await applyCiResult(projectId, ci(f, 'failure'), { evidence: redEvidence });
    await _drainPipelineForTest();
    assert.equal(calls.length, 1, 'the retry itself starts');
    assert.equal((await get(f.id)).status, 'fixing');
    const { processFinding } = await import('../server/autofix/pipeline.ts');
    const { finding: other } = await repo().upsertByFingerprint({
      project_id: projectId, source: 'ci_failed', kind: 'tests', fingerprint: `other-${++seq}`, severity: 'medium',
      evidence: 'boom', repo_id: repoId, branch: 'main', commit_sha: null,
    });
    await processFinding(other.id);
    assert.equal((await get(other.id)).status, 'new', 'deferred: the retried PR is still open');
    assert.equal(calls.length, 1);
  });
});

describe('late, duplicate and unrelated events', () => {
  it('a late event for a finding that is no longer pr_open changes nothing', async () => {
    const f = await prOpen();
    await applyPrClosed(projectId, closed(f, true));
    const resolved = await get(f.id);
    assert.equal(resolved.status, 'resolved');
    await applyCiResult(projectId, ci(f, 'failure'), { evidence: redEvidence });
    await applyCiResult(projectId, ci(f, 'success'));
    await applyPrClosed(projectId, closed(f, false));
    await _drainPipelineForTest();
    const after = await get(f.id);
    assert.equal(after.status, 'resolved');
    assert.equal(after.attempts, resolved.attempts);
    assert.equal(after.cooldown_until, resolved.cooldown_until);
    assert.equal(calls.length, 0);
    assert.equal(inboxItems().length, 0);
  });

  it('events for an unknown branch or a branch outside autofix/ touch no finding', async () => {
    const f = await prOpen();
    await applyCiResult(projectId, { ...ci(f, 'failure'), branch: 'autofix/tests-ffffffff' });
    await applyCiResult(projectId, { ...ci(f, 'success'), branch: 'main' });
    await applyPrClosed(projectId, { ...closed(f, false), branch: 'feature/x' });
    await _drainPipelineForTest();
    assert.equal((await get(f.id)).status, 'pr_open');
    assert.equal(calls.length, 0);
  });
});

describe('through the webhook', () => {
  it('a signed workflow_run failure on autofix/tests-ab12cd34 drives the retry with the run log as evidence', async () => {
    const f = await prOpen({}, { fix_branch: 'autofix/tests-ab12cd34', pr_branch: 'autofix/tests-ab12cd34', pr_head_sha: 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678' });
    const seen: Array<{ runId?: number; branch: string }> = [];
    _setEvidenceFetcher(async (c) => { seen.push({ runId: c.runId, branch: c.branch }); return redEvidence(); });
    assert.equal(await deliver(fx('workflow_run_failed_autofix'), 'workflow_run'), 202);
    assert.deepEqual(seen, [{ runId: 9100002, branch: 'autofix/tests-ab12cd34' }]);
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].opts.vars?.previous_attempt), /expected 3, got 4/);
    const got = await get(f.id);
    assert.equal(got.status, 'fixing');
    assert.equal(got.attempts, 1);
    assert.equal(got.pr_branch, 'autofix/tests-ab12cd34');
    // No new finding was opened for the fix branch's failure.
    assert.equal((await repo().list(projectId, { limit: 50 })).length, 1);
  });

  it('a signed pull_request closed merged event resolves the finding', async () => {
    const f = await prOpen({ kind: 'lint' }, { fix_branch: 'autofix/lint-9f8e7d6c', pr_branch: 'autofix/lint-9f8e7d6c' });
    assert.equal(await deliver(fx('pull_request_merged'), 'pull_request'), 202);
    assert.equal((await get(f.id)).status, 'resolved');
  });

  it('a pull_request closed on a non-autofix branch and a workflow_run success on main touch no finding', async () => {
    const f = await prOpen({}, { fix_branch: 'autofix/tests-ab12cd34', pr_branch: 'autofix/tests-ab12cd34' });
    let fetched = 0;
    _setEvidenceFetcher(async () => { fetched++; return ''; });
    const pr = fx('pull_request_merged').replace('autofix/lint-9f8e7d6c', 'feature/login');
    assert.equal(await deliver(pr, 'pull_request'), 202);
    assert.equal(await deliver(fx('workflow_run_success_main'), 'workflow_run'), 202);
    const got = await get(f.id);
    assert.equal(got.status, 'pr_open');
    assert.equal(got.updated_at, f.updated_at);
    assert.equal(fetched, 0);
    assert.equal((await repo().list(projectId, { limit: 50 })).length, 1);
    assert.equal(calls.length, 0);
  });
});
