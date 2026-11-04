/**
 * Knowledge base routes.
 *
 * Routes:
 *   GET    /api/projects/:id/knowledge             — list docs
 *   POST   /api/projects/:id/knowledge/upload      — multipart upload (max 50 MB)
 *   DELETE /api/projects/:id/knowledge/:docId      — delete doc
 *   GET    /api/projects/:id/knowledge/search?q=   — search (FTS5 on SQLite, inverted index on DynamoDB)
 *   POST   /api/projects/:id/knowledge/ask         — answer question from docs
 *   GET    /api/projects/:id/knowledge/decisions   — list decisions
 *   POST   /api/projects/:id/knowledge/decisions   — add decision
 */

import { registerBackgroundJob, runInBackground } from './background-jobs.ts';
import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { generateId, now, str, badRequest, notFound, forbidden } from './util.ts';
import { config } from './config.ts';
import { persistFile, restoreFile, forgetFile } from './durable-files.ts';
import { emit } from './events.ts';
import { convertToMarkdown } from './convert.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { getKnowledgeRepository } from './repositories/knowledge.ts';
import { splitPassages, rankPassages, excerptAround, ASK_SYSTEM, buildAskUser, citedNumbers, type Passage } from './knowledge-answer.ts';
import { retrieve, getSearchConfig, onDocumentReady, onDocumentDeleted } from './knowledge-search.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireMember(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
) {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const project = await getProjectRepository().getProjectById(projectId);
  if (!project || project.archived) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user.is_admin) return project;
  const member = await getProjectRepository().isMember(projectId, req.user.id);
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
    if (bodyStr[start] === '\r') start++;
    if (bodyStr[start] === '\n') start++;
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

    if (!filenameMatch) continue;

    const filename = filenameMatch[1].trim();
    const mimeType = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';
    return { filename, mimeType, data: fileData };
  }

  return null;
}

// ── Background processing ──────────────────────────────────────────────────────

async function processKnowledgeDoc(
  docId: string,
  projectId: string,
  filePath: string,
  mimeType: string,
  mdPath: string,
): Promise<void> {
  const repo = getKnowledgeRepository();
  try {
    // May run in another Lambda invocation than the upload: bring the file back from S3 first.
    await restoreFile(filePath);
    const markdown = await convertToMarkdown(filePath, mimeType);

    // Save markdown
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, markdown, 'utf8');
    await persistFile(mdPath, 'text/markdown');

    // Index in search
    await repo.indexDoc(docId, projectId, markdown);

    // Update status
    await repo.updateDoc(docId, { status: 'ready', markdown_path: mdPath, error: null });

    emit(projectId, { type: 'knowledge:ready', docId });

    // Bring the chosen search backends (meaning-based index, Knowledge Base copy) up to date. Never fails the upload.
    try {
      const project = await getProjectRepository().getProjectById(projectId);
      const doc = await repo.getDocById(docId);
      if (project && doc) await onDocumentReady({ id: projectId, slug: project.slug }, docId, doc.original_name || doc.name, markdown);
    } catch (e) { console.warn('[knowledge] search backends not updated:', e instanceof Error ? e.message : e); }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await repo.updateDoc(docId, { status: 'error', error: msg }).catch(() => {});
    emit(projectId, { type: 'knowledge:error', docId, error: msg });
  }
}

// ── Route registration ────────────────────────────────────────────────────────

/** The passages of the given documents that best match a question (their Markdown is read from storage). */
async function passagesFor(slug: string, docs: Array<{ docId: string; name: string }>, question: string, limit: number): Promise<Passage[]> {
  const all: Passage[] = [];
  for (const d of docs) {
    const abs = knowledgeDir(slug, `docs/md/${d.docId}.md`);
    try {
      if (!(await restoreFile(abs))) continue;
      all.push(...splitPassages(d.docId, d.name, fs.readFileSync(abs, 'utf8')));
    } catch { /* a document that cannot be read is skipped */ }
  }
  return rankPassages(all, question, limit);
}

export function registerKnowledgeRoutes(): void {
  registerBackgroundJob('knowledge-process', async (a) => {
    await processKnowledgeDoc(String(a.docId), String(a.projectId), String(a.filePath), String(a.mimeType), String(a.mdPath));
  });

  // GET /api/projects/:id/knowledge
  router.get('/api/projects/:id/knowledge', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await requireMember(req, res, req.params.id);
    if (!project) return;

    const docs = await getKnowledgeRepository().listDocs(req.params.id);
    sendJson(res, 200, { docs });
  });

  // POST /api/projects/:id/knowledge/upload
  router.post(
    '/api/projects/:id/knowledge/upload',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const project = await requireMember(req, res, req.params.id);
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
      const slug = project.slug;

      // Save original file
      const uploadsDir = knowledgeDir(slug, 'docs/uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      const safeFilename = path.basename(filename).replace(/[^\w.\-]/g, '_').slice(0, 200);
      const filePath = path.join(uploadsDir, `${docId}-${safeFilename}`);
      fs.writeFileSync(filePath, data);
      await persistFile(filePath);

      const doc = await getKnowledgeRepository().createDoc({
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

      // Background conversion (started before replying: on Lambda the instance freezes after the reply).
      const mdPath = knowledgeDir(slug, `docs/md/${docId}.md`);
      await runInBackground('knowledge-process', { docId, projectId: req.params.id, filePath, mimeType, mdPath });

      sendJson(res, 200, { doc });
    },
  );

  // DELETE /api/projects/:id/knowledge/:docId
  router.delete(
    '/api/projects/:id/knowledge/:docId',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const project = await requireMember(req, res, req.params.id);
      if (!project) return;

      const doc = await getKnowledgeRepository().getDocById(req.params.docId);
      if (!doc || doc.project_id !== req.params.id) {
        sendJson(res, 404, { error: 'Document not found' });
        return;
      }

      await getKnowledgeRepository().deleteDoc(req.params.docId);

      // Remove files (best effort)
      const slug = project.slug;
      const uploadsDir = knowledgeDir(slug, 'docs/uploads');
      try {
        for (const f of fs.readdirSync(uploadsDir)) {
          if (f.startsWith(req.params.docId + '-')) {
            fs.rmSync(path.join(uploadsDir, f), { force: true });
            await forgetFile(path.join(uploadsDir, f)).catch(() => {});
          }
        }
      } catch {
        // non-fatal
      }
      if (doc.markdown_path) {
        try {
          fs.rmSync(String(doc.markdown_path), { force: true });
          await forgetFile(String(doc.markdown_path)).catch(() => {});
        } catch {
          // non-fatal
        }
      }

      await onDocumentDeleted({ id: String(project.id), slug }, req.params.docId).catch(() => {});

      sendJson(res, 200, { ok: true });
    },
  );

  // GET /api/projects/:id/knowledge/search?q=
  router.get(
    '/api/projects/:id/knowledge/search',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const project = await requireMember(req, res, req.params.id);
      if (!project) return;

      const q = req.query.get('q') ?? '';
      if (!q.trim()) {
        sendJson(res, 200, { results: [] });
        return;
      }

      // Meaning-based or Knowledge Base search: the best passages, one result per document.
      const cfg = getSearchConfig(String(project.id));
      if (cfg.backend !== 'keyword') {
        const found = await retrieve({ id: String(project.id), slug: project.slug }, q, 15);
        const seen = new Set<string>();
        const docs = [];
        for (const p of found.passages) {
          if (seen.has(p.docId)) continue;
          seen.add(p.docId);
          docs.push({ docId: p.docId, name: p.docName, snippet: excerptAround(p.text, q), heading: p.heading || undefined });
        }
        sendJson(res, 200, { results: docs, via: found.via, note: found.note });
        return;
      }

      const results = await getKnowledgeRepository().searchDocs(req.params.id, q, 20);
      // Show the lines that matched instead of the start of the document (for the first few results).
      const head = results.slice(0, 8);
      const best = await passagesFor(project.slug, head.map((r) => ({ docId: r.docId, name: r.name })), q, 40);
      const withSnippets = results.map((r) => {
        const hit = best.find((p) => p.docId === r.docId);
        return hit ? { ...r, snippet: excerptAround(hit.text, q), heading: hit.heading || undefined } : r;
      });
      sendJson(res, 200, { results: withSnippets });
    },
  );

  // POST /api/projects/:id/knowledge/ask
  router.post('/api/projects/:id/knowledge/ask', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await requireMember(req, res, req.params.id);
    if (!project) return;

    const body = req.body as Record<string, unknown>;
    const question = str(body.question, 'question', { max: 2000 });

    // 1. The project's search backend (keywords, meaning-based index or Knowledge Base) finds the best passages.
    const found = await retrieve({ id: String(project.id), slug: project.slug }, question, 6);
    if (!found.passages.length) {
      sendJson(res, 200, { answer: null, needsTeam: true, via: found.via, searchNote: found.note });
      return;
    }
    const passages = found.passages;
    const sources = passages.map((p, i) => ({ n: i + 1, docId: p.docId, name: p.docName, heading: p.heading || undefined, snippet: excerptAround(p.text, question, 360) }));

    // 2. (the passages are numbered so the answer can cite them)
    // 3. A model answers from those passages only and cites them. Without a usable sign-in the passages themselves are the answer.
    try {
      const { callTextModel } = await import('./testing/model-provider.ts');
      const credentialId = typeof body.credentialId === 'string' && body.credentialId.trim() ? body.credentialId.trim() : null;
      const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
      const reply = (await callTextModel(ASK_SYSTEM, buildAskUser(question, passages), {
        createdBy: req.user!.id, credentialId, model, maxTokens: 1200,
      })).trim();
      if (!reply) throw new Error('The model returned no answer.');
      const used = citedNumbers(reply, passages.length);
      sendJson(res, 200, { answer: reply, mode: 'model', sources, cited: used, via: found.via, searchNote: found.note });
      return;
    } catch (e) {
      const why = String((e as { message?: string })?.message ?? e).slice(0, 200);
      const answer =
        `Based on the project documents:\n\n` +
        sources.map((x) => `**${x.name}${x.heading ? ` › ${x.heading}` : ''}**: ${x.snippet}`).join('\n\n');
      sendJson(res, 200, { answer, mode: 'passages', sources, cited: [], via: found.via, searchNote: found.note, note: `No model answered (${why}). These are the matching passages.` });
    }
  });

  // GET /api/projects/:id/knowledge/decisions
  router.get(
    '/api/projects/:id/knowledge/decisions',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const project = await requireMember(req, res, req.params.id);
      if (!project) return;

      const decisions = await getKnowledgeRepository().listDecisions(req.params.id);
      sendJson(res, 200, { decisions });
    },
  );

  // POST /api/projects/:id/knowledge/decisions
  router.post(
    '/api/projects/:id/knowledge/decisions',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const project = await requireMember(req, res, req.params.id);
      if (!project) return;

      const body = req.body as Record<string, unknown>;
      const question = str(body.question, 'question', { max: 2000 });
      const answer = str(body.answer, 'answer', { max: 10000 });

      const id = generateId();
      const decision = await getKnowledgeRepository().createDecision({
        id,
        project_id: req.params.id,
        question,
        answer,
        asked_by: req.user!.id,
        answered_by: req.user!.id,
        created_at: now(),
      });

      // Append to decisions.md (best effort)
      const slug = project.slug;
      const decisionsPath = knowledgeDir(slug, 'docs/decisions.md');
      try {
        fs.mkdirSync(path.dirname(decisionsPath), { recursive: true });
        const entry =
          `\n\n## Q: ${question}\n\n**A:** ${answer}\n\n*Recorded ${new Date().toISOString()}*`;
        fs.appendFileSync(decisionsPath, entry, 'utf8');
      } catch {
        // non-fatal
      }

      sendJson(res, 200, { decision });
    },
  );
}
