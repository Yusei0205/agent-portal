/**
 * Repository interface for vault_files.
 *
 * Vault scopes:
 *   project  — project_id SET, user_id NULL  → accessible to all project members
 *   personal — project_id SET, user_id SET   → uploader only
 *   portal   — project_id NULL               → admin-uploaded, readable by all
 *
 * SQLite is the default backend. DynamoDB is activated by USE_DYNAMODB=true.
 *
 * DynamoDB table: portal-content
 *
 * Key design:
 *   Project scope:  PK=VAULTPROJ#<projectId>        SK=VFILE#<isoCreatedAt>#<fileId>
 *   Personal scope: PK=VAULTPERS#<projectId>#<userId> SK=VFILE#<isoCreatedAt>#<fileId>
 *   Portal scope:   PK=VAULTPORTAL                   SK=VFILE#<isoCreatedAt>#<fileId>
 *   GSI-ContentEntityId: PK=id, SK=entityType  →  getById, getByIdForProject
 *
 * Combined listings (project + personal + portal) require 3 parallel Queries merged
 * in application code. No scan needed.
 *
 * Note: file bytes remain on disk (or S3 in a future phase); only metadata is in DynamoDB.
 */

import { SqliteVaultFilesRepository } from './vault-files-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ─────────────────────────────────────────────────────────────

export interface VaultFileRecord {
  id: string;
  project_id: string | null;
  user_id: string | null;
  name: string;
  path: string;
  size_bytes: number | null;
  mime_type: string | null;
  uploaded_by: string | null;
  folder: string | null;
  source_workflow_id: string | null;
  created_at: string;
}

// ── Input types ──────────────────────────────────────────────────────────────

export interface CreateVaultFileInput {
  id: string;
  project_id: string | null;
  user_id: string | null;
  name: string;
  path: string;
  size_bytes: number;
  mime_type: string;
  uploaded_by: string | null;
  folder: string | null;
  source_workflow_id: string | null;
  created_at: string;
}

// ── Repository interface ─────────────────────────────────────────────────────

export interface VaultFilesRepository {
  /**
   * Create a new vault file record.
   * Note: the actual file bytes must be written to disk by the caller first.
   */
  create(input: CreateVaultFileInput): Promise<VaultFileRecord>;

  /** Get a vault file by its ID. Returns null when not found. */
  getById(id: string): Promise<VaultFileRecord | null>;

  /**
   * Get a vault file by ID, accepting only files whose project_id equals
   * projectId OR is NULL (portal scope). Used by scan.ts context fetch.
   */
  getByIdForProject(id: string, projectId: string): Promise<VaultFileRecord | null>;

  /**
   * List vault files accessible in a project context, optionally filtered by scope.
   *
   * If scope is 'project': files WHERE project_id = ? AND user_id IS NULL
   * If scope is 'personal': files WHERE project_id = ? AND user_id = ?
   * If scope is 'portal': files WHERE project_id IS NULL
   * If scope is null/undefined: union of all three — project + personal(userId) + portal
   *
   * Results are ordered by created_at DESC.
   */
  listByProject(
    projectId: string,
    userId: string,
    scope?: 'project' | 'personal' | 'portal' | null,
  ): Promise<VaultFileRecord[]>;

  /**
   * List vault files by project scope with optional folder filter.
   * Used by the zip route.
   */
  listByScope(
    scope: 'project' | 'personal' | 'portal',
    projectId: string,
    userId: string,
    folderFilter?: string | null,
  ): Promise<VaultFileRecord[]>;

  /** List all portal-scoped vault files (project_id IS NULL). Admin only. */
  listPortal(): Promise<VaultFileRecord[]>;

  /** Delete a vault file record by ID. */
  delete(id: string): Promise<void>;

  /** Update size_bytes and mime_type of an existing vault file (used by copyToVault replace-in-place). */
  updateSizeAndMime(id: string, sizeBytes: number, mimeType: string): Promise<void>;

  /** Set the folder for a vault file. */
  updateFolder(id: string, folder: string | null): Promise<void>;

  /** Bulk delete vault file records. */
  bulkDelete(ids: string[]): Promise<void>;

  /** Bulk update folder for project-scoped vault files. */
  bulkUpdateFolder(ids: string[], folder: string | null): Promise<void>;

  /**
   * Find a project-scoped vault file by project, folder, name, and source workflow.
   * Used by copyToVault to detect replace-in-place.
   */
  findByWorkflowFolderName(
    projectId: string,
    folder: string,
    name: string,
    workflowId: string,
  ): Promise<VaultFileRecord | null>;

  /**
   * Validate that all fileIds belong to a project (project scope, user_id IS NULL).
   * Returns the first missing ID or null if all are valid.
   */
  validateProjectFiles(fileIds: string[], projectId: string): Promise<string | null>;

  /**
   * Get vault files by their IDs (best-effort).
   * Returns only found records (no error for missing IDs).
   */
  getByIds(ids: string[]): Promise<VaultFileRecord[]>;
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: VaultFilesRepository | null = null;

export async function initVaultFilesRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbVaultFilesRepository } = await import('./vault-files-dynamodb.ts');
    _instance = new DynamoDbVaultFilesRepository();
  } else {
    _instance = new SqliteVaultFilesRepository();
  }
}

export function getVaultFilesRepository(): VaultFilesRepository {
  if (!_instance) _instance = new SqliteVaultFilesRepository();
  return _instance;
}

export function setVaultFilesRepository(repo: VaultFilesRepository): void { _instance = repo; }
export function clearVaultFilesRepository(): void { _instance = null; }
