/**
 * Knowledge built from a project's repositories (docs/superpowers/specs/2026-11-21-knowledge-from-code-design.md).
 *
 * A generated document (Create › Documents) can be linked to Knowledge: `sources.knowledge = { on, docId }` in its sources_json. While
 * the link is on, every finished version is written into one Knowledge document (created the first time, overwritten and re-indexed
 * after that), so Search, Ask and Kyu answer from it. Deleting the Knowledge copy turns the link off.
 *
 *   POST /api/projects/:id/knowledge/build                  { repoIds, types? }  one linked generated document per type   (editors)
 *   PUT  /api/projects/:id/generated-docs/:docId/knowledge  { on }               link one document, or unlink and delete  (editors)
 */

import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import type { Row } from './db.ts';
import { config } from './config.ts';
import { generateId, now, parseJson } from './util.ts';
import { persistFile, restoreFile, forgetFile } from './durable-files.ts';
import { emit } from './events.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { getKnowledgeRepository } from './repositories/knowledge.ts';
import { getGeneratedDocRepository } from './repositories/generated-docs-data.ts';
import { getGitReposRepository } from './repositories/git-repos.ts';
import { onDocumentReady, onDocumentDeleted } from './knowledge-search.ts';
import { DOC_TYPE_LABELS, DOC_LIMITS, type DocType } from './generated-doc-text.ts';

/** The set "Build from repositories" makes when no types are given. The user guide needs a running system, so it is not in it. */
export const BUILD_TYPES: DocType[] = ['overview', 'architecture', 'api', 'runbook'];

export interface KnowledgeLink { on: boolean; docId?: string }

export function knowledgeLinkOf(sourcesJson: unknown): KnowledgeLink {
  const s = parseJson<Record<string, unknown>>(String(sourcesJson ?? '{}'), {});
  const k = s.knowledge as { on?: unknown; docId?: unknown } | undefined;
  return { on: k?.on === true, ...(typeof k?.docId === 'string' && k.docId ? { docId: k.docId } : {}) };
}

async function setLink(genDocId: string, sourcesJson: unknown, link: KnowledgeLink): Promise<void> {
  const s = parseJson<Record<string, unknown>>(String(sourcesJson ?? '{}'), {});
  s.knowledge = link;
  await getGeneratedDocRepository().update(genDocId, { sources_json: JSON.stringify(s) });
}

const mdPathFor = (slug: string, knowledgeDocId: string): string => path.join(config.dataDir, 'projects', slug, `docs/md/${knowledgeDocId}.md`);

/**
 * Write the latest version of a linked generated document into Knowledge. Returns the Knowledge document id, or null when the document
 * is not linked or has no Markdown yet. Never throws: Knowledge must not fail a generation.
 */
export async function syncGeneratedDocToKnowledge(projectId: string, genDocId: string): Promise<string | null> {
  try {
    const gen = await getGeneratedDocRepository().getById(genDocId, projectId);
    if (!gen) return null;
    const link = knowledgeLinkOf(gen.sources_json);
    if (!link.on || !gen.latest_version_id) return null;
    const version = (await getGeneratedDocRepository().listVersions(genDocId)).find((v) => v.id === gen.latest_version_id);
    if (!version?.md_path) return null;
    if (!(await restoreFile(version.md_path))) return null;
    const markdown = fs.readFileSync(version.md_path, 'utf8');
    const project = await getProjectRepository().getProjectById(projectId);
    if (!project) return null;

    const repo = getKnowledgeRepository();
    const existing = link.docId ? await repo.getDocById(link.docId) : null;
    const docId = existing && existing.project_id === projectId ? existing.id : generateId();
    const fileName = `${String(gen.name).replace(/[^\w.\- ]/g, '_').slice(0, 150)}.md`;
    if (!existing || existing.project_id !== projectId) {
      await repo.createDoc({
        id: docId, project_id: projectId, name: fileName, original_name: fileName, mime_type: 'text/markdown',
        size_bytes: Buffer.byteLength(markdown), status: 'processing', uploaded_by: gen.created_by, created_at: now(),
      });
    }
    const mdPath = mdPathFor(project.slug, docId);
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, markdown, 'utf8');
    await persistFile(mdPath, 'text/markdown');
    await repo.indexDoc(docId, projectId, markdown);
    await repo.updateDoc(docId, { status: 'ready', markdown_path: mdPath, error: null, name: fileName });
    if (link.docId !== docId) await setLink(genDocId, gen.sources_json, { on: true, docId });
    emit(projectId, { type: 'knowledge:ready', docId });
    await onDocumentReady({ id: projectId, slug: project.slug }, docId, fileName, markdown).catch((e) => console.warn('[knowledge-from-code] search backends not updated:', e instanceof Error ? e.message : e));
    return docId;
  } catch (e) {
    console.warn('[knowledge-from-code] could not update Knowledge:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** Knowledge documents that came from a generated document, by Knowledge document id. */
export async function generatedLinks(projectId: string): Promise<Map<string, { id: string; name: string; status: string; stale: boolean }>> {
  const out = new Map<string, { id: string; name: string; status: string; stale: boolean }>();
  for (const g of await getGeneratedDocRepository().listByProject(projectId)) {
    const link = knowledgeLinkOf(g.sources_json);
    if (link.on && link.docId) out.set(link.docId, { id: g.id, name: g.name, status: String(g.status ?? 'ready'), stale: Boolean(g.stale) });
  }
  return out;
}

/** The Knowledge copy was deleted: turn the link off so a later version does not bring it back. */
export async function unlinkKnowledgeDoc(projectId: string, knowledgeDocId: string): Promise<void> {
  for (const g of await getGeneratedDocRepository().listByProject(projectId)) {
    const link = knowledgeLinkOf(g.sources_json);
    if (link.docId === knowledgeDocId) await setLink(g.id, g.sources_json, { on: false });
  }
}

async function deleteKnowledgeCopy(project: { id: string; slug: string }, knowledgeDocId: string): Promise<void> {
  const repo = getKnowledgeRepository();
  const doc = await repo.getDocById(knowledgeDocId);
  if (!doc || doc.project_id !== project.id) return;
  await repo.deleteDoc(knowledgeDocId);
  const md = mdPathFor(project.slug, knowledgeDocId);
  try { fs.rmSync(md, { force: true }); await forgetFile(md).catch(() => {}); } catch { /* best effort */ }
  await onDocumentDeleted(project, knowledgeDocId).catch(() => {});
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** Signed in, the project exists, and the caller may create documents in it (admin, or a member who is not a viewer). */
async function editorProject(req: PortalRequest, res: PortalResponse, projectId: string): Promise<Row | null> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return null; }
  const projects = getProjectRepository();
  const project = await projects.getProjectById(projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  if (!req.user.is_admin) {
    const member = await projects.getMember(projectId, req.user.id);
    if (!member) { sendJson(res, 404, { error: 'Project not found' }); return null; }
    if (String(member.role) === 'viewer') { sendJson(res, 403, { error: 'Editors and above can create documents' }); return null; }
  }
  return project as unknown as Row;
}

export function registerKnowledgeFromCodeRoutes(): void {
  router.post('/api/projects/:id/knowledge/build', async (req: PortalRequest, res: PortalResponse) => {
    const project = await editorProject(req, res, String(req.params.id));
    if (!project) return;
    const projectId = String(project.id);
    const body = (req.body ?? {}) as { repoIds?: unknown; types?: unknown };
    const repoIds = Array.isArray(body.repoIds) ? [...new Set(body.repoIds.map(String))] : [];
    if (!repoIds.length) { sendJson(res, 400, { error: 'Choose at least one repository' }); return; }
    const repos = await getGitReposRepository().listByProject(projectId);
    const chosen = repoIds.map((id) => repos.find((r) => r.id === id));
    if (chosen.some((r) => !r)) { sendJson(res, 400, { error: 'A chosen repository is not in this project' }); return; }
    const types = body.types === undefined ? BUILD_TYPES : Array.isArray(body.types) ? [...new Set(body.types.map(String))] : [];
    if (!types.length || types.some((t) => !(t in DOC_TYPE_LABELS) || t === 'user-guide')) {
      sendJson(res, 400, { error: `types must be some of: ${BUILD_TYPES.join(', ')}` });
      return;
    }
    const count = await getGeneratedDocRepository().countByProject(projectId);
    if (count + types.length > DOC_LIMITS.perProject) {
      sendJson(res, 400, { error: `A project can hold at most ${DOC_LIMITS.perProject} generated documents; delete some first` });
      return;
    }
    const repoNames = chosen.map((r) => r!.name).join(', ');
    const { createGeneratedDoc } = await import('./generated-docs.ts');
    const docs = [];
    for (const t of types as DocType[]) {
      const name = `${DOC_TYPE_LABELS[t]} · ${repoNames}`.slice(0, DOC_LIMITS.titleChars);
      const r = await createGeneratedDoc(project, req.user!.id, { name, docType: t, sources: { repoIds } }, { knowledge: true });
      docs.push({ ...r.doc, workflow_id: r.doc.workflow_id ?? r.workflowId });
    }
    sendJson(res, 200, { docs });
  });

  router.put('/api/projects/:id/generated-docs/:docId/knowledge', async (req: PortalRequest, res: PortalResponse) => {
    const project = await editorProject(req, res, String(req.params.id));
    if (!project) return;
    const projectId = String(project.id);
    const on = (req.body as { on?: unknown } | undefined)?.on;
    if (typeof on !== 'boolean') { sendJson(res, 400, { error: 'on must be true or false' }); return; }
    const gen = await getGeneratedDocRepository().getById(String(req.params.docId), projectId);
    if (!gen) { sendJson(res, 404, { error: 'Document not found' }); return; }
    const link = knowledgeLinkOf(gen.sources_json);
    if (on) {
      await setLink(gen.id, gen.sources_json, { on: true, ...(link.docId ? { docId: link.docId } : {}) });
      const knowledgeDocId = await syncGeneratedDocToKnowledge(projectId, gen.id);
      sendJson(res, 200, { on: true, knowledgeDocId });
      return;
    }
    await setLink(gen.id, gen.sources_json, { on: false });
    if (link.docId) await deleteKnowledgeCopy({ id: projectId, slug: String(project.slug) }, link.docId);
    sendJson(res, 200, { on: false, knowledgeDocId: null });
  });
}
