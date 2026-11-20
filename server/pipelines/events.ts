/** Pure parsing of a GitHub `workflow_run` delivery into what the pipeline monitor stores. Everything in the payload is untrusted. */

import type { PipelineStatus } from '../repositories/pipeline-runs.ts';

export interface WorkflowRunEvent {
  repoFullName: string;
  runId: number;
  runAttempt: number;
  runNumber: number;
  workflowId: number;
  workflowName: string;
  branch: string;
  headSha: string;
  actor: string;
  event: string;
  status: PipelineStatus;
  htmlUrl: string;
  startedAt: string | null;
  completedAt: string | null;
}

const MAX_TEXT = 200;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Strip control characters and bound the length. */
const clean = (v: unknown, max = MAX_TEXT): string => text(v).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, max);
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const timestamp = (v: unknown): string | null => {
  const s = text(v);
  if (!s || s.length > 40) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** Only a plain https://github.com URL without userinfo or port, and nothing hidden in the raw text. */
function githubUrl(v: unknown): string {
  const raw = text(v);
  if (!raw || raw.length > 500 || /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw)) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.host !== 'github.com' || u.username || u.password || u.port) return '';
    return u.href;
  } catch {
    return '';
  }
}

const CONCLUSIONS: Record<string, PipelineStatus> = {
  success: 'success', failure: 'failure', timed_out: 'timed_out', cancelled: 'cancelled', skipped: 'skipped',
};

export function parseWorkflowRun(eventName: string, payload: unknown): WorkflowRunEvent | null {
  if (eventName !== 'workflow_run') return null;
  const p = obj(payload);
  const run = obj(p?.workflow_run);
  if (!p || !run) return null;
  const repoFullName = text(obj(p.repository)?.full_name);
  if (!REPO_RE.test(repoFullName)) return null;

  const runId = posInt(run.id);
  const workflowId = posInt(run.workflow_id);
  const runNumber = posInt(run.run_number);
  const runAttempt = run.run_attempt === undefined ? 1 : posInt(run.run_attempt);
  if (!runId || !workflowId || !runNumber || !runAttempt) return null;

  const branch = clean(run.head_branch);
  if (!branch) return null;

  let status: PipelineStatus;
  if (p.action === 'requested') status = 'queued';
  else if (p.action === 'in_progress') status = 'in_progress';
  else if (p.action === 'completed') status = CONCLUSIONS[text(run.conclusion)] ?? 'other';
  else return null;

  const actor = clean(obj(run.triggering_actor)?.login, 100) || clean(obj(run.actor)?.login, 100);

  return {
    repoFullName,
    runId,
    runAttempt,
    runNumber,
    workflowId,
    workflowName: clean(run.name),
    branch,
    headSha: text(run.head_sha).replace(/[^0-9a-fA-F]/g, '').slice(0, 64),
    actor,
    event: clean(run.event, 50),
    status,
    htmlUrl: githubUrl(run.html_url),
    startedAt: timestamp(run.run_started_at) ?? timestamp(run.created_at),
    completedAt: p.action === 'completed' ? timestamp(run.updated_at) : null,
  };
}
