import fs from 'node:fs';
import path from 'node:path';
import { all, insert, one, run as exec, update, type Row } from '../db.ts';
import { publish, projectChannel, runChannel } from '../events.ts';
import { agentEnv, assertBudget, getSettings, providerMode } from '../settings.ts';
import { config } from '../config.ts';
import { ensureBuiltInSkills, getProject, projectDir, notifyProject, type Project } from '../projects.ts';
import { HttpError, badRequest, newId, now, parseJson, withLock } from '../util.ts';
import { commitAll } from '../git.ts';
import { blockedCommand } from '../guardrails.ts';
import type { CanUseTool, PermissionMode, ProviderRunOptions, SdkMessage } from './types.ts';
import { sdkRun } from './sdk.ts';
import { kiroRun } from './kiro.ts';
import { demoRun, demoModel } from './demo.ts';
import { listAgentFiles, listSkillNames } from '../builder.ts';
import { searchForAgent, reindexDecisions } from '../knowledge.ts';
import { createWorktree, getRepo } from '../repos.ts';
import { effectiveProvider } from '../project-aws.ts';

export type RunKind = 'chat' | 'test' | 'review' | 'qa' | 'learn' | 'quiz' | 'verify' | 'connection';

export interface StartRunInput {
  projectId: string;
  userId: string;
  kind: RunKind;
  title: string;
  prompt: string;
  repoId?: string | null;
  branch?: string | null;
  /** Several repositories, each with its own working copy in the run folder. The first is the run's main one. */
  repos?: RepoChoice[] | null;
  permissionMode?: PermissionMode;
  model?: string;
  resumeOf?: string | null;
  tools?: string[];
  allowedTools?: string[];
  systemAppend?: string;
  systemPrompt?: string;
  maxTurns?: number;
  meta?: Record<string, unknown>;
  /** Unattended workflow runs: tools are allowed without asking, except the commands in guardrails.ts. */
  autoApprove?: boolean;
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
}

interface Active {
  abort: AbortController;
  allowAll: Set<string>;
  pending: Map<string, Pending>;
  seq: number;
  seenMessageIds: Set<string>;
  /** For the project's live "what is happening" line: whose run this is and when it was last announced. */
  projectId?: string;
  workflowId?: string;
  activityAt?: number;
}

const active = new Map<string, Active>();

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const AUTO_ALLOWED = ['Read', 'Grep', 'Glob', 'Skill', 'TodoWrite', 'Agent', 'Task', 'LS'];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function runSummary(r: Row) {
  return {
    id: r.id,
    project_id: r.project_id,
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
  const r = one('SELECT * FROM runs WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Run not found');
  return r;
}

function setStatus(runId: string, status: string, extra: Record<string, unknown> = {}): void {
  update('runs', runId, { status, ...(extra as any) });
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
  insert('run_events', { run_id: runId, seq, ts, type, parent_tool_use_id: parent, data: JSON.stringify(small) });
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

export function createInput(opts: {
  projectId: string;
  runId: string | null;
  type: 'question' | 'approval';
  toolName: string | null;
  payload: unknown;
  userId: string | null;
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
  });
  const row = one('SELECT * FROM inputs WHERE id = ?', id)!;
  notifyProject(opts.projectId, 'input.created', inputView(row));
  return row;
}

export function inputView(r: Row) {
  return { ...r, payload: parseJson(r.payload, {}), response: parseJson(r.response, null) };
}

function waitForInput(runId: string, a: Active, type: 'question' | 'approval', toolName: string, payload: unknown, signal: AbortSignal): Promise<any> {
  const r = getRun(runId);
  const input = createInput({ projectId: r.project_id, runId, type, toolName, payload, userId: r.created_by });
  recordEvent(runId, a, 'portal:input', null, { inputId: input.id, inputType: type, toolName, payload });
  setStatus(runId, 'waiting');
  return new Promise((resolve, reject) => {
    a.pending.set(input.id, { resolve, reject });
    const onAbort = () => {
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
  if (row.status !== 'pending') throw badRequest('This was already answered');
  const payload = parseJson<any>(row.payload, {});
  let response: any;
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
    const r = row.run_id ? one('SELECT title FROM runs WHERE id = ?', row.run_id) : null;
    await appendDecisions(row.project_id, payload.questions, answers, user.name, r ? `run “${r.title}”` : payload.source === 'qa' ? 'a Knowledge question' : '');
  } else {
    if (body.decision !== 'allow' && body.decision !== 'deny') throw badRequest('Choose allow or deny');
    response = {
      decision: body.decision,
      remember: Boolean(body.remember),
      message: typeof body.message === 'string' ? body.message.slice(0, 2000) : '',
    };
  }
  exec(
    "UPDATE inputs SET status = 'answered', response = ?, answered_by = ?, answered_at = ? WHERE id = ?",
    JSON.stringify(response),
    user.id,
    now(),
    inputId,
  );
  notifyProject(row.project_id, 'input.resolved', { id: inputId, status: 'answered' });
  if (row.run_id) {
    const a = active.get(row.run_id);
    const p = a?.pending.get(inputId);
    if (a && p) {
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
  const mode = effectiveProvider(project.id);
  assertBudget(mode);
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

  insert('runs', {
    id: runId,
    project_id: project.id,
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
    meta: JSON.stringify({ ...(input.meta ?? {}), workDir: relToProject(project, workDir), ...(inheritedRepos ? { repos: inheritedRepos } : {}) }),
    created_by: input.userId,
    created_at: now(),
  });
  const a: Active = {
    abort: new AbortController(),
    allowAll: new Set(),
    pending: new Map(),
    seq: 0,
    seenMessageIds: new Set(),
    projectId: project.id,
    workflowId: typeof input.meta?.workflowId === 'string' ? input.meta.workflowId : undefined,
  };
  active.set(runId, a);
  notifyProject(project.id, 'run.updated', runSummary(getRun(runId)));

  const done = (async () => {
    try {
      fs.mkdirSync(workDir, { recursive: true });
      if (!input.oneshot) ensureBuiltInSkills(project);
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
        update('runs', runId, { worktree, branch: made[0].branch, meta: JSON.stringify({ ...meta, repos: made }) });
      } else if (input.repoId && !worktree) {
        const repo = getRepo(input.repoId);
        if (repo.project_id !== project.id) throw badRequest('That repository belongs to another project');
        const dest = path.join(workDir, repo.slug);
        await createWorktree(repo, input.branch || repo.default_branch, dest);
        worktree = relToProject(project, dest);
        update('runs', runId, { worktree, branch: input.branch || repo.default_branch });
      }
      await execute(runId, a, project, input, { mode, model, permissionMode, workDir, resumeSession, worktree });
    } catch (e: any) {
      const aborted = e?.name === 'AbortError' || a.abort.signal.aborted;
      const r = getRun(runId);
      if (!['completed', 'failed', 'stopped'].includes(r.status)) {
        setStatus(runId, aborted ? 'stopped' : 'failed', { error: aborted ? 'Stopped by a user' : String(e?.message ?? e), finished_at: now() });
      }
      if (!aborted && !(e instanceof HttpError)) console.error(`[run ${runId}]`, e);
    } finally {
      for (const [inputId, p] of a.pending) {
        exec("UPDATE inputs SET status = 'cancelled' WHERE id = ? AND status = 'pending'", inputId);
        p.reject(new DOMException('Run ended', 'AbortError'));
      }
      active.delete(runId);
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
  o: { mode: string; model: string; permissionMode: PermissionMode; workDir: string; resumeSession?: string; worktree: string | null },
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
      `This request comes from ${user?.name ?? 'a team member'}.`,
      '---',
      input.prompt,
    ].join('\n');
  }

  const canUseTool: CanUseTool = async (toolName, toolInput, { signal }) => {
    if (input.autoApprove && !input.oneshot) {
      // Nobody is there to answer: questions are refused and the agent must decide, and only safe commands run.
      if (toolName === 'AskUserQuestion') return { behavior: 'deny', message: 'No person is available to answer. Choose the most reasonable option and list it under assumptions in your summary.' };
      if (toolName === 'Bash') {
        const why = blockedCommand(String((toolInput as any).command ?? ''));
        if (why) return { behavior: 'deny', message: `Blocked by Agent Portal: ${why} If you need this, report blocked and say what you need.` };
      }
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
    if (a.allowAll.has(toolName)) return { behavior: 'allow', updatedInput: toolInput };
    const resp = await waitForInput(runId, a, 'approval', toolName, { toolName, input: shrink(toolInput, 4000) }, signal);
    if (resp.decision === 'allow') {
      if (resp.remember) a.allowAll.add(toolName);
      return { behavior: 'allow', updatedInput: toolInput };
    }
    return { behavior: 'deny', message: resp.message ? `The user declined: ${resp.message}` : 'The user declined this action.' };
  };

  const guard = (toolName: string, toolInput: Record<string, unknown>): string | null => {
    if (!WRITE_TOOLS.has(toolName)) return null;
    const target = String(toolInput.file_path ?? toolInput.notebook_path ?? '');
    if (!target) return null;
    const abs = path.resolve(pdir, target);
    if (abs === writeDirAbs || abs.startsWith(writeDirAbs + path.sep)) return null;
    return `Blocked by Agent Portal: this run may only change files under ${writeDirRel}/.`;
  };

  const env = o.mode === 'demo' ? {} : await agentEnv(project.id);
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
      (o.mode === 'kiro'
        ? 'You run inside Agent Portal. Follow CLAUDE.md. When requirements are unclear, stop and ask your questions in your final reply instead of guessing; the user answers with a follow-up. The role descriptions in .claude/agents/ describe how this team works: apply the matching role yourself.'
        : 'You run inside Agent Portal. Follow CLAUDE.md. When requirements are unclear, use AskUserQuestion instead of guessing. When a task matches a role subagent in .claude/agents, delegate to it.'),
    systemPrompt: input.systemPrompt,
    canUseTool,
    guard: input.oneshot ? undefined : guard,
    onHook: (event, data) => recordEvent(runId, a, `hook:${event}`, null, data),
    abort: a.abort,
    env,
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
      update('runs', runId, { session_id: msg.session_id });
    }
    if (msg.type === 'assistant' && msg.message?.usage) {
      const mid = msg.message.id || msg.uuid || '';
      if (!a.seenMessageIds.has(mid)) {
        a.seenMessageIds.add(mid);
        inTok += (msg.message.usage.input_tokens || 0) + (msg.message.usage.cache_read_input_tokens || 0) + (msg.message.usage.cache_creation_input_tokens || 0);
        outTok += msg.message.usage.output_tokens || 0;
        update('runs', runId, { input_tokens: inTok, output_tokens: outTok });
      }
    }
    if (msg.type === 'result') {
      sawResult = true;
      const ok = msg.subtype === 'success' && !msg.is_error;
      const meta = parseJson<any>(getRun(runId).meta, {});
      if (typeof msg.estimated_cost_usd === 'number') meta.estimatedUsd = msg.estimated_cost_usd;
      if (typeof msg.kiro_credits === 'number') meta.kiroCredits = msg.kiro_credits;
      const usage = (msg.usage ?? {}) as Record<string, number>;
      setStatus(runId, ok ? 'completed' : 'failed', {
        result: typeof msg.result === 'string' ? msg.result : '',
        error: ok ? null : `${msg.subtype ?? 'error'}${typeof msg.result === 'string' && msg.result ? `: ${msg.result.slice(0, 500)}` : ''}`,
        cost_usd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0,
        input_tokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) || inTok,
        output_tokens: usage.output_tokens || outTok,
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

export function isActive(runId: string): boolean {
  return active.has(runId);
}

/** After a restart, nothing is running any more. */
export function recoverRuns(): void {
  const stuck = all("SELECT id FROM runs WHERE status IN ('queued', 'running', 'waiting')");
  for (const r of stuck) {
    exec("UPDATE runs SET status = 'failed', error = 'The server restarted while this run was active', finished_at = ? WHERE id = ?", now(), r.id);
  }
  exec("UPDATE inputs SET status = 'cancelled' WHERE status = 'pending' AND run_id IS NOT NULL");
}

export { runSummary, providerMode };
