/**
 * Repository interface for mcp_integrations.
 *
 * SQLite default.  DynamoDB activated by USE_DYNAMODB=true.
 *
 * DynamoDB table: portal-projects
 * Key design:
 *   PK=MCPINT#<projectId>   SK=INT#<id>
 */

import { SqliteIntegrationsRepository } from './integrations-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ───────────────────────────────────────────────────────────────

export interface IntegrationRecord {
  id: string;
  project_id: string | null;
  name: string;
  type: string;
  config_enc: string | null;
  enabled: number;
  created_by: string | null;
  created_at: string;
}

export interface CreateIntegrationInput {
  id: string;
  project_id: string;
  name: string;
  type: string;
  config_enc: string | null;
  enabled: number;
  created_by: string | null;
  created_at: string;
}

export interface UpdateIntegrationFields {
  name?: string;
  enabled?: number;
  config_enc?: string | null;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface IntegrationsRepository {
  getById(id: string): Promise<IntegrationRecord | null>;
  getByIdAndProject(id: string, projectId: string): Promise<IntegrationRecord | null>;
  listByProject(projectId: string): Promise<IntegrationRecord[]>;
  create(input: CreateIntegrationInput): Promise<IntegrationRecord>;
  update(id: string, projectId: string, fields: UpdateIntegrationFields): Promise<IntegrationRecord | null>;
  delete(id: string, projectId: string): Promise<boolean>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: IntegrationsRepository | null = null;

export async function initIntegrationsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbIntegrationsRepository } = await import('./integrations-dynamodb.ts');
    _instance = new DynamoDbIntegrationsRepository();
  } else {
    _instance = new SqliteIntegrationsRepository();
  }
}

export function getIntegrationsRepository(): IntegrationsRepository {
  if (!_instance) _instance = new SqliteIntegrationsRepository();
  return _instance;
}

export function setIntegrationsRepository(repo: IntegrationsRepository): void { _instance = repo; }
export function clearIntegrationsRepository(): void { _instance = null; }
