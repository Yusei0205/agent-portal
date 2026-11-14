/**
 * SQLite implementation of IntegrationsRepository.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  IntegrationsRepository,
  IntegrationRecord,
  CreateIntegrationInput,
  UpdateIntegrationFields,
} from './integrations.ts';

function toRecord(row: Row): IntegrationRecord {
  return {
    id: String(row.id ?? ''),
    project_id: row.project_id != null ? String(row.project_id) : null,
    name: String(row.name ?? ''),
    type: String(row.type ?? ''),
    config_enc: row.config_enc != null ? String(row.config_enc) : null,
    enabled: Number(row.enabled ?? 1),
    created_by: row.created_by != null ? String(row.created_by) : null,
    created_at: String(row.created_at ?? ''),
  };
}

export class SqliteIntegrationsRepository implements IntegrationsRepository {
  async getById(id: string): Promise<IntegrationRecord | null> {
    const row = one<Row>('SELECT * FROM mcp_integrations WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async getByIdAndProject(id: string, projectId: string): Promise<IntegrationRecord | null> {
    const row = one<Row>(
      'SELECT * FROM mcp_integrations WHERE id = ? AND project_id = ?',
      id,
      projectId,
    );
    return row ? toRecord(row) : null;
  }

  async listByProject(projectId: string): Promise<IntegrationRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM mcp_integrations WHERE project_id = ? ORDER BY created_at',
      projectId,
    );
    return rows.map(toRecord);
  }

  async create(input: CreateIntegrationInput): Promise<IntegrationRecord> {
    insert('mcp_integrations', {
      id: input.id,
      project_id: input.project_id,
      name: input.name,
      type: input.type,
      config_enc: input.config_enc,
      enabled: input.enabled,
      created_by: input.created_by,
      created_at: input.created_at,
    });
    const row = one<Row>('SELECT * FROM mcp_integrations WHERE id = ?', input.id)!;
    return toRecord(row);
  }

  async update(
    id: string,
    projectId: string,
    fields: UpdateIntegrationFields,
  ): Promise<IntegrationRecord | null> {
    const keys = Object.keys(fields) as Array<keyof UpdateIntegrationFields>;
    if (keys.length === 0) return this.getByIdAndProject(id, projectId);
    const setClauses = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => fields[k] ?? null);
    dbRun(
      `UPDATE mcp_integrations SET ${setClauses} WHERE id = ? AND project_id = ?`,
      ...vals,
      id,
      projectId,
    );
    const row = one<Row>('SELECT * FROM mcp_integrations WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const result = dbRun(
      'DELETE FROM mcp_integrations WHERE id = ? AND project_id = ?',
      id,
      projectId,
    ) as { changes: number };
    return result.changes > 0;
  }
}
