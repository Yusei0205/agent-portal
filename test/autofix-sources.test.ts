/**
 * Auto-fix sources beyond CI: code review findings become `review_finding` findings (server/autofix/review-source.ts) that the
 * pipeline fixes with the builtin-autofix-review spec on a stacked pull request, and `session_failed` findings go to a person
 * (a failed session has no repository a fix session could work on). fireLoopSpec is a stub; the database is real.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { run as dbRun, all, one } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { getAutofixFindingsRepository } from '../server/repositories/autofix-findings.ts';
import type { AutofixFinding, UpsertFindingInput } from '../server/repositories/autofix-findings.ts';
import { getReviewsRepository } from '../server/repositories/reviews.ts';
import type { ReviewRecord } from '../server/repositories/reviews.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { getGitReposRepository } from '../server/repositories/git-repos.ts';
import { getLoopSpecsRepository } from '../server/repositories/loop-specs.ts';
import type { LoopSpecRecord } from '../server/repositories/loop-specs.ts';
import { saveAutofixPolicy, setPaused, DEFAULT_POLICY } from '../server/autofix/policy.ts';
import type { FireOptions, FireResult } from '../server/loop-triggers.ts';
import { fillGoal } from '../server/loop-triggers.ts';
import { newLoopState } from '../server/workflows/loop.ts';
import { processFinding, processNew, _setFireLoopSpec, _drainPipelineForTest, AUTOFIX_SPEC_BY_SOURCE } from '../server/autofix/pipeline.ts';
import { emitReviewFindings, reviewKindSlug, reviewFilePath, REVIEW_EVIDENCE_MAX } from '../server/autofix/review-source.ts';
import { autofixPrPlan } from '../server/autofix/delivery.ts';
import { handleReviewLifecycle } from '../server/review-lifecycle.ts';

let baseUrl = '';
let cookie = '';
let adminId = '';
let projectId = '';
let repoId = '';
let seq = 0;

const repo = () => getAutofixFindingsRepository();
const findings = async (source = 'review_finding') => (await repo().list(projectId, { limit: 200 })).filter((f) => f.source === source);
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const SHA = '0123456789abcdef0123456789abcdef01234567';

// ── fireLoopSpec stub ────────────────────────────────────────────────────────

type Call = { spec: LoopSpecRecord; opts: FireOptions; workflowId?: string };
let calls: Call[] = [];
/** When set, every fire answers this (409 keeps findings `new`, so the emit tests see predictable statuses). */
let fixedResult: FireResult | null = null;

async function stubFire(spec: LoopSpecRecord, opts: FireOptions): Promise<FireResult> {
  const call: Call = { spec, opts };
  calls.push(call);
  if (fixedResult) return fixedResult;
  const id = `wf-src-${++seq}`;
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

// ── reviews ──────────────────────────────────────────────────────────────────

async function makeReview(over: Partial<ReviewRecord> = {}): Promise<ReviewRecord> {
  return getReviewsRepository().create({
    id: generateId(), project_id: projectId, base_ref: 'main', head_ref: 'feature/login', pr_number: 17, repo_id: repoId,
    status: 'done', post_mode: 'draft', from_loop: null, workflow_id: null, min_severity: 'medium', summary: null, raw_output: null,
    created_by: adminId, created_at: now(), parent_review_id: null, source_sha: SHA, dest_sha: null, provider_id: null, model_id: null,
    jira_context: '{}', run_log: '[]', input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0, llm_requests: 0,
    retry_count: 0, tool_calls: 0, files_reviewed: 0, duration_ms: null, started_at: null, merged_at: null, merged_by: null,
    head_commit_sha: SHA, ...over,
  });
}

async function addFinding(reviewId: string, over: { file?: string; line?: number | null; severity?: string; title?: string; body?: string; accepted?: number } = {}): Promise<void> {
  await getReviewsRepository().createFinding({
    id: generateId(), review_id: reviewId, file_path: over.file ?? 'src/auth/login.ts', line_number: over.line === undefined ? 42 : over.line,
    severity: over.severity ?? 'high', title: over.title ?? 'Password compared with ==',
    body: over.body ?? 'The password check uses a non-constant-time comparison.\n\nSuggested fix:\nUse crypto.timingSafeEqual.',
    confidence: null, accepted: over.accepted ?? 0, posted_at: null, created_at: now(),
  });
}

async function emit(reviewId: string): Promise<void> {
  await emitReviewFindings(reviewId);
  await _drainPipelineForTest();
}

async function setPolicy(patch: Record<string, unknown> = {}): Promise<void> {
  await saveAutofixPolicy(projectId, {
    mode: 'propose', engine: 'demo', verify: { command: 'npm test', quick_commands: [] }, run_as: adminId,
    classes: [...DEFAULT_POLICY.classes, 'review'], branches: { default_branch: true, portal_prs: true, extra: ['feature/*'] },
    ...patch,
  } as never, { actorId: adminId, isAdmin: true });
}

before(async () => {
  ({ baseUrl } = await createTestServer());
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@src.test', password: 'adminpassword1', name: 'A' } });
  cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@src.test', password: 'adminpassword1' } })).cookie ?? '';
  adminId = String((((await fetchJson(baseUrl, '/api/auth/state', { cookie })).body as Record<string, unknown>).user as Record<string, unknown>).id);
  projectId = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'Sources' }, cookie })).body as { project: { id: string } }).project.id;
  repoId = 'repo-src-1';
  await getGitReposRepository().create({
    id: repoId, project_id: projectId, name: 'shop', url: 'https://github.com/acme/shop.git', provider: 'github', status: 'pending',
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
  calls = [];
  fixedResult = { ok: false, status: 409, reason: 'The previous session of this spec is still running.' };
  _setFireLoopSpec(stubFire);
  await setPaused(projectId, false);
  await setPolicy();
});
afterEach(async () => { await _drainPipelineForTest(); });

// ── the seeded spec ──────────────────────────────────────────────────────────

describe('the seeded review spec', () => {
  it('builtin-autofix-review is a webhook spec for review_finding findings, shaped like the CI one', async () => {
    const spec = (await getLoopSpecsRepository().getSpecById('builtin-autofix-review'))!;
    assert.ok(spec);
    const ci = (await getLoopSpecsRepository().getSpecById('builtin-autofix-ci'))!;
    assert.equal(spec.trigger_type, 'webhook');
    assert.deepEqual(JSON.parse(spec.trigger_config), { finding_kind: 'review_finding', maxPerHour: 12 });
    assert.equal(spec.stop_config, ci.stop_config);
    assert.equal(spec.max_iterations, ci.max_iterations);
    for (const v of ['{{kind}}', '{{branch}}', '{{evidence}}', '{{verify_command}}', '{{checkout}}', '{{previous_attempt}}']) assert.ok(spec.goal_template.includes(v), v);
    assert.match(spec.goal_template, /cannot reproduce/);
    assert.match(spec.goal_template, /\.github\/workflows/);
    assert.match(spec.goal_template, /infra\//);
    assert.match(spec.goal_template, /\.env/);
    assert.ok(spec.goal_template.indexOf('{{verify_command}}') < spec.goal_template.indexOf('Change only what'), 'the check runs first');
  });

  it('no session spec is seeded: failed sessions go to a person (no repository to fix)', async () => {
    assert.equal(await getLoopSpecsRepository().getSpecById('builtin-autofix-session'), null);
    assert.equal(AUTOFIX_SPEC_BY_SOURCE.session_failed, undefined);
    assert.equal(AUTOFIX_SPEC_BY_SOURCE.review_finding, 'builtin-autofix-review');
  });

  it('builtin-autofix-review cannot be run by hand', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs/builtin-autofix-review/run`, { method: 'POST', body: { vars: {} }, cookie });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(String((r.body as { error?: string }).error), /auto-fix/i);
  });
});

// ── emitReviewFindings ───────────────────────────────────────────────────────

describe('emitReviewFindings', () => {
  it('a review with one high and one low finding creates one review_finding', async () => {
    const r = await makeReview();
    await addFinding(r.id, { severity: 'high' });
    await addFinding(r.id, { severity: 'low', file: 'src/util.ts', body: 'Variable name is unclear.' });
    await emit(r.id);
    const got = await findings();
    assert.equal(got.length, 1);
    const f = got[0];
    assert.equal(f.kind, 'review');
    assert.equal(f.severity, 'high');
    assert.equal(f.branch, 'feature/login');
    assert.equal(f.commit_sha, SHA);
    assert.equal(f.repo_id, repoId);
    assert.match(f.evidence, new RegExp(`review ${r.id}`));
    assert.match(f.evidence, /pull request #17/);
    assert.match(f.evidence, /src\/auth\/login\.ts:42/);
    assert.match(f.evidence, /Severity: high/);
    assert.match(f.evidence, /non-constant-time comparison/);
    assert.match(f.evidence, /Suggestion:\nUse crypto\.timingSafeEqual/);
  });

  it('severity: medium and critical are fixed (critical as high), low and info are not', async () => {
    const r = await makeReview();
    await addFinding(r.id, { severity: 'medium', file: 'a.ts', body: 'medium one' });
    await addFinding(r.id, { severity: 'critical', file: 'b.ts', body: 'critical one' });
    await addFinding(r.id, { severity: 'info', file: 'c.ts', body: 'info one' });
    await addFinding(r.id, { severity: 'low', file: 'd.ts', body: 'low one' });
    await emit(r.id);
    const got = await findings();
    assert.deepEqual(got.map((f) => f.severity).sort(), ['high', 'medium']);
  });

  it('a dismissed (rejected) review finding is skipped', async () => {
    const r = await makeReview();
    await addFinding(r.id, { accepted: -1 });
    await addFinding(r.id, { accepted: 1, file: 'x.ts', body: 'accepted one' });
    await emit(r.id);
    const got = await findings();
    assert.equal(got.length, 1);
    assert.match(got[0].evidence, /accepted one/);
  });

  it('nothing is created while the project policy is off', async () => {
    await setPolicy({ mode: 'off' });
    const r = await makeReview();
    await addFinding(r.id);
    await emit(r.id);
    assert.equal((await findings()).length, 0);
  });

  it('a rerun of the same review does not create a second finding', async () => {
    const r = await makeReview();
    await addFinding(r.id);
    await emit(r.id);
    await emit(r.id);
    const got = await findings();
    assert.equal(got.length, 1);
    assert.equal(got[0].occurrences, 2);
  });

  it('the same finding on a later commit at another line is the same finding (no line numbers in the fingerprint)', async () => {
    const r1 = await makeReview();
    await addFinding(r1.id, { line: 42 });
    await emit(r1.id);
    const r2 = await makeReview({ source_sha: 'f'.repeat(40), head_commit_sha: 'f'.repeat(40) });
    await addFinding(r2.id, { line: 57 });
    await emit(r2.id);
    const got = await findings();
    assert.equal(got.length, 1);
    assert.equal(got[0].occurrences, 2);
    assert.match(got[0].evidence, /login\.ts:57/, 'a waiting finding gets the latest evidence');
  });

  it('the same message on two files that share a basename is two findings', async () => {
    const r = await makeReview();
    await addFinding(r.id, { file: 'server/api/users.ts', body: 'Missing input validation.' });
    await addFinding(r.id, { file: 'server/admin/users.ts', body: 'Missing input validation.' });
    await addFinding(r.id, { file: 'packages/a/src/index.ts', body: 'Missing input validation.' });
    await addFinding(r.id, { file: 'packages/b/src/index.ts', body: 'Missing input validation.' });
    await emit(r.id);
    assert.equal((await findings()).length, 4);
  });

  it('the same message and file on two branches of one family (feature/a, feature/b) are two findings', async () => {
    const a = await makeReview({ head_ref: 'feature/a' });
    await addFinding(a.id, { body: 'Missing input validation.' });
    const b = await makeReview({ head_ref: 'feature/b' });
    await addFinding(b.id, { body: 'Missing input validation.' });
    await emit(a.id);
    await emit(b.id);
    const got = await findings();
    assert.equal(got.length, 2);
    assert.deepEqual(got.map((f) => f.branch).sort(), ['feature/a', 'feature/b']);
  });

  it('evidence full of credential patterns keeps its header and stays under the cap (scrubbed before it is cut)', async () => {
    const r = await makeReview();
    const noisy = 'clone http://a:b@example.com/x '.repeat(200) + '\nAuthorization: Bearer abcdefghijklmnop\n'.repeat(150);
    await addFinding(r.id, { body: noisy + '\n\nSuggested fix:\n' + 'use http://u:p@h/ instead '.repeat(200) });
    await emit(r.id);
    const [f] = await findings();
    assert.ok(f.evidence.length <= REVIEW_EVIDENCE_MAX, String(f.evidence.length));
    assert.ok(f.evidence.startsWith(`Code review ${r.id} of pull request #17`), f.evidence.slice(0, 120));
    assert.equal(f.evidence.slice(-4000), f.evidence);
    assert.doesNotMatch(f.evidence, /a:b@|u:p@|abcdefghijklmnop/);
    assert.match(f.evidence, /\nSuggestion:\n/);
  });

  it('a ./-prefixed, Windows-style or differently cased form of the same path is the same finding', async () => {
    assert.equal(reviewFilePath('./src/Auth/Login.ts'), 'src/auth/login.ts');
    assert.equal(reviewFilePath('src\\auth\\login.ts'), 'src/auth/login.ts');
    const r = await makeReview();
    await addFinding(r.id, { file: 'src/auth/login.ts', line: 1, body: 'Missing input validation.' });
    await addFinding(r.id, { file: './src/auth/login.ts', line: 9, body: 'Missing input validation.' });
    await addFinding(r.id, { file: 'src\\auth\\login.ts', line: 20, body: 'Missing input validation.' });
    await emit(r.id);
    const got = await findings();
    assert.equal(got.length, 1);
    assert.equal(got[0].occurrences, 3);
  });

  it('a maximal finding keeps its header and stays under the goal\'s 4000-character evidence window', async () => {
    const r = await makeReview({ head_ref: 'feature/' + 'b'.repeat(190) });
    const file = 'src/' + 'd/'.repeat(240) + 'deep.ts';
    await addFinding(r.id, { file, line: 123456, title: 'T'.repeat(500), body: 'M'.repeat(20_000) + '\n\nSuggested fix:\n' + 'S'.repeat(20_000) });
    await emit(r.id);
    const [f] = await findings();
    assert.ok(f.evidence.length <= REVIEW_EVIDENCE_MAX, String(f.evidence.length));
    assert.ok(f.evidence.length < 4000);
    assert.ok(f.evidence.startsWith(`Code review ${r.id} of pull request #17`), f.evidence.slice(0, 120));
    assert.match(f.evidence, /deep\.ts:123456/);
    assert.match(f.evidence, /\nMessage:\nM{100}/);
    assert.match(f.evidence, /\nSuggestion:\nS{100}/);
    // What the goal keeps (the last 4000 characters) is the whole evidence.
    assert.equal(f.evidence.slice(-4000), f.evidence);
  });

  it('a rerun does not re-open or rewrite a finding that is being fixed or has a PR open', async () => {
    const r = await makeReview();
    await addFinding(r.id);
    await emit(r.id);
    const [f] = await findings();
    for (const status of ['fixing', 'pr_open'] as const) {
      await repo().transition(f.id, [(await repo().getById(f.id))!.status], { status, evidence: 'kept' });
      await addFinding(r.id, { line: 99 });
      await emit(r.id);
      const got = (await repo().getById(f.id))!;
      assert.equal(got.status, status);
      assert.equal(got.evidence, 'kept');
    }
    assert.equal((await findings()).length, 1);
  });

  it('a resolved finding whose fix PR is still open (not yet taken into the reviewed branch) is not re-opened by a rerun', async () => {
    const r = await makeReview();
    await addFinding(r.id);
    await emit(r.id);
    const [f] = await findings();
    await repo().transition(f.id, ['new'], { status: 'resolved', pr_branch: 'autofix/review-12345678', pr_number: 5 });
    await emit(r.id);
    assert.equal((await repo().getById(f.id))!.status, 'resolved');
  });

  it('the evidence is scrubbed (a token in the message and the suggestion)', async () => {
    const r = await makeReview();
    await addFinding(r.id, { body: `Hard-coded token ${TOKEN} in the client.\n\nSuggested fix:\nRead it from the env, not ${TOKEN}.` });
    await emit(r.id);
    const [f] = await findings();
    assert.ok(!f.evidence.includes(TOKEN), f.evidence);
    assert.match(f.evidence, /Hard-coded token/);
  });

  it('kind is the category as a short slug; no category means review', () => {
    assert.equal(reviewKindSlug('Security Issue'), 'security-issue');
    assert.equal(reviewKindSlug('  Type_Errors!! '), 'type-errors');
    assert.equal(reviewKindSlug(''), 'review');
    assert.equal(reviewKindSlug(null), 'review');
    assert.equal(reviewKindSlug('!!!'), 'review');
    const long = reviewKindSlug('a'.repeat(30) + ' ' + 'b'.repeat(30));
    assert.ok(long.length <= 40 && /^[a-z0-9-]+$/.test(long) && !long.endsWith('-'), long);
  });

  it('a review of an auto-fix branch, a scan, a non-GitHub repository or an unsafe branch name creates nothing', async () => {
    const codecommit = 'repo-src-cc';
    if (!(await getGitReposRepository().getById(codecommit))) {
      await getGitReposRepository().create({
        id: codecommit, project_id: projectId, name: 'cc', url: 'https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/cc', provider: 'codecommit',
        status: 'pending', default_branch: 'main', identity: null, last_synced_at: null, last_error: null, created_at: now(), connection_id: null,
      });
    }
    for (const over of [
      { head_ref: 'autofix/review-12345678' }, { scan_id: 'scan-1' }, { repo_id: codecommit }, { repo_id: null }, { head_ref: 'bad branch;rm -rf' },
      { status: 'failed' as const },
    ]) {
      const r = await makeReview(over as Partial<ReviewRecord>);
      if ('scan_id' in over) dbRun('UPDATE p10_reviews SET scan_id = ? WHERE id = ?', 'scan-1', r.id);
      await addFinding(r.id);
      await emit(r.id);
    }
    assert.equal((await findings()).length, 0);
  });

  it('never throws (unknown review, a repository error)', async () => {
    await emitReviewFindings('no-such-review');
    const reviews = getReviewsRepository();
    const orig = reviews.getById.bind(reviews);
    reviews.getById = async () => { throw new Error('database down'); };
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
    try {
      await emitReviewFindings('x');
    } finally {
      reviews.getById = orig;
      console.error = origError;
    }
    assert.equal(errors.length, 1);
  });

  it('a finished review emits its findings through the review lifecycle', async () => {
    const wid = generateId();
    dbRun(`INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, iteration_count, max_iterations, kind, created_at, updated_at)
           VALUES (?,?,'Code review','done','demo',0,'[]',1,1,'review',?,?)`, wid, projectId, now(), now());
    const r = await makeReview({ status: 'running', workflow_id: wid });
    const runId = generateId();
    dbRun(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?,?,'done',?)`, runId, wid, now());
    const report = { summary: 's', findings: [
      { file: 'src/auth/login.ts', line: 3, severity: 'high', title: 'Bad compare', body: 'Use a constant-time compare.' },
      { file: 'src/x.ts', line: 1, severity: 'low', title: 'Nit', body: 'Rename.' },
    ] };
    await getSessionsRepository().appendRunEvent(runId, 'assistant-text', JSON.stringify({ text: '```json\n' + JSON.stringify(report) + '\n```' }), now());
    await handleReviewLifecycle(wid, runId, 'done');
    assert.equal(one<{ status: string }>('SELECT status FROM p10_reviews WHERE id = ?', r.id)?.status, 'done');
    for (let i = 0; i < 50 && (await findings()).length === 0; i++) await new Promise((ok) => setTimeout(ok, 20));
    await _drainPipelineForTest();
    const got = await findings();
    assert.equal(got.length, 1);
    assert.match(got[0].evidence, /constant-time compare/);
  });
});

// ── the pipeline for review findings ─────────────────────────────────────────

async function reviewFinding(over: Partial<UpsertFindingInput> = {}): Promise<AutofixFinding> {
  const { finding } = await repo().upsertByFingerprint({
    project_id: projectId, source: 'review_finding', kind: 'review', fingerprint: `fp-src-${++seq}`, severity: 'high',
    evidence: 'Code review r1 of pull request #17: src/auth/login.ts:42\nMessage:\nUse a constant-time compare.', repo_id: repoId,
    branch: 'feature/login', commit_sha: SHA, ...over,
  });
  return finding;
}

describe('pipeline: review findings', () => {
  beforeEach(() => { fixedResult = null; });

  it('starts builtin-autofix-review on the repository with the finding, the reviewed commit and the verify command in its goal', async () => {
    const f = await reviewFinding();
    await processFinding(f.id);
    assert.equal(calls.length, 1);
    const { spec, opts, workflowId } = calls[0];
    assert.equal(spec.id, 'builtin-autofix-review');
    assert.deepEqual(opts.repoIds, [repoId]);
    assert.equal(opts.vars?.branch, 'feature/login');
    assert.match(String(opts.vars?.evidence), /constant-time compare/);
    assert.match(String(opts.vars?.checkout), new RegExp(`git fetch origin feature/login`));
    assert.match(String(opts.vars?.checkout), new RegExp(`git checkout -B autofix-work ${SHA}`));
    const goal = (await getSessionsRepository().getWorkflowById(workflowId!))!.goal as string;
    assert.match(goal, /constant-time compare/);
    assert.match(goal, /npm test/);
    assert.ok(!goal.includes('{{'), goal);
    assert.equal((await repo().getById(f.id))!.status, 'fixing');
  });

  it('a retry on the fix PR does not start from the reviewed commit again', async () => {
    const f = await reviewFinding();
    await repo().transition(f.id, ['new'], { status: 'new', pr_branch: 'autofix/review-abcdef01', pr_number: 9 });
    await processFinding(f.id);
    assert.doesNotMatch(String(calls[0].opts.vars?.checkout), /checkout -B autofix-work/);
    assert.match(String(calls[0].opts.vars?.previous_attempt), /git checkout -B autofix\/review-abcdef01 origin\/autofix\/review-abcdef01/);
  });

  it("the reviewed PR's branch is not eligible by default (human PR branches are opt-in through branches.extra)", async () => {
    await setPolicy({ branches: { default_branch: true, portal_prs: true, extra: [] } });
    const f = await reviewFinding();
    await processFinding(f.id);
    assert.equal(calls.length, 0);
    assert.equal((await repo().getById(f.id))!.status, 'suppressed');
  });

  it("a review finding whose category is not in the policy's classes is suppressed", async () => {
    await setPolicy({ classes: [...DEFAULT_POLICY.classes] });
    const f = await reviewFinding();
    await processFinding(f.id);
    assert.equal(calls.length, 0);
    assert.equal((await repo().getById(f.id))!.status, 'suppressed');
  });

  it('the PR plan of a review fix opens its PR against the reviewed branch', async () => {
    const f = await reviewFinding();
    await processFinding(f.id);
    const wf = calls[0].workflowId!;
    const plan = (await autofixPrPlan(wf, 'run-x'))!;
    assert.equal(plan.base, 'feature/login');
    assert.match(plan.branchStem, /^autofix\/review-/);
  });
});

// ── session_failed ───────────────────────────────────────────────────────────

describe('pipeline: failed sessions go to a person', () => {
  async function sessionFinding(): Promise<AutofixFinding> {
    const { finding } = await repo().upsertByFingerprint({
      project_id: projectId, source: 'session_failed', kind: 'session', fingerprint: `fp-sess-${++seq}`, severity: 'medium',
      evidence: 'Session wf-1, run r-1. Goal: build it\nError: boom', repo_id: null, branch: 'sessions', commit_sha: null,
    });
    return finding;
  }
  beforeEach(() => { fixedResult = null; });

  it("with 'session' allowed, the finding goes to needs_human with a blocked Inbox item and no session is started", async () => {
    await setPolicy({ classes: [...DEFAULT_POLICY.classes, 'session'] });
    const f = await sessionFinding();
    await processFinding(f.id);
    assert.equal(calls.length, 0);
    assert.equal((await repo().getById(f.id))!.status, 'needs_human');
    const items = all<{ type: string; payload: string }>('SELECT type, payload FROM p6_inbox WHERE project_id = ?', projectId);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'blocked');
    const p = JSON.parse(items[0].payload) as Record<string, unknown>;
    assert.equal(p.kind, 'autofix');
    assert.equal(p.reason, 'failed session: needs a person');
    assert.equal(p.findingId, f.id);
  });

  it("without 'session' in the classes it is suppressed; while paused it waits as new", async () => {
    const f = await sessionFinding();
    await setPaused(projectId, true);
    await processFinding(f.id);
    assert.equal((await repo().getById(f.id))!.status, 'new');
    await setPaused(projectId, false);
    await processFinding(f.id);
    assert.equal((await repo().getById(f.id))!.status, 'suppressed');
    assert.equal(calls.length, 0);
  });

  it('processNew handles waiting failed-session findings too', async () => {
    await setPolicy({ classes: [...DEFAULT_POLICY.classes, 'session'] });
    const f = await sessionFinding();
    await processNew(projectId);
    assert.equal((await repo().getById(f.id))!.status, 'needs_human');
    assert.equal(calls.length, 0);
  });
});
