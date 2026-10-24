/**
 * Automatic code review of pull requests (NEW-3): the `review_pr` action of a loop spec.
 *
 * Like "Keep docs current" (docs-sync.ts) this is a trigger action that does not start a goal session. A firing is one
 * pull request at one commit:
 *
 *  1. Decide whether the GitHub event is a reason to review (decideGithubEvent): a pull request that was opened,
 *     reopened, got new commits or was marked ready for review; still open; not a draft and not one of the portal's
 *     own documentation pull requests unless the spec says so; in a repository the spec covers.
 *  2. Start (startPrReview): one review per pull request and commit (a redelivery or a repeated event finds the first
 *     one), one at a time per pull request, inside the spec's monthly budget. It creates a coordinating session (a
 *     paused row that never runs an agent, so the firing shows in the session list, the metrics and escalates like
 *     any session of a spec) and an ordinary review (`reviews`, `findings`), then works in the background.
 *  3. Review (runAutoReview): the existing two passes (Haiku triage, optional Sonnet deep look), findings stored like
 *     a manual review.
 *  4. Post (review-post.ts): `auto` posts what passes the filters at once; `draft` (the default) keeps the findings,
 *     puts "review ready: approve to post" in the Inbox and posts when a person approves. Nothing to post: nothing is
 *     posted, and no empty comment goes on the pull request.
 *
 * Failure of any step stops the coordinating session as failed, which is an Inbox escalation (FR-LOOP-9).
 * CodeCommit has no webhook into the portal, so its pull requests are reviewed by hand ("Run now" with a pull request
 * number) and get one summary comment.
 */
import { all, insert, one, run as exec, update, type Row } from './db.ts';
import { auditRaw } from './audit.ts';
import { getProject, notifyProject } from './projects.ts';
import { checkBranch, diffRefs, ensureFresh, fetchPullRef, getCodeCommitPull, getRepo, githubApi, githubSlug, syncRepo, repoDir, type Repo } from './repos.ts';
import { git } from './git.ts';
import { badRequest, newId, now } from './util.ts';
import { parseUnifiedDiff } from './agent/heuristics.ts';
import { DEFAULT_BOT_PREFIXES, REVIEW_PR_ACTIONS, specMonthSpend, type LoopSpec, type ReviewPostMode, type ReviewSeverity } from './loop-specs.ts';
import { readSettings } from './workflows/validation.ts';
import { getWorkflow, log, patch } from './workflows/store.ts';
import { stopWith } from './workflows/lifecycle.ts';
import { reviewPasses, storeFindings, trimDiff } from './review.ts';
import { postReview, previewPost, type PostOptions } from './review-post.ts';

/** Reviews this process is working on; a `running` review that is not in here was cut short by a restart. */
const active = new Set<string>();

/** A review that has been running this long is not "busy" any more: a new event may start another. */
const BUSY_MS = 60 * 60_000;

export interface ReviewOptions extends PostOptions {
  postMode: ReviewPostMode;
  deepLook: boolean;
  includeDrafts: boolean;
  includeBotPrs: boolean;
  prActions: string[];
  repoIds: string[] | null;
  botBranchPrefixes: string[];
}

/** The options of a review_pr spec with their defaults. */
export function reviewOptions(spec: LoopSpec): ReviewOptions {
  const tc = spec.trigger_config;
  return {
    postMode: tc.postMode === 'auto' ? 'auto' : 'draft',
    minSeverity: (tc.minSeverity ?? 'medium') as ReviewSeverity,
    minConfidence: tc.minConfidence ?? 0.5,
    maxComments: tc.maxComments ?? 20,
    dedupe: true,
    deepLook: Boolean(tc.deepLook),
    includeDrafts: Boolean(tc.includeDrafts),
    includeBotPrs: Boolean(tc.includeBotPrs),
    prActions: tc.prActions?.length ? tc.prActions : [...REVIEW_PR_ACTIONS],
    repoIds: tc.repoIds?.length ? tc.repoIds : null,
    botBranchPrefixes: tc.botBranchPrefixes?.length ? tc.botBranchPrefixes : DEFAULT_BOT_PREFIXES,
  };
}

/* ------------------------------------------------------------------ */
/* Which events start a review                                         */
/* ------------------------------------------------------------------ */

export type ReviewDecision = { fire: true; vars: Record<string, string>; repo: Repo; key: string } | { fire: false; reason: string };

function githubRepoByName(projectId: string, fullName: string, only: string[] | null): Repo | null {
  const want = fullName.toLowerCase();
  for (const r of all<Repo>("SELECT * FROM repos WHERE project_id = ? AND provider = 'github' ORDER BY created_at, id", projectId)) {
    const g = githubSlug(r.url);
    if (!g || `${g.owner}/${g.repo}`.toLowerCase() !== want) continue;
    if (only && !only.includes(r.id)) continue;
    return r;
  }
  return null;
}

/** Whether a GitHub webhook delivery is a reason to review, and if so what the review needs to know. */
export function decideGithubEvent(spec: LoopSpec, event: string, payload: any): ReviewDecision {
  const o = reviewOptions(spec);
  if (event !== 'pull_request') return { fire: false, reason: `Event "${event}" is not reviewed (only pull_request)` };
  const action = String(payload?.action ?? '');
  if (!o.prActions.includes(action)) return { fire: false, reason: `pull_request "${action}" does not start a review` };
  const pr = payload?.pull_request;
  const number = Number(pr?.number ?? payload?.number);
  const sha = String(pr?.head?.sha ?? '');
  if (!pr || !Number.isInteger(number) || number < 1 || !sha) return { fire: false, reason: 'The payload has no pull request with a head commit' };
  if (pr.state !== 'open' || pr.merged === true) return { fire: false, reason: 'The pull request is closed' };
  if (pr.draft === true && !o.includeDrafts) return { fire: false, reason: 'Draft pull request (it is reviewed when it is marked ready for review)' };
  const branch = String(pr.head?.ref ?? '');
  if (!o.includeBotPrs && o.botBranchPrefixes.some((p) => branch.startsWith(p))) return { fire: false, reason: `Pull request of the portal itself (branch ${branch})` };
  const fullName = String(payload?.repository?.full_name ?? '');
  const repo = fullName ? githubRepoByName(spec.project_id, fullName, o.repoIds) : null;
  if (!repo) return { fire: false, reason: `Repository ${fullName || '(none)'} is not one this spec reviews` };
  const base = String(pr.base?.ref ?? '');
  return {
    fire: true,
    repo,
    key: `github:pr-review:${repo.id}#${number}@${sha}`,
    vars: {
      'github.event': event,
      'github.action': action,
      'repo.id': repo.id,
      'repo.name': repo.name,
      'repo.full_name': fullName,
      'pr.number': String(number),
      'pr.title': String(pr.title ?? ''),
      'pr.branch': branch,
      'pr.base': base,
      'pr.sha': sha,
      'pr.url': String(pr.html_url ?? ''),
      'pr.author': String(pr.user?.login ?? ''),
      'pr.draft': pr.draft === true ? 'true' : 'false',
    },
  };
}

/* ------------------------------------------------------------------ */
/* Starting a review                                                   */
/* ------------------------------------------------------------------ */

function idleRow(projectId: string, title: string, reason: string, extra: Record<string, unknown> = {}): Row {
  return { id: null, project_id: projectId, title, status: 'done', stop_reason: reason, ...extra };
}

function enforceSpecBudget(spec: LoopSpec): void {
  if (spec.monthly_budget_usd !== null && spec.monthly_budget_usd !== undefined && specMonthSpend(spec.id) >= spec.monthly_budget_usd) {
    throw badRequest(`This loop spec's monthly budget of $${spec.monthly_budget_usd} is used up.`);
  }
}

function resolveRepo(spec: LoopSpec, vars: Record<string, string>, o: ReviewOptions): Repo {
  const repos = all<Repo>('SELECT * FROM repos WHERE project_id = ? ORDER BY created_at, id', spec.project_id).filter((r) => !o.repoIds || o.repoIds.includes(r.id));
  const id = vars['repo.id'];
  if (id) {
    const r = repos.find((x) => x.id === id);
    if (!r) throw badRequest('That repository is not one this spec reviews');
    return r;
  }
  const full = (vars['repo.full_name'] ?? '').toLowerCase();
  if (full) {
    const r = repos.find((x) => {
      const g = githubSlug(x.url);
      return g && `${g.owner}/${g.repo}`.toLowerCase() === full;
    });
    if (r) return r;
  }
  const usable = repos.filter((r) => r.provider === 'github' || r.provider === 'codecommit');
  if (usable.length === 1) return usable[0];
  throw badRequest(usable.length ? 'Say which repository: pass vars {"repo.id": "..."}' : 'This project has no GitHub or CodeCommit repository to review pull requests of');
}

/**
 * Start the review of one pull request. Called by createWorkflowFromSpec for a spec whose action is review_pr (from the
 * webhook, with the pull request in `vars`, or by hand with at least `pr.number`). Returns the coordinating session, or
 * a row with a null id and the reason when nothing was started.
 */
export async function startPrReview(spec: LoopSpec, userId: string, vars: Record<string, string>): Promise<Row> {
  const o = reviewOptions(spec);
  enforceSpecBudget(spec);
  const repo = resolveRepo(spec, vars, o);
  if (repo.provider !== 'github' && repo.provider !== 'codecommit') throw badRequest('Pull request reviews work for GitHub and CodeCommit repositories');
  const number = Number(vars['pr.number']);
  if (!Number.isInteger(number) || number < 1) throw badRequest('Say which pull request to review: pass vars {"pr.number": 12}');

  let sha = vars['pr.sha'] || '';
  let base = vars['pr.base'] || '';
  let branch = vars['pr.branch'] || '';
  let title = vars['pr.title'] || '';
  let url = vars['pr.url'] || '';
  if (!sha || !base || (repo.provider === 'codecommit' && !branch)) {
    if (repo.provider === 'github') {
      const pr = await githubApi(repo, 'GET', `/pulls/${number}`);
      sha = String(pr.head?.sha ?? '');
      base = String(pr.base?.ref ?? '');
      branch = String(pr.head?.ref ?? '');
      title = title || String(pr.title ?? '');
      url = url || String(pr.html_url ?? '');
    } else {
      const pr = await getCodeCommitPull(repo, number);
      sha = pr.sha;
      base = pr.base;
      branch = pr.head;
      title = title || pr.title;
    }
  }
  if (!sha || !base) throw badRequest(`Could not read pull request #${number}`);
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw badRequest(`Pull request #${number} has an unusual head commit`);
  checkBranch(base);
  const head = repo.provider === 'github' ? `pr/${number}` : checkBranch(branch);

  const same = one<Row>("SELECT id FROM reviews WHERE repo_id = ? AND pr_number = ? AND head_sha = ? AND source = 'auto' AND status IN ('running', 'done') LIMIT 1", repo.id, number, sha);
  if (same) return idleRow(spec.project_id, spec.name, `Pull request #${number} at ${sha.slice(0, 7)} was already reviewed.`, { review: { id: same.id }, duplicate: true });
  const since = new Date(Date.now() - BUSY_MS).toISOString();
  const busy = one<Row>("SELECT id FROM reviews WHERE repo_id = ? AND pr_number = ? AND source = 'auto' AND status = 'running' AND created_at >= ? LIMIT 1", repo.id, number, since);
  if (busy) return idleRow(spec.project_id, spec.name, `A review of pull request #${number} is still running. Push again or redeliver this event when it has finished.`, { review: { id: busy.id }, busy: true });

  const project = getProject(spec.project_id);
  const wid = newId('w_');
  const rid = newId('v_');
  const ts = now();
  const s = readSettings({ model: 'haiku', budgetUsd: 1000, maxIterations: 1, pushMode: 'never', permissionMode: '' }, undefined, { hasRepos: true, isPlayground: false });
  const label = `Review PR #${number}${title ? `: ${title}` : ''}`.slice(0, 120);
  insert('workflows', {
    id: wid,
    project_id: project.id,
    title: label,
    goal: `Review pull request #${number} of ${repo.name} at ${sha.slice(0, 7)}.`,
    status: 'paused',
    stop_reason: 'Reviewing the pull request. The result is stored in Code review.',
    queue_reason: '',
    queued_at: null,
    repo_id: repo.id,
    branch: base,
    repos: JSON.stringify([{ repoId: repo.id, branch: base }]),
    workspace_id: null,
    engine: '',
    integrations: '[]',
    playground: 0,
    ...s,
    rules: '',
    iteration: 0,
    burst_start: 0,
    spent_usd: 0,
    spent_credits: 0,
    work_branch: '',
    lead_agent: '',
    jira_key: '',
    jira_summary: '',
    jira_url: '',
    summary: '',
    loop_spec_id: spec.id,
    planning_gate: 0,
    created_by: userId,
    created_at: ts,
    updated_at: ts,
  });
  const opts: PostOptions = { minSeverity: o.minSeverity, minConfidence: o.minConfidence, maxComments: o.maxComments, dedupe: true };
  insert('reviews', {
    id: rid,
    project_id: project.id,
    repo_id: repo.id,
    base,
    head,
    pr_number: number,
    head_sha: sha,
    diff: '',
    files: '[]',
    status: 'running',
    deep: o.deepLook ? 1 : 0,
    created_by: userId,
    created_at: ts,
    source: 'auto',
    loop_spec_id: spec.id,
    workflow_id: wid,
    pr_title: title || null,
    pr_url: url || null,
    post_mode: o.postMode,
    post_state: '',
    post_options: JSON.stringify(opts),
  });
  // A review of newer commits replaces one that still waits for approval.
  exec("UPDATE reviews SET post_state = 'superseded' WHERE repo_id = ? AND pr_number = ? AND post_state = 'awaiting' AND id != ?", repo.id, number, rid);
  log(wid, 'system', `Reviewing pull request #${number} at ${sha.slice(0, 7)} (${o.postMode === 'auto' ? 'comments are posted automatically' : 'a person approves posting'}).`);
  auditRaw(userId, 'review.auto', `review:${rid}`, { projectId: project.id, specId: spec.id, repoId: repo.id, pr: number, sha, postMode: o.postMode });
  notifyProject(project.id, 'workflow.created', { id: wid });
  notifyProject(project.id, 'review.updated', { id: rid });
  active.add(rid);
  void runAutoReview(rid, userId);
  return { ...getWorkflow(wid), review: { id: rid } };
}

/* ------------------------------------------------------------------ */
/* Doing the review                                                    */
/* ------------------------------------------------------------------ */

async function prepareDiff(review: Row, repo: Repo): Promise<string> {
  await ensureFresh(repo);
  if (repo.provider === 'github') await fetchPullRef(repo, Number(review.pr_number));
  else {
    // A branch pushed moments ago may not be in the clone yet.
    const has = await git(['rev-parse', '--verify', '--quiet', `origin/${review.head}`], { cwd: repoDir(repo) }).then(() => true, () => false);
    if (!has) await syncRepo(getRepo(repo.id));
  }
  return diffRefs(repo, review.base, review.head);
}

async function runAutoReview(reviewId: string, userId: string): Promise<void> {
  const first = one<Row>('SELECT * FROM reviews WHERE id = ?', reviewId);
  if (!first) return;
  const wid = String(first.workflow_id);
  const bill = (usd: number) => {
    const w = one<Row>('SELECT spent_usd FROM workflows WHERE id = ?', wid);
    if (w) patch(wid, { spent_usd: Number(w.spent_usd ?? 0) + usd });
  };
  let stage = 'preparing the changes';
  try {
    const repo = getRepo(first.repo_id);
    const raw = await prepareDiff(first, repo);
    if (!raw.trim()) {
      update('reviews', reviewId, { status: 'done', summary: 'No differences between the pull request and its base.', finished_at: now(), post_state: 'nothing' });
      notifyProject(first.project_id, 'review.updated', { id: reviewId });
      return finish(wid, 'done', `Pull request #${first.pr_number} has no changes to review.`);
    }
    const { diff, truncated } = trimDiff(raw);
    const files = parseUnifiedDiff(diff).map((f) => ({ path: f.newPath, oldPath: f.oldPath, status: f.status, additions: f.additions, deletions: f.deletions, binary: f.binary }));
    update('reviews', reviewId, { diff, files: JSON.stringify(files), summary: truncated ? 'The diff was very large, so only the first files were reviewed.' : null });
    notifyProject(first.project_id, 'review.updated', { id: reviewId });

    stage = 'reviewing';
    const review = one<Row>('SELECT * FROM reviews WHERE id = ?', reviewId)!;
    const { findings, summary } = await reviewPasses(review, repo, userId, bill);
    storeFindings(reviewId, findings);
    update('reviews', reviewId, { status: 'done', summary: truncated ? `${summary} (Only the first files were reviewed: the diff was very large.)` : summary, finished_at: now() });
    notifyProject(first.project_id, 'review.updated', { id: reviewId });

    stage = 'posting the comments';
    if (first.post_mode === 'auto') {
      const out = await postReview(reviewId, userId);
      finish(wid, 'done', out.posted ? `Posted ${out.posted} comment${out.posted === 1 ? '' : 's'} to pull request #${first.pr_number}.` : `Nothing to post on pull request #${first.pr_number}: ${findings.length} finding${findings.length === 1 ? ' is' : 's are'} below the threshold, already posted or none.`);
    } else {
      const pv = previewPost(reviewId);
      if (pv.total) {
        update('reviews', reviewId, { post_state: 'awaiting', post_result: JSON.stringify({ pending: pv.total, inline: pv.inline, listed: pv.listed, held: pv.held }) });
        notifyProject(first.project_id, 'review.updated', { id: reviewId });
        finish(wid, 'done', `Review ready: approve to post ${pv.total} comment${pv.total === 1 ? '' : 's'} to pull request #${first.pr_number}.`);
      } else {
        update('reviews', reviewId, { post_state: 'nothing', post_result: JSON.stringify({ posted: 0, held: pv.held, at: now() }) });
        finish(wid, 'done', `Review done. Nothing to post on pull request #${first.pr_number}.`);
      }
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 280);
    const cur = one<Row>('SELECT status FROM reviews WHERE id = ?', reviewId);
    if (cur && cur.status === 'running') update('reviews', reviewId, { status: 'error', error: msg, finished_at: now() });
    notifyProject(first.project_id, 'review.updated', { id: reviewId });
    auditRaw(userId, 'review.auto_error', `review:${reviewId}`, { projectId: first.project_id, pr: first.pr_number, stage, error: msg });
    finish(wid, 'failed', `The review failed while ${stage}: ${msg}`);
  } finally {
    active.delete(reviewId);
  }
}

function finish(workflowId: string, status: 'done' | 'failed', reason: string): void {
  try {
    stopWith(workflowId, status, reason);
  } catch {
    /* the session may have been deleted */
  }
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

/** True for the coordinating session of an automatic review. */
export function isReviewSession(workflowId: string): boolean {
  return Boolean(one<Row>('SELECT 1 AS x FROM reviews WHERE workflow_id = ?', workflowId));
}

/** Resume pressed on a review's session: run a failed review again, otherwise show where it stands. */
export function resumePrReview(workflowId: string): void {
  const r = one<Row>('SELECT * FROM reviews WHERE workflow_id = ?', workflowId);
  if (!r) return;
  if (r.status === 'error' && !active.has(String(r.id))) {
    update('reviews', r.id, { status: 'running', error: null, finished_at: null });
    patch(workflowId, { status: 'paused', stop_reason: 'Reviewing the pull request again.' });
    log(workflowId, 'status', 'Reviewing again.');
    active.add(String(r.id));
    void runAutoReview(String(r.id), String(getWorkflow(workflowId).created_by));
    return;
  }
  if (r.status === 'running') {
    patch(workflowId, { status: 'paused', stop_reason: 'Reviewing the pull request. The result is stored in Code review.' });
    return;
  }
  stopWith(workflowId, 'done', r.post_state === 'awaiting' ? 'Review ready: approve to post it from the Inbox or Code review.' : 'The review is finished.');
}

/** Reviews a restart cut short: fail them (an Inbox escalation) so a person can run them again. */
export function reconcilePrReviews(): void {
  for (const r of all<Row>("SELECT id, workflow_id FROM reviews WHERE source = 'auto' AND status = 'running'")) {
    if (active.has(String(r.id))) continue;
    update('reviews', r.id, { status: 'error', error: 'The portal restarted while the review was running.', finished_at: now() });
    finish(String(r.workflow_id), 'failed', 'The portal restarted while the review was running. Resume the session to review again.');
  }
}

/** Reviews whose comments wait for a person (draft mode), for the Inbox. */
export function awaitingReviews(userId: string, projectFilter: string | null): Row[] {
  return all<Row>(
    `SELECT r.id, r.project_id, r.pr_number, r.pr_title, r.pr_url, r.workflow_id, r.post_result, r.created_at, p.name AS project_name, g.name AS repo_name
       FROM reviews r JOIN projects p ON p.id = r.project_id LEFT JOIN repos g ON g.id = r.repo_id
      WHERE r.post_state = 'awaiting' AND (? IS NULL OR r.project_id = ?)
        AND (r.created_by = ? OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = r.project_id AND m.user_id = ?))
      ORDER BY r.created_at DESC LIMIT 50`,
    projectFilter, projectFilter, userId, userId,
  );
}

export function awaitingReviewCount(userId: string): number {
  return Number(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM reviews r WHERE r.post_state = 'awaiting'
          AND (r.created_by = ? OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = r.project_id AND m.user_id = ?))`,
      userId, userId,
    )?.n ?? 0,
  );
}
