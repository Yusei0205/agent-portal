/**
 * Repository interface for git_connections_v2.
 *
 * DynamoDB table: portal-p10
 * PK=GITCONN#<userId> SK=CONN#<id> (personal)
 * PK=GITCONN_SHARED   SK=CONN#<id> (shared)
 * GSI-P10EntityId: PK=id, SK=entityType='gitconn'
 */

import { SqliteGitConnectionsRepository } from './git-connections-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

export interface GitConnectionRecord {
  id: string;
  name: string;
  provider: string;
  credentials_enc: string | null;
  scope: string;
  owner_id: string | null;
  created_at: string;
}

export interface CreateGitConnectionInput {
  id: string;
  name: string;
  provider: string;
  credentials_enc: string | null;
  scope: string;
  owner_id: string | null;
  created_at: string;
}

export interface GitConnectionsRepository {
  create(input: CreateGitConnectionInput): Promise<GitConnectionRecord>;
  getById(id: string): Promise<GitConnectionRecord | null>;
  /** List connections owned by userId plus all shared connections. */
  listByUserOrShared(userId: string): Promise<GitConnectionRecord[]>;
  /** List connections for credential lookup by provider (owned by userId OR shared). Returns credentials_enc. */
  listByProviderForUser(provider: string, userId: string): Promise<GitConnectionRecord[]>;
  update(id: string, patch: Partial<GitConnectionRecord>): Promise<GitConnectionRecord | null>;
  delete(id: string): Promise<boolean>;
}

let _instance: GitConnectionsRepository | null = null;

export async function initGitConnectionsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbGitConnectionsRepository } = await import('./git-connections-dynamodb.ts');
    _instance = new DynamoDbGitConnectionsRepository();
  } else {
    _instance = new SqliteGitConnectionsRepository();
  }
}

export function getGitConnectionsRepository(): GitConnectionsRepository {
  if (!_instance) _instance = new SqliteGitConnectionsRepository();
  return _instance;
}

export function setGitConnectionsRepository(repo: GitConnectionsRepository): void { _instance = repo; }
export function clearGitConnectionsRepository(): void { _instance = null; }
