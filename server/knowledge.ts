/**
 * Knowledge base routes.
 *
 * Routes:
 *   GET    /api/projects/:id/knowledge             — list docs
 *   POST   /api/projects/:id/knowledge/upload      — multipart upload (max 50 MB)
 *   DELETE /api/projects/:id/knowledge/:docId      — delete doc
 *   GET    /api/projects/:id/knowledge/search?q=   — FTS5 search
 *   POST   /api/projects/:id/knowledge/ask         — answer question from docs
 *   GET    /api/projects/:id/knowledge/decisions   — list decisions
 *   POST   /api/projects/:id/knowledge/decisions   — add decision
 */

import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { all, one, run, insert, getDb } from './db.ts';
import type { Row } from './db.ts';
import { generateId, now, str, badRequest, notFound, forbidden } from './util.ts';
import { config } from './config.ts';
import { emit } from './events.ts';
import { convertToMarkdown } from './convert.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireMember(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): Row | null {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const project = one<Row>('SELECT * FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user.is_admin) return project;
  const member = one<Row>(
    'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  return project;
}

function knowledgeDir(projectSlug: string, sub: string): string {
  return path.join(config.dataDir, 'projects', projectSlug, sub);
}

// ── Multipart body reader ─────────────────────────────────────────────────────

interface UploadedFile {
  filename: string;
  mimeType: string;
  data: Buffer;
}

function parseMultipartFile(
  rawBody: Buffer,
  contentType: string,
): UploadedFile | null {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) throw badRequest('Missing multipart boundary');
  const boundary = '--' + boundaryMatch[1];

  const bodyStr = rawBody.toString('binary');
  const boundaryBuf = Buffer.from(boundary, 'utf8');

  // Split on boundary
  const parts: Buffer[] = [];
  let start = 0;
  while (true) {
    const idx = bodyStr.indexOf(boundary, start);
    if (idx < 0) break;
    if (start > 0) {
      let end = idx;
      if (bodyStr[end - 1] === '\n') end--;
      if (bodyStr[end - 1] === '\r') end--;
      parts.push(rawBody.slice(start, end));
    }
    start = idx + boundaryBuf.length;
    // skip CRLF after boundary
    if (bodyStr[start] === '\r') start++;
    if (bodyStr[start] === '\n') start++;
    // check for terminal --
    if (bodyStr.slice(idx + boundaryBuf.length, idx + boundaryBuf.length + 2) === '--') break;
  }

  for (const part of parts) {
    const partStr = part.toString('binary');
    const headerEnd = partStr.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerSection = partStr.slice(0, headerEnd);
    const fileData = part.slice(headerEnd + 4);

    const filenameMatch = headerSection.match(/Content-Disposition:[^\r\n]*filename="([^"]+)"/i);
    const ctMatch = headerSection.match(/Content-Type:\s*([^\r\n]+)/i);

    if (!filenameMatch) continue; // skip non-file fields

    const filename = filenameMatch[1].trim();
    const mimeType = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';
    return { filename, mimeType, data: fileData };
  }

  return null;
}

// ── FTS helpers ───────────────────────────────────────────────────────────────

/** Split text into ~500-char chunks at word boundaries. */
function chunkText(text: string, size = 500): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + size, text.length);
    // Move end back to a word boundary
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

function indexDocInFts(docId: string, text: string): void {
  const db = getDb();
  // Remove existing FTS rows for this doc
  db.exec(`DELETE FROM knowledge_search WHERE doc_id = '${docId.replace(/'/g, "''")}'`);
  const chunks = chunkText(text);
  const stmt = db.prepare('INSERT INTO knowledge_search (doc_id, content) VALUES (?, ?)');
  for (const chunk of chunks) {
    stmt.run(docId, chunk);
  }
}

// ── Background processing ──────────────────────────────────────────────────────

async function processKnowledgeDoc(
  docId: string,
  filePath: string,
  mimeType: string,
  mdPath: string,
): Promise<void> {
  try {
    const markdown = await convertToMarkdown(filePath, mimeType);

    // Save markdown
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, markdown, 'utf8');

    // Index in FTS
    indexDocInFts(docId, markdown);

    // Update status
    run(
      "UPDATE knowledge_docs SET status = 'ready', markdown_path = ?, error = NULL WHERE id = ?",
      mdPath,
      docId,
    );

    // Look up project_id for SSE emit
    const doc = one<Row>('SELECT project_id FROM knowledge_docs WHERE id = ?', docId);
    if (doc) {
      emit(String(doc.project_id), { type: 'knowledge:ready', docId });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    run("UPDATE knowledge_docs SET status = 'error', error = ? WHERE id = ?", msg, docId);
    const doc = one<Row>('SELECT project_id FROM knowledge_docs WHERE id = ?', docId);
    if (doc) {
      emit(String(doc.project_id), { type: 'knowledge:error', docId, error: msg });
    }
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerKnowledgeRoutes(): void {

  // GET /api/projects/:id/knowledge
  router.get('/api/projects/:id/knowledge', (req: PortalRequest, res: PortalResponse): void => {
    const project = requireMember(req, res, req.params.id);
    if (!project) return;

    const docs = all<Row>(
      'SELECT * FROM knowledge_docs WHERE project_id = ? ORDER BY created_at DESC',
      req.params.id,
    );
    sendJson(res, 200, { docs });
  });

  // POST /api/projects/:id/knowledge/upload
  router.post(
    '/api/projects/:id/knowledge/upload',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const project = requireMember(req, res, req.params.id);
      if (!project) return;

      let uploaded: ReturnType<typeof parseMultipartFile>;
      try {
        if (!req.rawBody || !req.rawBody.length) {
          throw badRequest('No file data received');
        }
        const contentType = String(req.headers['content-type'] ?? '');
        uploaded = parseMultipartFile(req.rawBody, contentType);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { error: msg });
        return;
      }

      if (!uploaded) {
        sendJson(res, 400, { error: 'No file found in upload' });
        return;
      }

      const { filename, mimeType, data } = uploaded;
      const docId = generateId();
      const slug = project.slug as string;

      // Save original file
      const uploadsDir = knowledgeDir(slug, 'docs/uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      const safeFilename = path.basename(filename).replace(/[^\w.\-]/g, '_').slice(0, 200);
      const filePath = path.join(uploadsDir, `${docId}-${safeFilename}`);
      fs.writeFileSync(filePath, data);

      // Insert DB row (status=processing)
      insert('knowledge_docs', {
        id: docId,
        project_id: req.params.id,
        name: safeFilename,
        original_name: filename,
        mime_type: mimeType,
        size_bytes: data.length,
        status: 'processing',
        uploaded_by: req.user!.id,
        created_at: now(),
      });

      const doc = one<Row>('SELECT * FROM knowledge_docs WHERE id = ?', docId);
      sendJson(res, 200, { doc });

      // Background conversion
      const mdPath = knowledgeDir(slug, `docs/md/${docId}.md`);
      setImmediate(() => {
        processKnowledgeDoc(docId, filePath, mimeType, mdPath).catch(() => {
          // already handled inside
        });
      });
    },
  );

  // DELETE /api/projects/:id/knowledge/:docId
  router.delete(
    '/api/projects/:id/knowledge/:docId',
    (req: PortalRequest, res: PortalResponse): void => {
      const project = requireMember(req, res, req.params.id);
      if (!project) return;

      const doc = one<Row>(
        'SELECT * FROM knowledge_docs WHERE id = ? AND project_id = ?',
        req.params.docId,
        req.params.id,
      );
      if (!doc) {
        sendJson(res, 404, { error: 'Document not found' });
        return;
      }

      // Remove FTS entries
      try {
        getDb().exec(
          `DELETE FROM knowledge_search WHERE doc_id = '${req.params.docId.replace(/'/g, "''")}'`,
        );
      } catch {
        // non-fatal
      }

      // Remove DB row
      run('DELETE FROM knowledge_docs WHERE id = ?', req.params.docId);

      // Remove files (best effort)
      const slug = project.slug as string;
      const uploadsDir = knowledgeDir(slug, 'docs/uploads');
      try {
        for (const f of fs.readdirSync(uploadsDir)) {
          if (f.startsWith(req.params.docId + '-')) {
            fs.rmSync(path.join(uploadsDir, f), { force: true });
          }
        }
      } catch {
        // non-fatal
      }
      if (doc.markdown_path) {
        try {
          fs.rmSync(String(doc.markdown_path), { force: true });
        } catch {
          // non-fatal
        }
      }

      sendJson(res, 200, { ok: true });
    },
  );

  // GET /api/projects/:id/knowledge/search?q=
  router.get(
    '/api/projects/:id/knowledge/search',
    (req: PortalRequest, res: PortalResponse): void => {
      const project = requireMember(req, res, req.params.id);
      if (!project) return;

      const q = req.query.get('q') ?? '';
      if (!q.trim()) {
        sendJson(res, 200, { results: [] });
        return;
      }

      // FTS5 search — join back to knowledge_docs to filter by project
      const rows = all<Row>(
        `SELECT ks.doc_id, kd.name,
                snippet(knowledge_search, 1, '⟦', '⟧', '…', 20) AS snippet
           FROM knowledge_search ks
           JOIN knowledge_docs kd ON kd.id = ks.doc_id
          WHERE kd.project_id = ?
            AND knowledge_search MATCH ?
          ORDER BY rank
          LIMIT 20`,
        req.params.id,
        q,
      );

      sendJson(res, 200, { results: rows.map((r) => ({
        docId: r.doc_id,
        name: r.name,
        snippet: r.snippet,
      })) });
    },
  );

  // POST /api/projects/:id/knowledge/ask
  router.post('/api/projects/:id/knowledge/ask', (req: PortalRequest, res: PortalResponse): void => {
    const project = requireMember(req, res, req.params.id);
    if (!project) return;

    const body = req.body as Record<string, unknown>;
    const question = str(body.question, 'question', { max: 2000 });

    // Search FTS for relevant chunks
    let rows: Row[] = [];
    try {
      rows = all<Row>(
        `SELECT ks.doc_id, kd.name,
                snippet(knowledge_search, 1, '⟦', '⟧', '…', 30) AS snippet
           FROM knowledge_search ks
           JOIN knowledge_docs kd ON kd.id = ks.doc_id
          WHERE kd.project_id = ?
            AND knowledge_search MATCH ?
          ORDER BY rank
          LIMIT 5`,
        req.params.id,
        question,
      );
    } catch {
      // FTS match can fail for odd query strings — treat as no results
    }

    if (!rows.length) {
      sendJson(res, 200, { answer: null, needsTeam: true });
      return;
    }

    // Simple synthesis: concatenate snippets as answer with sources
    const sources = rows.map((r) => ({
      docId: r.doc_id as string,
      name: r.name as string,
      snippet: r.snippet as string,
    }));

    const answer =
      `Based on the project documents:\n\n` +
      sources.map((s) => `**${s.name}**: ${s.snippet}`).join('\n\n');

    sendJson(res, 200, { answer, sources });
  });

  // GET /api/projects/:id/knowledge/decisions
  router.get(
    '/api/projects/:id/knowledge/decisions',
    (req: PortalRequest, res: PortalResponse): void => {
      const project = requireMember(req, res, req.params.id);
      if (!project) return;

      const decisions = all<Row>(
        'SELECT * FROM knowledge_decisions WHERE project_id = ? ORDER BY created_at DESC',
        req.params.id,
      );
      sendJson(res, 200, { decisions });
    },
  );

  // POST /api/projects/:id/knowledge/decisions
  router.post(
    '/api/projects/:id/knowledge/decisions',
    (req: PortalRequest, res: PortalResponse): void => {
      const project = requireMember(req, res, req.params.id);
      if (!project) return;

      const body = req.body as Record<string, unknown>;
      const question = str(body.question, 'question', { max: 2000 });
      const answer = str(body.answer, 'answer', { max: 10000 });

      const id = generateId();
      insert('knowledge_decisions', {
        id,
        project_id: req.params.id,
        question,
        answer,
        asked_by: req.user!.id,
        answered_by: req.user!.id,
        created_at: now(),
      });

      // Append to decisions.md
      const slug = project.slug as string;
      const decisionsPath = knowledgeDir(slug, 'docs/decisions.md');
      try {
        fs.mkdirSync(path.dirname(decisionsPath), { recursive: true });
        const entry =
          `\n\n## Q: ${question}\n\n**A:** ${answer}\n\n*Recorded ${new Date().toISOString()}*`;
        fs.appendFileSync(decisionsPath, entry, 'utf8');
      } catch {
        // non-fatal
      }

      const decision = one<Row>('SELECT * FROM knowledge_decisions WHERE id = ?', id);
      sendJson(res, 200, { decision });
    },
  );
}
