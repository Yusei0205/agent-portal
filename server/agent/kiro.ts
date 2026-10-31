/**
 * Kiro engine — runs agent workflows through kiro-cli headless mode.
 *
 * Spawns: kiro-cli chat --no-interactive [--agent <leadAgent>] [--trust-all-tools]
 *
 * Auth: KIRO_API_KEY from portal settings, or the user's existing kiro-cli login.
 *
 * Guardrails: tool trust is enforced at the CLI level:
 *   - trusted workflow   → --trust-all-tools (kiro proceeds without per-tool prompts)
 *   - untrusted workflow → kiro-cli uses its own default deny-on-ask behaviour in
 *     non-interactive mode; no flag is passed so individual tool prompts are skipped
 *     and the CLI blocks rather than silently proceeds.
 *
 * Machine-readable output (--output=json) is attempted first; if the installed
 * version does not support the flag the engine falls back to plain-text streaming.
 *
 * Requirements:
 *   D-12: if kiro-cli is missing the run fails with a clear, actionable error.
 *         No silent fallback to demo.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { run as dbRun, insert, one, getDb } from '../db.ts';
import type { Row } from '../db.ts';
import { now, generateId, HttpError } from '../util.ts';
import { getAgentEnv, getSettings, getSetting } from '../settings.ts';
import { resolveCredentialEnv, IDC_TOKEN_KEY, IDC_REGION_KEY, IDC_EXPIRY_KEY, IDC_START_URL_KEY, IDC_REFRESH_TOKEN_KEY, IDC_CLIENT_ID_KEY, IDC_CLIENT_SECRET_KEY, IDC_CLIENT_SECRET_EXPIRES_AT_KEY, IDC_PROFILE_ARN_KEY, IDC_PROFILE_NAME_KEY, refreshIdcCredentialToken } from '../credentials.ts';
import { getRunHomeDir } from '../user-config.ts';
import type { RunContext } from './types.ts';
import { getDelegationSettings, createRunToken, revokeRunToken } from '../delegation.ts';
import { config } from '../config.ts';
import { materialiseKiroAuthDb, cleanupKiroAuthDb, KIRO_TEST_DB_ENV, readKiroAuthDbToken } from '../kiro-idc.ts';
import { checkKiroIdcHookSupport } from '../kiro-idc-check.ts';

// ── Availability check ────────────────────────────────────────────────────────

function spawnCheck(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', shell: false, windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      setTimeout(() => { try { child.kill(); } catch { /* ok */ } resolve(false); }, 5_000).unref();
    } catch {
      resolve(false);
    }
  });
}

async function assertKiroAvailable(): Promise<void> {
  const ok = await spawnCheck('kiro-cli', ['--version']);
  if (!ok) {
    throw new HttpError(
      502,
      'kiro-cli is not installed or not on PATH. ' +
        'Install it via Settings › Tool packs › Kiro CLI, or visit https://kiro.dev/downloads.',
    );
  }
}

// ── Process spawning ──────────────────────────────────────────────────────────

/** The kiro-cli command. PORTAL_KIRO_FAKE replaces it with a Node.js mock in tests. */
function kiroCommand(args: string[]): { cmd: string; fullArgs: string[] } {
  const fake = process.env.PORTAL_KIRO_FAKE;
  if (fake) return { cmd: process.execPath, fullArgs: [fake, 'chat', '--no-interactive', ...args] };
  return { cmd: 'kiro-cli', fullArgs: ['chat', '--no-interactive', ...args] };
}

// ── JSON output line parsing ──────────────────────────────────────────────────

interface KiroJsonLine {
  type: string;
  text?: string;
  tool?: string;
  toolInput?: string;
  toolOutput?: string;
  tokens?: number;
  credits?: number;
  [k: string]: unknown;
}

function tryParseJsonLine(line: string): KiroJsonLine | null {
  if (!line.startsWith('{')) return null;
  try {
    return JSON.parse(line) as KiroJsonLine;
  } catch {
    return null;
  }
}

// ── Review system instructions ────────────────────────────────────────────────

const REVIEW_INSTRUCTIONS = `
You are performing a code review. Read diff.patch (if present) and the source files it touches.
Identify real defects, security risks, reliability issues, and best-practice violations.

At the end of your response output all findings as a JSON array in a markdown code block:

\`\`\`json
[
  {
    "file": "path/to/file.ext",
    "line": 42,
    "severity": "critical|high|medium|low|info",
    "title": "Short description",
    "body": "Detailed explanation and suggestion.",
    "confidence": 0.9
  }
]
\`\`\`

Use severities: critical, high, medium, low, info.
Set confidence 0.0–1.0. Output [] when the diff is clean.
`.trim();

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run a workflow using kiro-cli headless mode.
 * Emits events via ctx.emit() and returns the final summary text.
 */
export async function runKiro(ctx: RunContext): Promise<string> {
  const { run, emit } = ctx;

  // ── Pre-flight ─────────────────────────────────────────────────────────────
  // D-12: fail with a clear error if kiro-cli is not installed.
  // We skip the availability check when PORTAL_KIRO_FAKE is set (test mode).
  if (!process.env.PORTAL_KIRO_FAKE) {
    await assertKiroAvailable();
  }

  // ── Build env ──────────────────────────────────────────────────────────────
  const agentEnv = await resolveCredentialEnv('kiro', run.credentialOwnerId, run.credentialId);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...agentEnv };

  // ── Wire materialised home dir (F5) ────────────────────────────────────────
  // materialiseForRun() runs before the engine is called (see runner.ts).
  // getRunHomeDir() returns the registered path if materialisation succeeded.
  const homeDir = getRunHomeDir(run.runId);
  if (homeDir) {
    childEnv.HOME = homeDir;
    // USERPROFILE is intentionally NOT overridden on Windows.
    // kiro-cli is packaged with Bun; Bun calls SHGetKnownFolderPath during
    // runtime init and crashes with "error: home directory not found" when
    // USERPROFILE points to a directory that doesn't match the OS-registered
    // user profile.  kiro-cli's own tui.js reads HOME before USERPROFILE, so
    // setting HOME alone is sufficient to redirect config/credential lookups.
  }

  // ── IDC token file delivery (F4) ───────────────────────────────────────────
  // If the credential is identity_center mode, buildEnvFromCred returns sentinel
  // keys (_PORTAL_IDC_*) rather than KIRO_API_KEY.  We write the access token to
  // the standard AWS SSO cache location inside the materialised home so kiro-cli
  // can pick it up (legacy compat), AND materialise a per-user SQLite auth DB for
  // kiro-cli ≥ 2.37 via KIRO_TEST_DB_PATH.  The sentinel keys are removed before
  // spawning so they never reach the child process.
  let kiroAuthTmpDir: string | null = null;
  let originalIdcToken: string | null = null;
  if (childEnv[IDC_TOKEN_KEY]) {
    const idcToken = String(childEnv[IDC_TOKEN_KEY]);
    originalIdcToken = idcToken;
    const idcRegion = String(childEnv[IDC_REGION_KEY] ?? 'us-east-1');
    const idcExpiry = String(childEnv[IDC_EXPIRY_KEY] ?? new Date(Date.now() + 28_800_000).toISOString());
    const idcStartUrl = String(childEnv[IDC_START_URL_KEY] ?? '');
    const idcRefreshToken = childEnv[IDC_REFRESH_TOKEN_KEY] ? String(childEnv[IDC_REFRESH_TOKEN_KEY]) : undefined;
    const idcClientId = childEnv[IDC_CLIENT_ID_KEY] ? String(childEnv[IDC_CLIENT_ID_KEY]) : undefined;
    const idcClientSecret = childEnv[IDC_CLIENT_SECRET_KEY] ? String(childEnv[IDC_CLIENT_SECRET_KEY]) : undefined;
    const idcClientSecretExpiresAt = childEnv[IDC_CLIENT_SECRET_EXPIRES_AT_KEY]
      ? Number(childEnv[IDC_CLIENT_SECRET_EXPIRES_AT_KEY])
      : undefined;

    // 1. Legacy: write device-sso-lsp-token.json for kiro-cli < 2.37 (Linux/macOS compat).
    if (homeDir) {
      try {
        const ssoCacheDir = path.join(homeDir, '.aws', 'sso', 'cache');
        await fsp.mkdir(ssoCacheDir, { recursive: true });
        await fsp.writeFile(
          path.join(ssoCacheDir, 'device-sso-lsp-token.json'),
          JSON.stringify({ accessToken: idcToken, expiresAt: idcExpiry, region: idcRegion }),
          'utf8',
        );
      } catch {
        // Non-fatal: kiro-cli may still have a valid session from a prior login
      }
    }

    // 2. Modern: materialise per-user SQLite auth DB for kiro-cli ≥ 2.37.
    // First verify the hook is honoured — if it isn't, kiro-cli would silently
    // run under the portal machine's own IAM Identity Center session instead of
    // the user's credential, which is a silent identity leak.
    const hookCheck = await checkKiroIdcHookSupport();
    if (!hookCheck.supported) {
      throw new HttpError(
        502,
        hookCheck.error ??
          `Your Kiro IAM Identity Center credential cannot be isolated from the portal ` +
          `machine's own kiro-cli session (kiro-cli ${hookCheck.version} does not honour ` +
          `the per-user authentication hook). ` +
          'Use a Kiro API key credential instead.',
      );
    }

    // Materialise the per-user auth DB — fail loudly if this throws so the run
    // never proceeds under the wrong identity.
    try {
      const idcProfileArn = childEnv[IDC_PROFILE_ARN_KEY] ? String(childEnv[IDC_PROFILE_ARN_KEY]) : undefined;
      const idcProfileName = childEnv[IDC_PROFILE_NAME_KEY] ? String(childEnv[IDC_PROFILE_NAME_KEY]) : undefined;
      const authDb = await materialiseKiroAuthDb({
        accessToken: idcToken,
        expiresAt: idcExpiry,
        region: idcRegion,
        startUrl: idcStartUrl,
        refreshToken: idcRefreshToken,
        clientId: idcClientId,
        clientSecret: idcClientSecret,
        clientSecretExpiresAt: idcClientSecretExpiresAt,
        profileArn: idcProfileArn,
        profileName: idcProfileName,
      });
      kiroAuthTmpDir = authDb.tmpDir;
      childEnv[KIRO_TEST_DB_ENV] = authDb.dbPath;
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? e);
      throw new HttpError(
        502,
        `Could not create the per-user Kiro authentication database: ${msg}. ` +
          'Ensure the system temp directory is writable and try again.',
      );
    }

    delete childEnv[IDC_TOKEN_KEY];
    delete childEnv[IDC_REGION_KEY];
    delete childEnv[IDC_EXPIRY_KEY];
    delete childEnv[IDC_START_URL_KEY];
    delete childEnv[IDC_REFRESH_TOKEN_KEY];
    delete childEnv[IDC_CLIENT_ID_KEY];
    delete childEnv[IDC_CLIENT_SECRET_KEY];
    delete childEnv[IDC_CLIENT_SECRET_EXPIRES_AT_KEY];
    delete childEnv[IDC_PROFILE_ARN_KEY];
    delete childEnv[IDC_PROFILE_NAME_KEY];
  }

  // ── Build CLI args ─────────────────────────────────────────────────────────
  const extraArgs: string[] = [];

  if (run.trusted) {
    extraArgs.push('--trust-all-tools');
  }

  if (run.leadAgent) {
    extraArgs.push('--agent', run.leadAgent);
  }

  if (run.model) {
    extraArgs.push('--model', run.model);
  } else {
    // Apply portal default model when provider mode is kiro and no per-workflow model was set.
    // "auto" is deliberately NOT passed — omitting --model and passing --model auto are equivalent;
    // kiro-cli picks automatically in both cases.
    const settings = getSettings();
    if (settings.provider.mode === 'kiro') {
      const dm = (getSetting(getDb(), 'default.model') ?? '').trim();
      if (dm && dm !== 'auto') {
        extraArgs.push('--model', dm);
      }
    }
  }

  // ── Delegation: merge portal-delegation MCP server into materialised home (F7) ─
  // Kiro loads MCP servers from ~/.kiro/settings/mcp.json.
  // We create a short-lived delegate token and merge the portal-delegation entry into
  // the existing config (preserving any other MCP servers the user has configured).
  // If the file contains invalid JSON, we skip delegation and emit a run event rather
  // than wiping the user's config.
  //
  // Entry format per Kiro CLI documentation for HTTP MCP servers:
  // https://kiro.dev/docs/mcp/configuration/
  // { mcpServers: { name: { url: "...", headers: { Authorization: "Bearer ..." } } } }
  let delegationTokenId: string | null = null;
  if (homeDir && run.credentialOwnerId) {
    try {
      const delegationSettings = getDelegationSettings();
      if (delegationSettings.enabled) {
        const { raw: tokenRaw, tokenId } = createRunToken(run.credentialOwnerId, run.workflowId);
        delegationTokenId = tokenId;

        const portalPort = config.port;
        const newEntry = {
          // Direct url/headers — the nested transport.{type,url,headers} shape is wrong;
          // Kiro uses the flat format: https://kiro.dev/docs/mcp/configuration/
          url: `http://127.0.0.1:${portalPort}/api/mcp`,
          headers: {
            Authorization: `Bearer ${tokenRaw}`,
          },
        };

        const settingsDir = path.join(homeDir, '.kiro', 'settings');
        await fsp.mkdir(settingsDir, { recursive: true });
        const mcpJsonPath = path.join(settingsDir, 'mcp.json');

        // Read existing config (F5 materialised it); merge our entry in.
        // If the existing file is invalid JSON, skip delegation rather than wiping it.
        let existingConfig: { mcpServers?: Record<string, unknown> } = {};
        let skipDelegation = false;
        try {
          const existing = await fsp.readFile(mcpJsonPath, 'utf8').catch(() => '');
          if (existing.trim()) {
            existingConfig = JSON.parse(existing) as typeof existingConfig;
          }
        } catch {
          emit('run', {
            text: 'Portal delegation skipped: ~/.kiro/settings/mcp.json contains invalid JSON. ' +
              'Fix the file to enable the delegate_session tool for future runs.',
          });
          revokeRunToken(tokenId);
          delegationTokenId = null;
          skipDelegation = true;
        }

        if (!skipDelegation) {
          const merged: { mcpServers: Record<string, unknown> } = {
            ...existingConfig,
            mcpServers: {
              ...(existingConfig.mcpServers ?? {}),
              'portal-delegation': newEntry,
            },
          };
          await fsp.writeFile(mcpJsonPath, JSON.stringify(merged, null, 2), 'utf8');
        }
      }
    } catch {
      // Non-fatal: kiro will run without the delegation tool
    }
  }

  // ── Build prompt ───────────────────────────────────────────────────────────
  let prompt = run.goal;
  if (run.kind === 'review') {
    prompt = `${run.goal}\n\n${REVIEW_INSTRUCTIONS}`;
  }

  // ── Determine output mode ──────────────────────────────────────────────────
  // Real kiro-cli does not support machine-readable JSON output for the chat
  // command (--output-format only accepts 'never'/'auto' for wrapping control).
  // JSON line-by-line mode is only enabled when PORTAL_KIRO_FAKE is set (tests),
  // allowing the fake binary to emit structured JSON via PORTAL_FAKE_KIRO_SCENARIO=json.
  // Tests can also force text mode via PORTAL_KIRO_TEXT_MODE=1.
  const useJson = Boolean(process.env.PORTAL_KIRO_FAKE) && !process.env.PORTAL_KIRO_TEXT_MODE;
  const jsonArgs = useJson ? ['--output-format', 'json'] : [];

  const { cmd, fullArgs } = kiroCommand([...extraArgs, ...jsonArgs]);

  // ── Spawn ──────────────────────────────────────────────────────────────────
  const child = spawn(cmd, fullArgs, {
    cwd: run.workDir,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Forward abort signal
  const onAbort = (): void => {
    try { child.kill('SIGTERM'); } catch { /* ok */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ok */ } }, 2_000).unref();
  };

  if (ctx.signal?.aborted) {
    onAbort();
  } else if (ctx.signal) {
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  }

  // ── Write prompt to stdin ──────────────────────────────────────────────────
  try {
    child.stdin.write(prompt + '\n');
    child.stdin.end();
  } catch {
    // stdin may already be closed if the process errored immediately
  }

  // ── Stream and parse output ────────────────────────────────────────────────
  const textParts: string[] = [];
  let kiroCredits = 0;
  let jsonModeFailed = false;

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2_000);
    if (process.env.PORTAL_DEBUG_SDK) process.stderr.write(`[kiro] ${chunk}`);
  });

  child.stdout?.setEncoding('utf8');
  let lineBuf = '';

  child.stdout?.on('data', (chunk: string) => {
    lineBuf += chunk;
    let nl: number;
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl).trimEnd();
      lineBuf = lineBuf.slice(nl + 1);

      if (!line) continue;

      if (useJson && !jsonModeFailed) {
        const parsed = tryParseJsonLine(line);
        if (parsed) {
          handleKiroJsonLine(parsed, ctx, textParts);
          if (parsed.credits) kiroCredits = parsed.credits;
          continue;
        }
        // Non-JSON line in JSON mode means kiro-cli doesn't support --output=json;
        // treat remaining output as plain text
        jsonModeFailed = true;
      }

      // Plain-text mode: each non-empty line is assistant text
      if (line.trim()) {
        emit('assistant-text', { text: line + '\n' });
        textParts.push(line);
      }
    }
  });

  // ── Wait for child exit ────────────────────────────────────────────────────
  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') {
          reject(
            new HttpError(
              502,
              'kiro-cli was not found on PATH (ENOENT). ' +
                'Install it via Settings › Tool packs › Kiro CLI.',
            ),
          );
        } else {
          reject(new HttpError(502, `Could not start kiro-cli: ${e.message}`));
        }
      });
      child.on('close', (code) => resolve(code));
    });
  } finally {
    // Always clean up signal listener and revoke the delegate token,
    // regardless of whether the run succeeded or threw.
    if (ctx.signal) {
      ctx.signal.removeEventListener('abort', onAbort);
    }
    if (delegationTokenId) {
      revokeRunToken(delegationTokenId);
      delegationTokenId = null;
    }

    // Remove the portal-delegation entry from mcp.json so no token lingers
    // in the materialised home after the run ends.
    if (homeDir) {
      const mcpJsonPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json');
      try {
        const raw = await fsp.readFile(mcpJsonPath, 'utf8').catch(() => '');
        if (raw.trim()) {
          const cfg = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
          if (cfg.mcpServers?.['portal-delegation']) {
            delete cfg.mcpServers['portal-delegation'];
            await fsp.writeFile(mcpJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
          }
        }
      } catch {
        // Non-fatal — best effort
      }

      // Delete decrypted AWS credentials from the materialised home so they
      // do not persist after the run ends (success or failure).
      const awsDir = path.join(homeDir, '.aws');
      try {
        await fsp.rm(awsDir, { recursive: true, force: true });
      } catch {
        // Non-fatal
      }
    }

    // Clean up the per-user kiro-cli auth DB (KIRO_TEST_DB_PATH).
    if (kiroAuthTmpDir) {
      // Write-back: if kiro-cli refreshed the access_token during the run, the
      // new token will be in the temp DB. Read it back and update the credential
      // so the user's sign-in stays valid. Do this before cleanup.
      if (run.credentialId && originalIdcToken) {
        try {
          const dbPath = path.join(kiroAuthTmpDir, 'data.sqlite3');
          const newToken = readKiroAuthDbToken(dbPath);
          if (newToken && newToken.access_token !== originalIdcToken) {
            await refreshIdcCredentialToken(
              run.credentialId,
              newToken.access_token,
              newToken.expires_at,
              newToken.refresh_token,
            );
          }
        } catch {
          // Non-fatal — best effort write-back; worst case user re-authenticates
        }
      }
      await cleanupKiroAuthDb(kiroAuthTmpDir);
      kiroAuthTmpDir = null;
    }
  }

  if (ctx.signal?.aborted) {
    throw new DOMException('Run cancelled', 'AbortError');
  }

  if (exitCode !== 0 && exitCode !== null) {
    const tail = stderrTail.trim().slice(-500);
    throw new HttpError(
      502,
      `kiro-cli exited with code ${exitCode}.` + (tail ? ` ${tail}` : ''),
    );
  }

  // Flush remaining buffer
  if (lineBuf.trim()) {
    emit('assistant-text', { text: lineBuf.trim() + '\n' });
    textParts.push(lineBuf.trim());
  }

  // ── Persist run stats ──────────────────────────────────────────────────────
  // Kiro reports credits, not USD. Store raw credit count as approximate cost
  // (kiro credits ≈ USD cents for reference; no official conversion).
  const approxCostUsd = Number(kiroCredits.toFixed(4));

  dbRun(
    `UPDATE p6_runs
        SET cost_usd = ?, input_tokens = ?, output_tokens = ?,
            cache_write_tokens = ?, cache_read_tokens = ?,
            model = ?
      WHERE id = ?`,
    approxCostUsd,
    0,
    0,
    0,
    0,
    run.model ?? run.leadAgent ?? 'kiro',
    run.runId,
  );

  if (approxCostUsd > 0) {
    const wfRow = one<Row>('SELECT created_by FROM p6_workflows WHERE id = ?', run.workflowId);
    insert('budget_usage', {
      user_id: (wfRow?.created_by as string | null) ?? null,
      project_id: run.projectId,
      workflow_id: run.workflowId,
      run_id: null,
      cost_usd: approxCostUsd,
      input_tokens: 0,
      output_tokens: 0,
      provider: 'kiro',
      model: run.leadAgent ?? 'kiro-default',
      created_at: now(),
    });
  }

  const summary = textParts.join('\n').trim() || 'Kiro run complete.';
  emit('run-complete', { result: summary, cost_usd: approxCostUsd });
  return summary;
}

// ── JSON line handler ─────────────────────────────────────────────────────────

function handleKiroJsonLine(
  line: KiroJsonLine,
  ctx: RunContext,
  textParts: string[],
): void {
  const { emit } = ctx;

  switch (line.type) {
    case 'text':
    case 'assistant_text':
    case 'message': {
      const text = String(line.text ?? '').trim();
      if (text) {
        emit('assistant-text', { text });
        textParts.push(text);
      }
      break;
    }
    case 'tool_start':
    case 'tool_use': {
      const toolName = String(line.tool ?? line.toolName ?? 'Tool');
      const toolInput = line.toolInput ?? line.input ?? '';
      const toolInputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
      emit('tool-start', { toolName, toolInput: toolInputStr });
      break;
    }
    case 'tool_end':
    case 'tool_result': {
      const toolName = String(line.tool ?? line.toolName ?? 'Tool');
      const output = String(line.toolOutput ?? line.output ?? line.result ?? '').slice(0, 500);
      emit('tool-end', { toolName, output });
      break;
    }
    case 'tool_blocked': {
      const toolName = String(line.tool ?? line.toolName ?? 'Tool');
      const reason = String(line.reason ?? 'Blocked');
      const toolInput = line.toolInput ?? line.input ?? '';
      const toolInputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
      emit('tool-blocked', { toolName, toolInput: toolInputStr, reason });
      break;
    }
    case 'error':
    case 'run_error': {
      // Don't emit run-failed here — let the exit code handler deal with it
      break;
    }
    default:
      // Unknown event type; ignore silently
      break;
  }
}
