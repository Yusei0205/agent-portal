/**
 * Repository interface for p10_reviews + p10_findings.
 *
 * DynamoDB table: portal-p10
 * Reviews: PK=REVIEW#<projectId>  SK=REV#<isoCreatedAt>#<id>
 *          workflowId attr (sparse) → GSI-P10WorkflowId
 * Findings: PK=FIND#<reviewId>    SK=FIND#<id>
 * GSI-P10EntityId: PK=id, SK=entityType='review'
 * GSI-P10WorkflowId: PK=workflowId (sparse)
 */

import { SqliteReviewsRepository } from './reviews-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

export type ReviewStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ReviewRecord {
  id: string;
  project_id: string;
  base_ref: string;
  head_ref: string;
  pr_number: number | null;
  repo_id: string | null;
  status: ReviewStatus;
  post_mode: string;
  from_loop: string | null;
  workflow_id: string | null;
  min_severity: string;
  summary: string | null;
  raw_output: string | null;
  created_by: string | null;
  created_at: string;
  parent_review_id: string | null;
  source_sha: string | null;
  dest_sha: string | null;
  provider_id: string | null;
  model_id: string | null;
  jira_context: string;
  run_log: string;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  llm_requests: number;
  retry_count: number;
  tool_calls: number;
  files_reviewed: number;
  duration_ms: number | null;
  started_at: string | null;
  merged_at: string | null;
  merged_by: string | null;
  head_commit_sha: string | null;
}

export interface FindingRecord {
  id: string;
  review_id: string;
  file_path: string;
  line_number: number | null;
  severity: string;
  title: string;
  body: string;
  confidence: number | null;
  accepted: number;
  posted_at: string | null;
  created_at: string;
}

export interface CreateReviewInput extends Omit<ReviewRecord, 'id'> { id: string }
export interface CreateFindingInput extends Omit<FindingRecord, never> {}

export interface ReviewsRepository {
  create(input: CreateReviewInput): Promise<ReviewRecord>;
  getById(id: string): Promise<ReviewRecord | null>;
  getByWorkflowId(workflowId: string): Promise<ReviewRecord | null>;
  listByProject(projectId: string, opts: { limit: number; offset: number }): Promise<{ items: ReviewRecord[]; total: number }>;
  /** List reviews for dashboard — all projects, newer than `since`. */
  listByProjectIds(projectIds: string[], since: string): Promise<ReviewRecord[]>;
  update(id: string, patch: Partial<ReviewRecord>): Promise<void>;
  delete(id: string, projectId: string): Promise<boolean>;
  // Findings
  createFinding(input: CreateFindingInput): Promise<FindingRecord>;
  listFindings(reviewId: string): Promise<FindingRecord[]>;
  getFindingById(id: string, reviewId: string): Promise<FindingRecord | null>;
  updateFinding(id: string, patch: Partial<FindingRecord>): Promise<void>;
  /** Mark posted_at on a finding (best-effort). */
  markFindingPosted(id: string, postedAt: string): Promise<void>;
  /** Check whether a prior review for the same repo/PR/sha has any posted findings. */
  checkAlreadyPosted(repoId: string, prNumber: number, sourceSha: string, excludeReviewId: string): Promise<boolean>;
}

let _instance: ReviewsRepository | null = null;

export async function initReviewsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbReviewsRepository } = await import('./reviews-dynamodb.ts');
    _instance = new DynamoDbReviewsRepository();
  } else {
    _instance = new SqliteReviewsRepository();
  }
}

export function getReviewsRepository(): ReviewsRepository {
  if (!_instance) _instance = new SqliteReviewsRepository();
  return _instance;
}

export function setReviewsRepository(repo: ReviewsRepository): void { _instance = repo; }
export function clearReviewsRepository(): void { _instance = null; }
