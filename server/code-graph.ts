/**
 * Code graphs, built once per repository from the Repositories page instead of in every session.
 *
 * "Build code graph" starts a job that asks the Kiro runner (graphify is in its image) to clone the latest commit, build the
 * graph with a long time budget, and save it: the compact graph for the Code map (see code-map.ts) and the full graph as a
 * gzip object in the portal's storage. A session never builds a graph: when it clones a repository the portal hands the
 * runner a download link for the saved one (see agent/runner-repo-specs.ts and loadStoredGraph in agent/runner-graph.ts), and
 * the agent queries it like any other.
 *
 * Needs the cloud runner and S3 storage (presigned URLs). A repository has a graph per branch (at most MAX_BRANCH_GRAPHS; the
 * oldest is dropped for a new one). The state of a graph is kept in the setting `codegraph.<graph id>` (see graph-id.ts), and
 * the branches that have one in `codegraph-index.<repoId>`. A session loads the graph of the branch it clones.
 *
 *   POST /api/projects/:id/code-map/:repoId/build        start a build; body { branch? } (editor)
 *   GET  /api/projects/:id/code-map/:repoId/graph-status  its state; ?branch= (viewer)
 */

import { randomUUID } from 'node:crypto';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getDb } from './db.ts';
import { getSetting, setSetting } from './settings.ts';
import { getStorage } from './storage-instance.ts';
import { getGitReposRepository } from './repositories/git-repos.ts';
import { registerBackgroundJob, runInBackground } from './background-jobs.ts';
import { isJobRunner } from './job-runtime.ts';
import { getMemberRow, getProjectRow } from './project-access.ts';
import { requireProjectEditor } from './testing/helpers.ts';
import { badRequest, notFound, now } from './util.ts';
import { graphIdFor, graphStem, parseGraphId, validBranch } from './graph-id.ts';

export interface CodeGraphStatus {
  state: 'running' | 'ready' | 'failed';
  /** The branch this graph is of (graphs built before branches were told apart have none: they are of the default branch). */
  branch?: string;
  /** When this state began. */
  at: string;
  /** What it is doing, or why it failed, or a note on a graph that was built. */
  message: string;
  commit?: string;
  nodes?: number;
  links?: number;
  bytes?: number;
  /** True when the full graph is saved for sessions to download. */
  stored?: boolean;
  /** While running: how far the build has got over all its stages (0-100), the stage and what it is doing. Older runners send none. */
  percent?: number;
  stage?: string;
  detail?: string;
  /** When the runner last reported; a build that stops reporting is given up as lost. */
  updated?: string;
  /** When the saved graph was built; sessions compare it to know whether to download again. */
  version?: string;
}

const statusKey = (repoId: string): string => `codegraph.${repoId}`;
/**
 * A build is given up as lost when its job has stopped reporting. A runner that sends progress reports every few seconds, so
 * 20 minutes of silence means it is gone; an older runner reports nothing during the build, so it is judged by how long the
 * build may take at all (the job runtime's limit plus the time to clone and save).
 */
const STALE_REPORTING_MS = 20 * 60_000;
const STALE_SILENT_MS = 75 * 60_000;
/** On the job runtime a build may run this long (the runner accepts up to 60 minutes); on Lambda it must end within 15 minutes. */
export const GRAPH_MAX_MS = { jobRuntime: 55 * 60_000, lambda: 10 * 60_000 } as const;
const URL_LIFETIME_SECONDS = 2 * 60 * 60;

/** The most branch graphs one repository keeps. */
export const MAX_BRANCH_GRAPHS = 5;

/** Where a graph's full copy is kept; `id` is a graph id (see graph-id.ts). */
export function graphObjectKey(projectId: string, id: string): string {
  const { repo, branch } = graphStem(id);
  return branch ? `code-graphs/${projectId}/${repo}/${branch}.json.gz` : `code-graphs/${projectId}/${repo}.json.gz`;
}

const indexKey = (repoId: string): string => `codegraph-index.${repoId}`;
function readIndex(repoId: string): string[] {
  try {
    const v = JSON.parse(getSetting(getDb(), indexKey(repoId)) || '[]') as unknown;
    return Array.isArray(v) ? v.filter((b): b is string => typeof b === 'string') : [];
  } catch { return []; }
}

/**
 * The id of the graph a repository has for a branch, or null. A graph built before branches were told apart sits under the
 * repository's own id with no branch recorded: it is of the repository's default branch.
 */
export function resolveGraphId(repoId: string, branch: string | null | undefined, defaultBranch: string | null | undefined): string | null {
  const b = branch ?? '';
  const own = graphIdFor(repoId, b);
  if (own !== repoId && getCodeGraphStatus(own)) return own;
  const legacy = getCodeGraphStatus(repoId);
  if (legacy && (legacy.branch ?? defaultBranch ?? '') === b) return repoId;
  return null;
}

export interface BranchGraph { branch: string; id: string; status: CodeGraphStatus }

/** Every branch of a repository that has a graph (or a build under way or failed), the default branch first, then the newest. */
export function listCodeGraphs(repoId: string, defaultBranch: string | null | undefined): BranchGraph[] {
  const out: BranchGraph[] = [];
  const seen = new Set<string>();
  for (const branch of [...readIndex(repoId)].reverse()) {
    const id = resolveGraphId(repoId, branch, defaultBranch);
    const status = id ? getCodeGraphStatus(id) : null;
    if (id && status && !seen.has(branch)) { seen.add(branch); out.push({ branch, id, status }); }
  }
  const legacy = getCodeGraphStatus(repoId);
  const legacyBranch = legacy ? (legacy.branch ?? defaultBranch ?? '') : '';
  if (legacy && !seen.has(legacyBranch)) out.push({ branch: legacyBranch, id: repoId, status: legacy });
  return out.sort((a, b) => Number(b.branch === (defaultBranch ?? '')) - Number(a.branch === (defaultBranch ?? '')));
}

export function getCodeGraphStatus(repoId: string): CodeGraphStatus | null {
  const raw = getSetting(getDb(), statusKey(repoId));
  if (!raw) return null;
  try {
    const st = JSON.parse(raw) as CodeGraphStatus;
    const reporting = st.percent != null;
    const since = reporting ? (st.updated ?? st.at) : st.at;
    if (st.state === 'running' && Date.now() - new Date(since).getTime() > (reporting ? STALE_REPORTING_MS : STALE_SILENT_MS)) {
      return { ...st, state: 'failed', message: 'The build did not finish (its job was lost). Try again.' };
    }
    return st;
  } catch { return null; }
}

async function save(id: string, st: CodeGraphStatus): Promise<void> {
  const branch = parseGraphId(id).branch || st.branch;
  await setSetting(getDb(), statusKey(id), JSON.stringify(branch !== undefined ? { ...st, branch } : st));
}

interface Presigning { presign(logicalPath: string, method: 'get' | 'put', expiresInSeconds: number): Promise<string> }
function presigner(): Presigning | null {
  try {
    const storage = getStorage();
    return typeof (storage as unknown as Partial<Presigning>).presign === 'function' ? (storage as unknown as Presigning) : null;
  } catch { return null; }
}

/**
 * The saved graph of one branch of a repository (the branch a session clones) for a runner to download, or null when there is
 * none (or storage cannot hand out links). The graph of another branch is not used: it would describe other code.
 */
export async function savedGraphFor(projectId: string, repoId: string, branch?: string | null): Promise<{ url: string; version: string } | null> {
  const id = resolveGraphId(repoId, branch, branch);
  const st = id ? getCodeGraphStatus(id) : null;
  if (!id || !st || st.state !== 'ready' || !st.stored || !st.version) return null;
  try {
    const p = presigner();
    if (!p) return null;
    const key = graphObjectKey(projectId, id);
    if (!(await getStorage().exists(key))) return null;
    return { url: await p.presign(key, 'get', URL_LIFETIME_SECONDS), version: st.version };
  } catch {
    return null;
  }
}

/** The Kiro runner that builds graphs, or null (a local portal has none). */
export function graphRuntimeArn(): string | null {
  const arn = (process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN ?? '').trim();
  return arn || null;
}

/** Can a build be started here at all? Says why not, for the page. */
export function graphBuildUnavailable(): string | null {
  if (!graphRuntimeArn()) return 'Code graphs are built by the cloud portal\'s runner; this portal has none.';
  if (!presigner()) return 'Code graphs need the portal\'s S3 storage to be kept for sessions.';
  return null;
}

/** The branch to build (the repository's default when none is asked for) and the id its graph has or will have. */
async function targetFor(projectId: string, repoId: string, asked?: string | null) {
  const repo = await getGitReposRepository().getByIdForProject(repoId, projectId);
  if (!repo) throw notFound('Repository not found');
  const def = repo.default_branch ? String(repo.default_branch) : '';
  if (asked && !validBranch(asked)) throw badRequest('That is not a valid branch name.');
  const branch = asked || def;
  return { repo, branch, id: resolveGraphId(repoId, branch, def) ?? graphIdFor(repoId, branch) };
}

/** Notes that a branch has a graph (or an attempt at one), newest last. */
async function touchIndex(repoId: string, branch: string): Promise<void> {
  const list = readIndex(repoId).filter((b) => b !== branch);
  list.push(branch);
  await setSetting(getDb(), indexKey(repoId), JSON.stringify(list));
}

/** Drops one branch's graph: its state, its saved copy and its Code map. */
async function dropGraph(projectId: string, repoId: string, branch: string, defaultBranch: string): Promise<void> {
  const id = resolveGraphId(repoId, branch, defaultBranch) ?? graphIdFor(repoId, branch);
  await setSetting(getDb(), statusKey(id), '');
  await getStorage().delete(graphObjectKey(projectId, id)).catch(() => undefined);
  const { forgetCodeMap } = await import('./code-map.ts');
  await forgetCodeMap(projectId, id).catch(() => undefined);
}

/** After a build: keep at most MAX_BRANCH_GRAPHS per repository by dropping the one touched longest ago (never the default branch or this one). */
async function enforceBranchLimit(projectId: string, repoId: string, defaultBranch: string, justBuilt: string): Promise<void> {
  let list = readIndex(repoId);
  while (list.length > MAX_BRANCH_GRAPHS) {
    const victim = list.find((b) => b !== defaultBranch && b !== justBuilt);
    if (victim === undefined) break;
    list = list.filter((b) => b !== victim);
    await dropGraph(projectId, repoId, victim, defaultBranch);
  }
  await setSetting(getDb(), indexKey(repoId), JSON.stringify(list));
}

/** Starts a build for one branch of a repository (its default branch when none is given). Throws a message fit for the person when it cannot. */
export async function requestCodeGraphBuild(projectId: string, repoId: string, askedBranch?: string | null): Promise<CodeGraphStatus> {
  const why = graphBuildUnavailable();
  if (why) throw badRequest(why);
  const { repo, branch, id } = await targetFor(projectId, repoId, askedBranch);
  if (!String(repo.url ?? '').startsWith('https://')) throw badRequest('Only repositories with an https address can be built on the cloud runner.');
  const current = getCodeGraphStatus(id);
  if (current?.state === 'running') return current;
  const st: CodeGraphStatus = {
    state: 'running', at: now(), message: 'Starting…', branch,
    // Keep what the last build left, so sessions keep using it while the new one is made.
    ...(current?.stored ? { stored: true, version: current.version, commit: current.commit, nodes: current.nodes, links: current.links, bytes: current.bytes } : {}),
  };
  await save(id, st);
  await touchIndex(repoId, branch);
  await runInBackground('build-code-graph', { projectId, repoId, branch });
  return st;
}

async function buildJob(projectId: string, repoId: string, askedBranch: string): Promise<void> {
  const { repo, branch, id } = await targetFor(projectId, repoId, askedBranch);
  const defaultBranch = repo.default_branch ? String(repo.default_branch) : '';
  const before = getCodeGraphStatus(id);
  const keep = before?.stored ? { stored: true, version: before.version, commit: before.commit, nodes: before.nodes, links: before.links, bytes: before.bytes } : {};
  const fail = async (message: string): Promise<void> => save(id, { state: 'failed', at: now(), message: message.slice(0, 400), branch, ...keep });
  const arn = graphRuntimeArn();
  if (!arn) { await fail('This portal has no cloud runner.'); return; }

  const { buildRunnerRepos } = await import('./agent/runner-repo-specs.ts');
  const { invokeAgentCore } = await import('./agent/kiro-agentcore.ts');
  const { agentCoreSessionId } = await import('./agent/agentcore-session.ts');
  const { explainCloneFailure } = await import('./agent/repo-prep.ts');

  const notes: string[] = [];
  const specs = await buildRunnerRepos([repoId], projectId, (t) => notes.push(t), { withGraph: false, ...(branch ? { branch } : {}) });
  if (specs.length !== 1) { await fail(notes[0] ?? 'The repository cannot be used by the runner.'); return; }

  const p = presigner();
  const key = graphObjectKey(projectId, id);
  const putUrl = p ? await p.presign(key, 'put', URL_LIFETIME_SECONDS).catch(() => undefined) : undefined;
  const maxMs = isJobRunner() ? GRAPH_MAX_MS.jobRuntime : GRAPH_MAX_MS.lambda;
  const payload: Record<string, unknown> = { mode: 'build-graph', runId: `graph-${randomUUID()}`, repos: [specs[0]], ...(putUrl ? { putUrl } : {}), maxMs };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timed out')), maxMs + 5 * 60_000);
  let lastSave = 0;
  let progress = null as { percent: number; stage: string; detail: string } | null;
  const startedAt = before?.state === 'running' ? before.at : now();
  const running = (message: string): CodeGraphStatus => ({
    state: 'running', at: startedAt, updated: now(), branch, message: message.replace(/https?:\/\/[^@\s]*@/g, 'https://').slice(0, 200),
    ...(progress ? { percent: progress.percent, stage: progress.stage, detail: progress.detail } : {}), ...keep,
  });
  let result: Record<string, unknown> | null = null;
  let failedClone = '';
  let streamError = '';
  try {
    for await (const raw of invokeAgentCore(arn, agentCoreSessionId(`graph-${id}`, 'kiro'), payload, ac.signal)) {
      const ev = raw as unknown as Record<string, unknown>;
      if (ev.type === 'status' && typeof ev.text === 'string') {
        if (ev.text.startsWith('Could not clone')) failedClone = ev.text;
        if (!ev.text.startsWith('Work dir:') && Date.now() - lastSave > 2000) {
          lastSave = Date.now();
          await save(id, running(ev.text));
        }
      } else if (ev.type === 'graph-progress' && typeof ev.percent === 'number') {
        progress = { percent: Math.max(progress?.percent ?? 0, Math.min(100, ev.percent)), stage: String(ev.stage ?? ''), detail: String(ev.detail ?? '').slice(0, 160) };
        if (Date.now() - lastSave > 2000) {
          lastSave = Date.now();
          await save(id, running(progress.detail));
        }
      } else if (ev.type === 'result') {
        result = ev;
      } else if (ev.type === 'error') {
        streamError = String(ev.message ?? 'The runner reported an error');
      }
    }
  } catch (e) {
    streamError = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }

  if (!result || result.success !== true) {
    const problem = explainCloneFailure(`${failedClone} ${String(result?.error ?? '')} ${streamError}`, [String(specs[0].url)]);
    await fail(problem?.text ?? (String(result?.error ?? '') || streamError || failedClone || 'The build did not finish.'));
    return;
  }
  const stored = result.stored === true;
  await save(id, {
    state: 'ready',
    branch,
    at: now(),
    message: stored ? '' : String(result.error ?? 'The graph is shown in the Code map but is not saved for sessions.'),
    commit: String(result.commit ?? ''),
    nodes: Number(result.nodes ?? 0),
    links: Number(result.links ?? 0),
    bytes: Number(result.bytes ?? 0),
    stored,
    version: now(),
  });
  await touchIndex(repoId, branch);
  await enforceBranchLimit(projectId, repoId, defaultBranch, branch).catch((e) => console.warn('[code-graph] could not trim old branch graphs:', e instanceof Error ? e.message : e));
}

registerBackgroundJob('build-code-graph', async (a) => {
  const projectId = String(a.projectId);
  const repoId = String(a.repoId);
  const branch = typeof a.branch === 'string' ? a.branch : '';
  try {
    await buildJob(projectId, repoId, branch);
  } catch (e) {
    const id = await targetFor(projectId, repoId, branch).then((t) => t.id).catch(() => repoId);
    await save(id, { state: 'failed', at: now(), message: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).catch(() => undefined);
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerCodeGraphRoutes(): void {
  router.post('/api/projects/:id/code-map/:repoId/build', async (req: PortalRequest, res: PortalResponse) => {
    if (!(await requireProjectEditor(req, res, req.params.id))) return;
    const project = await getProjectRow(req.params.id);
    if (!project) { sendJson(res, 404, { error: 'Project not found' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = await requestCodeGraphBuild(String(project.id), req.params.repoId, typeof body.branch === 'string' ? body.branch : null);
    sendJson(res, 202, { status });
  });

  router.get('/api/projects/:id/code-map/:repoId/graph-status', async (req: PortalRequest, res: PortalResponse) => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    const project = await getProjectRow(req.params.id);
    if (!project || (!req.user.is_admin && !(await getMemberRow(req.params.id, req.user.id)))) { sendJson(res, 404, { error: 'Project not found' }); return; }
    const repo = await getGitReposRepository().getByIdForProject(req.params.repoId, req.params.id);
    if (!repo) { sendJson(res, 404, { error: 'Repository not found' }); return; }
    const defaultBranch = repo.default_branch ? String(repo.default_branch) : '';
    const asked = req.query.get('branch');
    if (asked && !validBranch(asked)) throw badRequest('That is not a valid branch name.');
    const branch = asked || defaultBranch;
    const id = resolveGraphId(req.params.repoId, branch, defaultBranch);
    sendJson(res, 200, {
      status: id ? getCodeGraphStatus(id) : null,
      branch,
      defaultBranch,
      branches: listCodeGraphs(req.params.repoId, defaultBranch).map((g) => ({ branch: g.branch, status: g.status })),
      unavailable: graphBuildUnavailable(),
    });
  });
}
