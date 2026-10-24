/**
 * "Keep docs current" (NEW-2): refresh stale architecture diagrams and generated documents in one firing of a loop spec
 * and propose the result as ONE pull request.
 *
 * A spec names its actions in trigger_config (`action`, or `actions` for several, see loop-specs.ts) and, with
 * `publishPr`, asks for the result to land in a repository. One firing then works like this:
 *
 *  1. Find what is really stale. A diagram or document is stale when its sources moved (FR-DIAG-5, FR-GDOC-5), but a
 *     repository that only gained commits touching docs/generated/ or docs/diagrams/ (this feature's own merged pull
 *     request) does not count, so the pull request does not feed itself. Nothing stale: no session and no pull request.
 *  2. Create one coordinating session (a paused row that never runs an agent) and start the existing refresh sessions:
 *     diagrams first, then, once those are stored, documents (they embed the new diagram versions).
 *  3. When every refresh session has been stored, write the latest version of each refreshed item as a file in a work
 *     branch of one repository (docs/diagrams/<slug>.mmd, docs/generated/<slug>.md; the Word files stay in the portal),
 *     check the changed .mmd files with Mermaid, run the spec's verification pipeline in the working copy, and hand the
 *     working copy to the normal push flow (FR-SESS-13): `ask` waits for a person on the session, `auto` pushes, `never`
 *     leaves the files in the Changes tab. Shared branches are refused as for every push.
 *
 * The files are written byte for byte from the stored versions and only when they differ from what the repository has,
 * so a firing that changes nothing opens nothing. A failed or blocked coordinating session escalates like any session
 * of a spec (Inbox, webhook). At most one firing of a spec is active at a time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { all, insert, one, run as exec, type Row } from './db.ts';
import { badRequest, newId, now, parseJson, slugify, withLock } from './util.ts';
import { getProject, notifyProject, projectDir } from './projects.ts';
import { createWorktree, ensureFresh, getRepo, githubSlug, repoDir, removeWorktree, type Repo } from './repos.ts';
import { specActions, specMonthSpend, type LoopSpec, type TriggerAction } from './loop-specs.ts';
import { DIAGRAMS_DIR, headSha, ingestSession as ingestDiagram, refreshDiagramStale, refreshStaleDiagrams } from './diagrams.ts';
import { ingestSession as ingestDoc, refreshDocStale, refreshStaleDocs } from './generated-docs.ts';
import { DiagramError, validateMermaid } from './diagram-text.ts';
import { formatPipelineForPrompt, persistPipelineResult, runPipeline } from './loop-verification.ts';
import { readSettings } from './workflows/validation.ts';
import { getWorkflow, log, patch } from './workflows/store.ts';
import { stopWith } from './workflows/lifecycle.ts';
import { deriveBranchName, pushForSession, type PushRequest } from './workflows/push.ts';
import { isSharedBranch } from './runs.ts';

/** Where in the repository the generated documents are kept (diagrams go to DIAGRAMS_DIR). */
export const DOCS_DIR = 'docs/generated';

const TERMINAL = ['done', 'blocked', 'failed', 'stopped'];

interface SyncItem {
  kind: 'diagram' | 'doc';
  id: string;
  title: string;
  workflowId: string;
  versionBefore: number;
  settled?: boolean;
  ok?: boolean;
  error?: string;
}

interface ActionResult {
  stale: number;
  started: Record<string, unknown>[];
  skipped: Record<string, unknown>[];
}

const TERMINAL_JOB = 'finished';

function getJob(workflowId: string): Row | undefined {
  return one<Row>('SELECT * FROM docs_sync_jobs WHERE workflow_id = ?', workflowId);
}

function saveJob(workflowId: string, p: { status?: string; remaining?: TriggerAction[]; items?: SyncItem[]; results?: Record<string, ActionResult> }): void {
  const sets: string[] = ['updated_at = ?'];
  const vals: (string | null)[] = [now()];
  if (p.status !== undefined) { sets.push('status = ?'); vals.push(p.status); }
  if (p.remaining !== undefined) { sets.push('remaining = ?'); vals.push(JSON.stringify(p.remaining)); }
  if (p.items !== undefined) { sets.push('items = ?'); vals.push(JSON.stringify(p.items)); }
  if (p.results !== undefined) { sets.push('results = ?'); vals.push(JSON.stringify(p.results)); }
  exec(`UPDATE docs_sync_jobs SET ${sets.join(', ')} WHERE workflow_id = ?`, ...vals, workflowId);
}

/** The job of a coordinating session, for the session views and tests. */
export function docsSyncJob(workflowId: string) {
  const j = getJob(workflowId);
  if (!j) return null;
  return { status: String(j.status), repoId: String(j.repo_id), items: parseJson<SyncItem[]>(j.items, []), results: parseJson<Record<string, ActionResult>>(j.results, {}) };
}

/* ------------------------------------------------------------------ */
/* What is really stale                                                */
/* ------------------------------------------------------------------ */

const GENERATED_PREFIXES = [`${DOCS_DIR}/`, `${DIAGRAMS_DIR}/`];

/** True when every file that changed between two commits is one this feature writes (or nothing changed). */
function onlyGenerated(repo: Repo, from: string, to: string): boolean {
  try {
    const out = execFileSync('git', ['-c', 'core.longpaths=true', 'diff', '--name-only', '-z', from, to], {
      cwd: repoDir(repo),
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return out.split('\0').filter(Boolean).every((f) => GENERATED_PREFIXES.some((p) => f.startsWith(p)));
  } catch {
    return false;
  }
}

function findRepo(id: string): Repo | null {
  return one<Repo>('SELECT * FROM repos WHERE id = ?', id) ?? null;
}

/** True when a repository of the recorded sources moved on by something other than generated files. */
function reposMoved(sources: { repoId: string; sha?: string | null }[]): boolean {
  for (const s of sources) {
    const repo = findRepo(s.repoId);
    const head = repo ? headSha(repo) : null;
    if (!repo || !head) return true;
    if (head === s.sha) continue;
    if (!s.sha || !onlyGenerated(repo, s.sha, head)) return true;
  }
  return false;
}

interface Candidates {
  ids: string[];
  rows: Row[];
  ignored: { id: string; title: string; reason: string }[];
}

const IGNORED = 'Only generated files changed since it was written (for example the merged documentation pull request).';

/** Stale items of one action whose change is real. Brings the reference clones up to date first. */
async function candidates(projectId: string, action: TriggerAction): Promise<Candidates> {
  const diagrams = action === 'refresh_diagrams';
  const table = diagrams ? 'diagrams' : 'generated_docs';
  const repoIds = new Set<string>();
  for (const d of all<Row>(`SELECT repo_ids FROM ${table} WHERE project_id = ? AND version > 0`, projectId)) for (const id of parseJson<string[]>(d.repo_ids, [])) repoIds.add(id);
  for (const id of repoIds) {
    const r = findRepo(id);
    if (r) await ensureFresh(r).catch(() => undefined);
  }
  if (diagrams) refreshDiagramStale(projectId);
  else refreshDocStale(projectId);
  const rows = diagrams
    ? all<Row>("SELECT * FROM diagrams WHERE project_id = ? AND stale = 1 AND version > 0 AND status != 'generating' ORDER BY updated_at", projectId)
    : all<Row>("SELECT * FROM generated_docs WHERE project_id = ? AND stale = 1 AND version > 0 AND status != 'generating' ORDER BY updated_at", projectId);
  const out: Candidates = { ids: [], rows: [], ignored: [] };
  for (const d of rows) {
    let real: boolean;
    if (diagrams) {
      const v = one<Row>('SELECT sources FROM diagram_versions WHERE diagram_id = ? AND version = ?', d.id, d.version);
      real = reposMoved(parseJson<{ repoId: string; sha?: string }[]>(v?.sources, []));
    } else {
      const v = one<Row>('SELECT sources FROM generated_doc_versions WHERE doc_id = ? AND version = ?', d.id, d.version);
      const reasons = parseJson<string[]>(d.stale_reasons, []);
      const other = reasons.length === 0 || reasons.some((r) => !r.startsWith('Repository "'));
      real = other || reposMoved(parseJson<{ repos: { repoId: string; sha?: string }[] }>(v?.sources, { repos: [] }).repos);
    }
    if (real) {
      out.ids.push(String(d.id));
      out.rows.push(d);
    } else out.ignored.push({ id: String(d.id), title: String(d.title), reason: IGNORED });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Starting a firing                                                   */
/* ------------------------------------------------------------------ */

function idleRow(projectId: string, title: string, reason: string, refreshed: unknown): Row {
  return { id: null, project_id: projectId, title, status: 'done', stop_reason: reason, refreshed };
}

/** True while a firing of the spec is waiting, running or waiting for a person to allow its push. */
function specBusy(specId: string): string {
  const j = one<Row>(
    `SELECT j.workflow_id FROM docs_sync_jobs j JOIN workflows w ON w.id = j.workflow_id
      WHERE j.spec_id = ? AND (j.status = 'waiting' OR w.pending_push != '' OR w.status IN ('running', 'queued')) LIMIT 1`,
    specId,
  );
  if (j) return 'The previous run of this spec has not finished (it is refreshing or waiting for the push to be allowed).';
  const s = one<Row>("SELECT id FROM workflows WHERE loop_spec_id = ? AND status IN ('running', 'queued') LIMIT 1", specId);
  return s ? 'A session of this spec is still running.' : '';
}

function pickRepo(spec: LoopSpec, vars: Record<string, string>, rows: Row[]): Repo {
  const project = getProject(spec.project_id);
  const repos = all<Repo>('SELECT * FROM repos WHERE project_id = ? ORDER BY created_at, id', project.id);
  const named = spec.trigger_config.repoId ? repos.find((r) => r.id === spec.trigger_config.repoId) : undefined;
  if (named) return named;
  const full = (vars['repo.full_name'] ?? '').toLowerCase();
  if (full) {
    const hit = repos.find((r) => {
      const g = githubSlug(r.url);
      return g && `${g.owner}/${g.repo}`.toLowerCase() === full;
    });
    if (hit) return hit;
  }
  for (const d of rows) for (const id of parseJson<string[]>(d.repo_ids, [])) {
    const r = repos.find((x) => x.id === id);
    if (r) return r;
  }
  throw badRequest('No repository of this project can receive the pull request. Set repoId in the spec.');
}

function enforceSpecBudget(spec: LoopSpec): void {
  if (spec.monthly_budget_usd !== null && spec.monthly_budget_usd !== undefined && specMonthSpend(spec.id) >= spec.monthly_budget_usd) {
    throw badRequest(`This loop spec's monthly budget of $${spec.monthly_budget_usd} is used up.`);
  }
}

/**
 * Fire a spec that has actions and, optionally, a pull request. Called by createWorkflowFromSpec for every case except a
 * single action without a pull request (which keeps its older code path). Returns the coordinating session row (or a row
 * with a null id when nothing was started) plus `refreshed`.
 */
export async function runRefreshActions(spec: LoopSpec, userId: string, vars: Record<string, string>): Promise<Row> {
  const actions = specActions(spec.trigger_config);
  const projectId = spec.project_id;
  enforceSpecBudget(spec);
  const busy = specBusy(spec.id);
  if (busy) return idleRow(projectId, spec.name, busy, {});

  if (!spec.trigger_config.publishPr) {
    const results: Record<string, ActionResult> = {};
    let first: Row | null = null;
    for (const a of actions) {
      const r = a === 'refresh_diagrams' ? await refreshStaleDiagrams(projectId, userId, { specId: spec.id }) : await refreshStaleDocs(projectId, userId, { specId: spec.id });
      results[a] = r as unknown as ActionResult;
      const wid = (r.started[0] as { workflowId?: string } | undefined)?.workflowId;
      if (!first && wid) first = one<Row>('SELECT * FROM workflows WHERE id = ?', wid) ?? null;
    }
    return { ...(first ?? idleRow(projectId, spec.name, 'Nothing is stale', null)), refreshed: results };
  }

  const plan: Record<string, Candidates> = {};
  for (const a of actions) plan[a] = await candidates(projectId, a);
  const planned = actions.flatMap((a) => plan[a].rows);
  if (!planned.length) {
    const refreshed = Object.fromEntries(actions.map((a) => [a, { stale: plan[a].ignored.length, started: [], skipped: plan[a].ignored }]));
    return idleRow(projectId, spec.name, 'Nothing is stale', refreshed);
  }
  const repo = pickRepo(spec, vars, planned);
  await ensureFresh(repo);

  const project = getProject(projectId);
  const id = newId('w_');
  const ts = now();
  const diagramsN = plan.refresh_diagrams?.rows.length ?? 0;
  const docsN = plan.refresh_docs?.rows.length ?? 0;
  const s = readSettings({ model: project.default_model || undefined, budgetUsd: 1, maxIterations: 1, pushMode: spec.push_mode || 'ask', permissionMode: '' }, undefined, { hasRepos: true, isPlayground: false });
  insert('workflows', {
    id,
    project_id: projectId,
    title: `${spec.name}: ${[diagramsN ? `${diagramsN} diagram${diagramsN === 1 ? '' : 's'}` : '', docsN ? `${docsN} document${docsN === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')}`.slice(0, 120),
    goal: spec.goal_template || 'Refresh the stale generated documents and architecture diagrams and propose the changes in one pull request.',
    status: 'paused',
    stop_reason: 'Refreshing. The pull request follows when the refresh sessions are done.',
    queue_reason: '',
    queued_at: null,
    repo_id: repo.id,
    branch: repo.default_branch,
    repos: JSON.stringify([{ repoId: repo.id, branch: repo.default_branch }]),
    workspace_id: null,
    engine: '',
    integrations: '[]',
    playground: 0,
    ...s,
    rules: '',
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
    loop_spec_id: spec.id,
    planning_gate: 0,
    created_by: userId,
    created_at: ts,
    updated_at: ts,
  });
  insert('docs_sync_jobs', {
    workflow_id: id,
    spec_id: spec.id,
    project_id: projectId,
    repo_id: repo.id,
    status: 'waiting',
    remaining: JSON.stringify(actions),
    items: '[]',
    results: '{}',
    created_by: userId,
    created_at: ts,
    updated_at: ts,
  });
  log(id, 'system', `${spec.name} started: ${diagramsN} stale diagram(s), ${docsN} stale document(s); the pull request goes to ${repo.name}.`);
  notifyProject(projectId, 'workflow.created', { id });
  await withLock(`docsync:${id}`, async () => {
    try {
      await launchNext(id);
    } catch (e: any) {
      finishWith(id, 'failed', String(e?.message ?? e).slice(0, 300));
    }
  });
  return { ...getWorkflow(id), refreshed: parseJson(getJob(id)?.results, {}) };
}

function finishWith(workflowId: string, status: 'done' | 'blocked' | 'failed', reason: string): void {
  if (getJob(workflowId)) saveJob(workflowId, { status: TERMINAL_JOB });
  stopWith(workflowId, status, reason);
}

/* ------------------------------------------------------------------ */
/* Phases: diagrams, then documents                                    */
/* ------------------------------------------------------------------ */

async function launchNext(workflowId: string): Promise<void> {
  const job = getJob(workflowId)!;
  const spec = one<Row>('SELECT id FROM loop_specs WHERE id = ?', job.spec_id);
  const specId = spec ? String(spec.id) : null;
  const remaining = parseJson<TriggerAction[]>(job.remaining, []);
  const items = parseJson<SyncItem[]>(job.items, []);
  const results = parseJson<Record<string, ActionResult>>(job.results, {});
  const userId = String(job.created_by);
  while (remaining.length) {
    const action = remaining.shift()!;
    const c = await candidates(String(job.project_id), action);
    let r: ActionResult = { stale: 0, started: [], skipped: [] };
    if (c.ids.length) {
      r = (action === 'refresh_diagrams'
        ? await refreshStaleDiagrams(String(job.project_id), userId, { specId, ids: c.ids })
        : await refreshStaleDocs(String(job.project_id), userId, { specId, ids: c.ids })) as unknown as ActionResult;
    }
    r.stale += c.ignored.length;
    r.skipped.push(...c.ignored.map((x) => (action === 'refresh_diagrams' ? { diagramId: x.id, title: x.title, reason: x.reason } : { docId: x.id, title: x.title, reason: x.reason })));
    results[action] = r;
    for (const st of r.started as { diagramId?: string; docId?: string; title: string; workflowId: string }[]) {
      const id = String(st.diagramId ?? st.docId);
      items.push({ kind: action === 'refresh_diagrams' ? 'diagram' : 'doc', id, title: st.title, workflowId: st.workflowId, versionBefore: Number(c.rows.find((x) => x.id === id)?.version ?? 0) });
    }
    saveJob(workflowId, { remaining, items, results });
    if (r.started.length) {
      log(workflowId, 'status', `${action === 'refresh_diagrams' ? 'Redrawing' : 'Rewriting'} ${r.started.length} ${action === 'refresh_diagrams' ? 'diagram' : 'document'}(s): ${r.started.map((x) => x.title).join(', ')}.`);
      return;
    }
  }
  await publish(workflowId);
}

/** A refresh session of a firing ended (or the portal restarted): go on when the whole phase is stored. */
export async function advance(workflowId: string): Promise<void> {
  await withLock(`docsync:${workflowId}`, async () => {
    const job = getJob(workflowId);
    if (!job || job.status !== 'waiting') return;
    try {
      const items = parseJson<SyncItem[]>(job.items, []);
      const open = items.filter((i) => !i.settled);
      if (!open.length) return void (await launchNext(workflowId));
      for (const i of open) {
        const w = one<Row>('SELECT status FROM workflows WHERE id = ?', i.workflowId);
        if (w && !TERMINAL.includes(w.status)) return;
      }
      for (const i of open) {
        if (i.kind === 'diagram') await ingestDiagram(i.workflowId);
        else await ingestDoc(i.workflowId);
        const e = one<Row>(i.kind === 'diagram' ? 'SELECT version, error FROM diagrams WHERE id = ?' : 'SELECT version, error FROM generated_docs WHERE id = ?', i.id);
        i.settled = true;
        i.ok = Boolean(e && Number(e.version) > i.versionBefore);
        if (!i.ok) i.error = String(e?.error ?? 'The refresh session did not produce a new version.').slice(0, 300);
      }
      saveJob(workflowId, { items });
      await launchNext(workflowId);
    } catch (e: any) {
      finishWith(workflowId, 'failed', `Keeping docs current failed: ${String(e?.message ?? e).slice(0, 300)}`);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Publishing: files, checks, push                                     */
/* ------------------------------------------------------------------ */

function docFileName(d: Row): string {
  const base = (t: Row) => slugify(String(t.title)) || String(t.type);
  const mine = base(d);
  const earlier = all<Row>('SELECT * FROM generated_docs WHERE project_id = ? AND id != ? ORDER BY created_at, id', d.project_id, d.id).some(
    (o) => base(o) === mine && (String(o.created_at) < String(d.created_at) || (o.created_at === d.created_at && String(o.id) < String(d.id))),
  );
  return `${earlier ? `${mine}-${String(d.id).slice(-6).toLowerCase()}` : mine}.md`;
}

function rel(pdir: string, abs: string): string {
  return path.relative(pdir, abs).replace(/\\/g, '/');
}

async function publish(workflowId: string): Promise<void> {
  const job = getJob(workflowId)!;
  const items = parseJson<SyncItem[]>(job.items, []);
  const good = items.filter((i) => i.ok);
  const bad = items.filter((i) => !i.ok);
  if (!good.length) {
    return finishWith(workflowId, 'failed', items.length ? `Nothing could be refreshed: ${bad.map((b) => `${b.title} (${b.error})`).join('; ').slice(0, 280)}` : 'Nothing could be refreshed.');
  }
  const w = getWorkflow(workflowId);
  const project = getProject(w.project_id);
  const repo = getRepo(String(job.repo_id));
  const spec = one<Row>('SELECT * FROM loop_specs WHERE id = ?', job.spec_id);
  await ensureFresh(repo);

  const runId = newId('r_');
  const pdir = projectDir(project);
  const workDir = path.join(pdir, 'work', runId);
  const dest = path.join(workDir, repo.slug);
  await createWorktree(repo, repo.default_branch, dest);

  const files: { rel: string; content: string; label: string }[] = [];
  for (const i of good) {
    if (i.kind === 'diagram') {
      const d = one<Row>('SELECT * FROM diagrams WHERE id = ?', i.id);
      const v = d ? one<Row>('SELECT mermaid FROM diagram_versions WHERE diagram_id = ? AND version = ?', d.id, d.version) : undefined;
      if (d && v) files.push({ rel: `${DIAGRAMS_DIR}/${d.slug}.mmd`, content: String(v.mermaid).replace(/\s+$/, '') + '\n', label: `Diagram: ${d.title} (v${d.version})` });
    } else {
      const d = one<Row>('SELECT * FROM generated_docs WHERE id = ?', i.id);
      const v = d ? one<Row>('SELECT markdown FROM generated_doc_versions WHERE doc_id = ? AND version = ?', d.id, d.version) : undefined;
      if (d && v) files.push({ rel: `${DOCS_DIR}/${docFileName(d)}`, content: String(v.markdown).replace(/\s+$/, '') + '\n', label: `Document: ${d.title} (v${d.version})` });
    }
  }
  const changed: typeof files = [];
  for (const f of files) {
    const abs = path.join(dest, f.rel);
    if (fs.existsSync(abs) && fs.readFileSync(abs, 'utf8') === f.content) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
    changed.push(f);
  }
  if (!changed.length) {
    await removeWorktree(repo, dest);
    return finishWith(workflowId, 'done', 'The repository already has the current copies of everything refreshed. No pull request is needed.');
  }

  const mermaidErrors: string[] = [];
  for (const f of changed.filter((x) => x.rel.endsWith('.mmd'))) {
    try {
      await validateMermaid(f.content);
    } catch (e: any) {
      mermaidErrors.push(`${f.rel}: ${e instanceof DiagramError ? e.message : String(e?.message ?? e)}`);
    }
  }
  if (mermaidErrors.length) {
    await removeWorktree(repo, dest);
    return finishWith(workflowId, 'blocked', `Mermaid check failed, so nothing is proposed: ${mermaidErrors.join('; ').slice(0, 300)}`);
  }

  const steps = spec ? parseJson<any[]>(spec.verification, []) : [];
  const summaryLines = [
    `Refreshed by the loop spec "${spec?.name ?? 'Keep docs current'}".`,
    '',
    ...changed.map((f) => `- \`${f.rel}\` (${f.label})`),
    ...(bad.length ? ['', 'Not refreshed:', ...bad.map((b) => `- ${b.title}: ${b.error}`)] : []),
  ];
  if (steps.length) {
    const pr = await runPipeline(steps, dest, summaryLines.join('\n'));
    persistPipelineResult(workflowId, pr);
    log(workflowId, 'check', pr.overall_ok ? 'Verification passed' : 'Verification failed', { data: { ok: pr.overall_ok, output: formatPipelineForPrompt(pr), overall_ok: pr.overall_ok, steps: pr.steps.map((s) => ({ step: s.step, ok: s.ok, advisory: Boolean(s.advisory) })) } });
    if (!pr.overall_ok) return finishWith(workflowId, 'blocked', 'The verification pipeline failed, so nothing is proposed. The files are in the Changes tab.');
  }

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const branch = `docs/keep-current-${day}-${workflowId.slice(-6).toLowerCase()}`;
  if (branch === repo.default_branch || isSharedBranch(branch)) return finishWith(workflowId, 'failed', `The branch name "${branch}" cannot be used.`);
  const title = `${spec?.name ?? 'Keep docs current'}: ${changed.length} file${changed.length === 1 ? '' : 's'}`;
  const ts = now();
  insert('agent_runs', {
    id: runId,
    project_id: project.id,
    workflow_id: workflowId,
    kind: 'chat',
    title,
    prompt: '(prepared by the portal: no agent ran in this working copy)',
    status: 'completed',
    repo_id: repo.id,
    branch: repo.default_branch,
    worktree: rel(pdir, dest),
    model: 'sonnet',
    permission_mode: '',
    provider: 'portal',
    result: summaryLines.join('\n'),
    meta: JSON.stringify({ workDir: rel(pdir, workDir), docsSync: true, workBranch: branch, repos: [{ repoId: repo.id, name: repo.name, branch: repo.default_branch, worktree: rel(pdir, dest) }] }),
    created_by: job.created_by,
    created_at: ts,
    started_at: ts,
    finished_at: ts,
  });
  patch(workflowId, { last_run_id: runId, work_branch: branch, iteration: 1, summary: summaryLines.join('\n').slice(0, 4000) });
  log(workflowId, 'iteration', `Prepared ${changed.length} file(s) in "${branch}": ${changed.map((f) => f.rel).join(', ')}`, { runId, data: { iteration: 1, state: 'done' } });
  saveJob(workflowId, { status: 'publishing' });
  await requestPush(workflowId);
}

/** Offer the prepared branch to the push flow according to the session's push mode. */
async function requestPush(workflowId: string): Promise<void> {
  const w = getWorkflow(workflowId);
  const mode = w.push_mode || 'ask';
  const branch = String(w.work_branch || deriveBranchName(w));
  const req: PushRequest = { message: String(w.title), pr: true, runId: String(w.last_run_id), branch, state: 'done', at: now() };
  if (mode === 'never') return finishWith(workflowId, 'done', `The files are ready in "${branch}" (Changes tab). Agent pushes are off for this spec.`);
  if (mode === 'auto') {
    const out = await pushForSession(w, req, 'The portal');
    return finishWith(workflowId, out.ok ? 'done' : 'blocked', out.ok ? `Pushed to "${branch}".` : 'The push failed. See the history.');
  }
  patch(workflowId, { pending_push: JSON.stringify(req) });
  stopWith(workflowId, 'paused', `Waiting for you to allow pushing to "${branch}".`);
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

/** True for the coordinating session of a firing. */
export function isDocsSyncSession(workflowId: string): boolean {
  return Boolean(getJob(workflowId));
}

/** Resume pressed (or a denied/failed push): wait for the refresh again, or offer the push again. */
export function resumeSync(workflowId: string): void {
  const job = getJob(workflowId);
  if (!job) return;
  if (job.status === 'waiting') {
    void advance(workflowId);
    return;
  }
  const w = getWorkflow(workflowId);
  if (job.status === 'publishing' && w.last_run_id && w.status !== 'done' && !w.pending_push) {
    requestPush(workflowId).catch(() => undefined);
  }
}

/** Called when any session ends: moves its firing on, or closes the job when it is the coordinating session. */
export function onSessionStopped(workflowId: string): void {
  if (getJob(workflowId)) {
    saveJob(workflowId, { status: TERMINAL_JOB });
    return;
  }
  const w = one<Row>('SELECT project_id FROM workflows WHERE id = ?', workflowId);
  if (!w) return;
  for (const j of all<Row>("SELECT workflow_id, items FROM docs_sync_jobs WHERE project_id = ? AND status = 'waiting'", w.project_id)) {
    if (String(j.items).includes(`"${workflowId}"`)) void advance(String(j.workflow_id)).catch(() => undefined);
  }
}

/** After a restart: go on with firings whose refresh sessions ended while the portal was down. */
export function reconcileDocsSync(): void {
  for (const j of all<Row>("SELECT workflow_id FROM docs_sync_jobs WHERE status = 'waiting'")) void advance(String(j.workflow_id)).catch(() => undefined);
}
