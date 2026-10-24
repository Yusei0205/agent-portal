/**
 * Word and PowerPoint templates (D-13), shared by the presentation generator (NEW-7) and the document generator (NEW-6).
 *
 * Scope, as decided by the owner: a template belongs to a project, and the portal can have a default. For a project the
 * template that applies is the project's own default, else the portal default, else none (the built-in look).
 *
 *   project templates   editors of the project upload, rename, set as default and delete them
 *   portal templates    admins manage them; every signed-in user can see and download them
 *
 * Uploads are checked before anything is stored: a real Office Open XML zip (not just the extension), within 25 MB, the
 * kind the extension says, and no macros (.pptm/.docm and friends are refused, and so is any file carrying a VBA project
 * or ActiveX controls). Files live in DATA_DIR/templates under a generated name; the API never shows a path. Before a
 * run starts, the templates that apply are copied into the project folder (.portal/templates/) so that `make-doc`,
 * which has no database, can follow them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { all, insert, one, run as exec, update, type Row } from './db.ts';
import { del, get, patch, post, sendFile, type Ctx } from './http.ts';
import { dataPath } from './config.ts';
import { getProject, projectDir, requireProject, type Project } from './projects.ts';
import { badRequest, forbidden, newId, notFound, now, parseJson, sha256, str } from './util.ts';
import { audit } from './audit.ts';
import { TEMPLATE_DEFAULTS, TEMPLATE_DIR } from './docgen.ts';
import { KIND_OF_EXT, TEMPLATE_LIMITS, TemplateError, checkTemplateUpload, type CheckedTemplate, type TemplateInfo, type TemplateKind, type TemplateScope } from './template-check.ts';

export { TEMPLATE_LIMITS, TemplateError, checkTemplateUpload, type CheckedTemplate, type TemplateInfo, type TemplateKind, type TemplateScope } from './template-check.ts';

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function folderFor(scope: TemplateScope, projectId: string | null): string {
  return scope === 'portal' ? dataPath('templates', 'portal') : dataPath('templates', 'projects', projectId!);
}

function fileOf(t: Row): string {
  return path.join(folderFor(t.scope, t.project_id), `${t.id}${t.ext}`);
}

export function readTemplateFile(t: Row): Buffer {
  const f = fileOf(t);
  if (!fs.existsSync(f)) throw notFound('The template file is missing');
  return fs.readFileSync(f);
}

function uploaderName(id: string | null): string | null {
  return id ? (one<Row>('SELECT name FROM users WHERE id = ?', id)?.name ?? null) : null;
}

/** What the API shows. No file paths, no stored names. */
export function templateView(t: Row, effectiveIds: Set<string> = new Set()) {
  return {
    id: t.id,
    kind: t.kind as TemplateKind,
    name: t.name,
    scope: t.scope as TemplateScope,
    project_id: t.project_id,
    filename: t.filename,
    size: t.size,
    is_default: Boolean(t.is_default),
    effective: effectiveIds.has(t.id),
    info: parseJson<TemplateInfo>(t.info, { kind: t.kind, warnings: [] }),
    uploaded_by: t.uploaded_by,
    uploaded_by_name: uploaderName(t.uploaded_by),
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

export function getTemplate(id: string): Row {
  const t = one<Row>('SELECT * FROM doc_templates WHERE id = ?', id);
  if (!t) throw notFound('Template not found');
  return t;
}

/** A template a project may use: its own, or a portal one. */
export function templateForProject(projectId: string, id: string): Row {
  const t = getTemplate(id);
  if (t.scope === 'project' && t.project_id !== projectId) throw notFound('Template not found');
  return t;
}

/** The template that applies to a project for a kind: its own default, else the portal default, else none. */
export function resolveTemplate(projectId: string | null, kind: TemplateKind): Row | null {
  if (projectId) {
    const own = one<Row>("SELECT * FROM doc_templates WHERE scope = 'project' AND project_id = ? AND kind = ? AND is_default = 1", projectId, kind);
    if (own) return own;
  }
  return one<Row>("SELECT * FROM doc_templates WHERE scope = 'portal' AND kind = ? AND is_default = 1", kind) ?? null;
}

function effectiveFor(projectId: string): Record<TemplateKind, Row | null> {
  return { pptx: resolveTemplate(projectId, 'pptx'), docx: resolveTemplate(projectId, 'docx') };
}

function saveTemplate(opts: { scope: TemplateScope; projectId: string | null; userId: string; name: string; filename: string; buf: Buffer; checked: CheckedTemplate; makeDefault: boolean }): Row {
  const id = newId('tp_');
  const ts = now();
  const dir = folderFor(opts.scope, opts.projectId);
  fs.mkdirSync(dir, { recursive: true });
  const row = {
    id,
    kind: opts.checked.kind,
    name: opts.name,
    scope: opts.scope,
    project_id: opts.projectId,
    filename: opts.filename,
    ext: opts.checked.ext,
    size: opts.buf.length,
    sha256: sha256(opts.buf),
    is_default: 0,
    info: JSON.stringify(opts.checked.info),
    uploaded_by: opts.userId,
    created_at: ts,
    updated_at: ts,
  };
  fs.writeFileSync(path.join(dir, `${id}${opts.checked.ext}`), opts.buf);
  insert('doc_templates', row);
  const hasDefault = one<Row>('SELECT 1 FROM doc_templates WHERE scope = ? AND project_id IS ? AND kind = ? AND is_default = 1', opts.scope, opts.projectId, opts.checked.kind);
  if (opts.makeDefault || !hasDefault) setDefault(getTemplate(id), true);
  return getTemplate(id);
}

function setDefault(t: Row, on: boolean): void {
  if (on) exec('UPDATE doc_templates SET is_default = 0 WHERE scope = ? AND project_id IS ? AND kind = ? AND id != ?', t.scope, t.project_id, t.kind, t.id);
  update('doc_templates', t.id, { is_default: on ? 1 : 0, updated_at: now() });
}

function removeTemplate(t: Row): void {
  exec('DELETE FROM doc_templates WHERE id = ?', t.id);
  try {
    fs.rmSync(fileOf(t), { force: true });
  } catch {
    /* the row is gone; a stray file is harmless */
  }
}

/* ------------------------------------------------------------------ */
/* Handing templates to runs                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_COPY = (kind: TemplateKind, ext: string) => `default-${kind}${ext}`;

/** Copy a template into the project folder; returns its path relative to the project folder (what a spec's "template" takes). */
export function placeTemplate(project: Project, t: Row, as?: string): string {
  const dir = path.join(projectDir(project), TEMPLATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const name = as ?? `${t.id}${t.ext}`;
  fs.copyFileSync(fileOf(t), path.join(dir, name));
  return `${TEMPLATE_DIR}/${name}`;
}

/**
 * Make the templates that apply to a project available to `make-doc`: copies the effective default of each kind into the
 * project folder and lists them in .portal/templates/defaults.json. Called before every run; cheap and safe to repeat.
 */
export function syncProjectTemplates(project: Project): void {
  const dir = path.join(projectDir(project), TEMPLATE_DIR);
  const eff = effectiveFor(project.id);
  const defaults: Record<string, unknown> = {};
  const keep = new Set<string>(['defaults.json']);
  fs.mkdirSync(dir, { recursive: true });
  for (const kind of ['pptx', 'docx'] as TemplateKind[]) {
    const t = eff[kind];
    if (!t || !fs.existsSync(fileOf(t))) continue;
    const name = DEFAULT_COPY(kind, t.ext);
    const dest = path.join(dir, name);
    const src = fileOf(t);
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== t.size || sha256(fs.readFileSync(dest)) !== t.sha256) fs.copyFileSync(src, dest);
    keep.add(name);
    defaults[kind] = { id: t.id, name: t.name, scope: t.scope, path: `${TEMPLATE_DIR}/${name}` };
  }
  // Copies of templates chosen explicitly for a run stay while the template exists.
  const named: Record<string, string> = {};
  for (const f of fs.readdirSync(dir)) {
    if (keep.has(f)) continue;
    const id = f.replace(/\.[^.]+$/, '');
    const t = one<Row>('SELECT name FROM doc_templates WHERE id = ?', id);
    if (!t) fs.rmSync(path.join(dir, f), { force: true });
    else named[`${TEMPLATE_DIR}/${f}`] = t.name;
  }
  if (Object.keys(named).length) defaults.named = named;
  const file = path.join(dir, path.basename(TEMPLATE_DEFAULTS));
  const text = JSON.stringify(defaults, null, 2) + '\n';
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  // Keep the copies out of the project's git repository without touching its .gitignore.
  try {
    const exclude = path.join(projectDir(project), '.git', 'info', 'exclude');
    if (fs.existsSync(path.dirname(exclude)) && !(fs.existsSync(exclude) && fs.readFileSync(exclude, 'utf8').includes('.portal/'))) fs.appendFileSync(exclude, '\n.portal/\n');
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function readName(ctx: { query: URLSearchParams }, filename: string): string {
  const raw = ctx.query.get('name');
  const base = path.basename(filename, path.extname(filename)).replace(/[_-]+/g, ' ').trim();
  return str(raw ?? base, 'Name', { max: TEMPLATE_LIMITS.nameChars, optional: true }).trim() || base || 'Template';
}

async function readUpload(ctx: Ctx): Promise<{ buf: Buffer; filename: string; checked: CheckedTemplate; name: string; makeDefault: boolean }> {
  const filename = path.basename(str(ctx.query.get('filename'), 'File name', { max: 200 }));
  const buf = await ctx.raw(TEMPLATE_LIMITS.bytes + 1024);
  let checked: CheckedTemplate;
  try {
    checked = await checkTemplateUpload(buf, filename);
  } catch (e) {
    if (e instanceof TemplateError) throw badRequest(e.message);
    throw e;
  }
  return { buf, filename, checked, name: readName(ctx, filename), makeDefault: ctx.query.get('default') === '1' };
}

function listFor(projectId: string | null, userIsAdmin = false) {
  void userIsAdmin;
  const eff = projectId ? effectiveFor(projectId) : { pptx: resolveTemplate(null, 'pptx'), docx: resolveTemplate(null, 'docx') };
  const effective = new Set([eff.pptx?.id, eff.docx?.id].filter(Boolean) as string[]);
  const rows = [
    ...(projectId ? all<Row>("SELECT * FROM doc_templates WHERE scope = 'project' AND project_id = ? ORDER BY kind, created_at", projectId) : []),
    ...all<Row>("SELECT * FROM doc_templates WHERE scope = 'portal' ORDER BY kind, created_at"),
  ];
  const brief = (t: Row | null) => (t ? { id: t.id, name: t.name, scope: t.scope as TemplateScope, kind: t.kind as TemplateKind } : null);
  return {
    templates: rows.map((t) => templateView(t, effective)),
    effective: { pptx: brief(eff.pptx), docx: brief(eff.docx) },
    limits: { bytes: TEMPLATE_LIMITS.bytes, perProject: TEMPLATE_LIMITS.perProject, portal: TEMPLATE_LIMITS.portal, extensions: Object.keys(KIND_OF_EXT) },
  };
}

function download(ctx: Ctx, t: Row, projectId: string | null) {
  audit(ctx, 'template.download', `template:${t.id}`, { projectId, scope: t.scope });
  const mime = t.kind === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return sendFile(ctx.res, readTemplateFile(t), mime, t.filename);
}

function applyPatch(ctx: Ctx, t: Row, body: any): Row {
  if (body.name !== undefined) update('doc_templates', t.id, { name: str(body.name, 'Name', { max: TEMPLATE_LIMITS.nameChars }).trim() || t.name, updated_at: now() });
  if (body.isDefault !== undefined) setDefault(getTemplate(t.id), Boolean(body.isDefault));
  audit(ctx, 'template.update', `template:${t.id}`, { projectId: t.project_id, scope: t.scope, name: body.name !== undefined, isDefault: body.isDefault });
  return getTemplate(t.id);
}

export function registerTemplateRoutes(): void {
  // ---- a project's templates, plus the portal ones it can use ----
  get('/api/projects/:pid/templates', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return listFor(project.id);
  });

  post('/api/projects/:pid/templates', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    if (Number(one<Row>("SELECT COUNT(*) AS n FROM doc_templates WHERE scope = 'project' AND project_id = ?", project.id)?.n) >= TEMPLATE_LIMITS.perProject) {
      throw badRequest(`A project can hold at most ${TEMPLATE_LIMITS.perProject} templates. Delete one first.`);
    }
    const up = await readUpload(ctx);
    const t = saveTemplate({ scope: 'project', projectId: project.id, userId: ctx.user!.id, name: up.name, filename: up.filename, buf: up.buf, checked: up.checked, makeDefault: up.makeDefault });
    audit(ctx, 'template.create', `template:${t.id}`, { projectId: project.id, scope: 'project', kind: t.kind, name: t.name, size: t.size });
    syncProjectTemplates(getProject(project.id));
    return { template: templateView(t, new Set([effectiveFor(project.id)[t.kind as TemplateKind]?.id ?? ''])), ...listFor(project.id) };
  });

  patch('/api/projects/:pid/templates/:id', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const t = templateForProject(project.id, ctx.params.id);
    if (t.scope !== 'project') throw forbidden('This is a portal template. Only an admin can change it.');
    applyPatch(ctx, t, await ctx.json());
    syncProjectTemplates(getProject(project.id));
    return listFor(project.id);
  });

  del('/api/projects/:pid/templates/:id', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const t = templateForProject(project.id, ctx.params.id);
    if (t.scope !== 'project') throw forbidden('This is a portal template. Only an admin can delete it.');
    removeTemplate(t);
    audit(ctx, 'template.delete', `template:${t.id}`, { projectId: project.id, scope: 'project', name: t.name });
    syncProjectTemplates(getProject(project.id));
    return listFor(project.id);
  });

  get('/api/projects/:pid/templates/:id/download', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return download(ctx, templateForProject(project.id, ctx.params.id), project.id);
  });

  // ---- the portal's templates (the default every project falls back to) ----
  get('/api/templates', (ctx) => {
    void ctx;
    return listFor(null);
  });

  post(
    '/api/templates',
    async (ctx) => {
      if (Number(one<Row>("SELECT COUNT(*) AS n FROM doc_templates WHERE scope = 'portal'")?.n) >= TEMPLATE_LIMITS.portal) throw badRequest(`The portal can hold at most ${TEMPLATE_LIMITS.portal} templates. Delete one first.`);
      const up = await readUpload(ctx);
      const t = saveTemplate({ scope: 'portal', projectId: null, userId: ctx.user!.id, name: up.name, filename: up.filename, buf: up.buf, checked: up.checked, makeDefault: up.makeDefault });
      audit(ctx, 'template.create', `template:${t.id}`, { scope: 'portal', kind: t.kind, name: t.name, size: t.size });
      return { template: templateView(t), ...listFor(null) };
    },
    { auth: 'admin' },
  );

  patch(
    '/api/templates/:id',
    async (ctx) => {
      const t = getTemplate(ctx.params.id);
      if (t.scope !== 'portal') throw badRequest('Change a project template from its project');
      applyPatch(ctx, t, await ctx.json());
      return listFor(null);
    },
    { auth: 'admin' },
  );

  del(
    '/api/templates/:id',
    (ctx) => {
      const t = getTemplate(ctx.params.id);
      if (t.scope !== 'portal') throw badRequest('Delete a project template from its project');
      removeTemplate(t);
      audit(ctx, 'template.delete', `template:${t.id}`, { scope: 'portal', name: t.name });
      return listFor(null);
    },
    { auth: 'admin' },
  );

  get('/api/templates/:id/download', (ctx) => {
    const t = getTemplate(ctx.params.id);
    if (t.scope !== 'portal') throw notFound('Template not found');
    return download(ctx, t, null);
  });
}
