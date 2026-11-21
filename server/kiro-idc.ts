/**
 * kiro-idc.ts — Per-user Kiro IAM Identity Center credential isolation.
 *
 * kiro-cli ≥ 2.37 stores auth tokens in a SQLite database
 * (%LOCALAPPDATA%\Kiro-Cli\data.sqlite3 on Windows,
 *  ~/.local/share/kiro-cli/data.sqlite3 on Linux,
 *  ~/Library/Application Support/kiro-cli/data.sqlite3 on macOS).
 * It no longer reads ~/.aws/sso/cache/device-sso-lsp-token.json.
 *
 * KIRO_TEST_DB_PATH overrides the database path for a single invocation.
 * Setting it to a fresh DB that contains only the user's auth rows makes
 * kiro-cli authenticate as that user without touching the portal machine's
 * own kiro-cli session.
 *
 * The injected DB contains the auth_kv token row and, when client registration
 * data is available, the device-registration row. kiro-cli ≥ 2.37 can refresh
 * the access token using the stored refresh_token; if it does, the new token
 * is written back to the temp DB before cleanup so the credential stays valid.
 *
 * Safety invariants:
 *   - We never read, copy or modify the real data.sqlite3.
 *   - We never print or log token values.
 *   - Temp DBs are created in os.tmpdir() and cleaned up by the caller.
 */

import { DatabaseSync } from 'node:sqlite';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * The env-var name that redirects kiro-cli's auth SQLite database.
 * Present in the kiro-cli.exe binary (kiro-cli ≥ 2.37 on all platforms).
 */
export const KIRO_TEST_DB_ENV = 'KIRO_TEST_DB_PATH';

/** auth_kv key for the IDC/OIDC token record. */
const AUTH_KV_TOKEN_KEY = 'kirocli:odic:token';

/** auth_kv key for the OIDC client registration record. */
const AUTH_KV_DEVICE_REG_KEY = 'kirocli:odic:device-registration';

/**
 * The three scopes that kiro-cli uses for CodeWhisperer / Kiro authentication.
 * These must match exactly what kiro-cli registers and expects.
 */
export const KIRO_IDC_SCOPES: readonly string[] = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
];

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A Kiro IAM Identity Center profile as returned by the ListAvailableProfiles API.
 * Stored in extra_config as selectedProfileArn/selectedProfileName.
 * Written into the `state` table as `api.codewhisperer.profile`.
 */
export interface KiroProfile {
  /** Full profile ARN, e.g. "arn:aws:codewhisperer:us-east-1:123456789:profile/abc". */
  arn: string;
  /** Human-readable profile name, e.g. "KiroProfile-us-east-1". */
  profileName: string;
}

/**
 * Result of a fetchKiroProfiles call.
 *
 * - ok: true  → profiles list (may be empty if no profiles are assigned)
 * - ok: false → reason is a sanitised, token-free error string suitable for
 *               storing in profileFetchError and surfacing to the user.
 */
export type FetchProfilesResult =
  | { ok: true; profiles: KiroProfile[] }
  | { ok: false; reason: string };

export interface KiroAuthDbOptions {
  /** Decrypted SSO OIDC access token. */
  accessToken: string;
  /** ISO-8601 expiry timestamp (e.g. from extra_config.tokenExpiry). */
  expiresAt: string;
  /** AWS region (e.g. "us-east-1"). */
  region: string;
  /** IAM Identity Center start URL. */
  startUrl: string;
  /** Decrypted OIDC refresh token (optional; omitted for old credentials). */
  refreshToken?: string;
  /** OIDC client ID from device registration (optional). */
  clientId?: string;
  /** Decrypted OIDC client secret from device registration (optional). */
  clientSecret?: string;
  /**
   * Unix-epoch seconds when the client secret expires (optional).
   * AWS SSO OIDC RegisterClient returns this as a number of seconds since epoch.
   */
  clientSecretExpiresAt?: number;
  /**
   * Kiro CodeWhisperer profile ARN (optional).
   * When provided, the three required state rows are written so kiro-cli
   * does not emit "No profile selected".
   */
  profileArn?: string;
  /**
   * Human-readable profile name (optional; paired with profileArn).
   * Stored in the api.codewhisperer.profile state row as profile_name.
   */
  profileName?: string;
}

export interface KiroAuthDbResult {
  /** Absolute path to the materialised data.sqlite3 file. */
  dbPath: string;
  /** Parent temp dir — pass to cleanupKiroAuthDb() after the run. */
  tmpDir: string;
}

/**
 * Token payload read back from the auth_kv table.
 * Used by callers to detect whether kiro-cli refreshed the token during a run.
 */
export interface KiroTokenPayload {
  access_token: string;
  expires_at: string;
  refresh_token?: string;
}

// ── DB schema ─────────────────────────────────────────────────────────────────

/**
 * Minimal schema matching the real kiro-cli data.sqlite3 layout.
 * Only auth_kv is populated; all other tables are created empty.
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    migration_time INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY,
    command TEXT,
    shell TEXT,
    pid INTEGER,
    session_id TEXT,
    cwd TEXT,
    start_time INTEGER,
    hostname TEXT,
    exit_code INTEGER,
    end_time INTEGER,
    duration INTEGER
  );
  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value BLOB
  );
  CREATE TABLE IF NOT EXISTS conversations (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS conversations_v2 (
    key TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS extracted_kas_versions (
    version TEXT PRIMARY KEY,
    last_used_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pinned_bin_versions (
    version TEXT PRIMARY KEY,
    last_used_at INTEGER NOT NULL
  );
`;

// ── Test hooks ────────────────────────────────────────────────────────────────

type MaterialiseFn = (opts: KiroAuthDbOptions) => Promise<KiroAuthDbResult>;
let _materialiseOverride: MaterialiseFn | null = null;

/**
 * @internal Override materialiseKiroAuthDb for testing (e.g., to simulate failure).
 * Pass null to restore the real implementation.
 */
export function _setMaterialiseKiroAuthDbOverride(fn: MaterialiseFn | null): void {
  _materialiseOverride = fn;
}

type ProfilesFetcherFn = (accessToken: string, region: string) => Promise<FetchProfilesResult>;
let _profilesFetcherOverride: ProfilesFetcherFn | null = null;

/**
 * Override the profiles fetcher for testing.
 * Pass null to restore the real implementation (live HTTP call).
 *
 * The override must return a FetchProfilesResult:
 *   - success: { ok: true, profiles: [...] }
 *   - failure: { ok: false, reason: 'human-readable error' }
 */
export function setProfilesFetcherOverride(fn: ProfilesFetcherFn | null): void {
  _profilesFetcherOverride = fn;
}

// ── Profiles API ──────────────────────────────────────────────────────────────

/** Max chars of a sanitised error body to include in a reason string. */
const MAX_ERR_BODY_CHARS = 300;

/**
 * Strip anything resembling a token (40+ char alphanum strings) from a string
 * before storing it or surfacing it to the user.
 */
function sanitiseForDisplay(s: string): string {
  return s.replace(/[A-Za-z0-9+/=_-]{40,}/g, '***').substring(0, MAX_ERR_BODY_CHARS);
}

/**
 * Fetch all available Kiro IAM Identity Center profiles for a given access token.
 *
 * Calls POST https://management.{region}.kiro.dev/List-Available-Profiles
 * with the access token as Bearer and follows pagination via nextToken.
 *
 * Source evidence: kiro-cli acp-server.js bundle (v2.37):
 *   ke.ListAvailableProfiles$=[9,pn,nnc,{[kN]:["POST","/List-Available-Profiles",200]},...],
 *   endpoint = management.{region}.kiro.dev  (from KRi("management",t)),
 *   auth = smithy.api#httpBearerAuth  (from defaultKiroControlPlaneBearerHttpAuthSchemeProvider),
 *   pagination = (nextToken request field, nextToken response field, maxResults).
 *   Live probe confirmed: response body {"profiles":[{"arn":"...","profileName":"..."}],"nextToken":null}.
 *
 * Returns FetchProfilesResult: { ok: true, profiles } on success or
 * { ok: false, reason } on any error, with token values scrubbed.
 * Never throws. Never logs token values.
 */
export async function fetchKiroProfiles(
  accessToken: string,
  region: string,
): Promise<FetchProfilesResult> {
  if (_profilesFetcherOverride) return _profilesFetcherOverride(accessToken, region);

  const endpoint = `https://management.${region}.kiro.dev/List-Available-Profiles`;
  const allProfiles: KiroProfile[] = [];
  let nextToken: string | null = null;

  try {
    do {
      const reqBody: Record<string, unknown> = {};
      if (nextToken) reqBody.nextToken = nextToken;

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const safe = sanitiseForDisplay(errText);
        return {
          ok: false,
          reason: `HTTP ${resp.status}${safe ? `: ${safe}` : ''}`,
        };
      }

      const data = await resp.json() as {
        profiles?: Array<{ arn?: string; profileName?: string }>;
        nextToken?: string | null;
      };

      // Wire field name is "arn" (confirmed via live probe of management.us-east-1.kiro.dev).
      // The Smithy model uses "profileArn" as the field identifier internally, but the
      // REST-JSON wire format uses the member name "arn" from the service definition.
      const page = (data.profiles ?? [])
        .filter((p) => typeof p.arn === 'string' && p.arn.length > 0)
        .map((p) => ({ arn: p.arn!, profileName: p.profileName ?? '' }));

      allProfiles.push(...page);
      nextToken = typeof data.nextToken === 'string' ? data.nextToken : null;
    } while (nextToken);

    return { ok: true, profiles: allProfiles };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: sanitiseForDisplay(msg) };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a throw-away SQLite database in a fresh temp directory that contains
 * the user's auth_kv rows in the exact shapes kiro-cli expects.
 *
 * Writes:
 *   - kirocli:odic:token         — access_token, expires_at, optional refresh_token,
 *                                  region, start_url, oauth_flow:"DeviceCode", scopes
 *   - kirocli:odic:device-registration — client_id, client_secret,
 *                                        client_secret_expires_at, region,
 *                                        oauth_flow:"DeviceCode", scopes
 *                                        (only written when clientId + clientSecret provided)
 *
 * The caller must:
 *   1. Set KIRO_TEST_DB_PATH=result.dbPath in the child process environment.
 *   2. Call cleanupKiroAuthDb(result.tmpDir) after the child process exits.
 *
 * @throws if the temp dir or DB cannot be created.
 */
export async function materialiseKiroAuthDb(
  opts: KiroAuthDbOptions,
): Promise<KiroAuthDbResult> {
  if (_materialiseOverride) return _materialiseOverride(opts);

  const tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'portal-kiro-auth-'),
  );
  const dbPath = path.join(tmpDir, 'data.sqlite3');

  const db = new DatabaseSync(dbPath, { open: true });
  try {
    db.exec(SCHEMA_SQL);

    const nowSec = Math.floor(Date.now() / 1000);
    const insertMig = db.prepare(
      'INSERT OR IGNORE INTO migrations (version, migration_time) VALUES (?, ?)',
    );
    for (let v = 0; v <= 10; v++) {
      insertMig.run(v, nowSec);
    }

    // Token row — oauth_flow must be "DeviceCode" (capital D C) which is what
    // kiro-cli ≥ 2.37 parses. "device_code" (lower-case with underscore) fails
    // with "unknown variant `device_code`, expected one of `DeviceCode`, `PKCE`, `Pkce`".
    const tokenPayload: Record<string, unknown> = {
      access_token: opts.accessToken,
      expires_at: opts.expiresAt,
      region: opts.region,
      start_url: opts.startUrl,
      oauth_flow: 'DeviceCode',
      scopes: [...KIRO_IDC_SCOPES],
    };
    if (opts.refreshToken) {
      tokenPayload.refresh_token = opts.refreshToken;
    }
    db.prepare(
      'INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)',
    ).run(AUTH_KV_TOKEN_KEY, JSON.stringify(tokenPayload));

    // Device-registration row — only written when client registration data is available.
    // kiro-cli uses this row to refresh the access_token via the refresh_token grant.
    if (opts.clientId && opts.clientSecret) {
      const regPayload: Record<string, unknown> = {
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        client_secret_expires_at: opts.clientSecretExpiresAt ?? 0,
        region: opts.region,
        oauth_flow: 'DeviceCode',
        scopes: [...KIRO_IDC_SCOPES],
      };
      db.prepare(
        'INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)',
      ).run(AUTH_KV_DEVICE_REG_KEY, JSON.stringify(regPayload));
    }

    // State rows — kiro-cli ≥ 2.37 reads these at startup.
    //
    // Encoding (verified against real data.sqlite3, read-only inspection):
    //   auth.idc.start-url  → JSON.stringify(string)  e.g. '"https://co.awsapps.com/start"'
    //   auth.idc.region     → JSON.stringify(string)  e.g. '"us-east-1"'
    //   api.codewhisperer.profile → JSON.stringify(object)
    //                            = '{"arn":"...","profile_name":"...","device_code_disabled":false}'
    //
    // Without api.codewhisperer.profile kiro-cli emits:
    //   "No profile selected. Please log in with `kiro-cli login` and select a profile."
    const insertState = db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)');
    insertState.run('auth.idc.start-url', JSON.stringify(opts.startUrl));
    insertState.run('auth.idc.region', JSON.stringify(opts.region));
    if (opts.profileArn) {
      insertState.run(
        'api.codewhisperer.profile',
        JSON.stringify({
          arn: opts.profileArn,
          profile_name: opts.profileName ?? '',
          device_code_disabled: false,
        }),
      );
    }
  } finally {
    db.close();
  }

  return { dbPath, tmpDir };
}

/**
 * Read the token row from a materialised auth DB.
 *
 * Returns null if the file doesn't exist, is unreadable, or has no token row.
 * Used by callers to detect whether kiro-cli refreshed the access_token during
 * a run (by comparing with the token that was written at materialisation time).
 *
 * Never throws. Never logs token values.
 */
export function readKiroAuthDbToken(dbPath: string): KiroTokenPayload | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { open: true });
    const row = db.prepare(
      'SELECT value FROM auth_kv WHERE key = ?',
    ).get(AUTH_KV_TOKEN_KEY) as { value: string } | undefined | null;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    const accessToken = String(parsed.access_token ?? '');
    if (!accessToken) return null;
    return {
      access_token: accessToken,
      expires_at: String(parsed.expires_at ?? ''),
      ...(parsed.refresh_token ? { refresh_token: String(parsed.refresh_token) } : {}),
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ok */ }
  }
}

/**
 * Remove the temp directory created by materialiseKiroAuthDb().
 * Non-fatal: logs nothing on failure; the caller may log if desired.
 */
export async function cleanupKiroAuthDb(tmpDir: string): Promise<void> {
  try {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Non-fatal — best effort cleanup.
  }
}
