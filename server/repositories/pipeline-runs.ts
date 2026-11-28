/**
 * Repository interface for the pipeline monitor: the latest GitHub workflow runs of a project (pipeline_runs) and one alert
 * state per repository + workflow + branch (pipeline_alerts).
 *
 * SQLite is the default backend. DynamoDB is activated by USE_DYNAMODB=true.
 *
 * DynamoDB table used: portal-projects
 *
 * Key design:
 *   PK=PROJECT#<projectId>  SK=PRUN#<runId>                                 the run (all fields, plus status_rank)
 *   PK=PROJECT#<projectId>  SK=PALERT#<repoId>#<workflowId>#<branch>        the alert state (all fields)
 *   latestPerBranch, history and prune read the project partition (PRUN# prefix) and work on it there.
 */

import { SqlitePipelineRunsRepository } from './pipeline-runs-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

export type PipelineStatus = 'queued' | 'in_progress' | 'success' | 'failure' | 'timed_out' | 'cancelled' | 'skipped' | 'other';

export const PIPELINE_STATUSES: readonly PipelineStatus[] = ['queued', 'in_progress', 'success', 'failure', 'timed_out', 'cancelled', 'skipped', 'other'];

export interface PipelineRun {
  project_id: string;
  repo_id: string;
  repo_full_name: string;
  run_id: number;
  run_attempt: number;
  run_number: number;
  workflow_id: number;
  workflow_name: string;
  branch: string;
  head_sha: string;
  actor: string;
  event: string;
  status: PipelineStatus;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
  /** Highest run_attempt the inbox alert was sent for (0 = never). */
  inbox_alerted_attempt: number;
  /** Highest run_attempt the chat message was sent for (0 = never). */
  chat_alerted_attempt: number;
  updated_at: string;
}

export interface PipelineAlert {
  project_id: string;
  repo_id: string;
  workflow_id: number;
  branch: string;
  open: boolean;
  inbox_id: string | null;
  last_run_id: number;
  last_run_number: number;
  failures: number;
  updated_at: string;
}

export type UpsertRunInput = Omit<PipelineRun, 'inbox_alerted_attempt' | 'chat_alerted_attempt' | 'updated_at'>;

export interface PipelineRunsRepository {
  /**
   * Store the run, or update it when it exists. The stored row is the one whose (run_attempt, status rank) is newest: a completed status
   * is never overwritten by a late queued/in_progress delivery of the same attempt, and a higher attempt replaces a lower one. The
   * alerted attempts are kept. Returns the stored row (the unchanged one when the delivery was older).
   */
  upsertRun(r: UpsertRunInput): Promise<{ run: PipelineRun; created: boolean }>;
  /** One row per repository + workflow + branch: the one with the highest run_number. */
  latestPerBranch(projectId: string): Promise<PipelineRun[]>;
  /** Newest first (by run_number, then run_id, descending). */
  history(projectId: string, repoId: string, workflowId: number, branch: string, limit: number): Promise<PipelineRun[]>;
  /** Keep the newest `keep` runs of the repository + workflow, and the latest run of every branch; delete the rest. Returns how many. */
  prune(projectId: string, repoId: string, workflowId: number, keep: number): Promise<number>;
  /** Set the channel's alerted attempt to `attempt` only when it is lower. Returns true when this call changed it (so of two concurrent callers exactly one wins). */
  markAlerted(projectId: string, runId: number, attempt: number, channel: 'inbox' | 'chat'): Promise<boolean>;
  getAlert(projectId: string, repoId: string, workflowId: number, branch: string): Promise<PipelineAlert | null>;
  /** Write the alert (with the updated_at it carries) only when the stored one still has `expectedUpdatedAt` (null = must not exist). */
  putAlert(a: PipelineAlert, expectedUpdatedAt: string | null): Promise<boolean>;
}

/** Order of a status within one attempt: queued < in_progress < completed (every conclusion). */
export function statusRank(s: PipelineStatus): number {
  return s === 'queued' ? 0 : s === 'in_progress' ? 1 : 2;
}

/** Whether a delivery with (attempt, status) may replace a stored row with (curAttempt, curStatus). */
export function supersedes(attempt: number, status: PipelineStatus, curAttempt: number, curStatus: PipelineStatus): boolean {
  return attempt > curAttempt || (attempt === curAttempt && statusRank(status) >= statusRank(curStatus));
}

/** Newest first: by run_number, then run_id, descending. */
export function newestFirst(a: PipelineRun, b: PipelineRun): number {
  return b.run_number - a.run_number || b.run_id - a.run_id;
}

/** The latest run of every repository + workflow + branch of the given runs. */
export function latestOfEachBranch(runs: PipelineRun[]): PipelineRun[] {
  const best = new Map<string, PipelineRun>();
  for (const r of [...runs].sort(newestFirst)) {
    const k = `${r.repo_id}\u0000${r.workflow_id}\u0000${r.branch}`;
    if (!best.has(k)) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => a.repo_full_name.localeCompare(b.repo_full_name) || a.workflow_name.localeCompare(b.workflow_name) || a.branch.localeCompare(b.branch));
}

/** The runs of one repository + workflow that pruning deletes: all but the newest `keep` and the latest of each branch. */
export function pruneVictims(runs: PipelineRun[], keep: number): PipelineRun[] {
  const sorted = [...runs].sort(newestFirst);
  const protectedIds = new Set<number>(sorted.slice(0, Math.max(0, keep)).map((r) => r.run_id));
  for (const r of latestOfEachBranch(sorted)) protectedIds.add(r.run_id);
  return sorted.filter((r) => !protectedIds.has(r.run_id));
}

let _instance: PipelineRunsRepository | null = null;

export async function initPipelineRunsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbPipelineRunsRepository } = await import('./pipeline-runs-dynamodb.ts');
    _instance = new DynamoDbPipelineRunsRepository();
  } else {
    _instance = new SqlitePipelineRunsRepository();
  }
}

export function getPipelineRunsRepository(): PipelineRunsRepository {
  if (!_instance) _instance = new SqlitePipelineRunsRepository();
  return _instance;
}

export function setPipelineRunsRepository(repo: PipelineRunsRepository): void { _instance = repo; }
export function clearPipelineRunsRepository(): void { _instance = null; }
