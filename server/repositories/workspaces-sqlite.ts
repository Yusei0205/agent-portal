/**
 * SQLite implementation of WorkspacesRepository.
 * All SQL for workspaces_v2 lives here.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type { WorkspacesRepository, WorkspaceRecord, CreateWorkspaceInput } from './workspaces.ts';

function toRecord(row: Row): WorkspaceRecord {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    name: String(row.name),
    repo_ids: String(row.repo_ids ?? '[]'),
    created_at: String(row.created_at ?? ''),
    default_engine: String(row.default_engine ?? ''),
    default_agent: String(row.default_agent ?? ''),
    default_model: String(row.default_model ?? ''),
  };
}

export class SqliteWorkspacesRepository implements WorkspacesRepository {
  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    insert('workspaces_v2', {
      id: input.id,
      project_id: input.project_id,
      name: input.name,
      repo_ids: input.repo_ids,
      default_engine: input.default_engine,
      default_agent: input.default_agent,
      default_model: input.default_model,
      created_at: input.created_at,
    });
    return toRecord(one<Row>('SELECT * FROM workspaces_v2 WHERE id = ?', input.id)!);
  }

  async getById(id: string): Promise<WorkspaceRecord | null> {
    const row = one<Row>('SELECT * FROM workspaces_v2 WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async getByIdForProject(id: string, projectId: string): Promise<WorkspaceRecord | null> {
    const row = one<Row>('SELECT * FROM workspaces_v2 WHERE id = ? AND project_id = ?', id, projectId);
    return row ? toRecord(row) : null;
  }

  async listByProject(projectId: string): Promise<WorkspaceRecord[]> {
    const rows = all<Row>('SELECT * FROM workspaces_v2 WHERE project_id = ? ORDER BY created_at', projectId);
    return rows.map(toRecord);
  }

  async update(id: string, projectId: string, patch: Partial<WorkspaceRecord>): Promise<WorkspaceRecord | null> {
    const ws = one<Row>('SELECT * FROM workspaces_v2 WHERE id = ? AND project_id = ?', id, projectId);
    if (!ws) return null;
    const keys = Object.keys(patch).filter((k) => k !== 'id' && k !== 'project_id' && k !== 'created_at');
    if (keys.length === 0) return toRecord(ws);
    dbRun(
      `UPDATE workspaces_v2 SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => (patch as Record<string, unknown>)[k] as string),
      id,
    );
    return toRecord(one<Row>('SELECT * FROM workspaces_v2 WHERE id = ?', id)!);
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const result = dbRun('DELETE FROM workspaces_v2 WHERE id = ? AND project_id = ?', id, projectId) as { changes: number };
    return result.changes > 0;
  }
}
