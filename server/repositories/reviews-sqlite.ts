/**
 * SQLite implementation of ReviewsRepository.
 * All SQL for p10_reviews and p10_findings lives here.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type { ReviewsRepository, ReviewRecord, FindingRecord, CreateReviewInput, CreateFindingInput, ReviewStatus } from './reviews.ts';

function toReview(row: Row): ReviewRecord {
  return {
    id: String(row.id), project_id: String(row.project_id ?? ''),
    base_ref: String(row.base_ref ?? ''), head_ref: String(row.head_ref ?? ''),
    pr_number: row.pr_number != null ? Number(row.pr_number) : null,
    repo_id: row.repo_id != null ? String(row.repo_id) : null,
    status: String(row.status ?? 'pending') as ReviewStatus,
    post_mode: String(row.post_mode ?? 'draft'),
    from_loop: row.from_loop != null ? String(row.from_loop) : null,
    workflow_id: row.workflow_id != null ? String(row.workflow_id) : null,
    min_severity: String(row.min_severity ?? 'high'),
    summary: row.summary != null ? String(row.summary) : null,
    raw_output: row.raw_output != null ? String(row.raw_output) : null,
    created_by: row.created_by != null ? String(row.created_by) : null,
    created_at: String(row.created_at ?? ''),
    parent_review_id: row.parent_review_id != null ? String(row.parent_review_id) : null,
    source_sha: row.source_sha != null ? String(row.source_sha) : null,
    dest_sha: row.dest_sha != null ? String(row.dest_sha) : null,
    provider_id: row.provider_id != null ? String(row.provider_id) : null,
    model_id: row.model_id != null ? String(row.model_id) : null,
    jira_context: String(row.jira_context ?? '{}'),
    run_log: String(row.run_log ?? '[]'),
    input_tokens: Number(row.input_tokens ?? 0), cache_write_tokens: Number(row.cache_write_tokens ?? 0),
    cache_read_tokens: Number(row.cache_read_tokens ?? 0), output_tokens: Number(row.output_tokens ?? 0),
    llm_requests: Number(row.llm_requests ?? 0), retry_count: Number(row.retry_count ?? 0),
    tool_calls: Number(row.tool_calls ?? 0), files_reviewed: Number(row.files_reviewed ?? 0),
    duration_ms: row.duration_ms != null ? Number(row.duration_ms) : null,
    started_at: row.started_at != null ? String(row.started_at) : null,
    merged_at: row.merged_at != null ? String(row.merged_at) : null,
    merged_by: row.merged_by != null ? String(row.merged_by) : null,
    head_commit_sha: row.head_commit_sha != null ? String(row.head_commit_sha) : null,
  };
}

function toFinding(row: Row): FindingRecord {
  return {
    id: String(row.id), review_id: String(row.review_id ?? ''),
    file_path: String(row.file_path ?? ''),
    line_number: row.line_number != null ? Number(row.line_number) : null,
    severity: String(row.severity ?? 'medium'), title: String(row.title ?? ''),
    body: String(row.body ?? ''), confidence: row.confidence != null ? Number(row.confidence) : null,
    accepted: Number(row.accepted ?? 0),
    posted_at: row.posted_at != null ? String(row.posted_at) : null,
    created_at: String(row.created_at ?? ''),
  };
}

export class SqliteReviewsRepository implements ReviewsRepository {
  async create(input: CreateReviewInput): Promise<ReviewRecord> {
    insert('p10_reviews', {
      id: input.id, project_id: input.project_id, base_ref: input.base_ref, head_ref: input.head_ref,
      pr_number: input.pr_number, repo_id: input.repo_id, status: input.status, post_mode: input.post_mode,
      from_loop: input.from_loop, workflow_id: input.workflow_id, min_severity: input.min_severity,
      summary: input.summary, raw_output: input.raw_output, created_by: input.created_by,
      created_at: input.created_at, parent_review_id: input.parent_review_id, source_sha: input.source_sha,
      dest_sha: input.dest_sha, provider_id: input.provider_id, model_id: input.model_id,
      jira_context: input.jira_context, run_log: input.run_log, input_tokens: input.input_tokens,
      cache_write_tokens: input.cache_write_tokens, cache_read_tokens: input.cache_read_tokens,
      output_tokens: input.output_tokens, llm_requests: input.llm_requests, retry_count: input.retry_count,
      tool_calls: input.tool_calls, files_reviewed: input.files_reviewed, duration_ms: input.duration_ms,
      started_at: input.started_at, merged_at: input.merged_at, merged_by: input.merged_by,
      head_commit_sha: input.head_commit_sha,
    });
    return toReview(one<Row>('SELECT * FROM p10_reviews WHERE id = ?', input.id)!);
  }

  async getById(id: string): Promise<ReviewRecord | null> {
    const row = one<Row>('SELECT * FROM p10_reviews WHERE id = ?', id);
    return row ? toReview(row) : null;
  }

  async getByWorkflowId(workflowId: string): Promise<ReviewRecord | null> {
    const row = one<Row>('SELECT * FROM p10_reviews WHERE workflow_id = ?', workflowId);
    return row ? toReview(row) : null;
  }

  async listByProject(
    projectId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ items: ReviewRecord[]; total: number }> {
    const rows = all<Row>(
      'SELECT * FROM p10_reviews WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      projectId, opts.limit, opts.offset,
    );
    const countRow = one<{ n: number }>('SELECT COUNT(*) AS n FROM p10_reviews WHERE project_id = ?', projectId);
    return { items: rows.map(toReview), total: Number(countRow?.n ?? 0) };
  }

  async listByProjectIds(projectIds: string[], since: string): Promise<ReviewRecord[]> {
    if (projectIds.length === 0) return [];
    const ph = projectIds.map(() => '?').join(',');
    const rows = all<Row>(
      `SELECT * FROM p10_reviews WHERE project_id IN (${ph}) AND created_at >= ? ORDER BY created_at DESC`,
      ...projectIds, since,
    );
    return rows.map(toReview);
  }

  async update(id: string, patch: Partial<ReviewRecord>): Promise<void> {
    const keys = Object.keys(patch).filter((k) => !['id', 'project_id', 'created_at'].includes(k));
    if (keys.length === 0) return;
    dbRun(
      `UPDATE p10_reviews SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null),
      id,
    );
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const result = dbRun('DELETE FROM p10_reviews WHERE id = ? AND project_id = ?', id, projectId) as { changes: number };
    return result.changes > 0;
  }

  async createFinding(input: CreateFindingInput): Promise<FindingRecord> {
    insert('p10_findings', {
      id: input.id, review_id: input.review_id, file_path: input.file_path, line_number: input.line_number,
      severity: input.severity, title: input.title, body: input.body, confidence: input.confidence,
      accepted: input.accepted, posted_at: input.posted_at, created_at: input.created_at,
    });
    return toFinding(one<Row>('SELECT * FROM p10_findings WHERE id = ?', input.id)!);
  }

  async listFindings(reviewId: string): Promise<FindingRecord[]> {
    const rows = all<Row>('SELECT * FROM p10_findings WHERE review_id = ?', reviewId);
    return rows.map(toFinding);
  }

  async getFindingById(id: string, reviewId: string): Promise<FindingRecord | null> {
    const row = one<Row>('SELECT * FROM p10_findings WHERE id = ? AND review_id = ?', id, reviewId);
    return row ? toFinding(row) : null;
  }

  async updateFinding(id: string, patch: Partial<FindingRecord>): Promise<void> {
    const keys = Object.keys(patch).filter((k) => !['id', 'review_id', 'created_at'].includes(k));
    if (keys.length === 0) return;
    dbRun(
      `UPDATE p10_findings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null),
      id,
    );
  }

  async markFindingPosted(id: string, postedAt: string): Promise<void> {
    dbRun('UPDATE p10_findings SET posted_at = ? WHERE id = ?', postedAt, id);
  }

  async checkAlreadyPosted(repoId: string, prNumber: number, sourceSha: string, excludeReviewId: string): Promise<boolean> {
    const row = one<{ id: string }>(
      `SELECT r.id FROM p10_reviews r
       JOIN p10_findings f ON f.review_id = r.id
       WHERE r.repo_id = ? AND r.pr_number = ? AND r.source_sha = ?
         AND r.id != ? AND f.posted_at IS NOT NULL
       LIMIT 1`,
      repoId, prNumber, sourceSha, excludeReviewId,
    );
    return row != null;
  }
}
