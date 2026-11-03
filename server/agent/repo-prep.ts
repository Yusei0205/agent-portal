/**
 * Getting a session's repositories ready before the first message.
 *
 * When repositories are attached to a Kiro or Claude session (at creation, or later from the Context tab), a short
 * background job asks that engine's AgentCore runner to put them into the session's persistent folder. The next
 * message then only has to bring them up to date. The outcome is kept in a setting so the page can show it.
 *
 * Does nothing unless the engine runs on AgentCore.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../db.ts';
import { getSetting, setSetting } from '../settings.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { registerBackgroundJob, runInBackground } from '../background-jobs.ts';
import { invokeAgentCore } from './kiro-agentcore.ts';
import { snapshotAccess } from './runner-snapshot-access.ts';
import { agentCoreSessionId } from './agentcore-session.ts';
import { buildRunnerRepos } from './runner-repo-specs.ts';
import { now } from '../util.ts';

export interface RepoPrepState {
  state: 'running' | 'done' | 'failed';
  at: string;
  /** Human-readable outcome (last status line, or the error). */
  message: string;
  /** true when the repositories were put in persistent storage (false: they will be cloned per message). */
  persisted?: boolean;
  repos?: string[];
}

const key = (workflowId: string): string => `repoprep.${workflowId}`;

export function getRepoPrep(workflowId: string): RepoPrepState | null {
  const raw = getSetting(getDb(), key(workflowId));
  if (!raw) return null;
  try { return JSON.parse(raw) as RepoPrepState; } catch { return null; }
}

async function save(workflowId: string, st: RepoPrepState): Promise<void> {
  await setSetting(getDb(), key(workflowId), JSON.stringify(st));
}

function runtimeFor(engine: string): { arn: string; kind: 'kiro' | 'claude-code' } | null {
  if (engine === 'kiro' && process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN) {
    return { arn: process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN, kind: 'kiro' };
  }
  if (engine === 'claude-code' && process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN) {
    return { arn: process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN, kind: 'claude-code' };
  }
  return null;
}

/** Starts the preparation in the background (a separate Lambda invocation). Safe to call any time. */
export async function requestRepoPrep(workflowId: string): Promise<void> {
  const w = await getSessionsRepository().getWorkflowById(workflowId);
  if (!w || !runtimeFor(String(w.engine))) return;
  let ids: string[] = [];
  try { ids = JSON.parse(String(w.repo_ids ?? '[]')) as string[]; } catch { ids = []; }
  if (ids.length === 0) { await save(workflowId, { state: 'done', at: now(), message: 'No repositories attached.', repos: [] }); return; }
  await save(workflowId, { state: 'running', at: now(), message: 'Preparing repositories…' });
  await runInBackground('prepare-repos', { workflowId });
}

/** A message sent right after attaching a repository waits (briefly) for the preparation, so the two never overlap. */
export async function waitForRepoPrep(workflowId: string, maxMs = 90_000): Promise<void> {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const st = getRepoPrep(workflowId);
    if (!st || st.state !== 'running') return;
    // A preparation that has been "running" for far longer than it can take is stale (its Lambda was lost).
    if (Date.now() - new Date(st.at).getTime() > 6 * 60_000) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function prepare(workflowId: string): Promise<void> {
  const w = await getSessionsRepository().getWorkflowById(workflowId);
  const rt = w ? runtimeFor(String(w.engine)) : null;
  if (!w || !rt) return;

  let ids: string[] = [];
  try { ids = JSON.parse(String(w.repo_ids ?? '[]')) as string[]; } catch { ids = []; }
  const notes: string[] = [];
  const repos = await buildRunnerRepos(ids, w.project_id ?? null, (t) => notes.push(t));
  if (repos.length === 0) {
    await save(workflowId, { state: 'done', at: now(), message: notes[0] ?? 'No repositories to prepare.', repos: [] });
    return;
  }

  const runId = `prep-${randomUUID()}`;
  const snapshot = await snapshotAccess(workflowId);
  const payload: Record<string, unknown> = rt.kind === 'kiro'
    ? { mode: 'prepare-repos', runId, repos, ...(snapshot ? { snapshot } : {}) }
    : { runId, prepareOnly: true, repos, ...(snapshot ? { snapshot } : {}) };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timed out')), 5 * 60_000);
  let last = '';
  const problems: string[] = [];
  let persisted = false;
  let names: string[] = [];
  let failed: string | null = null;
  try {
    for await (const raw of invokeAgentCore(rt.arn, agentCoreSessionId(workflowId, rt.kind), payload, ac.signal)) {
      const ev = raw as unknown as Record<string, unknown>;
      if (ev.type === 'status' && typeof ev.text === 'string' && !ev.text.startsWith('Work dir:')) {
        last = ev.text;
        if (ev.text.startsWith('Could not')) problems.push(ev.text);
      }
      if (ev.type === 'error') failed = String(ev.message ?? 'The runner reported an error');
      if (ev.type === 'result') {
        if (ev.success === false) failed = String(ev.error ?? 'Some repositories could not be prepared');
        if (typeof ev.persisted === 'boolean') persisted = ev.persisted;
        if (Array.isArray(ev.repos)) names = ev.repos.map(String);
      }
    }
  } catch (e: unknown) {
    failed = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }

  const message = (problems.length ? problems.join(' ') : (failed ?? last ?? 'Repositories are ready.')).replace(/https?:\/\/[^@\s]*@/g, 'https://').slice(0, 300);
  await save(workflowId, {
    state: failed ? 'failed' : 'done',
    at: now(),
    message: [...notes, message].filter(Boolean).join(' ').slice(0, 300),
    persisted,
    repos: names,
  });
}

registerBackgroundJob('prepare-repos', async (a) => {
  const id = String(a.workflowId);
  try {
    await prepare(id);
  } catch (e: unknown) {
    await save(id, { state: 'failed', at: now(), message: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
  }
});
