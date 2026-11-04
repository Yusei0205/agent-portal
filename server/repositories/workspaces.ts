/**
 * Repository interface for workspaces_v2.
 *
 * DynamoDB table: portal-code
 * PK=WS#<projectId>  SK=WS#<isoCreatedAt>#<id>
 * GSI-P10EntityId: PK=id, SK=entityType='workspace'
 */

import { SqliteWorkspacesRepository } from './workspaces-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

export interface WorkspaceRecord {
  id: string;
  project_id: string;
  name: string;
  repo_ids: string;
  created_at: string;
  default_engine: string;
  default_agent: string;
  default_model: string;
}

export interface CreateWorkspaceInput {
  id: string;
  project_id: string;
  name: string;
  repo_ids: string;
  created_at: string;
  default_engine: string;
  default_agent: string;
  default_model: string;
}

export interface WorkspacesRepository {
  create(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  getById(id: string): Promise<WorkspaceRecord | null>;
  getByIdForProject(id: string, projectId: string): Promise<WorkspaceRecord | null>;
  listByProject(projectId: string): Promise<WorkspaceRecord[]>;
  update(id: string, projectId: string, patch: Partial<WorkspaceRecord>): Promise<WorkspaceRecord | null>;
  delete(id: string, projectId: string): Promise<boolean>;
}

let _instance: WorkspacesRepository | null = null;

export async function initWorkspacesRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbWorkspacesRepository } = await import('./workspaces-dynamodb.ts');
    _instance = new DynamoDbWorkspacesRepository();
  } else {
    _instance = new SqliteWorkspacesRepository();
  }
}

export function getWorkspacesRepository(): WorkspacesRepository {
  if (!_instance) _instance = new SqliteWorkspacesRepository();
  return _instance;
}

export function setWorkspacesRepository(repo: WorkspacesRepository): void { _instance = repo; }
export function clearWorkspacesRepository(): void { _instance = null; }
