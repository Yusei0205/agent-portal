/**
 * Terminal — interactive shell streamed over WebSocket.
 *
 * Authentication: session cookie (admin only). API tokens are explicitly refused.
 * Origin check: the upgrade request Origin must match the server's host (CSRF-equivalent).
 *
 * PTY support: tries @lydell/node-pty, then node-pty at runtime; degrades to a piped
 * spawn when unavailable. The capability response tells the UI what mode is active.
 *
 * WebSocket protocol (JSON messages):
 *
 *   Server → client:
 *     { type: 'ready',  pty: boolean, cols: number, rows: number, shell?: string }
 *     { type: 'output', data: string }   (base64-encoded bytes)
 *     { type: 'exit',   code: number }
 *     { type: 'error',  message: string }
 *     { type: 'pong' }
 *
 *   Client → server:
 *     { type: 'input',  data: string }   (base64-encoded bytes)
 *     { type: 'resize', cols: number, rows: number }
 *     { type: 'ping' }
 *
 * Routes:
 *   GET /api/terminal/capability               — capability check (any authenticated user)
 *   GET /api/admin/terminal/settings           — get terminal admin settings
 *   PUT /api/admin/terminal/settings           — update terminal admin settings
 *
 * WebSocket endpoint (upgrade only, handled outside the HTTP router):
 *   ws://.../api/terminal/ws?workflowId=<id>
 */

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { router, sendJson, parseCookies } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, run as dbRun } from './db.ts';
import type { Row } from './db.ts';
import { config } from './config.ts';
import { appendAudit } from './audit.ts';
import { getDb } from './db.ts';
import { getSetting } from './settings.ts';
import { getSettingsRepository, _updateSnapshotKey } from './repositories/settings.ts';
import path from 'node:path';
import fs from 'node:fs';

// ── PTY capability ────────────────────────────────────────────────────────────

interface NodePtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface NodePty {
  spawn(
    file: string,
    args: string[],
    opts: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string | undefined> },
  ): NodePtyProcess;
}

let _pty: NodePty | null = null;
let _ptyChecked = false;

// Internal import function — can be replaced in tests via _setImporterForTest.
type PtyImportFn = (pkg: string) => Promise<NodePty>;
let _ptyImport: PtyImportFn = (pkg) =>
  Function('m', 'return import(m)')(pkg) as Promise<NodePty>;

// Ordered list of packages to try. @lydell/node-pty is preferred: ships prebuilt
// win32-x64 binaries, never requires node-gyp.
const PTY_PACKAGES = ['@lydell/node-pty', 'node-pty'] as const;

async function tryLoadPty(): Promise<NodePty | null> {
  if (_ptyChecked) return _pty;
  _ptyChecked = true;
  for (const pkg of PTY_PACKAGES) {
    try {
      const mod = await _ptyImport(pkg);
      // Handle both named-export (mod.spawn) and default-export (mod.default.spawn)
      // that CJS/ESM interop may produce.
      const candidate: NodePty =
        mod && typeof (mod as NodePty).spawn === 'function'
          ? (mod as NodePty)
          : ((mod as unknown as { default?: NodePty }).default ?? (mod as NodePty));
      if (candidate && typeof candidate.spawn === 'function') {
        _pty = candidate;
        break;
      }
    } catch {
      // package missing or binary unavailable — try next
    }
  }
  return _pty;
}

// ── Test helpers (exported only for the test suite) ───────────────────────────

/** Reset PTY load state so the next tryLoadPty() call re-probes. */
export function _resetPtyStateForTest(): void {
  _pty = null;
  _ptyChecked = false;
  _ptyImport = (pkg) => Function('m', 'return import(m)')(pkg) as Promise<NodePty>;
}

/** Override the import function for PTY package loading in tests. Also resets state. */
export function _setImporterForTest(fn: PtyImportFn): void {
  _ptyImport = fn;
  _pty = null;
  _ptyChecked = false;
}

/** Override the loaded PTY module directly (for tests that need a mock PTY). */
export function _overridePtyForTest(mod: NodePty | null): void {
  _pty = mod;
  _ptyChecked = true;
}

/** Reset the cached Windows shell detection result. */
export function _resetShellCacheForTest(): void {
  _windowsShell = null;
}

export { buildSafeEnv as _buildSafeEnvForTest };
export { defaultShell as _defaultShellForTest };
export { pipeFallbackShell as _pipeFallbackShellForTest };

// ── Safe environment ──────────────────────────────────────────────────────────

// Keys allowed through to the shell — no secrets, no portal-internal vars.
const SAFE_ENV_KEYS = new Set([
  // POSIX / macOS
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
  'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME', 'TZ', 'TMPDIR',
  'COLORTERM', 'DISPLAY', 'MANPATH', 'PAGER', 'EDITOR',
  // Windows
  'USERPROFILE', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMPUTERNAME',
  'PROCESSOR_ARCHITECTURE', 'PROGRAMFILES', 'PROGRAMDATA',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'PATHEXT', 'COMSPEC',
  // Dev tools (non-secret)
  'NODE_VERSION', 'NVM_DIR', 'NVM_BIN', 'JAVA_HOME', 'GOPATH', 'GOROOT',
  'PYTHON', 'PYTHON3', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
]);

// Keys that must never appear in the shell, even if somehow in SAFE_ENV_KEYS
const BLOCKED_ENV_KEYS = new Set([
  'PORTAL_SECRET_KEY', 'SECRET_KEY_ARN', 'PORTAL_SECRET_KEY_SSM_PATH',
  'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'KIRO_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK',
]);

function buildSafeEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Windows env var names are case-insensitive (e.g. 'Path' instead of 'PATH').
    // Normalise to uppercase for the allow/block checks, but keep the original key
    // in the output env so the child process receives it in its native casing.
    const upperKey = k.toUpperCase();
    if (!SAFE_ENV_KEYS.has(upperKey)) continue;
    if (BLOCKED_ENV_KEYS.has(upperKey)) continue;
    if (v !== undefined) env[k] = v;
  }
  for (const k of BLOCKED_ENV_KEYS) {
    delete env[k];
  }
  env.PWD = cwd;
  // Force terminal type for full colour/interactive support.
  // These override anything inherited from process.env.
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

// ── Shell detection ───────────────────────────────────────────────────────────

// Cache the Windows shell detection result (runs `where` once at most).
let _windowsShell: { cmd: string; args: string[] } | null = null;

/** Detect the best PTY shell on Windows: pwsh.exe (PS7+) > powershell.exe, both with -NoLogo. */
function detectWindowsShell(): { cmd: string; args: string[] } {
  if (_windowsShell) return _windowsShell;
  try {
    const result = spawnSync('where', ['pwsh.exe'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (result.status === 0 && result.stdout.trim()) {
      _windowsShell = { cmd: 'pwsh.exe', args: ['-NoLogo'] };
      return _windowsShell;
    }
  } catch {
    // `where` unavailable — fall through
  }
  _windowsShell = { cmd: 'powershell.exe', args: ['-NoLogo'] };
  return _windowsShell;
}

/** Shell used for PTY sessions. */
function defaultShell(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    return detectWindowsShell();
  }
  return { cmd: process.env.SHELL ?? '/bin/bash', args: [] };
}

/** Shell used for the non-PTY pipe fallback. */
function pipeFallbackShell(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    // powershell.exe with -Command - reads commands from stdin line by line.
    return { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', '-'] };
  }
  return { cmd: process.env.SHELL ?? '/bin/bash', args: [] };
}

// ── Active process tracking (for server shutdown) ─────────────────────────────

const activeTerminalProcesses = new Set<{ kill(): void }>();

/**
 * Kill all active terminal PTY/pipe processes.
 * Called during server shutdown so no conpty/powershell processes are left orphaned.
 */
export function shutdownAllTerminals(): void {
  for (const proc of activeTerminalProcesses) {
    try { proc.kill(); } catch { /* ignore */ }
  }
  activeTerminalProcesses.clear();
}

// ── Concurrency limits ────────────────────────────────────────────────────────

const MAX_SESSIONS_PER_USER = 3;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes

// Map: userId → count of open terminal sessions
const openSessionCounts = new Map<string, number>();

function incrementSession(userId: string): boolean {
  const count = openSessionCounts.get(userId) ?? 0;
  if (count >= MAX_SESSIONS_PER_USER) return false;
  openSessionCounts.set(userId, count + 1);
  return true;
}

function decrementSession(userId: string): void {
  const count = openSessionCounts.get(userId) ?? 1;
  if (count <= 1) openSessionCounts.delete(userId);
  else openSessionCounts.set(userId, count - 1);
}

// ── Settings helpers ──────────────────────────────────────────────────────────

function isTerminalEnabled(): boolean {
  try {
    const val = getSetting(getDb(), 'terminal.enabled');
    return val === null ? true : val === 'true';
  } catch {
    return true;
  }
}

// ── Auth for WebSocket upgrades ───────────────────────────────────────────────

interface AuthResult {
  userId: string;
  isAdmin: boolean;
}

/**
 * Authenticate a WebSocket upgrade using the portal_session cookie.
 * API tokens (Authorization: Bearer ...) are explicitly refused at the
 * call site; this function only checks browser session cookies.
 */
async function authenticateUpgrade(req: http.IncomingMessage): Promise<AuthResult | null> {
  const cookieHeader = req.headers.cookie ?? '';
  if (!cookieHeader) return null;
  const cookies = parseCookies(cookieHeader);
  const token = cookies['portal_session'];
  if (!token) return null;

  const tokenHash = createHash('sha256').update(decodeURIComponent(token)).digest('hex');

  // Use the auth repository (works for both SQLite and DynamoDB).
  // For SQLite, the SqliteAuthRepository also exposes getSessionWithUserSync() but
  // since terminal upgrade handlers are already called from async contexts, async is fine.
  const { getAuthRepository } = await import('./repositories/auth.ts');
  const session = await getAuthRepository().getSessionWithUser(tokenHash);
  if (!session) return null;
  if (session.disabled) return null;
  if (session.expires_at < new Date().toISOString()) return null;

  return { userId: session.user_id, isAdmin: Boolean(session.is_admin) };
}

/**
 * Check whether a user has write access to a session's project.
 * Admins always pass. Other users must be 'editor' or 'owner' of the project.
 * Returns false if the workflow or project cannot be found.
 */
function canUserWriteWorkflow(userId: string, isAdmin: boolean, workflowId: string): boolean {
  if (isAdmin) return true;
  const wf = one<Row>('SELECT project_id FROM p6_workflows WHERE id = ?', workflowId);
  if (!wf || !wf.project_id) return false;
  const member = one<Row>(
    'SELECT access FROM project_members WHERE project_id = ? AND user_id = ?',
    String(wf.project_id),
    userId,
  );
  if (!member) return false;
  return ['editor', 'owner'].includes(String(member.access));
}

/**
 * Check that the WebSocket upgrade request comes from an acceptable origin.
 * Accepts:
 *   - No Origin header (same-origin request from a browser on the same host)
 *   - Origin that matches the request Host
 */
function checkOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // no origin → same-origin or non-browser (allow)
  const host = req.headers.host ?? '';
  try {
    const originHost = new URL(origin).host;
    return originHost === host;
  } catch {
    return false;
  }
}

// ── Resolve working directory for a workflow ──────────────────────────────────

function resolveTerminalWorkDir(workflowId: string): string | null {
  const wf = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', workflowId);
  if (!wf || !wf.project_id) return null;
  const project = one<Row>('SELECT slug FROM projects WHERE id = ?', wf.project_id as string);
  if (!project) return null;
  const slug = String(project.slug);

  // Prefer the workflow's persistent work_dir (set after first run)
  if (wf.work_dir) {
    const persisted = String(wf.work_dir);
    if (fs.existsSync(persisted)) return persisted;
    // Persisted dir doesn't exist yet — refuse rather than falling back
    return null;
  }

  // Fallback: look up the latest run's workdir (pre-M21 workflows)
  const latestRun = one<Row>(
    'SELECT id FROM p6_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1',
    workflowId,
  );
  if (latestRun) {
    const workDir = path.join(config.dataDir, 'projects', slug, 'work', String(latestRun.id));
    if (fs.existsSync(workDir)) return workDir;
  }

  // No working copy available — refuse with null so the caller can send a clear error.
  // Do NOT fall back to the whole project dir.
  return null;
}

// ── WebSocket server ──────────────────────────────────────────────────────────

let _wss: WebSocketServer | null = null;

/** Returns (creating once) the WebSocketServer instance bound to noServer. */
function getWss(): WebSocketServer {
  if (!_wss) {
    _wss = new WebSocketServer({ noServer: true });
  }
  return _wss;
}

/**
 * Handle a WebSocket upgrade request for /api/terminal/ws.
 * Called from the HTTP server's 'upgrade' event.
 */
export function handleTerminalUpgrade(
  req: http.IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
): void {
  // Delegate to the async implementation; any unhandled rejection is caught.
  _handleTerminalUpgradeAsync(req, socket, head).catch((err: unknown) => {
    console.error('[terminal] upgrade error:', err);
    try { socket.destroy(); } catch { /* ignore */ }
  });
}

async function _handleTerminalUpgradeAsync(
  req: http.IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/api/terminal/ws') {
    socket.destroy();
    return;
  }

  // Origin check (CSRF-equivalent)
  if (!checkOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // Explicitly refuse API token authentication (must use browser session cookie)
  if (req.headers.authorization) {
    socket.write('HTTP/1.1 403 Forbidden\r\nX-Terminal-Error: API tokens cannot be used for terminal access\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // Auth: session cookie only
  const auth = await authenticateUpgrade(req);
  if (!auth) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // Terminal feature enabled?
  if (!isTerminalEnabled()) {
    socket.write('HTTP/1.1 403 Forbidden\r\nX-Terminal-Error: Terminal disabled by administrator\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // Access: admins always allowed; others must have write access to the session's project
  const workflowId = url.searchParams.get('workflowId') ?? '';
  if (!auth.isAdmin) {
    if (!workflowId) {
      // Portal-level terminal (no session scope) is admin-only
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!canUserWriteWorkflow(auth.userId, false, workflowId)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  // Concurrency limit
  if (!incrementSession(auth.userId)) {
    socket.write(`HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  getWss().handleUpgrade(req, socket, head, (ws) => {
    handleTerminalSession(ws, req, auth, url).catch((err: unknown) => {
      // The promise was dropped — decrement session count and close on unexpected error
      decrementSession(auth.userId);
      try { ws.close(); } catch { /* ignore */ }
      console.error('[terminal] Unhandled error in session:', err);
    });
  });
}

async function handleTerminalSession(
  ws: WebSocket,
  req: http.IncomingMessage,
  auth: AuthResult,
  url: URL,
): Promise<void> {
  const workflowId = url.searchParams.get('workflowId') ?? '';

  // Resolve working directory — refuse if a workflow was specified but has no working copy.
  let cwd: string;
  if (workflowId) {
    const resolved = resolveTerminalWorkDir(workflowId);
    if (!resolved) {
      const safeSendErr = (msg: object): void => {
        try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
      };
      safeSendErr({ type: 'error', message: 'Session working copy not found. Run the session at least once to create the working directory.' });
      ws.close();
      decrementSession(auth.userId);
      return;
    }
    cwd = resolved;
  } else {
    cwd = config.dataDir;
  }

  // Audit: terminal opened
  try {
    appendAudit(
      getDb(),
      auth.userId,
      'terminal.open',
      workflowId ? `workflow:${workflowId}` : null,
      { cwd },
      null,
    );
  } catch {
    // best-effort audit
  }

  const safeSend = (msg: object): void => {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    } catch {
      // ignore send errors on closing sockets
    }
  };

  let cols = 80;
  let rows = 24;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      safeSend({ type: 'error', message: 'Session timed out due to inactivity' });
      ws.close();
    }, IDLE_TIMEOUT_MS);
  }

  resetIdleTimer();

  // Holds a reference to the active PTY or child process so cleanup() can
  // remove it from the global tracking set on any exit path.
  let activeProcess: { kill(): void } | null = null;

  const ptyMod = await tryLoadPty();

  let cleanedUp = false;
  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (activeProcess) {
      activeTerminalProcesses.delete(activeProcess);
      activeProcess = null;
    }
    decrementSession(auth.userId);
    // Audit: terminal closed
    try {
      appendAudit(
        getDb(),
        auth.userId,
        'terminal.close',
        workflowId ? `workflow:${workflowId}` : null,
        {},
        null,
      );
    } catch {
      // best-effort
    }
  }

  if (ptyMod) {
    // ── PTY-based terminal ───────────────────────────────────────────────────
    const { cmd, args } = defaultShell();
    let ptyProcess: NodePtyProcess;
    try {
      ptyProcess = ptyMod.spawn(cmd, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: buildSafeEnv(cwd) as Record<string, string>,
      });
    } catch (e: unknown) {
      safeSend({ type: 'error', message: `Failed to start terminal: ${e instanceof Error ? e.message : String(e)}` });
      ws.close();
      cleanup();
      return;
    }

    activeProcess = ptyProcess;
    activeTerminalProcesses.add(ptyProcess);

    safeSend({ type: 'ready', pty: true, cols, rows, shell: cmd });

    ptyProcess.onData((data) => {
      resetIdleTimer();
      // node-pty delivers decoded UTF-8 text; re-encode as UTF-8 (not latin1) so
      // non-ASCII output such as box-drawing or CJK characters survives the trip.
      safeSend({ type: 'output', data: Buffer.from(data, 'utf8').toString('base64') });
    });

    ptyProcess.onExit(({ exitCode }) => {
      safeSend({ type: 'exit', code: exitCode });
      ws.close();
      cleanup();
    });

    ws.on('message', (raw: Buffer) => {
      resetIdleTimer();
      let msg: { type: string; data?: string; cols?: number; rows?: number };
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'input' && msg.data) {
        // The client sends UTF-8 bytes (TextEncoder); decode them as UTF-8.
        ptyProcess.write(Buffer.from(msg.data, 'base64').toString('utf8'));
      } else if (msg.type === 'resize' && msg.cols && msg.rows) {
        cols = msg.cols;
        rows = msg.rows;
        ptyProcess.resize(cols, rows);
      } else if (msg.type === 'ping') {
        safeSend({ type: 'pong' });
      }
    });

    ws.on('close', () => {
      try { ptyProcess.kill(); } catch { /* ignore */ }
      cleanup();
    });

    ws.on('error', () => {
      try { ptyProcess.kill(); } catch { /* ignore */ }
      cleanup();
    });

  } else {
    // ── Pipe-based fallback (no PTY) ─────────────────────────────────────────
    // Uses PowerShell on Windows for better command compatibility than cmd.exe.
    const { cmd, args } = pipeFallbackShell();
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, {
        cwd,
        env: buildSafeEnv(cwd) as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (e: unknown) {
      safeSend({ type: 'error', message: `Failed to start terminal: ${e instanceof Error ? e.message : String(e)}` });
      ws.close();
      cleanup();
      return;
    }

    activeProcess = proc;
    activeTerminalProcesses.add(proc);

    // pty: false tells the UI it's in degraded mode; shell tells it what's running.
    safeSend({ type: 'ready', pty: false, cols, rows, shell: cmd });

    proc.stdout?.on('data', (chunk: Buffer) => {
      resetIdleTimer();
      safeSend({ type: 'output', data: chunk.toString('base64') });
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      resetIdleTimer();
      safeSend({ type: 'output', data: chunk.toString('base64') });
    });

    proc.on('exit', (code) => {
      safeSend({ type: 'exit', code: code ?? 0 });
      ws.close();
      cleanup();
    });

    proc.on('error', (err) => {
      safeSend({ type: 'error', message: err.message });
      ws.close();
      cleanup();
    });

    ws.on('message', (raw: Buffer) => {
      resetIdleTimer();
      let msg: { type: string; data?: string; cols?: number; rows?: number };
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'input' && msg.data) {
        const input = Buffer.from(msg.data, 'base64');
        proc.stdin?.write(input);
      } else if (msg.type === 'ping') {
        safeSend({ type: 'pong' });
      }
      // resize is a no-op for non-PTY
    });

    ws.on('close', () => {
      try { proc.kill(); } catch { /* ignore */ }
      cleanup();
    });

    ws.on('error', () => {
      try { proc.kill(); } catch { /* ignore */ }
      cleanup();
    });
  }
}

// ── HTTP routes ───────────────────────────────────────────────────────────────

export function registerTerminalRoutes(): void {

  // GET /api/terminal/capability
  router.get('/api/terminal/capability', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) {
      sendJson(res, 401, { error: 'Sign in to continue' });
      return;
    }
    const enabled = isTerminalEnabled();
    const ptyMod = await tryLoadPty();
    sendJson(res, 200, {
      available: enabled,
      adminOnly: false,
      ptyAvailable: ptyMod !== null,
      platform: process.platform,
      reason: !enabled ? 'Terminal is disabled by an administrator' : undefined,
    });
  });

  // GET /api/admin/terminal/settings
  router.get('/api/admin/terminal/settings', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user?.is_admin) {
      sendJson(res, 403, { error: 'Admin access required' });
      return;
    }
    const val = getSetting(getDb(), 'terminal.enabled');
    const enabled = val === null ? true : val === 'true';
    sendJson(res, 200, { enabled });
  });

  // PUT /api/admin/terminal/settings
  router.put('/api/admin/terminal/settings', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user?.is_admin) {
      sendJson(res, 403, { error: 'Admin access required' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const enabled = Boolean(body.enabled ?? true);
    const repo = getSettingsRepository();
    if (repo) {
      await repo.setKey('terminal.enabled', enabled ? 'true' : 'false');
      _updateSnapshotKey('terminal.enabled', enabled ? 'true' : 'false');
    } else {
      dbRun(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        'terminal.enabled',
        enabled ? 'true' : 'false',
      );
    }
    sendJson(res, 200, { enabled });
  });
}
