/**
 * Kiro CLI provider: runs agents through `kiro-cli acp` (Agent Client Protocol, JSON-RPC 2.0 over stdio)
 * and translates Kiro's session updates into the SdkMessage shapes the runner already understands.
 *
 *  ACP from Kiro                          → portal
 *  session/update agent_message_chunk     → assistant text
 *  session/update tool_call               → assistant tool_use (Kiro tool names mapped to Read / Write / Bash …)
 *  session/update tool_call_update        → user tool_result once completed or failed
 *  session/request_permission             → guard + canUseTool (approvals UI)
 *  _kiro.dev/metadata meteringUsage       → credits on the result message
 *  session/prompt response stopReason     → result
 *
 * Each run gets its own Kiro agent profile in <project>/.kiro/agents/ (git-excluded) with no MCP servers
 * and only read tools pre-approved, so the user's global kiro-cli config cannot silently trust writes.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProviderRunOptions, SdkMessage } from './types.ts';
import { HttpError, badRequest } from '../util.ts';
import { getSettings } from '../settings.ts';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

/* ------------------------------------------------------------------ */
/* Process and JSON-RPC                                                */
/* ------------------------------------------------------------------ */

/** The kiro-cli command line. PORTAL_KIRO_FAKE (tests) swaps in a Node script that speaks ACP. */
export function kiroCommand(extraArgs: string[]): { cmd: string; args: string[] } {
  const fake = process.env.PORTAL_KIRO_FAKE;
  if (fake) return { cmd: process.execPath, args: [fake, 'acp', ...extraArgs] };
  const configured = getSettings().kiro.command.trim();
  return { cmd: configured || 'kiro-cli', args: ['acp', ...extraArgs] };
}

type Handler = (params: any, id?: string | number) => void;

export class AcpConnection {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  private buf = '';
  private stderrTail = '';
  private exited: Promise<number | null>;
  onNotification: Handler = () => {};
  onRequest: (method: string, params: any, id: string | number) => void = (_m, _p, id) => this.respondError(id, -32601, 'Not supported');

  constructor(cwd: string, env: Record<string, string>, extraArgs: string[] = []) {
    const { cmd, args } = kiroCommand(extraArgs);
    this.child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.exited = new Promise((resolve) => {
      this.child.on('error', (e: any) => {
        const msg =
          e?.code === 'ENOENT'
            ? `kiro-cli was not found (${cmd}). Install Kiro CLI on the server, or set its full path in Settings › Model provider › Kiro CLI.`
            : `Could not start kiro-cli: ${e?.message ?? e}`;
        this.failAll(new HttpError(502, msg));
        resolve(null);
      });
      this.child.on('exit', (code) => {
        this.failAll(new HttpError(502, `kiro-cli stopped (exit code ${code}).${this.stderrTail ? ` ${this.stderrTail.trim().slice(-500)}` : ''}`));
        resolve(code);
      });
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d: string) => this.onData(d));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
      if (process.env.PORTAL_DEBUG_SDK) process.stderr.write(`[kiro] ${d}`);
    });
    this.child.stdin.on('error', () => {
      /* the process exited; the exit handler reports it */
    });
  }

  private failAll(e: unknown) {
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
  }

  private onData(d: string) {
    this.buf += d;
    let n: number;
    while ((n = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, n).trim();
      this.buf = this.buf.slice(n + 1);
      if (!line) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.method && m.id !== undefined && m.id !== null) this.onRequest(m.method, m.params ?? {}, m.id);
      else if (m.method) this.onNotification({ method: m.method, params: m.params ?? {} });
      else if (typeof m.id === 'number' && this.waiting.has(m.id)) {
        const w = this.waiting.get(m.id)!;
        this.waiting.delete(m.id);
        if (m.error) w.reject(new HttpError(502, `Kiro: ${m.error.message ?? 'request failed'}${m.error.data ? ` (${JSON.stringify(m.error.data).slice(0, 300)})` : ''}`));
        else w.resolve(m.result ?? {});
      }
    }
  }

  private write(obj: unknown) {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.waiting.delete(id);
          reject(new HttpError(504, `kiro-cli did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
      }
      this.waiting.set(id, {
        resolve: (v) => (timer && clearTimeout(timer), resolve(v)),
        reject: (e) => (timer && clearTimeout(timer), reject(e)),
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  respond(id: string | number, result: unknown) {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: string | number, code: number, message: string) {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Stop the process; waits briefly for a clean exit, then kills it. */
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return;
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    const t = setTimeout(() => this.child.kill(), 500);
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 3000))]);
    clearTimeout(t);
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }
}

async function initialize(conn: AcpConnection): Promise<any> {
  return conn.request(
    'initialize',
    {
      protocolVersion: 1,
      // The portal does not serve files or terminals: Kiro uses its own built-in tools.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-portal', version: '0.1.0' },
    },
    60_000,
  );
}

/* ------------------------------------------------------------------ */
/* Agent profile                                                       */
/* ------------------------------------------------------------------ */

/** Write a per-run Kiro agent profile into <project>/.kiro/agents and keep it out of git. */
export function writeAgentProfile(projectDir: string, prompt: string, toolsEnabled: boolean): { name: string; file: string } {
  const name = `agent-portal-${randomBytes(4).toString('hex')}`;
  const dir = path.join(projectDir, '.kiro', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const profile = {
    name,
    description: 'Agent Portal run (generated; deleted when the run ends)',
    prompt,
    tools: toolsEnabled ? ['read', 'write', 'shell', 'grep', 'glob'] : [],
    // CLI 2.x: tools that run without asking. Writes and commands always ask, so the portal can check them.
    allowedTools: toolsEnabled ? ['read', 'grep', 'glob'] : [],
    // CLI V3 equivalent of allowedTools.
    permissions: { rules: toolsEnabled ? [{ capability: 'fs_read', match: ['**'], effect: 'allow' }] : [] },
    mcpServers: {},
    // No MCP servers from the user's mcp.json. (CLI 2.x treats useLegacyMcpJson as an alias: never set both.)
    includeMcpJson: false,
    resources: toolsEnabled && fs.existsSync(path.join(projectDir, 'CLAUDE.md')) ? ['file://CLAUDE.md'] : [],
  };
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(profile, null, 2));
  excludeFromGit(projectDir);
  return { name, file };
}

function excludeFromGit(projectDir: string) {
  const exclude = path.join(projectDir, '.git', 'info', 'exclude');
  try {
    if (!fs.existsSync(path.dirname(exclude))) return;
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!cur.includes('.kiro/agents/agent-portal-')) fs.appendFileSync(exclude, `${cur.endsWith('\n') || !cur ? '' : '\n'}.kiro/agents/agent-portal-*\n`);
  } catch {
    /* not a git repository; nothing to exclude */
  }
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

export interface KiroModel {
  modelId: string;
  name?: string;
  description?: string;
}

const ALIASES = new Set(['sonnet', 'haiku', 'opus']);

/** Turn the portal's alias (sonnet / haiku / opus) or an exact ID into a Kiro model ID, or null for Kiro's default. */
export function resolveKiroModel(requested: string, available: KiroModel[]): string | null {
  const ids = available.map((m) => m.modelId);
  const s = getSettings().kiro;
  if (ALIASES.has(requested)) {
    const pinned = s.models[requested as 'sonnet' | 'haiku' | 'opus'];
    if (pinned) {
      if (ids.length && !ids.includes(pinned)) throw badRequest(`Kiro does not offer the model "${pinned}" set for ${requested}. Available: ${ids.join(', ')}`);
      return pinned;
    }
    // Kiro lists the newest models first.
    return ids.find((id) => id.toLowerCase().includes(requested)) ?? null;
  }
  if (ids.length && !ids.includes(requested)) throw badRequest(`Kiro does not offer the model "${requested}". Available: ${ids.join(', ')}`);
  return requested;
}

/** List the models the signed-in Kiro account offers (one short ACP session, no prompt, no credits). */
export async function kiroModels(env: Record<string, string>, cwd: string): Promise<KiroModel[]> {
  fs.mkdirSync(cwd, { recursive: true });
  const { name, file } = writeAgentProfile(cwd, 'List models only.', false);
  const conn = new AcpConnection(cwd, env, ['--agent', name]);
  try {
    await initialize(conn);
    const s = await conn.request('session/new', { cwd, mcpServers: [] }, 90_000);
    return (s.models?.availableModels ?? []) as KiroModel[];
  } finally {
    await conn.close();
    fs.rmSync(file, { force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Tool name and input mapping                                         */
/* ------------------------------------------------------------------ */

function firstPath(raw: any, locations: any[] | undefined): string {
  return String(raw?.path ?? raw?.file_path ?? raw?.operations?.[0]?.path ?? locations?.[0]?.path ?? '');
}

/** Map a Kiro tool call to the portal's (Claude Code) tool vocabulary, keeping Kiro's raw input alongside. */
export function mapTool(kiroName: string, kind: string | undefined, raw: any, locations?: any[]): { name: string; input: Record<string, unknown> } {
  const n = (kiroName || '').toLowerCase();
  const input: Record<string, unknown> = raw && typeof raw === 'object' ? { ...raw } : {};
  if (n === 'read' || n === 'fs_read' || (!n && kind === 'read')) {
    return { name: 'Read', input: { ...input, file_path: firstPath(raw, locations) } };
  }
  if (n === 'write' || n === 'fs_write' || (!n && kind === 'edit')) {
    const cmd = String(raw?.command ?? '');
    return { name: cmd === 'create' ? 'Write' : 'Edit', input: { ...input, file_path: firstPath(raw, locations) } };
  }
  if (n === 'shell' || n === 'execute_bash' || n === 'execute_pwsh' || n === 'execute_cmd' || (!n && kind === 'execute')) {
    return { name: 'Bash', input: { ...input, command: String(raw?.command ?? '') } };
  }
  if (n === 'grep') return { name: 'Grep', input };
  if (n === 'glob') return { name: 'Glob', input };
  if (n === 'web_fetch') return { name: 'WebFetch', input };
  if (n === 'web_search') return { name: 'WebSearch', input };
  return { name: kiroName || kind || 'tool', input };
}

function outputText(update: any): string {
  const items = update?.rawOutput?.items;
  if (Array.isArray(items)) {
    return items
      .map((i: any) => (typeof i?.Text === 'string' ? i.Text : typeof i?.text === 'string' ? i.text : i?.Json !== undefined ? JSON.stringify(i.Json) : JSON.stringify(i)))
      .join('\n');
  }
  if (Array.isArray(update?.content)) {
    return update.content
      .map((c: any) => (c?.content?.text ?? c?.text ?? (c?.type === 'diff' ? `${c.path}: updated` : '')))
      .filter(Boolean)
      .join('\n');
  }
  if (update?.rawOutput !== undefined) return typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput);
  return '';
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

class Queue<T> {
  private items: T[] = [];
  private waiters: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(v: T) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true });
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const r = await new Promise<IteratorResult<T>>((res) => this.waiters.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

export async function* kiroRun(opts: ProviderRunOptions): AsyncIterable<SdkMessage> {
  const toolsEnabled = !(Array.isArray(opts.tools) && opts.tools.length === 0);
  const prompt = opts.systemPrompt ?? opts.systemAppend ?? '';
  const profile = writeAgentProfile(opts.cwd, prompt, toolsEnabled);
  const conn = new AcpConnection(opts.cwd, opts.env, ['--agent', profile.name]);
  const out = new Queue<SdkMessage>();
  const signal = opts.abort.signal;

  let sessionId = '';
  let loading = false; // session/load replays history as updates; ignore them
  let msgSeq = 0;
  let text = '';
  let finalText = '';
  let allText = '';
  let credits = 0;
  let model = '';
  const tools = new Map<string, { name: string; kiroName: string; kind?: string; raw: any; locations?: any[]; done: boolean }>();

  const assistant = (content: any[]): SdkMessage => ({
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { id: `kiro_${sessionId}_${++msgSeq}`, role: 'assistant', model, content },
  });
  const flushText = () => {
    if (!text) return;
    out.push(assistant([{ type: 'text', text }]));
    finalText = text;
    text = '';
  };

  conn.onNotification = ({ method, params }) => {
    if (loading) return;
    if (method === 'session/update' || method === 'session/notification') {
      const u = params.update ?? {};
      const kind = u.sessionUpdate;
      if (kind === 'agent_message_chunk' && u.content?.type === 'text') {
        text += u.content.text;
        allText += u.content.text;
      } else if (kind === 'tool_call') {
        flushText();
        finalText = '';
        const kiroName = u._meta?.kiro?.toolName ?? u.title ?? '';
        const t = mapTool(kiroName, u.kind, u.rawInput, u.locations);
        tools.set(u.toolCallId, { name: t.name, kiroName, kind: u.kind, raw: u.rawInput, locations: u.locations, done: false });
        out.push(assistant([{ type: 'tool_use', id: u.toolCallId, name: t.name, input: { ...t.input, title: u.title } }]));
      } else if (kind === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) {
        const t = tools.get(u.toolCallId);
        if (t && !t.done) {
          t.done = true;
          out.push({
            type: 'user',
            session_id: sessionId,
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: u.toolCallId, content: outputText(u), is_error: u.status === 'failed' }] },
          });
        }
      }
    } else if (method === '_kiro.dev/metadata' && Array.isArray(params.meteringUsage)) {
      for (const m of params.meteringUsage) if (typeof m?.value === 'number') credits += m.value;
    } else if (method === '_kiro.dev/subagent/list_update' && Array.isArray(params.subagents) && params.subagents.length) {
      out.push({ type: 'system', subtype: 'kiro_subagents', session_id: sessionId, ...params });
    }
  };

  conn.onRequest = (method, params, id) => {
    if (method !== 'session/request_permission') {
      conn.respondError(id, -32601, `${method} is not supported by Agent Portal`);
      return;
    }
    const options: any[] = params.options ?? [];
    const pick = (kinds: string[]) => options.find((o) => kinds.includes(o.kind))?.optionId ?? options.find((o) => kinds.some((k) => String(o.optionId).startsWith(k.split('_')[0])))?.optionId;
    const allow = () => conn.respond(id, { outcome: { outcome: 'selected', optionId: pick(['allow_once']) ?? 'allow_once' } });
    const reject = () => conn.respond(id, { outcome: { outcome: 'selected', optionId: pick(['reject_once']) ?? 'reject_once' } });
    const tc = params.toolCall ?? {};
    // Kiro announces the call (tool_call) before asking; the request itself carries only id, title and input.
    const known = tools.get(tc.toolCallId);
    const { name, input } = mapTool(
      tc._meta?.kiro?.toolName ?? known?.kiroName ?? '',
      tc.kind ?? known?.kind,
      tc.rawInput ?? known?.raw,
      tc.locations ?? known?.locations,
    );

    void (async () => {
      try {
        if (!toolsEnabled) return reject();
        const blocked = opts.guard?.(name, input);
        if (blocked) {
          out.push({ type: 'system', subtype: 'portal_blocked', session_id: sessionId, tool_use_id: tc.toolCallId, tool_name: name, reason: blocked });
          return reject();
        }
        if ((opts.allowedTools ?? []).includes(name)) return allow();
        if (opts.permissionMode === 'plan' && !READ_TOOLS.has(name)) return reject();
        if (opts.permissionMode === 'acceptEdits' && WRITE_TOOLS.has(name)) return allow();
        const r = await opts.canUseTool(name, input, { signal, toolUseID: tc.toolCallId });
        return r.behavior === 'allow' ? allow() : reject();
      } catch {
        conn.respond(id, { outcome: { outcome: 'cancelled' } });
      }
    })();
  };

  const onAbort = () => {
    if (sessionId) conn.notify('session/cancel', { sessionId });
    setTimeout(() => void conn.close(), 2000);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  // Drive the session in the background; the generator yields from the queue.
  const driver = (async () => {
    try {
      await initialize(conn);
      let s: any;
      if (opts.resume) {
        loading = true;
        s = await conn.request('session/load', { sessionId: opts.resume, cwd: opts.cwd, mcpServers: [] }, 120_000);
        loading = false;
        sessionId = opts.resume;
      } else {
        s = await conn.request('session/new', { cwd: opts.cwd, mcpServers: [] }, 120_000);
        sessionId = s.sessionId;
      }
      const mode = s?.modes?.currentModeId;
      if (mode && mode !== profile.name) {
        throw new HttpError(502, `kiro-cli did not load the Agent Portal agent profile (it used "${mode}"). Update Kiro CLI and try again.`);
      }
      const available: KiroModel[] = s?.models?.availableModels ?? [];
      const wanted = resolveKiroModel(opts.model, available);
      model = wanted ?? s?.models?.currentModelId ?? 'kiro';
      if (wanted && wanted !== s?.models?.currentModelId) {
        await conn.request('session/set_model', { sessionId, modelId: wanted }, 30_000);
      }
      out.push({ type: 'system', subtype: 'init', session_id: sessionId, model, tools: toolsEnabled ? ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] : [], provider: 'kiro' });

      const started = Date.now();
      const res = await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: opts.prompt }] });
      flushText();
      const stop = res?.stopReason ?? 'end_turn';
      if (stop === 'cancelled' || signal.aborted) return;
      const ok = stop === 'end_turn';
      out.push({
        type: 'result',
        subtype: ok ? 'success' : stop === 'max_turn_requests' || stop === 'max_tokens' ? 'error_max_turns' : 'error_during_execution',
        is_error: !ok,
        session_id: sessionId,
        result: ok ? (finalText || allText).trim() : `Kiro stopped: ${stop}`,
        total_cost_usd: 0,
        kiro_credits: Number(credits.toFixed(4)),
        usage: {},
        num_turns: 1 + tools.size,
        duration_ms: Date.now() - started,
      });
    } catch (e: any) {
      if (signal.aborted) return;
      flushText();
      out.push({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: sessionId,
        result: String(e?.message ?? e).slice(0, 1000),
        total_cost_usd: 0,
        kiro_credits: Number(credits.toFixed(4)),
        usage: {},
      });
    } finally {
      out.close();
    }
  })();

  try {
    for await (const m of out) yield m;
    await driver;
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Shut kiro-cli down in the background so the run is released as soon as its result is recorded.
    void conn.close().finally(() => fs.rmSync(profile.file, { force: true }));
  }
}
