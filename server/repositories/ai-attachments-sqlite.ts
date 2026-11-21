/**
 * SQLite implementation of AiAttachmentRepository.
 * All SQL for ai_attachments lives here.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  AiAttachmentRepository,
  AiAttachmentRecord,
  CreateAiAttachmentInput,
  AttachmentParentKind,
} from './ai-attachments.ts';

function toRecord(row: Row): AiAttachmentRecord {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    filename: String(row.filename),
    original_name: String(row.original_name ?? row.filename),
    mime_type: String(row.mime_type),
    size: Number(row.size ?? 0),
    kind: String(row.kind) as AiAttachmentRecord['kind'],
    file_path: String(row.file_path ?? ''),
    parent_kind: row.parent_kind != null ? String(row.parent_kind) as AttachmentParentKind : null,
    parent_id: row.parent_id != null ? String(row.parent_id) : null,
    uploaded_by: row.uploaded_by != null ? String(row.uploaded_by) : null,
    created_at: String(row.created_at ?? ''),
  };
}

export class SqliteAiAttachmentRepository implements AiAttachmentRepository {
  async create(input: CreateAiAttachmentInput): Promise<AiAttachmentRecord> {
    insert('ai_attachments', {
      id: input.id,
      project_id: input.project_id,
      filename: input.filename,
      original_name: input.original_name,
      mime_type: input.mime_type,
      size: input.size,
      kind: input.kind,
      file_path: input.file_path,
      parent_kind: input.parent_kind,
      parent_id: input.parent_id,
      uploaded_by: input.uploaded_by,
      created_at: input.created_at,
    });
    return toRecord(one<Row>('SELECT * FROM ai_attachments WHERE id = ?', input.id)!);
  }

  async getById(id: string): Promise<AiAttachmentRecord | null> {
    const row = one<Row>('SELECT * FROM ai_attachments WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async getByIdForProject(id: string, projectId: string): Promise<AiAttachmentRecord | null> {
    const row = one<Row>('SELECT * FROM ai_attachments WHERE id = ? AND project_id = ?', id, projectId);
    return row ? toRecord(row) : null;
  }

  async getByIds(ids: string[]): Promise<AiAttachmentRecord[]> {
    const results: AiAttachmentRecord[] = [];
    for (const id of ids) {
      const row = one<Row>('SELECT * FROM ai_attachments WHERE id = ?', id);
      if (row) results.push(toRecord(row));
    }
    return results;
  }

  async listByProject(projectId: string): Promise<AiAttachmentRecord[]> {
    const rows = all<Row>('SELECT * FROM ai_attachments WHERE project_id = ? ORDER BY created_at DESC', projectId);
    return rows.map(toRecord);
  }

  async listByParent(parentKind: AttachmentParentKind, parentId: string): Promise<AiAttachmentRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM ai_attachments WHERE parent_kind = ? AND parent_id = ?',
      parentKind, parentId,
    );
    return rows.map(toRecord);
  }

  async listOrphanedBefore(cutoff: string): Promise<AiAttachmentRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM ai_attachments WHERE parent_id IS NULL AND created_at < ?',
      cutoff,
    );
    return rows.map(toRecord);
  }

  async linkToParent(ids: string[], parentKind: AttachmentParentKind, parentId: string): Promise<void> {
    for (const id of ids) {
      dbRun(
        'UPDATE ai_attachments SET parent_kind = ?, parent_id = ? WHERE id = ?',
        parentKind, parentId, id,
      );
    }
  }

  async deleteByParent(parentKind: AttachmentParentKind, parentId: string): Promise<void> {
    dbRun('DELETE FROM ai_attachments WHERE parent_kind = ? AND parent_id = ?', parentKind, parentId);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) {
      dbRun('DELETE FROM ai_attachments WHERE id = ?', id);
    }
  }

  async deleteOrphanedBefore(cutoff: string): Promise<void> {
    dbRun('DELETE FROM ai_attachments WHERE parent_id IS NULL AND created_at < ?', cutoff);
  }
}
