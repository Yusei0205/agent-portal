/**
 * Repository interface for p10_scans + p10_scan_files.
 *
 * DynamoDB table: portal-p10
 * Scans:     PK=SCAN#<projectId>    SK=SCAN#<isoCreatedAt>#<id>
 * ScanFiles: PK=SCANFILES#<scanId>  SK=FILE#<id>
 * GSI-P10EntityId: PK=id, SK=entityType='scan'
 * GSI-P10WorkflowId: PK=workflowId (sparse, only on scan items)
 */

import { SqliteScansRepository } from './scans-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

export type ScanStatus = 'estimating' | 'estimate_ready' | 'queued' | 'fetching' | 'reviewing' | 'completed' | 'failed';

export interface ScanRecord {
  id: string;
  project_id: string | null;
  repo_id: string | null;
  branch: string | null;
  pinned_sha: string | null;
  include_paths: string;
  exclude_paths: string;
  background_doc_ids: string;
  model_role: string | null;
  provider_id: string | null;
  model_id: string | null;
  status: ScanStatus;
  fail_reason: string | null;
  budget_tokens: number | null;
  estimated_files: number | null;
  estimated_bytes: number | null;
  estimated_tokens: number | null;
  estimated_cost_usd: number | null;
  estimated_minutes: number | null;
  files_total: number;
  files_done: number;
  tokens_used: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  summary: string | null;
  review_id: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  workflow_id: string | null;
}

export interface ScanFileRecord {
  id: string;
  scan_id: string;
  file_path: string;
  status: string;
  tokens_used: number;
  done_at: string | null;
}

export interface CreateScanInput {
  id: string;
  project_id: string | null;
  repo_id: string | null;
  branch: string | null;
  pinned_sha: string | null;
  include_paths: string;
  exclude_paths: string;
  background_doc_ids: string;
  model_role: string | null;
  provider_id: string | null;
  model_id: string | null;
  status: ScanStatus;
  fail_reason: string | null;
  budget_tokens: number | null;
  estimated_files: number | null;
  estimated_bytes: number | null;
  estimated_tokens: number | null;
  estimated_cost_usd: number | null;
  estimated_minutes: number | null;
  files_total: number;
  files_done: number;
  tokens_used: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  summary: string | null;
  review_id: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  workflow_id: string | null;
}

export interface CreateScanFileInput {
  id: string;
  scan_id: string;
  file_path: string;
  status: string;
  tokens_used: number;
  done_at: string | null;
}

export interface ScansRepository {
  create(input: CreateScanInput): Promise<ScanRecord>;
  getById(id: string): Promise<ScanRecord | null>;
  getByIdForProject(id: string, projectId: string): Promise<ScanRecord | null>;
  getByWorkflowId(workflowId: string): Promise<ScanRecord | null>;
  listByProject(projectId: string, opts: { status?: ScanStatus; limit: number; offset: number }): Promise<{ items: ScanRecord[]; total: number }>;
  update(id: string, patch: Partial<ScanRecord>): Promise<void>;
  delete(id: string, projectId: string): Promise<boolean>;
  createFile(input: CreateScanFileInput): Promise<ScanFileRecord>;
  listFiles(scanId: string): Promise<ScanFileRecord[]>;
  updateFile(id: string, patch: Partial<ScanFileRecord>): Promise<void>;
}

let _instance: ScansRepository | null = null;

export async function initScansRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbScansRepository } = await import('./scans-dynamodb.ts');
    _instance = new DynamoDbScansRepository();
  } else {
    _instance = new SqliteScansRepository();
  }
}

export function getScansRepository(): ScansRepository {
  if (!_instance) _instance = new SqliteScansRepository();
  return _instance;
}

export function setScansRepository(repo: ScansRepository): void { _instance = repo; }
export function clearScansRepository(): void { _instance = null; }
