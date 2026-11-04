/**
 * SQLite implementation of GitReposRepository.
 * All SQL for the `repositories` table lives here.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type { GitReposRepository, GitRepoRecord, CreateGitRepoInput } from './git-repos.ts';

function toRecord(row: Row): GitRepoRecord {
  return {
    id: String(row.id),
    project_id: String(row.project_id ?? ''),
    name: String(row.name ?? ''),
    url: String(row.url ?? ''),
    provider: String(row.provider ?? ''),
    status: String(row.status ?? ''),
    default_branch: row.default_branch != null ? String(row.default_branch) : null,
    identity: row.identity != null ? String(row.identity) : null,
    last_synced_at: row.last_synced_at != null ? String(row.last_synced_at) : null,
    last_error: row.last_error != null ? String(row.last_error) : null,
    created_at: String(row.created_at ?? ''),
    connection_id: row.connection_id != null ? String(row.connection_id) : null,
  };
}

export class SqliteGitReposRepository implements GitReposRepository {
  async create(input: CreateGitRepoInput): Promise<GitRepoRecord> {
    insert('repositories', {
      id: input.id, project_id: input.project_id, name: input.name, url: input.url,
      provider: input.provider, status: input.status, default_branch: input.default_branch,
      identity: input.identity, last_synced_at: input.last_synced_at, last_error: input.last_error,
      created_at: input.created_at, connection_id: input.connection_id,
    });
    return toRecord(one<Row>('SELECT * FROM repositories WHERE id = ?', input.id)!);
  }

  async getById(id: string): Promise<GitRepoRecord | null> {
    const row = one<Row>('SELECT * FROM repositories WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async getByIdForProject(id: string, projectId: string): Promise<GitRepoRecord | null> {
    const row = one<Row>('SELECT * FROM repositories WHERE id = ? AND project_id = ?', id, projectId);
    return row ? toRecord(row) : null;
  }

  async listByProject(projectId: string): Promise<GitRepoRecord[]> {
    const rows = all<Row>('SELECT * FROM repositories WHERE project_id = ? ORDER BY created_at', projectId);
    return rows.map(toRecord);
  }

  async listUrlsByProject(projectId: string): Promise<string[]> {
    const rows = all<{ url: string }>('SELECT url FROM repositories WHERE project_id = ?', projectId);
    return rows.map((r) => r.url);
  }

  async updateStatus(
    id: string, status: string,
    extra?: { lastSyncedAt?: string | null; defaultBranch?: string | null; lastError?: string | null },
  ): Promise<void> {
    const patch: Record<string, unknown> = { status };
    if (extra?.lastSyncedAt !== undefined) patch.last_synced_at = extra.lastSyncedAt;
    if (extra?.defaultBranch !== undefined) patch.default_branch = extra.defaultBranch;
    if (extra?.lastError !== undefined) patch.last_error = extra.lastError;
    const keys = Object.keys(patch);
    dbRun(
      `UPDATE repositories SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => patch[k] as string | null),
      id,
    );
  }

  async updateDefaultBranch(id: string, branch: string): Promise<void> {
    dbRun('UPDATE repositories SET default_branch = ? WHERE id = ?', branch, id);
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const result = dbRun('DELETE FROM repositories WHERE id = ? AND project_id = ?', id, projectId) as { changes: number };
    return result.changes > 0;
  }
}
