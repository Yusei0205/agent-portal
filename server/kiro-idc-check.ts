/**
 * kiro-idc-check.ts — Runtime self-check for KIRO_TEST_DB_PATH hook support.
 *
 * kiro-cli ≥ 2.37 honours KIRO_TEST_DB_PATH to redirect its SQLite auth
 * database.  Setting it to an empty database makes `kiro-cli whoami` report
 * "not signed in", confirming the hook is active.  If the hook is ignored,
 * whoami returns the portal machine's own session — a silent identity leak.
 *
 * Result is cached per kiro-cli version so the check runs at most once per
 * deployed binary version.  Call _clearIdcHookCheckCache() in tests.
 *
 * Safety invariants:
 *   - We never log or expose the machine's real account details even when
 *     the hook-ignored path is detected.
 *   - The empty DB used for the check contains no tokens.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { KIRO_TEST_DB_ENV } from './kiro-idc.ts';
import { resolveKiroCmd } from './kiro-cmd.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KiroIdcHookCheck {
  /** True when kiro-cli honours KIRO_TEST_DB_PATH for the installed version. */
  supported: boolean;
  /** Installed kiro-cli version string, or 'unknown'. */
  version: string;
  /**
   * Set when the check could not be completed (e.g., kiro-cli not installed).
   * NOT set when the check completed and determined the hook is unsupported.
   * Never contains token values or account details.
   */
  error?: string;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const _checkCache = new Map<string, KiroIdcHookCheck>();

/** @internal Test hook — clear the IDC hook check cache. */
export function _clearIdcHookCheckCache(): void {
  _checkCache.clear();
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function createEmptyAuthDb(): Promise<{ dbPath: string; tmpDir: string }> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-kiro-selfcheck-'));
  const dbPath = path.join(tmpDir, 'data.sqlite3');
  const db = new DatabaseSync(dbPath, { open: true });
  db.close();
  return { dbPath, tmpDir };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the installed kiro-cli version string.
 * Returns 'unknown' if kiro-cli is not installed or the command fails.
 */
export function getKiroCliVersion(): Promise<string> {
  return new Promise((resolve) => {
    const { cmd, fullArgs } = resolveKiroCmd(['--version']);
    let stdout = '';
    let settled = false;
    function settle(v: string): void {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, fullArgs, {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        windowsHide: true,
      });
    } catch {
      settle('unknown');
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', () => settle('unknown'));
    child.on('close', () => {
      settle(stdout.trim().split('\n')[0].trim() || 'unknown');
    });
    setTimeout(() => {
      try { child.kill(); } catch { /* ok */ }
      settle('unknown');
    }, 5_000).unref();
  });
}

/**
 * Check whether KIRO_TEST_DB_PATH is honoured by the installed kiro-cli.
 *
 * Runs `kiro-cli whoami` with KIRO_TEST_DB_PATH pointing at an empty DB.
 * If kiro-cli reports "not signed in", the hook is honoured (supported: true).
 * If it reports a signed-in session, the hook is silently ignored (supported: false).
 *
 * Result is cached per kiro-cli version.  Call _clearIdcHookCheckCache() to reset.
 */
export async function checkKiroIdcHookSupport(): Promise<KiroIdcHookCheck> {
  const version = await getKiroCliVersion();
  const cached = _checkCache.get(version);
  if (cached) return cached;

  const check = await doCheck(version);
  if (!check.error) {
    _checkCache.set(version, check);
  }
  return check;
}

async function doCheck(version: string): Promise<KiroIdcHookCheck> {
  let tmpDir: string | null = null;
  try {
    const emptyDb = await createEmptyAuthDb();
    tmpDir = emptyDb.tmpDir;
    return await runWhoamiCheck(emptyDb.dbPath, version);
  } catch (e: unknown) {
    return {
      supported: false,
      version,
      error: `IAM Identity Center isolation self-check failed: ${String((e as Error)?.message ?? e)}`,
    };
  } finally {
    if (tmpDir) {
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }
}

function sanitiseDiagnosticOutput(text: string): string {
  return text
    .replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, '[redacted]')
    .replace(/https?:\/\/\S+/g, '[redacted-url]');
}

function runWhoamiCheck(emptyDbPath: string, version: string): Promise<KiroIdcHookCheck> {
  return new Promise((resolve) => {
    const { cmd, fullArgs } = resolveKiroCmd(['whoami']);
    const checkEnv: NodeJS.ProcessEnv = { ...process.env, [KIRO_TEST_DB_ENV]: emptyDbPath };

    let stdout = '';
    let stderr = '';
    let settled = false;
    function settle(r: KiroIdcHookCheck): void {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, fullArgs, {
        env: checkEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      settle({
        supported: false,
        version,
        error: err.code === 'ENOENT'
          ? 'kiro-cli is not installed or not on PATH.'
          : `Failed to start kiro-cli: ${err.message}`,
      });
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    child.on('error', (e: NodeJS.ErrnoException) => {
      settle({
        supported: false,
        version,
        error: e.code === 'ENOENT'
          ? 'kiro-cli is not installed or not on PATH.'
          : `Failed to run kiro-cli whoami: ${e.message}`,
      });
    });

    child.on('close', (code) => {
      const combined = (stdout + stderr).toLowerCase();
      const explicitlyNotLoggedIn =
        combined.includes('not signed in') ||
        combined.includes('not logged in');

      if (explicitlyNotLoggedIn) {
        settle({ supported: true, version });
        return;
      }

      const explicitlyLoggedIn =
        combined.includes('logged in') ||
        combined.includes('signed in');

      if (explicitlyLoggedIn) {
        settle({ supported: false, version });
        return;
      }

      const stderrTail = sanitiseDiagnosticOutput(
        stderr.trim().split('\n').slice(-3).join(' ').trim(),
      );
      settle({
        supported: false,
        version,
        error: `kiro-cli whoami self-check inconclusive (exit ${code ?? 'null'}): ${stderrTail || '(no stderr)'}`,
      });
    });

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ok */ }
      settle({
        supported: false,
        version,
        error: 'kiro-cli whoami timed out during the per-user isolation self-check.',
      });
    }, 5_000).unref();

    child.on('close', () => clearTimeout(timer));
  });
}
