/**
 * SQLite implementation of ApiTokenRepository.
 *
 * Wraps the existing synchronous node:sqlite helpers in Promise.resolve() so
 * they satisfy the async interface.  All SQL lives here — no api_tokens SQL
 * should appear anywhere else (except the deprecated authenticateApiToken,
 * which is kept for backward-compatibility with existing tests).
 */

import { one, all, run as dbRun, insert, getDb } from '../db.ts';
import type { Row } from '../db.ts';
import type { SQLInputValue } from 'node:sqlite';
import { now } from '../util.ts';
import type {
  ApiTokenRepository,
  CreateTokenInput,
  TokenRecord,
  TokenWithUser,
  TokenWithUserMeta,
} from './api-tokens.ts';

// ── Helper: row → TokenRecord ─────────────────────────────────────────────────

function toTokenRecord(row: Row): TokenRecord {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    name: String(row.name),
    token_hash: String(row.token_hash),
    prefix: String(row.prefix),
    scope: String(row.scope ?? 'read'),
    scopes: row.scopes != null ? String(row.scopes) : null,
    project_id: row.project_id != null ? String(row.project_id) : null,
    workflow_id: row.workflow_id != null ? String(row.workflow_id) : null,
    expires_at: String(row.expires_at),
    last_used_at: row.last_used_at != null ? String(row.last_used_at) : null,
    revoked_at: row.revoked_at != null ? String(row.revoked_at) : null,
    created_at: String(row.created_at),
  };
}

function toTokenWithUser(row: Row): TokenWithUser {
  return {
    ...toTokenRecord(row),
    user_email: String(row.user_email ?? row.email ?? ''),
    user_name: String(row.user_name ?? row.name ?? ''),
    user_is_admin: Number(row.user_is_admin ?? row.is_admin ?? 0),
    user_disabled: Number(row.user_disabled ?? row.disabled ?? 0),
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class SqliteApiTokenRepository implements ApiTokenRepository {
  async create(input: CreateTokenInput): Promise<TokenRecord> {
    const record: Record<string, SQLInputValue | boolean | undefined> = {
      id: input.id,
      user_id: input.user_id,
      name: input.name,
      token_hash: input.token_hash,
      prefix: input.prefix,
      scope: input.scope,
      scopes: input.scopes,
      project_id: input.project_id,
      expires_at: input.expires_at,
      created_at: input.created_at,
    };
    if (input.workflow_id !== undefined) {
      record.workflow_id = input.workflow_id;
    }
    insert('api_tokens', record);
    const row = one<Row>('SELECT * FROM api_tokens WHERE id = ?', input.id);
    return toTokenRecord(row!);
  }

  async getByIdAndUser(id: string, userId: string): Promise<TokenRecord | null> {
    const row = one<Row>(
      'SELECT * FROM api_tokens WHERE id = ? AND user_id = ?',
      id,
      userId,
    );
    return row ? toTokenRecord(row) : null;
  }

  async getByHash(hash: string): Promise<TokenWithUser | null> {
    const row = one<Row>(
      `SELECT t.id, t.user_id, t.name, t.token_hash, t.prefix, t.scope, t.scopes,
              t.project_id, t.workflow_id, t.expires_at, t.last_used_at, t.revoked_at, t.created_at,
              u.email AS user_email, u.name AS user_name, u.is_admin AS user_is_admin,
              u.disabled AS user_disabled
         FROM api_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?`,
      hash,
    );
    return row ? toTokenWithUser(row) : null;
  }

  async listByUser(userId: string): Promise<TokenRecord[]> {
    const rows = all<Row>(
      `SELECT id, user_id, name, token_hash, prefix, scope, scopes, project_id,
              workflow_id, created_at, expires_at, last_used_at, revoked_at
         FROM api_tokens
        WHERE user_id = ?
          AND (scopes IS NULL OR scopes NOT LIKE '%"delegate"%')
        ORDER BY created_at DESC
        LIMIT 50`,
      userId,
    );
    return rows.map(toTokenRecord);
  }

  async listAll(): Promise<TokenWithUserMeta[]> {
    const rows = all<Row>(
      `SELECT t.id, t.user_id, t.name, t.token_hash, t.prefix, t.scope, t.scopes,
              t.project_id, t.workflow_id, t.created_at, t.expires_at, t.last_used_at, t.revoked_at,
              u.name AS user_name, u.email AS user_email
         FROM api_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE (t.scopes IS NULL OR t.scopes NOT LIKE '%"delegate"%')
        ORDER BY t.created_at DESC
        LIMIT 200`,
    );
    return rows.map((row) => ({
      ...toTokenRecord(row),
      user_name: String(row.user_name ?? ''),
      user_email: String(row.user_email ?? ''),
    }));
  }

  async countActive(userId: string): Promise<number> {
    const row = one<Row>(
      'SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at >= ?',
      userId,
      now(),
    );
    return Number(row?.n ?? 0);
  }

  async updateLastUsed(id: string, _userId: string, ts: string): Promise<void> {
    dbRun('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', ts, id);
  }

  async revoke(id: string, _userId: string, ts: string): Promise<void> {
    dbRun('UPDATE api_tokens SET revoked_at = ? WHERE id = ?', ts, id);
  }

  /**
   * Synchronous get by hash — used only by the deprecated authenticateApiToken()
   * function which must remain synchronous for backward compatibility.
   * Not part of the ApiTokenRepository interface.
   */
  getByHashSync(hash: string): TokenWithUser | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT t.id, t.user_id, t.name, t.token_hash, t.prefix, t.scope, t.scopes,
              t.project_id, t.workflow_id, t.expires_at, t.last_used_at, t.revoked_at, t.created_at,
              u.email AS user_email, u.name AS user_name, u.is_admin AS user_is_admin,
              u.disabled AS user_disabled
         FROM api_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?`,
    ).get(hash) as Row | undefined;
    return row ? toTokenWithUser(row) : null;
  }

  /**
   * Synchronous last_used_at update — used only by authenticateApiToken().
   * Not part of the ApiTokenRepository interface.
   */
  updateLastUsedSync(id: string, ts: string): void {
    dbRun('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', ts, id);
  }
}
