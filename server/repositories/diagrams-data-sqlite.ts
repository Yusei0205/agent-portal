/**
 * SQLite implementation of DiagramRepository.
 */

import { one, all, run as dbRun, insert, update } from '../db.ts';
import type { DbParam } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  DiagramRepository,
  DiagramRecord,
  DiagramVersionRecord,
  CreateDiagramInput,
  CreateDiagramVersionInput,
  DiagramUpdate,
} from './diagrams-data.ts';

function toDiagram(row: Row): DiagramRecord {
  return {
    id:                  String(row.id),
    project_id:          String(row.project_id),
    kind:                String(row.kind ?? ''),
    title:               String(row.title ?? ''),
    slug:                String(row.slug ?? ''),
    focus:               String(row.focus ?? ''),
    repo_ids:            String(row.repo_ids ?? '[]'),
    status:              String(row.status ?? ''),
    error:               row.error != null ? String(row.error) : null,
    version:             Number(row.version ?? 0),
    source_hash:         row.source_hash != null ? String(row.source_hash) : null,
    stale:               Number(row.stale ?? 0),
    pending_workflow_id: row.pending_workflow_id != null ? String(row.pending_workflow_id) : null,
    pending_sources:     String(row.pending_sources ?? '[]'),
    created_by:          row.created_by != null ? String(row.created_by) : null,
    created_at:          String(row.created_at ?? ''),
    updated_at:          String(row.updated_at ?? ''),
    format:              String(row.format ?? 'mermaid'),
    style:               String(row.style ?? 'mermaid'),
    cloud:               String(row.cloud ?? ''),
    lead_agent:          String(row.lead_agent ?? ''),
    trust_tools:         Number(row.trust_tools ?? 0),
    workflow_id:         row.workflow_id != null ? String(row.workflow_id) : null,
    ingested_run_id:     row.ingested_run_id != null ? String(row.ingested_run_id) : null,
    attachment_ids:      String(row.attachment_ids ?? '[]'),
  };
}

function toVersion(row: Row): DiagramVersionRecord {
  return {
    diagram_id:  String(row.diagram_id),
    version:     Number(row.version ?? 0),
    mermaid:     String(row.mermaid ?? ''),
    description: String(row.description ?? ''),
    citations:   String(row.citations ?? '[]'),
    sources:     String(row.sources ?? '[]'),
    source_hash: row.source_hash != null ? String(row.source_hash) : null,
    workflow_id: row.workflow_id != null ? String(row.workflow_id) : null,
    run_id:      row.run_id != null ? String(row.run_id) : null,
    created_by:  row.created_by != null ? String(row.created_by) : null,
    created_at:  String(row.created_at ?? ''),
    format:      String(row.format ?? 'mermaid'),
    style:       String(row.style ?? 'mermaid'),
    cloud:       String(row.cloud ?? ''),
    drawio:      row.drawio != null ? String(row.drawio) : null,
    stats:       String(row.stats ?? '{}'),
  };
}

export class SqliteDiagramRepository implements DiagramRepository {
  async create(input: CreateDiagramInput): Promise<DiagramRecord> {
    insert('diagrams', {
      id:                  input.id,
      project_id:          input.project_id,
      kind:                input.kind,
      title:               input.title,
      slug:                input.slug,
      focus:               input.focus,
      repo_ids:            input.repo_ids,
      status:              input.status,
      error:               input.error,
      version:             0,
      source_hash:         null,
      stale:               0,
      pending_workflow_id: null,
      pending_sources:     '[]',
      created_by:          input.created_by,
      created_at:          input.created_at,
      updated_at:          input.updated_at,
      format:              input.format,
      style:               input.style,
      cloud:               input.cloud,
      lead_agent:          input.lead_agent,
      trust_tools:         input.trust_tools,
      workflow_id:         null,
      ingested_run_id:     null,
      attachment_ids:      input.attachment_ids,
    });
    return toDiagram(one<Row>('SELECT * FROM diagrams WHERE id = ?', input.id)!);
  }

  async getById(id: string): Promise<DiagramRecord | null> {
    const row = one<Row>('SELECT * FROM diagrams WHERE id = ?', id);
    return row ? toDiagram(row) : null;
  }

  async getByProjectAndId(projectId: string, id: string): Promise<DiagramRecord | null> {
    const row = one<Row>('SELECT * FROM diagrams WHERE project_id = ? AND id = ?', projectId, id);
    return row ? toDiagram(row) : null;
  }

  async getBySlug(projectId: string, slug: string): Promise<DiagramRecord | null> {
    const row = one<Row>('SELECT * FROM diagrams WHERE project_id = ? AND slug = ?', projectId, slug);
    return row ? toDiagram(row) : null;
  }

  async slugExists(projectId: string, slug: string): Promise<boolean> {
    return !!one<Row>('SELECT 1 FROM diagrams WHERE project_id = ? AND slug = ?', projectId, slug);
  }

  async listByProject(projectId: string): Promise<DiagramRecord[]> {
    const rows = all<Row>('SELECT * FROM diagrams WHERE project_id = ? ORDER BY updated_at DESC', projectId);
    return rows.map(toDiagram);
  }

  async update(id: string, fields: DiagramUpdate): Promise<void> {
    const dbFields: Record<string, unknown> = {};
    const k = Object.keys(fields) as (keyof DiagramUpdate)[];
    for (const key of k) {
      if (fields[key] !== undefined) dbFields[key as string] = fields[key];
    }
    update('diagrams', id, dbFields as Record<string, DbParam>);
  }

  async delete(id: string): Promise<void> {
    dbRun('DELETE FROM diagrams WHERE id = ?', id);
  }

  async createVersion(input: CreateDiagramVersionInput): Promise<DiagramVersionRecord> {
    insert('diagram_versions', {
      diagram_id:  input.diagram_id,
      version:     input.version,
      mermaid:     input.mermaid,
      description: input.description,
      citations:   input.citations,
      sources:     input.sources,
      source_hash: input.source_hash,
      workflow_id: input.workflow_id,
      run_id:      input.run_id,
      created_by:  input.created_by,
      created_at:  input.created_at,
      format:      input.format,
      style:       input.style,
      cloud:       input.cloud,
      drawio:      input.drawio,
      stats:       input.stats,
    });
    return toVersion(one<Row>('SELECT * FROM diagram_versions WHERE diagram_id = ? AND version = ?', input.diagram_id, input.version)!);
  }

  async getLatestVersion(diagramId: string): Promise<DiagramVersionRecord | null> {
    const row = one<Row>('SELECT * FROM diagram_versions WHERE diagram_id = ? ORDER BY version DESC LIMIT 1', diagramId);
    return row ? toVersion(row) : null;
  }

  async listVersions(diagramId: string): Promise<DiagramVersionRecord[]> {
    const rows = all<Row>('SELECT * FROM diagram_versions WHERE diagram_id = ? ORDER BY version DESC', diagramId);
    return rows.map(toVersion);
  }

  async getVersionByNumber(diagramId: string, version: number): Promise<DiagramVersionRecord | null> {
    const row = one<Row>('SELECT * FROM diagram_versions WHERE diagram_id = ? AND version = ?', diagramId, version);
    return row ? toVersion(row) : null;
  }
}
