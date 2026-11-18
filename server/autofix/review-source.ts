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
 * Fingerprint: repository, branch family, kind, the normalised message and, kept out of the normalisation, the exact file path
 * (reviewFilePath), without the line number: the same finding on a rerun or a later commit is one finding, and the same message on two
 * files that share a basename (server/api/users.ts, server/admin/users.ts) is two. A rerun never re-opens a finding being fixed or with
 * a PR open (recordFinding), nor a resolved one whose fix PR is still open (the reviewed branch has not taken the fix yet).
 *
 * Known limits: a person dismisses review findings after the review has finished, so the `accepted !== -1` filter only sees findings
 * dismissed before a rerun; and rerun dedupe relies on the reviewer wording the message the same way (different wording is a new
 * finding).
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
/**
 * The whole evidence stays under this many characters: the fix goal keeps only the last 4000 (pipeline.ts EVIDENCE_IN_GOAL), so a
 * longer one would lose its header (file and line) first. The header is at most about 900 characters; message and suggestion share
 * the rest.
 */
export const REVIEW_EVIDENCE_MAX = 3_800;
const SUGGESTION_MAX = 1_000;

/** The category as a kind: lowercase, [a-z0-9-], at most 40 characters; 'review' when nothing is left. */
export function reviewKindSlug(category: unknown): string {
  const s = String(category ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
  return s || 'review';
}

/**
 * The file path as a fingerprint component: backslashes as slashes, leading `./` and `/` removed, lowercased (so `./src/A.ts`,
 * `src\\A.ts` and `src/a.ts` are one file).
 */
export function reviewFilePath(p: unknown): string {
  return String(p ?? '').trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '').toLowerCase();
}

/** One line, no control characters, credentials removed. */
const oneLine = (v: unknown, max: number): string => scrubSecrets(String(v ?? '')).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

function splitBody(body: string): { message: string; suggestion: string } {
  const i = body.indexOf(SUGGESTION_MARK);
  if (i < 0) return { message: body.trim(), suggestion: '' };
  return { message: body.slice(0, i).trim(), suggestion: body.slice(i + SUGGESTION_MARK.length).trim() };
}

function evidenceFor(review: ReviewRecord, f: FindingRecord, kind: string, branch: string, sha: string, message: string, suggestion: string): string {
  // A long path keeps its end (the file name), not its start.
  const path = oneLine(f.file_path, 100_000);
  const shownPath = path.length > 300 ? `…${path.slice(-299)}` : path;
  const where = `${shownPath || '(no file)'}${f.line_number != null ? `:${f.line_number}` : ''}`;
  const pr = review.pr_number != null ? ` of pull request #${review.pr_number}` : '';
  const header = [
    `Code review ${oneLine(review.id, 80)}${pr} on branch ${branch}${sha ? ` at commit ${sha.slice(0, 12)}` : ''}: ${where}`,
    `Severity: ${SEVERITY[f.severity]}. Category: ${kind}.`,
    `Title: ${oneLine(f.title, 200)}`,
    'Message:',
  ].join('\n');
  // What is left after the header and the labels goes to the message first; the suggestion gets at most a third of it.
  const room = Math.max(0, REVIEW_EVIDENCE_MAX - header.length - '\nSuggestion:\n'.length - '\n'.length - '(none)'.length);
  const sugg = suggestion ? suggestion.slice(0, Math.min(SUGGESTION_MAX, Math.floor(room / 3))) : '';
  const msg = message.slice(0, room - sugg.length);
  return `${header}\n${msg}\nSuggestion:\n${sugg || '(none)'}`;
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
    .filter((f) => f.accepted !== -1 && Object.hasOwn(SEVERITY, f.severity))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.created_at.localeCompare(b.created_at))
    .slice(0, MAX_PER_REVIEW);
  const findings = getAutofixFindingsRepository();
  for (const f of wanted) {
    // The review store keeps no category today; a store that does gets its category as the kind.
    const kind = reviewKindSlug((f as FindingRecord & { category?: unknown }).category);
    const { message, suggestion } = splitBody(String(f.body ?? ''));
    const c: FindingCandidate = {
      repoFullName, branch, headSha: sha, source: 'review_finding', kind, severity: SEVERITY[f.severity],
      errorText: message,
      // The exact path, outside normalizeError (which would cut it to its first segment and basename).
      fingerprintSubject: reviewFilePath(f.file_path),
    };
    // A resolved finding whose fix PR is still open: the reviewed branch has not taken the fix yet, so a rerun would only repeat it.
    const fp = computeFingerprint({ repo: c.repoFullName, branch: c.branch, kind: c.kind, error: c.errorText, subject: c.fingerprintSubject });
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
