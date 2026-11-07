/**
 * SQLite implementation of AwsAccountsRepository.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  AwsAccountsRepository,
  AwsAccountRecord,
  CreateAwsAccountInput,
  UpdateAwsAccountFields,
} from './aws-accounts.ts';

function toRecord(row: Row): AwsAccountRecord {
  return {
    id: String(row.id ?? ''),
    project_id: row.project_id != null ? String(row.project_id) : null,
    name: String(row.name ?? ''),
    auth_method: String(row.auth_method ?? ''),
    region: row.region != null ? String(row.region) : null,
    credentials_enc: row.credentials_enc != null ? String(row.credentials_enc) : null,
    profile_name: row.profile_name != null ? String(row.profile_name) : null,
    created_by: row.created_by != null ? String(row.created_by) : null,
    created_at: String(row.created_at ?? ''),
  };
}

export class SqliteAwsAccountsRepository implements AwsAccountsRepository {
  async getById(id: string): Promise<AwsAccountRecord | null> {
    const row = one<Row>('SELECT * FROM aws_accounts WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async getByIdAndProject(id: string, projectId: string): Promise<AwsAccountRecord | null> {
    const row = one<Row>('SELECT * FROM aws_accounts WHERE id = ? AND project_id = ?', id, projectId);
    return row ? toRecord(row) : null;
  }

  async listByProject(projectId: string): Promise<AwsAccountRecord[]> {
    const rows = all<Row>('SELECT * FROM aws_accounts WHERE project_id = ? ORDER BY created_at', projectId);
    return rows.map(toRecord);
  }

  async create(input: CreateAwsAccountInput): Promise<AwsAccountRecord> {
    insert('aws_accounts', {
      id: input.id,
      project_id: input.project_id,
      name: input.name,
      auth_method: input.auth_method,
      region: input.region,
      credentials_enc: input.credentials_enc,
      profile_name: input.profile_name,
      created_by: input.created_by,
      created_at: input.created_at,
    });
    const row = one<Row>('SELECT * FROM aws_accounts WHERE id = ?', input.id)!;
    return toRecord(row);
  }

  async update(
    id: string,
    projectId: string,
    fields: UpdateAwsAccountFields,
  ): Promise<AwsAccountRecord | null> {
    const keys = Object.keys(fields) as Array<keyof UpdateAwsAccountFields>;
    if (keys.length === 0) return this.getByIdAndProject(id, projectId);
    const setClauses = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => fields[k] ?? null);
    dbRun(
      `UPDATE aws_accounts SET ${setClauses} WHERE id = ? AND project_id = ?`,
      ...vals,
      id,
      projectId,
    );
    const row = one<Row>('SELECT * FROM aws_accounts WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const result = dbRun(
      'DELETE FROM aws_accounts WHERE id = ? AND project_id = ?',
      id,
      projectId,
    ) as { changes: number };
    return result.changes > 0;
  }
}
