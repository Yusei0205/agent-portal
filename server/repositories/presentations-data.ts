/**
 * Repository interface for presentations.
 *
 * SQLite default; DynamoDB activated by USE_DYNAMODB=true.
 * DynamoDB table: portal-create (DYNAMODB_TABLE_PORTAL_CREATE, default 'portal-create')
 *
 * Key design:
 *   PK=PRES#<id>  SK=#META
 * GSI-PresByProject (portal-create):
 *   PK=presProjectId (<projectId>)  SK=<createdAt>#<id>
 * GSI-PresByWorkflow (sparse):
 *   PK=presWorkflowId  SK=#META
 */

import { SqlitePresentationRepository } from './presentations-data-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ──────────────────────────────────────────────────────────────

export interface PresentationRecord {
  id: string;
  project_id: string;
  name: string;
  topic: string | null;
  source_kind: string;
  source_ref: string | null;
  audience: string | null;
  slide_count: number;
  diagram_style: string;
  diagram_cloud: string | null;
  lead_agent: string | null;
  trust_all_tools: number;
  pptx_path: string | null;
  preview_json: string | null;
  workflow_id: string | null;
  stale: number;
  status: string;
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  attachment_ids: string;
}

export interface CreatePresentationInput {
  id: string;
  project_id: string;
  name: string;
  topic: string | null;
  source_kind: string;
  source_ref: string | null;
  audience: string | null;
  slide_count: number;
  diagram_style: string;
  diagram_cloud: string | null;
  lead_agent: string | null;
  trust_all_tools: number;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  attachment_ids: string;
}

export type PresentationUpdate = Partial<Omit<PresentationRecord, 'id' | 'project_id' | 'created_at' | 'created_by'>>;

// ── Repository interface ───────────────────────────────────────────────────────

export interface PresentationRepository {
  create(input: CreatePresentationInput): Promise<PresentationRecord>;
  getById(id: string, projectId: string): Promise<PresentationRecord | null>;
  getByWorkflowId(workflowId: string): Promise<PresentationRecord | null>;
  listByProject(projectId: string): Promise<PresentationRecord[]>;
  countByProject(projectId: string): Promise<number>;
  update(id: string, fields: PresentationUpdate): Promise<void>;
  delete(id: string): Promise<void>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: PresentationRepository | null = null;

export async function initPresentationRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbPresentationRepository } = await import('./presentations-data-dynamodb.ts');
    _instance = new DynamoDbPresentationRepository();
  } else {
    _instance = new SqlitePresentationRepository();
  }
}

export function getPresentationRepository(): PresentationRepository {
  if (!_instance) _instance = new SqlitePresentationRepository();
  return _instance;
}

export function setPresentationRepository(repo: PresentationRepository): void { _instance = repo; }
export function clearPresentationRepository(): void { _instance = null; }
