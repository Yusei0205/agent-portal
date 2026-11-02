/**
 * Repository interface for generated_docs and generated_doc_versions (M9 schema).
 *
 * DynamoDB table: portal-create (DYNAMODB_TABLE_PORTAL_CREATE, default 'portal-create')
 *
 * Key design:
 *   PK=GDOC#<id>  SK=#META  (generated_docs canonical item)
 *   PK=GDOC#<docId>  SK=VER#<versionNum>  (generated_doc_versions)
 * GSI-GDocByProject (portal-create):
 *   PK=gdocProjectId (<projectId>)  SK=<createdAt>#<id>
 */

import { SqliteGeneratedDocRepository } from './generated-docs-data-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ──────────────────────────────────────────────────────────────

export interface GeneratedDocRecord {
  id: string;
  project_id: string;
  name: string;
  doc_type: string;
  sources_json: string;
  diagram_style: string;
  diagram_cloud: string | null;
  lead_agent: string | null;
  trust_all_tools: number;
  audience: string | null;
  latest_version_id: string | null;
  stale: number;
  status: string;
  error: string | null;
  created_by: string | null;
  created_at: string;
  attachment_ids: string;
}

export interface GeneratedDocVersionRecord {
  id: string;
  doc_id: string;
  version_num: number;
  md_path: string | null;
  docx_path: string | null;
  warnings: string | null;
  workflow_id: string | null;
  created_at: string;
}

export interface CreateGeneratedDocInput {
  id: string;
  project_id: string;
  name: string;
  doc_type: string;
  sources_json: string;
  diagram_style: string;
  diagram_cloud: string | null;
  lead_agent: string | null;
  trust_all_tools: number;
  audience: string | null;
  latest_version_id: string | null;
  stale: number;
  created_by: string | null;
  created_at: string;
  attachment_ids: string;
}

export interface CreateGeneratedDocVersionInput {
  id: string;
  doc_id: string;
  version_num: number;
  md_path: string | null;
  docx_path: string | null;
  warnings: string | null;
  workflow_id: string | null;
  created_at: string;
}

export type GeneratedDocUpdate = Partial<Pick<GeneratedDocRecord,
  'name' | 'doc_type' | 'sources_json' | 'diagram_style' | 'diagram_cloud' | 'lead_agent' |
  'trust_all_tools' | 'audience' | 'latest_version_id' | 'stale' | 'status' | 'error' | 'attachment_ids'
>>;

// ── Repository interface ───────────────────────────────────────────────────────

export interface GeneratedDocRepository {
  // generated_docs
  create(input: CreateGeneratedDocInput): Promise<GeneratedDocRecord>;
  getById(id: string, projectId: string): Promise<GeneratedDocRecord | null>;
  listByProject(projectId: string): Promise<GeneratedDocRecord[]>;
  countByProject(projectId: string): Promise<number>;
  update(id: string, fields: GeneratedDocUpdate): Promise<void>;
  delete(id: string): Promise<void>;

  // generated_doc_versions
  createVersion(input: CreateGeneratedDocVersionInput): Promise<GeneratedDocVersionRecord>;
  getVersionById(id: string): Promise<GeneratedDocVersionRecord | null>;
  getLatestVersion(docId: string): Promise<GeneratedDocVersionRecord | null>;
  getMaxVersionNum(docId: string): Promise<number>;
  listVersions(docId: string): Promise<GeneratedDocVersionRecord[]>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: GeneratedDocRepository | null = null;

export async function initGeneratedDocRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbGeneratedDocRepository } = await import('./generated-docs-data-dynamodb.ts');
    _instance = new DynamoDbGeneratedDocRepository();
  } else {
    _instance = new SqliteGeneratedDocRepository();
  }
}

export function getGeneratedDocRepository(): GeneratedDocRepository {
  if (!_instance) _instance = new SqliteGeneratedDocRepository();
  return _instance;
}

export function setGeneratedDocRepository(repo: GeneratedDocRepository): void { _instance = repo; }
export function clearGeneratedDocRepository(): void { _instance = null; }
