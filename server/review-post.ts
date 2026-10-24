/**
 * Putting review findings on a pull request (FR-REV-3, NEW-3).
 *
 * One function decides what is posted and one posts it, for manual reviews and for the automatic review of the
 * "Review new pull requests" loop spec alike:
 *
 *  - Which findings: dismissed ones never; below the minimum severity or the minimum confidence only when a person
 *    accepted them; ones already posted on the same pull request (same file, line and text) never again, also not by a
 *    later review of new commits; no more than the cap for the whole pull request.
 *  - Where they go: a finding whose line is on the changed side of the diff becomes an inline comment; every other
 *    finding is listed in the one summary comment. GitHub refuses a whole review when one inline line is not in the
 *    diff, so that is checked first, and a refusal falls back to a summary comment holding everything.
 *  - What they say: text that is about to leave the portal is scrubbed of secret values (agent/heuristics.ts).
 *  - CodeCommit: one summary comment on the pull request. Inline comments are not used there (see FR-REV-4).
 */
import { all, insert, one, run as exec, update, type Row } from './db.ts';
import { auditRaw } from './audit.ts';
import { notifyProject } from './projects.ts';
import { getRepo, githubApi, postCodeCommitSummary, type Repo } from './repos.ts';
import { HttpError, badRequest, newId, notFound, now, parseJson, sha256, withLock } from './util.ts';
import { parseUnifiedDiff, redactSecrets, secretLiterals, type DiffFile, type Severity } from './agent/heuristics.ts';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const rank = (s: string): number => {
  const i = SEVERITIES.indexOf(s as Severity);
  return i < 0 ? 2 : i;
};

export interface PostOptions {
  minSeverity: Severity;
  /** Findings with a confidence below this are left out (findings without one are kept). */
  minConfidence: number;
  /** At most this many findings on one pull request, counting those posted earlier when `dedupe` is on. */
  maxComments: number;
  /** Leave out what was posted before on the same pull request, and post nothing when nothing is left. */
  dedupe: boolean;
}

/** What a person gets when they press "Post to GitHub" on a review they started themselves: everything not dismissed. */
export const MANUAL_POST_OPTIONS: PostOptions = { minSeverity: 'info', minConfidence: 0, maxComments: 50, dedupe: false };

export function postOptionsOf(review: Row): PostOptions {
  const stored = parseJson<Partial<PostOptions>>(review.post_options, {});
  return { ...MANUAL_POST_OPTIONS, ...stored };
}

const MARK = (fp: string) => `<!-- agent-portal:fp=${fp} -->`;
const MARK_RE = /agent-portal:fp=([0-9a-f]{16})/g;

/** How a finding is recognised on a later review of the same pull request: file, line and wording. */
export function fingerprint(file: string, line: number | null, message: string): string {
  return sha256(`${file}\n${line ?? ''}\n${message.toLowerCase().replace(/\s+/g, ' ').trim()}`).slice(0, 16);
}

/** The lines of the new side of each file that a review comment can sit on. */
function commentable(files: DiffFile[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const f of files) {
    const set = out.get(f.newPath) ?? new Set<number>();
    for (const h of f.hunks) for (const l of h.lines) if (l.newLine !== null && l.type !== 'del') set.add(l.newLine);
    out.set(f.newPath, set);
  }
  return out;
}

/** The secret values the added lines of each file contain, so a reviewer quoting one without its name is still scrubbed. */
function literalsByFile(files: DiffFile[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of files) {
    const lits = new Set<string>();
    for (const h of f.hunks) for (const l of h.lines) if (l.type === 'add') for (const s of secretLiterals(l.text)) lits.add(s);
    out.set(f.newPath, [...lits]);
  }
  return out;
}

export interface Planned {
  f: Row;
  fp: string;
  message: string;
  suggestion: string | null;
  inline: boolean;
}
export type HeldReason = 'severity' | 'confidence' | 'duplicate' | 'cap';
export interface Plan {
  inline: Planned[];
  listed: Planned[];
  held: { f: Row; reason: HeldReason }[];
}

/**
 * Decide what to post. `known` holds the fingerprints already on the pull request; `alreadyPosted` how many findings
 * the portal put there before (they use up the cap).
 */
export function planPost(findings: Row[], diffFiles: DiffFile[], opts: PostOptions, known: Set<string>, alreadyPosted: number): Plan {
  const lines = commentable(diffFiles);
  const lits = literalsByFile(diffFiles);
  const plan: Plan = { inline: [], listed: [], held: [] };
  const seen = new Set<string>();
  let room = Math.max(0, opts.maxComments - (opts.dedupe ? alreadyPosted : 0));
  const ordered = [...findings].sort(
    (a, b) =>
      Number(b.status === 'accepted') - Number(a.status === 'accepted') ||
      rank(a.severity) - rank(b.severity) ||
      String(a.file).localeCompare(String(b.file)) ||
      Number(a.line ?? 0) - Number(b.line ?? 0),
  );
  for (const f of ordered) {
    if (f.status === 'dismissed') continue;
    const accepted = f.status === 'accepted';
    if (!accepted && rank(f.severity) > rank(opts.minSeverity)) {
      plan.held.push({ f, reason: 'severity' });
      continue;
    }
    if (!accepted && f.confidence !== null && f.confidence !== undefined && Number(f.confidence) < opts.minConfidence) {
      plan.held.push({ f, reason: 'confidence' });
      continue;
    }
    const l = lits.get(String(f.file)) ?? [];
    const message = redactSecrets(String(f.message), l);
    const suggestion = f.suggestion ? redactSecrets(String(f.suggestion), l) : null;
    const fp = fingerprint(String(f.file), f.line ?? null, message);
    if ((opts.dedupe && known.has(fp)) || seen.has(fp)) {
      plan.held.push({ f, reason: 'duplicate' });
      continue;
    }
    seen.add(fp);
    if (room <= 0) {
      plan.held.push({ f, reason: 'cap' });
      continue;
    }
    room--;
    const inline = Boolean(f.line) && Boolean(lines.get(String(f.file))?.has(Number(f.line)));
    (inline ? plan.inline : plan.listed).push({ f, fp, message, suggestion, inline });
  }
  return plan;
}

/** Fingerprints the portal has put on a pull request, from its own records. */
function localFingerprints(repoId: string, pr: number): { known: Set<string>; count: number } {
  const rows = all<Row>('SELECT DISTINCT fingerprint FROM review_comments WHERE repo_id = ? AND pr_number = ?', repoId, pr);
  return { known: new Set(rows.map((r) => String(r.fingerprint))), count: rows.length };
}

/** Fingerprints found in the comments and reviews on GitHub itself (best effort: the records above are the main source). */
async function githubFingerprints(repo: Repo, pr: number): Promise<Set<string>> {
  const known = new Set<string>();
  for (const p of [`/pulls/${pr}/comments?per_page=100`, `/pulls/${pr}/reviews?per_page=100`]) {
    try {
      const list = await githubApi(repo, 'GET', p);
      if (Array.isArray(list)) for (const item of list) for (const m of String(item?.body ?? '').matchAll(MARK_RE)) known.add(m[1]);
    } catch {
      /* the local records still apply */
    }
  }
  return known;
}

export interface PostPreview {
  inline: number;
  listed: number;
  total: number;
  held: Record<HeldReason, number>;
}

function countHeld(plan: Plan): Record<HeldReason, number> {
  const held: Record<HeldReason, number> = { severity: 0, confidence: 0, duplicate: 0, cap: 0 };
  for (const h of plan.held) held[h.reason]++;
  return held;
}

/** What posting would do now, without posting (the Inbox item says how many comments wait for approval). */
export function previewPost(reviewId: string): PostPreview {
  const r = one<Row>('SELECT * FROM reviews WHERE id = ?', reviewId);
  if (!r) throw notFound('Review not found');
  const opts = postOptionsOf(r);
  const local = r.pr_number ? localFingerprints(String(r.repo_id), Number(r.pr_number)) : { known: new Set<string>(), count: 0 };
  const plan = planPost(all<Row>('SELECT * FROM findings WHERE review_id = ?', r.id), parseUnifiedDiff(String(r.diff ?? '')), opts, local.known, local.known.size);
  return { inline: plan.inline.length, listed: plan.listed.length, total: plan.inline.length + plan.listed.length, held: countHeld(plan) };
}

const CAP_NOTE = (n: number, opts: PostOptions) => `${n} more finding${n === 1 ? '' : 's'} not posted because ${opts.maxComments} is the most this pull request gets`;

function heldLine(held: Record<HeldReason, number>, opts: PostOptions): string {
  const parts: string[] = [];
  if (held.severity) parts.push(`${held.severity} below ${opts.minSeverity} severity`);
  if (held.confidence) parts.push(`${held.confidence} with low confidence`);
  if (held.duplicate) parts.push(`${held.duplicate} already posted`);
  if (held.cap) parts.push(CAP_NOTE(held.cap, opts));
  return parts.length ? `_Left out: ${parts.join(', ')}. The full list is in the portal._` : '';
}

function inlineBody(p: Planned): string {
  const f = p.f;
  return `**${f.severity}** · ${f.category}\n\n${p.message}${p.suggestion ? `\n\n_Suggestion:_ ${p.suggestion}` : ''}\n\n${MARK(p.fp)}`;
}

function listedLine(p: Planned, withMark: boolean): string {
  const f = p.f;
  return `- **${f.severity}** \`${f.file}${f.line ? `:${f.line}` : ''}\`: ${p.message.replace(/\s*\n\s*/g, ' ')}${withMark ? ` ${MARK(p.fp)}` : ''}`;
}

function summaryBody(r: Row, listed: Planned[], posted: number, held: Record<HeldReason, number>, opts: PostOptions, foldedInline: Planned[], codecommit: boolean): string {
  const allLiterals = [...literalsByFile(parseUnifiedDiff(String(r.diff ?? ''))).values()].flat();
  const summary = redactSecrets(String(r.summary ?? ''), allLiterals);
  const rows = [...foldedInline, ...listed];
  const out = [`**Agent Portal review** (${posted} finding${posted === 1 ? '' : 's'})`, summary];
  if (rows.length) out.push(`${foldedInline.length ? 'Findings' : 'Findings not on a changed line'}:\n${rows.map((p) => listedLine(p, !codecommit)).join('\n')}`);
  if (opts.dedupe) out.push(heldLine(held, opts));
  return out.filter(Boolean).join('\n\n').slice(0, codecommit ? 10_000 : 60_000);
}

export interface PostOutcome {
  ok: true;
  /** Findings put on the pull request (inline plus listed in the summary). */
  posted: number;
  inline: number;
  listed: number;
  held: Record<HeldReason, number>;
  state: 'posted' | 'nothing';
}

/**
 * Post a review's findings to its pull request. `by` is the person who asked (null: the portal, for an automatic
 * review in auto mode). Safe to call twice: the second call finds the first call's comments and posts nothing new
 * when the review's options say `dedupe`.
 */
export async function postReview(reviewId: string, by: string | null): Promise<PostOutcome> {
  const first = one<Row>('SELECT * FROM reviews WHERE id = ?', reviewId);
  if (!first) throw notFound('Review not found');
  return withLock(`review-post:${first.repo_id}:${first.pr_number}`, async () => {
    const r = one<Row>('SELECT * FROM reviews WHERE id = ?', reviewId);
    if (!r) throw notFound('Review not found');
    const repo = getRepo(String(r.repo_id));
    if (!r.pr_number || !r.head_sha) throw badRequest('Posting works for GitHub and CodeCommit pull request reviews only');
    if (repo.provider !== 'github' && repo.provider !== 'codecommit') throw badRequest('Posting works for GitHub and CodeCommit pull request reviews only');
    if (r.status !== 'done') throw badRequest('Wait for the review to finish before posting it');
    const opts = postOptionsOf(r);
    const pr = Number(r.pr_number);
    const local = localFingerprints(String(r.repo_id), pr);
    const known = opts.dedupe ? new Set([...local.known, ...(repo.provider === 'github' ? await githubFingerprints(repo, pr) : [])]) : local.known;
    const diffFiles = parseUnifiedDiff(String(r.diff ?? ''));
    const plan = planPost(all<Row>('SELECT * FROM findings WHERE review_id = ?', r.id), diffFiles, opts, known, known.size);
    const held = countHeld(plan);
    const wanted = plan.inline.length + plan.listed.length;
    const finish = (state: 'posted' | 'nothing', inlineN: number, listedN: number): PostOutcome => {
      const result = { posted: inlineN + listedN, inline: inlineN, listed: listedN, held, at: now() };
      update('reviews', r.id, { post_state: state, post_result: JSON.stringify(result), ...(state === 'posted' ? { posted_at: now() } : {}) });
      notifyProject(String(r.project_id), 'review.updated', { id: r.id });
      auditRaw(by, 'review.post', `review:${r.id}`, { projectId: r.project_id, pr, ...result });
      return { ok: true, posted: inlineN + listedN, inline: inlineN, listed: listedN, held, state };
    };
    if (!wanted && opts.dedupe) return finish('nothing', 0, 0);

    let inlinePosted = plan.inline;
    let listedPosted = plan.listed;
    try {
      if (repo.provider === 'github') {
        const send = (body: string, comments: Planned[]) =>
          githubApi(repo, 'POST', `/pulls/${pr}/reviews`, {
            commit_id: r.head_sha,
            event: 'COMMENT',
            body,
            comments: comments.map((p) => ({ path: p.f.file, line: p.f.line, side: 'RIGHT', body: inlineBody(p) })),
          });
        try {
          await send(summaryBody(r, plan.listed, wanted, held, opts, [], false), plan.inline);
        } catch (e) {
          // GitHub refuses the whole review when one inline comment cannot be placed; keep the findings in the summary instead.
          if (!(e instanceof HttpError) || !/\b422\b/.test(e.message) || !plan.inline.length) throw e;
          await send(summaryBody(r, plan.listed, wanted, held, opts, plan.inline, false), []);
          listedPosted = [...plan.inline, ...plan.listed];
          inlinePosted = [];
        }
      } else {
        await postCodeCommitSummary(repo, pr, summaryBody(r, plan.listed, wanted, held, opts, plan.inline, true));
        listedPosted = [...plan.inline, ...plan.listed];
        inlinePosted = [];
      }
    } catch (e: any) {
      if (r.source === 'auto') {
        update('reviews', r.id, { post_state: 'failed', post_result: JSON.stringify({ error: String(e?.message ?? e).slice(0, 300), at: now() }) });
        notifyProject(String(r.project_id), 'review.updated', { id: r.id });
      }
      throw e;
    }
    const at = now();
    for (const p of [...inlinePosted, ...listedPosted]) {
      insert('review_comments', { id: newId('rc_'), repo_id: String(r.repo_id), pr_number: pr, fingerprint: p.fp, review_id: String(r.id), finding_id: String(p.f.id), file: String(p.f.file), line: p.f.line ?? null, head_sha: String(r.head_sha), inline: inlinePosted.includes(p) ? 1 : 0, posted_at: at });
      exec('UPDATE findings SET posted_at = ? WHERE id = ?', at, p.f.id);
    }
    return finish('posted', inlinePosted.length, listedPosted.length);
  });
}
