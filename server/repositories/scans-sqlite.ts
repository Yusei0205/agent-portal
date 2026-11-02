/**
 * SQLite implementation of ScansRepository.
 * All SQL for p10_scans and p10_scan_files lives here.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type { ScansRepository, ScanRecord, ScanFileRecord, CreateScanInput, CreateScanFileInput, ScanStatus } from './scans.ts';

function toScan(row: Row): ScanRecord {
  return {
    id: String(row.id), project_id: row.project_id != null ? String(row.project_id) : null,
    repo_id: row.repo_id != null ? String(row.repo_id) : null,
    branch: row.branch != null ? String(row.branch) : null,
    pinned_sha: row.pinned_sha != null ? String(row.pinned_sha) : null,
    include_paths: String(row.include_paths ?? '[]'), exclude_paths: String(row.exclude_paths ?? '[]'),
    background_doc_ids: String(row.background_doc_ids ?? '[]'),
    model_role: row.model_role != null ? String(row.model_role) : null,
    provider_id: row.provider_id != null ? String(row.provider_id) : null,
    model_id: row.model_id != null ? String(row.model_id) : null,
    status: String(row.status ?? 'estimating') as ScanStatus,
    fail_reason: row.fail_reason != null ? String(row.fail_reason) : null,
    budget_tokens: row.budget_tokens != null ? Number(row.budget_tokens) : null,
    estimated_files: row.estimated_files != null ? Number(row.estimated_files) : null,
    estimated_bytes: row.estimated_bytes != null ? Number(row.estimated_bytes) : null,
    estimated_tokens: row.estimated_tokens != null ? Number(row.estimated_tokens) : null,
    estimated_cost_usd: row.estimated_cost_usd != null ? Number(row.estimated_cost_usd) : null,
    estimated_minutes: row.estimated_minutes != null ? Number(row.estimated_minutes) : null,
    files_total: Number(row.files_total ?? 0), files_done: Number(row.files_done ?? 0),
    tokens_used: Number(row.tokens_used ?? 0), cost_usd: Number(row.cost_usd ?? 0),
    input_tokens: Number(row.input_tokens ?? 0), output_tokens: Number(row.output_tokens ?? 0),
    summary: row.summary != null ? String(row.summary) : null,
    review_id: row.review_id != null ? String(row.review_id) : null,
    created_by: row.created_by != null ? String(row.created_by) : null,
    created_at: String(row.created_at ?? ''), started_at: row.started_at != null ? String(row.started_at) : null,
    completed_at: row.completed_at != null ? String(row.completed_at) : null,
    workflow_id: row.workflow_id != null ? String(row.workflow_id) : null,
  };
}

function toFile(row: Row): ScanFileRecord {
  return {
    id: String(row.id), scan_id: String(row.scan_id ?? ''), file_path: String(row.file_path ?? ''),
    status: String(row.status ?? 'pending'), tokens_used: Number(row.tokens_used ?? 0),
    done_at: row.done_at != null ? String(row.done_at) : null,
    file_sha: row.file_sha != null ? String(row.file_sha) : null,
    file_size: row.file_size != null ? Number(row.file_size) : null,
  };
}

export class SqliteScansRepository implements ScansRepository {
  async create(input: CreateScanInput): Promise<ScanRecord> {
    insert('p10_scans', {
      id: input.id, project_id: input.project_id, repo_id: input.repo_id, branch: input.branch,
      pinned_sha: input.pinned_sha, include_paths: input.include_paths, exclude_paths: input.exclude_paths,
      background_doc_ids: input.background_doc_ids, model_role: input.model_role,
      provider_id: input.provider_id, model_id: input.model_id, status: input.status,
      fail_reason: input.fail_reason, budget_tokens: input.budget_tokens, estimated_files: input.estimated_files,
      estimated_bytes: input.estimated_bytes, estimated_tokens: input.estimated_tokens,
      estimated_cost_usd: input.estimated_cost_usd, estimated_minutes: input.estimated_minutes,
      files_total: input.files_total, files_done: input.files_done, tokens_used: input.tokens_used,
      cost_usd: input.cost_usd, input_tokens: input.input_tokens, output_tokens: input.output_tokens,
      summary: input.summary, review_id: input.review_id, created_by: input.created_by,
      created_at: input.created_at, started_at: input.started_at, completed_at: input.completed_at,
      workflow_id: input.workflow_id,
    });
    return toScan(one<Row>('SELECT * FROM p10_scans WHERE id = ?', input.id)!);
  }

  async getById(id: string): Promise<ScanRecord | null> {
    const row = one<Row>('SELECT * FROM p10_scans WHERE id = ?', id);
    return row ? toScan(row) : null;
  }

  async getByIdForProject(id: string, projectId: string): Promise<ScanRecord | null> {
    const row = one<Row>('SELECT * FROM p10_scans WHERE id = ? AND project_id = ?', id, projectId);
    return row ? toScan(row) : null;
  }

  async getByWorkflowId(workflowId: string): Promise<ScanRecord | null> {
    const row = one<Row>('SELECT * FROM p10_scans WHERE workflow_id = ?', workflowId);
    return row ? toScan(row) : null;
  }

  async listByProject(
    projectId: string,
    opts: { status?: ScanStatus; limit: number; offset: number },
  ): Promise<{ items: ScanRecord[]; total: number }> {
    let rows: Row[];
    let countRow: { n: number } | null;
    if (opts.status) {
      rows = all<Row>(
        'SELECT * FROM p10_scans WHERE project_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        projectId, opts.status, opts.limit, opts.offset,
      );
      countRow = one<{ n: number }>('SELECT COUNT(*) AS n FROM p10_scans WHERE project_id = ? AND status = ?', projectId, opts.status);
    } else {
      rows = all<Row>(
        'SELECT * FROM p10_scans WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        projectId, opts.limit, opts.offset,
      );
      countRow = one<{ n: number }>('SELECT COUNT(*) AS n FROM p10_scans WHERE project_id = ?', projectId);
    }
    return { items: rows.map(toScan), total: Number(countRow?.n ?? 0) };
  }

  async update(id: string, patch: Partial<ScanRecord>): Promise<void> {
    const keys = Object.keys(patch).filter((k) => !['id', 'created_at'].includes(k));
    if (keys.length === 0) return;
    dbRun(
      `UPDATE p10_scans SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null),
      id,
    );
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const result = dbRun('DELETE FROM p10_scans WHERE id = ? AND project_id = ?', id, projectId) as { changes: number };
    return result.changes > 0;
  }

  async createFile(input: CreateScanFileInput): Promise<ScanFileRecord> {
    insert('p10_scan_files', {
      id: input.id, scan_id: input.scan_id, file_path: input.file_path,
      status: input.status, tokens_used: input.tokens_used, done_at: input.done_at,
      file_sha: input.file_sha ?? null, file_size: input.file_size ?? null,
    });
    return toFile(one<Row>('SELECT * FROM p10_scan_files WHERE id = ?', input.id)!);
  }

  async listFiles(scanId: string): Promise<ScanFileRecord[]> {
    const rows = all<Row>('SELECT * FROM p10_scan_files WHERE scan_id = ?', scanId);
    return rows.map(toFile);
  }

  async updateFile(id: string, patch: Partial<ScanFileRecord>): Promise<void> {
    const keys = Object.keys(patch).filter((k) => !['id', 'scan_id'].includes(k));
    if (keys.length === 0) return;
    dbRun(
      `UPDATE p10_scan_files SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null),
      id,
    );
  }
}
