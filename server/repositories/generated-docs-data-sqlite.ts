/**
 * SQLite implementation of GeneratedDocRepository.
 */

import { one, all, run as dbRun, insert, update } from '../db.ts';
import type { DbParam } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  GeneratedDocRepository,
  GeneratedDocRecord,
  GeneratedDocVersionRecord,
  CreateGeneratedDocInput,
  CreateGeneratedDocVersionInput,
  GeneratedDocUpdate,
} from './generated-docs-data.ts';

function toDoc(row: Row): GeneratedDocRecord {
  return {
    id:                String(row.id),
    project_id:        String(row.project_id),
    name:              String(row.name ?? ''),
    doc_type:          String(row.doc_type ?? ''),
    sources_json:      String(row.sources_json ?? '{}'),
    diagram_style:     String(row.diagram_style ?? 'mermaid'),
    diagram_cloud:     row.diagram_cloud != null ? String(row.diagram_cloud) : null,
    lead_agent:        row.lead_agent != null ? String(row.lead_agent) : null,
    trust_all_tools:   Number(row.trust_all_tools ?? 0),
    audience:          row.audience != null ? String(row.audience) : null,
    latest_version_id: row.latest_version_id != null ? String(row.latest_version_id) : null,
    stale:             Number(row.stale ?? 0),
    status:            String(row.status ?? 'ready'),
    error:             row.error != null ? String(row.error) : null,
    created_by:        row.created_by != null ? String(row.created_by) : null,
    created_at:        String(row.created_at ?? ''),
    attachment_ids:    String(row.attachment_ids ?? '[]'),
  };
}

function toVersion(row: Row): GeneratedDocVersionRecord {
  return {
    id:          String(row.id),
    doc_id:      String(row.doc_id),
    version_num: Number(row.version_num ?? 1),
    md_path:     row.md_path != null ? String(row.md_path) : null,
    docx_path:   row.docx_path != null ? String(row.docx_path) : null,
    warnings:    row.warnings != null ? String(row.warnings) : null,
    workflow_id: row.workflow_id != null ? String(row.workflow_id) : null,
    created_at:  String(row.created_at ?? ''),
  };
}

export class SqliteGeneratedDocRepository implements GeneratedDocRepository {
  async create(input: CreateGeneratedDocInput): Promise<GeneratedDocRecord> {
    insert('generated_docs', {
      id:                input.id,
      project_id:        input.project_id,
      name:              input.name,
      doc_type:          input.doc_type,
      sources_json:      input.sources_json,
      diagram_style:     input.diagram_style,
      diagram_cloud:     input.diagram_cloud,
      lead_agent:        input.lead_agent,
      trust_all_tools:   input.trust_all_tools,
      audience:          input.audience,
      latest_version_id: input.latest_version_id,
      stale:             input.stale,
      created_by:        input.created_by,
      created_at:        input.created_at,
      attachment_ids:    input.attachment_ids,
    });
    return toDoc(one<Row>('SELECT * FROM generated_docs WHERE id = ?', input.id)!);
  }

  async getById(id: string, projectId: string): Promise<GeneratedDocRecord | null> {
    const row = one<Row>('SELECT * FROM generated_docs WHERE id = ? AND project_id = ?', id, projectId);
    return row ? toDoc(row) : null;
  }

  async listByProject(projectId: string): Promise<GeneratedDocRecord[]> {
    const rows = all<Row>('SELECT * FROM generated_docs WHERE project_id = ? ORDER BY created_at DESC', projectId);
    return rows.map(toDoc);
  }

  async countByProject(projectId: string): Promise<number> {
    const row = one<{ n: number }>('SELECT COUNT(*) AS n FROM generated_docs WHERE project_id = ?', projectId);
    return Number(row?.n ?? 0);
  }

  async update(id: string, fields: GeneratedDocUpdate): Promise<void> {
    const dbFields: Record<string, unknown> = {};
    if (fields.name !== undefined)              dbFields.name = fields.name;
    if (fields.doc_type !== undefined)          dbFields.doc_type = fields.doc_type;
    if (fields.sources_json !== undefined)      dbFields.sources_json = fields.sources_json;
    if (fields.diagram_style !== undefined)     dbFields.diagram_style = fields.diagram_style;
    if (fields.diagram_cloud !== undefined)     dbFields.diagram_cloud = fields.diagram_cloud;
    if (fields.lead_agent !== undefined)        dbFields.lead_agent = fields.lead_agent;
    if (fields.trust_all_tools !== undefined)   dbFields.trust_all_tools = fields.trust_all_tools;
    if (fields.audience !== undefined)          dbFields.audience = fields.audience;
    if (fields.latest_version_id !== undefined) dbFields.latest_version_id = fields.latest_version_id;
    if (fields.stale !== undefined)             dbFields.stale = fields.stale;
    if (fields.status !== undefined)            dbFields.status = fields.status;
    if (fields.error !== undefined)             dbFields.error = fields.error;
    if (fields.attachment_ids !== undefined)    dbFields.attachment_ids = fields.attachment_ids;
    update('generated_docs', id, dbFields as Record<string, DbParam>);
  }

  async delete(id: string): Promise<void> {
    dbRun('DELETE FROM generated_docs WHERE id = ?', id);
  }

  async createVersion(input: CreateGeneratedDocVersionInput): Promise<GeneratedDocVersionRecord> {
    insert('generated_doc_versions', {
      id:          input.id,
      doc_id:      input.doc_id,
      version_num: input.version_num,
      md_path:     input.md_path,
      docx_path:   input.docx_path,
      warnings:    input.warnings,
      workflow_id: input.workflow_id,
      created_at:  input.created_at,
    });
    return toVersion(one<Row>('SELECT * FROM generated_doc_versions WHERE id = ?', input.id)!);
  }

  async getVersionById(id: string): Promise<GeneratedDocVersionRecord | null> {
    const row = one<Row>('SELECT * FROM generated_doc_versions WHERE id = ?', id);
    return row ? toVersion(row) : null;
  }

  async getLatestVersion(docId: string): Promise<GeneratedDocVersionRecord | null> {
    const row = one<Row>('SELECT * FROM generated_doc_versions WHERE doc_id = ? ORDER BY version_num DESC LIMIT 1', docId);
    return row ? toVersion(row) : null;
  }

  async getMaxVersionNum(docId: string): Promise<number> {
    const row = one<{ max_v: number }>('SELECT COALESCE(MAX(version_num), 0) AS max_v FROM generated_doc_versions WHERE doc_id = ?', docId);
    return Number(row?.max_v ?? 0);
  }

  async listVersions(docId: string): Promise<GeneratedDocVersionRecord[]> {
    const rows = all<Row>('SELECT * FROM generated_doc_versions WHERE doc_id = ? ORDER BY version_num DESC', docId);
    return rows.map(toVersion);
  }
}
