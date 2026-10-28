import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, insert, one, run as exec, update, type Row } from '../db.ts';
import { publish, projectChannel, runChannel } from '../events.ts';
import { agentEnv, assertBudget, getSettings, providerMode } from '../settings.ts';
import { config } from '../config.ts';
import { ensureBuiltInSkills, getProject, projectDir, notifyProject, type Project } from '../projects.ts';
import { HttpError, badRequest, newId, now, parseJson, withLock } from '../util.ts';
import { commitAll } from '../git.ts';
import { blockedCommand, alwaysBlockedCommand, parseTrustedPush, composeLeadAppend, isGitPush, outsideDeleteReason, isInsideDir } from '../guardrails.ts';
import type { CanUseTool, PermissionMode, ProviderRunOptions, SdkMessage } from './types.ts';
import { sdkRun } from './sdk.ts';
import { kiroRun } from './kiro.ts';
import { demoRun, demoModel } from './demo.ts';
import { listAgentFiles, listSkillNames } from '../builder.ts';
import { searchForAgent, reindexDecisions } from '../knowledge.ts';
import { createWorktree, getRepo } from '../repos.ts';
import { clearRunAwsFiles, engineProvider, removeRunAwsFiles } from '../project-aws.ts';
import { integrationGuard, resolveIntegrations, type RunIntegrations } from '../integrations.ts';
import { copyVaultsInto } from '../vault.ts';
import { syncProjectTemplates } from '../doc-templates.ts';

export type RunKind = 'chat' | 'test' | 'review' | 'qa' | 'learn' | 'quiz' | 'verify' | 'connection';

export interface StartRunInput {
  projectId: string;
  userId: string;
  kind: RunKind;
  title: string;
  prompt: string;
  repoId?: string | null;
  branch?: string | null;
  /** The session this run is an iteration of; empty for background tasks (agent tests, analyses, reviews, model calls). */
  workflowId?: string | null;
  /** 'claude' or 'kiro' to pick the engine for this run; empty follows the project's connection. */
  engine?: string | null;
  /** Integration ids (MCP tools) the run's agents may use; checked against the person the run acts for. */
  integrations?: string[] | null;
  /** Several repositories, each with its own working copy in the run folder. The first is the run's main one. */
  repos?: RepoChoice[] | null;
  permissionMode?: PermissionMode;
  model?: string;
  resumeOf?: string | null;
  tools?: string[];
  allowedTools?: string[];
  systemAppend?: string;
  /** A project agent that leads this run: its instructions become the system text, worded for the run's engine. */
  lead?: { name: string; description: string; prompt: string; team: { name: string; description: string }[]; isKiroNative?: boolean };
  systemPrompt?: string;
  maxTurns?: number;
  meta?: Record<string, unknown>;
  /** Unattended workflow runs: tools are allowed without asking, except the commands in guardrails.ts. */
  autoApprove?: boolean;
  /** Trust all tools: file edits and shell commands run without asking; git push intercepted by the portal. */
  trustTools?: boolean;
  /**
   * When trustTools is true, the portal intercepts git push and calls this to perform it.
   * Receives the parsed branch name (or null to use the session's work branch).
   * Returns a message string ("Pushed to branch X (commit abc1234)." or an error).
   */
  trustedPushHandler?: (branch: string | null) => Promise<string>;
  /** Single-shot tasks: no project settings, no tools. */
  oneshot?: boolean;
  /** Text the demo provider returns for single-shot tasks. */
  demoOutput?: () => string | Promise<string>;
}

export interface RepoChoice {
  repoId: string;
  branch?: string | null;
}

/** A repository working copy of a run, as kept in run.meta.repos. */
export interface RunRepo {
  repoId: string;
  name: string;
  branch: string;
  worktree: string;
}

/** The working copies of a run: meta.repos when it has several, else the single repo_id / worktree columns. */
export function runRepos(r: Row): RunRepo[] {
  const meta = parseJson<any>(r.meta, {});
  if (Array.isArray(meta.repos) && meta.repos.length) return meta.repos;
  if (r.repo_id && r.worktree) return [{ repoId: r.repo_id, name: meta.repoName ?? '', branch: r.branch ?? '', worktree: r.worktree }];
  return [];
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  /** Ends the wait when nobody answers in time (agents.approvalExpiryMinutes). */
  timer?: ReturnType<typeof setTimeout>;
}

interface Active {
  abort: AbortController;
  /**
   * What the user allowed for the rest of the run, by rememberKey(): one exact shell command, one web host, or one other
   * tool ("allow all Bash" or "all WebFetch" was too broad: one approval then covered whatever a document asked for later).
   */
  allowed: Set<string>;
  pending: Map<string, Pending>;
  seq: number;
  seenMessageIds: Set<string>;
  /** For the project's live "what is happening" line: whose run this is and when it was last announced. */
  projectId?: string;
  workflowId?: string;
  activityAt?: number;
  /** Why the run was stopped, for its record ("Stopped by a user" when not set). */
  stopReason?: string;
}

const active = new Map<string, Active>();

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const AUTO_ALLOWED = ['Read', 'Grep', 'Glob', 'Skill', 'TodoWrite', 'Agent', 'Task', 'LS'];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Read-only tools and the inputs that name what they read. */
const READ_TOOL_FIELDS = new Map<string, string[]>([
  ['Read', ['file_path']],
  ['Grep', ['path']],
  ['Glob', ['path', 'pattern']],
  ['LS', ['path']],
  ['NotebookRead', ['notebook_path']],
]);

function runSummary(r: Row) {
  return {
    id: r.id,
    project_id: r.project_id,
    workflow_id: r.workflow_id ?? null,
    kind: r.kind,
    title: r.title,
    status: r.status,
    cost_usd: r.cost_usd,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    model: r.model,
    provider: r.provider,
    created_at: r.created_at,
    finished_at: r.finished_at,
    created_by: r.created_by,
    meta: parseJson(r.meta, {}),
  };
}

export function getRun(id: string): Row {
  const r = one('SELECT * FROM agent_runs WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Run not found');
  return r;
}

function setStatus(runId: string, status: string, extra: Record<string, unknown> = {}): void {
  update('agent_runs', runId, { status, ...(extra as any) });
  const r = getRun(runId);
  publish(runChannel(runId), 'run', runSummary(r));
  notifyProject(r.project_id, 'run.updated', runSummary(r));
}

/** Keep stored events small: long strings (file contents, big tool results) are cut. */
function shrink(v: unknown, max = 20_000): unknown {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + `\n… (${v.length - max} more characters)` : v;
  if (Array.isArray(v)) return v.map((x) => shrink(x, max));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = shrink(x, max);
    return o;
  }
  return v;
}

function recordEvent(runId: string, a: Active, type: string, parent: string | null, data: unknown): void {
  const seq = ++a.seq;
  const ts = now();
  const small = shrink(data);
  insert('agent_run_events', { run_id: runId, seq, ts, type, parent_tool_use_id: parent, data: JSON.stringify(small) });
  publish(runChannel(runId), 'event', { seq, ts, type, parent, data: small });
  if (type === 'assistant') announceActivity(runId, a, parent, data);
}

/** At most this often per run, the project hears one line about what the run is doing. */
const ACTIVITY_EVERY_MS = 1000;

/** One short line from an assistant message: the last tool it calls, else the start of what it says. */
export function activityLine(message: any): string {
  const blocks: any[] = Array.isArray(message?.message?.content) ? message.message.content : [];
  const tool = [...blocks].reverse().find((b) => b?.type === 'tool_use');
  if (tool) {
    const i = tool.input ?? {};
    const what = i.subagent_type ? `${i.subagent_type}: ${i.description ?? ''}` : i.file_path ?? i.pattern ?? i.command ?? i.skill ?? i.url ?? i.query ?? i.description ?? '';
    return `${tool.name} ${String(what)}`.replace(/\s+/g, ' ').trim().slice(0, 140);
  }
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, 140);
}

function announceActivity(runId: string, a: Active, parent: string | null, data: unknown): void {
  if (!a.projectId) return;
  const t = Date.now();
  if (a.activityAt && t - a.activityAt < ACTIVITY_EVERY_MS) return;
  const line = activityLine(data);
  if (!line) return;
  a.activityAt = t;
  notifyProject(a.projectId, 'run.activity', { runId, workflowId: a.workflowId ?? null, line, subagent: Boolean(parent) });
}

/* ------------------------------------------------------------------ */
/* Questions and approvals                                             */
/* ------------------------------------------------------------------ */

/** The fields of a tool call that decide what it does. An approval shows them whole, never cut. */
const DECIDING_FIELDS = new Set(['command', 'url', 'file_path', 'notebook_path', 'path', 'pattern', 'branch']);
/** A shell command longer than this is refused instead of shown to a person: nobody can review it. */
export const MAX_REVIEWABLE_COMMAND = 20_000;

/** JSON with sorted keys, so the same tool call always gives the same text. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The fingerprint of one exact tool call. An approval must send it back, so a person allows exactly what they saw. */
export function inputFingerprint(toolName: string, input: unknown): string {
  return createHash('sha256').update(canonicalJson({ tool: toolName, input })).digest('hex');
}

/** What an approval shows: the deciding fields whole, other long strings (file contents) cut at 4,000 characters. */
function approvalView(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = DECIDING_FIELDS.has(k) && typeof v === 'string' ? v : shrink(v, 4000);
  return out;
}

/**
 * What "allow for the rest of this run" covers: one exact shell command (approving `npm test` must not approve what a
 * prompt-injected document suggests later), one web host for WebFetch (not every address), or one other tool.
 */
export function rememberKey(toolName: string, input: Record<string, unknown>): { key: string; scope: 'command' | 'host' | 'tool'; label: string } {
  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    return { key: `Bash\u0000${command}`, scope: 'command', label: command };
  }
  if (toolName === 'WebFetch') {
    let host = '';
    try {
      host = new URL(String(input.url ?? '')).host.toLowerCase();
    } catch {
      /* not a URL: only this exact call */
    }
    return host ? { key: `WebFetch\u0000${host}`, scope: 'host', label: host } : { key: `WebFetch\u0000${String(input.url ?? '')}`, scope: 'command', label: String(input.url ?? '') };
  }
  return { key: toolName, scope: 'tool', label: toolName };
}

export function createInput(opts: {
  projectId: string;
  runId: string | null;
  type: 'question' | 'approval';
  toolName: string | null;
  payload: unknown;
  userId: string | null;
  /** When nobody answering by then ends the wait (ISO time). */
  expiresAt?: string | null;
}): Row {
  const id = newId('i_');
  insert('inputs', {
    id,
    project_id: opts.projectId,
    run_id: opts.runId,
    type: opts.type,
    tool_name: opts.toolName,
    payload: JSON.stringify(opts.payload),
    status: 'pending',
    created_by: opts.userId,
    created_at: now(),
    expires_at: opts.expiresAt ?? null,
  });
  const row = one('SELECT * FROM inputs WHERE id = ?', id)!;
  notifyProject(opts.projectId, 'input.created', inputView(row));
  return row;
}

export function inputView(r: Row) {
  return { ...r, payload: parseJson(r.payload, {}), response: parseJson(r.response, null) };
}

/** What the agent hears when nobody answered in time. */
function expiredResponse(type: 'question' | 'approval', minutes: number) {
  return type === 'approval'
    ? { decision: 'deny', remember: false, expired: true, message: `Nobody answered within ${minutes} minutes, so this was declined. Carry on without it, or report blocked and say what you need.` }
    : { answers: {}, expired: true, response: `Nobody answered within ${minutes} minutes. Choose the most reasonable option and list it as an assumption in your summary.` };
}

function waitForInput(runId: string, a: Active, type: 'question' | 'approval', toolName: string, payload: unknown, signal: AbortSignal): Promise<any> {
  const r = getRun(runId);
  // A request nobody answers ends after agents.approvalExpiryMinutes (0 = waits until the run is stopped), so a
  // forgotten approval does not hold the run, its budget and its slot for ever.
  const minutes = Number(getSettings().agents.approvalExpiryMinutes ?? 60);
  const expiresAt = minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
  const input = createInput({ projectId: r.project_id, runId, type, toolName, payload, userId: r.created_by, expiresAt });
  recordEvent(runId, a, 'portal:input', null, { inputId: input.id, inputType: type, toolName, payload, expiresAt });
  setStatus(runId, 'waiting');
  return new Promise((resolve, reject) => {
    const pending: Pending = { resolve, reject };
    a.pending.set(input.id, pending);
    if (minutes > 0) {
      pending.timer = setTimeout(() => {
        const response = expiredResponse(type, minutes);
        const claimed = exec("UPDATE inputs SET status = 'expired', response = ?, answered_at = ? WHERE id = ? AND status = 'pending'", JSON.stringify(response), now(), input.id);
        if (!claimed.changes || a.pending.get(input.id) !== pending) return;
        a.pending.delete(input.id);
        notifyProject(r.project_id, 'input.resolved', { id: input.id, status: 'expired' });
        recordEvent(runId, a, 'portal:input_expired', null, { inputId: input.id, minutes });
        if (!a.pending.size) setStatus(runId, 'running');
        resolve(response);
      }, minutes * 60_000);
      pending.timer.unref?.();
    }
    const onAbort = () => {
      clearTimeout(pending.timer);
      if (a.pending.get(input.id) !== pending) return; // already answered or expired
      a.pending.delete(input.id);
      exec("UPDATE inputs SET status = 'cancelled' WHERE id = ? AND status = 'pending'", input.id);
      notifyProject(r.project_id, 'input.resolved', { id: input.id, status: 'cancelled' });
      reject(new DOMException('Run stopped', 'AbortError'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function appendDecisions(projectId: string, questions: any[], answers: Record<string, unknown>, who: string, context: string): Promise<void> {
  const p = getProject(projectId);
  const file = path.join(projectDir(p), 'docs', 'decisions.md');
  const date = now().slice(0, 10);
  const entries = (questions || [])
    .map((q: any) => {
      const a = answers?.[q.question];
      if (a === undefined || a === '') return '';
      const text = Array.isArray(a) ? a.join(', ') : String(a);
      return `\n### ${date} — ${q.header || 'Decision'}\n\n**Q:** ${q.question}\n**A:** ${text}\n_Answered by ${who}${context ? ` for ${context}` : ''}._\n`;
    })
    .join('');
  if (!entries) return;
  await withLock(`git:${projectDir(p)}`, async () => {
    fs.appendFileSync(file, entries);
    await commitAll(projectDir(p), 'Record decision', ['docs/decisions.md']).catch(() => false);
  });
  await reindexDecisions(projectId);
}

/** Resolve a pending question or approval (from the UI or the project inbox). */
export async function answerInput(inputId: string, user: { id: string; name: string }, body: any): Promise<Row> {
  const row = one('SELECT * FROM inputs WHERE id = ?', inputId);
  if (!row) throw new HttpError(404, 'Question not found');
  if (row.status === 'expired') throw new HttpError(409, 'Nobody answered this in time, so the agent was told to carry on without it.');
  if (row.status !== 'pending') throw badRequest('This was already answered');
  const payload = parseJson<any>(row.payload, {});
  let response: any;
  let questions: { list: any[]; answers: Record<string, string | string[]> } | null = null;
  if (row.type === 'question') {
    const answers: Record<string, string | string[]> = {};
    for (const q of payload.questions || []) {
      const a = body.answers?.[q.question];
      if (a === undefined || a === null || (typeof a === 'string' && !a.trim()) || (Array.isArray(a) && !a.length)) continue;
      answers[q.question] = Array.isArray(a) ? a.map(String).slice(0, 10) : String(a).slice(0, 4000);
    }
    const free = typeof body.response === 'string' ? body.response.trim().slice(0, 4000) : '';
    if (!Object.keys(answers).length && !free) throw badRequest('Answer at least one question');
    response = { answers, ...(free ? { response: free } : {}) };
    questions = { list: payload.questions, answers };
  } else {
    if (body.decision !== 'allow' && body.decision !== 'deny') throw badRequest('Choose allow or deny');
    // Allowing is bound to the exact call the person saw (its fingerprint); declining needs no proof.
    if (body.decision === 'allow' && payload.inputHash && body.inputHash !== payload.inputHash) {
      throw new HttpError(409, 'This is not the tool call you reviewed. Reload the page and review it again.');
    }
    response = {
      decision: body.decision,
      remember: Boolean(body.remember),
      message: typeof body.message === 'string' ? body.message.slice(0, 2000) : '',
    };
  }
  // Claim it in one step, so two people answering at once cannot both win, and an expiry cannot overtake an answer.
  const claimed = exec(
    "UPDATE inputs SET status = 'answered', response = ?, answered_by = ?, answered_at = ? WHERE id = ? AND status = 'pending'",
    JSON.stringify(response),
    user.id,
    now(),
    inputId,
  );
  if (!claimed.changes) throw new HttpError(409, 'Someone answered this a moment ago.');
  if (questions) {
    const r = row.run_id ? one('SELECT title FROM agent_runs WHERE id = ?', row.run_id) : null;
    await appendDecisions(row.project_id, questions.list, questions.answers, user.name, r ? `run “${r.title}”` : payload.source === 'qa' ? 'a Knowledge question' : '').catch((e) =>
      console.error(`[inputs] could not record the decision of ${inputId}:`, e),
    );
  }
  notifyProject(row.project_id, 'input.resolved', { id: inputId, status: 'answered' });
  if (row.run_id) {
    const a = active.get(row.run_id);
    const p = a?.pending.get(inputId);
    if (a && p) {
      clearTimeout(p.timer);
      a.pending.delete(inputId);
      recordEvent(row.run_id, a, 'portal:input_answered', null, { inputId, response, by: user.name });
      if (!a.pending.size) setStatus(row.run_id, 'running');
      p.resolve(response);
    }
  }
  return one('SELECT * FROM inputs WHERE id = ?', inputId)!;
}

/* ------------------------------------------------------------------ */
/* Starting and running                                                */
/* ------------------------------------------------------------------ */

function relToProject(project: Project, abs: string): string {
  return path.relative(projectDir(project), abs).split(path.sep).join('/');
}

export interface StartedRun {
  run: Row;
  done: Promise<Row>;
}

export async function startRun(input: StartRunInput): Promise<StartedRun> {
  const settings = getSettings();
  const project = getProject(input.projectId);
  // The project's own connection decides the provider; without one it follows Settings.
  // A continued run keeps the engine of the run it continues.
  if (input.resumeOf && input.engine === undefined) input.engine = parseJson<any>(getRun(input.resumeOf).meta, {}).engine ?? null;
  const mode = engineProvider(project.id, input.engine);
  // The person's and the project's monthly caps apply to every run, not only to diagrams and triggers.
  assertBudget(mode, input.userId, project.id);
  const pdir = projectDir(project);
  const runId = newId('r_');
  const model = input.model || 'sonnet';
  const permissionMode: PermissionMode = input.permissionMode ?? settings.agents.defaultPermissionMode;

  let resumeSession: string | undefined;
  let workDir = path.join(pdir, 'work', runId);
  let worktree: string | null = null;
  let inheritedRepos: RunRepo[] | null = null;
  if (input.resumeOf) {
    const prev = getRun(input.resumeOf);
    if (prev.project_id !== project.id) throw badRequest('That run belongs to another project');
    resumeSession = prev.session_id || undefined;
    const prevMeta = parseJson<any>(prev.meta, {});
    if (prevMeta.workDir) workDir = path.join(pdir, prevMeta.workDir);
    worktree = prev.worktree;
    input.repoId = input.repoId ?? prev.repo_id;
    input.branch = input.branch ?? prev.branch;
    if (Array.isArray(prevMeta.repos) && prevMeta.repos.length) inheritedRepos = prevMeta.repos;
    if (!input.integrations && Array.isArray(prevMeta.integrations)) input.integrations = prevMeta.integrations.map((x: any) => x.id);
  }
  // One list of repositories either way; the first one fills the run's own repo_id / branch / worktree columns.
  const choices: RepoChoice[] = inheritedRepos ? [] : input.repos?.length ? input.repos : input.repoId ? [{ repoId: input.repoId, branch: input.branch }] : [];
  if (choices.length) {
    const seen = new Set<string>();
    for (const c of choices) {
      if (seen.has(c.repoId)) throw badRequest('Each repository can be chosen once');
      seen.add(c.repoId);
    }
    input.repoId = choices[0].repoId;
    input.branch = choices[0].branch ?? input.branch ?? null;
  }

  insert('agent_runs', {
    id: runId,
    project_id: project.id,
    workflow_id: input.workflowId ?? null,
    kind: input.kind,
    title: input.title.slice(0, 200),
    prompt: input.prompt,
    status: 'queued',
    repo_id: input.repoId ?? null,
    branch: input.branch ?? null,
    worktree,
    resume_of: input.resumeOf ?? null,
    model,
    permission_mode: permissionMode,
    provider: mode,
    meta: JSON.stringify({ ...(input.meta ?? {}), workDir: relToProject(project, workDir), ...(inheritedRepos ? { repos: inheritedRepos } : {}), ...(input.engine ? { engine: input.engine } : {}) }),
    created_by: input.userId,
    created_at: now(),
  });
  const a: Active = {
    abort: new AbortController(),
    allowed: new Set(),
    pending: new Map(),
    seq: 0,
    seenMessageIds: new Set(),
    projectId: project.id,
    workflowId: input.workflowId ?? undefined,
  };
  active.set(runId, a);
  notifyProject(project.id, 'run.updated', runSummary(getRun(runId)));

  const done = (async () => {
    try {
      fs.mkdirSync(workDir, { recursive: true });
      if (!input.oneshot) {
        ensureBuiltInSkills(project);
        // The Word and PowerPoint templates that apply to this project, for make-doc (D-13).
        try {
          syncProjectTemplates(project);
        } catch {
          /* a template problem must never stop a run */
        }
      }
      if (choices.length > 1 && !worktree) {
        // Several repositories: one working copy each, side by side in the run folder.
        const made: RunRepo[] = [];
        for (const c of choices) {
          const repo = getRepo(c.repoId);
          if (repo.project_id !== project.id) throw badRequest('That repository belongs to another project');
          const branch = c.branch || repo.default_branch;
          const dest = path.join(workDir, repo.slug);
          await createWorktree(repo, branch, dest);
          made.push({ repoId: repo.id, name: repo.name, branch, worktree: relToProject(project, dest) });
        }
        worktree = made[0].worktree;
        const meta = parseJson<any>(getRun(runId).meta, {});
        update('agent_runs', runId, { worktree, branch: made[0].branch, meta: JSON.stringify({ ...meta, repos: made }) });
      } else if (input.repoId && !worktree) {
        const repo = getRepo(input.repoId);
        if (repo.project_id !== project.id) throw badRequest('That repository belongs to another project');
        const dest = path.join(workDir, repo.slug);
        await createWorktree(repo, input.branch || repo.default_branch, dest);
        worktree = relToProject(project, dest);
        update('agent_runs', runId, { worktree, branch: input.branch || repo.default_branch });
      }
      // Integrations become MCP servers. Demo runs only record them; real ones start them with their secrets.
      let integ: RunIntegrations | null = null;
      if (input.integrations?.length && !input.oneshot) {
        integ = mode === 'demo' ? await resolveIntegrations(input.integrations, input.userId).catch(() => null) : await resolveIntegrations(input.integrations, input.userId);
        if (integ) {
          const meta = parseJson<any>(getRun(runId).meta, {});
          update('agent_runs', runId, { meta: JSON.stringify({ ...meta, integrations: integ.summary }) });
        }
      }
      // The team vault and the owner's vault, copied into the run folder for agents to read.
      const vaultNote = !input.oneshot && (input.kind === 'chat' || input.kind === 'test') ? copyVaultsInto(workDir, relToProject(project, workDir), input.userId, project.id) : '';
      await execute(runId, a, project, input, { mode, model, permissionMode, workDir, resumeSession, worktree, integ, vaultNote });
    } catch (e: any) {
      const aborted = e?.name === 'AbortError' || a.abort.signal.aborted;
      const r = getRun(runId);
      if (!['completed', 'failed', 'stopped'].includes(r.status)) {
        setStatus(runId, aborted ? 'stopped' : 'failed', { error: aborted ? (a.stopReason ?? 'Stopped by a user') : String(e?.message ?? e), finished_at: now() });
      }
      if (!aborted && !(e instanceof HttpError)) console.error(`[run ${runId}]`, e);
    } finally {
      for (const [inputId, p] of a.pending) {
        exec("UPDATE inputs SET status = 'cancelled' WHERE id = ? AND status = 'pending'", inputId);
        p.reject(new DOMException('Run ended', 'AbortError'));
      }
      active.delete(runId);
      // The run's copy of its project's AWS keys goes with it.
      removeRunAwsFiles(runId);
    }
    return getRun(runId);
  })();
  return { run: getRun(runId), done };
}

async function execute(
  runId: string,
  a: Active,
  project: Project,
  input: StartRunInput,
  o: { mode: string; model: string; permissionMode: PermissionMode; workDir: string; resumeSession?: string; worktree: string | null; integ?: RunIntegrations | null; vaultNote?: string },
): Promise<void> {
  const pdir = projectDir(project);
  const r0 = getRun(runId);
  const repos = runRepos(r0);
  // With several working copies the agent may change any of them, so it writes anywhere in the run folder.
  const writeDirRel = relToProject(project, repos.length > 1 ? o.workDir : o.worktree ? path.join(pdir, o.worktree) : o.workDir);
  const writeDirAbs = path.join(pdir, writeDirRel);
  const user = one<{ name: string }>('SELECT name FROM users WHERE id = ?', input.userId);

  let prompt = input.prompt;
  if (!input.oneshot) {
    const repo = input.repoId ? getRepo(input.repoId) : null;
    prompt = [
      `You are working in the project "${project.name}". Read CLAUDE.md first.`,
      repos.length > 1
        ? [
            'This run works across several repositories, each with its own working copy:',
            ...repos.map((x) => `- ${x.worktree}/ (repository "${x.name}", branch ${x.branch})`),
            'Make code changes only inside these working copies; keep each change in the repository it belongs to.',
          ].join('\n')
        : repo
          ? `Working copy for this run: ${writeDirRel}/ (branch ${r0.branch}, repository "${repo.name}"). Make code changes only inside it.`
          : `If you create files, put them under ${writeDirRel}/.`,
      ...(o.integ?.summary.length
        ? [
            `Tools from integrations: ${o.integ.summary.map((x) => `${x.server} (${x.name}${x.readOnly ? ', read-only' : ''})`).join(', ')}. Read-only integrations refuse tools that change something.`,
          ]
        : []),
      ...(o.vaultNote ? [o.vaultNote] : []),
      `This request comes from ${user?.name ?? 'a team member'}.`,
      '---',
      input.prompt,
    ].join('\n');
  }

  const canUseTool: CanUseTool = async (toolName, toolInput, { signal }) => {
    if (input.autoApprove && !input.oneshot) {
      // Nobody is there to answer: questions are refused and the agent must decide.
      if (toolName === 'AskUserQuestion') return { behavior: 'deny', message: 'No person is available to answer. Choose the most reasonable option and list it under assumptions in your summary.' };
      if (input.trustTools) {
        // Trusted + unattended: file edits and shell commands run without asking.
        // always-blocked commands are already refused by the guard; here just allow everything else.
        return { behavior: 'allow', updatedInput: toolInput };
      }
      // Untrusted unattended: only safe commands run.
      if (toolName === 'Bash') {
        const why = blockedCommand(String((toolInput as any).command ?? ''));
        if (why) return { behavior: 'deny', message: `Blocked by Agent Portal: ${why} If you need this, report blocked and say what you need.` };
      }
      return { behavior: 'allow', updatedInput: toolInput };
    }
    // Trust all tools in an interactive (non-autoApprove) session: file edits and shell commands run without asking.
    // Blocked commands are still refused via the guard.
    if (input.trustTools && !input.oneshot) {
      if (toolName === 'AskUserQuestion') {
        // Questions still flow to the person.
        const questions = Array.isArray((toolInput as any).questions) ? (toolInput as any).questions : [];
        const resp = await waitForInput(runId, a, 'question', toolName, { questions }, signal);
        return { behavior: 'allow', updatedInput: { ...toolInput, questions, answers: resp.answers, ...(resp.response ? { response: resp.response } : {}) } };
      }
      // always-blocked commands are checked in the guard; here just allow.
      return { behavior: 'allow', updatedInput: toolInput };
    }
    if (toolName === 'AskUserQuestion') {
      const questions = Array.isArray((toolInput as any).questions) ? (toolInput as any).questions : [];
      const resp = await waitForInput(runId, a, 'question', toolName, { questions }, signal);
      return { behavior: 'allow', updatedInput: { ...toolInput, questions, answers: resp.answers, ...(resp.response ? { response: resp.response } : {}) } };
    }
    if (input.oneshot || input.kind === 'review') {
      return { behavior: 'deny', message: `${toolName} is not available for this task.` };
    }
    const remember = rememberKey(toolName, toolInput);
    if (a.allowed.has(remember.key)) return { behavior: 'allow', updatedInput: toolInput };
    const command = toolName === 'Bash' ? String((toolInput as any).command ?? '') : '';
    if (command.length > MAX_REVIEWABLE_COMMAND) {
      return { behavior: 'deny', message: `This command is ${command.length} characters long, too long for a person to review. Write a script file first, or split it into smaller steps.` };
    }
    // The approval shows the whole command, address or path, and is bound to the exact call by its fingerprint. The
    // call that runs is always this one (toolInput, held here), whatever the browser sends.
    const resp = await waitForInput(
      runId,
      a,
      'approval',
      toolName,
      { toolName, input: approvalView(toolInput), inputHash: inputFingerprint(toolName, toolInput), rememberScope: remember.scope, rememberLabel: remember.label.slice(0, 300) },
      signal,
    );
    if (resp.decision === 'allow') {
      if (resp.remember) a.allowed.add(remember.key);
      return { behavior: 'allow', updatedInput: toolInput };
    }
    return { behavior: 'deny', message: resp.message ? (resp.expired ? resp.message : `The user declined: ${resp.message}`) : 'The user declined this action.' };
  };

  const runDirAbs = path.resolve(o.workDir);
  const readsAnywhere = Boolean(getSettings().agents.allowReadsOutsideProject);
  const guard = async (toolName: string, toolInput: Record<string, unknown>): Promise<string | null> => {
    // Reads stay inside the project folder: other projects, the portal database and its key file live next door.
    const readFields = READ_TOOL_FIELDS.get(toolName);
    if (readFields && !readsAnywhere) {
      for (const field of readFields) {
        const v = toolInput[field];
        if (typeof v !== 'string' || !v) continue;
        if (field === 'pattern' && !path.isAbsolute(v)) continue; // a relative glob is searched from the project folder
        if (!isInsideDir(pdir, path.resolve(pdir, v))) {
          return 'Blocked by Agent Portal: agents may only read files inside this project. If you need something from elsewhere, ask the person to add it to the project documents, the Vault or a connected repository.';
        }
      }
    }
    if (toolName === 'Bash') {
      const command = String(toolInput.command ?? '');
      // Every run, trusted or not: deletes stay inside this run's folder (the shell starts in the project folder).
      const outside = outsideDeleteReason(command, runDirAbs, { cwd: pdir, home: os.homedir() });
      if (outside) return `Blocked by Agent Portal: ${outside}`;
      if (input.trustTools && !input.oneshot) {
        // Trusted session: always-blocked commands still refused.
        const alwaysBlocked = alwaysBlockedCommand(command);
        if (alwaysBlocked) return `Blocked by Agent Portal: ${alwaysBlocked}`;
        // Intercept git push: perform it via the portal, return success/failure as the "block" reason.
        if (isGitPush(command)) {
          const parsed = parseTrustedPush(command);
          if (!parsed) return null; // not a push (shouldn't happen)
          if ('unsafe' in parsed) return `Blocked by Agent Portal: ${parsed.unsafe}`;
          if (input.trustedPushHandler) {
            try {
              const msg = await input.trustedPushHandler(parsed.branch);
              return `Agent Portal performed the push: ${msg}`;
            } catch (e: any) {
              return `Agent Portal could not push: ${String(e?.message ?? e).slice(0, 300)}`;
            }
          }
          return 'Blocked by Agent Portal: no repository is attached to this session. Attach a repository in the session settings and try again.';
        }
        // Integration read-only check.
        if (o.integ?.readOnly.size || o.integ?.onlyTools.size) {
          const why = integrationGuard(o.integ.readOnly, toolName, o.integ.onlyTools);
          if (why) return why;
        }
        return null;
      }
      // Untrusted: git push is blocked.
      if (isGitPush(command)) {
        return 'Blocked by Agent Portal: do not run git push. In a session that allows agent pushes, add "push" to your status line and the portal pushes for you; otherwise a person pushes from the portal after review.';
      }
      // Untrusted sessions: the always-blocked and the untrusted lists apply here too, before any approval,
      // so a command allowed earlier in the run (or by an approval) can never run one of them.
      const blocked = blockedCommand(command);
      if (blocked) return `Blocked by Agent Portal: ${blocked}`;
    }
    if (o.integ?.readOnly.size || o.integ?.onlyTools.size) {
      const why = integrationGuard(o.integ.readOnly, toolName, o.integ.onlyTools);
      if (why) return why;
    }
    if (!WRITE_TOOLS.has(toolName)) return null;
    const target = String(toolInput.file_path ?? toolInput.notebook_path ?? '');
    if (!target) return null;
    const abs = path.resolve(pdir, target);
    if (abs === writeDirAbs || abs.startsWith(writeDirAbs + path.sep)) return null;
    return `Blocked by Agent Portal: this run may only change files under ${writeDirRel}/.`;
  };

  const env = o.mode === 'demo' ? {} : await agentEnv(project.id, o.mode as any, { runId });
  const opts: ProviderRunOptions = {
    prompt,
    cwd: pdir,
    model: o.model,
    permissionMode: o.permissionMode,
    allowedTools: input.allowedTools ?? (input.oneshot ? [] : AUTO_ALLOWED),
    tools: input.tools,
    maxTurns: input.maxTurns ?? (input.oneshot ? 1 : getSettings().agents.maxTurns),
    resume: o.resumeSession,
    settingSources: input.oneshot ? [] : ['project'],
    systemAppend:
      input.systemAppend ??
      (input.lead
        ? composeLeadAppend(input.lead, input.lead.team, o.mode === 'kiro' ? 'kiro' : o.mode === 'demo' ? 'demo' : 'claude', Boolean(input.lead.isKiroNative))
        : o.mode === 'kiro'
          ? 'You run inside Agent Portal. Follow CLAUDE.md. When requirements are unclear, stop and ask your questions in your final reply instead of guessing; the user answers with a follow-up. When a task matches one of the project roles, hand it to that role with the subagent tool (the roles are listed below).'
          : 'You run inside Agent Portal. Follow CLAUDE.md. When requirements are unclear, use AskUserQuestion instead of guessing. When a task matches a role subagent in .claude/agents, delegate to it.'),
    leadAgent: input.lead?.name,
    systemPrompt: input.systemPrompt,
    canUseTool,
    guard: input.oneshot ? undefined : guard,
    onHook: (event, data) => recordEvent(runId, a, `hook:${event}`, null, data),
    abort: a.abort,
    env,
    mcpServers: o.mode === 'demo' ? undefined : o.integ?.servers,
    demo:
      o.mode === 'demo'
        ? {
            projectDir: pdir,
            runId,
            kind: input.kind,
            agents: listAgentFiles(project).filter((x) => x.enabled).map((x) => ({ name: x.name, description: x.description, model: x.model || 'sonnet' })),
            skills: listSkillNames(project),
            writeDir: writeDirAbs,
            writeDirRel,
            decisions: readDecisions(project),
            search: (q, limit) => searchForAgent(project.id, q, limit),
            speed: config.demoSpeed,
          }
        : undefined,
  };

  setStatus(runId, 'running', { started_at: now() });

  const stream: AsyncIterable<SdkMessage> =
    o.mode === 'demo'
      ? input.oneshot && input.demoOutput
        ? demoOneshot(opts, input.demoOutput)
        : demoRun(opts)
      : o.mode === 'kiro'
        ? kiroRun(opts)
        : sdkRun(opts);

  let inTok = 0;
  let outTok = 0;
  let sawResult = false;
  for await (const msg of stream) {
    const type = msg.subtype ? `${msg.type}:${msg.subtype}` : msg.type;
    recordEvent(runId, a, type, (msg.parent_tool_use_id as string) ?? null, msg);
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      update('agent_runs', runId, { session_id: msg.session_id });
    }
    if (msg.type === 'assistant' && msg.message?.usage) {
      const mid = msg.message.id || msg.uuid || '';
      if (!a.seenMessageIds.has(mid)) {
        a.seenMessageIds.add(mid);
        inTok += (msg.message.usage.input_tokens || 0) + (msg.message.usage.cache_read_input_tokens || 0) + (msg.message.usage.cache_creation_input_tokens || 0);
        outTok += msg.message.usage.output_tokens || 0;
        update('agent_runs', runId, { input_tokens: inTok, output_tokens: outTok });
      }
    }
    if (msg.type === 'result') {
      sawResult = true;
      const ok = msg.subtype === 'success' && !msg.is_error;
      const meta = parseJson<any>(getRun(runId).meta, {});
      if (typeof msg.estimated_cost_usd === 'number') meta.estimatedUsd = msg.estimated_cost_usd;
      if (typeof msg.kiro_credits === 'number') meta.kiroCredits = msg.kiro_credits;
      const spent = runSpend(msg, input.resumeOf ?? null, { input: inTok, output: outTok });
      if (spent.session) meta.sessionTotals = spent.session;
      setStatus(runId, ok ? 'completed' : 'failed', {
        result: typeof msg.result === 'string' ? msg.result : '',
        error: ok ? null : `${msg.subtype ?? 'error'}${typeof msg.result === 'string' && msg.result ? `: ${msg.result.slice(0, 500)}` : ''}`,
        cost_usd: spent.costUsd,
        input_tokens: spent.input,
        output_tokens: spent.output,
        meta: JSON.stringify(meta),
        finished_at: now(),
      });
    }
  }
  if (!sawResult) {
    if (a.abort.signal.aborted) throw new DOMException('Run stopped', 'AbortError');
    setStatus(runId, 'failed', { error: 'The agent ended without a result', finished_at: now() });
  }
}

interface SessionTotals {
  costUsd: number;
  /** Input tokens including cache reads and writes (the portal's convention for input_tokens). */
  input: number;
  output: number;
  sessionId?: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * This run's own spend. With the Claude Agent SDK a resumed session's result carries the session's running totals
 * (its docs: "a resumed or forked session continues from the total its transcript saved"), and every session
 * iteration and follow-up resumes the previous run. Storing those totals made budgets, caps and Insights add the
 * earlier runs again on every iteration. A continued run now stores the difference from the run it continues.
 * Totals come from modelUsage, which (unlike usage) includes subagents.
 */
export function runSpend(
  msg: SdkMessage,
  resumeOf: string | null,
  live: { input: number; output: number },
): { costUsd: number; input: number; output: number; session: SessionTotals | null } {
  const total = num(msg.total_cost_usd);
  const perModel = (msg as any).modelUsage;
  if (!perModel || typeof perModel !== 'object' || !Object.keys(perModel).length) {
    // Demo, Kiro and older results: no per-model usage, and totals are per run.
    const usage = (msg.usage ?? {}) as Record<string, number>;
    return {
      costUsd: total,
      input: num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens) || live.input,
      output: num(usage.output_tokens) || live.output,
      session: null,
    };
  }
  const session: SessionTotals = { costUsd: total, input: 0, output: 0, sessionId: typeof msg.session_id === 'string' ? msg.session_id : undefined };
  for (const m of Object.values(perModel as Record<string, any>)) {
    session.input += num(m?.inputTokens) + num(m?.cacheReadInputTokens) + num(m?.cacheCreationInputTokens);
    session.output += num(m?.outputTokens);
  }
  let prev: Partial<SessionTotals> | null = null;
  if (resumeOf) {
    const p = one<Row>('SELECT cost_usd, session_id, meta FROM agent_runs WHERE id = ?', resumeOf);
    if (p) {
      const pm = parseJson<any>(p.meta, {});
      // Runs recorded before this fix stored the session total as their cost, so that is the earlier total.
      prev = pm.sessionTotals ?? { costUsd: num(p.cost_usd), sessionId: p.session_id ?? undefined };
    }
  }
  const sameSession = Boolean(prev) && (!prev!.sessionId || !session.sessionId || prev!.sessionId === session.sessionId);
  const minus = (cur: number, before: number | undefined) => (sameSession && typeof before === 'number' && cur >= before ? cur - before : cur);
  return {
    costUsd: Number(minus(session.costUsd, prev?.costUsd).toFixed(6)),
    input: minus(session.input, prev?.input),
    output: minus(session.output, prev?.output),
    session,
  };
}

async function* demoOneshot(opts: ProviderRunOptions, output: () => string | Promise<string>): AsyncIterable<SdkMessage> {
  const model = demoModel(opts.model);
  const session = `demo-${Date.now().toString(36)}`;
  yield { type: 'system', subtype: 'init', session_id: session, model, tools: [], demo: true };
  const text = await output();
  const usage = { input_tokens: Math.round(opts.prompt.length / 4) + 300, output_tokens: Math.round(text.length / 4) };
  const { estimateCost } = await import('./pricing.ts');
  yield {
    type: 'assistant',
    session_id: session,
    parent_tool_use_id: null,
    message: { id: `msg_${session}`, role: 'assistant', model, content: [{ type: 'text', text }], usage },
  };
  yield {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: session,
    result: text,
    total_cost_usd: 0,
    estimated_cost_usd: Number(estimateCost(model, usage).toFixed(5)),
    usage,
    num_turns: 1,
  };
}

function readDecisions(p: Project): string {
  try {
    return fs.readFileSync(path.join(projectDir(p), 'docs', 'decisions.md'), 'utf8');
  } catch {
    return '';
  }
}

/** Run a single-shot model call (no tools) and return its text. */
export async function oneshot(opts: {
  projectId: string;
  userId: string;
  kind: RunKind;
  title: string;
  system: string;
  prompt: string;
  model: 'haiku' | 'sonnet' | 'opus';
  meta?: Record<string, unknown>;
  demoOutput: () => string | Promise<string>;
}): Promise<{ text: string; runId: string }> {
  const { run, done } = await startRun({
    projectId: opts.projectId,
    userId: opts.userId,
    kind: opts.kind,
    title: opts.title,
    prompt: opts.prompt,
    model: opts.model,
    oneshot: true,
    tools: [],
    allowedTools: [],
    systemPrompt: opts.system,
    maxTurns: 1,
    meta: opts.meta,
    demoOutput: opts.demoOutput,
  });
  const final = await done;
  if (final.status !== 'completed') throw new HttpError(502, `The model call failed: ${final.error || final.status}`);
  return { text: final.result || '', runId: run.id };
}

export function stopRun(runId: string): boolean {
  const a = active.get(runId);
  if (!a) return false;
  a.abort.abort();
  return true;
}

/** True while any run is going: session iterations and standalone runs (reviews, questions, documents, one-off runs). */
export function anyRunActive(): boolean {
  return active.size > 0;
}

/**
 * Stop the standalone runs that are still going and wait (up to timeoutMs) until each has recorded how it ended, so
 * the database can be closed afterwards. Session iterations are left alone: their sessions resume after a restart.
 * Returns how many runs were stopped.
 */
export async function stopStandaloneRuns(reason: string, timeoutMs: number): Promise<number> {
  const ids = [...active].filter(([, a]) => !a.workflowId).map(([id]) => id);
  for (const id of ids) {
    const a = active.get(id)!;
    a.stopReason = reason;
    a.abort.abort();
  }
  const until = Date.now() + timeoutMs;
  while (ids.some((id) => active.has(id)) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return ids.length;
}

export { killProcessTree } from '../proc.ts';

export function isActive(runId: string): boolean {
  return active.has(runId);
}

/** After a restart, nothing is running any more. */
export function recoverRuns(): void {
  const stuck = all("SELECT id FROM agent_runs WHERE status IN ('queued', 'running', 'waiting')");
  for (const r of stuck) {
    exec("UPDATE agent_runs SET status = 'failed', error = 'The server restarted while this run was active', finished_at = ? WHERE id = ?", now(), r.id);
  }
  exec("UPDATE inputs SET status = 'cancelled' WHERE status = 'pending' AND run_id IS NOT NULL");
  // AWS keys copied for runs that were cut off by the restart.
  clearRunAwsFiles();
}

export { runSummary, providerMode };
