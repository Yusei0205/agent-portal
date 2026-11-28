/**
 * SQLite implementation of GitConnectionsRepository.
 * All SQL for git_connections_v2 lives here.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type { GitConnectionsRepository, GitConnectionRecord, CreateGitConnectionInput } from './git-connections.ts';

function toRecord(row: Row): GitConnectionRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    provider: String(row.provider ?? ''),
    credentials_enc: row.credentials_enc != null ? String(row.credentials_enc) : null,
    scope: String(row.scope ?? 'personal'),
    owner_id: row.owner_id != null ? String(row.owner_id) : null,
    created_at: String(row.created_at ?? ''),
  };
}

export class SqliteGitConnectionsRepository implements GitConnectionsRepository {
  async create(input: CreateGitConnectionInput): Promise<GitConnectionRecord> {
    insert('git_connections_v2', {
      id: input.id,
      name: input.name,
      provider: input.provider,
      credentials_enc: input.credentials_enc,
      scope: input.scope,
      owner_id: input.owner_id,
      created_at: input.created_at,
    });
    return toRecord(one<Row>('SELECT * FROM git_connections_v2 WHERE id = ?', input.id)!);
  }

  async getById(id: string): Promise<GitConnectionRecord | null> {
    const row = one<Row>('SELECT * FROM git_connections_v2 WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async listByUserOrShared(userId: string): Promise<GitConnectionRecord[]> {
    const rows = all<Row>(
      `SELECT * FROM git_connections_v2 WHERE owner_id = ? OR scope = 'shared' ORDER BY created_at`,
      userId,
    );
    return rows.map(toRecord);
  }

  async listByProviderForUser(provider: string, userId: string): Promise<GitConnectionRecord[]> {
    const rows = all<Row>(
      `SELECT * FROM git_connections_v2 WHERE provider = ? AND (owner_id = ? OR scope = 'shared') ORDER BY created_at`,
      provider,
      userId,
    );
    return rows.map(toRecord);
  }

  async update(id: string, patch: Partial<GitConnectionRecord>): Promise<GitConnectionRecord | null> {
    const conn = one<Row>('SELECT * FROM git_connections_v2 WHERE id = ?', id);
    if (!conn) return null;
    const keys = Object.keys(patch).filter((k) => !['id', 'created_at'].includes(k));
    if (keys.length === 0) return toRecord(conn);
    dbRun(
      `UPDATE git_connections_v2 SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => (patch as Record<string, unknown>)[k] as string | null),
      id,
    );
    return toRecord(one<Row>('SELECT * FROM git_connections_v2 WHERE id = ?', id)!);
  }

  async delete(id: string): Promise<boolean> {
    const result = dbRun('DELETE FROM git_connections_v2 WHERE id = ?', id) as { changes: number };
    return result.changes > 0;
  }
}
