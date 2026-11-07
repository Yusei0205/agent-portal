/**
 * Repository interface for output_files.
 *
 * Session output files are collected at the end of every agent run.
 * They are versioned per workflow+path: if the same file path changes between
 * runs, a new version row is added.
 *
 * SQLite is the default backend. DynamoDB is activated by USE_DYNAMODB=true.
 *
 * DynamoDB table: portal-content
 *
 * Key design:
 *   PK=WFOUT#<workflowId>  SK=OUTFILE#<isoCreatedAt>#<fileId>
 *   GSI-ContentEntityId: PK=id, SK=entityType  →  getById
 *
 * Notes:
 *   - output_files are workflow-scoped, not project-scoped.
 *   - File bytes remain on disk (or S3 in a future phase); only metadata is in DynamoDB.
 *   - listLatestByWorkflow applies max-version-per-path deduplication in-memory in
 *     DynamoDB mode; SQLite uses a correlated subquery (same semantics).
 */

import { SqliteOutputFilesRepository } from './output-files-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ─────────────────────────────────────────────────────────────

export interface OutputFileRecord {
  id: string;
  workflow_id: string;
  run_id: string;
  name: string;
  path: string;
  size_bytes: number | null;
  mime_type: string | null;
  version: number;
  refused_reason: string | null;
  hash: string | null;
  vault_file_id: string | null;
  created_at: string;
}

// ── Input types ──────────────────────────────────────────────────────────────

export interface CreateOutputFileInput {
  id: string;
  workflow_id: string;
  run_id: string;
  name: string;
  path: string;
  size_bytes: number | null;
  mime_type: string | null;
  version: number;
  refused_reason: string | null;
  hash: string | null;
  created_at: string;
}

// ── Repository interface ─────────────────────────────────────────────────────

export interface OutputFilesRepository {
  /** Create an output file record. */
  create(input: CreateOutputFileInput): Promise<OutputFileRecord>;

  /**
   * Get an output file by its ID and workflow ID.
   * workflowId is required to build the DynamoDB primary key; SQLite ignores it.
   * Returns null when not found or when the workflow does not own the file.
   */
  getById(id: string, workflowId: string): Promise<OutputFileRecord | null>;

  /**
   * Get the latest version of a file by workflow and relative path,
   * excluding refused files. Returns null if no version exists.
   */
  getLatestByPath(workflowId: string, filePath: string): Promise<OutputFileRecord | null>;

  /**
   * List all output files for a workflow, returning only the latest
   * version per unique path. Refused files are excluded.
   * Results are ordered by created_at DESC.
   */
  listLatestByWorkflow(workflowId: string): Promise<OutputFileRecord[]>;

  /** Update the vault_file_id FK on an output file record (set by copyToVault). */
  updateVaultFileId(id: string, vaultFileId: string): Promise<void>;

  /** Count output files for a workflow (excluding refused). Used for SSE notification. */
  countByWorkflow(workflowId: string): Promise<number>;
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: OutputFilesRepository | null = null;

export async function initOutputFilesRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbOutputFilesRepository } = await import('./output-files-dynamodb.ts');
    _instance = new DynamoDbOutputFilesRepository();
  } else {
    _instance = new SqliteOutputFilesRepository();
  }
}

export function getOutputFilesRepository(): OutputFilesRepository {
  if (!_instance) _instance = new SqliteOutputFilesRepository();
  return _instance;
}

export function setOutputFilesRepository(repo: OutputFilesRepository): void { _instance = repo; }
export function clearOutputFilesRepository(): void { _instance = null; }
