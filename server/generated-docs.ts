/**
 * Documentation generator (NEW-6).
 *
 * A person asks for a document (overview, architecture, API reference, runbook or user guide) about some of the project's
 * repositories, optionally with its knowledge documents, its decisions log and stored architecture diagrams. The portal
 * starts an ordinary single-run session (playground-run.ts: the same concurrency caps, queue, drain mode and budget as
 * every session) whose prompt tells the agent to read the repositories' reference clones in place and write Markdown that
 * cites files and lines. When the session ends the portal
 *
 *   - puts the stored diagrams where the agent placed their markers (the exact Mermaid from the diagram store),
 *   - checks every cited file path (and line) against the repository snapshot the document was written from,
 *   - builds the Word file with the same engine as `make-doc`, following the project's Word template (docx-template.ts),
 *   - stores the result as a new version, with the hashes of every source it was written from.
 *
 * A document is stale when a repository has new commits, a knowledge document or the decisions log changed, or a chosen
 * diagram has a newer version (the same idea as Learn's source hashes and the diagrams' commit hashes). Regenerating
 * appends a new version; older versions stay retrievable. Loop specs refresh stale documents with the "refresh_docs"
 * trigger action (refreshStaleDocs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { all, insert, isDbOpen, one, run as exec, tx, update, type Row } from './db.ts';
import { del, get, post, sendFile } from './http.ts';
import { dataPath } from './config.ts';
import { getProject, notifyProject, projectDir, requireProject } from './projects.ts';
import { ensureFresh, repoDir, type Repo } from './repos.ts';
import { HttpError, badRequest, newId, notFound, now, parseJson, safeJoin, sha256, slugify, str, withLock } from './util.ts';
import { audit, auditRaw } from './audit.ts';
import { getRun } from './agent/runner.ts';
import { rendererProblem } from './docimage.ts';
import { renderDocx } from './docgen.ts';
import { view as sessionView } from './workflows/views.ts';
import { diagramMarkdown, diagramSource, headSha } from './diagrams.ts';
import { placeTemplate, resolveTemplate, syncProjectTemplates, templateForProject } from './doc-templates.ts';
import { checkRunBudget, startPlaygroundRun } from './playground-run.ts';
import { readRunOptionsRequest, resolveRunOptions, runOptionChoices, runOptionsView, storeRunOptions, type RunOptions, type RunOptionsRequest } from './run-options.ts';
import { log } from './workflows/store.ts';
import { generatedFiles, removeGenerated, saveGenerated } from './vault-generated.ts';
import {
  DOC_LIMITS,
  DOC_TYPES,
  DOC_TYPE_LABELS,
  citationWarning,
  composeDocPrompt,
  extractCitations,
  normalizeMarkdown,
  parseDocReply,
  placeDiagrams,
  type Citation,
  type DocType,
  type ResolvedCitation,
} from './generated-doc-text.ts';

export { DOC_LIMITS, DOC_TYPES, DOC_TYPE_LABELS, type DocType } from './generated-doc-text.ts';

const TERMINAL = ['done', 'blocked', 'failed', 'stopped'];
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/* ------------------------------------------------------------------ */
/* Sources: what a document is written from, and what it is now        */
/* ------------------------------------------------------------------ */

export interface SourceSnapshot {
  repos: { repoId: string; name: string; slug: string; branch: string; sha: string | null }[];
  /** Knowledge documents (not the decisions log), or null when the document does not use them. */
  knowledge: { id: string; name: string; hash: string }[] | null;
  /** The decisions log, or null when the document does not use it. */
  decisions: { id: string; hash: string } | null;
  diagrams: { id: string; slug: string; title: string; version: number | null }[];
}

function findRepo(id: string): Repo | null {
  return one<Repo>('SELECT * FROM repos WHERE id = ?', id) ?? null;
}

/** The sources as they are right now, for the request stored on a document. `heads` caches repository commits across a loop. */
function snapshotFor(d: Row, heads = new Map<string, string | null>()): SourceSnapshot {
  const repos = parseJson<string[]>(d.repo_ids, []).map((id) => {
    const r = findRepo(id);
    if (!heads.has(id)) heads.set(id, r ? headSha(r) : null);
    return { repoId: id, name: r?.name ?? '(removed repository)', slug: r?.slug ?? '', branch: r?.default_branch ?? '', sha: heads.get(id) ?? null };
  });
  const knowledge = d.include_knowledge
    ? all<Row>("SELECT id, name, hash FROM documents WHERE project_id = ? AND status = 'ready' AND kind != 'decisions' AND hash IS NOT NULL ORDER BY id", d.project_id).map((k) => ({ id: String(k.id), name: String(k.name), hash: String(k.hash) }))
    : null;
  const dec = d.include_decisions ? one<Row>("SELECT id, hash FROM documents WHERE project_id = ? AND kind = 'decisions'", d.project_id) : undefined;
  const diagrams = parseJson<string[]>(d.diagram_ids, []).map((id) => {
    const s = diagramSource(d.project_id, id);
    return { id, slug: s?.slug ?? '', title: s?.title ?? '(removed diagram)', version: s?.version ?? null };
  });
  return { repos, knowledge, decisions: d.include_decisions ? { id: dec?.id ?? '', hash: String(dec?.hash ?? '') } : null, diagrams };
}

/** One hash for everything a document was written from. */
export function hashOfSnapshot(s: SourceSnapshot): string {
  return sha256(
    JSON.stringify({
      r: s.repos.map((r) => `${r.repoId}@${r.sha ?? 'missing'}`).sort(),
      k: s.knowledge ? s.knowledge.map((k) => `${k.id}:${k.hash}`).sort() : null,
      d: s.decisions ? s.decisions.hash : null,
      g: s.diagrams.map((g) => `${g.id}@${g.version ?? 'missing'}`).sort(),
    }),
  );
}

/** Plain-language reasons a document differs from the sources it was written from (empty when it does not). */
export function staleReasons(recorded: SourceSnapshot, current: SourceSnapshot): string[] {
  const out: string[] = [];
  for (const r of recorded.repos) {
    const now = current.repos.find((c) => c.repoId === r.repoId);
    if (!now || !now.sha) out.push(`Repository "${r.name}" was removed or has no checkout.`);
    else if (now.sha !== r.sha) out.push(`Repository "${r.name}" has new commits (${(r.sha ?? '').slice(0, 7)} to ${now.sha.slice(0, 7)}).`);
  }
  if (recorded.knowledge && current.knowledge) {
    const before = new Map(recorded.knowledge.map((k) => [k.id, k]));
    const after = new Map(current.knowledge.map((k) => [k.id, k]));
    const changed = [...after.values()].filter((k) => before.has(k.id) && before.get(k.id)!.hash !== k.hash).map((k) => k.name);
    const added = [...after.values()].filter((k) => !before.has(k.id)).map((k) => k.name);
    const removed = [...before.values()].filter((k) => !after.has(k.id)).map((k) => k.name);
    const list = (names: string[]) => names.slice(0, 3).map((n) => `"${n}"`).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
    if (changed.length) out.push(`Knowledge ${changed.length === 1 ? 'document' : 'documents'} changed: ${list(changed)}.`);
    if (added.length) out.push(`Knowledge ${added.length === 1 ? 'document' : 'documents'} added: ${list(added)}.`);
    if (removed.length) out.push(`Knowledge ${removed.length === 1 ? 'document' : 'documents'} removed: ${list(removed)}.`);
  }
  if (recorded.decisions && current.decisions && recorded.decisions.hash !== current.decisions.hash) out.push('The decisions log changed.');
  for (const g of recorded.diagrams) {
    const now = current.diagrams.find((c) => c.id === g.id);
    if (!now || now.version === null) out.push(`Diagram "${g.title}" was removed.`);
    else if (now.version !== g.version) out.push(`Diagram "${g.title}" has a newer version (v${now.version}, the document uses v${g.version}).`);
  }
  return out;
}

/** Recompute the stale flag of every finished document of a project; tells the UI when one changed. Cheap enough to call on reads. */
export function refreshDocStale(projectId: string): void {
  if (!isDbOpen()) return;
  const heads = new Map<string, string | null>();
  let changed = false;
  for (const d of all<Row>('SELECT * FROM generated_docs WHERE project_id = ? AND version > 0', projectId)) {
    const v = one<Row>('SELECT sources FROM generated_doc_versions WHERE doc_id = ? AND version = ?', d.id, d.version);
    const current = snapshotFor(d, heads);
    const stale = hashOfSnapshot(current) !== d.source_hash ? 1 : 0;
    const reasons = stale ? staleReasons(parseJson<SourceSnapshot>(v?.sources, { repos: [], knowledge: null, decisions: null, diagrams: [] }), current) : [];
    const json = JSON.stringify(stale && !reasons.length ? ['Its sources changed.'] : reasons);
    if (stale !== d.stale || json !== d.stale_reasons) {
      exec('UPDATE generated_docs SET stale = ?, stale_reasons = ? WHERE id = ?', stale, json, d.id);
      changed = true;
    }
  }
  if (changed) notifyProject(projectId, 'generated-docs.updated', {});
}

/* ------------------------------------------------------------------ */
/* Citations                                                           */
/* ------------------------------------------------------------------ */

const gitOpts = { encoding: 'utf8' as const, timeout: 30_000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], windowsHide: true };

/** The files of a repository at a commit, or null when git cannot say (then the working tree is used). */
function filesAt(repo: Repo, sha: string): Set<string> | null {
  try {
    const out = execFileSync('git', ['-c', 'core.longpaths=true', 'ls-tree', '-r', '--name-only', '-z', sha], { ...gitOpts, cwd: repoDir(repo) });
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

function linesAt(repo: Repo, sha: string, file: string): number | null {
  try {
    const out = execFileSync('git', ['-c', 'core.longpaths=true', 'cat-file', 'blob', `${sha}:${file}`], { cwd: repoDir(repo), maxBuffer: 16 * 1024 * 1024, timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let n = 0;
    for (const b of out) if (b === 10) n++;
    return out.length && out[out.length - 1] !== 10 ? n + 1 : n;
  } catch {
    return null;
  }
}

/**
 * Check each cited file against the repository snapshot the document was written from (the recorded commits), and
 * `docs/...` citations against the project folder. A citation may start with the repository folder name or not. A line
 * number past the end of the file does not resolve. Never throws: a repository git cannot read is checked on disk.
 */
export function checkCitations(projectPath: string, snap: SourceSnapshot, cites: Citation[]): ResolvedCitation[] {
  const repos = snap.repos.flatMap((r) => {
    const repo = findRepo(r.repoId);
    return repo ? [{ repo, slug: r.slug, sha: r.sha }] : [];
  });
  const files = new Map<string, Set<string> | null>();
  const fileSet = (x: (typeof repos)[number]) => {
    if (!files.has(x.slug)) files.set(x.slug, x.sha ? filesAt(x.repo, x.sha) : null);
    return files.get(x.slug)!;
  };
  const exists = (x: (typeof repos)[number], file: string): boolean => {
    const set = fileSet(x);
    if (set) return set.has(file);
    try {
      return fs.statSync(path.join(repoDir(x.repo), file)).isFile();
    } catch {
      return false;
    }
  };
  let lineLookups = 0;
  return cites.slice(0, DOC_LIMITS.citations).map((c) => {
    const firstSeg = c.path.split('/')[0];
    const candidates: { x: (typeof repos)[number]; file: string }[] = [];
    for (const x of repos) if (c.path.includes('/') && firstSeg === x.slug) candidates.push({ x, file: c.path.slice(firstSeg.length + 1) });
    for (const x of repos) candidates.push({ x, file: c.path });
    const hit = candidates.find((k) => k.file && exists(k.x, k.file));
    if (hit) {
      if (c.line !== null && hit.x.sha && lineLookups++ < 200) {
        const total = linesAt(hit.x.repo, hit.x.sha, hit.file);
        if (total !== null && c.line > total) return { ...c, repo: hit.x.slug, ok: false, reason: `line ${c.line} is past the end of the file, which has ${total} lines` };
      }
      return { ...c, repo: hit.x.slug, ok: true, reason: null };
    }
    if (/^docs\//.test(c.path)) {
      try {
        if (fs.statSync(path.join(projectPath, c.path)).isFile()) return { ...c, repo: null, ok: true, reason: null };
      } catch {
        /* falls through */
      }
      return { ...c, repo: null, ok: false, reason: 'no such project document' };
    }
    return { ...c, repo: null, ok: false, reason: repos.length ? 'file not found in the repository snapshot' : 'no repository to check against' };
  });
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function storeDir(projectId: string): string {
  return dataPath('generated-docs', projectId);
}

function docxFile(projectId: string, v: Row): string {
  return path.join(storeDir(projectId), String(v.file));
}

function workflowState(id: string | null): { status: string; stop_reason: string } | null {
  return id ? (one<Row>('SELECT status, stop_reason FROM workflows WHERE id = ?', id) as { status: string; stop_reason: string } | undefined) ?? null : null;
}

function userName(id: string | null): string | null {
  return id ? (one<Row>('SELECT name FROM users WHERE id = ?', id)?.name ?? null) : null;
}

function currentVersion(d: Row): Row | undefined {
  return d.version > 0 ? one<Row>('SELECT * FROM generated_doc_versions WHERE doc_id = ? AND version = ?', d.id, d.version) : undefined;
}

function sourcesView(s: SourceSnapshot) {
  return {
    repos: s.repos.map((r) => ({ id: r.repoId, name: r.name, slug: r.slug, branch: r.branch, commit: r.sha })),
    knowledge: s.knowledge ? { documents: s.knowledge.length, names: s.knowledge.slice(0, 20).map((k) => k.name) } : null,
    decisions: s.decisions !== null,
    diagrams: s.diagrams.map((g) => ({ id: g.id, slug: g.slug, title: g.title, version: g.version })),
  };
}

function versionView(d: Row, v: Row, detail: boolean) {
  const cites = parseJson<ResolvedCitation[]>(v.citations, []);
  const base = `/api/projects/${d.project_id}/generated-docs/${d.id}`;
  return {
    version: v.version,
    title: v.title,
    bytes: v.bytes,
    has_word: Boolean(v.file),
    template_used: v.template_used,
    warnings: parseJson<string[]>(v.warnings, []),
    citations: { total: cites.length, unresolved: cites.filter((c) => !c.ok).length, ...(detail ? { items: cites.map((c) => ({ text: c.raw, path: c.path, line: c.line, repo: c.repo, ok: c.ok, reason: c.reason })) } : {}) },
    sources: sourcesView(parseJson<SourceSnapshot>(v.sources, { repos: [], knowledge: null, decisions: null, diagrams: [] })),
    workflow_id: v.workflow_id,
    run_id: v.run_id,
    created_by: v.created_by,
    created_by_name: userName(v.created_by),
    created_at: v.created_at,
    links: { markdown: `${base}/download?format=md&version=${v.version}`, ...(v.file ? { word: `${base}/download?format=docx&version=${v.version}` } : {}) },
    ...(detail ? { markdown: v.markdown } : {}),
  };
}

function docView(d: Row, detail = false) {
  const wf = workflowState(d.workflow_id);
  const cur = currentVersion(d);
  const base = `/api/projects/${d.project_id}/generated-docs/${d.id}`;
  const diagramIds = parseJson<string[]>(d.diagram_ids, []);
  const view = {
    id: d.id,
    project_id: d.project_id,
    type: d.type as DocType,
    type_label: DOC_TYPE_LABELS[d.type as DocType] ?? d.type,
    title: d.title,
    audience: d.audience,
    repos: parseJson<string[]>(d.repo_ids, []).map((id) => {
      const r = findRepo(id);
      return { id, name: r?.name ?? '(removed repository)', slug: r?.slug ?? '', removed: !r };
    }),
    include_knowledge: Boolean(d.include_knowledge),
    include_decisions: Boolean(d.include_decisions),
    diagrams: diagramIds.map((id) => {
      const s = diagramSource(d.project_id, id);
      const pinned = cur ? parseJson<SourceSnapshot>(cur.sources, { repos: [], knowledge: null, decisions: null, diagrams: [] }).diagrams.find((g) => g.id === id) : undefined;
      return { id, title: s?.title ?? pinned?.title ?? '(removed diagram)', slug: s?.slug ?? pinned?.slug ?? '', removed: !s, used_version: pinned?.version ?? null, current_version: s?.version ?? null };
    }),
    template: { requested_id: d.template_id, requested_name: d.template_name, used: cur?.template_used ?? null },
    status: d.status,
    error: d.error,
    generating: d.status === 'generating',
    queued: d.status === 'generating' && wf?.status === 'queued',
    workflow_id: d.workflow_id,
    vault_files: generatedFiles(d.project_id, 'docs', d.vault_name),
    version: d.version,
    stale: Boolean(d.stale),
    stale_reasons: parseJson<string[]>(d.stale_reasons, []),
    warnings: cur ? parseJson<string[]>(cur.warnings, []) : [],
    citations: cur ? versionView(d, cur, false).citations : { total: 0, unresolved: 0 },
    bytes: cur?.bytes ?? 0,
    has_word: Boolean(cur?.file),
    generated_at: cur?.created_at ?? null,
    ...runOptionsView(d),
    links: cur ? { markdown: `${base}/download?format=md`, ...(cur.file ? { word: `${base}/download?format=docx` } : {}) } : null,
    created_by: d.created_by,
    created_by_name: userName(d.created_by),
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
  if (!detail) return view;
  return {
    ...view,
    markdown: cur?.markdown ?? '',
    current: cur ? versionView(d, cur, true) : null,
    versions: all<Row>('SELECT * FROM generated_doc_versions WHERE doc_id = ? ORDER BY version DESC', d.id).map((v) => versionView(d, v, false)),
  };
}

function getDoc(projectId: string, id: string): Row {
  const d = one<Row>('SELECT * FROM generated_docs WHERE id = ? AND project_id = ?', id, projectId);
  if (!d) throw notFound('Document not found');
  return d;
}

/* ------------------------------------------------------------------ */
/* Starting a generation                                               */
/* ------------------------------------------------------------------ */

function sessionIsActive(workflowId: string | null): boolean {
  if (!workflowId) return false;
  const w = one<Row>('SELECT status FROM workflows WHERE id = ?', workflowId);
  return Boolean(w && (w.status === 'running' || w.status === 'queued'));
}

/**
 * Start the session that writes (or rewrites) a document. Refuses before anything is written when the budget is used up,
 * a repository is not ready or a chosen diagram is gone. Returns the session row.
 */
export async function startGeneration(docId: string, userId: string, opts: { specId?: string | null; request?: RunOptionsRequest; audit?: (workflowId: string) => void; onOptions?: (o: RunOptions) => void } = {}): Promise<Row> {
  let d = one<Row>('SELECT * FROM generated_docs WHERE id = ?', docId);
  if (!d) throw notFound('Document not found');
  const project = getProject(d.project_id);
  if (d.status === 'generating' && sessionIsActive(d.pending_workflow_id)) throw badRequest('This document is already being written');
  const repos: Repo[] = [];
  for (const id of parseJson<string[]>(d.repo_ids, [])) {
    const r = findRepo(id);
    if (!r) throw badRequest('A repository of this document was removed from the project. Create the document again with the repositories it should use.');
    repos.push(r);
  }
  const diagrams = parseJson<string[]>(d.diagram_ids, []).map((id) => {
    const s = diagramSource(project.id, id);
    if (!s) throw badRequest('A diagram of this document was removed or has no version. Create the document again without it.');
    return s;
  });
  checkRunBudget(project.id, userId);
  for (const r of repos) await ensureFresh(r);
  d = one<Row>('SELECT * FROM generated_docs WHERE id = ?', docId)!;
  if (d.status === 'generating' && sessionIsActive(d.pending_workflow_id)) throw badRequest('This document is already being written');
  const snap = snapshotFor(d);
  const missing = snap.repos.find((r) => !r.sha);
  if (missing) throw badRequest(`Repository "${missing.name}" has no checkout yet. Sync it on the Repos tab.`);

  const goal = composeDocPrompt({
    type: d.type as DocType,
    title: d.title,
    audience: d.audience,
    repos: repos.map((r) => ({ name: r.name, slug: r.slug, branch: r.default_branch })),
    knowledge: Boolean(d.include_knowledge),
    decisions: Boolean(d.include_decisions),
    diagrams: diagrams.map((g) => ({ slug: g.slug, title: g.title, kind: g.kind, description: g.description })),
  });
  const chosen = resolveRunOptions(project, { request: opts.request, specId: opts.specId, stored: d });
  const w = await startPlaygroundRun({
    projectId: project.id,
    userId,
    leadAgent: chosen.leadAgent,
    trustTools: chosen.trustTools,
    title: `Document: ${d.title}`.slice(0, 120),
    goal,
    rules: 'Write only inside your run folder. Do not change anything inside repos/. Never copy secrets into the document. The portal collects document.md from your run folder by itself and keeps the result on the Create page (Documents tab) and in the project Vault (generated/docs/). If you are asked to change the document, write the complete new document.md again in your run folder; a reply without a new document.md changes nothing.',
    budgetUsd: DOC_LIMITS.budgetUsd,
    logLine: `Documentation session started for "${d.title}"`,
  });
  if (opts.specId) exec('UPDATE workflows SET loop_spec_id = ? WHERE id = ?', opts.specId, w.id);
  storeRunOptions('generated_docs', d.id, opts.request);
  for (const x of chosen.warnings) log(w.id, 'status', x);
  opts.onOptions?.(chosen);
  update('generated_docs', d.id, { status: 'generating', error: null, pending_workflow_id: w.id, workflow_id: w.id, pending_sources: JSON.stringify(snap), updated_at: now() });
  opts.audit?.(w.id);
  notifyProject(project.id, 'generated-docs.updated', { id: d.id });
  return one<Row>('SELECT * FROM workflows WHERE id = ?', w.id)!;
}

/* ------------------------------------------------------------------ */
/* Collecting the result                                               */
/* ------------------------------------------------------------------ */

function findMarkdown(base: string): { rel: string; mtime: number }[] {
  const out: { rel: string; mtime: number }[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6 || !fs.existsSync(dir) || out.length > 200) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'vault', 'repos'].includes(e.name) || e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r, depth + 1);
      else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push({ rel: r, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs });
    }
  };
  walk(base, '', 0);
  return out;
}

function failGeneration(d: Row, message: string, actor: string | null, w?: Row): void {
  update('generated_docs', d.id, {
    status: d.version > 0 ? 'ready' : 'error',
    error: message.slice(0, 600),
    pending_workflow_id: null,
    ...(w?.last_run_id ? { ingested_run_id: w.last_run_id } : {}),
    updated_at: now(),
  });
  auditRaw(actor, 'gendoc.version', `gendoc:${d.id}`, { projectId: d.project_id, ok: false, error: message.slice(0, 300) });
  if (w) log(w.id, 'status', `The document "${d.title}" was not stored: ${message.slice(0, 400)}`);
  notifyProject(d.project_id, 'generated-docs.updated', { id: d.id });
}

/** The agent left no new document in a follow-up: nothing changes, the document goes back to what it was. */
function settleUnchanged(d: Row, w: Row, why: string): void {
  update('generated_docs', d.id, { status: d.version > 0 ? 'ready' : 'error', pending_workflow_id: null, ingested_run_id: w.last_run_id ?? d.ingested_run_id, updated_at: now() });
  log(w.id, 'status', `${why}${d.version > 0 ? ` The stored document is still version ${d.version}.` : ''}`);
  notifyProject(d.project_id, 'generated-docs.updated', { id: d.id });
}

class NoDocumentError extends Error {}

/**
 * A message sent to the session of a document: it shows as being written again until the session ends. Does nothing for
 * any other session.
 */
export function followUpStarted(workflowId: string): void {
  const d = one<Row>('SELECT * FROM generated_docs WHERE workflow_id = ?', workflowId);
  if (!d || d.status === 'generating') return;
  update('generated_docs', d.id, { status: 'generating', pending_workflow_id: workflowId, updated_at: now() });
  notifyProject(d.project_id, 'generated-docs.updated', { id: d.id });
}

/** A file name for the document's copies in the Vault, fixed on first use so a rename never leaves copies behind. */
function vaultNameOf(d: Row): string {
  if (d.vault_name) return String(d.vault_name);
  const base = slugify(String(d.title), 60) || 'document';
  let name = base;
  for (let n = 2; one('SELECT 1 FROM generated_docs WHERE project_id = ? AND vault_name = ? AND id != ?', d.project_id, name, d.id); n++) name = `${base}-${n}`;
  exec('UPDATE generated_docs SET vault_name = ? WHERE id = ?', name, d.id);
  return name;
}

/** Keep a version in the project Vault: the Markdown and, when it was built, the Word file. Never throws. */
export function vaultSaveDoc(d: Row, v: Row, actor: string | null): void {
  try {
    const files: { ext: string; data: Buffer | string }[] = [{ ext: 'md', data: String(v.markdown) }];
    if (v.file && fs.existsSync(docxFile(d.project_id, v))) files.push({ ext: 'docx', data: fs.readFileSync(docxFile(d.project_id, v)) });
    saveGenerated(d.project_id, 'docs', vaultNameOf(d), files, actor);
  } catch {
    /* the copy is a convenience */
  }
}

/** Build the Word file for a version. Never throws: a failure becomes a warning and the version keeps its Markdown. */
async function buildWord(d: Row, markdown: string, warnings: string[]): Promise<{ buffer: Buffer | null; template: string | null }> {
  const project = getProject(d.project_id);
  try {
    let templatePath: string | undefined;
    if (d.template_id) {
      let t: Row | null = null;
      try {
        t = templateForProject(project.id, d.template_id);
      } catch {
        t = null;
      }
      if (t && t.kind === 'docx') templatePath = placeTemplate(project, t);
      else warnings.push(`The template "${d.template_name ?? d.template_id}" no longer exists or is not a Word template, so the project default was used.`);
    }
    syncProjectTemplates(project);
    const built = await withLock('gendoc-render', () =>
      renderDocx({ type: 'docx', output: 'document.docx', markdown, titleFromHeading: true, ...(templatePath ? { template: templatePath } : {}) }, projectDir(project)),
    );
    warnings.push(...built.warnings);
    if (d.template_name && !built.template) warnings.push(`The template "${d.template_name}" was not applied to this document.`);
    return { buffer: built.buffer, template: built.template ?? null };
  } catch (e: any) {
    warnings.push(`The Word file could not be built (${String(e?.message ?? e).split('\n')[0].slice(0, 200)}). The Markdown is available.`);
    return { buffer: null, template: null };
  }
}

/**
 * Store the document a finished session wrote as a new version. Safe to call more than once and for any session: it does
 * nothing unless the session belongs to a document that is still waiting for it.
 */
export async function ingestSession(workflowId: string): Promise<void> {
  const first = one<Row>('SELECT id FROM generated_docs WHERE pending_workflow_id = ? OR workflow_id = ?', workflowId, workflowId);
  if (!first) return;
  await withLock(`gendoc:${first.id}`, async () => {
    if (!isDbOpen()) return;
    const d = one<Row>('SELECT * FROM generated_docs WHERE id = ?', first.id);
    if (!d || (d.pending_workflow_id !== workflowId && d.workflow_id !== workflowId)) return;
    const waiting = d.pending_workflow_id === workflowId;
    const w = one<Row>('SELECT * FROM workflows WHERE id = ?', workflowId);
    if (!w) return waiting ? failGeneration(d, 'The documentation session was deleted before it finished.', null) : undefined;
    if (!TERMINAL.includes(w.status)) return;
    const sameRun = Boolean(w.last_run_id) && w.last_run_id === d.ingested_run_id;
    if (!waiting && (w.status !== 'done' || !w.last_run_id || sameRun)) return;
    if (waiting && sameRun && d.version > 0) return settleUnchanged(d, w, 'Nothing new was written in this session.');
    if (w.status !== 'done') return failGeneration(d, `The documentation session ended as ${w.status}${w.stop_reason ? `: ${w.stop_reason}` : ''}`, w.created_by);
    const followUp = Number(w.iteration) > 1;
    try {
      const run = w.last_run_id ? getRun(w.last_run_id) : null;
      const meta = parseJson<any>(run?.meta, {});
      if (!run || !meta.workDir) throw new Error('the session left no run folder');
      const project = getProject(d.project_id);
      const base = safeJoin(projectDir(project), String(meta.workDir));
      const warnings: string[] = [];

      // The Markdown: the file the agent named, else document.md, else the newest .md in its run folder, else (last resort) its reply.
      // A follow-up shares the first run's folder, so only files written since it began count as its work.
      const since = followUp ? Date.parse(String(run.started_at || run.created_at)) - 1000 : 0;
      const found = findMarkdown(base).filter((f) => f.mtime >= since);
      const said = parseDocReply(String(run.result ?? '')).path;
      let rel: string | null = null;
      if (said) {
        for (const cand of [path.resolve(projectDir(project), said), path.resolve(base, said)]) {
          if (cand.startsWith(base + path.sep) && /\.(md|markdown)$/i.test(cand) && fs.existsSync(cand) && fs.statSync(cand).mtimeMs >= since) rel = path.relative(base, cand).replace(/\\/g, '/');
        }
      }
      rel = rel ?? found.find((f) => f.rel === 'document.md')?.rel ?? found.sort((a, b) => b.mtime - a.mtime)[0]?.rel ?? null;
      let raw: string;
      if (rel) raw = fs.readFileSync(path.join(base, rel), 'utf8');
      else if (followUp) throw new NoDocumentError('The follow-up wrote no new document.md in its run folder, so nothing was changed. Ask the agent to rewrite the document to get a new version.');
      else {
        const reply = String(run.result ?? '').replace(/^\s*\**Document\**\s*:.*$/im, '').trim();
        if (reply.length < 500 || !/^#{1,3}\s+\S/m.test(reply)) throw new Error('The agent finished without saving a Markdown file (document.md) in its run folder.');
        raw = reply;
        warnings.push('The agent gave the document in its reply instead of saving a file; it was used as it stood.');
      }
      if (raw.trim().length < 80) throw new Error('The document is empty.');
      if (raw.length > DOC_LIMITS.markdownChars) throw new Error(`The document is longer than ${DOC_LIMITS.markdownChars.toLocaleString('en')} characters, which is more than the Word builder accepts. Ask for a narrower scope.`);

      // Stored diagrams go where the agent put their markers, at the versions the document was started with.
      const snap = parseJson<SourceSnapshot>(d.pending_sources, { repos: [], knowledge: null, decisions: null, diagrams: [] });
      const insertions = snap.diagrams.flatMap((g) => {
        const md = diagramMarkdown(d.project_id, g.id, { version: g.version ?? undefined, description: true, heading: false });
        if (!md) {
          warnings.push(`Diagram "${g.title}" could not be read, so it was left out.`);
          return [];
        }
        return [{ slug: g.slug, markdown: md }];
      });
      const placed = placeDiagrams(raw, insertions);
      for (const slug of placed.appended) warnings.push(`The agent did not place diagram "${snap.diagrams.find((g) => g.slug === slug)?.title ?? slug}", so it was added at the end under "Diagrams".`);
      if (placed.unknown.length) warnings.push(`The agent used diagram markers that were not chosen (${placed.unknown.slice(0, 3).join(', ')}); they were removed.`);
      const markdown = normalizeMarkdown(placed.markdown, d.title);

      // Citations against the snapshot the document was written from.
      const cites = checkCitations(projectDir(project), snap, extractCitations(markdown));
      const cw = citationWarning(cites);
      if (cw) warnings.push(cw);
      if (!cites.length && (snap.repos.length || snap.knowledge)) warnings.push('The document cites no source files. Treat its statements as unchecked.');

      // The Word file, following the template that applies.
      const word = await buildWord(d, markdown, warnings);

      const version = d.version + 1;
      const ts = now();
      let file: string | null = null;
      if (word.buffer) {
        file = `${d.id}-v${version}.docx`;
        fs.mkdirSync(storeDir(d.project_id), { recursive: true });
        fs.writeFileSync(path.join(storeDir(d.project_id), file), word.buffer);
      }
      const hash = hashOfSnapshot(snap);
      tx(() => {
        insert('generated_doc_versions', {
          doc_id: d.id,
          version,
          title: d.title,
          markdown,
          file,
          bytes: word.buffer?.length ?? 0,
          template_used: word.template,
          warnings: JSON.stringify(warnings.slice(0, 50)),
          citations: JSON.stringify(cites),
          sources: JSON.stringify(snap),
          source_hash: hash,
          workflow_id: workflowId,
          run_id: run.id,
          created_by: w.created_by,
          created_at: ts,
        });
        update('generated_docs', d.id, { version, status: 'ready', error: null, source_hash: hash, stale: 0, stale_reasons: '[]', pending_workflow_id: null, workflow_id: workflowId, ingested_run_id: run.id, updated_at: ts });
      });
      vaultSaveDoc(d, { markdown, file }, w.created_by);
      auditRaw(w.created_by, 'gendoc.version', `gendoc:${d.id}`, { projectId: d.project_id, ok: true, version, word: Boolean(file), template: word.template, citations: cites.length, unresolved: cites.filter((c) => !c.ok).length, warnings: warnings.length });
      notifyProject(d.project_id, 'generated-docs.updated', { id: d.id });
      refreshDocStale(d.project_id);
    } catch (e: any) {
      if (!isDbOpen()) return;
      if (e instanceof NoDocumentError) return settleUnchanged(d, w, e.message);
      const message = String(e?.message ?? e);
      failGeneration(d, d.version > 0 ? `${message} The previous version (v${d.version}) was kept.` : message, w.created_by, w);
    }
  });
}

/** Called when any session ends: stores the result when the session was writing a document. Never throws. */
export function onSessionStopped(workflowId: string): void {
  ingestSession(workflowId).catch(() => undefined);
}

/** Pick up documentation sessions that ended while the portal was down or before anyone looked. */
export async function reconcileDocs(projectId: string): Promise<void> {
  for (const d of all<Row>('SELECT pending_workflow_id AS wid FROM generated_docs WHERE project_id = ? AND pending_workflow_id IS NOT NULL', projectId)) {
    await ingestSession(d.wid);
  }
}

export interface DocRefreshResult {
  stale: number;
  started: { docId: string; title: string; workflowId: string }[];
  skipped: { docId: string; title: string; reason: string }[];
  warnings: string[];
}

/**
 * Rewrite the documents whose sources moved on (the "refresh_docs" action of loop specs and the Refresh stale button).
 * First brings the reference clones of those documents' repositories up to date, then starts up to `max` sessions,
 * oldest first. Each success appends a version.
 */
export async function refreshStaleDocs(projectId: string, userId: string, opts: { specId?: string | null; max?: number; ids?: string[]; request?: RunOptionsRequest; audit?: (docId: string, workflowId: string) => void } = {}): Promise<DocRefreshResult> {
  const repoIds = new Set<string>();
  for (const d of all<Row>('SELECT repo_ids FROM generated_docs WHERE project_id = ? AND version > 0', projectId)) for (const id of parseJson<string[]>(d.repo_ids, [])) repoIds.add(id);
  for (const id of repoIds) {
    const r = findRepo(id);
    if (r) await ensureFresh(r).catch(() => undefined);
  }
  refreshDocStale(projectId);
  const rows = all<Row>("SELECT * FROM generated_docs WHERE project_id = ? AND stale = 1 AND version > 0 ORDER BY updated_at", projectId).filter((d) => !opts.ids || opts.ids.includes(d.id));
  const max = Math.max(1, Math.min(opts.max ?? DOC_LIMITS.refreshBatch, DOC_LIMITS.refreshBatch));
  const out: DocRefreshResult = { stale: rows.length, started: [], skipped: [], warnings: [] };
  let stopReason = '';
  for (const d of rows) {
    if (d.status === 'generating' && sessionIsActive(d.pending_workflow_id)) {
      out.skipped.push({ docId: d.id, title: d.title, reason: 'It is already being rewritten.' });
      continue;
    }
    if (stopReason || out.started.length >= max) {
      out.skipped.push({ docId: d.id, title: d.title, reason: stopReason || `Only ${max} documents are refreshed at a time; the rest follow on the next run.` });
      continue;
    }
    try {
      const w = await startGeneration(d.id, userId, { specId: opts.specId, request: opts.request, audit: (wid) => opts.audit?.(d.id, wid), onOptions: (o) => out.warnings.push(...o.warnings.filter((x) => !out.warnings.includes(x))) });
      out.started.push({ docId: d.id, title: d.title, workflowId: w.id });
    } catch (e: any) {
      const reason = String(e?.message ?? e);
      out.skipped.push({ docId: d.id, title: d.title, reason });
      if (/budget/i.test(reason)) stopReason = reason;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function readFlag(v: unknown, name: string): number {
  if (v === undefined || v === null) return 1;
  if (typeof v !== 'boolean') throw badRequest(`${name} must be true or false`);
  return v ? 1 : 0;
}

function readIds(v: unknown, name: string, max: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest(`${name} must be a list`);
  const ids = [...new Set(v.map(String))];
  if (ids.length > max) throw badRequest(`Pick at most ${max} ${name === 'repoIds' ? 'repositories' : 'diagrams'}`);
  return ids;
}

/** The Word template chosen for a request, checked: a template of this project or the portal, and a Word one. */
function chosenTemplate(projectId: string, templateId: unknown): { id: string | null; name: string | null } {
  if (templateId === undefined || templateId === null || templateId === '') return { id: null, name: null };
  const t = templateForProject(projectId, String(templateId));
  if (t.kind !== 'docx') throw badRequest('Choose a Word template (.docx or .dotx)');
  return { id: t.id, name: t.name };
}

function wordCapability() {
  const reason = rendererProblem();
  return { diagrams: reason === null, diagramsReason: reason };
}

export function registerGeneratedDocRoutes(): void {
  get('/api/projects/:pid/generated-docs', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    await reconcileDocs(project.id);
    refreshDocStale(project.id);
    const rows = all<Row>('SELECT * FROM generated_docs WHERE project_id = ? ORDER BY updated_at DESC', project.id);
    const t = resolveTemplate(project.id, 'docx');
    return {
      documents: rows.map((d) => docView(d)),
      types: DOC_TYPES.map((id) => ({ id, label: DOC_TYPE_LABELS[id] })),
      template: t ? { id: t.id, name: t.name, scope: t.scope } : null,
      word: wordCapability(),
      runOptions: runOptionChoices(project),
      limits: { titleChars: DOC_LIMITS.titleChars, audienceChars: DOC_LIMITS.audienceChars, repos: DOC_LIMITS.repos, diagrams: DOC_LIMITS.diagrams, perProject: DOC_LIMITS.perProject },
    };
  });

  post('/api/projects/:pid/generated-docs', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    if (!DOC_TYPES.includes(body.type)) throw badRequest(`Type must be one of: ${DOC_TYPES.join(', ')}`);
    const type = body.type as DocType;
    if (Number(one<Row>('SELECT COUNT(*) AS n FROM generated_docs WHERE project_id = ?', project.id)?.n) >= DOC_LIMITS.perProject) {
      throw badRequest(`A project can hold at most ${DOC_LIMITS.perProject} generated documents. Delete one first.`);
    }
    const repoIds = readIds(body.repoIds, 'repoIds', DOC_LIMITS.repos);
    for (const id of repoIds) if (findRepo(id)?.project_id !== project.id) throw badRequest('That repository was not found in this project');
    const includeKnowledge = readFlag(body.includeKnowledge, 'includeKnowledge');
    const includeDecisions = readFlag(body.includeDecisions, 'includeDecisions');
    const diagramIds = readIds(body.diagramIds, 'diagramIds', DOC_LIMITS.diagrams).map((ref) => {
      const s = diagramSource(project.id, ref);
      if (!s) throw badRequest('That diagram was not found, or it has no version yet');
      return s.id;
    });
    if (!repoIds.length && !includeKnowledge && !includeDecisions && !diagramIds.length) throw badRequest('Choose at least one source: a repository, the knowledge documents, the decisions log or a diagram');
    const audience = str(body.audience, 'Audience', { max: DOC_LIMITS.audienceChars, optional: true }).trim();
    const names = repoIds.map((id) => findRepo(id)!.name);
    const title = str(body.title, 'Title', { max: DOC_LIMITS.titleChars, optional: true }).trim() || `${DOC_TYPE_LABELS[type]}: ${names.length ? names.join(', ') : project.name}`.slice(0, DOC_LIMITS.titleChars);
    const tpl = chosenTemplate(project.id, body.templateId);
    const request = readRunOptionsRequest(project, body);
    const id = newId('gd_');
    const ts = now();
    insert('generated_docs', {
      id,
      project_id: project.id,
      type,
      title,
      audience,
      repo_ids: JSON.stringify(repoIds),
      include_knowledge: includeKnowledge,
      include_decisions: includeDecisions,
      diagram_ids: JSON.stringify(diagramIds),
      template_id: tpl.id,
      template_name: tpl.name,
      status: 'generating',
      created_by: ctx.user!.id,
      created_at: ts,
      updated_at: ts,
    });
    try {
      let options: RunOptions | undefined;
      const w = await startGeneration(id, ctx.user!.id, { request, onOptions: (o) => (options = o), audit: (wid) => audit(ctx, 'gendoc.create', `gendoc:${id}`, { projectId: project.id, type, repos: repoIds.length, diagrams: diagramIds.length, workflowId: wid }) });
      return { document: docView(one<Row>('SELECT * FROM generated_docs WHERE id = ?', id)!), workflow: sessionView(w), warnings: options?.warnings ?? [] };
    } catch (e) {
      exec('DELETE FROM generated_docs WHERE id = ?', id);
      throw e;
    }
  });

  // Registered before the :id routes so "refresh-stale" is never read as an id.
  post('/api/projects/:pid/generated-docs/refresh-stale', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    await reconcileDocs(project.id);
    const body = await ctx.json().catch(() => ({}));
    const request = readRunOptionsRequest(project, body);
    const res = await refreshStaleDocs(project.id, ctx.user!.id, {
      request,
      audit: (docId, workflowId) => audit(ctx, 'gendoc.regenerate', `gendoc:${docId}`, { projectId: project.id, workflowId, reason: 'stale' }),
    });
    return { ...res, workflows: res.started.map((s) => sessionView(one<Row>('SELECT * FROM workflows WHERE id = ?', s.workflowId)!)) };
  });

  get('/api/projects/:pid/generated-docs/:id', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    await reconcileDocs(project.id);
    refreshDocStale(project.id);
    const d = getDoc(project.id, ctx.params.id);
    const wf = d.workflow_id ? one<Row>('SELECT * FROM workflows WHERE id = ?', d.workflow_id) : undefined;
    return { document: docView(d, true), workflow: wf ? sessionView(wf) : null, word: wordCapability() };
  });

  get('/api/projects/:pid/generated-docs/:id/versions/:version', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const d = getDoc(project.id, ctx.params.id);
    const n = Number(ctx.params.version);
    const v = Number.isInteger(n) ? one<Row>('SELECT * FROM generated_doc_versions WHERE doc_id = ? AND version = ?', d.id, n) : undefined;
    if (!v) throw notFound('Version not found');
    return { version: versionView(d, v, true), current: d.version === v.version };
  });

  post('/api/projects/:pid/generated-docs/:id/regenerate', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    await reconcileDocs(project.id);
    const d = getDoc(project.id, ctx.params.id);
    const body = await ctx.json().catch(() => ({}));
    const request = readRunOptionsRequest(project, body);
    const patch: Record<string, string | null> = {};
    if (body.audience !== undefined) patch.audience = str(body.audience, 'Audience', { max: DOC_LIMITS.audienceChars, optional: true }).trim();
    if (body.title !== undefined) patch.title = str(body.title, 'Title', { max: DOC_LIMITS.titleChars }).trim() || d.title;
    if (body.templateId !== undefined) {
      const tpl = chosenTemplate(project.id, body.templateId);
      patch.template_id = tpl.id;
      patch.template_name = tpl.name;
    }
    if (d.status === 'generating' && sessionIsActive(d.pending_workflow_id)) throw badRequest('This document is already being written');
    if (Object.keys(patch).length) update('generated_docs', d.id, { ...patch, updated_at: now() });
    let options: RunOptions | undefined;
    const w = await startGeneration(d.id, ctx.user!.id, { request, onOptions: (o) => (options = o), audit: (wid) => audit(ctx, 'gendoc.regenerate', `gendoc:${d.id}`, { projectId: project.id, workflowId: wid, version: d.version }) });
    return { document: docView(getDoc(project.id, d.id)), workflow: sessionView(w), warnings: options?.warnings ?? [] };
  });

  get('/api/projects/:pid/generated-docs/:id/download', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const d = getDoc(project.id, ctx.params.id);
    if (d.version < 1) throw badRequest('This document has no version to download yet');
    const n = ctx.query.get('version') ? Number(ctx.query.get('version')) : d.version;
    const v = Number.isInteger(n) ? one<Row>('SELECT * FROM generated_doc_versions WHERE doc_id = ? AND version = ?', d.id, n) : undefined;
    if (!v) throw notFound('Version not found');
    const format = ctx.query.get('format') || 'docx';
    if (format !== 'docx' && format !== 'md') throw badRequest('Format must be docx or md');
    const base = `${String(d.title).replace(/[^\w .-]+/g, '_').trim().slice(0, 80) || 'document'}${n === d.version ? '' : `-v${n}`}`;
    if (format === 'md') {
      audit(ctx, 'gendoc.download', `gendoc:${d.id}`, { projectId: project.id, format, version: n });
      return sendFile(ctx.res, String(v.markdown), 'text/markdown; charset=utf-8', `${base}.md`);
    }
    if (!v.file || !fs.existsSync(docxFile(project.id, v))) {
      throw new HttpError(404, 'This version has no Word file (it could not be built). Download the Markdown (format=md) instead.');
    }
    audit(ctx, 'gendoc.download', `gendoc:${d.id}`, { projectId: project.id, format, version: n });
    return sendFile(ctx.res, fs.readFileSync(docxFile(project.id, v)), DOCX_MIME, `${base}.docx`);
  });

  del('/api/projects/:pid/generated-docs/:id', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const d = getDoc(project.id, ctx.params.id);
    if (d.status === 'generating' && sessionIsActive(d.pending_workflow_id)) throw badRequest('This document is still being written. Stop its session first.');
    const files = all<Row>('SELECT file FROM generated_doc_versions WHERE doc_id = ? AND file IS NOT NULL', d.id).map((v) => String(v.file));
    exec('DELETE FROM generated_docs WHERE id = ?', d.id);
    removeGenerated(project.id, 'docs', d.vault_name, ctx.user!.id);
    for (const f of files) {
      try {
        fs.rmSync(path.join(storeDir(project.id), f), { force: true });
      } catch {
        /* the row is gone; stray files are harmless */
      }
    }
    audit(ctx, 'gendoc.delete', `gendoc:${d.id}`, { projectId: project.id, title: d.title });
    notifyProject(project.id, 'generated-docs.updated', { id: d.id });
    return { ok: true };
  });
}
