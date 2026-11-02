/**
 * Repository interface for the `repositories` table (git repos).
 *
 * DynamoDB table: portal-p10
 * PK=REPO#<projectId>  SK=REPO#<isoCreatedAt>#<id>
 * GSI-P10EntityId: PK=id, SK=entityType='repo'
 */

import { SqliteGitReposRepository } from './git-repos-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

export interface GitRepoRecord {
  id: string;
  project_id: string;
  name: string;
  url: string;
  provider: string;
  status: string;
  default_branch: string | null;
  identity: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  connection_id: string | null;
}

export interface CreateGitRepoInput {
  id: string;
  project_id: string;
  name: string;
  url: string;
  provider: string;
  status: string;
  default_branch: string | null;
  identity: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  connection_id: string | null;
}

export interface GitReposRepository {
  create(input: CreateGitRepoInput): Promise<GitRepoRecord>;
  getById(id: string): Promise<GitRepoRecord | null>;
  getByIdForProject(id: string, projectId: string): Promise<GitRepoRecord | null>;
  listByProject(projectId: string): Promise<GitRepoRecord[]>;
  /** List just URLs — used for duplicate detection on bulk-add. */
  listUrlsByProject(projectId: string): Promise<string[]>;
  updateStatus(id: string, status: string, extra?: { lastSyncedAt?: string | null; defaultBranch?: string | null; lastError?: string | null }): Promise<void>;
  updateDefaultBranch(id: string, branch: string): Promise<void>;
  delete(id: string, projectId: string): Promise<boolean>;
}

let _instance: GitReposRepository | null = null;

export async function initGitReposRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbGitReposRepository } = await import('./git-repos-dynamodb.ts');
    _instance = new DynamoDbGitReposRepository();
  } else {
    _instance = new SqliteGitReposRepository();
  }
}

export function getGitReposRepository(): GitReposRepository {
  if (!_instance) _instance = new SqliteGitReposRepository();
  return _instance;
}

export function setGitReposRepository(repo: GitReposRepository): void { _instance = repo; }
export function clearGitReposRepository(): void { _instance = null; }
