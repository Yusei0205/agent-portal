/**
 * kiro-run mode — run kiro-cli via ACP (Agent Client Protocol) with an IdC token.
 *
 * The portal uses `kiro-cli acp` (JSON-RPC 2.0 over stdio) for production runs.
 * `kiro-cli chat --no-interactive` does NOT work for IdC auth because it triggers
 * a browser-based login flow even when a valid KIRO_TEST_DB_PATH token is present.
 * ACP honours KIRO_TEST_DB_PATH and uses the token directly.
 *
 * ACP protocol (same as server/agent/kiro.ts runKiroAcp):
 *   initialize → session/new → session/prompt → session/update notifications → exit
 *
 * Safety invariants:
 *   - Token fields (accessToken, refreshToken, clientSecret) never appear in logs.
 *   - Temp DB and temp dirs are deleted at the end regardless of outcome.
 *   - Every tool call kiro-cli asks about passes the portal's guard (shared/agent/guard.ts):
 *     tool settings, MCP lists, Kiro config and git hooks/config are never changed.
 *   - Untrusted runs ask a person through the portal (shared/agent/agentcore-approvals.ts),
 *     the same rule as the portal's local Kiro engine. Without a way to ask, they decline.
 *   - Secret-looking variables are removed from kiro-cli's environment (shared/agent/env-scrub.ts).
 *   - A cancel from the portal (or the portal hanging up) stops kiro-cli.
 */

import { emitRunnerFiles, writeInputFiles } from '../shared/runner-files.js';
import { runCheckSteps } from '../shared/runner-checks.js';
import { parseRunnerRepos, cloneRunnerRepos, usablePersistRoot, PERSIST_ROOT } from '../shared/runner-repos.js';
import { parseSnapshot, restoreWorkspace, moveSnapshotMarks } from '../shared/runner-snapshot.js';
import { reportRepoChanges } from '../shared/runner-finalize-run.js';
import { parseMcpServers } from '../shared/runner-mcp.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { KiroRunPayload } from './validate.js';
import { guardToolCall } from '../shared/agent/guard.ts';
import { scrubEnvForShell } from '../shared/agent/env-scrub.ts';
import { inputFingerprint } from '../shared/agent/tool-policy.ts';
import type { ApprovalBroker } from '../shared/agent/agentcore-approvals.ts';

export type EmitFn = (event: Record<string, unknown>) => void;

// ── Constants ─────────────────────────────────────────────────────────────────

const KIRO_TEST_DB_ENV = 'KIRO_TEST_DB_PATH';
const AUTH_KV_TOKEN_KEY = 'kirocli:odic:token';
const AUTH_KV_DEVICE_REG_KEY = 'kirocli:odic:device-registration';
const KIRO_IDC_SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
];

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    migration_time INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY, command TEXT, shell TEXT, pid INTEGER,
    session_id TEXT, cwd TEXT, start_time INTEGER, hostname TEXT,
    exit_code INTEGER, end_time INTEGER, duration INTEGER
  );
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value BLOB);
  CREATE TABLE IF NOT EXISTS conversations (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS conversations_v2 (
    key TEXT NOT NULL, conversation_id TEXT NOT NULL,
    value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS extracted_kas_versions (version TEXT PRIMARY KEY, last_used_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS pinned_bin_versions (version TEXT PRIMARY KEY, last_used_at INTEGER NOT NULL);
`;

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function materialiseKiroAuthDb(opts: {
  accessToken: string;
  expiresAt: string;
  region: string;
  startUrl: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  clientSecretExpiresAt?: number;
  profileArn?: string;
  profileName?: string;
}): Promise<{ dbPath: string; tmpDir: string }> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kiro-runner-auth-'));
  const dbPath = path.join(tmpDir, 'data.sqlite3');
  const db = new DatabaseSync(dbPath, { open: true });
  try {
    db.exec(SCHEMA_SQL);
    const nowSec = Math.floor(Date.now() / 1000);
    const insertMig = db.prepare('INSERT OR IGNORE INTO migrations (version, migration_time) VALUES (?, ?)');
    for (let v = 0; v <= 10; v++) insertMig.run(v, nowSec);

    const tokenPayload: Record<string, unknown> = {
      access_token: opts.accessToken,
      expires_at: opts.expiresAt,
      region: opts.region,
      start_url: opts.startUrl,
      oauth_flow: 'DeviceCode',
      scopes: [...KIRO_IDC_SCOPES],
    };
    if (opts.refreshToken) tokenPayload.refresh_token = opts.refreshToken;
    db.prepare('INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)')
      .run(AUTH_KV_TOKEN_KEY, JSON.stringify(tokenPayload));

    if (opts.clientId && opts.clientSecret) {
      const regPayload: Record<string, unknown> = {
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        client_secret_expires_at: opts.clientSecretExpiresAt ?? 0,
        region: opts.region,
        oauth_flow: 'DeviceCode',
        scopes: [...KIRO_IDC_SCOPES],
      };
      db.prepare('INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)')
        .run(AUTH_KV_DEVICE_REG_KEY, JSON.stringify(regPayload));
    }

    const insertState = db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)');
    insertState.run('auth.idc.start-url', JSON.stringify(opts.startUrl));
    insertState.run('auth.idc.region', JSON.stringify(opts.region));
    if (opts.profileArn) {
      insertState.run(
        'api.codewhisperer.profile',
        JSON.stringify({ arn: opts.profileArn, profile_name: opts.profileName ?? '', device_code_disabled: false }),
      );
    }
  } finally {
    db.close();
  }
  return { dbPath, tmpDir };
}

interface TokenPayload {
  access_token: string;
  expires_at: string;
  refresh_token?: string;
}

function readTokenFromDb(dbPath: string): TokenPayload | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { open: true });
    const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?')
      .get(AUTH_KV_TOKEN_KEY) as { value: string } | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    const accessToken = String(parsed.access_token ?? '');
    if (!accessToken) return null;
    return {
      access_token: accessToken,
      expires_at: String(parsed.expires_at ?? ''),
      ...(parsed.refresh_token ? { refresh_token: String(parsed.refresh_token) } : {}),
    };
  } catch { return null; }
  finally { try { db?.close(); } catch { /* ok */ } }
}

// ── ACP JSON-RPC client ───────────────────────────────────────────────────────

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string };

interface AcpClient {
  sendRequest(method: string, params?: unknown): Promise<unknown>;
  sendNotification(method: string, params?: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): void;
  onServerRequest(handler: (method: string, params: unknown, id: number) => Promise<unknown>): void;
  close(): void;
}

function createAcpClient(child: ReturnType<typeof spawn>): AcpClient {
  let nextId = 1;
  let lineBuf = '';
  const pending = new Map<number, Pending>();
  const notifHandlers: Array<(method: string, params: unknown) => void> = [];
  let reqHandler: ((method: string, params: unknown, id: number) => Promise<unknown>) | null = null;

  function writeLine(obj: unknown): void {
    try { child.stdin?.write(JSON.stringify(obj) + '\n'); } catch { /* stdin closed */ }
  }

  function handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }

    if ('id' in msg && 'method' in msg) {
      const id = msg.id as number;
      if (reqHandler) {
        reqHandler(String(msg.method), msg.params, id).then(
          (result) => writeLine({ jsonrpc: '2.0', id, result }),
          (err: unknown) => writeLine({ jsonrpc: '2.0', id, error: { code: -32000, message: String((err as Error)?.message ?? err) } }),
        );
      } else {
        writeLine({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      }
    } else if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const id = msg.id as number;
      const p = pending.get(id);
      if (p) {
        pending.delete(id);
        if (msg.error) {
          const e = msg.error as { code: number; message: string; data?: unknown };
          // The reason is often an object (which parameter was wrong); show it as text.
          const detail = e.data === undefined ? '' : ` (${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)})`;
          p.reject(new Error(`ACP error ${e.code}: ${e.message}${detail} [${p.method}]`));
        } else {
          p.resolve(msg.result);
        }
      }
    } else if ('method' in msg) {
      for (const h of notifHandlers) {
        try { h(String(msg.method), msg.params); } catch { /* ignore */ }
      }
    }
  }

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    lineBuf += chunk;
    let nl: number;
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      handleLine(lineBuf.slice(0, nl).trimEnd());
      lineBuf = lineBuf.slice(nl + 1);
    }
  });

  child.on('close', () => {
    for (const p of pending.values()) p.reject(new Error('kiro-cli process exited'));
    pending.clear();
  });

  return {
    sendRequest(method, params) {
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        writeLine({ jsonrpc: '2.0', id, method, params });
      });
    },
    sendNotification(method, params) {
      writeLine(params !== undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', method });
    },
    onNotification(handler) { notifHandlers.push(handler); },
    onServerRequest(handler) { reqHandler = handler; },
    close() { try { child.stdin?.end(); } catch { /* ok */ } },
  };
}

// ── ACP session/update → SSE events ──────────────────────────────────────────

interface SessionUpdatePayload {
  sessionUpdate: string;
  content?: unknown;
  title?: string;
  name?: string;
  cost?: { amount: number; currency: string };
}

function extractText(content: unknown): string {
  if (!content) return '';
  const list = Array.isArray(content) ? content : [content];
  return list.flatMap((c: unknown) => {
    if (typeof c !== 'object' || !c) return [];
    const item = c as Record<string, unknown>;
    const inner = (item.type === 'content' && item.content) ? (item.content as Record<string, unknown>) : item;
    return inner.type === 'text' ? [String(inner.text ?? '')] : [];
  }).join('');
}

// ── Warm kiro-cli (one per machine) ───────────────────────────────────────────
//
// An AgentCore machine serves one portal session, and the portal sends every chat message to it as its own run.
// Starting kiro-cli, signing in, creating an ACP session and putting the repositories in place for each message
// is slow and gives the agent no memory of the earlier messages. So after a run that went well the kiro-cli process
// and its ACP session are kept, and the next message is simply another `session/prompt` on it.
// A fresh start happens when the machine is new (idle for 5 minutes), the repositories or integrations changed,
// the browser is on (its tools are started with the session), or the last run failed or timed out.

/** How tool permissions are decided for the message being worked on. */
interface PermContext {
  trusted: boolean;
  broker?: ApprovalBroker;
  approvals?: { via: 'portal'; expiryMinutes: number };
  runId: string;
  abort: AbortSignal;
  workDir: string;
}

interface WarmKiro {
  child: ReturnType<typeof spawn>;
  acp: AcpClient;
  acpSessionId: string;
  workDir: string;
  kiroHome: string;
  authTmpDir: string;
  defaultDbPath: string;
  fingerprint: string;
  model?: string;
  expiresAtBefore: unknown;
  exited: boolean;
  exitCode: number | null;
  /** Folder browser-mcp drops live-view frames in (browser sessions only); lives as long as kiro-cli. */
  liveDir: string | null;
  startedAt: number;
  /** The cloud browser session kiro-cli opened, announced again to the portal on each later message. */
  browserSession: Record<string, unknown> | null;
  /** Where the events of the message being worked on go; replaced at the start of each message. */
  emit: EmitFn;
  /** What the permission handler needs to know about the message being worked on; replaced at the start of each message. */
  perm: PermContext | null;
  stderr: { tail: string };
}

let warm: WarmKiro | null = null;

function waitForExit(w: WarmKiro, ms: number): Promise<number | null> {
  if (w.exited) return Promise.resolve(w.exitCode);
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { w.child.kill('SIGKILL'); } catch { /* ok */ } }, ms);
    w.child.once('close', (code) => { clearTimeout(t); resolve(code); });
  });
}

/** Moves repos/ prepared in the persistent folder into the work folder (same disk, so a rename). */
function adoptPersistedRepos(workDir: string): void {
  const persist = usablePersistRoot(PERSIST_ROOT);
  if (!persist) return;
  const from = path.join(persist, 'repos');
  const to = path.join(workDir, 'repos');
  try {
    if (fs.existsSync(from) && !fs.lstatSync(from).isSymbolicLink() && !fs.existsSync(to)) {
      fs.renameSync(from, to);
      moveSnapshotMarks(persist, workDir);
    }
  } catch { /* the repositories are cloned again */ }
}

/** Puts repos/ back in the persistent folder so it outlives the work folder (and can be saved). */
function stashRepos(workDir: string): void {
  const persist = usablePersistRoot(PERSIST_ROOT);
  if (!persist) return;
  const from = path.join(workDir, 'repos');
  const to = path.join(persist, 'repos');
  try {
    if (fs.existsSync(from) && !fs.lstatSync(from).isSymbolicLink() && !fs.existsSync(to)) {
      fs.renameSync(from, to);
      moveSnapshotMarks(workDir, persist);
    }
  } catch { /* lost with the work folder; the saved copy or a clone brings it back */ }
}

/** Where the live workspace is right now: the warm session's work folder while it holds repos/, else null. */
export function kiroWorkspaceRoot(): string | null {
  try { return warm && fs.existsSync(path.join(warm.workDir, 'repos')) ? warm.workDir : null; } catch { return null; }
}

async function disposeKiro(w: WarmKiro): Promise<void> {
  if (warm === w) warm = null;
  try { w.acp.close(); } catch { /* ok */ }
  await waitForExit(w, 5_000);
  stashRepos(w.workDir);
  for (const dir of [w.authTmpDir, w.workDir, w.kiroHome, ...(w.liveDir ? [w.liveDir] : [])]) {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* non-fatal */ });
  }
}

// ── Permission requests ───────────────────────────────────────────────────────

/** kiro-cli sends rawInput as an object or as JSON text. */
function parseRawInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* not JSON */ }
    return { command: raw };
  }
  return {};
}

// ── Run entry point ───────────────────────────────────────────────────────────

/** Errors from kiro's service that pass on their own. A request the model refused or a bad input is not one of them. */
function isTransientKiroError(message: string): boolean {
  return /dispatch failure|error in the response stream|unknown error occurred|throttl|too many requests|service unavailable|temporar|timed? ?out|ECONNRESET|socket hang up|overloaded|-32603/i.test(message)
    && !/context (window|length)|content filter|not authori[sz]ed|invalid (token|credential)|expired/i.test(message);
}

export async function runKiroRun(
  payload: KiroRunPayload,
  emit: EmitFn,
  processStartMs: number,
  broker?: ApprovalBroker,
  stop?: AbortSignal,
): Promise<void> {
  const coldStartMs = Date.now() - processStartMs;
  const invokeStart = Date.now();
  const { token, prompt, runId } = payload;

  // Only what identifies the setup: credentials and tokens inside these change from message to message.
  const pick = (list: unknown[] | undefined, keys: string[]) => (list ?? []).map((x) => keys.map((k) => String((x as Record<string, unknown>)?.[k] ?? '')));
  const fingerprint = JSON.stringify({ repos: pick(payload.repos, ['name', 'url', 'branch']), mcp: pick(payload.mcpServers, ['name', 'url']), browser: Boolean(payload.browser), aws: payload.awsEnv?.AWS_ACCESS_KEY_ID ?? '', model: payload.model ?? '' });
  // A cloud browser session lasts 15 minutes, so a browser session's kiro-cli is restarted after 12.
  const browserExpired = Boolean(payload.browser) && warm !== null && Date.now() - warm.startedAt > 12 * 60_000;
  if (warm && (browserExpired || warm.exited || warm.fingerprint !== fingerprint)) await disposeKiro(warm);

  let w: WarmKiro | null = warm;
  const continuing = w !== null;
  let keep = false;
  let authTmpDir: string | undefined;
  let workDir: string | undefined;
  let kiroHome: string | undefined;

  try {
    if (!w) {
      const authResult = await materialiseKiroAuthDb(token);
      authTmpDir = authResult.tmpDir;
      const dbPath = authResult.dbPath;

      workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `kiro-work-${runId}-`));
      kiroHome = await fsp.mkdtemp(path.join(os.tmpdir(), `kiro-home-${runId}-`));
      if (payload.inputFiles?.length) {
        const n = writeInputFiles(workDir, payload.inputFiles);
        emit({ type: 'status', text: `${n} input file${n === 1 ? '' : 's'} placed in the work folder` });
      }

      // The session's repositories, under repos/ in the agent's work folder
      if (payload.repos?.length) {
        const parsed = parseRunnerRepos(payload.repos);
        // kiro-cli 3 refuses any path that reaches outside its work folder through a symlink (rule kiro-scope:workspace-escape),
        // so repos/ is a real folder inside the work folder here, not a link to the persistent folder.
        // Repositories prepared earlier on this machine are moved in; they move back when the session is released.
        if (parsed.ok) {
          adoptPersistedRepos(workDir);
          await restoreWorkspace(parseSnapshot(payload.snapshot), workDir, (ev) => emit(ev));
          await cloneRunnerRepos(parsed.repos, workDir, (ev) => emit(ev), { homeDir: kiroHome });
        }
        else emit({ type: 'status', text: `Repositories were not cloned: ${parsed.error}` });
      }

      // Place the DB at the default location for kiro-cli-chat.
      // kiro-cli-chat (the ACP backend) reads from $HOME/.local/share/kiro-cli/data.sqlite3
      // and does NOT honour KIRO_TEST_DB_PATH. We use kiroHome as HOME so kiro-cli-chat
      // finds the token without touching the portal machine's real kiro-cli session.
      const kiroDataDir = path.join(kiroHome, '.local', 'share', 'kiro-cli');
      await fsp.mkdir(kiroDataDir, { recursive: true });
      const defaultDbPath = path.join(kiroDataDir, 'data.sqlite3');
      await fsp.copyFile(dbPath, defaultDbPath);

      const liveDir = payload.browser ? await fsp.mkdtemp(path.join(os.tmpdir(), 'browser-live-')) : null;

      emit({ type: 'status', text: 'kiro-cli ACP starting…' });

      // Build child env — set HOME to isolated temp dir; DO NOT set KIRO_TEST_DB_PATH
      // (kiro-cli-chat ignores it; we use the real default path instead)
      // Secret-looking variables (*_KEY, *_TOKEN, *_SECRET, model and portal keys) never reach kiro-cli.
      const childEnv: Record<string, string> = Object.fromEntries(
        Object.entries(scrubEnvForShell(process.env as Record<string, string | undefined>) as Record<string, string | undefined>)
          .filter(([k, v]) => v !== undefined
            && k !== 'KIRO_CLI_SKIP_SETUP'
            && k !== 'KIRO_CLI_NO_MODIFY_PATH'
            && k !== KIRO_TEST_DB_ENV)
          .map(([k, v]) => [k, v as string]),
      );
      childEnv.HOME = kiroHome;
      childEnv.USERPROFILE = kiroHome;
      // XDG_DATA_HOME must point into kiroHome so kiro-cli-chat finds the DB
      childEnv.XDG_DATA_HOME = path.join(kiroHome, '.local', 'share');
      // The project's AWS account for the agent's shell. The machine's own role credentials are taken out so the
      // agent can only act as the account it was given.
      if (payload.awsEnv) {
        for (const k of ['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_PROFILE', 'AWS_SESSION_TOKEN']) delete childEnv[k];
        Object.assign(childEnv, payload.awsEnv);
      }

      // kiro-cli 3 refuses session/set_model ("no persistence classification"), so the model is given at start. A
      // different model later starts a new kiro-cli (the model is part of the fingerprint above).
      const child = spawn('kiro-cli', payload.model ? ['acp', '--model', payload.model] : ['acp'], {
        cwd: workDir,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const acp = createAcpClient(child);
      const made: WarmKiro = {
        child, acp, acpSessionId: '', workDir, kiroHome, authTmpDir, defaultDbPath, fingerprint,
        model: payload.model, expiresAtBefore: token.expiresAt, exited: false, exitCode: null, liveDir, startedAt: Date.now(), browserSession: null, emit, perm: null, stderr: { tail: '' },
      };
      w = made;

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        made.stderr.tail = (made.stderr.tail + chunk).slice(-4_000);
      });
      child.on('close', (code) => { made.exited = true; made.exitCode = code; });
      child.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') made.emit({ type: 'error', message: 'kiro-cli not found. Check container image.' });
        else made.emit({ type: 'error', message: `kiro-cli spawn error: ${e.message}` });
      });

      // How full the model's context window is. Kiro reports it as a percentage in its own notifications
      // (`contextUsagePercentage`), or as used/size in the standard `usage_update`. Each notification method is
      // logged once by name so a change in what Kiro sends can be seen in the logs.
      const seenMethods = new Set<string>();
      let lastPercent = -1;
      const reportContext = (percent: unknown): void => {
        const n = Number(percent);
        if (!Number.isFinite(n) || n < 0) return;
        const rounded = Math.min(100, Math.round(n));
        if (rounded === lastPercent) return;
        lastPercent = rounded;
        made.emit({ type: 'context', percent: rounded });
      };
      const findPercent = (v: unknown, depth = 0): unknown => {
        if (!v || typeof v !== 'object' || depth > 3) return undefined;
        const o = v as Record<string, unknown>;
        if (o.contextUsagePercentage !== undefined) return o.contextUsagePercentage;
        for (const x of Object.values(o)) {
          const r = findPercent(x, depth + 1);
          if (r !== undefined) return r;
        }
        return undefined;
      };
      acp.onNotification((method, params) => {
        if (!seenMethods.has(method)) {
          seenMethods.add(method);
          process.stdout.write(JSON.stringify({ event: 'acp_notification', method }) + '\n');
        }
        if (method !== 'session/update') {
          reportContext(findPercent(params));
          return;
        }
        {
          const u = (params as { update?: { sessionUpdate?: string; used?: unknown; size?: unknown; cost?: { amount?: unknown } } })?.update;
          if (u?.sessionUpdate === 'usage_update' && Number(u.size) > 0 && Number.isFinite(Number(u.used))) {
            reportContext((Number(u.used) / Number(u.size)) * 100);
          }
          // Kiro bills in credits; usage_update carries the credits used so far in this turn.
          if (u?.sessionUpdate === 'usage_update' && u.cost && Number.isFinite(Number(u.cost.amount))) {
            made.emit({ type: 'usage', credits: Number(u.cost.amount) });
          }
        }
        const p = params as { update?: SessionUpdatePayload };
        const update = p?.update;
        if (!update) return;
        switch (update.sessionUpdate) {
          case 'agent_message_chunk': {
            const text = extractText(update.content);
            if (text) made.emit({ type: 'text', text });
            break;
          }
          case 'agent_thought_chunk': {
            const text = extractText(update.content);
            if (text) made.emit({ type: 'thought', text });
            break;
          }
          case 'tool_call':
            made.emit({ type: 'tool', name: update.title ?? update.name ?? 'Tool' });
            break;
        }
      });

      // Tool permissions: guard first, then trust, then a person (through the portal). The decision uses what the
      // message being worked on set in `perm`, since kiro-cli and this handler outlive a single message.
      // ACP wants the choice wrapped as an outcome; a bare optionId is rejected ("missing field outcome").
      const chosen = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } });
      acp.onServerRequest(async (method, params, _id) => {
        if (method !== 'session/request_permission') throw new Error(`Unhandled server request: ${method}`);
        const p = params as {
          toolCall?: { title?: string; name?: string; rawInput?: unknown };
          options?: Array<{ optionId: string; kind: string }>;
        };
        const options = p?.options ?? [];
        const allowId = (options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options[0])?.optionId ?? 'allow_once';
        const rejectId = (options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always') ?? options[options.length - 1])?.optionId ?? 'reject_once';
        const toolName = p?.toolCall?.title ?? p?.toolCall?.name ?? 'Tool';
        const input = parseRawInput(p?.toolCall?.rawInput);
        const inputStr = JSON.stringify(input);
        const perm = made.perm;
        const trace = (what: string, extra?: unknown): void => { process.stdout.write(JSON.stringify({ event: 'acp_permission', what, tool: toolName, trusted: perm?.trusted, options: options.map((o) => `${o.kind}:${o.optionId}`), extra }) + '\n'); };
        trace('request');

        const guardReason = guardToolCall(toolName, input, perm?.workDir ?? workDir ?? '');
        if (guardReason) {
          made.emit({ type: 'tool-blocked', toolName, toolInput: inputStr, reason: guardReason });
          return chosen(rejectId);
        }
        if (!perm || perm.trusted) return chosen(allowId);

        if (!perm.approvals || !perm.broker) {
          made.emit({ type: 'tool-blocked', toolName, toolInput: inputStr, reason: `"${toolName}" needs a person's approval, and this run has no way to ask one.` });
          return chosen(rejectId);
        }
        const inputHash = inputFingerprint(toolName, input);
        const expiryMs = Math.round(perm.approvals.expiryMinutes * 60_000) + 60_000;
        const req = perm.broker.open(perm.runId, inputHash, expiryMs, perm.abort);
        made.emit({ type: 'approval-request', requestId: req.requestId, toolName, input, inputHash, expiresAt: req.expiresAt });
        const outcome = await req.outcome;
        trace('answered', outcome.decision);
        if (outcome.decision === 'allow') return chosen(allowId);
        made.emit({ type: 'tool-blocked', toolName, toolInput: inputStr, reason: outcome.message || 'The user declined this action.' });
        return chosen(rejectId);
      });
    } else {
      w.emit = emit;
      emit({ type: 'status', text: 'Continuing in the same kiro-cli session.' });
      if (w.browserSession) emit({ type: 'browser-session', ...w.browserSession });
      // The session may have run on Claude Code meanwhile (engine switch): bring in its newer saved workspace, unless
      // this machine has unsaved changes of its own (restoreWorkspace only replaces an unchanged, out-of-date copy).
      if (payload.repos?.length) await restoreWorkspace(parseSnapshot(payload.snapshot), w.workDir, (ev) => emit(ev));
    }

    const run = w;
    const TIMEOUT_MS = 29 * 60_000; // just under the AgentCore maxLifetime (30 min)
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      emit({ type: 'status', text: 'kiro-cli ACP wall-clock timeout. Terminating.' });
      try { run.child.kill('SIGTERM'); } catch { /* ok */ }
      setTimeout(() => { try { run.child.kill('SIGKILL'); } catch { /* ok */ } }, 3_000).unref();
    }, TIMEOUT_MS);

    const acp = run.acp;

    // Live Browser view: browser-mcp (a child of kiro-cli) drops a small picture in this folder after each action;
    // it is forwarded to the portal as browser events and never reaches the model.
    const liveDir = run.liveDir;
    let draining = false;
    const drainFrames = async (): Promise<void> => {
      if (!liveDir || draining) return;
      draining = true;
      try {
        const names = (await fsp.readdir(liveDir)).filter((n) => n.endsWith('.json')).sort();
        let last: { url?: string; jpegBase64?: string } | null = null;
        for (const n of names) {
          const file = path.join(liveDir, n);
          try {
            const item = JSON.parse(await fsp.readFile(file, 'utf8')) as { url?: string; jpegBase64?: string; session?: Record<string, unknown> };
            if (item.session) { run.browserSession = item.session; emit({ type: 'browser-session', ...item.session }); }
            else last = item;
          } catch { /* half written */ }
          await fsp.rm(file, { force: true });
        }
        if (last?.url) emit({ type: 'browser-navigate', url: last.url });
        if (last?.jpegBase64) emit({ type: 'browser-screenshot', screenshotBase64: last.jpegBase64, ...(last.url ? { url: last.url } : {}) });
      } catch { /* the live view is optional */ } finally { draining = false; }
    };
    const frameTimer = liveDir ? setInterval(() => { void drainFrames(); }, 500) : null;
    // A cancel from the portal stops kiro-cli and this run's pending approvals.
    const runAbort = new AbortController();
    let cancelled = false;
    const onStop = (): void => {
      cancelled = true;
      runAbort.abort();
      emit({ type: 'status', text: 'Run cancelled. Stopping kiro-cli.' });
      try { run.child.kill('SIGTERM'); } catch { /* ok */ }
      setTimeout(() => { try { run.child.kill('SIGKILL'); } catch { /* ok */ } }, 3_000).unref();
    };
    if (stop?.aborted) onStop();
    else stop?.addEventListener('abort', onStop, { once: true });
    // What the permission handler (set up once, with kiro-cli) needs to know about this run.
    run.perm = { trusted: payload.policy?.trusted ?? true, broker, approvals: payload.approvals, runId, abort: runAbort.signal, workDir: run.workDir };

    let acpError: Error | undefined;
    try {
      if (!continuing) {
        // ACP handshake
        // kiro-cli 3.x wants the protocol version as a number; 2.x took the text "0.1". Try the number first.
        const initParams = (protocolVersion: number | string) => ({
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'kiro-runner', version: '1.0' },
        });
        try {
          await acp.sendRequest('initialize', initParams(1));
        } catch (e) {
          if (!/-32602/.test(String((e as Error)?.message))) throw e;
          await acp.sendRequest('initialize', initParams('0.1'));
        }
        acp.sendNotification('notifications/initialized');

        // New session
        // AgentCore Browser tools, served by dist/browser-mcp.mjs (started by kiro-cli on demand). The child gets
        // the AWS credential variables explicitly because kiro-cli does not pass its own environment on.
        const browserMcp = payload.browser
          ? [{
              name: 'browser',
              command: 'node',
              args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser-mcp.mjs')],
              env: [...(liveDir ? [{ name: 'BROWSER_LIVE_DIR', value: liveDir }] : []), ...['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
                'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']
                .filter((k) => process.env[k])
                .map((k) => ({ name: k, value: process.env[k] as string }))],
            }]
          : [];
        // Remote MCP integrations: each one runs behind a local stdio proxy that keeps its headers out of kiro-cli's
        // config and hides write tools unless the integration allows them.
        const proxyPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-proxy.mjs');
        // The draw.io server is bundled in the image: an integration named "drawio" runs from there (no network).
        const drawioPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drawio-mcp.mjs');
        const localDrawio = fs.existsSync(drawioPath) && fs.existsSync(path.join(process.env.DRAWIO_MCP_HOME || '/opt/drawio-mcp', 'shape-index.json'));
        const integrationMcp = parseMcpServers(payload.mcpServers).map((s) => (localDrawio && s.name === 'drawio'
          ? { name: s.name, command: 'node', args: [drawioPath], env: [{ name: 'DRAWIO_MCP_HOME', value: process.env.DRAWIO_MCP_HOME || '/opt/drawio-mcp' }] }
          : { name: s.name, command: 'node', args: [proxyPath], env: [{ name: 'MCP_PROXY_SPEC', value: JSON.stringify(s) }] }));
        const sessionResult = await acp.sendRequest('session/new', {
          cwd: run.workDir,
          mcpServers: [...browserMcp, ...integrationMcp],
        }) as { sessionId?: string };
        run.acpSessionId = sessionResult?.sessionId ?? '';
        if (!run.acpSessionId) throw new Error('kiro-cli ACP did not return a sessionId');
      }
      const sessionId = run.acpSessionId;

      // The model the person chose. A model that cannot be set is reported and the run goes on with kiro's own default.
      if (payload.model && payload.model !== run.model) {
        try {
          await acp.sendRequest('session/set_model', { sessionId, modelId: payload.model });
          run.model = payload.model;
          emit({ type: 'status', text: `Model: ${payload.model}` });
        } catch (e) {
          emit({ type: 'status', text: `Could not use model ${payload.model} (${String((e as Error)?.message ?? e).slice(0, 120)}); using kiro's default.` });
        }
      }

      // Send the prompt. Kiro's service now and then drops a request ("dispatch failure", a broken response stream, a
      // throttle). These pass on their own, so try again a few times before giving up. When nothing of the answer had
      // arrived yet the same prompt is sent again; when part of it had, kiro is asked to carry on from where it stopped
      // so that the earlier part is not repeated.
      const baseEmit = run.emit;
      let seen = 0;
      run.emit = (ev) => { seen++; baseEmit(ev); };
      try {
        const delays = [2_000, 5_000, 10_000];
        let text = prompt;
        for (let attempt = 0; ; attempt++) {
          seen = 0;
          try {
            await acp.sendRequest('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
            break;
          } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            if (attempt >= delays.length || cancelled || timedOut || run.exited || !isTransientKiroError(msg)) throw e;
            if (seen > 0) text = 'A temporary error interrupted your last reply. Carry on from where you stopped, without repeating what you already did or said.';
            baseEmit({ type: 'status', text: `Kiro had a temporary error (${msg.slice(0, 90)}). Trying again (${attempt + 1} of ${delays.length})…` });
            await new Promise((r) => setTimeout(r, delays[attempt]));
            if (cancelled || run.exited) throw e;
          }
        }
      } finally {
        run.emit = baseEmit;
      }
    } catch (e) {
      acpError = e as Error;
    } finally {
      clearTimeout(timeoutTimer);
      if (frameTimer) clearInterval(frameTimer);
      await drainFrames();
      stop?.removeEventListener('abort', onStop);
      runAbort.abort();
      broker?.closeRun(runId);
    }

    // Keep kiro-cli for the next message only after a clean run without the browser.
    const mustClose = Boolean(acpError) || timedOut || run.exited || cancelled;
    let exitCode: number | null = 0;
    if (mustClose) {
      try { acp.close(); } catch { /* ok */ }
      exitCode = await waitForExit(run, 5_000);
    }

    if (acpError) {
      emit({ type: 'error', message: `ACP error: ${acpError.message.slice(0, 500)}` });
    }

    const durationMs = Date.now() - invokeStart;
    // After run: detect token refresh by comparing what's in the DB now
    const tokenAfter = readTokenFromDb(run.defaultDbPath);
    const tokenRefreshed = Boolean(
      tokenAfter && tokenAfter.access_token && tokenAfter.expires_at !== run.expiresAtBefore,
    );

    process.stdout.write(JSON.stringify({
      event: 'run_complete', runId, exitCode, durationMs, coldStartMs, continued: continuing,
      tokenRefreshed, timedOut, cancelled, acpError: acpError?.message?.slice(0, 200),
      prompt_preview: prompt.slice(0, 200) + (prompt.length > 200 ? '…' : ''),
    }) + '\n');

    // Loop sessions: run the check steps where the code is and report the result for the next iteration.
    if (payload.checks?.length) {
      try {
        emit({ type: 'check-result', ...(await runCheckSteps(payload.checks as never, run.workDir)) });
      } catch (e) {
        emit({ type: 'check-result', ok: false, ranAt: new Date().toISOString(), steps: [{ step: 'checks', ok: false, output: String((e as Error)?.message ?? e).slice(0, 500), durationMs: 0, required: true }] });
      }
    }

    // Pull requests: say which cloned repositories changed (read-only; nothing is committed or pushed here).
    if (payload.finalizeCheck && payload.repos?.length) {
      try { await reportRepoChanges(payload.repos, run.workDir, emit); } catch { /* best effort */ }
    }

    // Send back the files kiro wrote in the work folder, within size limits.
    try { emitRunnerFiles(run.workDir, emit); } catch { /* best effort */ }

    emit({
      type: 'result',
      runId,
      exitCode: exitCode ?? -1,
      durationMs,
      coldStartMs,
      tokenRefreshed,
      ...(tokenRefreshed && tokenAfter ? {
        refreshedToken: {
          accessToken: tokenAfter.access_token,
          expiresAt: tokenAfter.expires_at,
          ...(tokenAfter.refresh_token ? { refreshToken: tokenAfter.refresh_token } : {}),
        },
      } : {}),
      stderrTail: (exitCode !== 0 || acpError) ? run.stderr.tail.trim().slice(-500) : undefined,
    });

    if (!mustClose) {
      keep = true;
      warm = run;
    }
  } finally {
    if (!keep) {
      if (w) await disposeKiro(w);
      else for (const dir of ([authTmpDir, workDir, kiroHome] as Array<string | undefined>)) {
        if (dir === workDir && workDir) stashRepos(workDir);
        if (dir) fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* non-fatal */ });
      }
    }
  }
}
