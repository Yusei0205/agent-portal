/**
 * SQLite implementation of DocTemplateRepository.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  DocTemplateRepository,
  DocTemplateRecord,
  CreateDocTemplateInput,
} from './doc-templates-data.ts';

function toRecord(row: Row): DocTemplateRecord {
  return {
    id:          String(row.id),
    project_id:  row.project_id != null ? String(row.project_id) : null,
    name:        String(row.name ?? ''),
    type:        String(row.type ?? ''),
    path:        String(row.path ?? ''),
    is_default:  Number(row.is_default ?? 0),
    uploaded_by: row.uploaded_by != null ? String(row.uploaded_by) : null,
    created_at:  String(row.created_at ?? ''),
  };
}

export class SqliteDocTemplateRepository implements DocTemplateRepository {
  async create(input: CreateDocTemplateInput): Promise<DocTemplateRecord> {
    insert('doc_templates', {
      id:          input.id,
      project_id:  input.project_id,
      name:        input.name,
      type:        input.type,
      path:        input.path,
      is_default:  input.is_default,
      uploaded_by: input.uploaded_by,
      created_at:  input.created_at,
    });
    return toRecord(one<Row>('SELECT * FROM doc_templates WHERE id = ?', input.id)!);
  }

  async getById(id: string): Promise<DocTemplateRecord | null> {
    const row = one<Row>('SELECT * FROM doc_templates WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async listByProject(projectId: string): Promise<DocTemplateRecord[]> {
    const rows = all<Row>('SELECT * FROM doc_templates WHERE project_id = ? ORDER BY type, created_at', projectId);
    return rows.map(toRecord);
  }

  async listPortal(): Promise<DocTemplateRecord[]> {
    const rows = all<Row>('SELECT * FROM doc_templates WHERE project_id IS NULL ORDER BY type, created_at');
    return rows.map(toRecord);
  }

  async setDefault(id: string, projectId: string | null, type: string): Promise<void> {
    if (projectId) {
      dbRun('UPDATE doc_templates SET is_default = 0 WHERE project_id = ? AND type = ? AND id != ?', projectId, type, id);
    } else {
      dbRun('UPDATE doc_templates SET is_default = 0 WHERE project_id IS NULL AND type = ? AND id != ?', type, id);
    }
    dbRun('UPDATE doc_templates SET is_default = 1 WHERE id = ?', id);
  }

  async delete(id: string): Promise<void> {
    dbRun('DELETE FROM doc_templates WHERE id = ?', id);
  }
}
