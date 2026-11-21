/**
 * SQLite implementation of FeedbackRepository.
 */

import { one, all, run as dbRun } from '../db.ts';
import type { Row } from '../db.ts';
import type { FeedbackPatch, FeedbackRecord, FeedbackRepository } from './feedback.ts';

const COLUMNS = [
  'id', 'user_id', 'user_name', 'kind', 'title', 'body', 'page', 'status', 'admin_note', 'project_id', 'workflow_id',
  'repo_id', 'branch', 'pr_url', 'pr_number', 'decision_note', 'decided_by_name', 'decided_at', 'created_at', 'updated_at',
] as const;

const str = (v: unknown): string | null => (v == null ? null : String(v));

function toRecord(row: Row): FeedbackRecord {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    user_name: str(row.user_name),
    kind: String(row.kind) as FeedbackRecord['kind'],
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    page: str(row.page),
    status: String(row.status) as FeedbackRecord['status'],
    admin_note: str(row.admin_note),
    project_id: str(row.project_id),
    workflow_id: str(row.workflow_id),
    repo_id: str(row.repo_id),
    branch: str(row.branch),
    pr_url: str(row.pr_url),
    pr_number: row.pr_number == null ? null : Number(row.pr_number),
    decision_note: str(row.decision_note),
    decided_by_name: str(row.decided_by_name),
    decided_at: str(row.decided_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export class SqliteFeedbackRepository implements FeedbackRepository {
  async create(rec: FeedbackRecord): Promise<void> {
    dbRun(
      `INSERT INTO feedback (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
      ...COLUMNS.map((c) => rec[c] as string | number | null),
    );
  }

  async getById(id: string): Promise<FeedbackRecord | null> {
    const row = one<Row>('SELECT * FROM feedback WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async listAll(): Promise<FeedbackRecord[]> {
    return all<Row>('SELECT * FROM feedback ORDER BY updated_at DESC LIMIT 500').map(toRecord);
  }

  async listByUser(userId: string): Promise<FeedbackRecord[]> {
    return all<Row>('SELECT * FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', userId).map(toRecord);
  }

  async update(id: string, patch: FeedbackPatch): Promise<FeedbackRecord | null> {
    const keys = Object.keys(patch).filter((k) => (COLUMNS as readonly string[]).includes(k) && k !== 'id');
    if (keys.length) {
      dbRun(
        `UPDATE feedback SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
        ...keys.map((k) => (patch as Record<string, string | number | null>)[k] ?? null),
        id,
      );
    }
    return this.getById(id);
  }
}
