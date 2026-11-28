import fs from 'node:fs/promises';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { config } from './config.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { getGitReposRepository } from './repositories/git-repos.ts';
import { readChecklist, writeChecklist, ChecklistConflict } from './repositories/project-checklists.ts';
import { PROVIDERS, analyzeRepository, generateChecklist, checklistMarkdown } from './project-checklist-analysis.ts';
import type { Checklist, ChecklistItem, ChecklistTarget, RepoAnalysis } from './project-checklist-analysis.ts';

async function access(req: PortalRequest, res: PortalResponse, edit = false) {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return null; }
  const repo = getProjectRepository();
  const project = await repo.getProjectById(req.params.id);
  if (!project || project.archived) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  if (req.user.is_admin) return project;
  const member = await repo.getMember(project.id, req.user.id);
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  if (edit && !['owner', 'editor'].includes(member.access) && member.role !== 'owner') {
    sendJson(res, 403, { error: 'Project editor access required' }); return null;
  }
  return project;
}

export async function analyzeProject(projectId: string, slug: string): Promise<RepoAnalysis[]> {
  const repos = await getGitReposRepository().listByProject(projectId);
  const base = path.resolve(config.dataDir, 'projects', slug, 'repos');
  const results: RepoAnalysis[] = [];
  for (const repo of repos) {
    const root = path.resolve(base, repo.name);
    const relative = path.relative(base, root);
    let safe = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    try {
      const actualBase = await fs.realpath(base);
      const actualRoot = await fs.realpath(root);
      const actualRelative = path.relative(actualBase, actualRoot);
      safe = safe && actualRelative !== '' && !actualRelative.startsWith('..') && !path.isAbsolute(actualRelative);
    } catch { safe = false; }
    results.push(await analyzeRepository(root, safe ? repo : { ...repo, status: 'unavailable' }));
  }
  return results;
}

/** Called after clone/sync as well as by the explicit regenerate action. */
export async function regenerateProjectChecklist(projectId: string, slug: string, expectedRevision?: number): Promise<Checklist> {
  const previous = await readChecklist(projectId);
  if (expectedRevision !== undefined && expectedRevision !== (previous?.revision ?? 0)) throw new ChecklistConflict('Checklist changed. Reload before regenerating.');
  const next = generateChecklist(previous, await analyzeProject(projectId, slug));
  await writeChecklist(projectId, previous, next);
  return next;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, optional = false): string {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) throw new Error(`Text must be ${optional ? '0' : '1'}–${max} characters.`);
  return value;
}
function identifier(value: unknown): string {
  const id = text(value, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid item or provider id.');
  return id;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Expected a list with up to ${max} entries.`);
  return value;
}
export function editChecklist(previous: Checklist | null, input: unknown, userId: string): Checklist {
  const body = record(input);
  if (body.revision !== (previous?.revision ?? 0)) throw new ChecklistConflict('Checklist changed. Reload before saving.');
  const targets: ChecklistTarget[] = list(body.targets, 20).map((v) => {
    const t = record(v);
    if (!PROVIDERS.includes(t.provider as ChecklistTarget['provider'])) throw new Error('Invalid provider.');
    return { id: identifier(t.id), provider: t.provider as ChecklistTarget['provider'], name: text(t.name, 120) };
  });
  if (new Set(targets.map((t) => t.id)).size !== targets.length) throw new Error('Provider ids must be unique.');
  const timestamp = new Date().toISOString();
  const items: ChecklistItem[] = list(body.items, 600).map((v) => {
    const i = record(v);
    const id = identifier(i.id);
    const old = previous?.items.find((item) => item.id === id);
    const targetId = text(i.targetId, 100, true);
    if (targetId && !targets.some((t) => t.id === targetId)) throw new Error('Item refers to an unknown provider.');
    if (i.kind !== 'deployment' && i.kind !== 'security') throw new Error('Invalid checklist kind.');
    if (!['pending', 'in_progress', 'approved', 'blocked', 'not_applicable'].includes(String(i.status))) throw new Error('Invalid review status.');
    const item: ChecklistItem = {
      id, targetId, kind: i.kind, category: text(i.category, 120), resource: text(i.resource, 240),
      requirement: text(i.requirement, 4000), evidence: list(i.evidence, 80).map((e) => text(e, 500)),
      status: i.status as ChecklistItem['status'], notes: text(i.notes, 4000, true), reviewedBy: old?.reviewedBy ?? null, reviewedAt: old?.reviewedAt ?? null,
    };
    if (!old || ['status', 'category', 'resource', 'requirement', 'notes', 'targetId', 'kind', 'evidence'].some((key) => JSON.stringify(old[key as keyof ChecklistItem]) !== JSON.stringify(item[key as keyof ChecklistItem]))) {
      item.reviewedBy = userId; item.reviewedAt = timestamp;
    }
    return item;
  });
  if (new Set(items.map((i) => i.id)).size !== items.length) throw new Error('Item ids must be unique.');
  const deleted = previous?.items.filter((i) => !items.some((n) => n.id === i.id)).map((i) => i.id) ?? [];
  const suppressed = [...new Set([...(previous?.suppressed ?? []), ...deleted])].filter((id) => !items.some((i) => i.id === id));
  return { version: 1, revision: (previous?.revision ?? 0) + 1, generatedAt: previous?.generatedAt ?? null, updatedAt: timestamp, targets, items, suppressed, analysis: previous?.analysis ?? [] };
}
function failure(res: PortalResponse, error: unknown) {
  if (error instanceof ChecklistConflict) sendJson(res, 409, { error: error.message });
  else if ((error as Error).message.startsWith('Checklist is too large')) sendJson(res, 400, { error: (error as Error).message });
  else throw error;
}

export function registerProjectChecklistRoutes(): void {
  router.get('/api/projects/:id/checklists', async (req, res) => {
    if (!await access(req, res)) return;
    sendJson(res, 200, { checklist: await readChecklist(req.params.id) });
  });
  router.post('/api/projects/:id/checklists/generate', async (req, res) => {
    const project = await access(req, res, true);
    if (!project) return;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    if (!Number.isInteger(body.revision) || Number(body.revision) < 0) { sendJson(res, 400, { error: 'A revision is required.' }); return; }
    try { sendJson(res, 200, { checklist: await regenerateProjectChecklist(project.id, project.slug, Number(body.revision)) }); }
    catch (error) { failure(res, error); }
  });
  router.put('/api/projects/:id/checklists', async (req, res) => {
    if (!await access(req, res, true)) return;
    const previous = await readChecklist(req.params.id);
    let next: Checklist;
    try { next = editChecklist(previous, req.body, req.user!.id); }
    catch (error) { sendJson(res, error instanceof ChecklistConflict ? 409 : 400, { error: (error as Error).message }); return; }
    try { await writeChecklist(req.params.id, previous, next); }
    catch (error) {
      if ((error as Error).message.startsWith('Checklist is too large')) { sendJson(res, 400, { error: (error as Error).message }); return; }
      failure(res, error); return;
    }
    sendJson(res, 200, { checklist: next });
  });
  router.get('/api/projects/:id/checklists/export', async (req, res) => {
    if (!await access(req, res)) return;
    const format = req.query.get('format') ?? 'json';
    if (!['json', 'markdown'].includes(format)) { sendJson(res, 400, { error: 'Choose json or markdown.' }); return; }
    const doc = await readChecklist(req.params.id);
    if (!doc) { sendJson(res, 404, { error: 'Generate a checklist first.' }); return; }
    res.setHeader('Content-Disposition', `attachment; filename="checklists.${format === 'json' ? 'json' : 'md'}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8');
    res.end(format === 'json' ? JSON.stringify(doc, null, 2) : checklistMarkdown(doc));
  });
}
