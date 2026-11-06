/**
 * Engine model listing endpoint.
 *
 * GET /api/engines/:engine/models?credentialId=<id>&refresh=1
 *
 * Returns the models available for the given engine under the credential that
 * will actually be used when a session starts.  The same credential-resolution
 * order as resolveCredentialEnv() is used so the dropdown always matches reality.
 *
 * Response:
 *   {
 *     models:  Array<{ id: string; label: string }>,
 *     source:  'kiro-cli' | 'bedrock' | 'anthropic' | 'static' | 'none',
 *     runsAs:  { kind: 'credential' | 'portal'; label: string },
 *     error?:  string   // user-actionable; present when models: []
 *   }
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getDb } from './db.ts';
import type { DatabaseSync } from 'node:sqlite';
import { decrypt } from './secrets.ts';
import { config } from './config.ts';
import { openUserCodex, codexUsesCloud } from './codex-auth.ts';
import { getSettings, listModelsForProvider, setBedrockListingMock } from './settings.ts';
import type { BedrockListingMock } from './settings.ts';
import { getSetting } from './settings.ts';
import { IDC_TOKEN_KEY, IDC_REGION_KEY, IDC_EXPIRY_KEY, IDC_START_URL_KEY, IDC_REFRESH_TOKEN_KEY, IDC_CLIENT_ID_KEY, IDC_CLIENT_SECRET_KEY, IDC_CLIENT_SECRET_EXPIRES_AT_KEY, IDC_PROFILE_ARN_KEY, IDC_PROFILE_NAME_KEY, refreshIdcCredentialToken, autoRefreshIdcIfNeeded, ensureKiroProfileFetched } from './credentials.ts';
import { materialiseKiroAuthDb, cleanupKiroAuthDb, KIRO_TEST_DB_ENV, readKiroAuthDbToken } from './kiro-idc.ts';
import { spawnKiroListModels, parseKiroModelsStdout } from './kiro-list-models.ts';
import { listKiroModelsViaAgentCore } from './agent/kiro-agentcore.ts';
import type { KiroTokenPayload } from './agent/kiro-agentcore.ts';
import type { KiroModelRaw } from './kiro-list-models.ts';
import { checkKiroIdcHookSupport } from './kiro-idc-check.ts';
import { getCredentialsRepository } from './repositories/credentials.ts';

// ── Re-export test hook so tests can inject Bedrock mock here too ─────────────

export { setBedrockListingMock };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EngineModelEntry {
  id: string;
  label: string;
  default?: true;
}

export type EngineModelSource = 'codex' | 'kiro-cli' | 'bedrock' | 'anthropic' | 'static' | 'none';

/**
 * Credential isolation status for identity_center credentials.
 *
 * Frontend usage:
 *   - supported: true  → isolation is active; no warning needed.
 *   - supported: false → kiro-cli will run under the portal machine's own
 *     sign-in instead of the user's credential. The UI should warn and
 *     recommend switching to a Kiro API key credential.
 *   - method: 'kiro-test-db' → auth isolation via KIRO_TEST_DB_PATH (kiro-cli ≥ 2.37).
 *   - method: 'idc-file' → legacy device-sso-lsp-token.json (kiro-cli < 2.37, Linux/macOS only).
 * Only present when engine='kiro' and mode='identity_center'.
 */
export interface KiroIdcIsolation {
  supported: boolean;
  method: 'kiro-test-db' | 'idc-file' | 'none';
}

export interface EngineModelsResponse {
  models: EngineModelEntry[];
  source: EngineModelSource;
  runsAs: { kind: 'credential' | 'portal'; label: string };
  error?: string;
  /** Only present for identity_center Kiro credentials. See KiroIdcIsolation. */
  idcIsolation?: KiroIdcIsolation;
}

// ── Cache (10-minute TTL per (engine, credentialId|'portal')) ────────────────

const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  expiry: number;
  response: EngineModelsResponse;
}

const _cache = new Map<string, CacheEntry>();

/** @internal Test hook — clear the engine model listing cache. */
export function _clearEngineModelCache(): void {
  _cache.clear();
}

function cacheKey(engine: string, credId: string): string {
  return `${engine}::${credId}`;
}

function fromCache(engine: string, credId: string): EngineModelsResponse | null {
  const entry = _cache.get(cacheKey(engine, credId));
  if (entry && Date.now() < entry.expiry) return entry.response;
  return null;
}

function toCache(engine: string, credId: string, result: EngineModelsResponse): EngineModelsResponse {
  // Never remember failures or empty lists: the user usually fixes the cause (signs in, adds a key) and expects the next load to work.
  if (result.error || result.models.length === 0) return result;
  _cache.set(cacheKey(engine, credId), { expiry: Date.now() + CACHE_TTL_MS, response: result });
  return result;
}

// ── Credential row helper ─────────────────────────────────────────────────────

import type { CredentialRecord } from './repositories/credentials.ts';
type CredentialRow = CredentialRecord;

function safeJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try { return JSON.parse(String(s)) as Record<string, unknown>; } catch { return {}; }
}

// ── Kiro child-process env builder ───────────────────────────────────────────

/**
 * Build the child-process environment for a `kiro-cli --list-models` invocation.
 *
 * Windows note — do NOT set USERPROFILE to a temp dir:
 * kiro-cli is bundled with Bun, which calls the Windows SHGetKnownFolderPath /
 * SHGetUserProfileDirectory API during runtime initialisation.  That API
 * ignores the USERPROFILE environment variable and returns the OS-registered
 * home directory.  When Bun compares the USERPROFILE env var against the API
 * result and they differ (temp dir vs real home), Bun aborts with
 * "error: home directory not found" before tui.js even starts.
 *
 * kiro-cli's own code (`tui.js`) checks `process.env.HOME` before
 * `process.env.USERPROFILE`, so setting HOME=tmpHome alone is sufficient to
 * redirect its config-directory and `.aws` lookups without touching USERPROFILE.
 *
 * Per-user IDC credential isolation (kiro-cli ≥ 2.37, all platforms):
 * kiro-cli 2.37 stores auth tokens in a SQLite database
 * (%LOCALAPPDATA%\Kiro-Cli\data.sqlite3 on Windows).  It no longer reads
 * ~/.aws/sso/cache/device-sso-lsp-token.json.  Per-user isolation is
 * achieved by setting KIRO_TEST_DB_PATH to a freshly created SQLite database
 * that contains only the user's auth_kv token row.  The caller passes
 * `kiroTestDbPath` with the path to that temp database.
 *
 * Backwards compat: the device-sso-lsp-token.json file is still written to
 * tmpHome for kiro-cli versions < 2.37 running on Linux/macOS.
 *
 * @internal Exported so unit tests can verify env-var construction without spawning.
 */
export function _buildKiroListChildEnv(
  env: Record<string, string>,
  tmpHome: string | null,
  baseEnv: NodeJS.ProcessEnv,
  kiroTestDbPath?: string | null,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv, ...env };
  if (tmpHome) {
    childEnv.HOME = tmpHome;
    // USERPROFILE is intentionally NOT set on win32 — see JSDoc above.
  }
  if (kiroTestDbPath) {
    childEnv[KIRO_TEST_DB_ENV] = kiroTestDbPath;
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
  return childEnv;
}

// ── Kiro model listing ────────────────────────────────────────────────────────

const KIRO_LIST_TIMEOUT_MS = 15_000;

interface KiroListResult {
  models: EngineModelEntry[];
  source: 'kiro-cli';
  error?: string;
}

async function listKiroModels(
  env: Record<string, string>,
  credLabel: string,
  credentialId?: string | null,
): Promise<KiroListResult> {
  // Write IDC token to temp home then run kiro-cli chat --list-models
  // (PORTAL_KIRO_FAKE is handled inside runKiroListModels via process.execPath)
  let tmpHome: string | null = null;
  let kiroAuthTmpDir: string | null = null;
  let kiroTestDbPath: string | null = null;
  const originalIdcToken = env[IDC_TOKEN_KEY] ? String(env[IDC_TOKEN_KEY]) : null;
  try {
    // If IDC token is in the env, materialise credentials in two ways:
    //   1. Legacy: device-sso-lsp-token.json in tmpHome (kiro-cli < 2.37, Linux/macOS compat).
    //   2. Modern: SQLite auth DB via KIRO_TEST_DB_PATH (kiro-cli ≥ 2.37, all platforms).
    if (env[IDC_TOKEN_KEY]) {
      const idcToken = String(env[IDC_TOKEN_KEY]);
      const idcRegion = String(env[IDC_REGION_KEY] ?? 'us-east-1');
      const idcExpiry = String(env[IDC_EXPIRY_KEY] ?? new Date(Date.now() + 28_800_000).toISOString());
      const idcStartUrl = String(env[IDC_START_URL_KEY] ?? '');
      const idcRefreshToken = env[IDC_REFRESH_TOKEN_KEY] ? String(env[IDC_REFRESH_TOKEN_KEY]) : undefined;
      const idcClientId = env[IDC_CLIENT_ID_KEY] ? String(env[IDC_CLIENT_ID_KEY]) : undefined;
      const idcClientSecret = env[IDC_CLIENT_SECRET_KEY] ? String(env[IDC_CLIENT_SECRET_KEY]) : undefined;
      const idcClientSecretExpiresAt = env[IDC_CLIENT_SECRET_EXPIRES_AT_KEY]
        ? Number(env[IDC_CLIENT_SECRET_EXPIRES_AT_KEY])
        : undefined;

      // 1. Legacy file-based approach (tmpHome + device-sso-lsp-token.json).
      tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-kiro-list-'));
      const ssoCacheDir = path.join(tmpHome, '.aws', 'sso', 'cache');
      await fsp.mkdir(ssoCacheDir, { recursive: true });
      await fsp.writeFile(
        path.join(ssoCacheDir, 'device-sso-lsp-token.json'),
        JSON.stringify({ accessToken: idcToken, expiresAt: idcExpiry, region: idcRegion }),
        'utf8',
      );

      // 2. Modern SQLite-based approach (kiro-cli ≥ 2.37).
      // Caller (getEngineModels) has already verified hook support.
      // Do NOT fall back silently on failure — that would run under the machine's session.
      try {
        const authDb = await materialiseKiroAuthDb({
          accessToken: idcToken,
          expiresAt: idcExpiry,
          region: idcRegion,
          startUrl: idcStartUrl,
          refreshToken: idcRefreshToken,
          clientId: idcClientId,
          clientSecret: idcClientSecret,
          clientSecretExpiresAt: idcClientSecretExpiresAt,
          profileArn: env[IDC_PROFILE_ARN_KEY] ? String(env[IDC_PROFILE_ARN_KEY]) : undefined,
          profileName: env[IDC_PROFILE_NAME_KEY] ? String(env[IDC_PROFILE_NAME_KEY]) : undefined,
        });
        kiroAuthTmpDir = authDb.tmpDir;
        kiroTestDbPath = authDb.dbPath;
      } catch (e: unknown) {
        const msg = String((e as Error)?.message ?? e);
        return {
          source: 'kiro-cli',
          models: [],
          error:
            `Could not create the per-user Kiro authentication database: ${msg}. ` +
            'Ensure the system temp directory is writable and try again.',
        };
      }
    }

    // Build child env: strip sentinel keys, inject KIRO_TEST_DB_PATH.
    const childEnv: NodeJS.ProcessEnv = _buildKiroListChildEnv(env, tmpHome, process.env, kiroTestDbPath);

    // Check if --list-models / --output-format json are supported
    // kiro-cli 2.36.0 supports --list-models; prefer JSON output
    const result = await runKiroListModels(childEnv);
    return result;
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e);
    return { source: 'kiro-cli', models: [], error: `kiro-cli --list-models failed: ${msg}` };
  } finally {
    // Write-back: if kiro-cli refreshed the access_token during listing, the new
    // token is in the temp DB. Read it back before cleanup and update the credential.
    if (kiroAuthTmpDir && credentialId && originalIdcToken) {
      try {
        const dbPath = path.join(kiroAuthTmpDir, 'data.sqlite3');
        const newToken = readKiroAuthDbToken(dbPath);
        if (newToken && newToken.access_token !== originalIdcToken) {
          await refreshIdcCredentialToken(
            credentialId,
            newToken.access_token,
            newToken.expires_at,
            newToken.refresh_token,
          );
        }
      } catch {
        // Non-fatal — best effort write-back
      }
    }
    if (tmpHome) {
      try { await fsp.rm(tmpHome, { recursive: true, force: true }); } catch { /* non-fatal */ }
    }
    if (kiroAuthTmpDir) {
      await cleanupKiroAuthDb(kiroAuthTmpDir);
    }
  }
}

// ── Plain-text table parser ───────────────────────────────────────────────────

// Line format (kiro-cli --output-format text):
//   [* | ] <id>   <N.NNx> credits   <description>
// The '*' marker indicates the default model.
const MODEL_ROW_RE = /^([* ]) +(\S+) +(\d+\.\d+x) +credits(.*)/;

/**
 * Parse the plain-text table printed by `kiro-cli chat --list-models --output-format text`.
 *
 * Exported so it can be unit-tested independently of the CLI spawn.
 *
 * @param output  Raw stdout captured from kiro-cli
 * @returns       Parsed entries, or an error result when nothing could be parsed
 */
export function parseKiroModelsTable(output: string): KiroListResult {
  const models: EngineModelEntry[] = [];
  for (const raw of output.split('\n')) {
    const m = MODEL_ROW_RE.exec(raw);
    if (!m) continue; // header, blank line, or garbage → skip
    const [, star, id, multiplier, rest] = m;
    const description = rest.trim();
    const label = description
      ? `${id} — ${description} (${multiplier} credits)`
      : `${id} (${multiplier} credits)`;
    const entry: EngineModelEntry = { id, label };
    if (star === '*') entry.default = true;
    models.push(entry);
  }
  if (models.length === 0) {
    return { source: 'kiro-cli', models: [], error: 'kiro-cli --list-models returned no models.' };
  }
  return { source: 'kiro-cli', models };
}

// ── Raw-to-entry transform ────────────────────────────────────────────────────

/**
 * Transform a KiroModelRaw entry (from JSON or plain-text parse) into an
 * EngineModelEntry with a label matching the plain-text table format exactly:
 *   "<id> — <description> (<N.NNx> credits)"
 *
 * This keeps the label format consistent whether data came from JSON or plain text.
 */
function kiroRawToEngineEntry(m: KiroModelRaw): EngineModelEntry {
  const rateStr = m.rate_multiplier != null ? `${m.rate_multiplier.toFixed(2)}x` : null;
  const desc = (m.description ?? '').trim();
  let label: string;
  if (desc && rateStr) {
    label = `${m.model_id} — ${desc} (${rateStr} credits)`;
  } else if (desc) {
    label = `${m.model_id} — ${desc}`;
  } else if (rateStr) {
    label = `${m.model_id} (${rateStr} credits)`;
  } else {
    label = m.model_id;
  }
  const entry: EngineModelEntry = { id: m.model_id, label };
  if (m.is_default) entry.default = true;
  return entry;
}

// ── CLI spawner ───────────────────────────────────────────────────────────────

async function runKiroListModels(env: NodeJS.ProcessEnv): Promise<KiroListResult> {
  const rawResult = await spawnKiroListModels(env, KIRO_LIST_TIMEOUT_MS);

  if (rawResult.error) {
    return { source: 'kiro-cli', models: [], error: rawResult.error };
  }

  if (rawResult.models.length === 0) {
    return { source: 'kiro-cli', models: [], error: 'kiro-cli --list-models returned no models.' };
  }

  return { source: 'kiro-cli', models: rawResult.models.map(kiroRawToEngineEntry) };
}

// ── Static subscription model list ───────────────────────────────────────────

const SUBSCRIPTION_MODELS: EngineModelEntry[] = [
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

// ── Core listing logic ────────────────────────────────────────────────────────

/**
 * Resolve and return models for the given engine + credential context.
 * `userId` is the authenticated user's ID; `requestedCredentialId` may be null.
 */
export async function getEngineModels(
  engine: 'kiro' | 'claude-code' | 'codex',
  userId: string,
  requestedCredentialId: string | null,
  refresh: boolean,
): Promise<EngineModelsResponse> {
  if (engine === 'codex') {
    const runsAs = { kind: 'credential' as const, label: 'Your Codex ChatGPT sign-in' };
    if (requestedCredentialId) return { models: [], source: 'none', runsAs, error: 'Codex uses your own Codex sign-in, not a Kiro or Claude credential.' };
    let client: Awaited<ReturnType<typeof openUserCodex>> | undefined;
    try {
      if (codexUsesCloud()) {
        const { listCodexModelsViaAgentCore } = await import('./agent/codex-agentcore.ts');
        return { models: await listCodexModelsViaAgentCore(userId), source: 'codex', runsAs };
      }
      client = await openUserCodex(userId);
      const account = await client.request('account/read', { refreshToken: false });
      if (account.account?.type !== 'chatgpt') return { models: [], source: 'codex', runsAs, error: 'Sign in to Codex in Connect > Agent sign-ins.' };
      const models: EngineModelEntry[] = [];
      let cursor: string | null = null;
      do {
        const page = await client.request('model/list', { cursor, limit: 100 });
        for (const m of page.data ?? []) models.push({ id: m.model, label: m.displayName ?? m.model, ...(m.isDefault ? { default: true as const } : {}) });
        cursor = page.nextCursor ?? null;
      } while (cursor);
      return { models, source: 'codex', runsAs };
    } catch {
      return { models: [], source: 'codex', runsAs, error: 'Could not list Codex models. Check Codex installation and sign-in in Connect > Agent sign-ins.' };
    } finally { client?.close(); }
  }

  // ── 1. Resolve which credential to use ──────────────────────────────────
  let cred: CredentialRow | null = null;
  let runsAs: EngineModelsResponse['runsAs'];

  if (requestedCredentialId) {
    const found = await getCredentialsRepository().getByIdAndUser(requestedCredentialId, userId);
    if (!found || found.engine !== engine) {
      return {
        models: [],
        source: 'none',
        runsAs: { kind: 'credential', label: 'unknown' },
        error: 'Credential not found or does not belong to you.',
      };
    }
    cred = found;
    runsAs = { kind: 'credential', label: String(cred.name) };
  } else {
    // Try user's default credential for this engine
    const defaultCred = await getCredentialsRepository().getDefaultByUserAndEngine(userId, engine);
    if (defaultCred) {
      cred = defaultCred;
      runsAs = { kind: 'credential', label: String(defaultCred.name) };
    } else {
      // Fall back to portal provider
      const s = getSettings();
      const portalLabel = portalProviderLabel(engine, s.provider.mode);
      runsAs = { kind: 'portal', label: portalLabel };
    }
  }

  const cacheId = cred ? String(cred.id) : 'portal';
  if (!refresh) {
    const cached = fromCache(engine, cacheId);
    if (cached) return cached;
  }

  // ── 2. Kiro engine ───────────────────────────────────────────────────────
  if (engine === 'kiro') {
    if (cred) {
      const mode = String(cred.mode);
      const env: Record<string, string> = {};

      if (mode === 'api_key') {
        if (!cred.secret_enc) {
          return toCache(engine, cacheId, { models: [], source: 'none', runsAs, error: 'Kiro API key credential has no secret stored. Update it in Credentials.' });
        }
        let key: string;
        try { key = decrypt(String(cred.secret_enc), config.secretKey); }
        catch { return toCache(engine, cacheId, { models: [], source: 'none', runsAs, error: 'Could not decrypt Kiro API key.' }); }
        env.KIRO_API_KEY = key;
      } else if (mode === 'identity_center') {
        if (!cred.secret_enc) {
          return toCache(engine, cacheId, { models: [], source: 'none', runsAs, error: 'Kiro IAM Identity Center credential has no token. Complete the device-code sign-in flow first.' });
        }
        const origExtra = safeJson(cred.extra_config);

        // Detect credentials created with the old sso:account:access scope.
        // These lack clientId in extra_config. The user must sign in again.
        // AgentCore sign-ins have no clientId but record signedInAt.
        if (!origExtra.clientId && !origExtra.signedInAt) {
          return toCache(engine, cacheId, {
            models: [], source: 'none', runsAs,
            error: 'Kiro IAM Identity Center credential was created with outdated scopes. Click Sign in again in Credentials to re-authenticate.',
          });
        }

        // Auto-refresh if token is expired or expiring within 5 minutes.
        let activeCred: CredentialRow = cred;
        try {
          await autoRefreshIdcIfNeeded(String(cred.id));
          const refreshed = await getCredentialsRepository().getByIdAndUser(String(cred.id), userId);
          if (refreshed) activeCred = refreshed;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return toCache(engine, cacheId, { models: [], source: 'none', runsAs, error: msg });
        }

        // Lazy profile fetch — same place as auto-refresh.
        try {
          await ensureKiroProfileFetched(String(cred.id));
          const afterProfile = await getCredentialsRepository().getByIdAndUser(String(cred.id), userId);
          if (afterProfile) activeCred = afterProfile;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return toCache(engine, cacheId, { models: [], source: 'none', runsAs, error: msg });
        }

        let token: string;
        try { token = decrypt(String(activeCred.secret_enc ?? ''), config.secretKey); }
        catch { return toCache(engine, cacheId, { models: [], source: 'none', runsAs, error: 'Could not decrypt Kiro Identity Center token.' }); }
        const extra = safeJson(activeCred.extra_config);
        const region = String(extra.region ?? 'us-east-1');
        const expiry = extra.tokenExpiry ? String(extra.tokenExpiry) : new Date(Date.now() + 28_800_000).toISOString();
        const startUrl = String(extra.startUrl ?? '');

        env[IDC_TOKEN_KEY] = token;
        env[IDC_REGION_KEY] = region;
        env[IDC_EXPIRY_KEY] = expiry;
        env[IDC_START_URL_KEY] = startUrl;

        let refreshToken = '';
        if (extra.refreshTokenEnc && typeof extra.refreshTokenEnc === 'string') {
          try { refreshToken = decrypt(extra.refreshTokenEnc, config.secretKey); } catch { /* best-effort */ }
        }
        let clientSecret = '';
        if (extra.clientSecretEnc && typeof extra.clientSecretEnc === 'string') {
          try { clientSecret = decrypt(extra.clientSecretEnc, config.secretKey); } catch { /* best-effort */ }
        }
        const clientId = String(extra.clientId ?? '');
        const clientSecretExpiresAt = String(extra.clientSecretExpiresAt ?? 0);
        if (refreshToken) env[IDC_REFRESH_TOKEN_KEY] = refreshToken;
        if (clientId) env[IDC_CLIENT_ID_KEY] = clientId;
        if (clientSecret) env[IDC_CLIENT_SECRET_KEY] = clientSecret;
        if (clientSecretExpiresAt !== '0') env[IDC_CLIENT_SECRET_EXPIRES_AT_KEY] = clientSecretExpiresAt;
        if (extra.selectedProfileArn) env[IDC_PROFILE_ARN_KEY] = String(extra.selectedProfileArn);
        if (extra.selectedProfileName) env[IDC_PROFILE_NAME_KEY] = String(extra.selectedProfileName);
      }

      // For identity_center mode: verify the KIRO_TEST_DB_PATH hook is honoured
      // before calling listKiroModels.  If it isn't, kiro-cli would silently use
      // the portal machine's own session — a silent identity leak.
      const acRuntimeArn = process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN;
      if (mode === 'identity_center' && acRuntimeArn) {
        // Cloud portal: kiro-cli is not installed locally, so list models inside the AgentCore runtime.
        const token: KiroTokenPayload = {
          accessToken: String(env[IDC_TOKEN_KEY] ?? ''),
          expiresAt: String(env[IDC_EXPIRY_KEY] ?? ''),
          region: String(env[IDC_REGION_KEY] ?? 'us-east-1'),
          startUrl: String(env[IDC_START_URL_KEY] ?? ''),
          ...(env[IDC_REFRESH_TOKEN_KEY] ? { refreshToken: String(env[IDC_REFRESH_TOKEN_KEY]) } : {}),
          ...(env[IDC_CLIENT_ID_KEY] ? { clientId: String(env[IDC_CLIENT_ID_KEY]) } : {}),
          ...(env[IDC_CLIENT_SECRET_KEY] ? { clientSecret: String(env[IDC_CLIENT_SECRET_KEY]) } : {}),
          ...(env[IDC_CLIENT_SECRET_EXPIRES_AT_KEY] ? { clientSecretExpiresAt: Number(env[IDC_CLIENT_SECRET_EXPIRES_AT_KEY]) } : {}),
          ...(env[IDC_PROFILE_ARN_KEY] ? { profileArn: String(env[IDC_PROFILE_ARN_KEY]) } : {}),
          ...(env[IDC_PROFILE_NAME_KEY] ? { profileName: String(env[IDC_PROFILE_NAME_KEY]) } : {}),
        };
        const listed = await listKiroModelsViaAgentCore(acRuntimeArn, token);
        const parsed = listed.stdout ? parseKiroModelsStdout(listed.stdout) : { models: [], error: listed.error };
        if (parsed.error || parsed.models.length === 0) {
          // Keep sessions usable with Kiro's automatic model choice, and say why the list is missing.
          return toCache(engine, cacheId, {
            models: [{ id: 'auto', label: 'Auto', default: true }],
            source: 'static',
            runsAs,
            error: `Could not list Kiro models: ${parsed.error ?? 'no models returned'}`,
          });
        }
        return toCache(engine, cacheId, { models: parsed.models.map(kiroRawToEngineEntry), source: 'kiro-cli', runsAs });
      }

      if (mode === 'identity_center') {
        const hookCheck = await checkKiroIdcHookSupport();
        const idcIsolation: KiroIdcIsolation = {
          supported: hookCheck.supported,
          method: hookCheck.supported ? 'kiro-test-db' : 'none',
        };
        if (!hookCheck.supported) {
          const errMsg =
            hookCheck.error ??
            `Your Kiro IAM Identity Center credential cannot be isolated from the portal ` +
            `machine's own kiro-cli session (kiro-cli ${hookCheck.version} does not honour ` +
            `the per-user authentication hook). ` +
            'Use a Kiro API key credential instead.';
          return toCache(engine, cacheId, { models: [], source: 'none', runsAs, idcIsolation, error: errMsg });
        }
        const result = await listKiroModels(env, String(cred.name), String(cred.id));
        return toCache(engine, cacheId, { ...result, runsAs, idcIsolation });
      }

      const result = await listKiroModels(env, String(cred.name), String(cred.id));
      return toCache(engine, cacheId, { ...result, runsAs });
    }

    // Portal Kiro provider
    const s = getSettings();
    if (s.kiroApiKeySet && s.kiroApiKeyEnc) {
      let key: string;
      try { key = decrypt(s.kiroApiKeyEnc, config.secretKey); }
      catch { return toCache(engine, cacheId, { models: [], source: 'none', runsAs, error: 'Could not decrypt portal Kiro API key.' }); }
      const result = await listKiroModels({ KIRO_API_KEY: key }, 'Portal provider', null);
      return toCache(engine, cacheId, { ...result, runsAs });
    }

    // No Kiro key anywhere
    return toCache(engine, cacheId, {
      models: [],
      source: 'none',
      runsAs,
      error: 'No Kiro credentials are configured. Add a Kiro credential or configure the portal Kiro API key in Settings.',
    });
  }

  // ── 3. Claude Code engine ────────────────────────────────────────────────
  if (engine === 'claude-code') {
    if (cred) {
      const mode = String(cred.mode);

      if (mode === 'subscription_token') {
        return toCache(engine, cacheId, { models: SUBSCRIPTION_MODELS, source: 'static', runsAs });
      }

      if (mode === 'api_key') {
        if (!cred.secret_enc) {
          return toCache(engine, cacheId, { models: [], source: 'none', runsAs, error: 'Anthropic API key credential has no secret stored.' });
        }
        let apiKey: string;
        try { apiKey = decrypt(String(cred.secret_enc), config.secretKey); }
        catch { return toCache(engine, cacheId, { models: [], source: 'none', runsAs, error: 'Could not decrypt Anthropic API key.' }); }
        const r = await listAnthropicModels(apiKey);
        return toCache(engine, cacheId, { ...r, runsAs });
      }

      if (mode === 'bedrock_role') {
        const extra = safeJson(cred.extra_config);
        const roleArn = String(extra.roleArn ?? '');
        const region = String(extra.region ?? 'us-east-1');
        if (!roleArn) {
          return toCache(engine, cacheId, { models: [], source: 'none', runsAs, error: 'Bedrock role credential has no roleArn configured.' });
        }
        const r = await listBedrockModelsForRole(roleArn, region, extra.externalId ? String(extra.externalId) : undefined);
        return toCache(engine, cacheId, { ...r, runsAs });
      }
    }

    // Portal provider
    const s = getSettings();
    const mode = s.provider.mode;

    if (mode === 'anthropic') {
      const r = await listModelsForProvider('anthropic', getDb(), refresh);
      const models = r.groups.flatMap((g) => g.models);
      const response: EngineModelsResponse = {
        models,
        source: 'anthropic',
        runsAs,
        ...(r.error ? { error: r.error } : {}),
      };
      return toCache(engine, cacheId, response);
    }

    if (mode === 'bedrock') {
      const r = await listModelsForProvider('bedrock', getDb(), refresh);
      const models = r.groups.flatMap((g) => g.models);
      const response: EngineModelsResponse = {
        models,
        source: 'bedrock',
        runsAs,
        ...(r.error ? { error: r.error } : {}),
      };
      return toCache(engine, cacheId, response);
    }

    if (mode === 'demo') {
      return toCache(engine, cacheId, { models: [], source: 'none', runsAs, error: 'Provider is set to Demo mode. Configure Anthropic or Bedrock to list real models.' });
    }

    return toCache(engine, cacheId, { models: [], source: 'none', runsAs, error: `Provider mode "${mode}" is not supported for model listing.` });
  }

  return { models: [], source: 'none', runsAs: { kind: 'portal', label: 'Unknown' }, error: `Unknown engine: ${engine}` };
}

function portalProviderLabel(engine: string, mode: string): string {
  if (engine === 'kiro') return 'Portal Kiro provider';
  if (mode === 'bedrock') return 'Portal provider (Bedrock)';
  if (mode === 'anthropic') return 'Portal provider (Anthropic)';
  if (mode === 'demo') return 'Demo mode';
  return `Portal provider (${mode})`;
}

// ── Anthropic model listing ───────────────────────────────────────────────────

async function listAnthropicModels(apiKey: string): Promise<{ models: EngineModelEntry[]; source: 'anthropic'; error?: string }> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      const msg = ((body as { error?: { message?: string } }).error?.message ?? res.statusText);
      return { models: [], source: 'anthropic', error: `Anthropic API error: ${msg}` };
    }
    const data = await res.json() as { data?: Array<{ id: string; display_name?: string; type?: string }> };
    const models = (data.data ?? [])
      .filter((m) => !m.type || m.type === 'model')
      .map((m) => ({ id: m.id, label: m.display_name ?? m.id }))
      .sort((a, b) => b.id.localeCompare(a.id));
    return { models, source: 'anthropic' };
  } catch (e: unknown) {
    return { models: [], source: 'anthropic', error: `Anthropic connection failed: ${String((e as Error)?.message ?? e)}` };
  }
}

// ── Bedrock model listing for role credential ─────────────────────────────────

async function listBedrockModelsForRole(
  roleArn: string,
  region: string,
  externalId?: string,
): Promise<{ models: EngineModelEntry[]; source: 'bedrock'; error?: string }> {
  try {
    type CredProvidersModule = {
      fromTemporaryCredentials: (opts: {
        params: { RoleArn: string; RoleSessionName: string; ExternalId?: string };
        clientConfig?: { region: string };
      }) => () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
    };
    const credMod = await (Function('m', 'return import(m)')('@aws-sdk/credential-providers') as Promise<CredProvidersModule>);
    const provider = credMod.fromTemporaryCredentials({
      params: {
        RoleArn: roleArn,
        RoleSessionName: `portal-model-list-${Date.now()}`,
        ...(externalId ? { ExternalId: externalId } : {}),
      },
      clientConfig: { region },
    });
    const creds = await provider();

    type BM = {
      BedrockClient: new (opts: object) => { send(cmd: object): Promise<unknown> };
      ListFoundationModelsCommand: new (opts?: object) => object;
      ListInferenceProfilesCommand: new (opts?: object) => object;
    };
    const mod = await (Function('m', 'return import(m)')('@aws-sdk/client-bedrock') as Promise<BM>);
    const client = new mod.BedrockClient({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });

    const [fmResult, ipResult] = await Promise.all([
      client.send(new mod.ListFoundationModelsCommand({})) as Promise<{ foundationModelSummaries?: Array<{ modelId?: string; modelName?: string; outputModalities?: string[] }> }>,
      client.send(new mod.ListInferenceProfilesCommand({ type: 'SYSTEM_DEFINED' })).catch(() => ({ inferenceProfileSummaries: [] })) as Promise<{ inferenceProfileSummaries?: Array<{ inferenceProfileId?: string; inferenceProfileName?: string; type?: string; status?: string }> }>,
    ]);

    const models: EngineModelEntry[] = [];
    for (const m of fmResult.foundationModelSummaries ?? []) {
      if (m.modelId && m.outputModalities?.includes('TEXT')) {
        models.push({ id: m.modelId, label: m.modelName ?? m.modelId });
      }
    }
    for (const p of ipResult.inferenceProfileSummaries ?? []) {
      if (p.inferenceProfileId && (!p.type || p.type === 'SYSTEM_DEFINED') && (!p.status || p.status === 'ACTIVE')) {
        models.push({ id: p.inferenceProfileId, label: p.inferenceProfileName ?? p.inferenceProfileId });
      }
    }

    return { models, source: 'bedrock' };
  } catch (e: unknown) {
    const raw = String((e as Error)?.message ?? e);
    const safe = raw.replace(/[A-Za-z0-9+/]{20,}/g, '***');
    return { models: [], source: 'bedrock', error: `Bedrock listing failed: ${safe}` };
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerEngineModelRoutes(): void {
  router.get('/api/engines/:engine/models', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const engine = req.params.engine;
    if (engine !== 'kiro' && engine !== 'claude-code' && engine !== 'codex') {
      sendJson(res, 400, { error: 'engine must be kiro, claude-code, or codex' });
      return;
    }

    const qs = req.url ? new URL(req.url, 'http://localhost').searchParams : new URLSearchParams();
    const credentialId = qs.get('credentialId') ?? null;
    const refresh = qs.get('refresh') === '1';

    const result = await getEngineModels(
      engine as 'kiro' | 'claude-code' | 'codex',
      req.user!.id,
      credentialId,
      refresh,
    );

    sendJson(res, 200, result);
  }));
}


// ── Legacy alias resolution (used by settings tests and non-engine callers) ────

export const MODEL_DEFAULTS: Record<string, string> = {
  sonnet: 'claude-sonnet-4-5',
  haiku: 'claude-haiku-4-5',
  opus: 'claude-opus-4-5',
};

/**
 * Resolve a model alias ('sonnet' | 'haiku' | 'opus') to its configured model ID.
 * Reads from settings table first (model.<alias> key), falls back to MODEL_DEFAULTS.
 *
 * @deprecated Prefer getSettings().defaultModel for engine runs. Use resolveModel only
 *   for legacy call-sites that need per-alias resolution.
 */
export function resolveModel(alias: string, db?: DatabaseSync): string {
  const d = db ?? getDb();
  const override = getSetting(d, `model.${alias}`);
  if (override && override.trim()) return override.trim();
  return MODEL_DEFAULTS[alias] ?? MODEL_DEFAULTS.sonnet;
}
