/**
 * SQLite implementation of InboxRepository.
 *
 * Wraps synchronous node:sqlite helpers in Promise.resolve().
 * All SQL for p6_inbox lives here.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  InboxRepository,
  InboxRecord,
  CreateInboxInput,
} from './inbox.ts';

// ── Row converter ─────────────────────────────────────────────────────────────

function toRecord(row: Row): InboxRecord {
  return {
    id: String(row.id),
    project_id: row.project_id != null ? String(row.project_id) : null,
    workflow_id: row.workflow_id != null ? String(row.workflow_id) : null,
    run_id: row.run_id != null ? String(row.run_id) : null,
    type: String(row.type ?? '') as InboxRecord['type'],
    payload: String(row.payload ?? '{}'),
    resolved: Number(row.resolved ?? 0),
    resolved_by: row.resolved_by != null ? String(row.resolved_by) : null,
    resolved_at: row.resolved_at != null ? String(row.resolved_at) : null,
    created_at: String(row.created_at ?? ''),
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class SqliteInboxRepository implements InboxRepository {
  async create(input: CreateInboxInput): Promise<InboxRecord> {
    insert('p6_inbox', {
      id: input.id,
      project_id: input.project_id,
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      type: input.type,
      payload: input.payload,
      resolved: 0,
      resolved_by: null,
      resolved_at: null,
      created_at: input.created_at,
    });
    const row = one<Row>('SELECT * FROM p6_inbox WHERE id = ?', input.id)!;
    return toRecord(row);
  }

  async getById(id: string): Promise<InboxRecord | null> {
    const row = one<Row>('SELECT * FROM p6_inbox WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async listUnresolvedByProjects(
    projectIds: string[],
    opts: { limit: number; offset?: number },
  ): Promise<{ items: InboxRecord[]; total: number }> {
    if (projectIds.length === 0) return { items: [], total: 0 };
    const placeholders = projectIds.map(() => '?').join(', ');
    const limit = opts.limit;
    const offset = opts.offset ?? 0;
    const rows = all<Row>(
      `SELECT * FROM p6_inbox WHERE project_id IN (${placeholders}) AND resolved = 0
        ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...projectIds,
      limit,
      offset,
    );
    const countRow = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM p6_inbox WHERE project_id IN (${placeholders}) AND resolved = 0`,
      ...projectIds,
    );
    return { items: rows.map(toRecord), total: Number(countRow?.n ?? 0) };
  }

  async listAllUnresolved(opts: { limit: number; offset?: number }): Promise<{ items: InboxRecord[]; total: number }> {
    const limit = opts.limit;
    const offset = opts.offset ?? 0;
    const rows = all<Row>(
      'SELECT * FROM p6_inbox WHERE resolved = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?',
      limit,
      offset,
    );
    const countRow = one<{ n: number }>('SELECT COUNT(*) AS n FROM p6_inbox WHERE resolved = 0');
    return { items: rows.map(toRecord), total: Number(countRow?.n ?? 0) };
  }

  async countUnresolvedByProjects(projectIds: string[]): Promise<number> {
    if (projectIds.length === 0) return 0;
    const placeholders = projectIds.map(() => '?').join(', ');
    const row = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM p6_inbox WHERE project_id IN (${placeholders}) AND resolved = 0`,
      ...projectIds,
    );
    return Number(row?.n ?? 0);
  }

  async countAllUnresolved(): Promise<number> {
    const row = one<{ n: number }>('SELECT COUNT(*) AS n FROM p6_inbox WHERE resolved = 0');
    return Number(row?.n ?? 0);
  }

  async resolveConditional(id: string, userId: string, resolvedAt: string): Promise<boolean> {
    const result = dbRun(
      'UPDATE p6_inbox SET resolved = 1, resolved_by = ?, resolved_at = ? WHERE id = ? AND resolved = 0',
      userId,
      resolvedAt,
      id,
    ) as { changes: number };
    return result.changes > 0;
  }
}
