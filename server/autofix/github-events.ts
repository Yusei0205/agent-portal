/** Pure parsing of GitHub webhook deliveries into what auto-fix cares about. */

import type { FindingSource } from '../repositories/autofix-findings.ts';

export interface FindingCandidate {
  repoFullName: string;
  branch: string;
  headSha: string;
  source: FindingSource;
  kind: string;
  severity: 'low' | 'medium' | 'high';
  errorText: string;
  /** An exact identity kept out of the error normalisation (see computeFingerprint); only review findings set it. */
  fingerprintSubject?: string;
  runId?: number;
}

export type GithubEventResult =
  | { type: 'finding'; candidate: FindingCandidate }
  /** workflowName and runId: which workflow run reported (a fix is judged only by runs of its own kind; the run's log is the evidence). */
  | { type: 'ci_result'; repoFullName: string; branch: string; conclusion: 'success' | 'failure'; headSha: string; workflowName?: string; runId?: number }
  | { type: 'pr_closed'; repoFullName: string; branch: string; merged: boolean; prNumber: number }
  | { type: 'ignore' };

const IGNORE: GithubEventResult = { type: 'ignore' };
export const AUTOFIX_BRANCH_PREFIX = 'autofix/';

export function classifyKind(name: string): 'lint' | 'types' | 'build' | 'tests' | 'other' {
  if (/lint|eslint|prettier/i.test(name)) return 'lint';
  if (/type|tsc/i.test(name)) return 'types';
  if (/build|compile/i.test(name)) return 'build';
  if (/test/i.test(name)) return 'tests';
  return 'other';
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function parseGithubEvent(event: string, payload: unknown): GithubEventResult {
  const p = obj(payload);
  if (!p) return IGNORE;
  const repoFullName = text(obj(p.repository)?.full_name);
  if (!repoFullName) return IGNORE;

  if (event === 'workflow_run') {
    const run = obj(p.workflow_run);
    if (!run || p.action !== 'completed') return IGNORE;
    const branch = text(run.head_branch);
    const headSha = text(run.head_sha);
    if (!branch) return IGNORE;
    const conclusion = text(run.conclusion);
    const name = text(run.name) || 'CI';
    const runId = typeof run.id === 'number' ? run.id : undefined;
    const about = { workflowName: name, ...(runId !== undefined ? { runId } : {}) };
    // A CI result speaks for a fix branch only when the run was on this repository's own branch: a fork's run (a PR from a fork whose
    // branch happens to be named autofix/...) is ignored.
    const headRepo = text(obj(run.head_repository)?.full_name);
    const ownRun = headRepo.toLowerCase() === repoFullName.toLowerCase();
    if (conclusion === 'success') return ownRun ? { type: 'ci_result', repoFullName, branch, conclusion: 'success', headSha, ...about } : IGNORE;
    if (conclusion !== 'failure' && conclusion !== 'timed_out') return IGNORE;
    // A failing run on a fix branch reports on that fix attempt; it never opens a new finding.
    if (branch.startsWith(AUTOFIX_BRANCH_PREFIX)) return ownRun ? { type: 'ci_result', repoFullName, branch, conclusion: 'failure', headSha, ...about } : IGNORE;
    const kind = classifyKind(name);
    return {
      type: 'finding',
      candidate: {
        repoFullName, branch, headSha, source: 'ci_failed', kind,
        severity: kind === 'lint' ? 'low' : 'medium',
        errorText: `${name} ${conclusion}`,
        runId,
      },
    };
  }

  // check_suite is ignored on purpose: GitHub Actions failures arrive as workflow_run too, so taking both would double count.
  if (event === 'pull_request') {
    const pr = obj(p.pull_request);
    if (!pr || p.action !== 'closed') return IGNORE;
    const branch = text(obj(pr.head)?.ref);
    const prNumber = typeof pr.number === 'number' ? pr.number : Number(p.number);
    if (!branch || !Number.isFinite(prNumber)) return IGNORE;
    return { type: 'pr_closed', repoFullName, branch, merged: pr.merged === true, prNumber };
  }
  return IGNORE;
}
