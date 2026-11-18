/**
 * Code review findings become auto-fix findings (source `review_finding`), through recordFinding like every other source, so dedupe,
 * scrubbing and the status rules stay in one place.
 *
 * Called when a review has finished (review-lifecycle.ts) and never throws into the review flow. A review finding is emitted when:
 *  - the project's auto-fix mode is not off;
 *  - the review is a finished ('done') review of a GitHub repository of the project, not a full-repository scan, and its head branch
 *    is a plain branch name outside autofix/ (a review of an auto-fix PR must not start a fix of the fix);
 *  - the finding is medium, high or critical and was not dismissed by a person (accepted -1).
 *
 * Kind: the finding's category as a short slug ('review' when there is none: the review store keeps no category today). Triage then
 * applies the policy as for CI findings: the kind must be in policy.classes and the head branch must be eligible (a person's PR branch
 * only through branches.extra), so review fixing is opt-in.
 *
 * Fingerprint: repository, branch family, kind and `<file> <message>` without the line number, so the same finding on a rerun or a later
 * commit is one finding. A rerun never re-opens a finding being fixed or with a PR open (recordFinding), nor a resolved one whose fix
 * PR is still open (the reviewed branch has not taken the fix yet).
 */

import { getReviewsRepository } from '../repositories/reviews.ts';
import type { FindingRecord, ReviewRecord } from '../repositories/reviews.ts';
import { getGitReposRepository } from '../repositories/git-repos.ts';
import { getAutofixFindingsRepository } from '../repositories/autofix-findings.ts';
import { parseGitHubOwnerRepo } from '../review.ts';
import { scrubSecrets } from '../pull-requests.ts';
import { getAutofixPolicy } from './policy.ts';
import { recordFinding } from './intake.ts';
import { computeFingerprint } from './fingerprint.ts';
import { AUTOFIX_BRANCH_PREFIX } from './github-events.ts';
import type { FindingCandidate } from './github-events.ts';

/** Review severities that are fixed, and the finding severity each becomes. */
const SEVERITY: Record<string, 'high' | 'medium'> = { critical: 'high', high: 'high', medium: 'medium' };
const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2 };

/** A branch name safe to put in a git command line of the fix session's goal (the runner's own rule for repo.branch). */
export const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SAFE_SHA = /^[0-9a-f]{7,64}$/i;

/** How review.ts folds a reviewer's suggestion into the finding body (review-result.ts normalizeReviewFindings). */
const SUGGESTION_MARK = '\n\nSuggested fix:\n';
/** At most this many findings of one review become auto-fix findings (worst first). */
const MAX_PER_REVIEW = 20;
const MESSAGE_MAX = 2_000;
const SUGGESTION_MAX = 1_200;

/** The category as a kind: lowercase, [a-z0-9-], at most 40 characters; 'review' when nothing is left. */
export function reviewKindSlug(category: unknown): string {
  const s = String(category ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
  return s || 'review';
}

/** One line, no control characters, credentials removed. */
const oneLine = (v: unknown, max: number): string => scrubSecrets(String(v ?? '')).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

function splitBody(body: string): { message: string; suggestion: string } {
  const i = body.indexOf(SUGGESTION_MARK);
  if (i < 0) return { message: body.trim(), suggestion: '' };
  return { message: body.slice(0, i).trim(), suggestion: body.slice(i + SUGGESTION_MARK.length).trim() };
}

function evidenceFor(review: ReviewRecord, f: FindingRecord, kind: string, branch: string, sha: string, message: string, suggestion: string): string {
  const where = `${oneLine(f.file_path, 300) || '(no file)'}${f.line_number != null ? `:${f.line_number}` : ''}`;
  const pr = review.pr_number != null ? ` of pull request #${review.pr_number}` : '';
  return [
    `Code review ${review.id}${pr} on branch ${branch}${sha ? ` at commit ${sha.slice(0, 12)}` : ''}: ${where}`,
    `Severity: ${SEVERITY[f.severity]}. Category: ${kind}.`,
    `Title: ${oneLine(f.title, 200)}`,
    'Message:',
    message.slice(0, MESSAGE_MAX),
    'Suggestion:',
    suggestion ? suggestion.slice(0, SUGGESTION_MAX) : '(none)',
  ].join('\n');
}

async function emit(reviewId: string): Promise<void> {
  const review = await getReviewsRepository().getById(reviewId);
  if (!review || review.status !== 'done' || review.scan_id || !review.project_id || !review.repo_id) return;
  const projectId = review.project_id;
  if ((await getAutofixPolicy(projectId)).mode === 'off') return;

  const branch = String(review.head_ref ?? '');
  if (!SAFE_BRANCH.test(branch) || branch.includes('..') || branch.startsWith(AUTOFIX_BRANCH_PREFIX)) return;
  const gitRepo = await getGitReposRepository().getById(review.repo_id);
  if (!gitRepo || gitRepo.project_id !== projectId || gitRepo.provider === 'codecommit') return;
  const slug = parseGitHubOwnerRepo(gitRepo.url ?? '');
  if (!slug) return;
  const repoFullName = `${slug.owner}/${slug.repo}`;
  const shaRaw = String(review.source_sha ?? review.head_commit_sha ?? '');
  const sha = SAFE_SHA.test(shaRaw) ? shaRaw.toLowerCase() : '';

  const wanted = (await getReviewsRepository().listFindings(reviewId))
    .filter((f) => f.accepted !== -1 && f.severity in SEVERITY)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.created_at.localeCompare(b.created_at))
    .slice(0, MAX_PER_REVIEW);
  const findings = getAutofixFindingsRepository();
  for (const f of wanted) {
    // The review store keeps no category today; a store that does gets its category as the kind.
    const kind = reviewKindSlug((f as FindingRecord & { category?: unknown }).category);
    const { message, suggestion } = splitBody(String(f.body ?? ''));
    const c: FindingCandidate = {
      repoFullName, branch, headSha: sha, source: 'review_finding', kind, severity: SEVERITY[f.severity],
      errorText: `${String(f.file_path ?? '')} ${message}`,
    };
    // A resolved finding whose fix PR is still open: the reviewed branch has not taken the fix yet, so a rerun would only repeat it.
    const fp = computeFingerprint({ repo: c.repoFullName, branch: c.branch, kind: c.kind, error: c.errorText });
    const existing = await findings.getByFingerprint(projectId, fp);
    if (existing && existing.status === 'resolved' && existing.pr_branch) continue;
    await recordFinding(projectId, c, evidenceFor(review, f, kind, branch, sha, message, suggestion));
  }
}

/** Turn a finished review's findings into auto-fix findings (see the module comment). Never throws. */
export async function emitReviewFindings(reviewId: string): Promise<void> {
  try {
    await emit(reviewId);
  } catch (e) {
    console.error(`[autofix] emitting the findings of review ${reviewId} failed:`, e instanceof Error ? e.message : e);
  }
}
