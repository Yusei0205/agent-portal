/** Turning a CI failure candidate into a finding, and fetching its evidence from GitHub. */

import { getAutofixFindingsRepository } from '../repositories/autofix-findings.ts';
import type { AutofixFinding } from '../repositories/autofix-findings.ts';
import { getGitReposRepository } from '../repositories/git-repos.ts';
import type { GitRepoRecord } from '../repositories/git-repos.ts';
import { githubTokenForRepo } from '../pull-requests.ts';
import { parseGitHubOwnerRepo } from '../review.ts';
import { computeFingerprint } from './fingerprint.ts';
import { scrubEvidence } from './scrub.ts';
import { getAutofixPolicy } from './policy.ts';
import { maybeProcess } from './pipeline.ts';
import type { FindingCandidate } from './github-events.ts';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
let githubFetch: FetchFn | null = null;
/** Test seam for the GitHub network calls. Call with null to restore the real fetch. */
export function _setGithubFetch(fn: FetchFn | null): void { githubFetch = fn; }

const LOG_TAIL_BYTES = 64 * 1024;

/** The project's GitHub repository whose remote is `fullName` (owner/name, case-insensitive), or null. CodeCommit never matches. */
export async function findProjectGithubRepo(projectId: string, fullName: string): Promise<GitRepoRecord | null> {
  const want = fullName.toLowerCase();
  for (const r of await getGitReposRepository().listByProject(projectId)) {
    if (r.provider === 'codecommit') continue;
    const slug = parseGitHubOwnerRepo(r.url ?? '');
    if (slug && `${slug.owner}/${slug.repo}`.toLowerCase() === want) return r;
  }
  return null;
}

export async function fetchCiEvidence(c: FindingCandidate, projectId: string): Promise<string> {
  const fallback = scrubEvidence(`${c.kind} CI check failed (conclusion: failure) on ${c.branch}`);
  if (!c.runId) return fallback;
  try {
    const repo = await findProjectGithubRepo(projectId, c.repoFullName);
    const slug = repo ? parseGitHubOwnerRepo(repo.url ?? '') : null;
    if (!repo || !slug) return fallback;
    const token = await githubTokenForRepo(repo);
    const doFetch: FetchFn = githubFetch ?? ((u, i) => fetch(u, i));
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const base = `https://api.github.com/repos/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}`;
    const jobsRes = await doFetch(`${base}/actions/runs/${c.runId}/jobs?per_page=100`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!jobsRes.ok) return fallback;
    const jobs = ((await jobsRes.json()) as { jobs?: Array<{ id: number; name: string; conclusion: string | null }> }).jobs ?? [];
    const failed = jobs.find((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out');
    if (!failed) return fallback;
    const logRes = await doFetch(`${base}/actions/jobs/${failed.id}/logs`, { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!logRes.ok) return scrubEvidence(`${failed.name} ${failed.conclusion}`);
    const log = await logRes.text();
    return scrubEvidence(log.length > LOG_TAIL_BYTES ? log.slice(-LOG_TAIL_BYTES) : log);
  } catch {
    return fallback;
  }
}

export async function recordFinding(projectId: string, c: FindingCandidate, evidence: string): Promise<{ finding: AutofixFinding; created: boolean }> {
  const repos = getAutofixFindingsRepository();
  const repo = await findProjectGithubRepo(projectId, c.repoFullName);
  const clean = scrubEvidence(evidence);
  const fingerprint = computeFingerprint({ repo: c.repoFullName, branch: c.branch, kind: c.kind, error: c.errorText });
  const policy = await getAutofixPolicy(projectId);
  const { finding, created } = await repos.upsertByFingerprint({
    project_id: projectId, source: c.source, kind: c.kind, fingerprint, severity: c.severity, evidence: clean,
    repo_id: repo?.id ?? null, branch: c.branch, commit_sha: c.headSha || null,
  });

  if (created) {
    if (policy.mode === 'off') await repos.transition(finding.id, ['new'], { status: 'suppressed' });
    else void maybeProcess(finding.id); // in the background; it never rejects
    return { finding: (await repos.getById(finding.id)) ?? finding, created };
  }

  const cooling = finding.cooldown_until !== null && Date.parse(finding.cooldown_until) > Date.now();
  if ((finding.status === 'dismissed' || finding.status === 'suppressed') && cooling) return { finding, created }; // counter only
  if (finding.status === 'resolved') {
    if (await repos.transition(finding.id, ['resolved'], { status: 'new', evidence: clean, commit_sha: c.headSha || finding.commit_sha })) {
      void maybeProcess(finding.id); // reopened: in the background; it never rejects
    }
  } else if (finding.status !== 'fixing' && finding.status !== 'pr_open') {
    // A finding being fixed keeps the evidence and commit the fix works from; only the counter moves.
    await repos.transition(finding.id, [finding.status], { status: finding.status, evidence: clean, commit_sha: c.headSha || finding.commit_sha });
    // A finding still waiting as `new` (held back earlier) gets another chance with each new delivery.
    if (finding.status === 'new') void maybeProcess(finding.id);
  }
  return { finding: (await repos.getById(finding.id)) ?? finding, created };
}
