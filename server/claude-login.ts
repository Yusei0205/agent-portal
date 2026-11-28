/**
 * "Sign in with your Claude plan" — drives the official Claude Code CLI (`claude setup-token`)
 * inside a pseudo-terminal so the person can sign in from the portal instead of running the
 * command on their own computer.
 *
 * The portal does NOT implement OAuth itself: the CLI owns the client, the PKCE exchange and the
 * token request. We only relay (1) the sign-in URL it prints and (2) the code the person pastes
 * back, and read the long-lived token it prints at the end. The token never goes to the browser;
 * the caller stores it encrypted as a `subscription_token` credential.
 *
 * Each login runs with its own throw-away CLAUDE_CONFIG_DIR and a minimal environment, so it never
 * touches the host's own Claude login and never inherits portal/AWS/API-key secrets.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryLoadPty } from './terminal.ts';
import { HttpError } from './util.ts';

export type ClaudeLoginStatus = 'starting' | 'awaiting_code' | 'finishing' | 'complete' | 'failed';

export interface ClaudeLoginState {
  status: ClaudeLoginStatus;
  url?: string;
  error?: string;
}

interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(): void;
}

interface Login {
  pty: PtyLike;
  configDir: string;
  output: string;
  state: ClaudeLoginState;
  token?: string;
  timer: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
}

const LOGIN_TTL_MS = 10 * 60_000;
const START_TIMEOUT_MS = 30_000;
const FINISH_TIMEOUT_MS = 60_000;
const logins = new Map<string, Login>();

// ── Pure helpers (exported for tests) ─────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
export function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

const ALLOWED_HOSTS = new Set(['claude.com', 'claude.ai', 'platform.claude.com']);

/** Accept only an https URL on a Claude host; anything else the terminal prints is ignored. */
export function safeSignInUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}

/** The CLI prints the sign-in URL as an OSC 8 hyperlink (and again as wrapped plain text). */
export function extractSignInUrl(output: string): string | null {
  // eslint-disable-next-line no-control-regex
  const osc = /\x1b\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/.exec(output);
  if (osc) return safeSignInUrl(osc[1]);
  return null;
}

/** Long-lived subscription tokens look like sk-ant-oat01-…; read it from the CLI's final output. */
export function extractToken(output: string): string | null {
  const m = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/.exec(stripAnsi(output));
  return m ? m[0] : null;
}

/** The code claude.ai shows looks like `abc…#xyz…`. Reject anything that could be terminal control input. */
export function validAuthCode(code: string): boolean {
  return /^[A-Za-z0-9_#.~%-]{10,400}$/.test(code);
}

// ── Locating the CLI ──────────────────────────────────────────────────────────

export function resolveClaudeBinary(): string | null {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const explicit = process.env.PORTAL_CLAUDE_CLI;
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  // The Agent SDK ships a native CLI for each platform.
  const sdk = path.resolve(process.cwd(), 'node_modules', '@anthropic-ai',
    `claude-agent-sdk-${process.platform}-${process.arch}`, exe);
  if (fs.existsSync(sdk)) return sdk;
  return null;
}

function loginEnv(configDir: string): Record<string, string> {
  const keep = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'LOCALAPPDATA',
    'APPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v && keep.includes(k.toUpperCase())) env[k] = v;
  env.TERM = 'xterm-256color';
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

export async function claudeLoginSupport(): Promise<{ supported: boolean; reason?: string }> {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_LAMBDA_RUNTIME_API) {
    return { supported: false, reason: 'Signing in from the portal is not available on this deployment. Use `claude setup-token` on your computer and paste the token.' };
  }
  if (!(await tryLoadPty())) return { supported: false, reason: 'This server has no terminal support, so it cannot run the Claude sign-in.' };
  if (!resolveClaudeBinary()) return { supported: false, reason: 'The Claude Code CLI is not installed on this server.' };
  return { supported: true };
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

function cleanup(userId: string): void {
  const login = logins.get(userId);
  if (!login) return;
  logins.delete(userId);
  clearTimeout(login.timer);
  try { login.pty.kill(); } catch { /* already gone */ }
  fs.rm(login.configDir, { recursive: true, force: true }, () => {});
  for (const w of login.waiters) w();
}

export function cancelClaudeLogin(userId: string): void { cleanup(userId); }

export function getClaudeLoginState(userId: string): ClaudeLoginState | null {
  return logins.get(userId)?.state ?? null;
}

function waitFor(login: Login, done: () => boolean, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (done()) { resolve(); return; }
    const finish = () => { clearTimeout(timer); login.waiters.delete(check); resolve(); };
    const check = () => { if (done()) finish(); };
    const timer = setTimeout(finish, ms);
    login.waiters.add(check);
  });
}

function notify(login: Login): void { for (const w of [...login.waiters]) w(); }

export async function startClaudeLogin(userId: string): Promise<ClaudeLoginState> {
  const support = await claudeLoginSupport();
  if (!support.supported) throw new HttpError(409, support.reason ?? 'Sign-in is not available here.');
  cleanup(userId);

  const pty = await tryLoadPty();
  const binary = resolveClaudeBinary();
  if (!pty || !binary) throw new HttpError(409, 'Sign-in is not available here.');

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-claude-login-'));
  let proc: PtyLike;
  try {
    proc = pty.spawn(binary, ['setup-token'], { name: 'xterm-256color', cols: 500, rows: 40, cwd: configDir, env: loginEnv(configDir) });
  } catch {
    fs.rmSync(configDir, { recursive: true, force: true });
    throw new HttpError(502, 'Could not start the Claude sign-in.');
  }

  const login: Login = {
    pty: proc, configDir, output: '', state: { status: 'starting' }, waiters: new Set(),
    timer: setTimeout(() => cleanup(userId), LOGIN_TTL_MS),
  };
  login.timer.unref?.();
  logins.set(userId, login);

  proc.onData((data) => {
    login.output = (login.output + data).slice(-64_000);
    if (login.state.status === 'starting') {
      const url = extractSignInUrl(login.output);
      if (url) login.state = { status: 'awaiting_code', url };
    } else if (login.state.status === 'finishing') {
      const token = extractToken(login.output);
      if (token) { login.token = token; login.state = { status: 'complete' }; }
    }
    notify(login);
  });
  proc.onExit(() => {
    if (login.state.status === 'finishing') {
      const token = extractToken(login.output);
      if (token) { login.token = token; login.state = { status: 'complete' }; }
      else login.state = { status: 'failed', error: 'Sign-in did not complete. The code may be wrong or expired — start again.' };
    } else if (login.state.status === 'starting' || login.state.status === 'awaiting_code') {
      login.state = { status: 'failed', error: 'The Claude sign-in ended unexpectedly. Please try again.' };
    }
    notify(login);
  });

  await waitFor(login, () => login.state.status !== 'starting', START_TIMEOUT_MS);
  if (login.state.status !== 'awaiting_code') {
    const error = login.state.error ?? 'Could not get a sign-in link from the Claude CLI. Please try again.';
    cleanup(userId);
    throw new HttpError(502, error);
  }
  return login.state;
}

/** Types the pasted code into the CLI and returns the token it prints. The login is consumed. */
export async function submitClaudeLoginCode(userId: string, rawCode: string): Promise<string> {
  const login = logins.get(userId);
  if (!login || login.state.status !== 'awaiting_code') {
    throw new HttpError(409, 'No sign-in is waiting for a code. Start the sign-in again.');
  }
  const code = rawCode.trim();
  if (!validAuthCode(code)) throw new HttpError(400, 'That does not look like the code from the Claude sign-in page.');

  login.state = { status: 'finishing' };
  login.output = '';
  login.pty.write(code);
  setTimeout(() => { try { login.pty.write('\r'); } catch { /* exited */ } }, 150);

  await waitFor(login, () => login.state.status !== 'finishing', FINISH_TIMEOUT_MS);
  const token = login.token;
  const error = login.state.error ?? 'Sign-in did not complete. The code may be wrong or expired — start again.';
  cleanup(userId);
  if (!token) throw new HttpError(400, error);
  return token;
}

export function _resetClaudeLoginsForTest(): void { for (const id of [...logins.keys()]) cleanup(id); }
