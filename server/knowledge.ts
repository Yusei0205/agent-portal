import fs from 'node:fs';
import path from 'node:path';
import { all, insert, one, run, tx, update, type Row } from './db.ts';
import { del, get, patch, post, put, sendFile } from './http.ts';
import { config } from './config.ts';
import { commitProject, getProject, notifyProject, projectDir, requireProject, type Project } from './projects.ts';
import { SUPPORTED, sectionize, toMarkdown } from './convert.ts';
import { HttpError, badRequest, extractJson, newId, notFound, now, parseJson, sha256, slugify, str, withLock } from './util.ts';
import { demoAnswer, type Hit, type SourceSection } from './agent/heuristics.ts';

export const MARK_START = '⟦';
export const MARK_END = '⟧';

export interface DocRow {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  /** Folder path the document was uploaded from, like "billing/api"; empty for loose files. */
  folder: string;
  /** Repository the document belongs to, if any. */
  repo_id: string | null;
  kind: 'upload' | 'decisions';
  mime: string | null;
  size: number;
  hash: string | null;
  original_path: string | null;
  md_path: string | null;
  status: string;
  error: string | null;
  sections_count: number;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

export function getDoc(id: string): DocRow {
  const d = one<DocRow>('SELECT * FROM documents WHERE id = ?', id);
  if (!d) throw notFound('Document not found');
  return d;
}

function publishDoc(d: DocRow) {
  notifyProject(d.project_id, 'document.updated', getDoc(d.id));
}

/** Rebuild the sections and the search index for one document from its Markdown file. */
export async function indexDocument(docId: string): Promise<void> {
  const d = getDoc(docId);
  const p = getProject(d.project_id);
  const file = path.join(projectDir(p), d.md_path!);
  const md = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const sections = sectionize(md, d.name);
  tx(() => {
    run('DELETE FROM sections_fts WHERE rowid IN (SELECT id FROM sections WHERE doc_id = ?)', d.id);
    run('DELETE FROM sections WHERE doc_id = ?', d.id);
    sections.forEach((s, i) => {
      const r = run(
        'INSERT INTO sections (doc_id, project_id, ord, heading, level, anchor, content, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        d.id,
        d.project_id,
        i,
        s.heading,
        s.level,
        s.anchor,
        s.content,
        s.hash,
      );
      run('INSERT INTO sections_fts (rowid, heading, content) VALUES (?, ?, ?)', r.lastInsertRowid, s.heading, s.content);
    });
    update('documents', d.id, { sections_count: sections.length, status: 'ready', error: null, updated_at: now(), hash: sha256(md) });
  });
  publishDoc(d);
  const { refreshStaleFlags } = await import('./learn.ts');
  refreshStaleFlags(d.project_id);
}

export async function registerDecisionsDoc(projectId: string, userId: string | null): Promise<void> {
  if (one("SELECT id FROM documents WHERE project_id = ? AND kind = 'decisions'", projectId)) return;
  const id = newId('d_');
  insert('documents', {
    id,
    project_id: projectId,
    name: 'Decisions log',
    slug: 'decisions',
    kind: 'decisions',
    mime: 'text/markdown',
    size: 0,
    md_path: 'docs/decisions.md',
    status: 'processing',
    uploaded_by: userId,
    created_at: now(),
    updated_at: now(),
  });
  await indexDocument(id);
}

export async function reindexDecisions(projectId: string): Promise<void> {
  const d = one<DocRow>("SELECT * FROM documents WHERE project_id = ? AND kind = 'decisions'", projectId);
  if (d) await indexDocument(d.id);
  else await registerDecisionsDoc(projectId, null);
}

/** Normalise a folder path from the browser: forward slashes, no empty, "." or ".." parts, bounded length. */
export function cleanFolder(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f]/g, '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
    .slice(0, 200);
}

export interface UploadOptions {
  /** Folder the file came from, like "billing/api". */
  folder?: string;
  /** Repository this document belongs to. Leave undefined to keep an existing document's repository. */
  repoId?: string | null;
  /** Re-process this existing document instead of looking one up by name (used by "Convert again"). */
  replaceId?: string;
}

/** A repository id from the browser must belong to the same project. */
function checkRepoId(projectId: string, repoId: string | null | undefined): string | null {
  if (!repoId) return null;
  if (!one('SELECT id FROM repos WHERE id = ? AND project_id = ?', repoId, projectId)) throw badRequest('That repository is not in this project');
  return repoId;
}

export async function uploadDocument(project: Project, filename: string, buf: Buffer, userId: string, opts: UploadOptions = {}): Promise<DocRow> {
  const base = path.basename(filename).replace(/[\u0000-\u001f]/g, '').trim();
  const ext = path.extname(base).toLowerCase();
  if (!SUPPORTED.includes(ext)) throw badRequest(`Files of type ${ext || '(none)'} are not supported. Use: ${SUPPORTED.join(', ')}`);
  const repoId = opts.repoId === undefined ? undefined : checkRepoId(project.id, opts.repoId);
  if (!buf.length) throw badRequest('The file is empty');
  const name = base.slice(0, base.length - ext.length).slice(0, 150) || 'Document';
  const replacing = opts.replaceId ? getDoc(opts.replaceId) : undefined;
  if (replacing && replacing.project_id !== project.id) throw badRequest('That document belongs to another project');
  const folder = replacing ? replacing.folder : cleanFolder(opts.folder ?? '');
  // The same file name in different folders or repositories must not collide, so they get a short hash in the slug.
  const scope = [folder, repoId ?? ''].filter(Boolean).join('|');
  const slug = replacing ? replacing.slug : scope ? `${slugify(name, 48)}-${sha256(scope).slice(0, 6)}` : slugify(name, 60);
  if (slug === 'decisions') throw badRequest('“decisions” is reserved for the decisions log. Rename the file.');
  const dir = projectDir(project);
  const existing = replacing ?? one<DocRow>('SELECT * FROM documents WHERE project_id = ? AND slug = ?', project.id, slug);
  const id = existing?.id ?? newId('d_');
  const originalRel = `docs/originals/${slug}${ext}`;
  const mdRel = `docs/md/${slug}.md`;
  if (existing) {
    update('documents', id, {
      name,
      mime: ext,
      size: buf.length,
      status: 'processing',
      error: null,
      original_path: originalRel,
      updated_at: now(),
      uploaded_by: userId,
      ...(repoId !== undefined ? { repo_id: repoId } : {}),
    });
  } else {
    insert('documents', {
      id,
      project_id: project.id,
      name,
      slug,
      folder,
      repo_id: repoId ?? null,
      kind: 'upload',
      mime: ext,
      size: buf.length,
      original_path: originalRel,
      md_path: mdRel,
      status: 'processing',
      uploaded_by: userId,
      created_at: now(),
      updated_at: now(),
    });
  }
  publishDoc(getDoc(id));
  // Remove an older original with a different extension.
  if (existing?.original_path && existing.original_path !== originalRel) fs.rmSync(path.join(dir, existing.original_path), { force: true });
  fs.writeFileSync(path.join(dir, originalRel), buf);
  try {
    const md = await toMarkdown(base, buf);
    if (!md.trim()) throw badRequest('No text could be read from this file (it may be a scanned image). Upload a text-based version.');
    await withLock(`git:${dir}`, async () => {
      fs.writeFileSync(path.join(dir, mdRel), md.endsWith('\n') ? md : md + '\n');
    });
    await indexDocument(id);
    await commitProject(project.id, `${existing ? 'Update' : 'Add'} document ${name}`, ['docs/md']).catch(() => undefined);
  } catch (e: any) {
    update('documents', id, { status: 'error', error: e instanceof HttpError ? e.message : `Could not convert this file: ${e?.message ?? e}` });
    publishDoc(getDoc(id));
  }
  return getDoc(id);
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export interface SearchHit {
  sectionId: number;
  docId: string;
  docName: string;
  docKind: string;
  heading: string;
  anchor: string;
  snippet: string;
  score: number;
}

function ftsQuery(q: string, joiner: ' ' | ' OR '): string | null {
  const tokens = (q.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []).slice(0, 12);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(joiner);
}

export function search(projectId: string, q: string, opts: { docIds?: string[]; limit?: number } = {}): SearchHit[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const docFilter = opts.docIds?.length ? `AND s.doc_id IN (${opts.docIds.map(() => '?').join(',')})` : '';
  const exec = (match: string) =>
    all<SearchHit>(
      `SELECT s.id AS sectionId, s.doc_id AS docId, d.name AS docName, d.kind AS docKind, s.heading, s.anchor,
              snippet(sections_fts, 1, '${MARK_START}', '${MARK_END}', ' … ', 24) AS snippet,
              bm25(sections_fts, 4.0, 1.0) AS score
         FROM sections_fts
         JOIN sections s ON s.id = sections_fts.rowid
         JOIN documents d ON d.id = s.doc_id
        WHERE sections_fts MATCH ? AND s.project_id = ? ${docFilter}
        ORDER BY score LIMIT ?`,
      match,
      projectId,
      ...(opts.docIds ?? []),
      limit,
    );
  const strict = ftsQuery(q, ' ');
  if (!strict) return [];
  let hits = exec(strict);
  if (!hits.length) {
    const loose = ftsQuery(q, ' OR ');
    if (loose && loose !== strict) hits = exec(loose);
  }
  return hits;
}

/** Search results shaped like Grep output, for the demo agent. */
export function searchForAgent(projectId: string, q: string, limit: number): { file: string; heading: string; snippet: string; line: number }[] {
  const p = getProject(projectId);
  const lineCache = new Map<string, string[]>();
  return search(projectId, q, { limit }).map((h) => {
    const d = getDoc(h.docId);
    const file = d.md_path!;
    let lines = lineCache.get(file);
    if (!lines) {
      try {
        lines = fs.readFileSync(path.join(projectDir(p), file), 'utf8').split('\n');
      } catch {
        lines = [];
      }
      lineCache.set(file, lines);
    }
    const idx = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.includes(h.heading));
    return {
      file,
      heading: h.heading,
      snippet: h.snippet.replaceAll(MARK_START, '').replaceAll(MARK_END, '').replace(/\s+/g, ' ').trim(),
      line: idx >= 0 ? idx + 1 : 1,
    };
  });
}

export function sectionsFor(projectId: string, opts: { docIds?: string[]; focus?: string; maxChars?: number }): SourceSection[] {
  const maxChars = opts.maxChars ?? 60_000;
  let rows: Row[];
  if (opts.focus?.trim()) {
    const ids = search(projectId, opts.focus, { docIds: opts.docIds, limit: 20 }).map((h) => h.sectionId);
    rows = ids.length
      ? all(
          `SELECT s.*, d.name AS doc_name FROM sections s JOIN documents d ON d.id = s.doc_id WHERE s.id IN (${ids.map(() => '?').join(',')}) ORDER BY d.name, s.ord`,
          ...ids,
        )
      : [];
  } else {
    const docFilter = opts.docIds?.length ? `AND s.doc_id IN (${opts.docIds.map(() => '?').join(',')})` : "AND d.kind = 'upload'";
    rows = all(
      `SELECT s.*, d.name AS doc_name FROM sections s JOIN documents d ON d.id = s.doc_id WHERE s.project_id = ? ${docFilter} ORDER BY d.name, s.ord`,
      projectId,
      ...(opts.docIds ?? []),
    );
  }
  const out: SourceSection[] = [];
  let used = 0;
  for (const r of rows) {
    if (!r.content.trim()) continue;
    if (used + r.content.length > maxChars && out.length) break;
    used += r.content.length;
    out.push({ docId: r.doc_id, docName: r.doc_name, sectionId: r.id, heading: r.heading, anchor: r.anchor, content: r.content });
  }
  return out;
}

export function sectionsByIds(ids: number[]): SourceSection[] {
  if (!ids.length) return [];
  return all<Row>(
    `SELECT s.*, d.name AS doc_name FROM sections s JOIN documents d ON d.id = s.doc_id WHERE s.id IN (${ids.map(() => '?').join(',')}) ORDER BY d.name, s.ord`,
    ...ids,
  ).map((r) => ({ docId: r.doc_id, docName: r.doc_name, sectionId: r.id, heading: r.heading, anchor: r.anchor, content: r.content }));
}

export function sourceHash(sectionIds: number[]): string | null {
  if (!sectionIds.length) return null;
  const rows = all<{ id: number; hash: string }>(`SELECT id, hash FROM sections WHERE id IN (${sectionIds.map(() => '?').join(',')})`, ...sectionIds);
  if (rows.length !== new Set(sectionIds).size) return 'missing';
  const map = new Map(rows.map((r) => [r.id, r.hash]));
  return sha256(sectionIds.map((id) => map.get(id)).join('|'));
}

/** Section IDs change on re-index, so learning items store (docId, heading) and resolve them here. */
export function resolveRefs(refs: { docId: string; heading: string; anchor: string }[]): number[] {
  const ids: number[] = [];
  for (const r of refs) {
    const s = one<{ id: number }>('SELECT id FROM sections WHERE doc_id = ? AND anchor = ?', r.docId, r.anchor);
    if (s) ids.push(s.id);
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* Ask the documents                                                   */
/* ------------------------------------------------------------------ */

const ASK_SYSTEM = `You answer questions about a software project using ONLY the numbered sources provided.
Rules:
- Answer in plain language first, then add technical details if the sources have them.
- Cite sources inline as [1], [2] matching the numbers given. Every factual sentence needs a citation.
- If the sources do not answer the question, say so and set "missing" to true. Never use outside knowledge.
- Reply with JSON only: {"answer": "<markdown>", "citations": [<source numbers used>], "missing": <true|false>, "suggestedQuestion": "<a precise question for the project team when missing, else empty>"}`;

export async function ask(project: Project, userId: string, question: string) {
  const hits = search(project.id, question, { limit: 6 });
  const sections: Hit[] = hits.map((h) => {
    const s = one<Row>('SELECT content FROM sections WHERE id = ?', h.sectionId)!;
    return { docId: h.docId, docName: h.docName, sectionId: h.sectionId, heading: h.heading, anchor: h.anchor, content: s.content };
  });
  const sourcesText = sections
    .map((s, i) => `[${i + 1}] ${s.docName} › ${s.heading}\n${s.content.slice(0, 3500)}`)
    .join('\n\n---\n\n');
  const { oneshot } = await import('./agent/runner.ts');
  const { text, runId } = await oneshot({
    projectId: project.id,
    userId,
    kind: 'qa',
    title: `Question: ${question.slice(0, 120)}`,
    system: ASK_SYSTEM,
    prompt: `Question: ${question}\n\nSources:\n\n${sourcesText || '(no matching sources)'}`,
    model: 'haiku',
    meta: { question },
    demoOutput: () => {
      const d = demoAnswer(question, sections);
      return JSON.stringify({ ...d, citations: d.citations.map((id) => sections.findIndex((s) => s.sectionId === id) + 1) });
    },
  });
  const parsed = extractJson<any>(text) ?? { answer: text, citations: [], missing: false, suggestedQuestion: '' };
  const cited: number[] = Array.isArray(parsed.citations) ? parsed.citations.map(Number).filter((n: number) => n >= 1 && n <= sections.length) : [];
  return {
    answer: String(parsed.answer ?? ''),
    missing: Boolean(parsed.missing),
    suggestedQuestion: String(parsed.suggestedQuestion ?? ''),
    sources: sections.map((s, i) => ({
      n: i + 1,
      cited: cited.includes(i + 1),
      docId: s.docId,
      docName: s.docName,
      sectionId: s.sectionId,
      heading: s.heading,
      anchor: s.anchor,
    })),
    runId,
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function registerKnowledgeRoutes(): void {
  get('/api/projects/:pid/documents', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return {
      documents: all(
        `SELECT d.*, u.name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
          WHERE d.project_id = ? ORDER BY d.kind = 'decisions' DESC, d.folder COLLATE NOCASE, d.name COLLATE NOCASE`,
        project.id,
      ),
      folders: all<{ path: string }>(
        `SELECT path FROM project_folders WHERE project_id = ? ORDER BY path COLLATE NOCASE`,
        project.id,
      ).map((r) => r.path),
      supported: SUPPORTED,
      maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
    };
  });

  put('/api/projects/:pid/documents', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const filename = str(ctx.query.get('name'), 'File name', { max: 200 });
    const buf = await ctx.raw();
    const repo = ctx.query.get('repo');
    return { document: await uploadDocument(project, filename, buf, ctx.user!.id, { folder: ctx.query.get('folder') ?? '', repoId: repo ? repo : undefined }) };
  });

  // Update a document: move to a folder, assign/clear repository, rename display name.
  // The decisions log cannot be moved.
  patch('/api/documents/:id', async (ctx) => {
    const d = getDoc(ctx.params.id);
    const { project } = requireProject(ctx, d.project_id, 'editor');
    if (d.kind !== 'upload') throw badRequest('Only uploaded documents can be modified');
    const body = await ctx.json();

    const changes: Record<string, string | null> = {};

    if ('repoId' in body) {
      changes.repo_id = checkRepoId(project.id, body.repoId);
    }

    if ('name' in body) {
      const newName = str(body.name, 'Name', { max: 150 }).trim();
      if (!newName) throw badRequest('Name cannot be empty');
      changes.name = newName;
    }

    if ('folder' in body) {
      const newFolder = cleanFolder(String(body.folder ?? ''));
      changes.folder = newFolder;
      // Persist the target folder as a virtual folder so it shows in the tree even if empty.
      if (newFolder) {
        run('INSERT OR IGNORE INTO project_folders (project_id, path) VALUES (?, ?)', project.id, newFolder);
      }
    }

    if (!Object.keys(changes).length) throw badRequest('Send at least one of: repoId, name, folder');

    changes.updated_at = now();
    update('documents', d.id, changes);
    publishDoc(d);
    return { document: getDoc(d.id) };
  });

  // Bulk move documents to a folder (or clear folder with '').
  post('/api/projects/:pid/documents/bulk-move', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    if (!Array.isArray(body.ids) || !body.ids.length) throw badRequest('Send ids (array of document ids)');
    if (typeof body.folder !== 'string') throw badRequest('Send folder (string, empty for root)');
    const targetFolder = cleanFolder(body.folder);
    const ids: string[] = body.ids.slice(0, 500).map(String);

    // Validate all docs belong to this project and are not decisions.
    for (const id of ids) {
      const doc = one<DocRow>('SELECT id, project_id, kind FROM documents WHERE id = ?', id);
      if (!doc) throw notFound(`Document ${id} not found`);
      if (doc.project_id !== project.id) throw badRequest(`Document ${id} does not belong to this project`);
      if (doc.kind === 'decisions') throw badRequest('The decisions log cannot be moved');
    }

    tx(() => {
      for (const id of ids) {
        run('UPDATE documents SET folder = ?, updated_at = ? WHERE id = ?', targetFolder, now(), id);
      }
      // Persist target folder so it shows in the tree.
      if (targetFolder) {
        run('INSERT OR IGNORE INTO project_folders (project_id, path) VALUES (?, ?)', project.id, targetFolder);
      }
    });

    // Notify clients.
    notifyProject(project.id, 'document.updated', { bulk: true });
    return { ok: true, moved: ids.length };
  });

  // List virtual folders for a project.
  get('/api/projects/:pid/folders', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const folders = all<{ path: string }>(
      `SELECT path FROM project_folders WHERE project_id = ? ORDER BY path COLLATE NOCASE`,
      project.id,
    ).map((r) => r.path);
    return { folders };
  });

  // Create a virtual folder (empty, no documents required).
  post('/api/projects/:pid/folders', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const folderPath = cleanFolder(str(body.path, 'Folder path', { max: 200 }));
    if (!folderPath) throw badRequest('Folder path cannot be empty');
    run('INSERT OR IGNORE INTO project_folders (project_id, path) VALUES (?, ?)', project.id, folderPath);
    notifyProject(project.id, 'document.updated', { folder: folderPath });
    return { folder: folderPath };
  });

  // Rename a folder: moves all documents with the old prefix and updates the virtual folder record.
  patch('/api/projects/:pid/folders', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const oldPath = cleanFolder(str(body.from, 'from', { max: 200 }));
    const newPath = cleanFolder(str(body.to, 'to', { max: 200 }));
    if (!oldPath) throw badRequest('"from" cannot be empty');
    if (!newPath) throw badRequest('"to" cannot be empty');
    if (oldPath === newPath) return { ok: true };

    // Move all documents with the exact folder or with oldPath as a prefix.
    const docs = all<DocRow>(
      `SELECT * FROM documents WHERE project_id = ? AND (folder = ? OR folder LIKE ?)`,
      project.id,
      oldPath,
      `${oldPath}/%`,
    );
    tx(() => {
      for (const d of docs) {
        const updatedFolder = d.folder === oldPath ? newPath : newPath + d.folder.slice(oldPath.length);
        run('UPDATE documents SET folder = ?, updated_at = ? WHERE id = ?', updatedFolder, now(), d.id);
      }
      // Update virtual folder records (rename exact match and children).
      const virtualFolders = all<{ path: string }>(
        `SELECT path FROM project_folders WHERE project_id = ? AND (path = ? OR path LIKE ?)`,
        project.id,
        oldPath,
        `${oldPath}/%`,
      );
      for (const vf of virtualFolders) {
        const updatedPath = vf.path === oldPath ? newPath : newPath + vf.path.slice(oldPath.length);
        run('DELETE FROM project_folders WHERE project_id = ? AND path = ?', project.id, vf.path);
        run('INSERT OR IGNORE INTO project_folders (project_id, path) VALUES (?, ?)', project.id, updatedPath);
      }
      // Ensure the new path itself is in the table.
      run('INSERT OR IGNORE INTO project_folders (project_id, path) VALUES (?, ?)', project.id, newPath);
    });

    notifyProject(project.id, 'document.updated', { folderRenamed: true });
    return { ok: true, moved: docs.length };
  });

  // Delete a virtual folder record. Refuses if documents still live there (unless force=true).
  del('/api/projects/:pid/folders', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const folderPath = cleanFolder(str(body.path, 'Folder path', { max: 200 }));
    if (!folderPath) throw badRequest('Folder path cannot be empty');
    const force = Boolean(body.force);

    // Check for documents in this folder or sub-folders.
    const docCount = one<{ c: number }>(
      `SELECT COUNT(*) AS c FROM documents WHERE project_id = ? AND (folder = ? OR folder LIKE ?)`,
      project.id,
      folderPath,
      `${folderPath}/%`,
    )?.c ?? 0;
    if (docCount > 0 && !force) throw badRequest(`Folder "${folderPath}" still has ${docCount} document${docCount !== 1 ? 's' : ''}. Move or delete them first, or use force:true to move them to root.`);

    tx(() => {
      if (force && docCount > 0) {
        // Move all documents in this folder (and sub-folders) to root.
        run(`UPDATE documents SET folder = '', updated_at = ? WHERE project_id = ? AND (folder = ? OR folder LIKE ?)`,
          now(), project.id, folderPath, `${folderPath}/%`);
      }
      // Remove virtual folder records for this folder and its children.
      run(`DELETE FROM project_folders WHERE project_id = ? AND (path = ? OR path LIKE ?)`,
        project.id, folderPath, `${folderPath}/%`);
    });

    notifyProject(project.id, 'document.updated', { folderDeleted: true });
    return { ok: true };
  });

  get('/api/documents/:id', (ctx) => {
    const d = getDoc(ctx.params.id);
    const { project } = requireProject(ctx, d.project_id);
    const file = path.join(projectDir(project), d.md_path ?? '');
    return {
      document: d,
      markdown: d.md_path && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '',
      sections: all('SELECT id, heading, level, anchor, length(content) AS chars FROM sections WHERE doc_id = ? ORDER BY ord', d.id),
    };
  });

  get('/api/documents/:id/original', (ctx) => {
    const d = getDoc(ctx.params.id);
    const { project } = requireProject(ctx, d.project_id);
    const rel = d.original_path ?? d.md_path;
    if (!rel) throw notFound();
    const file = path.join(projectDir(project), rel);
    if (!fs.existsSync(file)) throw notFound('The original file is missing');
    return sendFile(ctx.res, fs.readFileSync(file), 'application/octet-stream', `${d.name}${path.extname(rel)}`);
  });

  get('/api/sections/:id', (ctx) => {
    const s = one<Row>('SELECT s.*, d.name AS doc_name FROM sections s JOIN documents d ON d.id = s.doc_id WHERE s.id = ?', Number(ctx.params.id));
    if (!s) throw notFound('Section not found');
    requireProject(ctx, s.project_id);
    return { section: s };
  });

  post('/api/documents/:id/reindex', async (ctx) => {
    const d = getDoc(ctx.params.id);
    const { project } = requireProject(ctx, d.project_id, 'editor');
    if (d.kind === 'upload' && d.original_path) {
      const buf = fs.readFileSync(path.join(projectDir(project), d.original_path));
      return { document: await uploadDocument(project, `${d.name}${path.extname(d.original_path)}`, buf, ctx.user!.id, { replaceId: d.id }) };
    }
    await indexDocument(d.id);
    return { document: getDoc(d.id) };
  });

  del('/api/documents/:id', async (ctx) => {
    const d = getDoc(ctx.params.id);
    const { project } = requireProject(ctx, d.project_id, 'editor');
    if (d.kind === 'decisions') throw badRequest('The decisions log cannot be deleted');
    const dir = projectDir(project);
    for (const rel of [d.original_path, d.md_path]) if (rel) fs.rmSync(path.join(dir, rel), { force: true });
    tx(() => {
      run('DELETE FROM sections_fts WHERE rowid IN (SELECT id FROM sections WHERE doc_id = ?)', d.id);
      run('DELETE FROM documents WHERE id = ?', d.id);
    });
    await commitProject(project.id, `Remove document ${d.name}`, ['docs/md']).catch(() => undefined);
    const { refreshStaleFlags } = await import('./learn.ts');
    refreshStaleFlags(project.id);
    notifyProject(project.id, 'document.deleted', { id: d.id });
    return { ok: true };
  });

  get('/api/projects/:pid/search', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const q = str(ctx.query.get('q'), 'Search', { max: 500 });
    const docIds = (ctx.query.get('docs') || '').split(',').filter(Boolean);
    return { hits: search(project.id, q, { docIds, limit: Number(ctx.query.get('limit') || 15) }), markStart: MARK_START, markEnd: MARK_END };
  });

  post('/api/projects/:pid/ask', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const body = await ctx.json();
    const question = str(body.question, 'Question', { max: 2000 }).trim();
    return ask(project, ctx.user!.id, question);
  });

  get('/api/projects/:pid/qa', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return {
      history: all(
        `SELECT r.id, r.title, r.status, r.created_at, r.meta, u.name AS asked_by FROM agent_runs r LEFT JOIN users u ON u.id = r.created_by
          WHERE r.project_id = ? AND r.kind = 'qa' ORDER BY r.created_at DESC LIMIT 30`,
        project.id,
      ).map((r) => ({ ...r, meta: parseJson(r.meta, {}) })),
    };
  });

  // ---- Project inbox: open questions for the team ----
  get('/api/projects/:pid/inputs', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const status = ctx.query.get('status') || 'pending';
    // Tool permission requests belong to their run; the team's question list asks for type=question only.
    const type = ['question', 'approval'].includes(ctx.query.get('type') ?? '') ? ctx.query.get('type')! : '';
    const rows = all(
      `SELECT i.*, r.title AS run_title, u.name AS created_by_name, a.name AS answered_by_name
         FROM inputs i LEFT JOIN agent_runs r ON r.id = i.run_id LEFT JOIN users u ON u.id = i.created_by LEFT JOIN users a ON a.id = i.answered_by
        WHERE i.project_id = ? ${status === 'all' ? '' : 'AND i.status = ?'} ${type ? 'AND i.type = ?' : ''}
        ORDER BY i.created_at DESC LIMIT 100`,
      project.id,
      ...(status === 'all' ? [] : [status]),
      ...(type ? [type] : []),
    );
    return { inputs: rows.map((r) => ({ ...r, payload: parseJson(r.payload, {}), response: parseJson(r.response, null) })) };
  });

  post('/api/projects/:pid/inbox', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const body = await ctx.json();
    const question = str(body.question, 'Question', { max: 1000 }).trim();
    const options = (Array.isArray(body.options) ? body.options : [])
      .map((o: unknown) => String(o).trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((label: string) => ({ label: label.slice(0, 100), description: '' }));
    const { createInput, inputView } = await import('./agent/runner.ts');
    const row = createInput({
      projectId: project.id,
      runId: null,
      type: 'question',
      toolName: null,
      payload: { source: 'qa', questions: [{ question, header: 'Question', options, multiSelect: false }] },
      userId: ctx.user!.id,
    });
    return { input: inputView(row) };
  });

  post('/api/inputs/:id/dismiss', (ctx) => {
    const row = one('SELECT * FROM inputs WHERE id = ?', ctx.params.id);
    if (!row) throw notFound();
    requireProject(ctx, row.project_id, 'editor');
    if (row.run_id) throw badRequest('Questions from a running agent must be answered or the run stopped');
    if (row.status !== 'pending') throw badRequest('This question is already closed');
    run("UPDATE inputs SET status = 'dismissed', answered_by = ?, answered_at = ? WHERE id = ?", ctx.user!.id, now(), row.id);
    notifyProject(row.project_id, 'input.resolved', { id: row.id, status: 'dismissed' });
    return { ok: true };
  });
}
