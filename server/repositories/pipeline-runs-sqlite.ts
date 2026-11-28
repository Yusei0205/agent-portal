/**
 * SQLite implementation of PipelineRunsRepository. All SQL for pipeline_runs and pipeline_alerts lives here.
 */

import { one, all, run as dbRun } from '../db.ts';
import type { Row } from '../db.ts';
import { now } from '../util.ts';
import type { PipelineAlert, PipelineRun, PipelineRunsRepository, PipelineStatus, UpsertRunInput } from './pipeline-runs.ts';

const str = (v: unknown): string | null => (v != null ? String(v) : null);

/** The same rank as statusRank() in pipeline-runs.ts, as SQL. */
const RANK = (col: string) => `CASE ${col} WHEN 'queued' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END`;

function toRun(row: Row): PipelineRun {
  return {
    project_id: String(row.project_id),
    repo_id: String(row.repo_id),
    repo_full_name: String(row.repo_full_name ?? ''),
    run_id: Number(row.run_id),
    run_attempt: Number(row.run_attempt),
    run_number: Number(row.run_number),
    workflow_id: Number(row.workflow_id),
    workflow_name: String(row.workflow_name ?? ''),
    branch: String(row.branch ?? ''),
    head_sha: String(row.head_sha ?? ''),
    actor: String(row.actor ?? ''),
    event: String(row.event ?? ''),
    status: String(row.status) as PipelineStatus,
    html_url: String(row.html_url ?? ''),
    started_at: str(row.started_at),
    completed_at: str(row.completed_at),
    inbox_alerted_attempt: Number(row.inbox_alerted_attempt ?? 0),
    chat_alerted_attempt: Number(row.chat_alerted_attempt ?? 0),
    updated_at: String(row.updated_at ?? ''),
  };
}

function toAlert(row: Row): PipelineAlert {
  return {
    project_id: String(row.project_id),
    repo_id: String(row.repo_id),
    workflow_id: Number(row.workflow_id),
    branch: String(row.branch ?? ''),
    open: Number(row.open) === 1,
    inbox_id: str(row.inbox_id),
    last_run_id: Number(row.last_run_id),
    last_run_number: Number(row.last_run_number),
    failures: Number(row.failures),
    updated_at: String(row.updated_at ?? ''),
  };
}

export class SqlitePipelineRunsRepository implements PipelineRunsRepository {
  async upsertRun(r: UpsertRunInput): Promise<{ run: PipelineRun; created: boolean }> {
    const ts = now();
    const res = dbRun(
      `INSERT INTO pipeline_runs (project_id, run_id, repo_id, repo_full_name, run_attempt, run_number, workflow_id, workflow_name,
         branch, head_sha, actor, event, status, html_url, started_at, completed_at, inbox_alerted_attempt, chat_alerted_attempt, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
       ON CONFLICT(project_id, run_id) DO NOTHING`,
      r.project_id, r.run_id, r.repo_id, r.repo_full_name, r.run_attempt, r.run_number, r.workflow_id, r.workflow_name,
      r.branch, r.head_sha, r.actor, r.event, r.status, r.html_url, r.started_at, r.completed_at, ts,
    ) as { changes: number };
    const created = res.changes > 0;
    if (!created) {
      // One statement: the newer (attempt, status rank) wins, so two racing deliveries cannot leave the older one stored.
      dbRun(
        `UPDATE pipeline_runs SET repo_id = ?, repo_full_name = ?, run_attempt = ?, run_number = ?, workflow_id = ?, workflow_name = ?,
           branch = ?, head_sha = ?, actor = ?, event = ?, status = ?, html_url = ?, started_at = ?, completed_at = ?, updated_at = ?
         WHERE project_id = ? AND run_id = ?
           AND (? > run_attempt OR (? = run_attempt AND ${RANK('?')} >= ${RANK('status')}))`,
        r.repo_id, r.repo_full_name, r.run_attempt, r.run_number, r.workflow_id, r.workflow_name,
        r.branch, r.head_sha, r.actor, r.event, r.status, r.html_url, r.started_at, r.completed_at, ts,
        r.project_id, r.run_id, r.run_attempt, r.run_attempt, r.status,
      );
    }
    const row = one<Row>('SELECT * FROM pipeline_runs WHERE project_id = ? AND run_id = ?', r.project_id, r.run_id)!;
    return { run: toRun(row), created };
  }

  async latestPerBranch(projectId: string): Promise<PipelineRun[]> {
    const rows = all<Row>(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY repo_id, workflow_id, branch ORDER BY run_number DESC, run_id DESC) AS rn
         FROM pipeline_runs WHERE project_id = ?
       ) WHERE rn = 1 ORDER BY repo_full_name, workflow_name, branch`,
      projectId,
    );
    return rows.map(toRun);
  }

  async history(projectId: string, repoId: string, workflowId: number, branch: string, limit: number): Promise<PipelineRun[]> {
    const rows = all<Row>(
      `SELECT * FROM pipeline_runs WHERE project_id = ? AND repo_id = ? AND workflow_id = ? AND branch = ?
       ORDER BY run_number DESC, run_id DESC LIMIT ?`,
      projectId, repoId, workflowId, branch, limit,
    );
    return rows.map(toRun);
  }

  async prune(projectId: string, repoId: string, workflowId: number, keep: number): Promise<number> {
    const res = dbRun(
      `DELETE FROM pipeline_runs WHERE project_id = ? AND repo_id = ? AND workflow_id = ?
         AND run_id NOT IN (
           SELECT run_id FROM pipeline_runs WHERE project_id = ? AND repo_id = ? AND workflow_id = ?
           ORDER BY run_number DESC, run_id DESC LIMIT ?)
         AND run_id NOT IN (
           SELECT run_id FROM (
             SELECT run_id, ROW_NUMBER() OVER (PARTITION BY branch ORDER BY run_number DESC, run_id DESC) AS rn
             FROM pipeline_runs WHERE project_id = ? AND repo_id = ? AND workflow_id = ?
           ) WHERE rn = 1)`,
      projectId, repoId, workflowId, projectId, repoId, workflowId, Math.max(0, keep), projectId, repoId, workflowId,
    ) as { changes: number };
    return Number(res.changes);
  }

  async markAlerted(projectId: string, runId: number, attempt: number, channel: 'inbox' | 'chat'): Promise<boolean> {
    const col = channel === 'inbox' ? 'inbox_alerted_attempt' : 'chat_alerted_attempt';
    const res = dbRun(`UPDATE pipeline_runs SET ${col} = ? WHERE project_id = ? AND run_id = ? AND ${col} < ?`, attempt, projectId, runId, attempt) as { changes: number };
    return res.changes > 0;
  }

  async getAlert(projectId: string, repoId: string, workflowId: number, branch: string): Promise<PipelineAlert | null> {
    const row = one<Row>('SELECT * FROM pipeline_alerts WHERE project_id = ? AND repo_id = ? AND workflow_id = ? AND branch = ?', projectId, repoId, workflowId, branch);
    return row ? toAlert(row) : null;
  }

  async putAlert(a: PipelineAlert, expectedUpdatedAt: string | null): Promise<boolean> {
    if (expectedUpdatedAt == null) {
      const res = dbRun(
        `INSERT INTO pipeline_alerts (project_id, repo_id, workflow_id, branch, open, inbox_id, last_run_id, last_run_number, failures, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, repo_id, workflow_id, branch) DO NOTHING`,
        a.project_id, a.repo_id, a.workflow_id, a.branch, a.open ? 1 : 0, a.inbox_id, a.last_run_id, a.last_run_number, a.failures, a.updated_at,
      ) as { changes: number };
      return res.changes > 0;
    }
    const res = dbRun(
      `UPDATE pipeline_alerts SET open = ?, inbox_id = ?, last_run_id = ?, last_run_number = ?, failures = ?, updated_at = ?
       WHERE project_id = ? AND repo_id = ? AND workflow_id = ? AND branch = ? AND updated_at = ?`,
      a.open ? 1 : 0, a.inbox_id, a.last_run_id, a.last_run_number, a.failures, a.updated_at,
      a.project_id, a.repo_id, a.workflow_id, a.branch, expectedUpdatedAt,
    ) as { changes: number };
    return res.changes > 0;
  }
}
