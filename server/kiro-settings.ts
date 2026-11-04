/**
 * Kiro CLI portal-wide settings routes.
 *
 * Manages the server-wide kiro-cli login state (signs in the OS user the portal
 * runs as). Admin + browser-session only.
 *
 * Routes:
 *   GET  /api/settings/kiro/status         — whoami (installed / signed-in state)
 *   POST /api/settings/kiro/login          — start device-flow login
 *   GET  /api/settings/kiro/login          — poll login status
 *   POST /api/settings/kiro/login/cancel   — cancel in-progress login
 *   POST /api/settings/kiro/logout         — sign out
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { HttpError } from './util.ts';
import { appendAudit } from './audit.ts';
import { getDb } from './db.ts';
import { resolveKiroCmd } from './kiro-cmd.ts';

// ── kiro-cli command helper ───────────────────────────────────────────────────

// resolveKiroCmd (imported above) replaces the old local kiroCmd() helper.
// The old helper used 'kiro-cli.cmd' on win32 with shell:false, which fails
// when only kiro-cli.exe is on PATH.  resolveKiroCmd always uses 'kiro-cli'.

function kiroCmd(args: string[]): { cmd: string; fullArgs: string[] } {
  return resolveKiroCmd(args);
}

// ── Kiro status ───────────────────────────────────────────────────────────────

export interface KiroStatus {
  installed: boolean;
  signedIn: boolean;
  method: 'builder-id' | 'identity-center' | null;
  startUrl: string | null;
  email: string | null;
  profile: string | null;
}

/**
 * Run `kiro-cli whoami` and parse the output.
 * Returns `{ installed: false }` when the binary is missing.
 * Returns `{ installed: true, signedIn: false }` when not logged in.
 */
export async function getKiroStatus(): Promise<KiroStatus> {
  const { cmd, fullArgs } = kiroCmd(['whoami']);

  return new Promise<KiroStatus>((resolve) => {
    let stdout = '';
    let stderr = '';

    let child: ChildProcess;
    try {
      child = spawn(cmd, fullArgs, {
        stdio: 'pipe',
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolve({ installed: false, signedIn: false, method: null, startUrl: null, email: null, profile: null });
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { stdout += d; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => { stderr += d; });

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ok */ }
    }, 8_000).unref();

    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') {
        resolve({ installed: false, signedIn: false, method: null, startUrl: null, email: null, profile: null });
      } else {
        resolve({ installed: true, signedIn: false, method: null, startUrl: null, email: null, profile: null });
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 127) {
        // Convention: exit 127 means "command not found"
        resolve({ installed: false, signedIn: false, method: null, startUrl: null, email: null, profile: null });
        return;
      }
      if (code !== 0) {
        resolve({ installed: true, signedIn: false, method: null, startUrl: null, email: null, profile: null });
        return;
      }

      const output = stdout + stderr;
      resolve(parseWhoamiOutput(output));
    });
  });
}

function parseWhoamiOutput(output: string): KiroStatus {
  const lines = output.split('\n').map((l) => l.trim());

  let method: 'builder-id' | 'identity-center' | null = null;
  let startUrl: string | null = null;
  let email: string | null = null;
  let profile: string | null = null;

  for (const line of lines) {
    // Method detection
    const identityCenterMatch = line.match(/IAM Identity Center.*?\((https?:\/\/[^\s)]+)\)/i);
    if (identityCenterMatch) {
      method = 'identity-center';
      startUrl = identityCenterMatch[1];
      continue;
    }
    if (/IAM Identity Center/i.test(line) && method === null) {
      method = 'identity-center';
      // try to find URL without parens
      const urlMatch = line.match(/https?:\/\/\S+/);
      if (urlMatch) startUrl = urlMatch[0];
      continue;
    }
    if (/Builder[\s-]?ID/i.test(line)) {
      method = 'builder-id';
      continue;
    }

    // Email
    const emailMatch = line.match(/^Email:\s*(.+)/i);
    if (emailMatch) {
      email = emailMatch[1].trim();
      continue;
    }

    // Profile
    const profileMatch = line.match(/^Profile:\s*(.+)/i);
    if (profileMatch) {
      profile = profileMatch[1].trim();
      continue;
    }
  }

  return {
    installed: true,
    signedIn: true,
    method: method ?? 'builder-id',
    startUrl,
    email,
    profile,
  };
}

// ── Active login state ────────────────────────────────────────────────────────

interface ActiveLogin {
  proc: ChildProcess;
  status: 'pending' | 'complete' | 'failed';
  error?: string;
  killTimer: ReturnType<typeof setTimeout>;
}

let _activeLogin: ActiveLogin | null = null;

function clearActiveLogin(): void {
  if (_activeLogin) {
    clearTimeout(_activeLogin.killTimer);
    try { _activeLogin.proc.kill(); } catch { /* ok */ }
    _activeLogin = null;
  }
}

/** @internal For tests only — inject a fake active login state. */
export function _setActiveLogin(al: ActiveLogin | null): void {
  _activeLogin = al;
}

// ── URL / code parsing ────────────────────────────────────────────────────────

interface LoginChallenge {
  verificationUri: string;
  userCode: string;
}

function parseLoginOutput(output: string): LoginChallenge | null {
  // Shape 1 — combined URL containing user_code param:
  //   "Visit: https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-1234"
  const combinedMatch = output.match(/(https?:\/\/\S+[?&]user_code=([A-Z0-9]{4}-[A-Z0-9]{4}))/i);
  if (combinedMatch) {
    const fullUrl = combinedMatch[1];
    const userCode = combinedMatch[2];
    // Strip the query string from verificationUri
    const verificationUri = fullUrl.replace(/[?&]user_code=[^&]+(&|$)/, '').replace(/[?&]$/, '');
    return { verificationUri, userCode };
  }

  // Shape 2 — user_code appears as a separate line/field:
  //   "Verification URL: https://..."
  //   "User code: ABCD-1234"
  const urlMatch = output.match(/https?:\/\/[^\s\n'"]+/);
  const codeMatch = output.match(/(?:user[\s_-]?code|code)[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i);
  if (urlMatch && codeMatch) {
    return { verificationUri: urlMatch[0], userCode: codeMatch[1] };
  }

  return null;
}

// ── Route auth helpers ────────────────────────────────────────────────────────

function requireAdminBrowser(req: PortalRequest, res: PortalResponse): boolean {
  const authHeader = String(req.headers.authorization ?? '');
  if (authHeader.startsWith('Bearer ')) {
    sendJson(res, 403, {
      error: 'Kiro settings can only be managed from a signed-in browser, not via API tokens',
    });
    return false;
  }
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  if (!req.user.is_admin) {
    sendJson(res, 403, { error: 'Admin access required' });
    return false;
  }
  return true;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerKiroSettingsRoutes(): void {
  // GET /api/settings/kiro/status — whoami
  router.get(
    '/api/settings/kiro/status',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdminBrowser(req, res)) return;

      try {
        // In the cloud portal Kiro runs in its own AgentCore runner, not on this server: there is no server CLI to check.
        if (process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN) {
          sendJson(res, 200, { installed: true, signedIn: false, method: null, startUrl: null, email: null, profile: null, remote: true });
          return;
        }
        const status = await getKiroStatus();
        sendJson(res, 200, status);
      } catch (e: unknown) {
        const msg = String((e as Error)?.message ?? e);
        throw new HttpError(502, `Could not check kiro-cli status: ${msg}`);
      }
    },
  );

  // POST /api/settings/kiro/login — start device-flow login
  router.post(
    '/api/settings/kiro/login',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdminBrowser(req, res)) return;

      if (_activeLogin && _activeLogin.status === 'pending') {
        sendJson(res, 409, { error: 'A kiro login is already in progress. Cancel it first.' });
        return;
      }

      // Clear any stale completed/failed login
      clearActiveLogin();

      const body = (req.body ?? {}) as Record<string, unknown>;
      const method = String(body.method ?? '');
      if (method !== 'builder-id' && method !== 'identity-center') {
        sendJson(res, 400, { error: 'method must be "builder-id" or "identity-center"' });
        return;
      }

      const startUrl = method === 'identity-center'
        ? String(body.startUrl ?? '').trim()
        : '';
      const region = method === 'identity-center'
        ? String(body.region ?? '').trim()
        : '';

      if (method === 'identity-center') {
        if (!startUrl || !startUrl.startsWith('https://')) {
          sendJson(res, 400, { error: 'startUrl must be a valid https URL for identity-center' });
          return;
        }
        if (!region) {
          sendJson(res, 400, { error: 'region is required for identity-center login' });
          return;
        }
      }

      // Build args (no shell — args passed as array)
      const loginArgs: string[] = ['login', '--use-device-flow'];
      if (method === 'builder-id') {
        loginArgs.push('--license', 'free');
      } else {
        loginArgs.push('--license', 'pro');
        loginArgs.push('--identity-provider', startUrl);
        loginArgs.push('--region', region);
      }

      const { cmd, fullArgs } = kiroCmd(loginArgs);

      let child: ChildProcess;
      try {
        child = spawn(cmd, fullArgs, {
          stdio: 'pipe',
          windowsHide: true,
          shell: false,
        });
      } catch (spawnErr: unknown) {
        const msg = String((spawnErr as Error)?.message ?? spawnErr);
        throw new HttpError(502, `Could not start kiro-cli login: ${msg}`);
      }

      // Accumulate stdout+stderr for URL parsing
      let outputBuffer = '';

      let urlResolve: ((v: LoginChallenge) => void) | null = null;
      let urlReject: ((e: Error) => void) | null = null;

      const challengePromise = new Promise<LoginChallenge>((res2, rej) => {
        urlResolve = res2;
        urlReject = rej;
      });

      // Timeout for URL extraction
      const urlExtractTimeout = setTimeout(() => {
        urlReject?.(
          new Error(
            'kiro-cli login did not produce a verification URL within 20 seconds. ' +
            'Check that kiro-cli is installed and the parameters are correct.',
          ),
        );
        urlResolve = null;
        urlReject = null;
      }, 20_000);

      const tryParseUrl = (): void => {
        const parsed = parseLoginOutput(outputBuffer);
        if (parsed && urlResolve) {
          clearTimeout(urlExtractTimeout);
          urlResolve(parsed);
          urlResolve = null;
          urlReject = null;
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        outputBuffer += d;
        tryParseUrl();
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (d: string) => {
        outputBuffer += d;
        tryParseUrl();
      });

      // Kill timer — 15 minutes (longer than most SSO flows)
      const killTimer = setTimeout(() => {
        if (_activeLogin && _activeLogin.status === 'pending') {
          _activeLogin.status = 'failed';
          _activeLogin.error = 'Login timed out';
          clearActiveLogin();
        }
      }, 15 * 60_000).unref();

      _activeLogin = { proc: child, status: 'pending', killTimer };

      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(urlExtractTimeout);
        const msg = e.code === 'ENOENT'
          ? 'kiro-cli is not installed or not on PATH'
          : `kiro-cli spawn error: ${e.message}`;
        if (_activeLogin) {
          _activeLogin.status = 'failed';
          _activeLogin.error = msg;
        }
        urlReject?.(new Error(msg));
        urlResolve = null;
        urlReject = null;
      });

      child.on('close', (code) => {
        clearTimeout(urlExtractTimeout);
        if (_activeLogin) {
          if (code === 0) {
            _activeLogin.status = 'complete';
          } else {
            _activeLogin.status = 'failed';
            _activeLogin.error = `kiro-cli login exited with code ${code}`;
          }
        }
        // If URL was never parsed and process already exited
        urlReject?.(
          new Error(`kiro-cli login exited (code ${code}) without producing a verification URL`),
        );
        urlResolve = null;
        urlReject = null;
      });

      // Wait for the URL to appear (or timeout)
      let challenge: LoginChallenge;
      try {
        challenge = await challengePromise;
      } catch (e: unknown) {
        clearActiveLogin();
        throw new HttpError(502, String((e as Error)?.message ?? e));
      }

      appendAudit(
        getDb(),
        req.user!.id,
        'kiro-cli.login.start',
        null,
        { method },
        req.ip,
      );

      sendJson(res, 200, {
        verificationUri: challenge.verificationUri,
        userCode: challenge.userCode,
      });
    },
  );

  // GET /api/settings/kiro/login — poll login status
  router.get(
    '/api/settings/kiro/login',
    (req: PortalRequest, res: PortalResponse): void => {
      if (!requireAdminBrowser(req, res)) return;

      if (!_activeLogin) {
        sendJson(res, 200, { status: 'idle' });
        return;
      }

      sendJson(res, 200, {
        status: _activeLogin.status,
        ..._activeLogin.error ? { error: _activeLogin.error } : {},
      });
    },
  );

  // POST /api/settings/kiro/login/cancel — cancel in-progress login
  router.post(
    '/api/settings/kiro/login/cancel',
    (req: PortalRequest, res: PortalResponse): void => {
      if (!requireAdminBrowser(req, res)) return;

      clearActiveLogin();
      sendJson(res, 200, { ok: true });
    },
  );

  // POST /api/settings/kiro/logout — sign out
  router.post(
    '/api/settings/kiro/logout',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdminBrowser(req, res)) return;

      // Kill any active login first
      clearActiveLogin();

      const { cmd, fullArgs } = kiroCmd(['logout']);

      await new Promise<void>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn(cmd, fullArgs, {
            stdio: 'ignore',
            windowsHide: true,
            shell: false,
          });
        } catch {
          resolve();
          return;
        }
        child.on('error', () => resolve());
        child.on('close', () => resolve());
        setTimeout(() => {
          try { child.kill(); } catch { /* ok */ }
          resolve();
        }, 8_000).unref();
      });

      appendAudit(getDb(), req.user!.id, 'kiro-cli.logout', null, {}, req.ip);

      sendJson(res, 200, { ok: true });
    },
  );
}
