/**
 * Telegram bridge: control the portal from a Telegram chat.
 *
 * - Long polling (getUpdates), so the portal needs no public address or tunnel.
 * - Only private chats whose ID is in TELEGRAM_ALLOWED_CHAT_IDS are answered. Anything else is
 *   dropped without a reply and logged (with the chat ID, so the owner can add their own).
 * - Every action goes through the portal's HTTP API with TELEGRAM_PORTAL_TOKEN, so the token's
 *   scopes and the portal's own rules apply (an API token cannot approve tool calls or pushes).
 * - Stopping a session asks for a "yes" first. Every command is written to the audit log.
 */

import fs from 'node:fs';
import path from 'node:path';
import { auditRaw } from '../audit.ts';
import { ENGINES, type BridgeEngine, type TelegramConfig } from './config.ts';
import { clipText, type TelegramApi, type TgMessage } from './telegram-api.ts';
import { PortalError, type PortalClient, type PortalWorkflow, type TranscriptEvent } from './portal-client.ts';

export const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'help', description: 'What the bot can do' },
  { command: 'projects', description: 'List your projects' },
  { command: 'project', description: 'Pick a project: /project 2' },
  { command: 'newproject', description: 'Create a project: /newproject Website' },
  { command: 'sessions', description: 'Recent sessions in the project' },
  { command: 'session', description: 'Pick a session: /session 1' },
  { command: 'new', description: 'Start a session: /new fix the login bug' },
  { command: 'status', description: 'Status and last reply of the session' },
  { command: 'stop', description: 'Stop the running session (asks first)' },
  { command: 'inbox', description: 'What is waiting for you' },
];

const HELP = [
  'Kyuubit portal bot',
  '',
  '/projects then /project <number> to pick a project',
  '/newproject <name> creates a project and picks it',
  '/sessions then /session <number> to pick a session',
  '/new <goal> starts a session (optionally /new codex <goal>)',
  'Any other text is sent as a message to the picked session',
  '/status shows the session and its last reply',
  '/stop stops the running session (you confirm with yes)',
  '/inbox lists approvals and questions waiting for you',
  '',
  'You get the agent\'s reply here when a turn finishes. Tool-call and push approvals still need the browser.',
].join('\n');

const ACTIVE = new Set(['pending', 'running']);
const CONFIRM_MS = 60_000;

interface ChatState { projectId?: string; workflowId?: string }
interface SavedState { offset: number; chats: Record<string, ChatState> }

export interface BotDeps {
  config: TelegramConfig;
  telegram: TelegramApi;
  portal: PortalClient;
  /** Where the update offset and each chat's picked project/session are kept (null: memory only). */
  stateFile: string | null;
  /** User who owns TELEGRAM_PORTAL_TOKEN, for the audit log. */
  actorId?: string | null;
  log?: (msg: string) => void;
  /** How often a watched session is checked for a finished turn. */
  watchIntervalMs?: number;
  /** How long a session is watched before giving up. */
  watchMaxMs?: number;
}

export class TelegramBridge {
  private state: SavedState = { offset: 0, chats: {} };
  private lists = new Map<string, { projects?: string[]; sessions?: string[] }>();
  private pendingStop = new Map<string, { projectId: string; workflowId: string; until: number }>();
  private watches = new Map<string, ReturnType<typeof setTimeout>>();
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: BotDeps) {
    this.log = deps.log ?? ((m) => console.log(`[telegram] ${m}`));
    this.load();
  }

  // ── State ──────────────────────────────────────────────────────────────────

  private load(): void {
    if (!this.deps.stateFile) return;
    try {
      const s = JSON.parse(fs.readFileSync(this.deps.stateFile, 'utf8')) as Partial<SavedState>;
      this.state = { offset: Number(s.offset) || 0, chats: s.chats && typeof s.chats === 'object' ? s.chats : {} };
    } catch { /* first start */ }
  }

  private save(): void {
    if (!this.deps.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.deps.stateFile), { recursive: true });
      fs.writeFileSync(this.deps.stateFile, JSON.stringify(this.state), { mode: 0o600 });
    } catch (e) { this.log(`could not save state: ${(e as Error).message}`); }
  }

  private chat(chatId: string): ChatState {
    return (this.state.chats[chatId] ??= {});
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  start(): void {
    if (this.loop) return;
    this.abort = new AbortController();
    this.loop = this.run(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    for (const t of this.watches.values()) clearTimeout(t);
    this.watches.clear();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  private async run(signal: AbortSignal): Promise<void> {
    let backoff = 2_000;
    while (!signal.aborted) {
      try {
        const updates = await this.deps.telegram.getUpdates(this.state.offset, 50, signal);
        backoff = 2_000;
        for (const u of updates) {
          this.state.offset = Math.max(this.state.offset, u.update_id + 1);
          if (u.message) await this.handleMessage(u.message);
        }
        if (updates.length) this.save();
      } catch (e) {
        if (signal.aborted) break;
        this.log(`polling failed, retrying in ${Math.round(backoff / 1000)}s: ${(e as Error).message}`);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  /** Public for tests: handles one incoming Telegram message. */
  async handleMessage(msg: TgMessage): Promise<void> {
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== 'private' || !this.deps.config.allowedChatIds.has(chatId)) {
      this.log(`ignored a message from chat ${chatId} (${msg.chat.type}): not in TELEGRAM_ALLOWED_CHAT_IDS`);
      return;
    }
    if (msg.from?.is_bot) return;
    const text = (msg.text ?? '').trim();
    if (!text) return;

    const { command, args } = parseCommand(text);
    auditRaw(this.deps.actorId ?? null, 'telegram.command', `telegram:${chatId}`, { command: command ?? 'message' });

    let reply: string | null;
    try {
      reply = await this.dispatch(chatId, command, args, text);
    } catch (e) {
      reply = e instanceof PortalError ? `The portal said: ${e.message}` : `Something went wrong: ${(e as Error).message}`;
      if (!(e instanceof PortalError)) this.log(`command failed: ${(e as Error).stack ?? e}`);
    }
    if (reply) await this.send(chatId, reply);
  }

  private async send(chatId: string, text: string): Promise<void> {
    try { await this.deps.telegram.sendMessage(chatId, text); }
    catch (e) { this.log(`could not send a reply: ${(e as Error).message}`); }
  }

  private async dispatch(chatId: string, command: string | null, args: string, text: string): Promise<string | null> {
    // A pending "stop?" is answered by the very next message.
    const pending = this.pendingStop.get(chatId);
    if (pending) {
      this.pendingStop.delete(chatId);
      if (command === null && /^(y|yes)$/i.test(text) && pending.until > Date.now()) {
        await this.deps.portal.cancel(pending.projectId, pending.workflowId);
        return 'Stopped. Send a message to carry on later.';
      }
      if (command === null && /^(n|no|y|yes)$/i.test(text)) return 'Not stopped.';
    }

    switch (command) {
      case 'start':
      case 'help': return HELP;
      case 'projects': return this.cmdProjects(chatId);
      case 'project': return this.cmdProject(chatId, args);
      case 'newproject': return this.cmdNewProject(chatId, args);
      case 'sessions': return this.cmdSessions(chatId);
      case 'session': return this.cmdSession(chatId, args);
      case 'new': return this.cmdNew(chatId, args);
      case 'status': return this.cmdStatus(chatId);
      case 'stop': return this.cmdStop(chatId);
      case 'inbox': return this.cmdInbox();
      case null: return this.cmdMessage(chatId, text);
      // Anything else that starts with "/" goes to the session as a slash command (/model, /cost, /clear …).
      default: return this.cmdMessage(chatId, text);
    }
  }

  private async cmdProjects(chatId: string): Promise<string> {
    const projects = (await this.deps.portal.listProjects()).filter((p) => !p.archived).slice(0, 30);
    if (!projects.length) return 'No projects yet. Create one in the portal first.';
    this.listsFor(chatId).projects = projects.map((p) => p.id);
    const current = this.chat(chatId).projectId;
    return ['Projects:', ...projects.map((p, i) => `${i + 1}. ${p.name}${p.id === current ? '  (picked)' : ''}`), '', 'Pick one with /project <number>'].join('\n');
  }

  private async cmdProject(chatId: string, args: string): Promise<string> {
    if (!args) return 'Which one? Send /projects, then /project <number>.';
    const projects = (await this.deps.portal.listProjects()).filter((p) => !p.archived);
    const listed = this.listsFor(chatId).projects ?? [];
    const n = Number(args);
    const found = Number.isInteger(n) && n >= 1 && listed[n - 1]
      ? projects.find((p) => p.id === listed[n - 1])
      : projects.find((p) => p.id === args || p.name.toLowerCase() === args.toLowerCase());
    if (!found) return 'No project like that. Send /projects to see the list.';
    this.state.chats[chatId] = { projectId: found.id };
    this.save();
    return `Project: ${found.name}\nNow /sessions, or /new <goal> to start one.`;
  }

  private async cmdNewProject(chatId: string, args: string): Promise<string> {
    const name = args.replace(/\s+/g, ' ').trim();
    if (!name) return 'Give it a name: /newproject <name>';
    if (name.length > 120) return 'That name is too long (120 characters at most).';
    const project = await this.deps.portal.createProject(name);
    this.state.chats[chatId] = { projectId: project.id };
    this.listsFor(chatId).sessions = [];
    this.save();
    return `Created the project ${project.name} and picked it.\nStart a session with /new <goal>. Add repositories in the portal when you need them.`;
  }

  private async cmdSessions(chatId: string): Promise<string> {
    const projectId = this.chat(chatId).projectId;
    if (!projectId) return 'Pick a project first: /projects';
    const sessions = await this.deps.portal.listWorkflows(projectId, 10);
    if (!sessions.length) return 'No sessions in this project yet. Start one with /new <goal>.';
    this.listsFor(chatId).sessions = sessions.map((s) => s.id);
    const current = this.chat(chatId).workflowId;
    return [
      'Recent sessions:',
      ...sessions.map((s, i) => `${i + 1}. ${label(s)}  [${s.status}]${s.id === current ? '  (picked)' : ''}`),
      '',
      'Pick one with /session <number>',
    ].join('\n');
  }

  private async cmdSession(chatId: string, args: string): Promise<string> {
    const st = this.chat(chatId);
    if (!st.projectId) return 'Pick a project first: /projects';
    if (!args) return 'Which one? Send /sessions, then /session <number>.';
    const listed = this.listsFor(chatId).sessions ?? [];
    const n = Number(args);
    const id = Number.isInteger(n) && n >= 1 && listed[n - 1] ? listed[n - 1] : args;
    const { workflow } = await this.deps.portal.getWorkflow(st.projectId, id);
    st.workflowId = workflow.id;
    this.save();
    return `Session: ${label(workflow)} [${workflow.status}]\nAnything you type now goes to this session.`;
  }

  private async cmdNew(chatId: string, args: string): Promise<string> {
    const st = this.chat(chatId);
    if (!st.projectId) return 'Pick a project first: /projects';
    let goal = args;
    let engine: BridgeEngine | null = null;
    const first = goal.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    if ((ENGINES as readonly string[]).includes(first)) {
      engine = first as BridgeEngine;
      goal = goal.slice(first.length).trim();
    }
    if (!goal) return 'Say what the session should do: /new <goal>';

    // Engine, model and repositories: as asked, else TELEGRAM_DEFAULT_ENGINE, else like the latest session here.
    const latest = (await this.deps.portal.listWorkflows(st.projectId, 1))[0];
    const body: Record<string, unknown> = { goal };
    body.engine = engine ?? this.deps.config.defaultEngine ?? latest?.engine ?? 'demo';
    if (latest && latest.engine === body.engine) {
      if (latest.model) body.model = latest.model;
      if (latest.repo_ids?.length) body.repoIds = latest.repo_ids;
    }
    const wf = await this.deps.portal.createWorkflow(st.projectId, body);
    await this.deps.portal.start(st.projectId, wf.id);
    st.workflowId = wf.id;
    this.save();
    this.watch(chatId, st.projectId, wf.id);
    return `Started a ${String(body.engine)} session: ${label(wf)}\nI'll send the reply when it finishes.`;
  }

  private async cmdStatus(chatId: string): Promise<string> {
    const st = this.chat(chatId);
    if (!st.projectId || !st.workflowId) return 'Pick a session first: /sessions';
    const { workflow, latestRun } = await this.deps.portal.getWorkflow(st.projectId, st.workflowId);
    const lines = [`${label(workflow)}`, `Status: ${describeStatus(workflow, latestRun?.status)}`];
    const reply = latestRun ? lastReply(await this.deps.portal.transcript(st.projectId, st.workflowId), latestRun.id) : null;
    if (reply) lines.push('', 'Last reply:', reply);
    return lines.join('\n');
  }

  private async cmdStop(chatId: string): Promise<string> {
    const st = this.chat(chatId);
    if (!st.projectId || !st.workflowId) return 'Pick a session first: /sessions';
    const { workflow, latestRun } = await this.deps.portal.getWorkflow(st.projectId, st.workflowId);
    if (!ACTIVE.has(workflow.status) && !ACTIVE.has(latestRun?.status ?? '')) return `${label(workflow)} is not running.`;
    this.pendingStop.set(chatId, { projectId: st.projectId, workflowId: st.workflowId, until: Date.now() + CONFIRM_MS });
    return `Stop "${label(workflow)}"? Reply yes within a minute to stop it.`;
  }

  private async cmdInbox(): Promise<string> {
    const items = await this.deps.portal.inbox();
    if (!items.length) return 'Nothing is waiting for you.';
    const lines = items.slice(0, 15).map((it, i) => {
      const what = String(it.payload?.toolName ?? it.payload?.question ?? it.payload?.title ?? '').slice(0, 80);
      const where = [it.project_name, it.workflow_goal ? it.workflow_goal.slice(0, 50) : null].filter(Boolean).join(' / ');
      return `${i + 1}. ${it.type}${what ? `: ${what}` : ''}${where ? `  (${where})` : ''}`;
    });
    return ['Waiting for you:', ...lines, '', 'Approvals of tool calls and pushes need the portal in a browser.'].join('\n');
  }

  private async cmdMessage(chatId: string, text: string): Promise<string | null> {
    const st = this.chat(chatId);
    if (!st.projectId) return 'Pick a project first: /projects (or /help)';
    if (!st.workflowId) return 'Pick a session with /sessions, or start one with /new <goal>.';
    const r = await this.deps.portal.message(st.projectId, st.workflowId, text);
    if (r.kind === 'command' && r.handled) {
      // The portal answered the slash command itself: show that answer.
      const answer = (await this.deps.portal.transcript(st.projectId, st.workflowId, 10))
        .find((e) => e.kind === 'command-result');
      const body = typeof answer?.payload === 'string' ? answer.payload.split('\n---\n').slice(1).join('\n---\n') : '';
      return body || 'Done.';
    }
    if (!r.resumed) {
      // Same as the chat box: a session that is not paused starts its next turn here (already running is fine).
      try { await this.deps.portal.start(st.projectId, st.workflowId); }
      catch (e) { if (!(e instanceof PortalError && e.status === 409)) throw e; }
    }
    this.watch(chatId, st.projectId, st.workflowId);
    return null; // The reply comes when the turn ends; a "sent" message would only be noise.
  }

  // ── Watching for the end of a turn ─────────────────────────────────────────

  private watch(chatId: string, projectId: string, workflowId: string): void {
    const key = `${chatId}:${workflowId}`;
    const existing = this.watches.get(key);
    if (existing) clearTimeout(existing);
    const interval = this.deps.watchIntervalMs ?? 4_000;
    const deadline = Date.now() + (this.deps.watchMaxMs ?? 60 * 60_000);
    let seenActive = false;
    let checks = 0;

    // The key stays in `watches` while a check is in flight, so idle() and a newer watch see it.
    const finish = (): void => { if (this.watches.get(key) === timer) this.watches.delete(key); };
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (): Promise<void> => {
      if (this.abort?.signal.aborted || this.watches.get(key) !== timer) return;
      try {
        const { workflow, latestRun } = await this.deps.portal.getWorkflow(projectId, workflowId);
        const active = ACTIVE.has(workflow.status) || ACTIVE.has(latestRun?.status ?? '');
        checks++;
        if (active) seenActive = true;
        // A turn that has not shown up as running yet gets a few checks before it counts as finished.
        if (!active && (seenActive || checks >= 3)) {
          const reply = latestRun ? lastReply(await this.deps.portal.transcript(projectId, workflowId), latestRun.id) : null;
          await this.send(chatId, `${label(workflow)}: ${describeStatus(workflow, latestRun?.status)}${reply ? `\n\n${reply}` : ''}`);
          finish();
          return;
        }
        if (Date.now() > deadline) {
          await this.send(chatId, `${label(workflow)} is still working. Send /status to check on it.`);
          finish();
          return;
        }
      } catch (e) {
        this.log(`watching ${workflowId} failed: ${(e as Error).message}`);
        if (Date.now() > deadline) { finish(); return; }
      }
      if (this.watches.get(key) !== timer) return;
      timer = setTimeout(() => { void tick(); }, interval);
      timer.unref?.();
      this.watches.set(key, timer);
    };
    timer = setTimeout(() => { void tick(); }, interval);
    timer.unref?.();
    this.watches.set(key, timer);
  }

  /** For tests: resolves when no session is being watched. */
  async idle(timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (this.watches.size && Date.now() < end) await sleep(20);
  }

  private listsFor(chatId: string): { projects?: string[]; sessions?: string[] } {
    let l = this.lists.get(chatId);
    if (!l) { l = {}; this.lists.set(chatId, l); }
    return l;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function parseCommand(text: string): { command: string | null; args: string } {
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return { command: null, args: '' };
  return { command: m[1].toLowerCase(), args: (m[2] ?? '').trim() };
}

function label(w: PortalWorkflow): string {
  const t = (w.title || w.goal || 'Untitled session').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

function describeStatus(w: PortalWorkflow, runStatus?: string): string {
  if (ACTIVE.has(w.status) || ACTIVE.has(runStatus ?? '')) return 'working';
  if (w.status === 'paused' && w.stop_reason === 'interrupted') return 'stopped';
  if (w.status === 'paused') return 'waiting for your next message';
  if (runStatus === 'failed' || w.status === 'failed') return 'failed';
  return w.status === 'done' ? 'finished' : w.status;
}

/** The agent's answer in a run: its final result, else the newest text it wrote. Events come newest first. */
export function lastReply(events: TranscriptEvent[], runId: string): string | null {
  const inRun = events.filter((e) => e.run_id === runId);
  const payloadOf = (e: TranscriptEvent): Record<string, unknown> =>
    (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
  const complete = inRun.find((e) => e.kind === 'run-complete' && typeof payloadOf(e).result === 'string' && String(payloadOf(e).result).trim());
  const text = complete
    ? String(payloadOf(complete).result)
    : (() => {
        const t = inRun.find((e) => e.kind === 'assistant-text' && String(payloadOf(e).text ?? '').trim());
        return t ? String(payloadOf(t).text) : '';
      })();
  if (!text.trim()) {
    const err = inRun.find((e) => e.kind === 'run-error' || e.kind === 'error');
    const m = err ? String(payloadOf(err).message ?? payloadOf(err).error ?? '') : '';
    return m.trim() ? `Error: ${clipText(m, 1500)}` : null;
  }
  return clipText(text, 3500);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
