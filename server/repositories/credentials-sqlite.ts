/**
 * SQLite implementation of CredentialsRepository.
 *
 * All SQL for engine_credentials lives here.
 */

import { one, all, run as dbRun, insert, update as dbUpdate } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  CredentialsRepository,
  CredentialRecord,
  CreateCredentialInput,
  UpdateCredentialFields,
} from './credentials.ts';

// ── Row converter ─────────────────────────────────────────────────────────────

function toRecord(row: Row): CredentialRecord {
  return {
    id: String(row.id ?? ''),
    user_id: String(row.user_id ?? ''),
    engine: String(row.engine ?? ''),
    name: String(row.name ?? ''),
    mode: String(row.mode ?? ''),
    secret_enc: row.secret_enc != null ? String(row.secret_enc) : null,
    extra_config: String(row.extra_config ?? '{}'),
    is_default: Number(row.is_default ?? 0),
    last4: String(row.last4 ?? ''),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    updated_by: row.updated_by != null ? String(row.updated_by) : null,
    updated_by_name: row.updated_by_name != null ? String(row.updated_by_name) : null,
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class SqliteCredentialsRepository implements CredentialsRepository {
  async getById(id: string): Promise<CredentialRecord | null> {
    const row = one<Row>('SELECT * FROM engine_credentials WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async getByIdAndUser(id: string, userId: string): Promise<CredentialRecord | null> {
    const row = one<Row>('SELECT * FROM engine_credentials WHERE id = ? AND user_id = ?', id, userId);
    return row ? toRecord(row) : null;
  }

  async getDefaultByUserAndEngine(userId: string, engine: string): Promise<CredentialRecord | null> {
    const row = one<Row>(
      'SELECT * FROM engine_credentials WHERE user_id = ? AND engine = ? AND is_default = 1',
      userId,
      engine,
    );
    return row ? toRecord(row) : null;
  }

  async listByUser(userId: string): Promise<CredentialRecord[]> {
    const rows = all<Row>(
      `SELECT ec.*, u.name AS updated_by_name
       FROM engine_credentials ec
       LEFT JOIN users u ON u.id = ec.updated_by
       WHERE ec.user_id = ?
       ORDER BY ec.engine, ec.is_default DESC, ec.created_at ASC`,
      userId,
    );
    return rows.map(toRecord);
  }

  async create(input: CreateCredentialInput): Promise<CredentialRecord> {
    insert('engine_credentials', {
      id: input.id,
      user_id: input.user_id,
      engine: input.engine,
      name: input.name,
      mode: input.mode,
      secret_enc: input.secret_enc,
      extra_config: input.extra_config,
      is_default: input.is_default,
      last4: input.last4,
      created_at: input.created_at,
      updated_at: input.updated_at,
      updated_by: input.updated_by,
    });
    const row = one<Row>('SELECT * FROM engine_credentials WHERE id = ?', input.id)!;
    return toRecord(row);
  }

  async update(id: string, fields: UpdateCredentialFields): Promise<CredentialRecord | null> {
    const patch: Record<string, string | number | null> = {};
    if (fields.name !== undefined) patch.name = fields.name;
    if (fields.secret_enc !== undefined) patch.secret_enc = fields.secret_enc;
    if (fields.extra_config !== undefined) patch.extra_config = fields.extra_config;
    if (fields.is_default !== undefined) patch.is_default = fields.is_default;
    if (fields.last4 !== undefined) patch.last4 = fields.last4;
    if (fields.updated_at !== undefined) patch.updated_at = fields.updated_at;
    if (fields.updated_by !== undefined) patch.updated_by = fields.updated_by;
    if (Object.keys(patch).length > 0) {
      dbUpdate('engine_credentials', id, patch);
    }
    const row = one<Row>('SELECT * FROM engine_credentials WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async updateToken(
    id: string,
    secretEnc: string,
    extraConfig: string,
    last4: string,
    updatedAt: string,
  ): Promise<void> {
    dbRun(
      'UPDATE engine_credentials SET secret_enc = ?, extra_config = ?, last4 = ?, updated_at = ? WHERE id = ?',
      secretEnc,
      extraConfig,
      last4,
      updatedAt,
      id,
    );
  }

  async updateTokenConditional(
    id: string,
    secretEnc: string,
    extraConfig: string,
    last4: string,
    updatedAt: string,
    expectedCiphertext: string,
  ): Promise<boolean> {
    const result = dbRun(
      'UPDATE engine_credentials SET secret_enc = ?, extra_config = ?, last4 = ?, updated_at = ? WHERE id = ? AND secret_enc = ?',
      secretEnc,
      extraConfig,
      last4,
      updatedAt,
      id,
      expectedCiphertext,
    ) as { changes: number };
    return result.changes > 0;
  }

  async updateExtraConfig(id: string, extraConfig: string, updatedAt: string): Promise<void> {
    dbRun(
      'UPDATE engine_credentials SET extra_config = ?, updated_at = ? WHERE id = ?',
      extraConfig,
      updatedAt,
      id,
    );
  }

  async clearDefaults(userId: string, engine: string): Promise<void> {
    dbRun(
      'UPDATE engine_credentials SET is_default = 0 WHERE user_id = ? AND engine = ?',
      userId,
      engine,
    );
  }

  async setDefault(id: string, updatedAt: string): Promise<void> {
    dbRun(
      'UPDATE engine_credentials SET is_default = 1, updated_at = ? WHERE id = ?',
      updatedAt,
      id,
    );
  }

  async delete(id: string): Promise<void> {
    dbRun('DELETE FROM engine_credentials WHERE id = ?', id);
  }
}
