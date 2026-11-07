/**
 * Word and PowerPoint template CRUD (P9, D-13).
 *
 * Routes:
 *   GET    /api/projects/:id/templates         — list project + portal-wide templates
 *   POST   /api/projects/:id/templates/upload  — upload .docx or .pptx template
 *   DELETE /api/projects/:id/templates/:tid    — delete project template
 *   PUT    /api/projects/:id/templates/:tid/default — set as default (project scope)
 *   GET    /api/settings/templates             — list portal-wide templates (admin)
 *   POST   /api/settings/templates/upload      — upload portal-wide template (admin)
 *   DELETE /api/settings/templates/:tid        — delete portal-wide template (admin)
 */
import { getDocTemplateRepository } from './repositories/doc-templates-data.ts';
import { persistFile, forgetFile } from './durable-files.ts';
import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import type { Row } from './db.ts';
import { newId, now, badRequest, notFound, forbidden, str } from './util.ts';
import { config } from './config.ts';
import { checkTemplateUpload, TEMPLATE_LIMITS, TemplateError, KIND_OF_EXT } from './template-check.ts';
import type { TemplateKind } from './template-check.ts';

import { getMemberRow, getProjectRow } from './project-access.ts';
// ── Helpers ───────────────────────────────────────────────────────────────────

function requireAuth(req: PortalRequest, res: PortalResponse): boolean {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  return true;
}

async function requireProjectAccess(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
  level: 'viewer' | 'editor' = 'viewer',
): Promise<Row | null> {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const project = await getProjectRow(projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user.is_admin) return project;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (level === 'editor' && String(member.role) === 'viewer') {
    sendJson(res, 403, { error: 'Editors and above can manage templates' });
    return null;
  }
  return project;
}

function templateDir(projectId: string | null): string {
  if (projectId) {
    return path.join(config.dataDir, 'templates', 'projects', projectId);
  }
  return path.join(config.dataDir, 'templates', 'portal');
}

function templatePath(t: Row): string {
  const dir = t.project_id ? templateDir(String(t.project_id)) : templateDir(null);
  return path.join(dir, String(t.path));
}

function templateView(t: Row) {
  return {
    id: t.id,
    project_id: t.project_id ?? null,
    name: t.name,
    type: t.type,
    is_default: Boolean(t.is_default),
    uploaded_by: t.uploaded_by ?? null,
    created_at: t.created_at,
  };
}

async function setDefault(id: string, projectId: string | null, type: string): Promise<void> {
  await getDocTemplateRepository().setDefault(id, projectId, type);
}

async function readUpload(req: PortalRequest): Promise<{ buf: Buffer; filename: string; kind: TemplateKind }> {
  const filename = str(req.query.get('filename') ?? '', 'filename', { max: 200 });
  if (!filename) throw badRequest('filename query parameter is required');

  // The router has already read the request body into rawBody (it is capped at 5 MB for non-multipart uploads).
  const buf = req.rawBody ?? Buffer.alloc(0);
  if (buf.length > TEMPLATE_LIMITS.bytes) throw badRequest('File too large');

  try {
    await checkTemplateUpload(buf, filename);
  } catch (e) {
    if (e instanceof TemplateError) throw badRequest(e.message);
    throw e;
  }

  const ext = path.extname(filename).toLowerCase();
  const kind = KIND_OF_EXT[ext];
  if (!kind) throw badRequest('Only .docx, .dotx, .pptx or .potx files are accepted');

  return { buf, filename, kind };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerDocTemplateRoutes(): void {
  // GET /api/projects/:id/templates
  router.get('/api/projects/:id/templates', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const repo = getDocTemplateRepository();
    const projectTemplates = (await repo.listByProject(String(project.id))) as unknown as Row[];
    const portalTemplates = (await repo.listPortal()) as unknown as Row[];

    sendJson(res, 200, {
      templates: [...projectTemplates, ...portalTemplates].map(templateView),
    });
  });

  // POST /api/projects/:id/templates/upload
  router.post('/api/projects/:id/templates/upload', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const count = (await getDocTemplateRepository().listByProject(String(project.id))).length;
    if (count >= TEMPLATE_LIMITS.perProject) {
      throw badRequest(`A project can hold at most ${TEMPLATE_LIMITS.perProject} templates`);
    }

    const { buf, filename, kind } = await readUpload(req);
    const id = newId('tp_');
    const ts = now();
    const dir = templateDir(String(project.id));
    fs.mkdirSync(dir, { recursive: true });
    const storedName = `${id}${path.extname(filename)}`;
    fs.writeFileSync(path.join(dir, storedName), buf);
    await persistFile(path.join(dir, storedName));

    const makeDefault = req.query.get('default') === '1';
    const name = str(req.query.get('name') ?? path.basename(filename, path.extname(filename)), 'name', { max: 80, optional: true }).trim() || path.basename(filename, path.extname(filename));

    await getDocTemplateRepository().create({
      id,
      project_id: String(project.id),
      name,
      type: kind,
      path: storedName,
      is_default: 0,
      uploaded_by: req.user!.id,
      created_at: ts,
    });

    if (makeDefault) {
      await setDefault(id, String(project.id), kind);
    } else {
      const hasDefault = (await getDocTemplateRepository().listByProject(String(project.id)))
        .some((x) => x.type === kind && x.is_default === 1);
      if (!hasDefault) await setDefault(id, String(project.id), kind);
    }

    const t = (await getDocTemplateRepository().getById(id)) as unknown as Row;
    sendJson(res, 200, { template: templateView(t) });
  });

  // DELETE /api/projects/:id/templates/:tid
  router.delete('/api/projects/:id/templates/:tid', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const t = (await getDocTemplateRepository().getById(req.params.tid)) as unknown as Row | null;
    if (!t) {
      sendJson(res, 404, { error: 'Template not found' });
      return;
    }
    if (String(t.project_id) !== String(project.id)) {
      sendJson(res, 404, { error: 'Template not found' });
      return;
    }

    await getDocTemplateRepository().delete(String(t.id));
    try {
      fs.rmSync(templatePath(t), { force: true });
    } catch { /* best effort */ }
    await forgetFile(templatePath(t)).catch(() => { /* best effort */ });

    sendJson(res, 200, { ok: true });
  });

  // PUT /api/projects/:id/templates/:tid/default
  router.put('/api/projects/:id/templates/:tid/default', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const t = (await getDocTemplateRepository().getById(req.params.tid)) as unknown as Row | null;
    if (!t || String(t.project_id) !== String(project.id)) {
      sendJson(res, 404, { error: 'Template not found' });
      return;
    }

    await setDefault(String(t.id), String(project.id), String(t.type));
    sendJson(res, 200, { ok: true });
  });

  // GET /api/settings/templates (admin)
  router.get('/api/settings/templates', async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAuth(req, res)) return;
    if (!req.user!.is_admin) {
      sendJson(res, 403, { error: 'Admin only' });
      return;
    }

    const rows = (await getDocTemplateRepository().listPortal()) as unknown as Row[];
    sendJson(res, 200, { templates: rows.map(templateView) });
  });

  // POST /api/settings/templates/upload (admin)
  router.post('/api/settings/templates/upload', async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAuth(req, res)) return;
    if (!req.user!.is_admin) {
      sendJson(res, 403, { error: 'Admin only' });
      return;
    }

    const count = (await getDocTemplateRepository().listPortal()).length;
    if (count >= TEMPLATE_LIMITS.portal) {
      throw badRequest(`The portal can hold at most ${TEMPLATE_LIMITS.portal} templates`);
    }

    const { buf, filename, kind } = await readUpload(req);
    const id = newId('tp_');
    const ts = now();
    const dir = templateDir(null);
    fs.mkdirSync(dir, { recursive: true });
    const storedName = `${id}${path.extname(filename)}`;
    fs.writeFileSync(path.join(dir, storedName), buf);
    await persistFile(path.join(dir, storedName));

    const makeDefault = req.query.get('default') === '1';
    const name = str(req.query.get('name') ?? path.basename(filename, path.extname(filename)), 'name', { max: 80, optional: true }).trim() || path.basename(filename, path.extname(filename));

    await getDocTemplateRepository().create({
      id,
      project_id: null,
      name,
      type: kind,
      path: storedName,
      is_default: 0,
      uploaded_by: req.user!.id,
      created_at: ts,
    });

    if (makeDefault) {
      await setDefault(id, null, kind);
    } else {
      const hasDefault = (await getDocTemplateRepository().listPortal())
        .some((x) => x.type === kind && x.is_default === 1);
      if (!hasDefault) await setDefault(id, null, kind);
    }

    const t = (await getDocTemplateRepository().getById(id)) as unknown as Row;
    sendJson(res, 200, { template: templateView(t) });
  });

  // DELETE /api/settings/templates/:tid (admin)
  router.delete('/api/settings/templates/:tid', async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAuth(req, res)) return;
    if (!req.user!.is_admin) {
      sendJson(res, 403, { error: 'Admin only' });
      return;
    }

    const t = (await getDocTemplateRepository().getById(req.params.tid)) as unknown as Row | null;
    if (!t || (t.project_id ?? null) !== null) {
      sendJson(res, 404, { error: 'Template not found' });
      return;
    }

    await getDocTemplateRepository().delete(String(t.id));
    try {
      fs.rmSync(templatePath(t), { force: true });
    } catch { /* best effort */ }
    await forgetFile(templatePath(t)).catch(() => { /* best effort */ });

    sendJson(res, 200, { ok: true });
  });
}
