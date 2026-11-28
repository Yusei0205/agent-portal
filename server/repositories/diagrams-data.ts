/**
 * Repository interface for diagrams and diagram_versions.
 *
 * DynamoDB table: portal-create (DYNAMODB_TABLE_PORTAL_CREATE, default 'portal-create')
 *
 * Key design:
 *   PK=DIAG#<id>  SK=#META     → canonical diagram item
 *   PK=DIAG#<diagId>  SK=DVER#<version>  → diagram_versions items
 * GSI-DiagByProject:
 *   PK=diagProjectId  SK=<updatedAt>#<id>
 */

import { SqliteDiagramRepository } from './diagrams-data-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ──────────────────────────────────────────────────────────────

export interface DiagramRecord {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  slug: string;
  focus: string;
  repo_ids: string;
  status: string;
  error: string | null;
  version: number;
  source_hash: string | null;
  stale: number;
  pending_workflow_id: string | null;
  pending_sources: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  format: string;
  style: string;
  cloud: string;
  lead_agent: string;
  trust_tools: number;
  workflow_id: string | null;
  ingested_run_id: string | null;
  attachment_ids: string;
}

export interface DiagramVersionRecord {
  diagram_id: string;
  version: number;
  mermaid: string;
  description: string;
  citations: string;
  sources: string;
  source_hash: string | null;
  workflow_id: string | null;
  run_id: string | null;
  created_by: string | null;
  created_at: string;
  format: string;
  style: string;
  cloud: string;
  drawio: string | null;
  stats: string;
}

export interface CreateDiagramInput {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  slug: string;
  focus: string;
  repo_ids: string;
  status: string;
  error: string | null;
  format: string;
  style: string;
  cloud: string;
  lead_agent: string;
  trust_tools: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  attachment_ids: string;
}

export interface CreateDiagramVersionInput {
  diagram_id: string;
  version: number;
  mermaid: string;
  description: string;
  citations: string;
  sources: string;
  source_hash: string | null;
  workflow_id: string | null;
  run_id: string | null;
  created_by: string | null;
  created_at: string;
  format: string;
  style: string;
  cloud: string;
  drawio: string | null;
  stats: string;
}

export type DiagramUpdate = Partial<Omit<DiagramRecord, 'id' | 'project_id' | 'created_by' | 'created_at'>>;

// ── Repository interface ───────────────────────────────────────────────────────

export interface DiagramRepository {
  // diagrams
  create(input: CreateDiagramInput): Promise<DiagramRecord>;
  getById(id: string): Promise<DiagramRecord | null>;
  getByProjectAndId(projectId: string, id: string): Promise<DiagramRecord | null>;
  getBySlug(projectId: string, slug: string): Promise<DiagramRecord | null>;
  slugExists(projectId: string, slug: string): Promise<boolean>;
  listByProject(projectId: string): Promise<DiagramRecord[]>;
  update(id: string, fields: DiagramUpdate): Promise<void>;
  delete(id: string): Promise<void>;

  // diagram_versions
  createVersion(input: CreateDiagramVersionInput): Promise<DiagramVersionRecord>;
  getLatestVersion(diagramId: string): Promise<DiagramVersionRecord | null>;
  listVersions(diagramId: string): Promise<DiagramVersionRecord[]>;
  getVersionByNumber(diagramId: string, version: number): Promise<DiagramVersionRecord | null>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: DiagramRepository | null = null;

export async function initDiagramRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbDiagramRepository } = await import('./diagrams-data-dynamodb.ts');
    _instance = new DynamoDbDiagramRepository();
  } else {
    _instance = new SqliteDiagramRepository();
  }
}

export function getDiagramRepository(): DiagramRepository {
  if (!_instance) _instance = new SqliteDiagramRepository();
  return _instance;
}

export function setDiagramRepository(repo: DiagramRepository): void { _instance = repo; }
export function clearDiagramRepository(): void { _instance = null; }
