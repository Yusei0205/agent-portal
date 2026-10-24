/**
 * Architecture diagram generator (NEW-1).
 *
 * A project keeps Mermaid diagrams (system context, components, data flow) drawn from its repositories. An agent session
 * does the drawing, exactly like the "Document a repository" mode: a single unattended run that reads the repository's
 * reference clone in place and replies with Mermaid source plus a short description that cites files. The reply is
 * checked (syntax and size) before it becomes a new version; an invalid reply keeps the previous version and reports
 * the error. Every version is kept in the database, and the latest one is committed to the project's git repository
 * under docs/diagrams/ (FR-PROJ-5), so git history has it too.
 *
 * A diagram is stale when the HEAD of any of its repositories is no longer the commit its latest version was drawn
 * from (the same idea as Learn's source hashes). A loop spec can refresh stale diagrams (trigger_config.action
 * "refresh_diagrams"), and other features embed a stored diagram with diagramSource() / diagramMarkdown().
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { all, insert, isDbOpen, one, run as exec, tx, update, type Row } from './db.ts';
import { del, get, patch, post, sendFile } from './http.ts';
import { commitProject, getProject, notifyProject, projectDir, requireProject } from './projects.ts';
import { ensureFresh, getRepo, repoDir, type Repo } from './repos.ts';
import { HttpError, badRequest, newId, notFound, now, parseJson, sha256, slugify, str, withLock } from './util.ts';
import { audit, auditRaw } from './audit.ts';
import { assertBudget, getSettings } from './settings.ts';
import { concurrencyReason, queueReasonLabel } from './control-plane.ts';
import { engineProvider } from './project-aws.ts';
import { getRun } from './agent/runner.ts';
import { renderToPng, rendererProblem } from './docimage.ts';
import { log } from './workflows/store.ts';
import { view as sessionView } from './workflows/views.ts';
import { readSettings } from './workflows/validation.ts';
import {
  DIAGRAM_KINDS,
  DIAGRAM_LIMITS,
  DiagramError,
  KIND_LABELS,
  composeDiagramPrompt,
  parseDiagramReply,
  validateMermaid,
  type DiagramKind,
} from './diagram-text.ts';

export { DIAGRAM_KINDS, DIAGRAM_LIMITS, KIND_LABELS, type DiagramKind } from './diagram-text.ts';

/** Where in the project's git repository the diagrams are kept. */
export const DIAGRAMS_DIR = 'docs/diagrams';

const TERMINAL = ['done', 'blocked', 'failed', 'stopped'];
/** Budget of one diagram session in dollars; a diagram is a bounded, read-only task. */
const DIAGRAM_BUDGET_USD = 5;

export interface DiagramSource {
  repoId: string;
  name: string;
  slug: string;
  branch: string;
  sha: string;
}

/* ------------------------------------------------------------------ */
/* Source hashes and stale tracking                                    */
/* ------------------------------------------------------------------ */

/** HEAD of a repository's reference clone, or null when it has none (never the project's own repository above it). */
export function headSha(repo: Repo): string | null {
  const dir = repoDir(repo);
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  try {
    const out = execFileSync('git', ['-c', 'core.longpaths=true', 'rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return /^[0-9a-f]{7,64}$/.test(out.trim()) ? out.trim() : null;
  } catch {
    return null;
  }
}

function findRepo(id: string): Repo | null {
  return one<Repo>('SELECT * FROM repos WHERE id = ?', id) ?? null;
}

/** One hash for a set of (repository, commit) pairs; 'missing' when a repository is gone or has no checkout. */
export function hashOfSources(pairs: { repoId: string; sha: string | null }[]): string {
  if (!pairs.length || pairs.some((p) => !p.sha)) return 'missing';
  return sha256(
    pairs
      .map((p) => `${p.repoId}@${p.sha}`)
      .sort()
      .join('|'),
  );
}

function currentHash(repoIds: string[], heads: Map<string, string | null>): string {
  return hashOfSources(
    repoIds.map((id) => {
      if (!heads.has(id)) {
        const r = findRepo(id);
        heads.set(id, r ? headSha(r) : null);
      }
      return { repoId: id, sha: heads.get(id) ?? null };
    }),
  );
}

/** Recompute the stale flag of every finished diagram of a project; tells the UI when one changed. Cheap enough to call on reads. */
export function refreshDiagramStale(projectId: string): void {
  if (!isDbOpen()) return;
  const heads = new Map<string, string | null>();
  let changed = false;
  for (const d of all<Row>('SELECT id, repo_ids, source_hash, stale FROM diagrams WHERE project_id = ? AND version > 0', projectId)) {
    const stale = currentHash(parseJson<string[]>(d.repo_ids, []), heads) !== d.source_hash ? 1 : 0;
    if (stale !== d.stale) {
      exec('UPDATE diagrams SET stale = ? WHERE id = ?', stale, d.id);
      changed = true;
    }
  }
  if (changed) notifyProject(projectId, 'diagrams.updated', {});
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

function getDiagramRow(projectId: string, ref: string): Row {
  const r = one<Row>('SELECT * FROM diagrams WHERE project_id = ? AND (id = ? OR slug = ?)', projectId, ref, ref);
  if (!r) throw notFound('Diagram not found');
  return r;
}

function versionRow(diagramId: string, version: number): Row | undefined {
  return one<Row>('SELECT * FROM diagram_versions WHERE diagram_id = ? AND version = ?', diagramId, version);
}

function versionView(v: Row, withSource: boolean) {
  const base = {
    version: v.version,
    description: v.description,
    citations: parseJson<string[]>(v.citations, []),
    sources: parseJson<DiagramSource[]>(v.sources, []),
    workflow_id: v.workflow_id,
    run_id: v.run_id,
    created_by: v.created_by,
    created_by_name: one<Row>('SELECT name FROM users WHERE id = ?', v.created_by)?.name ?? null,
    created_at: v.created_at,
    chars: String(v.mermaid).length,
  };
  return withSource ? { ...base, mermaid: v.mermaid } : base;
}

function diagramView(d: Row, withSource = false) {
  const cur = d.version > 0 ? versionRow(d.id, d.version) : undefined;
  const repoIds = parseJson<string[]>(d.repo_ids, []);
  return {
    id: d.id,
    project_id: d.project_id,
    kind: d.kind,
    kind_label: KIND_LABELS[d.kind as DiagramKind] ?? d.kind,
    title: d.title,
    slug: d.slug,
    focus: d.focus,
    repos: repoIds.map((id) => {
      const r = findRepo(id);
      return { id, name: r?.name ?? '(removed repository)', slug: r?.slug ?? '', removed: !r };
    }),
    status: d.status,
    error: d.error,
    version: d.version,
    stale: d.stale,
    generating: d.status === 'generating',
    workflow_id: d.pending_workflow_id,
    path: `${DIAGRAMS_DIR}/${d.slug}.mmd`,
    description: cur?.description ?? '',
    citations: cur ? parseJson<string[]>(cur.citations, []) : [],
    sources: cur ? parseJson<DiagramSource[]>(cur.sources, []) : [],
    generated_at: cur?.created_at ?? null,
    created_by: d.created_by,
    created_by_name: one<Row>('SELECT name FROM users WHERE id = ?', d.created_by)?.name ?? null,
    created_at: d.created_at,
    updated_at: d.updated_at,
    ...(withSource ? { mermaid: cur?.mermaid ?? '' } : {}),
  };
}

/** A stored diagram for other features (documents, presentations): its Mermaid source and where it came from. */
export function diagramSource(projectId: string, ref: string, version?: number) {
  const d = one<Row>('SELECT * FROM diagrams WHERE project_id = ? AND (id = ? OR slug = ?)', projectId, ref, ref);
  if (!d || d.version < 1) return null;
  const v = versionRow(d.id, version ?? d.version);
  if (!v) return null;
  return {
    id: String(d.id),
    slug: String(d.slug),
    title: String(d.title),
    kind: d.kind as DiagramKind,
    version: Number(v.version),
    mermaid: String(v.mermaid),
    description: String(v.description),
    stale: Boolean(d.stale),
    sources: parseJson<DiagramSource[]>(v.sources, []),
  };
}

/**
 * Markdown ready for make-doc (NEW-8 renders the fence as a picture in Word and PowerPoint): the diagram in a mermaid
 * fence, followed by its description when asked. Null when the diagram does not exist or has no version yet.
 */
export function diagramMarkdown(projectId: string, ref: string, opts: { version?: number; description?: boolean; heading?: boolean } = {}): string | null {
  const s = diagramSource(projectId, ref, opts.version);
  if (!s) return null;
  const parts = [];
  if (opts.heading) parts.push(`## ${s.title}`);
  parts.push('```mermaid\n' + s.mermaid + '\n```');
  if (opts.description && s.description) parts.push(s.description);
  return parts.join('\n\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Files in the project's git repository                               */
/* ------------------------------------------------------------------ */

async function writeFiles(d: Row, v: Record<string, any>, message: string): Promise<void> {
  const project = getProject(d.project_id);
  const dir = path.join(projectDir(project), DIAGRAMS_DIR);
  await withLock(`git:${projectDir(project)}`, async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${d.slug}.mmd`), String(v.mermaid).replace(/\s+$/, '') + '\n');
    fs.writeFileSync(
      path.join(dir, `${d.slug}.json`),
      JSON.stringify(
        {
          id: d.id,
          kind: d.kind,
          title: d.title,
          version: v.version,
          generatedAt: v.created_at,
          sources: parseJson(v.sources, []),
          description: v.description,
          citations: parseJson(v.citations, []),
        },
        null,
        2,
      ) + '\n',
    );
  });
  await commitProject(d.project_id, message, [DIAGRAMS_DIR]).catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Generation: start a session, then store what it returns             */
/* ------------------------------------------------------------------ */

function reposOf(d: Row): Repo[] {
  const out: Repo[] = [];
  for (const id of parseJson<string[]>(d.repo_ids, [])) {
    const r = findRepo(id);
    if (!r) throw badRequest('A repository of this diagram was removed from the project. Create the diagram again with the repositories it should use.');
    out.push(r);
  }
  if (!out.length) throw badRequest('The diagram has no repository');
  return out;
}

function sessionIsActive(workflowId: string | null): boolean {
  if (!workflowId) return false;
  const w = one<Row>('SELECT status FROM workflows WHERE id = ?', workflowId);
  return Boolean(w && (w.status === 'running' || w.status === 'queued'));
}

/**
 * Start the session that draws (or redraws) a diagram. Refuses when the budget is used up or a repository is not ready,
 * before anything is written. Returns the session row.
 */
export async function startGeneration(diagramId: string, userId: string, opts: { focus?: string; specId?: string | null; audit?: (workflowId: string) => void } = {}): Promise<Row> {
  let d = one<Row>('SELECT * FROM diagrams WHERE id = ?', diagramId);
  if (!d) throw notFound('Diagram not found');
  const project = getProject(d.project_id);
  if (d.status === 'generating' && sessionIsActive(d.pending_workflow_id)) throw badRequest('This diagram is already being drawn');
  const repos = reposOf(d);
  try {
    assertBudget(engineProvider(project.id, null), userId, project.id);
  } catch (e: any) {
    throw badRequest(e?.message ?? String(e));
  }
  for (const r of repos) await ensureFresh(r);
  const sources: DiagramSource[] = repos.map((r) => ({ repoId: r.id, name: r.name, slug: r.slug, branch: r.default_branch, sha: headSha(r) ?? '' }));
  const missing = sources.find((s) => !s.sha);
  if (missing) throw badRequest(`Repository "${missing.name}" has no checkout yet. Sync it on the Repos tab.`);
  d = one<Row>('SELECT * FROM diagrams WHERE id = ?', diagramId)!;
  if (d.status === 'generating' && sessionIsActive(d.pending_workflow_id)) throw badRequest('This diagram is already being drawn');

  const focus = (opts.focus ?? d.focus ?? '').trim().slice(0, DIAGRAM_LIMITS.focusChars);
  const goal = composeDiagramPrompt(d.kind as DiagramKind, d.title, repos, focus);
  const s = readSettings(
    { model: project.default_model || undefined, budgetUsd: DIAGRAM_BUDGET_USD, maxIterations: 1, pushMode: 'never', permissionMode: '' },
    undefined,
    { hasRepos: false, isPlayground: true },
  );
  const reason = concurrencyReason(userId, project.id);
  const queued = reason !== null;
  const id = newId('w_');
  const ts = now();
  insert('workflows', {
    id,
    project_id: project.id,
    title: `Diagram: ${d.title}`.slice(0, 120),
    goal,
    status: queued ? 'queued' : 'running',
    stop_reason: queued ? queueReasonLabel(reason!) : '',
    queue_reason: queued ? reason! : '',
    queued_at: queued ? ts : null,
    repo_id: null,
    branch: null,
    repos: '[]',
    workspace_id: null,
    engine: '',
    integrations: '[]',
    playground: 1,
    ...s,
    rules: 'This is a read-only task. Do not create, edit or delete any file. Reply with the diagram and its description only.',
    iteration: 0,
    burst_start: 0,
    spent_usd: 0,
    spent_credits: 0,
    work_branch: '',
    lead_agent: '',
    jira_key: '',
    jira_summary: '',
    jira_url: '',
    summary: '',
    loop_spec_id: opts.specId ?? null,
    planning_gate: 0,
    created_by: userId,
    created_at: ts,
    updated_at: ts,
  });
  update('diagrams', d.id, { status: 'generating', error: null, pending_workflow_id: id, pending_sources: JSON.stringify(sources), focus, updated_at: ts });
  log(id, 'system', `Diagram session started for "${d.title}"`);
  opts.audit?.(id);
  notifyProject(project.id, 'diagrams.updated', { id: d.id });
  notifyProject(project.id, 'workflow.created', { id });
  if (!queued) {
    const { kick } = await import('./workflows/driver.ts');
    kick(id);
  }
  return one<Row>('SELECT * FROM workflows WHERE id = ?', id)!;
}

/** Record a failed attempt: the previous version, if any, stays current. */
function failGeneration(d: Row, message: string, actor: string | null): void {
  update('diagrams', d.id, { status: d.version > 0 ? 'ready' : 'error', error: message.slice(0, 600), pending_workflow_id: null, updated_at: now() });
  auditRaw(actor, 'diagram.version', `diagram:${d.id}`, { projectId: d.project_id, ok: false, error: message.slice(0, 300) });
  notifyProject(d.project_id, 'diagrams.updated', { id: d.id });
}

/**
 * Store the result of a finished diagram session as a new version. Safe to call more than once and for any session:
 * it does nothing unless the session belongs to a diagram that is still waiting for it.
 */
export async function ingestSession(workflowId: string): Promise<void> {
  const first = one<Row>('SELECT id FROM diagrams WHERE pending_workflow_id = ?', workflowId);
  if (!first) return;
  await withLock(`diagram:${first.id}`, async () => {
    if (!isDbOpen()) return;
    const d = one<Row>('SELECT * FROM diagrams WHERE id = ?', first.id);
    if (!d || d.pending_workflow_id !== workflowId) return;
    const w = one<Row>('SELECT * FROM workflows WHERE id = ?', workflowId);
    if (!w) return failGeneration(d, 'The diagram session was deleted before it finished.', null);
    if (!TERMINAL.includes(w.status)) return;
    if (w.status !== 'done') return failGeneration(d, `The diagram session ended as ${w.status}${w.stop_reason ? `: ${w.stop_reason}` : ''}`, w.created_by);
    try {
      const run = w.last_run_id ? getRun(w.last_run_id) : null;
      const parsed = parseDiagramReply(run?.result ?? '');
      const ok = await validateMermaid(parsed.mermaid);
      const sources = parseJson<DiagramSource[]>(d.pending_sources, []);
      const hash = hashOfSources(sources.map((s) => ({ repoId: s.repoId, sha: s.sha || null })));
      const version = d.version + 1;
      const ts = now();
      const row = {
        diagram_id: d.id,
        version,
        mermaid: ok.source,
        description: parsed.description,
        citations: JSON.stringify(parsed.citations),
        sources: JSON.stringify(sources),
        source_hash: hash,
        workflow_id: workflowId,
        run_id: run?.id ?? null,
        created_by: w.created_by,
        created_at: ts,
      };
      // The files and their commit come first, so a diagram that reads "ready" is already in the project's repository.
      await writeFiles(d, row, `${version === 1 ? 'Add' : 'Update'} diagram ${d.title} (v${version})`);
      tx(() => {
        insert('diagram_versions', row);
        update('diagrams', d.id, { version, status: 'ready', error: null, source_hash: hash, stale: 0, pending_workflow_id: null, updated_at: ts });
      });
      auditRaw(w.created_by, 'diagram.version', `diagram:${d.id}`, { projectId: d.project_id, ok: true, version, type: ok.type, parsed: ok.parsed });
      notifyProject(d.project_id, 'diagrams.updated', { id: d.id });
      refreshDiagramStale(d.project_id);
      void import('./generated-docs.ts').then((m) => m.refreshDocStale(d.project_id)).catch(() => undefined);
    } catch (e: any) {
      if (!isDbOpen()) return;
      const message = e instanceof DiagramError ? e.message : `Could not store the diagram: ${String(e?.message ?? e)}`;
      failGeneration(d, d.version > 0 ? `${message} The previous version (v${d.version}) was kept.` : message, w.created_by);
    }
  });
}

/** Called when any session ends: stores the result when the session was drawing a diagram. Never throws. */
export function onSessionStopped(workflowId: string): void {
  ingestSession(workflowId).catch(() => undefined);
}

/** Pick up diagram sessions that ended while the portal was down or before anyone looked. */
export async function reconcileDiagrams(projectId: string): Promise<void> {
  for (const d of all<Row>('SELECT pending_workflow_id AS wid FROM diagrams WHERE project_id = ? AND pending_workflow_id IS NOT NULL', projectId)) {
    await ingestSession(d.wid);
  }
}

export interface RefreshResult {
  stale: number;
  started: { diagramId: string; title: string; workflowId: string }[];
  skipped: { diagramId: string; title: string; reason: string }[];
}

/**
 * Redraw the diagrams whose repositories moved on (the "refresh diagrams" action of loop specs and the Refresh stale
 * button). First brings the repositories' reference clones up to date, then starts up to `max` sessions, oldest first.
 */
export async function refreshStaleDiagrams(projectId: string, userId: string, opts: { specId?: string | null; max?: number; ids?: string[]; audit?: (diagramId: string, workflowId: string) => void } = {}): Promise<RefreshResult> {
  const repoIds = new Set<string>();
  for (const d of all<Row>('SELECT repo_ids FROM diagrams WHERE project_id = ? AND version > 0', projectId)) for (const id of parseJson<string[]>(d.repo_ids, [])) repoIds.add(id);
  for (const id of repoIds) {
    const r = findRepo(id);
    if (r) await ensureFresh(r).catch(() => undefined);
  }
  refreshDiagramStale(projectId);
  const rows = all<Row>("SELECT * FROM diagrams WHERE project_id = ? AND stale = 1 AND version > 0 AND status != 'generating' ORDER BY updated_at", projectId).filter((d) => !opts.ids || opts.ids.includes(d.id));
  const max = Math.max(1, Math.min(opts.max ?? DIAGRAM_LIMITS.refreshBatch, DIAGRAM_LIMITS.refreshBatch));
  const out: RefreshResult = { stale: rows.length, started: [], skipped: [] };
  let stopReason = '';
  for (const d of rows) {
    if (stopReason || out.started.length >= max) {
      out.skipped.push({ diagramId: d.id, title: d.title, reason: stopReason || `Only ${max} diagrams are refreshed at a time; the rest follow on the next run.` });
      continue;
    }
    try {
      const w = await startGeneration(d.id, userId, { specId: opts.specId, audit: (wid) => opts.audit?.(d.id, wid) });
      out.started.push({ diagramId: d.id, title: d.title, workflowId: w.id });
    } catch (e: any) {
      const reason = String(e?.message ?? e);
      out.skipped.push({ diagramId: d.id, title: d.title, reason });
      if (/budget/i.test(reason)) stopReason = reason;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function readKind(v: unknown): DiagramKind {
  if (!DIAGRAM_KINDS.includes(v as DiagramKind)) throw badRequest(`Kind must be one of: ${DIAGRAM_KINDS.join(', ')}`);
  return v as DiagramKind;
}

function readRepoIds(projectId: string, body: any): string[] {
  const raw: unknown[] = Array.isArray(body.repoIds) ? body.repoIds : body.repoId ? [body.repoId] : [];
  const ids = [...new Set(raw.map(String))];
  if (!ids.length) throw badRequest('Pick at least one repository');
  if (ids.length > DIAGRAM_LIMITS.repos) throw badRequest(`Pick at most ${DIAGRAM_LIMITS.repos} repositories`);
  for (const id of ids) if (getRepo(id).project_id !== projectId) throw badRequest('That repository belongs to another project');
  return ids;
}

function uniqueSlug(projectId: string, title: string): string {
  const base = slugify(title) || 'diagram';
  let slug = base;
  for (let n = 2; one('SELECT 1 FROM diagrams WHERE project_id = ? AND slug = ?', projectId, slug); n++) slug = `${base}-${n}`;
  return slug;
}

function pngCapability() {
  const reason = rendererProblem();
  return { png: reason === null, pngReason: reason };
}

export function registerDiagramRoutes(): void {
  get('/api/projects/:pid/diagrams', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    await reconcileDiagrams(project.id);
    refreshDiagramStale(project.id);
    const rows = all<Row>('SELECT * FROM diagrams WHERE project_id = ? ORDER BY updated_at DESC', project.id);
    return {
      diagrams: rows.map((d) => diagramView(d)),
      kinds: DIAGRAM_KINDS.map((id) => ({ id, label: KIND_LABELS[id] })),
      export: pngCapability(),
      limits: { mermaidChars: DIAGRAM_LIMITS.mermaidChars, repos: DIAGRAM_LIMITS.repos, focusChars: DIAGRAM_LIMITS.focusChars, perProject: DIAGRAM_LIMITS.perProject },
    };
  });

  post('/api/projects/:pid/diagrams', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const kind = readKind(body.kind);
    const repoIds = readRepoIds(project.id, body);
    if (Number(one<Row>('SELECT COUNT(*) AS n FROM diagrams WHERE project_id = ?', project.id)?.n) >= DIAGRAM_LIMITS.perProject) {
      throw badRequest(`A project can hold at most ${DIAGRAM_LIMITS.perProject} diagrams. Delete one first.`);
    }
    const names = repoIds.map((id) => getRepo(id).name);
    const title = str(body.title, 'Title', { max: DIAGRAM_LIMITS.titleChars, optional: true }).trim() || `${KIND_LABELS[kind]}: ${names.join(', ')}`.slice(0, DIAGRAM_LIMITS.titleChars);
    const focus = str(body.focus, 'Focus', { max: DIAGRAM_LIMITS.focusChars, optional: true }).trim();
    const id = newId('dg_');
    const ts = now();
    insert('diagrams', { id, project_id: project.id, kind, title, slug: uniqueSlug(project.id, title), focus, repo_ids: JSON.stringify(repoIds), status: 'generating', created_by: ctx.user!.id, created_at: ts, updated_at: ts });
    try {
      const w = await startGeneration(id, ctx.user!.id, { focus, audit: (wid) => audit(ctx, 'diagram.create', `diagram:${id}`, { projectId: project.id, kind, workflowId: wid }) });
      return { diagram: diagramView(one<Row>('SELECT * FROM diagrams WHERE id = ?', id)!), workflow: sessionView(w) };
    } catch (e) {
      exec('DELETE FROM diagrams WHERE id = ?', id);
      throw e;
    }
  });

  // Registered before the :id routes so "refresh-stale" is never read as an id.
  post('/api/projects/:pid/diagrams/refresh-stale', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const res = await refreshStaleDiagrams(project.id, ctx.user!.id, {
      audit: (diagramId, workflowId) => audit(ctx, 'diagram.refresh', `diagram:${diagramId}`, { projectId: project.id, workflowId }),
    });
    return { ...res, workflows: res.started.map((s) => sessionView(one<Row>('SELECT * FROM workflows WHERE id = ?', s.workflowId)!)) };
  });

  get('/api/projects/:pid/diagrams/:id', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    await reconcileDiagrams(project.id);
    refreshDiagramStale(project.id);
    const d = getDiagramRow(project.id, ctx.params.id);
    const versions = all<Row>('SELECT * FROM diagram_versions WHERE diagram_id = ? ORDER BY version DESC', d.id).map((v) => versionView(v, false));
    return { diagram: diagramView(d, true), versions, export: pngCapability() };
  });

  get('/api/projects/:pid/diagrams/:id/versions/:version', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const d = getDiagramRow(project.id, ctx.params.id);
    const n = Number(ctx.params.version);
    const v = Number.isInteger(n) ? versionRow(d.id, n) : undefined;
    if (!v) throw notFound('Version not found');
    return { version: versionView(v, true), current: d.version === v.version };
  });

  patch('/api/projects/:pid/diagrams/:id', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const d = getDiagramRow(project.id, ctx.params.id);
    const body = await ctx.json();
    const p: Record<string, string> = { updated_at: now() };
    if (body.title !== undefined) p.title = str(body.title, 'Title', { max: DIAGRAM_LIMITS.titleChars }).trim();
    if (body.focus !== undefined) p.focus = str(body.focus, 'Focus', { max: DIAGRAM_LIMITS.focusChars, optional: true }).trim();
    update('diagrams', d.id, p);
    notifyProject(project.id, 'diagrams.updated', { id: d.id });
    return { diagram: diagramView(getDiagramRow(project.id, d.id)) };
  });

  post('/api/projects/:pid/diagrams/:id/refresh', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    await reconcileDiagrams(project.id);
    const d = getDiagramRow(project.id, ctx.params.id);
    const body = await ctx.json().catch(() => ({}));
    const focus = body.focus === undefined ? undefined : str(body.focus, 'Focus', { max: DIAGRAM_LIMITS.focusChars, optional: true });
    const w = await startGeneration(d.id, ctx.user!.id, { focus, audit: (wid) => audit(ctx, 'diagram.refresh', `diagram:${d.id}`, { projectId: project.id, workflowId: wid }) });
    return { diagram: diagramView(getDiagramRow(project.id, d.id)), workflow: sessionView(w) };
  });

  del('/api/projects/:pid/diagrams/:id', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const d = getDiagramRow(project.id, ctx.params.id);
    exec('DELETE FROM diagrams WHERE id = ?', d.id);
    const dir = path.join(projectDir(project), DIAGRAMS_DIR);
    await withLock(`git:${projectDir(project)}`, async () => {
      for (const ext of ['mmd', 'json']) fs.rmSync(path.join(dir, `${d.slug}.${ext}`), { force: true });
    });
    await commitProject(project.id, `Delete diagram ${d.title}`, [DIAGRAMS_DIR]).catch(() => undefined);
    void import('./generated-docs.ts').then((m) => m.refreshDocStale(project.id)).catch(() => undefined);
    audit(ctx, 'diagram.delete', `diagram:${d.id}`, { projectId: project.id, title: d.title });
    notifyProject(project.id, 'diagrams.updated', { id: d.id });
    return { ok: true };
  });

  get('/api/projects/:pid/diagrams/:id/export', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const d = getDiagramRow(project.id, ctx.params.id);
    if (d.version < 1) throw badRequest('This diagram has no version to export yet');
    const n = ctx.query.get('version') ? Number(ctx.query.get('version')) : d.version;
    const v = Number.isInteger(n) ? versionRow(d.id, n) : undefined;
    if (!v) throw notFound('Version not found');
    const format = ctx.query.get('format') || 'png';
    const base = n === d.version ? d.slug : `${d.slug}-v${n}`;
    if (format === 'mmd') {
      audit(ctx, 'diagram.export', `diagram:${d.id}`, { projectId: project.id, format, version: n });
      return sendFile(ctx.res, String(v.mermaid).replace(/\s+$/, '') + '\n', 'text/plain; charset=utf-8', `${base}.mmd`);
    }
    if (format !== 'png') throw badRequest('Format must be png or mmd');
    const problem = rendererProblem();
    if (problem) {
      throw new HttpError(501, `PNG export is not available on this server: ${problem}. Download the Mermaid source (format=mmd) instead.`);
    }
    const [res] = await withLock('diagram-render', () => renderToPng([{ kind: 'mermaid', source: String(v.mermaid) }]));
    if (!res.ok) throw new HttpError(422, `The diagram could not be drawn as a picture: ${res.reason}. Download the Mermaid source (format=mmd) instead.`);
    audit(ctx, 'diagram.export', `diagram:${d.id}`, { projectId: project.id, format, version: n });
    return sendFile(ctx.res, res.image.data, 'image/png', `${base}.png`);
  });
}
