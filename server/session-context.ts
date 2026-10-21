/**
 * Context people attach to a session for its agents.
 *
 * Kinds: a knowledge document (referenced by its Markdown path), an uploaded file (kept in the session's own folder
 * under work/, converted to Markdown when it is an Office or PDF file), a note, a link, and the result of an earlier
 * run or session (copied in as text). Files are read by the agents from their path; the rest goes into the iteration
 * prompt inside an untrusted-content fence (see composeIterationPrompt).
 *
 * Context files live inside the project folder, so agents can read them, but outside every run's write folder, so
 * agents cannot change them. work/ is git-ignored, so they never land in the project's history.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, insert, one, run as exec, type Row } from './db.ts';
import { del, get, post, put } from './http.ts';
import { config } from './config.ts';
import { getProject, projectDir, requireProject } from './projects.ts';
import { SUPPORTED, toMarkdown } from './convert.ts';
import { badRequest, newId, notFound, now, str } from './util.ts';
import type { ContextForPrompt } from './guardrails.ts';

export const CONTEXT_KINDS = ['doc', 'file', 'note', 'url', 'run', 'session'] as const;
const MAX_ITEMS = 40;
const MAX_NOTE = 8000;
/** Files people may attach: what Knowledge converts, plain text and code, and images the agents can look at. */
const TEXT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.cs', '.go', '.rb', '.php', '.rs', '.swift', '.sql', '.sh', '.ps1', '.xml', '.log', '.ini', '.toml', '.env.example', '.diff', '.patch', '.css', '.scss', '.graphql', '.proto'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
/** Converted to Markdown so agents read text, not a binary file. */
const CONVERT_EXTS = ['.pdf', '.docx', '.xlsx', '.pptx', '.html', '.htm', '.odt', '.rtf', '.epub'];
export const ALLOWED_FILE_EXTS = [...new Set([...SUPPORTED, ...TEXT_EXTS, ...IMAGE_EXTS])];

function workflowRow(id: string): Row {
  const w = one<Row>('SELECT id, project_id FROM workflows WHERE id = ?', id);
  if (!w) throw notFound('Session not found');
  return w;
}

/** The session's own folder for attached files, relative to the project folder. */
export function contextDirRel(workflowId: string): string {
  return path.posix.join('work', 'sessions', workflowId, 'context');
}

function view(c: Row) {
  return {
    id: c.id,
    kind: c.kind,
    ref: c.ref,
    title: c.title,
    body: c.kind === 'note' || c.kind === 'url' ? c.body : '',
    path: c.path,
    size: c.size,
    seen: Boolean(c.seen),
    created_by_name: c.created_by_name,
    created_at: c.created_at,
  };
}

export function listContext(workflowId: string) {
  return all<Row>('SELECT * FROM workflow_context WHERE workflow_id = ? ORDER BY created_at, id', workflowId).map(view);
}

function checkRoom(workflowId: string): void {
  const n = Number(one<Row>('SELECT COUNT(*) AS n FROM workflow_context WHERE workflow_id = ?', workflowId)?.n ?? 0);
  if (n >= MAX_ITEMS) throw badRequest(`A session can hold at most ${MAX_ITEMS} context items. Remove some first.`);
}

/** File names stay readable for the agent but cannot leave the folder or clash with each other. */
export function safeFileName(raw: string): string {
  const base = path.basename(String(raw).replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
  const ext = path.extname(base).toLowerCase();
  const stem = base.slice(0, base.length - ext.length).replace(/[^\w.\- ]+/g, '-').replace(/\s+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'file';
  return `${stem}${ext}`;
}

interface Who {
  id: string;
  name: string;
}

function save(workflowId: string, who: Who, row: { kind: string; ref?: string; title: string; body?: string; path?: string; size?: number }) {
  const id = newId('c_');
  insert('workflow_context', {
    id,
    workflow_id: workflowId,
    kind: row.kind,
    ref: row.ref ?? '',
    title: row.title.slice(0, 200),
    body: row.body ?? '',
    path: row.path ?? '',
    size: row.size ?? 0,
    seen: 0,
    created_by: who.id,
    created_by_name: who.name,
    created_at: now(),
  });
  return view(one<Row>('SELECT * FROM workflow_context WHERE id = ?', id)!);
}

/** Add a document, note, link or earlier result. Every reference must belong to the session's project. */
export function addContext(workflowId: string, who: Who, body: any) {
  const w = workflowRow(workflowId);
  checkRoom(w.id);
  const kind = String(body?.kind ?? '');
  if (!(CONTEXT_KINDS as readonly string[]).includes(kind) || kind === 'file') throw badRequest('Choose a document, note, link, run or session to add');
  if (kind === 'note') {
    const text = str(body.body, 'Note', { max: MAX_NOTE }).trim();
    if (!text) throw badRequest('The note is empty');
    const title = str(body.title, 'Title', { max: 200, optional: true }).trim() || text.split('\n')[0].slice(0, 80);
    return save(w.id, who, { kind, title, body: text, size: text.length });
  }
  if (kind === 'url') {
    const url = str(body.ref, 'Link', { max: 2000 }).trim();
    if (!/^https?:\/\/\S+$/i.test(url)) throw badRequest('Use an http:// or https:// link');
    const note = str(body.body, 'Note', { max: MAX_NOTE, optional: true }).trim();
    return save(w.id, who, { kind, ref: url, title: str(body.title, 'Title', { max: 200, optional: true }).trim() || url, body: note, size: note.length });
  }
  const ref = str(body.ref, 'Reference', { max: 100 }).trim();
  if (kind === 'doc') {
    const d = one<Row>('SELECT id, project_id, name, md_path, status FROM documents WHERE id = ?', ref);
    if (!d || d.project_id !== w.project_id) throw badRequest('That document is not in this project');
    if (!d.md_path) throw badRequest('That document has no readable text yet');
    return save(w.id, who, { kind, ref: d.id, title: d.name, path: d.md_path });
  }
  if (kind === 'run') {
    const r = one<Row>('SELECT id, project_id, title, result FROM runs WHERE id = ?', ref);
    if (!r || r.project_id !== w.project_id) throw badRequest('That run is not in this project');
    if (!String(r.result ?? '').trim()) throw badRequest('That run has no result to share');
    return save(w.id, who, { kind, ref: r.id, title: r.title });
  }
  const other = one<Row>('SELECT id, project_id, title, summary FROM workflows WHERE id = ?', ref);
  if (!other || other.project_id !== w.project_id || other.id === w.id) throw badRequest('That session is not in this project');
  return save(w.id, who, { kind, ref: other.id, title: other.title });
}

/** Store an uploaded file in the session's context folder; Office and PDF files also get a Markdown copy. */
export async function addContextFile(workflowId: string, who: Who, filename: string, buf: Buffer) {
  const w = workflowRow(workflowId);
  checkRoom(w.id);
  if (!buf.length) throw badRequest('The file is empty');
  const name = safeFileName(filename);
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_FILE_EXTS.includes(ext)) throw badRequest(`Files of type ${ext || '(none)'} cannot be attached. Use documents, text, code or images.`);
  const project = getProject(w.project_id);
  const dirRel = contextDirRel(w.id);
  const dirAbs = path.join(projectDir(project), dirRel);
  fs.mkdirSync(dirAbs, { recursive: true });
  // A short prefix keeps two files with the same name apart.
  const stored = `${randomBytes(3).toString('hex')}-${name}`;
  fs.writeFileSync(path.join(dirAbs, stored), buf);
  let readRel = path.posix.join(dirRel, stored);
  if (CONVERT_EXTS.includes(ext)) {
    try {
      const md = await toMarkdown(name, buf);
      const mdName = `${stored}.md`;
      fs.writeFileSync(path.join(dirAbs, mdName), md);
      readRel = path.posix.join(dirRel, mdName);
    } catch (e: any) {
      fs.rmSync(path.join(dirAbs, stored), { force: true });
      throw badRequest(`Could not read ${name}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  return save(w.id, who, { kind: 'file', ref: stored, title: name, path: readRel, size: buf.length });
}

export function removeContext(workflowId: string, contextId: string): void {
  const c = one<Row>('SELECT * FROM workflow_context WHERE id = ? AND workflow_id = ?', contextId, workflowId);
  if (!c) throw notFound('Context item not found');
  if (c.kind === 'file') {
    const w = workflowRow(workflowId);
    const dirAbs = path.join(projectDir(getProject(w.project_id)), contextDirRel(w.id));
    for (const f of [c.ref, `${c.ref}.md`]) if (f && path.basename(f) === f) fs.rmSync(path.join(dirAbs, f), { force: true });
  }
  exec('DELETE FROM workflow_context WHERE id = ?', c.id);
}

/** Remove a deleted session's files. */
export function removeContextFiles(projectId: string, workflowId: string): void {
  const dir = path.join(projectDir(getProject(projectId)), 'work', 'sessions', workflowId);
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * What the next iteration is given. Earlier results are read fresh (a session's summary keeps changing); items not
 * yet seen by an iteration are flagged as new and then marked seen.
 */
export function contextForIteration(workflowId: string): ContextForPrompt[] {
  const rows = all<Row>('SELECT * FROM workflow_context WHERE workflow_id = ? ORDER BY created_at, id', workflowId);
  const out: ContextForPrompt[] = [];
  for (const c of rows) {
    const isNew = !c.seen;
    if (c.kind === 'doc' || c.kind === 'file') out.push({ kind: c.kind, title: c.title, path: c.path, isNew });
    else if (c.kind === 'note') out.push({ kind: 'note', title: c.title, text: c.body, isNew });
    else if (c.kind === 'url') out.push({ kind: 'link', title: c.title, text: `${c.ref}${c.body ? `\n${c.body}` : ''}`, isNew });
    else if (c.kind === 'run') {
      const r = one<Row>('SELECT result FROM runs WHERE id = ?', c.ref);
      if (r?.result) out.push({ kind: 'earlier run', title: c.title, text: String(r.result).slice(-6000), isNew });
    } else if (c.kind === 'session') {
      const s = one<Row>('SELECT summary, goal FROM workflows WHERE id = ?', c.ref);
      if (s) out.push({ kind: 'earlier session', title: c.title, text: `Goal: ${s.goal}\n\nWhere it got to: ${s.summary || '(no summary yet)'}`.slice(0, 6000), isNew });
    }
  }
  exec('UPDATE workflow_context SET seen = 1 WHERE workflow_id = ? AND seen = 0', workflowId);
  return out;
}

export function registerContextRoutes(onChange: (workflowId: string, message: string) => void): void {
  const access = (ctx: any, min: 'viewer' | 'editor') => {
    const w = workflowRow(ctx.params.id);
    requireProject(ctx, w.project_id, min);
    return w;
  };

  get('/api/workflows/:id/context', (ctx) => {
    const w = access(ctx, 'viewer');
    return { context: listContext(w.id), allowedFileTypes: ALLOWED_FILE_EXTS, maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024) };
  });

  post('/api/workflows/:id/context', async (ctx) => {
    const w = access(ctx, 'editor');
    const item = addContext(w.id, { id: ctx.user!.id, name: ctx.user!.name }, await ctx.json());
    onChange(w.id, `${ctx.user!.name} added ${item.kind === 'doc' ? 'the document' : item.kind === 'url' ? 'the link' : item.kind === 'note' ? 'a note' : `the ${item.kind}`} “${item.title}” as context`);
    return { item };
  });

  put('/api/workflows/:id/context/file', async (ctx) => {
    const w = access(ctx, 'editor');
    const filename = str(ctx.query.get('name'), 'File name', { max: 200 });
    const item = await addContextFile(w.id, { id: ctx.user!.id, name: ctx.user!.name }, filename, await ctx.raw());
    onChange(w.id, `${ctx.user!.name} attached the file “${item.title}” as context`);
    return { item };
  });

  del('/api/workflows/:id/context/:cid', (ctx) => {
    const w = access(ctx, 'editor');
    const c = one<Row>('SELECT title FROM workflow_context WHERE id = ? AND workflow_id = ?', ctx.params.cid, w.id);
    removeContext(w.id, ctx.params.cid);
    onChange(w.id, `${ctx.user!.name} removed “${c?.title ?? 'an item'}” from the context`);
    return { ok: true };
  });
}

