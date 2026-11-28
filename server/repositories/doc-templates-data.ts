/**
 * Repository interface for doc_templates (M9 schema).
 *
 * DynamoDB table: portal-create (DYNAMODB_TABLE_PORTAL_CREATE, default 'portal-create')
 *
 * Key design:
 *   PK=DTPL#<id>  SK=#META
 * GSI-TplByProject (sparse):
 *   PK=tplProjectId  SK=<type>#<id>
 */

import { SqliteDocTemplateRepository } from './doc-templates-data-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ──────────────────────────────────────────────────────────────

export interface DocTemplateRecord {
  id: string;
  project_id: string | null;
  name: string;
  type: string;
  path: string;
  is_default: number;
  uploaded_by: string | null;
  created_at: string;
}

export interface CreateDocTemplateInput {
  id: string;
  project_id: string | null;
  name: string;
  type: string;
  path: string;
  is_default: number;
  uploaded_by: string | null;
  created_at: string;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface DocTemplateRepository {
  create(input: CreateDocTemplateInput): Promise<DocTemplateRecord>;
  getById(id: string): Promise<DocTemplateRecord | null>;
  listByProject(projectId: string): Promise<DocTemplateRecord[]>;
  listPortal(): Promise<DocTemplateRecord[]>;
  setDefault(id: string, projectId: string | null, type: string): Promise<void>;
  delete(id: string): Promise<void>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: DocTemplateRepository | null = null;

export async function initDocTemplateRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbDocTemplateRepository } = await import('./doc-templates-data-dynamodb.ts');
    _instance = new DynamoDbDocTemplateRepository();
  } else {
    _instance = new SqliteDocTemplateRepository();
  }
}

export function getDocTemplateRepository(): DocTemplateRepository {
  if (!_instance) _instance = new SqliteDocTemplateRepository();
  return _instance;
}

export function setDocTemplateRepository(repo: DocTemplateRepository): void { _instance = repo; }
export function clearDocTemplateRepository(): void { _instance = null; }
