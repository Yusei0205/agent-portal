/**
 * SQLite implementation of PresentationRepository.
 */

import { one, all, run as dbRun, insert, update } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  PresentationRepository,
  PresentationRecord,
  CreatePresentationInput,
  PresentationUpdate,
} from './presentations-data.ts';

function toRecord(row: Row): PresentationRecord {
  return {
    id:             String(row.id),
    project_id:     String(row.project_id),
    name:           String(row.name ?? ''),
    topic:          row.topic != null ? String(row.topic) : null,
    source_kind:    String(row.source_kind ?? ''),
    source_ref:     row.source_ref != null ? String(row.source_ref) : null,
    audience:       row.audience != null && String(row.audience) !== '' ? String(row.audience) : null,
    slide_count:    Number(row.slide_count ?? 10),
    diagram_style:  String(row.diagram_style ?? 'mermaid'),
    diagram_cloud:  row.diagram_cloud != null && String(row.diagram_cloud) !== '' ? String(row.diagram_cloud) : null,
    lead_agent:     row.lead_agent != null && String(row.lead_agent) !== '' ? String(row.lead_agent) : null,
    trust_all_tools: Number(row.trust_all_tools ?? 0),
    pptx_path:      row.pptx_path != null ? String(row.pptx_path) : null,
    preview_json:   row.preview_json != null ? String(row.preview_json) : null,
    workflow_id:    row.workflow_id != null ? String(row.workflow_id) : null,
    stale:          Number(row.stale ?? 0),
    status:         String(row.status ?? 'ready'),
    error:          row.error != null ? String(row.error) : null,
    created_by:     row.created_by != null ? String(row.created_by) : null,
    created_at:     String(row.created_at ?? ''),
    updated_at:     String(row.updated_at ?? ''),
    attachment_ids: String(row.attachment_ids ?? '[]'),
  };
}

export class SqlitePresentationRepository implements PresentationRepository {
  async create(input: CreatePresentationInput): Promise<PresentationRecord> {
    insert('presentations', {
      id:             input.id,
      project_id:     input.project_id,
      name:           input.name,
      topic:          input.topic,
      source_kind:    input.source_kind,
      source_ref:     input.source_ref,
      audience:       input.audience ?? '',
      slide_count:    input.slide_count,
      diagram_style:  input.diagram_style,
      diagram_cloud:  input.diagram_cloud ?? '',
      lead_agent:     input.lead_agent ?? '',
      trust_all_tools: input.trust_all_tools,
      pptx_path:      null,
      preview_json:   null,
      workflow_id:    null,
      stale:          0,
      attachment_ids: input.attachment_ids,
      created_by:     input.created_by,
      created_at:     input.created_at,
      updated_at:     input.updated_at,
    });
    return toRecord(one<Row>('SELECT * FROM presentations WHERE id = ?', input.id)!);
  }

  async getById(id: string, projectId: string): Promise<PresentationRecord | null> {
    const row = one<Row>('SELECT * FROM presentations WHERE id = ? AND project_id = ?', id, projectId);
    return row ? toRecord(row) : null;
  }

  async getByWorkflowId(workflowId: string): Promise<PresentationRecord | null> {
    const row = one<Row>('SELECT * FROM presentations WHERE workflow_id = ?', workflowId);
    return row ? toRecord(row) : null;
  }

  async listByProject(projectId: string): Promise<PresentationRecord[]> {
    const rows = all<Row>('SELECT * FROM presentations WHERE project_id = ? ORDER BY created_at DESC', projectId);
    return rows.map(toRecord);
  }

  async countByProject(projectId: string): Promise<number> {
    const row = one<{ n: number }>('SELECT COUNT(*) AS n FROM presentations WHERE project_id = ?', projectId);
    return Number(row?.n ?? 0);
  }

  async update(id: string, fields: PresentationUpdate): Promise<void> {
    const dbFields: Record<string, unknown> = {};
    if (fields.name !== undefined)          { dbFields.title = fields.name; dbFields.name = fields.name; }
    if (fields.topic !== undefined)         dbFields.topic = fields.topic;
    if (fields.source_ref !== undefined)    dbFields.source_ref = fields.source_ref;
    if (fields.audience !== undefined)      dbFields.audience = fields.audience;
    if (fields.slide_count !== undefined)   { dbFields.slide_count = fields.slide_count; dbFields.slide_target = fields.slide_count; }
    if (fields.diagram_style !== undefined) dbFields.diagram_style = fields.diagram_style;
    if (fields.diagram_cloud !== undefined) dbFields.diagram_cloud = fields.diagram_cloud ?? '';
    if (fields.lead_agent !== undefined)    dbFields.lead_agent = fields.lead_agent ?? '';
    if (fields.trust_all_tools !== undefined) { dbFields.trust_all_tools = fields.trust_all_tools; dbFields.trust_tools = fields.trust_all_tools; }
    if (fields.pptx_path !== undefined)     dbFields.pptx_path = fields.pptx_path;
    if (fields.preview_json !== undefined)  dbFields.preview_json = fields.preview_json;
    if (fields.workflow_id !== undefined)   dbFields.workflow_id = fields.workflow_id;
    if (fields.stale !== undefined)         dbFields.stale = fields.stale;
    if (fields.status !== undefined)        dbFields.status = fields.status;
    if (fields.error !== undefined)         dbFields.error = fields.error;
    if (fields.updated_at !== undefined)    dbFields.updated_at = fields.updated_at;
    if (fields.attachment_ids !== undefined) dbFields.attachment_ids = fields.attachment_ids;
    update('presentations', id, dbFields);
  }

  async delete(id: string): Promise<void> {
    dbRun('DELETE FROM presentations WHERE id = ?', id);
  }
}
