/**
 * Knowledge search backends, and the setup that chooses one per project.
 *
 *   keyword     the word index (default, nothing to set up)
 *   embeddings  the portal's own meaning-based index (Bedrock embeddings, stored with the documents), merged with keywords
 *   kb          an Amazon Bedrock Knowledge Base with S3 Vectors
 *
 * Search and Ask call retrieve(); it returns passages and says which backend answered. A backend that fails falls
 * back to the keyword search with a note, so a question is never left without an answer because of a setup problem.
 *
 *   GET  /api/projects/:id/knowledge/search-setup          the choice, and each backend's status
 *   PUT  /api/projects/:id/knowledge/search-setup          { backend, kb? }
 *   POST /api/projects/:id/knowledge/search-setup/index    index every ready document (embeddings)
 *   POST /api/projects/:id/knowledge/search-setup/sync     copy the documents and start an ingestion job (kb)
 *   POST /api/projects/:id/knowledge/search-setup/test     { backend } try the backend once
 */

import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getDb } from './db.ts';
import { config } from './config.ts';
import { getSetting, setSetting } from './settings.ts';
import { restoreFile } from './durable-files.ts';
import { registerBackgroundJob, runInBackground } from './background-jobs.ts';
import { appendAudit } from './audit.ts';
import { getMemberRow, getProjectRow } from './project-access.ts';
import { getKnowledgeRepository } from './repositories/knowledge.ts';
import { splitPassages, rankPassages, type Passage } from './knowledge-answer.ts';
import { embedTexts, indexDocument, forgetEmbeddings, searchEmbeddings, countIndexed, EMBED_MODEL } from './knowledge-embeddings.ts';
import { kbFromEnv, kbRetrieve, kbStartSync, kbSyncState, writeKbCopy, removeKbCopy, listKbCopies, type KbRef } from './knowledge-kb.ts';

export type SearchBackend = 'keyword' | 'embeddings' | 'kb';
export interface SearchConfig { backend: SearchBackend; kb?: KbRef }
export interface ProjectRef { id: string; slug: string }

const BACKENDS: SearchBackend[] = ['keyword', 'embeddings', 'kb'];
const settingKey = (projectId: string): string => `knowledge.search.${projectId}`;

export function getSearchConfig(projectId: string): SearchConfig {
  try {
    const raw = getSetting(getDb(), settingKey(projectId));
    if (!raw) return { backend: 'keyword' };
    const c = JSON.parse(raw) as Partial<SearchConfig>;
    return { backend: BACKENDS.includes(c.backend as SearchBackend) ? (c.backend as SearchBackend) : 'keyword', ...(c.kb ? { kb: c.kb } : {}) };
  } catch {
    return { backend: 'keyword' };
  }
}

async function saveSearchConfig(projectId: string, cfg: SearchConfig): Promise<void> {
  await setSetting(getDb(), settingKey(projectId), JSON.stringify(cfg));
}

const kbOf = (cfg: SearchConfig): KbRef | null => cfg.kb ?? kbFromEnv();

// ── Reading documents ─────────────────────────────────────────────────────────

const mdPath = (slug: string, docId: string): string => path.join(config.dataDir, 'projects', slug, 'docs', 'md', `${docId}.md`);

async function readMarkdown(slug: string, docId: string): Promise<string | null> {
  const abs = mdPath(slug, docId);
  try {
    if (!(await restoreFile(abs))) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

async function readyDocs(projectId: string): Promise<Array<{ docId: string; name: string }>> {
  return (await getKnowledgeRepository().listDocs(projectId))
    .filter((d) => d.status === 'ready')
    .map((d) => ({ docId: d.id, name: d.original_name || d.name }));
}

async function keywordPassages(project: ProjectRef, question: string, limit: number, pool = 6): Promise<Passage[]> {
  const candidates = await getKnowledgeRepository().searchDocs(project.id, question, pool).catch(() => []);
  const all: Passage[] = [];
  for (const c of candidates) {
    const md = await readMarkdown(project.slug, c.docId);
    if (md) all.push(...splitPassages(c.docId, c.name, md));
  }
  const ranked = rankPassages(all, question, limit);
  if (ranked.length) return ranked;
  // The index knows the document but its text could not be read: fall back to what the index kept.
  return candidates.slice(0, limit).map((c) => ({ docId: c.docId, docName: c.name, heading: '', text: c.snippet }));
}

/** Reciprocal-rank fusion of ranked lists of passages (the same passage in several lists scores higher). */
function fuse(lists: Passage[][], limit: number): Passage[] {
  const score = new Map<string, { p: Passage; s: number }>();
  for (const list of lists) {
    list.forEach((p, i) => {
      const k = `${p.docId}\u0000${p.text.slice(0, 120)}`;
      const cur = score.get(k);
      const add = 1 / (60 + i + 1);
      if (cur) cur.s += add; else score.set(k, { p, s: add });
    });
  }
  return [...score.values()].sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.p);
}

export interface Retrieved { passages: Passage[]; via: SearchBackend; note?: string }

/** The passages that best answer a question, by the project's chosen backend. */
export async function retrieve(project: ProjectRef, question: string, limit: number): Promise<Retrieved> {
  const cfg = getSearchConfig(project.id);
  if (cfg.backend === 'embeddings') {
    try {
      const docs = await readyDocs(project.id);
      const vectors = await searchEmbeddings(project.slug, docs, question, limit * 2);
      if (vectors.length) {
        const words = await keywordPassages(project, question, limit * 2, 8);
        return { passages: fuse([vectors, words], limit), via: 'embeddings' };
      }
      return { passages: await keywordPassages(project, question, limit), via: 'keyword', note: 'No document is indexed for meaning-based search yet, so keywords were used. Index the documents in Search setup.' };
    } catch (e) {
      return { passages: await keywordPassages(project, question, limit), via: 'keyword', note: `Meaning-based search failed (${msg(e)}); keywords were used.` };
    }
  }
  if (cfg.backend === 'kb') {
    const kb = kbOf(cfg);
    try {
      if (!kb) throw new Error('no Knowledge Base is set up');
      const hits = await kbRetrieve(kb, project.slug, question, limit);
      if (hits.length) {
        const names = new Map((await readyDocs(project.id)).map((d) => [d.docId, d.name]));
        return { passages: hits.map((h) => ({ docId: h.docId, docName: names.get(h.docId) ?? h.docId, heading: '', text: h.text })), via: 'kb' };
      }
      return { passages: await keywordPassages(project, question, limit), via: 'keyword', note: 'The Knowledge Base returned nothing for this question (is it synced?), so keywords were used.' };
    } catch (e) {
      return { passages: await keywordPassages(project, question, limit), via: 'keyword', note: `The Knowledge Base failed (${msg(e)}); keywords were used.` };
    }
  }
  return { passages: await keywordPassages(project, question, limit), via: 'keyword' };
}

const msg = (e: unknown): string => String((e as { message?: string })?.message ?? e).replace(/\s+/g, ' ').slice(0, 160);

// ── Hooks from the document lifecycle ─────────────────────────────────────────

/** A document finished converting: bring the chosen backends up to date (best effort). */
export async function onDocumentReady(project: ProjectRef, docId: string, name: string, markdown: string): Promise<void> {
  const cfg = getSearchConfig(project.id);
  if (cfg.backend === 'embeddings') {
    await indexDocument(project.slug, docId, name, markdown).catch((e) => console.warn('[knowledge] indexing failed:', msg(e)));
  }
  const kb = kbOf(cfg);
  if (kb) {
    await writeKbCopy(project.slug, docId, markdown).catch((e) => console.warn('[knowledge] KB copy failed:', msg(e)));
    if (cfg.backend === 'kb') await kbStartSync(kb).catch((e) => console.warn('[knowledge] KB sync failed:', msg(e)));
  }
}

export async function onDocumentDeleted(project: ProjectRef, docId: string): Promise<void> {
  await forgetEmbeddings(project.slug, docId).catch(() => {});
  await removeKbCopy(project.slug, docId).catch(() => {});
  const cfg = getSearchConfig(project.id);
  const kb = kbOf(cfg);
  if (kb && cfg.backend === 'kb') await kbStartSync(kb).catch(() => {});
}

// ── Setup routes ──────────────────────────────────────────────────────────────

async function access(req: PortalRequest, res: PortalResponse, projectId: string, edit: boolean): Promise<ProjectRef | null> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return null; }
  const project = await getProjectRow(projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  const ref = { id: String(project.id), slug: String(project.slug) };
  if (req.user.is_admin) return ref;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  if (edit && !['editor', 'owner'].includes(String(member.access ?? ''))) {
    sendJson(res, 403, { error: 'Project editor access is needed to change the search setup' });
    return null;
  }
  return ref;
}

const KB_ID_RE = /^[A-Za-z0-9]{10}$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function registerKnowledgeSearchRoutes(): void {
  registerBackgroundJob('knowledge-embed', async (a) => {
    const project = await getProjectRow(String(a.projectId));
    if (!project) return;
    const ref = { id: String(project.id), slug: String(project.slug) };
    for (const d of await readyDocs(ref.id)) {
      const md = await readMarkdown(ref.slug, d.docId);
      if (md) await indexDocument(ref.slug, d.docId, d.name, md).catch((e) => console.warn('[knowledge] indexing failed:', d.docId, msg(e)));
    }
  });

  router.get('/api/projects/:id/knowledge/search-setup', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await access(req, res, req.params.id, false);
    if (!project) return;
    const cfg = getSearchConfig(project.id);
    const docs = await readyDocs(project.id);
    const kb = kbOf(cfg);
    let kbInfo: Record<string, unknown> = { configured: false };
    if (kb) {
      const copies = await listKbCopies(project.slug).catch(() => new Set<string>());
      let sync: unknown = null;
      let syncError: string | null = null;
      try { sync = await kbSyncState(kb); } catch (e) { syncError = msg(e); }
      kbInfo = {
        configured: true,
        source: cfg.kb ? 'custom' : 'deployment',
        knowledgeBaseId: kb.knowledgeBaseId,
        dataSourceId: kb.dataSourceId,
        region: kb.region,
        copied: docs.filter((d) => copies.has(d.docId)).length,
        sync,
        syncError,
      };
    }
    sendJson(res, 200, {
      backend: cfg.backend,
      total: docs.length,
      embeddings: { model: EMBED_MODEL, indexed: await countIndexed(project.slug, docs.map((d) => d.docId)) },
      kb: kbInfo,
      deploymentHasKb: Boolean(kbFromEnv()),
    });
  });

  router.put('/api/projects/:id/knowledge/search-setup', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await access(req, res, req.params.id, true);
    if (!project) return;
    const body = (req.body ?? {}) as { backend?: unknown; kb?: { knowledgeBaseId?: unknown; dataSourceId?: unknown; region?: unknown } | null };
    if (!BACKENDS.includes(body.backend as SearchBackend)) { sendJson(res, 400, { error: 'backend must be keyword, embeddings or kb' }); return; }
    const next: SearchConfig = { backend: body.backend as SearchBackend };
    if (body.kb && typeof body.kb === 'object' && (body.kb.knowledgeBaseId || body.kb.dataSourceId)) {
      const knowledgeBaseId = String(body.kb.knowledgeBaseId ?? '').trim();
      const dataSourceId = String(body.kb.dataSourceId ?? '').trim();
      const region = String(body.kb.region ?? '').trim() || (process.env.AWS_REGION || 'ap-southeast-1');
      if (!KB_ID_RE.test(knowledgeBaseId) || !KB_ID_RE.test(dataSourceId)) { sendJson(res, 400, { error: 'The Knowledge Base id and data source id are each 10 letters and digits, as shown in the Bedrock console.' }); return; }
      if (!REGION_RE.test(region)) { sendJson(res, 400, { error: 'The region looks wrong, for example ap-southeast-1.' }); return; }
      next.kb = { knowledgeBaseId, dataSourceId, region };
    } else {
      const old = getSearchConfig(project.id);
      if (old.kb) next.kb = old.kb;
    }
    if (next.backend === 'kb' && !kbOf(next)) { sendJson(res, 400, { error: 'No Knowledge Base is set up. Enter the ids of one, or deploy the portal with the Knowledge Base option.' }); return; }
    await saveSearchConfig(project.id, next);
    try { appendAudit(null, req.user!.id, 'knowledge.search-setup', `${project.id}:${next.backend}`, null, null); } catch { /* audit must not break a request */ }
    sendJson(res, 200, { backend: next.backend });
  });

  router.post('/api/projects/:id/knowledge/search-setup/index', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await access(req, res, req.params.id, true);
    if (!project) return;
    const total = (await readyDocs(project.id)).length;
    if (total) await runInBackground('knowledge-embed', { projectId: project.id });
    sendJson(res, 202, { queued: total });
  });

  router.post('/api/projects/:id/knowledge/search-setup/sync', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await access(req, res, req.params.id, true);
    if (!project) return;
    const kb = kbOf(getSearchConfig(project.id));
    if (!kb) { sendJson(res, 400, { error: 'No Knowledge Base is set up.' }); return; }
    try {
      const have = await listKbCopies(project.slug);
      let copied = 0;
      for (const d of await readyDocs(project.id)) {
        if (have.has(d.docId)) continue;
        const md = await readMarkdown(project.slug, d.docId);
        if (md) { await writeKbCopy(project.slug, d.docId, md); copied++; }
      }
      const jobId = await kbStartSync(kb);
      sendJson(res, 202, { jobId, copied });
    } catch (e) {
      sendJson(res, 502, { error: `Could not start the sync: ${msg(e)}` });
    }
  });

  router.post('/api/projects/:id/knowledge/search-setup/test', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await access(req, res, req.params.id, false);
    if (!project) return;
    const which = String((req.body as { backend?: unknown } | undefined)?.backend ?? '');
    try {
      if (which === 'embeddings') {
        await embedTexts(['connection test'], 'search_query');
        sendJson(res, 200, { ok: true, message: `The embedding model ${EMBED_MODEL} answered.` });
      } else if (which === 'kb') {
        const kb = kbOf(getSearchConfig(project.id));
        if (!kb) { sendJson(res, 200, { ok: false, message: 'No Knowledge Base is set up.' }); return; }
        const hits = await kbRetrieve(kb, project.slug, 'connection test', 1);
        sendJson(res, 200, { ok: true, message: `The Knowledge Base answered (${hits.length} matching passage${hits.length === 1 ? '' : 's'} for the test question).` });
      } else {
        sendJson(res, 200, { ok: true, message: 'Keyword search needs no setup.' });
      }
    } catch (e) {
      sendJson(res, 200, { ok: false, message: msg(e) });
    }
  });
}
