/**
 * SQLite implementation of KnowledgeRepository.
 *
 * All SQL for knowledge_docs, knowledge_search, and knowledge_decisions lives here.
 * Wraps synchronous node:sqlite helpers in Promise.resolve().
 */

import { one, all, run as dbRun, insert, getDb } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  KnowledgeRepository,
  KnowledgeDocRecord,
  KnowledgeDecisionRecord,
  SearchResult,
  CreateKnowledgeDocInput,
  UpdateDocPatch,
  CreateDecisionInput,
} from './knowledge.ts';

// ── Row converters ────────────────────────────────────────────────────────────

function toDocRecord(row: Row): KnowledgeDocRecord {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    name: String(row.name),
    original_name: String(row.original_name ?? row.name),
    mime_type: row.mime_type != null ? String(row.mime_type) : null,
    size_bytes: row.size_bytes != null ? Number(row.size_bytes) : null,
    markdown_path: row.markdown_path != null ? String(row.markdown_path) : null,
    status: String(row.status ?? 'processing') as KnowledgeDocRecord['status'],
    error: row.error != null ? String(row.error) : null,
    uploaded_by: row.uploaded_by != null ? String(row.uploaded_by) : null,
    created_at: String(row.created_at ?? ''),
    docVersion: 0,
  };
}

function toDecisionRecord(row: Row): KnowledgeDecisionRecord {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    question: String(row.question),
    answer: String(row.answer),
    asked_by: row.asked_by != null ? String(row.asked_by) : null,
    answered_by: row.answered_by != null ? String(row.answered_by) : null,
    created_at: String(row.created_at ?? ''),
  };
}

// ── FTS helpers ───────────────────────────────────────────────────────────────

/** Split text into ~500-char chunks at word boundaries (mirrors knowledge.ts logic). */
function chunkText(text: string, size = 500): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + size, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > pos) end = space;
    }
    const chunk = text.slice(pos, end).trim();
    if (chunk) chunks.push(chunk);
    pos = end + 1;
  }
  return chunks;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class SqliteKnowledgeRepository implements KnowledgeRepository {
  async listDocs(projectId: string): Promise<KnowledgeDocRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM knowledge_docs WHERE project_id = ? ORDER BY created_at DESC',
      projectId,
    );
    return rows.map(toDocRecord);
  }

  async getDocById(id: string): Promise<KnowledgeDocRecord | null> {
    const row = one<Row>('SELECT * FROM knowledge_docs WHERE id = ?', id);
    return row ? toDocRecord(row) : null;
  }

  async createDoc(input: CreateKnowledgeDocInput): Promise<KnowledgeDocRecord> {
    insert('knowledge_docs', {
      id: input.id,
      project_id: input.project_id,
      name: input.name,
      original_name: input.original_name,
      mime_type: input.mime_type,
      size_bytes: input.size_bytes,
      status: input.status,
      uploaded_by: input.uploaded_by,
      created_at: input.created_at,
    });
    const row = one<Row>('SELECT * FROM knowledge_docs WHERE id = ?', input.id)!;
    return toDocRecord(row);
  }

  async updateDoc(id: string, patch: UpdateDocPatch): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
    if (patch.markdown_path !== undefined) { sets.push('markdown_path = ?'); vals.push(patch.markdown_path); }
    if (patch.error !== undefined) { sets.push('error = ?'); vals.push(patch.error); }
    if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
    if (sets.length === 0) return;
    dbRun(`UPDATE knowledge_docs SET ${sets.join(', ')} WHERE id = ?`, ...(vals as string[]), id);
  }

  async deleteDoc(id: string): Promise<void> {
    await this.removeDocIndex(id);
    dbRun('DELETE FROM knowledge_docs WHERE id = ?', id);
  }

  async indexDoc(docId: string, _projectId: string, text: string): Promise<void> {
    const db = getDb();
    db.exec(`DELETE FROM knowledge_search WHERE doc_id = '${docId.replace(/'/g, "''")}'`);
    const chunks = chunkText(text);
    const stmt = db.prepare('INSERT INTO knowledge_search (doc_id, content) VALUES (?, ?)');
    for (const chunk of chunks) {
      stmt.run(docId, chunk);
    }
  }

  async removeDocIndex(docId: string): Promise<void> {
    try {
      getDb().exec(`DELETE FROM knowledge_search WHERE doc_id = '${docId.replace(/'/g, "''")}'`);
    } catch {
      // non-fatal
    }
  }

  async searchDocs(projectId: string, query: string, limit: number): Promise<SearchResult[]> {
    let rows: Row[] = [];
    try {
      rows = all<Row>(
        `SELECT ks.doc_id, kd.name,
                snippet(knowledge_search, 1, '⟦', '⟧', '…', 20) AS snippet
           FROM knowledge_search ks
           JOIN knowledge_docs kd ON kd.id = ks.doc_id
          WHERE kd.project_id = ?
            AND knowledge_search MATCH ?
          ORDER BY rank
          LIMIT ?`,
        projectId,
        query,
        limit,
      );
    } catch {
      // FTS match can fail for odd query strings
    }
    return rows.map((r) => ({
      docId: String(r.doc_id),
      name: String(r.name),
      snippet: String(r.snippet ?? ''),
    }));
  }

  async listDecisions(projectId: string): Promise<KnowledgeDecisionRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM knowledge_decisions WHERE project_id = ? ORDER BY created_at DESC',
      projectId,
    );
    return rows.map(toDecisionRecord);
  }

  async createDecision(input: CreateDecisionInput): Promise<KnowledgeDecisionRecord> {
    insert('knowledge_decisions', {
      id: input.id,
      project_id: input.project_id,
      question: input.question,
      answer: input.answer,
      asked_by: input.asked_by,
      answered_by: input.answered_by,
      created_at: input.created_at,
    });
    const row = one<Row>('SELECT * FROM knowledge_decisions WHERE id = ?', input.id)!;
    return toDecisionRecord(row);
  }
}
