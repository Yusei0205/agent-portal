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
  /** One row per repository, for the progress panel. */
  items?: RepoPrepItem[];
  /** Set when a clone failed for a reason the person can fix (refused sign-in), so the page can say what to do. */
  problem?: RepoPrepProblem;
}

export interface RepoPrepProblem {
  kind: 'aws-keys' | 'git-access';
  /** What happened and what to do, in plain words. */
  text: string;
  /** Which settings page fixes it: the project's AWS tab or its repositories. */
  fix: 'aws' | 'repositories';
}

/**
 * Turns "git exited with code 128 … 403" into what the person must do. A refused sign-in (401/403) on a CodeCommit address means
 * the AWS keys saved for the project are expired or lack access (they are temporary keys, so this is the usual cause).
 * Returns null for any other failure (network, missing repository, disk), which keeps its own message.
 */
export function explainCloneFailure(message: string, urls: string[]): RepoPrepProblem | null {
  const refused = /returned error: (401|403)\b|Authentication failed|could not read (Username|Password)|Access denied|not authorized|ExpiredToken|token (is )?expired/i.test(message);
  if (!refused) return null;
  if (urls.some((u) => /git-codecommit(-fips)?\.[^.]+\.(vpce\.)?amazonaws\.com/.test(u))) {
    return {
      kind: 'aws-keys',
      fix: 'aws',
      text: 'CodeCommit refused the AWS keys saved for this project (403). They have most likely expired, or they cannot read this repository. Update the keys in Workspaces → AWS, then try again.',
    };
  }
  return {
    kind: 'git-access',
    fix: 'repositories',
    text: 'The git host refused the saved sign-in for this repository. Update its Git connection or token in Workspaces → Repositories, then try again.',
  };
}

export interface RepoPrepItem {
  name: string;
  state: 'waiting' | 'working' | 'done' | 'failed';
  text: string;
  /** Overall 0-100 while git reports it (otherwise the panel shows a moving bar). */
  percent?: number;
  /** For example "1,234 / 3,333 objects · 12.3 MiB · 2.1 MiB/s" or "123 / 400 files". */
  detail?: string;
}

/** Update the repository rows from one status line of the runner. Returns true when a row changed. */
export function applyPrepStatus(items: RepoPrepItem[], text: string): boolean {
  const set = (name: string, state: RepoPrepItem['state'], t: string): boolean => {
    const it = items.find((i) => i.name === name);
    if (!it || (it.state === state && it.text === t)) return false;
    it.state = state; it.text = t;
    if (state === 'done') { it.percent = 100; delete it.detail; }
    return true;
  };
  let m = /^Cloning (.+?)(?: @ .+)?…$/.exec(text);
  if (m) return set(m[1], 'working', 'Cloning (full history)…');
  m = /^(.+) is up to date\.$/.exec(text);
  if (m) return set(m[1], 'done', 'Up to date');
  m = /^(.+) already has your session's changes/.exec(text);
  if (m) return set(m[1], 'done', 'Kept your changes');
  m = /^(.+): kept the earlier copy/.exec(text);
  if (m) return set(m[1], 'done', 'Kept the earlier copy');
  m = /^(.+) did not fit in the session's storage/.exec(text);
  if (m) return set(m[1], 'working', 'Cloning to temporary disk…');
  m = /^Could not clone (.+?) \(([^)]*)\)/.exec(text);
  if (m) return set(m[1], 'failed', `Could not clone (${m[2]})`);
  m = /^Repositories available at: (.+)$/.exec(text);
  if (m) {
    let changed = false;
    for (const part of m[1].split(',')) {
      const n = /repos\/([^/]+)\//.exec(part)?.[1];
      if (n) { const it = items.find((i) => i.name === n); if (it && it.state !== 'done') changed = set(n, 'done', 'Ready') || changed; }
    }
    return changed;
  }
  return false;
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

export function runtimeFor(engine: string): { arn: string; kind: 'kiro' | 'claude-code' | 'codex' } | null {
  if (engine === 'codex' && process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN) return { arn: process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN, kind: 'codex' };
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
    if (Date.now() - new Date(st.at).getTime() > 17 * 60_000) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function prepare(workflowId: string, onStatus?: (text: string) => void): Promise<void> {
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

  const items: RepoPrepItem[] = repos.map((r) => ({ name: String((r as { name?: string }).name ?? ''), state: 'waiting', text: 'Waiting…' }));
  await save(workflowId, { state: 'running', at: now(), message: 'Preparing repositories…', items });

  const runId = `prep-${randomUUID()}`;
  const snapshot = await snapshotAccess(workflowId);
  const payload: Record<string, unknown> = rt.kind !== 'claude-code'
    ? { mode: 'prepare-repos', runId, repos, ...(snapshot ? { snapshot } : {}) }
    : { runId, prepareOnly: true, repos, ...(snapshot ? { snapshot } : {}) };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timed out')), 15 * 60_000);
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
        const rowChanged = applyPrepStatus(items, ev.text);
        // The steps after the clone (the code graph, which can take minutes on a big repository) leave every row at 100%:
        // show what the runner is doing, so a long wait does not look stuck.
        const stepText = /^(Building|Updating) the code graph of /.test(ev.text) ? ev.text : null;
        if (stepText) onStatus?.(stepText);
        if (rowChanged || stepText) await save(workflowId, { state: 'running', at: now(), message: stepText ?? 'Preparing repositories…', items });
      }
      if (ev.type === 'progress' && typeof ev.name === 'string') {
        const it = items.find((i) => i.name === ev.name);
        if (it && it.state !== 'done') {
          it.state = ev.done === true ? 'done' : 'working';
          it.text = ev.done === true ? 'Ready' : String(ev.phase ?? 'Cloning');
          it.percent = ev.done === true ? 100 : Number(ev.percent ?? 0);
          it.detail = String(ev.detail ?? '');
          await save(workflowId, { state: 'running', at: now(), message: 'Preparing repositories…', items });
        }
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
  const anyFailed = Boolean(failed) || items.some((i) => i.state === 'failed') || problems.length > 0;
  const problem = anyFailed ? explainCloneFailure([...problems, failed ?? '', last].join(' '), repos.map((r) => String((r as { url?: string }).url ?? ''))) : null;
  await save(workflowId, {
    ...(problem ? { problem } : {}),
    state: failed ? 'failed' : 'done',
    at: now(),
    message: [...notes, message].filter(Boolean).join(' ').slice(0, 300),
    persisted,
    repos: names,
    items: items.map((i) => (i.state === 'waiting' || i.state === 'working') ? { ...i, state: failed ? 'failed' : 'done', text: failed ? 'Not finished' : 'Ready' } : i),
  });
}

/**
 * For one-shot Create runs (document, diagram): puts the chosen repositories on the runner and waits for it, so the agent
 * is only started once they are there. Returns null when the run may go on (nothing to prepare, not an AgentCore engine,
 * or every repository is ready), or the reason it must not (a repository could not be cloned).
 */
export async function prepareReposBeforeRun(workflowId: string): Promise<string | null> {
  const w = await getSessionsRepository().getWorkflowById(workflowId);
  if (!w || !runtimeFor(String(w.engine))) return null;
  let ids: string[] = [];
  try { ids = JSON.parse(String(w.repo_ids ?? '[]')) as string[]; } catch { ids = []; }
  if (ids.length === 0) return null;
  try {
    await prepare(workflowId);
  } catch (e: unknown) {
    return `Could not get the repositories ready: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
  }
  const st = getRepoPrep(workflowId);
  if (!st) return 'Could not get the repositories ready.';
  const bad = (st.items ?? []).filter((i) => i.state === 'failed');
  if (st.state === 'failed' || bad.length > 0) {
    if (st.problem) return `Could not clone ${bad.length ? bad.map((i) => i.name).join(', ') : 'the repositories'}. ${st.problem.text}`.slice(0, 500);
    return `Could not clone ${bad.length ? bad.map((i) => i.name).join(', ') : 'the repositories'}: ${st.message}`.slice(0, 400);
  }
  if (!st.repos?.length && !(st.items?.length)) return st.message || 'No repository could be prepared.';
  return null;
}

/** True when the last preparation left every one of `names` ready on the runner. */
export function reposAreReady(st: RepoPrepState | null, names: string[]): boolean {
  if (!st || st.state !== 'done' || st.problem) return false;
  const items = st.items ?? [];
  return names.every((n) => items.some((i) => i.name === n && i.state === 'done'));
}

/**
 * Before a cloud run starts: make sure the session's repositories are on the runner, cloning them now (and waiting for a
 * clone already going) instead of inside the run. The run's clock then starts after the clone, a refused sign-in is
 * reported up front, and the agent starts with the code in place. Returns the problem the person has to fix (a refused
 * sign-in), or null when the run may go on (everything is ready, or a failure that the runner may still get past).
 */
export async function ensureReposPrepared(
  workflowId: string,
  names: string[],
  say: (text: string) => void,
  signal?: AbortSignal,
): Promise<RepoPrepProblem | null> {
  const w = await getSessionsRepository().getWorkflowById(workflowId);
  if (!w || !runtimeFor(String(w.engine)) || names.length === 0) return null;
  if (reposAreReady(getRepoPrep(workflowId), names)) return null;

  // A preparation already going (started when the repositories were attached): wait for it.
  const until = Date.now() + 16 * 60_000;
  let st = getRepoPrep(workflowId);
  let waited = false;
  if (st?.state === 'running' && Date.now() - new Date(st.at).getTime() < 17 * 60_000) {
    waited = true;
    say('Waiting for the repositories to finish cloning…');
    while (Date.now() < until && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 2_000));
      st = getRepoPrep(workflowId);
      if (!st || st.state !== 'running') break;
    }
  }
  if (signal?.aborted) return null;
  // The preparation we waited for ended on a refused sign-in: cloning again would be refused the same way.
  // (An older failure is not reused: the person may have fixed the keys since, so that case clones again below.)
  if (waited && getRepoPrep(workflowId)?.problem) return getRepoPrep(workflowId)!.problem!;

  if (!reposAreReady(getRepoPrep(workflowId), names)) {
    say('Cloning the repositories before the run starts…');
    try { await prepare(workflowId, say); } catch (e: unknown) { say(`Could not clone the repositories first: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`); }
  }
  st = getRepoPrep(workflowId);
  if (st?.problem) return st.problem;
  if (st && !reposAreReady(st, names)) say(st.message || 'Some repositories could not be cloned first; the run will try again.');
  return null;
}

registerBackgroundJob('prepare-repos', async (a) => {
  const id = String(a.workflowId);
  try {
    await prepare(id);
  } catch (e: unknown) {
    await save(id, { state: 'failed', at: now(), message: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
  }
});
