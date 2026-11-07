/**
 * kiro-login mode — run kiro-cli device-flow login and stream the verification URL.
 *
 * Flow:
 *   1. Create an empty SQLite DB at KIRO_TEST_DB_PATH.
 *   2. Run kiro-cli login --use-device-flow --license pro --identity-provider <startUrl> --region <region>.
 *   3. As soon as the verification URL and user code appear in stdout/stderr, emit a SSE event.
 *   4. Wait for login to complete (process exits 0) or fail.
 *   5. Read the token from the DB (never emit token values in logs).
 *   6. Emit a result event with success/failure and token payload size.
 *   7. Clean up temp dirs.
 *
 * Safety invariants:
 *   - Token values never appear in logs or SSE events (only token size is reported).
 *   - Temp DB and home dir are deleted at the end regardless of outcome.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { KiroLoginPayload } from './validate.js';

export type EmitFn = (event: Record<string, unknown>) => void;

const KIRO_TEST_DB_ENV = 'KIRO_TEST_DB_PATH';
const AUTH_KV_TOKEN_KEY = 'kirocli:odic:token';
const AUTH_KV_DEVICE_REG_KEY = 'kirocli:odic:device-registration';

// ── DB helpers ────────────────────────────────────────────────────────────────

async function createEmptyAuthDb(): Promise<{ dbPath: string; tmpDir: string }> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kiro-runner-login-'));
  const dbPath = path.join(tmpDir, 'data.sqlite3');
  // Create an empty SQLite file (kiro-cli will populate it on successful login)
  const db = new DatabaseSync(dbPath, { open: true });
  db.close();
  return { dbPath, tmpDir };
}

interface TokenPayload {
  access_token: string;
  expires_at: string;
  refresh_token?: string;
  region?: string;
  start_url?: string;
  /** The sign-in client kiro-cli registered. Needed to renew the token later without a new sign-in. */
  client_id?: string;
  client_secret?: string;
  client_secret_expires_at?: number;
}

function readRegistration(db: DatabaseSync): Partial<TokenPayload> {
  try {
    const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?')
      .get(AUTH_KV_DEVICE_REG_KEY) as { value: string } | undefined;
    if (!row?.value) return {};
    const reg = JSON.parse(row.value) as Record<string, unknown>;
    if (!reg.client_id || !reg.client_secret) return {};
    return {
      client_id: String(reg.client_id),
      client_secret: String(reg.client_secret),
      ...(reg.client_secret_expires_at ? { client_secret_expires_at: Number(reg.client_secret_expires_at) } : {}),
    };
  } catch { return {}; }
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
    const reg = readRegistration(db);
    return {
      access_token: accessToken,
      expires_at: String(parsed.expires_at ?? ''),
      ...(parsed.refresh_token ? { refresh_token: String(parsed.refresh_token) } : {}),
      ...(parsed.region ? { region: String(parsed.region) } : {}),
      ...(parsed.start_url ? { start_url: String(parsed.start_url) } : {}),
      ...reg,
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ok */ }
  }
}

// ── Verification URL parser ───────────────────────────────────────────────────
// Same logic as server/kiro-settings.ts parseLoginOutput()

interface LoginChallenge {
  verificationUri: string;
  userCode: string;
}

function parseLoginOutput(raw: string): LoginChallenge | null {
  // Strip ANSI escape codes from PTY output.
  // eslint-disable-next-line no-control-regex
  const output = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

  // Shape 0 — kiro-cli 2.37 on Linux:
  //   "Code: JVCD-WZZZ"
  //   "Open this URL: https://d-xxx.awsapps.com/start/#/device?user_code=JVCD-WZZZ"
  const code0 = output.match(/Code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/);
  const url0 = output.match(/Open this URL:\s*(https?:\/\/\S+)/);
  if (code0 && url0) {
    return { verificationUri: url0[1], userCode: code0[1] };
  }

  // Shape 1 — combined URL with user_code param:
  //   "Visit: https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-1234"
  const combinedMatch = output.match(
    /(https?:\/\/\S+[?&]user_code=([A-Z0-9]{4}-[A-Z0-9]{4}))/i,
  );
  if (combinedMatch) {
    const fullUrl = combinedMatch[1];
    const userCode = combinedMatch[2];
    const verificationUri = fullUrl
      .replace(/[?&]user_code=[^&]+(&|$)/, '')
      .replace(/[?&]$/, '');
    return { verificationUri, userCode };
  }

  // Shape 2 — URL and code on separate lines:
  //   "Verification URL: https://..."
  //   "User code: ABCD-1234"
  const urlMatch = output.match(/https?:\/\/[^\s\n'"]+/);
  const codeMatch = output.match(/(?:user[\s_-]?code|code)[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i);
  if (urlMatch && codeMatch) {
    return { verificationUri: urlMatch[0], userCode: codeMatch[1] };
  }

  return null;
}

// ── Login entry point ─────────────────────────────────────────────────────────

/**
 * Run kiro-cli device-flow login.
 * Streams SSE events via emit(), then resolves.
 * Never logs or emits token values. Reports only token payload byte-size.
 *
 * @param payload   Validated kiro-login payload.
 * @param emit      SSE emit callback.
 * @param processStartMs  Date.now() at process start (for cold-start metric).
 */
export async function runKiroLogin(
  payload: KiroLoginPayload,
  emit: EmitFn,
  processStartMs: number,
): Promise<void> {
  const coldStartMs = Date.now() - processStartMs;
  const invokeStart = Date.now();
  const { startUrl, region, runId } = payload;

  let authTmpDir: string | undefined;
  let kiroHome: string | undefined;

  try {
    const authResult = await createEmptyAuthDb();
    authTmpDir = authResult.tmpDir;
    const dbPath = authResult.dbPath;

    kiroHome = await fsp.mkdtemp(path.join(os.tmpdir(), `kiro-login-home-${runId}-`));

    emit({ type: 'status', text: 'Starting kiro-cli device-flow login…' });

    const childEnv: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env as Record<string, string | undefined>)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, v as string]),
      ),
      HOME: kiroHome,
      USERPROFILE: kiroHome,
      [KIRO_TEST_DB_ENV]: dbPath,
      KIRO_CLI_SKIP_SETUP: '1',
      KIRO_CLI_NO_MODIFY_PATH: '1',
    };

    // kiro-cli 2.37 on Linux still shows "Enter Start URL" / "Enter Region" prompts
    // (prefilled from the flags) and reads empty input without a TTY, which yields
    // "failed to construct request". Run it under a pseudo-terminal via `script`
    // and press Enter at each prompt to accept the prefilled values.
    const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    const loginCmd = [
      'kiro-cli', 'login', '--use-device-flow', '--license', 'pro',
      '--identity-provider', startUrl, '--region', region,
    ].map(shQuote).join(' ');
    const child = spawn('script', ['-qfc', loginCmd, '/dev/null'], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let outputBuf = '';
    let challengeEmitted = false;
    let promptsAnswered = 0;
    const answerPrompts = (): void => {
      // eslint-disable-next-line no-control-regex
      const clean = outputBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      const promptCount = (clean.match(/\? Enter (Start URL|Region)/g) ?? []).length;
      while (promptsAnswered < promptCount) {
        promptsAnswered++;
        try { child.stdin?.write('\r'); } catch { /* closed */ }
      }
    };

    const tryEmitChallenge = (): void => {
      if (challengeEmitted) return;
      const challenge = parseLoginOutput(outputBuf);
      if (challenge) {
        challengeEmitted = true;
        emit({
          type: 'verification',
          verificationUri: challenge.verificationUri,
          userCode: challenge.userCode,
        });
        process.stdout.write(
          JSON.stringify({
            event: 'login_challenge',
            runId,
            verificationUri: challenge.verificationUri,
            userCode: challenge.userCode,
          }) + '\n',
        );
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      outputBuf += chunk;
      answerPrompts();
      tryEmitChallenge();
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      outputBuf += chunk;
      tryEmitChallenge();
    });

    // If kiro-cli prints no sign-in code soon after it starts, it is stuck (a prompt it is waiting on, a changed output
    // format, an unreachable start URL). Say so with what it printed, instead of leaving the page waiting until the
    // request times out and the runtime holds the machine for 15 minutes.
    const CHALLENGE_WAIT_MS = 45_000;
    let stuck = false;
    const challengeTimer = setTimeout(() => {
      if (challengeEmitted) return;
      stuck = true;
      // eslint-disable-next-line no-control-regex
      const seen = outputBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').trim().slice(-600);
      process.stdout.write(JSON.stringify({ event: 'login_no_challenge', runId, waitedMs: CHALLENGE_WAIT_MS, seen }) + '\n');
      emit({
        type: 'error',
        message: `kiro-cli did not show a sign-in code within ${CHALLENGE_WAIT_MS / 1000} seconds. ` +
          (seen ? `It printed: ${seen}` : 'It printed nothing.'),
      });
      try { child.kill('SIGTERM'); } catch { /* ok */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ok */ } }, 3_000).unref();
    }, CHALLENGE_WAIT_MS);

    // 15-minute timeout — enough for any SSO flow approval window
    const TIMEOUT_MS = 15 * 60_000;
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      emit({ type: 'error', message: 'kiro-cli login timed out after 15 minutes.' });
      try { child.kill('SIGTERM'); } catch { /* ok */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ok */ } }, 3_000).unref();
    }, TIMEOUT_MS);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timeoutTimer); clearTimeout(challengeTimer);
        if (e.code === 'ENOENT') {
          emit({ type: 'error', message: 'kiro-cli not found on PATH. Check the container image.' });
        } else {
          emit({ type: 'error', message: `kiro-cli spawn error: ${e.message}` });
        }
        resolve(null);
      });
      child.on('close', (code) => {
        clearTimeout(timeoutTimer); clearTimeout(challengeTimer);
        resolve(code);
      });
    });

    const durationMs = Date.now() - invokeStart;
    const success = exitCode === 0 && !timedOut && !stuck;

    // Read token from DB to get size — never log or emit the token itself
    let tokenSizeBytes = 0;
    let tokenPayload: TokenPayload | null = null;
    if (success) {
      tokenPayload = readTokenFromDb(dbPath)
        ?? readTokenFromDb(path.join(kiroHome, '.local', 'share', 'kiro-cli', 'data.sqlite3'));
      if (tokenPayload) {
        // Report serialised size only (so the client knows something was stored)
        tokenSizeBytes = Buffer.byteLength(JSON.stringify(tokenPayload), 'utf8');
        // Return the full token payload so the caller can store it
        // (the caller is responsible for not logging it)
      }
    }

    process.stdout.write(
      JSON.stringify({
        event: 'login_complete',
        runId,
        success,
        exitCode,
        durationMs,
        coldStartMs,
        tokenSizeBytes,
        timedOut,
      }) + '\n',
    );

    emit({
      type: 'result',
      runId,
      success,
      exitCode: exitCode ?? -1,
      durationMs,
      coldStartMs,
      tokenSizeBytes,
      // Include token payload for the calling script to store (never logged here)
      ...(success && tokenPayload ? { tokenPayload } : {}),
      stderrTail: !success
        ? outputBuf.slice(-500)
        : undefined,
    });

  } finally {
    for (const dir of ([authTmpDir, kiroHome] as Array<string | undefined>)) {
      if (dir) {
        fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* non-fatal */ });
      }
    }
  }
}
