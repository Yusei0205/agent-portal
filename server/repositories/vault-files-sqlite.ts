/**
 * SQLite implementation of VaultFilesRepository.
 *
 * All SQL for vault_files lives here.
 * Wraps synchronous node:sqlite helpers in Promise.resolve().
 */

import { one, all, run as dbRun, insert, tx } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  VaultFilesRepository,
  VaultFileRecord,
  CreateVaultFileInput,
} from './vault-files.ts';

// ── Row converter ─────────────────────────────────────────────────────────────

function toRecord(row: Row): VaultFileRecord {
  return {
    id: String(row.id),
    project_id: row.project_id != null ? String(row.project_id) : null,
    user_id: row.user_id != null ? String(row.user_id) : null,
    name: String(row.name),
    path: String(row.path),
    size_bytes: row.size_bytes != null ? Number(row.size_bytes) : null,
    mime_type: row.mime_type != null ? String(row.mime_type) : null,
    uploaded_by: row.uploaded_by != null ? String(row.uploaded_by) : null,
    folder: row.folder != null ? String(row.folder) : null,
    source_workflow_id: row.source_workflow_id != null ? String(row.source_workflow_id) : null,
    created_at: String(row.created_at ?? ''),
  };
}

// ── Implementation ────────────────────────────────────────────────────────────

export class SqliteVaultFilesRepository implements VaultFilesRepository {
  async create(input: CreateVaultFileInput): Promise<VaultFileRecord> {
    insert('vault_files', {
      id: input.id,
      project_id: input.project_id,
      user_id: input.user_id,
      name: input.name,
      path: input.path,
      size_bytes: input.size_bytes,
      mime_type: input.mime_type,
      uploaded_by: input.uploaded_by,
      folder: input.folder,
      source_workflow_id: input.source_workflow_id,
      created_at: input.created_at,
    });
    return toRecord(one<Row>('SELECT * FROM vault_files WHERE id = ?', input.id)!);
  }

  async getById(id: string): Promise<VaultFileRecord | null> {
    const row = one<Row>('SELECT * FROM vault_files WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  async getByIdForProject(id: string, projectId: string): Promise<VaultFileRecord | null> {
    const row = one<Row>(
      'SELECT * FROM vault_files WHERE id = ? AND (project_id = ? OR project_id IS NULL)',
      id,
      projectId,
    );
    return row ? toRecord(row) : null;
  }

  async listByProject(
    projectId: string,
    userId: string,
    scope?: 'project' | 'personal' | 'portal' | null,
  ): Promise<VaultFileRecord[]> {
    let rows: Row[];
    if (scope === 'project') {
      rows = all<Row>(
        'SELECT * FROM vault_files WHERE project_id = ? AND user_id IS NULL ORDER BY created_at DESC',
        projectId,
      );
    } else if (scope === 'personal') {
      rows = all<Row>(
        'SELECT * FROM vault_files WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC',
        projectId,
        userId,
      );
    } else if (scope === 'portal') {
      rows = all<Row>(
        'SELECT * FROM vault_files WHERE project_id IS NULL ORDER BY created_at DESC',
      );
    } else {
      rows = all<Row>(
        `SELECT * FROM vault_files
          WHERE (project_id = ? AND user_id IS NULL)
             OR (project_id = ? AND user_id = ?)
             OR project_id IS NULL
          ORDER BY created_at DESC`,
        projectId, projectId, userId,
      );
    }
    return rows.map(toRecord);
  }

  async listByScope(
    scope: 'project' | 'personal' | 'portal',
    projectId: string,
    userId: string,
    folderFilter?: string | null,
  ): Promise<VaultFileRecord[]> {
    let rows: Row[];
    if (scope === 'portal') {
      if (folderFilter) {
        rows = all<Row>(
          'SELECT * FROM vault_files WHERE project_id IS NULL AND (folder = ? OR folder LIKE ?)',
          folderFilter, `${folderFilter}/%`,
        );
      } else {
        rows = all<Row>('SELECT * FROM vault_files WHERE project_id IS NULL');
      }
    } else if (scope === 'personal') {
      if (folderFilter) {
        rows = all<Row>(
          'SELECT * FROM vault_files WHERE project_id = ? AND user_id = ? AND (folder = ? OR folder LIKE ?)',
          projectId, userId, folderFilter, `${folderFilter}/%`,
        );
      } else {
        rows = all<Row>(
          'SELECT * FROM vault_files WHERE project_id = ? AND user_id = ?',
          projectId, userId,
        );
      }
    } else {
      if (folderFilter) {
        rows = all<Row>(
          'SELECT * FROM vault_files WHERE project_id = ? AND user_id IS NULL AND (folder = ? OR folder LIKE ?)',
          projectId, folderFilter, `${folderFilter}/%`,
        );
      } else {
        rows = all<Row>(
          'SELECT * FROM vault_files WHERE project_id = ? AND user_id IS NULL',
          projectId,
        );
      }
    }
    return rows.map(toRecord);
  }

  async listPortal(): Promise<VaultFileRecord[]> {
    const rows = all<Row>('SELECT * FROM vault_files WHERE project_id IS NULL ORDER BY created_at DESC');
    return rows.map(toRecord);
  }

  async delete(id: string): Promise<void> {
    dbRun('DELETE FROM vault_files WHERE id = ?', id);
  }

  async updateSizeAndMime(id: string, sizeBytes: number, mimeType: string): Promise<void> {
    dbRun('UPDATE vault_files SET size_bytes = ?, mime_type = ? WHERE id = ?', sizeBytes, mimeType, id);
  }

  async updateFolder(id: string, folder: string | null): Promise<void> {
    dbRun('UPDATE vault_files SET folder = ? WHERE id = ?', folder, id);
  }

  async bulkDelete(ids: string[]): Promise<void> {
    tx(() => {
      for (const id of ids) {
        dbRun('DELETE FROM vault_files WHERE id = ?', id);
      }
    });
  }

  async bulkUpdateFolder(ids: string[], folder: string | null): Promise<void> {
    tx(() => {
      for (const id of ids) {
        dbRun('UPDATE vault_files SET folder = ? WHERE id = ?', folder, id);
      }
    });
  }

  async findByWorkflowFolderName(
    projectId: string,
    folder: string,
    name: string,
    workflowId: string,
  ): Promise<VaultFileRecord | null> {
    const row = one<Row>(
      `SELECT id, path FROM vault_files
        WHERE project_id = ? AND folder = ? AND name = ? AND source_workflow_id = ?`,
      projectId, folder, name, workflowId,
    );
    return row ? toRecord(row) : null;
  }

  async validateProjectFiles(fileIds: string[], projectId: string): Promise<string | null> {
    for (const id of fileIds) {
      const row = one<Row>(
        'SELECT id FROM vault_files WHERE id = ? AND project_id = ? AND user_id IS NULL',
        id, projectId,
      );
      if (!row) return id;
    }
    return null;
  }

  async getByIds(ids: string[]): Promise<VaultFileRecord[]> {
    const results: VaultFileRecord[] = [];
    for (const id of ids) {
      const row = one<Row>('SELECT * FROM vault_files WHERE id = ?', id);
      if (row) results.push(toRecord(row));
    }
    return results;
  }
}
