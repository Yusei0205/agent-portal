/**
 * SQLite implementation of OutputFilesRepository.
 *
 * All SQL for output_files lives here.
 * Wraps synchronous node:sqlite helpers in Promise.resolve().
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  OutputFilesRepository,
  OutputFileRecord,
  CreateOutputFileInput,
} from './output-files.ts';

// ── Row converter ─────────────────────────────────────────────────────────────

function toRecord(row: Row): OutputFileRecord {
  return {
    id: String(row.id),
    workflow_id: String(row.workflow_id),
    run_id: String(row.run_id),
    name: String(row.name),
    path: String(row.path),
    size_bytes: row.size_bytes != null ? Number(row.size_bytes) : null,
    mime_type: row.mime_type != null ? String(row.mime_type) : null,
    version: Number(row.version ?? 1),
    refused_reason: row.refused_reason != null ? String(row.refused_reason) : null,
    hash: row.hash != null ? String(row.hash) : null,
    vault_file_id: row.vault_file_id != null ? String(row.vault_file_id) : null,
    created_at: String(row.created_at ?? ''),
  };
}

// ── Implementation ────────────────────────────────────────────────────────────

export class SqliteOutputFilesRepository implements OutputFilesRepository {
  async create(input: CreateOutputFileInput): Promise<OutputFileRecord> {
    insert('output_files', {
      id: input.id,
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      name: input.name,
      path: input.path,
      size_bytes: input.size_bytes,
      mime_type: input.mime_type,
      version: input.version,
      refused_reason: input.refused_reason,
      hash: input.hash,
      vault_file_id: null,
      created_at: input.created_at,
    });
    return toRecord(one<Row>('SELECT * FROM output_files WHERE id = ?', input.id)!);
  }

  async getById(id: string, workflowId: string): Promise<OutputFileRecord | null> {
    const row = one<Row>(
      'SELECT * FROM output_files WHERE id = ? AND workflow_id = ?',
      id,
      workflowId,
    );
    return row ? toRecord(row) : null;
  }

  async getLatestByPath(workflowId: string, filePath: string): Promise<OutputFileRecord | null> {
    const row = one<Row>(
      `SELECT id, version, hash FROM output_files
        WHERE workflow_id = ? AND path = ? AND refused_reason IS NULL
        ORDER BY version DESC LIMIT 1`,
      workflowId,
      filePath,
    );
    return row ? toRecord(row) : null;
  }

  async listLatestByWorkflow(workflowId: string): Promise<OutputFileRecord[]> {
    const rows = all<Row>(
      `SELECT of1.*
         FROM output_files of1
        WHERE of1.workflow_id = ?
          AND of1.refused_reason IS NULL
          AND of1.version = (
            SELECT MAX(of2.version)
              FROM output_files of2
             WHERE of2.workflow_id = of1.workflow_id
               AND of2.path = of1.path
               AND of2.refused_reason IS NULL
          )
        ORDER BY of1.created_at DESC`,
      workflowId,
    );
    return rows.map(toRecord);
  }

  async updateVaultFileId(id: string, vaultFileId: string): Promise<void> {
    dbRun('UPDATE output_files SET vault_file_id = ? WHERE id = ?', vaultFileId, id);
  }

  async countByWorkflow(workflowId: string): Promise<number> {
    const row = one<{ c: number }>(
      'SELECT COUNT(*) AS c FROM output_files WHERE workflow_id = ? AND refused_reason IS NULL',
      workflowId,
    );
    return Number(row?.c ?? 0);
  }
}
