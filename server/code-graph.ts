/**
 * Code graphs, built once per repository from the Repositories page instead of in every session.
 *
 * "Build code graph" starts a job that asks the Kiro runner (graphify is in its image) to clone the latest commit, build the
 * graph with a long time budget, and save it: the compact graph for the Code map (see code-map.ts) and the full graph as a
 * gzip object in the portal's storage. A session never builds a graph: when it clones a repository the portal hands the
 * runner a download link for the saved one (see agent/runner-repo-specs.ts and loadStoredGraph in agent/runner-graph.ts), and
 * the agent queries it like any other.
 *
 * Needs the cloud runner and S3 storage (presigned URLs). The state of each repository's graph is kept in the setting
 * `codegraph.<repoId>`.
 *
 *   POST /api/projects/:id/code-map/:repoId/build        start a build (editor)
 *   GET  /api/projects/:id/code-map/:repoId/graph-status  its state (viewer)
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

export interface CodeGraphStatus {
  state: 'running' | 'ready' | 'failed';
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

export const graphObjectKey = (projectId: string, repoId: string): string => `code-graphs/${projectId}/${repoId.replace(/[^A-Za-z0-9_-]/g, '_')}.json.gz`;

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

async function save(repoId: string, st: CodeGraphStatus): Promise<void> {
  await setSetting(getDb(), statusKey(repoId), JSON.stringify(st));
}

interface Presigning { presign(logicalPath: string, method: 'get' | 'put', expiresInSeconds: number): Promise<string> }
function presigner(): Presigning | null {
  try {
    const storage = getStorage();
    return typeof (storage as unknown as Partial<Presigning>).presign === 'function' ? (storage as unknown as Presigning) : null;
  } catch { return null; }
}

/** The saved graph of a repository for a runner to download, or null when there is none (or storage cannot hand out links). */
export async function savedGraphFor(projectId: string, repoId: string): Promise<{ url: string; version: string } | null> {
  const st = getCodeGraphStatus(repoId);
  if (!st || st.state !== 'ready' || !st.stored || !st.version) return null;
  try {
    const p = presigner();
    if (!p) return null;
    const key = graphObjectKey(projectId, repoId);
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

/** Starts a build for one repository. Throws a message fit for the person when it cannot. */
export async function requestCodeGraphBuild(projectId: string, repoId: string): Promise<CodeGraphStatus> {
  const why = graphBuildUnavailable();
  if (why) throw badRequest(why);
  const repo = await getGitReposRepository().getByIdForProject(repoId, projectId);
  if (!repo) throw notFound('Repository not found');
  if (!String(repo.url ?? '').startsWith('https://')) throw badRequest('Only repositories with an https address can be built on the cloud runner.');
  const current = getCodeGraphStatus(repoId);
  if (current?.state === 'running') return current;
  const st: CodeGraphStatus = {
    state: 'running', at: now(), message: 'Starting…',
    // Keep what the last build left, so sessions keep using it while the new one is made.
    ...(current?.stored ? { stored: true, version: current.version, commit: current.commit, nodes: current.nodes, links: current.links, bytes: current.bytes } : {}),
  };
  await save(repoId, st);
  await runInBackground('build-code-graph', { projectId, repoId });
  return st;
}

async function buildJob(projectId: string, repoId: string): Promise<void> {
  const before = getCodeGraphStatus(repoId);
  const keep = before?.stored ? { stored: true, version: before.version, commit: before.commit, nodes: before.nodes, links: before.links, bytes: before.bytes } : {};
  const fail = async (message: string): Promise<void> => save(repoId, { state: 'failed', at: now(), message: message.slice(0, 400), ...keep });
  const arn = graphRuntimeArn();
  if (!arn) { await fail('This portal has no cloud runner.'); return; }

  const { buildRunnerRepos } = await import('./agent/runner-repo-specs.ts');
  const { invokeAgentCore } = await import('./agent/kiro-agentcore.ts');
  const { agentCoreSessionId } = await import('./agent/agentcore-session.ts');
  const { explainCloneFailure } = await import('./agent/repo-prep.ts');

  const notes: string[] = [];
  const specs = await buildRunnerRepos([repoId], projectId, (t) => notes.push(t), { withGraph: false });
  if (specs.length !== 1) { await fail(notes[0] ?? 'The repository cannot be used by the runner.'); return; }

  const p = presigner();
  const key = graphObjectKey(projectId, repoId);
  const putUrl = p ? await p.presign(key, 'put', URL_LIFETIME_SECONDS).catch(() => undefined) : undefined;
  const maxMs = isJobRunner() ? GRAPH_MAX_MS.jobRuntime : GRAPH_MAX_MS.lambda;
  const payload: Record<string, unknown> = { mode: 'build-graph', runId: `graph-${randomUUID()}`, repos: [specs[0]], ...(putUrl ? { putUrl } : {}), maxMs };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timed out')), maxMs + 5 * 60_000);
  let lastSave = 0;
  let progress = null as { percent: number; stage: string; detail: string } | null;
  const startedAt = before?.state === 'running' ? before.at : now();
  const running = (message: string): CodeGraphStatus => ({
    state: 'running', at: startedAt, updated: now(), message: message.replace(/https?:\/\/[^@\s]*@/g, 'https://').slice(0, 200),
    ...(progress ? { percent: progress.percent, stage: progress.stage, detail: progress.detail } : {}), ...keep,
  });
  let result: Record<string, unknown> | null = null;
  let failedClone = '';
  let streamError = '';
  try {
    for await (const raw of invokeAgentCore(arn, agentCoreSessionId(`graph-${repoId}`, 'kiro'), payload, ac.signal)) {
      const ev = raw as unknown as Record<string, unknown>;
      if (ev.type === 'status' && typeof ev.text === 'string') {
        if (ev.text.startsWith('Could not clone')) failedClone = ev.text;
        if (!ev.text.startsWith('Work dir:') && Date.now() - lastSave > 2000) {
          lastSave = Date.now();
          await save(repoId, running(ev.text));
        }
      } else if (ev.type === 'graph-progress' && typeof ev.percent === 'number') {
        progress = { percent: Math.max(progress?.percent ?? 0, Math.min(100, ev.percent)), stage: String(ev.stage ?? ''), detail: String(ev.detail ?? '').slice(0, 160) };
        if (Date.now() - lastSave > 2000) {
          lastSave = Date.now();
          await save(repoId, running(progress.detail));
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
  await save(repoId, {
    state: 'ready',
    at: now(),
    message: stored ? '' : String(result.error ?? 'The graph is shown in the Code map but is not saved for sessions.'),
    commit: String(result.commit ?? ''),
    nodes: Number(result.nodes ?? 0),
    links: Number(result.links ?? 0),
    bytes: Number(result.bytes ?? 0),
    stored,
    version: now(),
  });
}

registerBackgroundJob('build-code-graph', async (a) => {
  const projectId = String(a.projectId);
  const repoId = String(a.repoId);
  try {
    await buildJob(projectId, repoId);
  } catch (e) {
    await save(repoId, { state: 'failed', at: now(), message: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).catch(() => undefined);
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerCodeGraphRoutes(): void {
  router.post('/api/projects/:id/code-map/:repoId/build', async (req: PortalRequest, res: PortalResponse) => {
    if (!(await requireProjectEditor(req, res, req.params.id))) return;
    const project = await getProjectRow(req.params.id);
    if (!project) { sendJson(res, 404, { error: 'Project not found' }); return; }
    const status = await requestCodeGraphBuild(String(project.id), req.params.repoId);
    sendJson(res, 202, { status });
  });

  router.get('/api/projects/:id/code-map/:repoId/graph-status', async (req: PortalRequest, res: PortalResponse) => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    const project = await getProjectRow(req.params.id);
    if (!project || (!req.user.is_admin && !(await getMemberRow(req.params.id, req.user.id)))) { sendJson(res, 404, { error: 'Project not found' }); return; }
    sendJson(res, 200, { status: getCodeGraphStatus(req.params.repoId), unavailable: graphBuildUnavailable() });
  });
}
