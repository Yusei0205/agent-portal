/**
 * Repository interface for ai_attachments.
 *
 * SQLite default; DynamoDB activated by USE_DYNAMODB=true.
 * DynamoDB table: portal-create (DYNAMODB_TABLE_PORTAL_CREATE, default 'portal-create')
 *
 * Key design:
 *   PK=ATT#<id>  SK=#META
 * GSI-AttByProject (portal-create):
 *   PK=attProjectId (<projectId>)  SK=<createdAt>#<id>
 * GSI-AttByParent (portal-create, sparse):
 *   PK=attParentKey (<parentKind>#<parentId>)  SK=<createdAt>#<id>
 */

import { SqliteAiAttachmentRepository } from './ai-attachments-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ──────────────────────────────────────────────────────────────

export type AttachmentKind = 'image' | 'document' | 'diagram';
export type AttachmentParentKind = 'diagram' | 'doc' | 'presentation';

export interface AiAttachmentRecord {
  id: string;
  project_id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  kind: AttachmentKind;
  file_path: string;
  parent_kind: AttachmentParentKind | null;
  parent_id: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export interface CreateAiAttachmentInput {
  id: string;
  project_id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  kind: AttachmentKind;
  file_path: string;
  parent_kind: AttachmentParentKind | null;
  parent_id: string | null;
  uploaded_by: string | null;
  created_at: string;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface AiAttachmentRepository {
  create(input: CreateAiAttachmentInput): Promise<AiAttachmentRecord>;
  getById(id: string): Promise<AiAttachmentRecord | null>;
  getByIdForProject(id: string, projectId: string): Promise<AiAttachmentRecord | null>;
  getByIds(ids: string[]): Promise<AiAttachmentRecord[]>;
  listByProject(projectId: string): Promise<AiAttachmentRecord[]>;
  listByParent(parentKind: AttachmentParentKind, parentId: string): Promise<AiAttachmentRecord[]>;
  listOrphanedBefore(cutoff: string): Promise<AiAttachmentRecord[]>;
  linkToParent(ids: string[], parentKind: AttachmentParentKind, parentId: string): Promise<void>;
  deleteByParent(parentKind: AttachmentParentKind, parentId: string): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
  deleteOrphanedBefore(cutoff: string): Promise<void>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: AiAttachmentRepository | null = null;

export async function initAiAttachmentRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbAiAttachmentRepository } = await import('./ai-attachments-dynamodb.ts');
    _instance = new DynamoDbAiAttachmentRepository();
  } else {
    _instance = new SqliteAiAttachmentRepository();
  }
}

export function getAiAttachmentRepository(): AiAttachmentRepository {
  if (!_instance) _instance = new SqliteAiAttachmentRepository();
  return _instance;
}

export function setAiAttachmentRepository(repo: AiAttachmentRepository): void { _instance = repo; }
export function clearAiAttachmentRepository(): void { _instance = null; }
