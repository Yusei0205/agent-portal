/**
 * Per-user engine credentials (F4).
 *
 * Engines: kiro (api_key | identity_center), claude-code (api_key | subscription_token | bedrock_role).
 * Secrets are encrypted at rest with server/secrets.ts (AES-256-GCM).
 *
 * All routes are browser-only — requests with an Authorization: Bearer header receive 403.
 *
 * resolveCredentialEnv() is the public API used by agent engines to obtain run env vars.
 * Priority: specified credentialId → user's default → portal/project provider.
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getDb } from './db.ts';
import { encrypt, decrypt } from './secrets.ts';
import { getAgentEnv } from './settings.ts';
import { config } from './config.ts';
import { hasCodexLogin } from './codex-auth.ts';
import { generateId, now, str, badRequest, HttpError } from './util.ts';
import { appendAudit } from './audit.ts';
import { KIRO_IDC_SCOPES, fetchKiroProfiles, setProfilesFetcherOverride } from './kiro-idc.ts';
import type { FetchProfilesResult } from './kiro-idc.ts';
import { pollAgentCoreLoginShared } from './agent/kiro-agentcore.ts';
import { findUserCredential } from './credential-default.ts';
import { claudeLoginSupport, startClaudeLogin, submitClaudeLoginCode, cancelClaudeLogin, getClaudeLoginState } from './claude-login.ts';
import { getCredentialsRepository } from './repositories/credentials.ts';
import type { CredentialRecord } from './repositories/credentials.ts';

// Re-export the profiles fetcher override so tests can mock the API.
export { setProfilesFetcherOverride };

// ── Types ─────────────────────────────────────────────────────────────────────

export type Engine = 'kiro' | 'claude-code';
export type KiroMode = 'api_key' | 'identity_center';
export type ClaudeCodeMode = 'api_key' | 'subscription_token' | 'bedrock_role' | 'aws_keys';
export type CredentialMode = KiroMode | ClaudeCodeMode;

// CredentialRow is an alias for CredentialRecord for internal use
type CredentialRow = CredentialRecord;

// ── OIDC client abstraction (injectable for tests) ─────────────────────────────

export interface OIDCClientLike {
  registerClient(input: {
    clientName: string;
    clientType: string;
    scopes?: string[];
    grantTypes?: string[];
  }): Promise<{ clientId: string; clientSecret: string; clientSecretExpiresAt?: number }>;
  startDeviceAuthorization(input: {
    clientId: string;
    clientSecret: string;
    startUrl: string;
  }): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresIn: number;
    interval: number;
  }>;
  createToken(input: {
    clientId: string;
    clientSecret: string;
    deviceCode?: string;
    grantType: string;
    refreshToken?: string;
  }): Promise<{ accessToken: string; expiresIn?: number; refreshToken?: string }>;
}

let _oidcClientFactory: ((region: string) => OIDCClientLike) | null = null;

/** Override the OIDC client factory (call with null to restore real SDK). */
export function setOIDCClientFactory(fn: ((region: string) => OIDCClientLike) | null): void {
  _oidcClientFactory = fn;
}

/**
 * Injectable timeout (ms) for OIDC calls — used by tests to avoid waiting the
 * full production timeout.  null means no injected timeout (SDK handles it).
 */
let _oidcCallTimeoutMs: number | null = null;

/** Override the OIDC call timeout (pass null to remove override). Tests only. */
export function setOIDCCallTimeoutMs(ms: number | null): void {
  _oidcCallTimeoutMs = ms;
}

/** Thrown when an OIDC call exceeds the injected test timeout. */
class OIDCTimeoutError extends Error {
  constructor() {
    super('OIDC_TIMEOUT');
    this.name = 'OIDCTimeoutError';
  }
}

/**
 * Bound a call by an explicit deadline or the injected test deadline.
 * Refresh calls without a deadline use the SDK's own request timeout.
 */
function withOIDCTimeout<T>(promise: Promise<T>, ms: number | null = _oidcCallTimeoutMs): Promise<T> {
  if (ms === null) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OIDCTimeoutError()), ms);
  });
  return Promise.race([promise, timeoutP]).finally(() => clearTimeout(timer)) as Promise<T>;
}

async function makeOIDCClient(region: string): Promise<OIDCClientLike> {
  if (_oidcClientFactory) return _oidcClientFactory(region);

  type SSOOIDCModule = {
    SSOOIDCClient: new (opts: object) => { send(cmd: object): Promise<unknown> };
    RegisterClientCommand: new (input: object) => object;
    StartDeviceAuthorizationCommand: new (input: object) => object;
    CreateTokenCommand: new (input: object) => object;
  };

  const mod = await (Function('m', 'return import(m)')('@aws-sdk/client-sso-oidc') as Promise<SSOOIDCModule>);
  const client = new mod.SSOOIDCClient({
    region,
    requestHandler: {
      connectionTimeout: 3_000,
      requestTimeout: 12_000,
      throwOnRequestTimeout: true,
    },
    maxAttempts: 2,
  });

  return {
    registerClient: (input) =>
      client.send(new mod.RegisterClientCommand(input)) as Promise<{
        clientId: string; clientSecret: string; clientSecretExpiresAt?: number;
      }>,
    startDeviceAuthorization: (input) =>
      client.send(new mod.StartDeviceAuthorizationCommand(input)) as Promise<{
        deviceCode: string; userCode: string; verificationUri: string;
        verificationUriComplete?: string; expiresIn: number; interval: number;
      }>,
    createToken: (input) =>
      client.send(new mod.CreateTokenCommand(input)) as Promise<{ accessToken: string; expiresIn?: number; refreshToken?: string }>,
  };
}

/**
 * Returns true if an AWS SDK error matches any of the given name or message patterns.
 * Checks `e.name` first (SDK v3 sets the exception class name there), then falls back
 * to `e.message` for wire-level codes like `authorization_pending`.
 */
function matchSdkError(e: unknown, ...patterns: string[]): boolean {
  const err = e as { name?: string; message?: string } | null;
  const errName = String(err?.name ?? '');
  const errMsg = String(err?.message ?? '');
  return patterns.some((p) => errName === p || errMsg.includes(p));
}

// ── Bedrock role assumption ────────────────────────────────────────────────────

interface TempCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

async function assumeRole(roleArn: string, region: string, externalId?: string): Promise<TempCreds> {
  type CredProvidersModule = {
    fromTemporaryCredentials: (opts: {
      params: { RoleArn: string; RoleSessionName: string; ExternalId?: string };
      clientConfig?: { region: string };
    }) => () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
  };

  const mod = await (Function('m', 'return import(m)')('@aws-sdk/credential-providers') as Promise<CredProvidersModule>);
  const provider = mod.fromTemporaryCredentials({
    params: {
      RoleArn: roleArn,
      RoleSessionName: `portal-run-${Date.now()}`,
      ...(externalId ? { ExternalId: externalId } : {}),
    },
    clientConfig: { region },
  });
  const c = await provider();
  return {
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    sessionToken: c.sessionToken ?? '',
  };
}

// ── View helper ───────────────────────────────────────────────────────────────

type CredentialStatus = 'ok' | 'expiring' | 'expired' | 'needs_sign_in' | 'pending';

/**
 * Compute the status and canRefresh flag for a credential row.
 * For non-identity_center credentials: status='ok', canRefresh=false.
 * For identity_center: computed from tokenExpiry, refreshTokenEnc, and clientSecretExpiresAt.
 */
function computeIdcStatus(row: CredentialRow): { status: CredentialStatus; canRefresh: boolean } {
  if (String(row.mode) !== 'identity_center') {
    return { status: 'ok', canRefresh: false };
  }
  const extra = safeJson(row.extra_config);

  // Pending: device-code flow not yet complete (no access token stored)
  if (!row.secret_enc) {
    return { status: 'pending', canRefresh: false };
  }

  // Old credential without clientId (created with outdated scopes). A credential signed in through
  // AgentCore has no clientId (the client registration lives inside the runtime) but records signedInAt.
  if (!extra.clientId && !extra.signedInAt) {
    return { status: 'needs_sign_in', canRefresh: false };
  }

  const tokenExpiryMs = extra.tokenExpiry ? new Date(String(extra.tokenExpiry)).getTime() : 0;
  const nowMs = Date.now();
  const FIVE_MIN_MS = 5 * 60 * 1000;

  const hasRefreshToken = Boolean(extra.refreshTokenEnc);
  // clientSecretExpiresAt is Unix epoch seconds; 0 means no expiry recorded
  const clientSecretExpiresAt = Number(extra.clientSecretExpiresAt ?? 0);
  const clientRegValid = clientSecretExpiresAt === 0 || clientSecretExpiresAt * 1000 > nowMs;
  const canRefresh = hasRefreshToken && clientRegValid;

  if (!tokenExpiryMs || tokenExpiryMs <= nowMs) {
    return { status: canRefresh ? 'expired' : 'needs_sign_in', canRefresh };
  }
  if (tokenExpiryMs <= nowMs + FIVE_MIN_MS) {
    return { status: 'expiring', canRefresh };
  }
  return { status: 'ok', canRefresh };
}

function credView(row: CredentialRow) {
  const rawConfig = safeJson(row.extra_config) as Record<string, unknown>;
  // Strip pending device-code fields from the response
  const {
    pendingClientId: _1, pendingClientSecret: _2,
    pendingDeviceCode: _3, pendingExpireAt: _4,
    pendingClientSecretExpiresAt: _5,
    refreshTokenEnc: _6, clientSecretEnc: _7,
    pendingClientSecretEnc: _8,
    availableProfiles: _av,
    selectedProfileArn: _spa,
    selectedProfileName: _spn,
    profileFetchError: _pfe,
    ...publicConfig
  } = rawConfig;
  void _1; void _2; void _3; void _4; void _5; void _6; void _7; void _8;

  const { status, canRefresh } = computeIdcStatus(row);

  // Expose profile info to the frontend (for profile picker)
  const selectedProfile = _spa
    ? { arn: String(_spa), profileName: String(_spn ?? '') }
    : null;
  const profiles = Array.isArray(_av)
    ? (_av as Array<{ arn: string; profileName: string }>).map((p) => ({
        arn: String(p.arn ?? ''),
        profileName: String(p.profileName ?? ''),
      }))
    : null;

  return {
    id: String(row.id),
    engine: String(row.engine),
    name: String(row.name),
    mode: String(row.mode),
    isDefault: Boolean(row.is_default),
    last4: String(row.last4 ?? ''),
    updatedAt: String(row.updated_at),
    updatedBy: row.updated_by_name ? String(row.updated_by_name) : null,
    config: publicConfig,
    status,
    canRefresh,
    ...(selectedProfile ? { selectedProfile } : {}),
    ...(profiles ? { profiles } : {}),
  };
}

function safeJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try { return JSON.parse(String(s)) as Record<string, unknown>; } catch { return {}; }
}

// ── Kiro profile management ───────────────────────────────────────────────────

/**
 * Fetch available Kiro profiles using the stored access token and store the
 * result in the credential's extra_config.
 *
 * - Exactly one profile → auto-select it.
 * - Multiple profiles   → store all; auto-select the first.
 * - No profiles         → record a fetch error; caller must surface this.
 * - Fetch error         → record the sanitised reason in profileFetchError.
 *
 * Non-fatal: catches all errors internally, stores a profileFetchError on
 * failure so the credential's status shows `needs_sign_in`.
 * Never logs token values.
 */
async function fetchAndStoreProfile(credId: string, accessToken: string, region: string): Promise<void> {
  try {
    const result: FetchProfilesResult = await fetchKiroProfiles(accessToken, region);
    const cred = await getCredentialsRepository().getById(credId);
    if (!cred) return;
    const extra = safeJson(cred.extra_config);

    if (!result.ok) {
      const newExtra: Record<string, unknown> = {
        ...extra,
        profileFetchError: `Profile lookup failed: ${result.reason}`,
      };
      delete newExtra.selectedProfileArn;
      delete newExtra.selectedProfileName;
      delete newExtra.availableProfiles;
      await getCredentialsRepository().updateExtraConfig(credId, JSON.stringify(newExtra), now());
      return;
    }

    if (result.profiles.length === 0) {
      const newExtra: Record<string, unknown> = {
        ...extra,
        profileFetchError: 'No Kiro profiles found for this account. Ensure a Kiro profile is assigned in IAM Identity Center.',
      };
      delete newExtra.selectedProfileArn;
      delete newExtra.selectedProfileName;
      delete newExtra.availableProfiles;
      await getCredentialsRepository().updateExtraConfig(credId, JSON.stringify(newExtra), now());
      return;
    }

    const selected = result.profiles[0];
    const newExtra: Record<string, unknown> = {
      ...extra,
      selectedProfileArn: selected.arn,
      selectedProfileName: selected.profileName,
    };
    delete newExtra.profileFetchError;
    if (result.profiles.length > 1) {
      newExtra.availableProfiles = result.profiles;
    } else {
      delete newExtra.availableProfiles;
    }

    await getCredentialsRepository().updateExtraConfig(credId, JSON.stringify(newExtra), now());
  } catch {
    // Non-fatal: best-effort; user can re-authenticate to retry
  }
}

/**
 * Ensure the credential has a Kiro profile stored; fetch it lazily if not.
 *
 * Called in the same place as autoRefreshIdcIfNeeded, before a run or model
 * listing.  Throws HttpError(400) with a user-actionable message if the
 * profile cannot be obtained.  The message includes the actual failure reason
 * from profileFetchError, and recommends "Sign in again" only when that can
 * actually help (HTTP 4xx auth errors).
 *
 * Exported so models.ts can call it before listing models.
 */
export async function ensureKiroProfileFetched(credId: string): Promise<void> {
  const cred = await getCredentialsRepository().getById(credId);
  if (!cred || cred.mode !== 'identity_center') return;
  if (!cred.secret_enc) return;

  const extra = safeJson(cred.extra_config);
  if (extra.selectedProfileArn) return; // Already have a profile

  // Try to fetch the profile now
  let accessToken: string;
  try { accessToken = decrypt(String(cred.secret_enc), config.secretKey); } catch { return; }
  if (!accessToken) return;

  const region = String(extra.region ?? 'us-east-1');
  await fetchAndStoreProfile(credId, accessToken, region);

  // Re-read to check result
  const updatedCred = await getCredentialsRepository().getById(credId);
  const updatedExtra = safeJson(updatedCred?.extra_config);
  if (!updatedExtra.selectedProfileArn) {
    const fetchErr = updatedExtra.profileFetchError ? String(updatedExtra.profileFetchError) : '';

    if (!fetchErr) {
      throw new HttpError(
        400,
        'Kiro profile not found. Open Credentials and click Sign in again.',
      );
    }

    const isAuthError = /HTTP 40[0-9]/.test(fetchErr);
    const action = isAuthError
      ? 'Open Credentials and click Sign in again.'
      : 'Check your network connectivity or contact your IAM Identity Center administrator.';

    throw new HttpError(400, `Kiro profile lookup failed: ${fetchErr} — ${action}`);
  }
}

// ── IDC token refresh ─────────────────────────────────────────────────────────

type RefreshResult = { ok: true } | { ok: false; transient?: boolean; message: string };

/** Per-credential in-flight refresh promises — prevents concurrent OIDC calls for the same credential. */
const _refreshPromises = new Map<string, Promise<RefreshResult>>();

const IDC_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Classify a createToken error into one of three buckets:
 * - 'transient': retryable (SDK timeout, network failure, AWS throttling/5xx) → 504, no needsSignIn
 * - 'auth': AWS auth rejection → 409 + needsSignIn
 * - 'unknown': anything else → 409 + needsSignIn (caller logs name/code only)
 */
function classifyOidcError(e: unknown): 'transient' | 'auth' | 'unknown' {
  if (e instanceof OIDCTimeoutError) return 'transient';

  if (matchSdkError(e, 'TimeoutError', 'RequestTimeout')) return 'transient';

  const code = String((e as { code?: string })?.code ?? '');
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'transient';

  if (matchSdkError(e, 'InternalServerException', 'SlowDownException')) return 'transient';
  const httpStatus = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  if (typeof httpStatus === 'number' && httpStatus >= 500) return 'transient';

  if (matchSdkError(e, 'InvalidGrantException', 'ExpiredTokenException', 'InvalidClientException',
      'UnauthorizedClientException', 'AccessDeniedException')) return 'auth';

  return 'unknown';
}

/**
 * Attempt to refresh an identity_center credential's access token using the
 * stored refresh token and client registration.
 * Returns { ok: true } on success (DB updated); { ok: false, message } on any failure.
 * Never logs token values.
 */
async function attemptTokenRefresh(cred: CredentialRow): Promise<RefreshResult> {
  const extra = safeJson(cred.extra_config);

  const clientId = String(extra.clientId ?? '');
  const clientSecretExpiresAt = Number(extra.clientSecretExpiresAt ?? 0);

  if (!extra.refreshTokenEnc || !clientId || !extra.clientSecretEnc) {
    return { ok: false, message: "Your sign-in can't be renewed. Sign in again." };
  }
  // Client registration expired (epoch seconds; 0 means no expiry recorded)
  if (clientSecretExpiresAt > 0 && clientSecretExpiresAt * 1000 < Date.now()) {
    return { ok: false, message: "Your sign-in can't be renewed. Sign in again." };
  }

  let clientSecret: string;
  let refreshToken: string;
  try {
    clientSecret = decrypt(String(extra.clientSecretEnc), config.secretKey);
    refreshToken = decrypt(String(extra.refreshTokenEnc), config.secretKey);
  } catch {
    return { ok: false, message: "Your sign-in can't be renewed. Sign in again." };
  }

  const region = String(extra.region ?? 'us-east-1');
  try {
    const oidc = await makeOIDCClient(region);
    const result = await withOIDCTimeout(oidc.createToken({
      clientId,
      clientSecret,
      grantType: 'refresh_token',
      refreshToken,
    }));

    const tokenEnc = encrypt(result.accessToken, config.secretKey);
    const tokenExpiry = result.expiresIn
      ? new Date(Date.now() + result.expiresIn * 1000).toISOString()
      : new Date(Date.now() + 28_800_000).toISOString();

    const newExtra: Record<string, unknown> = { ...extra, tokenExpiry };
    if (result.refreshToken) {
      newExtra.refreshTokenEnc = encrypt(result.refreshToken, config.secretKey);
    }
    // Clear any stale pending fields
    delete newExtra.pendingClientId;
    delete newExtra.pendingClientSecret;
    delete newExtra.pendingClientSecretEnc;
    delete newExtra.pendingDeviceCode;
    delete newExtra.pendingExpireAt;
    delete newExtra.pendingClientSecretExpiresAt;

    await getCredentialsRepository().updateToken(
      String(cred.id),
      tokenEnc,
      JSON.stringify(newExtra),
      result.accessToken.slice(-4),
      now(),
    );
    return { ok: true };
  } catch (e) {
    const errClass = classifyOidcError(e);
    if (errClass === 'transient') {
      return { ok: false, transient: true, message: "AWS sign-in service didn't respond. Try again." };
    }
    if (errClass === 'unknown') {
      const errName = String((e as { name?: string })?.name ?? 'unknown');
      const errCode = String((e as { code?: string })?.code ?? '');
      console.error(`[credentials] OIDC createToken unexpected error: name=${errName}${errCode ? ` code=${errCode}` : ''}`);
    }
    return { ok: false, message: "Your sign-in can't be renewed. Sign in again." };
  }
}

/**
 * If the stored access token is expired or expires within 5 minutes, attempt to
 * refresh it using the stored refresh token.  Deduplicates concurrent refresh
 * calls for the same credential (only one OIDC round-trip per credential at a time).
 *
 * Throws HttpError(400) with "Kiro sign-in expired…" if refresh fails.
 * Returns immediately when no refresh token is stored or the token is still valid.
 *
 * Exported so models.ts can call it before listing models.
 */
export async function autoRefreshIdcIfNeeded(credId: string): Promise<void> {
  const cred = await getCredentialsRepository().getById(credId);
  if (!cred || cred.mode !== 'identity_center') return;
  if (!cred.secret_enc) return;

  const extra = safeJson(cred.extra_config);
  if (!extra.refreshTokenEnc) return; // No refresh token; proceed with existing token

  const tokenExpiryMs = extra.tokenExpiry ? new Date(String(extra.tokenExpiry)).getTime() : 0;
  if (tokenExpiryMs > Date.now() + IDC_EXPIRY_BUFFER_MS) return; // Still valid

  // Deduplicate: if a refresh is already in flight for this credential, await it
  let promise = _refreshPromises.get(credId);
  if (!promise) {
    promise = attemptTokenRefresh(cred as CredentialRow).finally(() => {
      _refreshPromises.delete(credId);
    });
    _refreshPromises.set(credId, promise);
  }

  const result = await promise;
  if (!result.ok) {
    if (result.transient) {
      throw new HttpError(504, "AWS sign-in service didn't respond. Try again.");
    }
    throw new HttpError(400, 'Kiro sign-in expired. Open Credentials and click Sign in again.');
  }
}

// ── Browser-only guard ────────────────────────────────────────────────────────

/**
 * Returns true when the request is from a browser session (cookie auth).
 * Sends 403 for API-token requests, 401 for unauthenticated requests.
 */
function requireBrowser(req: PortalRequest, res: PortalResponse): boolean {
  const authHeader = String(req.headers.authorization ?? '');
  if (authHeader.startsWith('Bearer ')) {
    sendJson(res, 403, {
      error: 'Credentials can only be managed from a signed-in browser, not via API tokens',
    });
    return false;
  }
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  return true;
}

// ── Ownership check ───────────────────────────────────────────────────────────

async function requireOwned(
  res: PortalResponse,
  credId: string,
  userId: string,
): Promise<CredentialRow | null> {
  const cred = await getCredentialsRepository().getByIdAndUser(credId, userId);
  if (!cred) {
    sendJson(res, 404, { error: 'Credential not found' });
    return null;
  }
  return cred;
}

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_MODES: Record<Engine, CredentialMode[]> = {
  kiro: ['api_key', 'identity_center'],
  'claude-code': ['api_key', 'subscription_token', 'bedrock_role', 'aws_keys'],
};

function validateMode(engine: Engine, mode: string): CredentialMode {
  const modes = VALID_MODES[engine];
  if (!modes || !modes.includes(mode as CredentialMode)) {
    throw badRequest(`Invalid mode "${mode}" for engine "${engine}". Valid: ${modes?.join(', ')}`);
  }
  return mode as CredentialMode;
}

// ── resolveCredentialEnv (public API for engines) ─────────────────────────────

/**
 * Build the process-environment additions for an agent run.
 *
 * Priority:
 *   1. credentialId row (must be owned by credentialOwnerId)
 *   2. credentialOwnerId's default credential for the engine
 *   3. Portal/project provider (getAgentEnv fallback)
 *
 * Secrets NEVER enter logs, events or transcripts — they live only in the
 * returned object which is merged into the child process's env.
 */
/**
 * "Amazon Bedrock (this AWS account)": a sign-in choice that is not a stored credential. On the cloud portal the Claude
 * Code engine runs on the AgentCore runtime, and this choice makes a session use Bedrock with the runtime's role
 * even when the person has an Anthropic key or the admin set an Anthropic portal provider.
 */
export const BEDROCK_RUNTIME_SIGN_IN = 'bedrock';
export const bedrockRuntimeAvailable = (): boolean => Boolean(process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN);
export const isBedrockRuntimeChoice = (engine: string, credentialId: string | null | undefined): boolean =>
  engine === 'claude-code' && credentialId === BEDROCK_RUNTIME_SIGN_IN && bedrockRuntimeAvailable();

/**
 * AWS variables for the Claude Code runner in the cloud, when the sign-in in use is the person's own AWS access
 * (pasted keys, or a role the portal assumed). Otherwise empty: the run uses the AgentCore runtime's role.
 */
export async function resolveBedrockEnvForRunner(
  credentialOwnerId: string | null,
  credentialId: string | null,
): Promise<Record<string, string>> {
  if (!credentialOwnerId || !credentialId || isBedrockRuntimeChoice('claude-code', credentialId)) return {};
  const cred = await getCredentialsRepository().getByIdAndUser(credentialId, credentialOwnerId);
  if (!cred || cred.engine !== 'claude-code' || (cred.mode !== 'aws_keys' && cred.mode !== 'bedrock_role')) return {};
  const env = await buildEnvFromCred(cred);
  const out: Record<string, string> = {};
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION']) {
    if (env[k]) out[k] = env[k];
  }
  return out;
}

export async function resolveCredentialEnv(
  engine: 'kiro' | 'claude-code',
  credentialOwnerId: string | null,
  credentialId: string | null,
  _db?: unknown,
): Promise<Record<string, string>> {
  let cred: CredentialRecord | null | undefined;

  if (isBedrockRuntimeChoice(engine, credentialId)) return { CLAUDE_CODE_USE_BEDROCK: '1' };

  if (credentialId && credentialOwnerId) {
    cred = await getCredentialsRepository().getByIdAndUser(credentialId, credentialOwnerId);
    if (cred && cred.engine !== engine) cred = undefined;
  }

  if (!cred && credentialOwnerId) {
    cred = await findUserCredential(credentialOwnerId, engine);
  }

  if (!cred) {
    return await getAgentEnv();
  }

  return buildEnvFromCred(cred);
}

/**
 * Sentinel env-var keys used to pass IDC token and registration data from
 * credentials.ts to kiro.ts / models.ts.
 * These are stripped from the child process environment before spawning — they are
 * never visible in logs or to the engine process itself.
 */
export const IDC_TOKEN_KEY = '_PORTAL_IDC_TOKEN';
export const IDC_REGION_KEY = '_PORTAL_IDC_REGION';
export const IDC_EXPIRY_KEY = '_PORTAL_IDC_EXPIRY';
export const IDC_START_URL_KEY = '_PORTAL_IDC_START_URL';
export const IDC_REFRESH_TOKEN_KEY = '_PORTAL_IDC_REFRESH_TOKEN';
export const IDC_CLIENT_ID_KEY = '_PORTAL_IDC_CLIENT_ID';
export const IDC_CLIENT_SECRET_KEY = '_PORTAL_IDC_CLIENT_SECRET';
export const IDC_CLIENT_SECRET_EXPIRES_AT_KEY = '_PORTAL_IDC_CLIENT_SECRET_EXPIRES_AT';

/** Sentinel env-var key for the user's selected Kiro profile ARN. */
export const IDC_PROFILE_ARN_KEY = '_PORTAL_IDC_PROFILE_ARN';
/** Sentinel env-var key for the user's selected Kiro profile name. */
export const IDC_PROFILE_NAME_KEY = '_PORTAL_IDC_PROFILE_NAME';

/**
 * Build env vars for an agent run from a specific credential row.
 *
 * Throws a clear, secret-free HttpError on ANY failure (missing secret, decrypt
 * error, failed role assumption).  The caller (resolveCredentialEnv) only falls
 * back to the portal provider when NO credential row exists for the user; once a
 * credential is found we must never silently bill the portal provider instead.
 */
/** AWS access keys pasted from the AWS access portal ("Command line or programmatic access"), stored as one encrypted blob. */
export interface AwsKeys { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

/** Checks pasted keys and returns what to store: the encrypted blob and the last 4 characters of the key ID. */
export function parseAwsKeys(input: unknown): { secretEnc: string; last4: string; keys: AwsKeys } {
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const accessKeyId = String(o.accessKeyId ?? '').trim();
  const secretAccessKey = String(o.secretAccessKey ?? '').trim();
  const sessionToken = String(o.sessionToken ?? '').trim();
  if (!/^[A-Z0-9]{16,128}$/.test(accessKeyId)) throw badRequest('Access key ID looks wrong: it is 16 to 128 capital letters and digits, such as ASIA…');
  if (!/^[A-Za-z0-9+/=]{20,128}$/.test(secretAccessKey)) throw badRequest('Secret access key looks wrong: paste it exactly as the AWS access portal shows it');
  if (sessionToken.length > 4096 || /\s/.test(sessionToken)) throw badRequest('Session token looks wrong: paste it as one piece, without line breaks');
  if (accessKeyId.startsWith('ASIA') && !sessionToken) throw badRequest('Keys that start with ASIA are temporary: paste the session token too');
  const keys: AwsKeys = { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  return { secretEnc: encrypt(JSON.stringify(keys), config.secretKey), last4: accessKeyId.slice(-4), keys };
}

export function readAwsKeys(cred: CredentialRow, label = 'AWS keys'): AwsKeys {
  if (!cred.secret_enc) throw new HttpError(400, `AWS keys credential ${label} has no keys stored.`);
  try {
    const k = JSON.parse(decrypt(String(cred.secret_enc), config.secretKey)) as AwsKeys;
    if (!k.accessKeyId || !k.secretAccessKey) throw new Error('incomplete');
    return k;
  } catch { throw new HttpError(500, `Could not read the AWS keys of credential ${label}.`); }
}

async function buildEnvFromCred(cred: CredentialRow): Promise<Record<string, string>> {
  const mode = String(cred.mode);
  const extra = safeJson(cred.extra_config);
  const label = `"${String(cred.name)}" (${String(cred.engine)}/${mode})`;

  if (String(cred.engine) === 'kiro') {
    if (mode === 'api_key') {
      if (!cred.secret_enc) {
        throw new HttpError(400, `Kiro credential ${label} has no API key stored. Update it in Credentials.`);
      }
      let val: string;
      try { val = decrypt(String(cred.secret_enc), config.secretKey); }
      catch { throw new HttpError(500, `Could not decrypt Kiro credential ${label}.`); }
      if (!val) throw new HttpError(400, `Kiro credential ${label} decrypted to an empty value.`);
      return { KIRO_API_KEY: val };
    }

    if (mode === 'identity_center') {
      // IDC access tokens must be delivered via the materialised home dir
      // (~/.aws/sso/cache/device-sso-lsp-token.json) — not as KIRO_API_KEY.
      // kiro.ts reads the sentinel keys, writes the cache file, then removes them.
      if (!cred.secret_enc) {
        throw new HttpError(400, `Kiro Identity Center credential ${label} has no token yet. Complete the device-code sign-in flow first.`);
      }

      // Detect credentials created with old scopes (sso:account:access).
      // These lack clientId in extra_config after sign-in completed.
      if (!extra.clientId && !extra.signedInAt) {
        throw new HttpError(400,
          `Kiro Identity Center credential ${label} was created with outdated authentication scopes. ` +
          `Use Sign in again in Credentials to re-authenticate.`,
        );
      }

      // Auto-refresh if token is expired or expiring within 5 minutes.
      // Throws HttpError(400) with a sign-in prompt if refresh is not possible.
      await autoRefreshIdcIfNeeded(String(cred.id));

      // Ensure the credential has a Kiro profile; fetch lazily if missing.
      // Must happen after auto-refresh so the token is fresh.
      await ensureKiroProfileFetched(String(cred.id));

      // Re-read the credential row in case a refresh occurred.
      const activeCred = await getCredentialsRepository().getById(String(cred.id)) ?? cred;
      const activeExtra = safeJson(activeCred.extra_config);

      let val: string;
      try { val = decrypt(String(activeCred.secret_enc ?? ''), config.secretKey); }
      catch { throw new HttpError(500, `Could not decrypt Kiro Identity Center credential ${label}.`); }
      if (!val) throw new HttpError(400, `Kiro Identity Center credential ${label} decrypted to an empty value.`);

      const region = String(activeExtra.region ?? 'us-east-1');
      const expiresAt = activeExtra.tokenExpiry
        ? String(activeExtra.tokenExpiry)
        : new Date(Date.now() + 28_800_000).toISOString();
      const startUrl = String(activeExtra.startUrl ?? '');

      let refreshToken = '';
      if (activeExtra.refreshTokenEnc && typeof activeExtra.refreshTokenEnc === 'string') {
        try { refreshToken = decrypt(activeExtra.refreshTokenEnc, config.secretKey); } catch { /* best-effort */ }
      }
      let clientSecret = '';
      if (activeExtra.clientSecretEnc && typeof activeExtra.clientSecretEnc === 'string') {
        try { clientSecret = decrypt(activeExtra.clientSecretEnc, config.secretKey); } catch { /* best-effort */ }
      }
      const clientId = String(activeExtra.clientId ?? '');
      const clientSecretExpiresAt = String(activeExtra.clientSecretExpiresAt ?? 0);
      const profileArn = activeExtra.selectedProfileArn ? String(activeExtra.selectedProfileArn) : '';
      const profileName = activeExtra.selectedProfileName ? String(activeExtra.selectedProfileName) : '';

      const result: Record<string, string> = {
        [IDC_TOKEN_KEY]: val,
        [IDC_REGION_KEY]: region,
        [IDC_EXPIRY_KEY]: expiresAt,
        [IDC_START_URL_KEY]: startUrl,
      };
      if (refreshToken) result[IDC_REFRESH_TOKEN_KEY] = refreshToken;
      if (clientId) result[IDC_CLIENT_ID_KEY] = clientId;
      if (clientSecret) result[IDC_CLIENT_SECRET_KEY] = clientSecret;
      if (clientSecretExpiresAt !== '0') result[IDC_CLIENT_SECRET_EXPIRES_AT_KEY] = clientSecretExpiresAt;
      if (profileArn) result[IDC_PROFILE_ARN_KEY] = profileArn;
      if (profileName) result[IDC_PROFILE_NAME_KEY] = profileName;
      return result;
    }
  }

  if (String(cred.engine) === 'claude-code') {
    if (mode === 'api_key') {
      if (!cred.secret_enc) {
        throw new HttpError(400, `Anthropic API key credential ${label} has no secret stored.`);
      }
      let val: string;
      try { val = decrypt(String(cred.secret_enc), config.secretKey); }
      catch { throw new HttpError(500, `Could not decrypt Anthropic API key credential ${label}.`); }
      if (!val) throw new HttpError(400, `Anthropic API key credential ${label} decrypted to an empty value.`);
      return { ANTHROPIC_API_KEY: val };
    }

    if (mode === 'subscription_token') {
      if (!cred.secret_enc) {
        throw new HttpError(400, `Claude subscription token credential ${label} has no secret stored.`);
      }
      let val: string;
      try { val = decrypt(String(cred.secret_enc), config.secretKey); }
      catch { throw new HttpError(500, `Could not decrypt Claude subscription token credential ${label}.`); }
      if (!val) throw new HttpError(400, `Claude subscription token credential ${label} decrypted to an empty value.`);
      return { CLAUDE_CODE_OAUTH_TOKEN: val };
    }

    if (mode === 'aws_keys') {
      const keys = readAwsKeys(cred, label);
      const region = String(extra.region ?? 'us-east-1');
      return {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: region,
        AWS_DEFAULT_REGION: region,
        AWS_ACCESS_KEY_ID: keys.accessKeyId,
        AWS_SECRET_ACCESS_KEY: keys.secretAccessKey,
        ...(keys.sessionToken ? { AWS_SESSION_TOKEN: keys.sessionToken } : {}),
      };
    }

    if (mode === 'bedrock_role') {
      const roleArn = String(extra.roleArn ?? '');
      const region = String(extra.region ?? 'us-east-1');
      const externalId = extra.externalId ? String(extra.externalId) : undefined;
      if (!roleArn) {
        throw new HttpError(400, `Bedrock role credential ${label} has no roleArn configured.`);
      }
      try {
        const tmp = await assumeRole(roleArn, region, externalId);
        return {
          CLAUDE_CODE_USE_BEDROCK: '1',
          AWS_REGION: region,
          AWS_DEFAULT_REGION: region,
          AWS_ACCESS_KEY_ID: tmp.accessKeyId,
          AWS_SECRET_ACCESS_KEY: tmp.secretAccessKey,
          AWS_SESSION_TOKEN: tmp.sessionToken,
        };
      } catch (e: unknown) {
        const raw = String((e as Error)?.message ?? e);
        // Strip any embedded credential-looking values (40-char alpha-num strings)
        const safe = raw.replace(/[A-Za-z0-9+/]{20,}/g, '***');
        throw new HttpError(502, `Could not assume role ${roleArn}: ${safe}`);
      }
    }
  }

  // Should never reach here with validated data; fail clearly rather than silently billing portal
  throw new HttpError(500, `Unknown credential type: engine=${String(cred.engine)} mode=${mode}`);
}

/**
 * Update an identity_center credential after kiro-cli refreshes the access_token
 * during a run or model listing. Re-encrypts and saves the new token values.
 *
 * Non-fatal: wraps all errors silently. Never logs token values.
 * Called from kiro.ts and models.ts before the temp auth DB is cleaned up.
 */
export async function refreshIdcCredentialToken(
  credentialId: string,
  newAccessToken: string,
  newExpiresAt: string,
  newRefreshToken: string | undefined,
): Promise<void> {
  try {
    const cred = await getCredentialsRepository().getById(credentialId);
    if (!cred || cred.mode !== 'identity_center') return;
    const extra = safeJson(cred.extra_config);
    const newExtra: Record<string, unknown> = {
      ...extra,
      tokenExpiry: newExpiresAt,
    };
    if (newRefreshToken) {
      newExtra.refreshTokenEnc = encrypt(newRefreshToken, config.secretKey);
    }
    delete newExtra.pendingClientId;
    delete newExtra.pendingClientSecret;
    delete newExtra.pendingClientSecretEnc;
    delete newExtra.pendingDeviceCode;
    delete newExtra.pendingExpireAt;
    delete newExtra.pendingClientSecretExpiresAt;

    const tokenEnc = encrypt(newAccessToken, config.secretKey);
    await getCredentialsRepository().updateToken(
      credentialId,
      tokenEnc,
      JSON.stringify(newExtra),
      newAccessToken.slice(-4),
      now(),
    );
  } catch {
    // Non-fatal — worst case the user re-authenticates at the next session
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerCredentialRoutes(): void {

  // GET /api/credentials — list (browser only)
  router.get('/api/credentials', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;

    const rows = await getCredentialsRepository().listByUser(req.user!.id);

    sendJson(res, 200, { credentials: rows.map(credView) });
  });

  // ── Claude plan sign-in from the portal (drives `claude setup-token`; see claude-login.ts) ──
  router.get('/api/claude-login/status', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;
    const support = await claudeLoginSupport();
    sendJson(res, 200, { ...support, login: getClaudeLoginState(req.user!.id) });
  });

  router.post('/api/claude-login/start', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;
    sendJson(res, 200, { login: await startClaudeLogin(req.user!.id) });
  });

  // Body: { code, name?, isDefault? } — stores the resulting token as a subscription_token credential.
  router.post('/api/claude-login/complete', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = str(body.code as string, 'code', { max: 400 });
    const name = (str(body.name as string, 'name', { max: 100, optional: true }).trim()) || 'Claude plan';
    const isDefault = Boolean(body.isDefault ?? false);
    const token = await submitClaudeLoginCode(req.user!.id, code);

    const id = generateId();
    const ts = now();
    if (isDefault) await getCredentialsRepository().clearDefaults(req.user!.id, 'claude-code');
    const created = await getCredentialsRepository().create({
      id, user_id: req.user!.id, engine: 'claude-code', name, mode: 'subscription_token',
      secret_enc: encrypt(token, config.secretKey),
      extra_config: JSON.stringify({ via: 'portal_login' }),
      is_default: isDefault ? 1 : 0,
      last4: token.slice(-4),
      created_at: ts, updated_at: ts, updated_by: req.user!.id,
    });
    appendAudit(getDb(), req.user!.id, 'credential.create', `credential:${id}`,
      { engine: 'claude-code', mode: 'subscription_token', name, via: 'portal_login' }, req.ip);
    sendJson(res, 201, { credential: credView(created) });
  });

  router.post('/api/claude-login/cancel', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;
    cancelClaudeLogin(req.user!.id);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/credentials — create (browser only)
  router.post('/api/credentials', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const engineStr = str(body.engine as string, 'engine');
    if (engineStr !== 'kiro' && engineStr !== 'claude-code') {
      throw badRequest('engine must be kiro or claude-code');
    }
    const engine = engineStr as Engine;
    const modeStr = str(body.mode as string, 'mode');
    const mode = validateMode(engine, modeStr);
    const name = (str(body.name as string, 'name', { max: 100, optional: true }).trim()) || `${engine} credential`;
    // A person's first Kiro sign-in is their default whatever the form says (it sends isDefault: false when the box is not
    // ticked): with none marked, every Kiro feature would report "no credentials".
    const firstKiro = engine === 'kiro' && !(await getCredentialsRepository().getDefaultByUserAndEngine(req.user!.id, engine));
    const isDefault = Boolean(body.isDefault ?? false) || firstKiro;
    const credConfig = ((body.config ?? {}) as Record<string, unknown>);

    const id = generateId();
    const ts = now();

    // ── identity_center: start device-code flow ────────────────────────────
    if (mode === 'identity_center') {
      const startUrl = str(credConfig.startUrl as string, 'config.startUrl');
      const region = str(credConfig.region as string, 'config.region');

      let deviceChallenge: Record<string, unknown>;
      let extraForStore: Record<string, unknown>;

      // Device authorization is a short AWS OIDC exchange, even when agents run
      // on AgentCore. Do not launch an interactive CLI or cold runner from this request.
      try {
        const oidc = await makeOIDCClient(region);
        const reg = await withOIDCTimeout(oidc.registerClient({
          clientName: 'agent-portal', clientType: 'public',
          scopes: [...KIRO_IDC_SCOPES],
          grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        }), _oidcCallTimeoutMs ?? 15_000);
        const da = await withOIDCTimeout(oidc.startDeviceAuthorization({
          clientId: reg.clientId, clientSecret: reg.clientSecret, startUrl,
        }), _oidcCallTimeoutMs ?? 15_000);
        extraForStore = {
          startUrl, region, pendingClientId: reg.clientId,
          pendingClientSecretEnc: encrypt(reg.clientSecret, config.secretKey),
          pendingClientSecretExpiresAt: reg.clientSecretExpiresAt ?? 0,
          pendingDeviceCode: da.deviceCode,
          pendingExpireAt: Date.now() + da.expiresIn * 1000,
        };
        deviceChallenge = {
          verificationUri: da.verificationUriComplete ?? da.verificationUri,
          userCode: da.userCode, expiresIn: da.expiresIn, interval: da.interval,
        };
      } catch (e) {
        if (classifyOidcError(e) === 'transient') throw new HttpError(504, 'AWS sign-in is taking too long or is temporarily unavailable. Please try again.');
        throw new HttpError(502, `Failed to start device authorization: ${(e as Error)?.message ?? e}`);
      }

      if (isDefault) {
        await getCredentialsRepository().clearDefaults(req.user!.id, engine);
      }

      const created = await getCredentialsRepository().create({
        id, user_id: req.user!.id, engine, name, mode,
        secret_enc: null,
        extra_config: JSON.stringify(extraForStore),
        is_default: isDefault ? 1 : 0,
        last4: '',
        created_at: ts, updated_at: ts, updated_by: req.user!.id,
      });

      appendAudit(getDb(), req.user!.id, 'credential.create', `credential:${id}`,
        { engine, mode, name }, req.ip);

      sendJson(res, 201, { credential: credView(created), deviceChallenge });
      return;
    }

    // ── bedrock_role: no secret, just config ──────────────────────────────
    let secretEnc: string | null = null;
    let last4 = '';

    if (mode === 'aws_keys') {
      str(credConfig.region as string, 'config.region'); // validate required
      const parsed = parseAwsKeys(body.awsKeys);
      secretEnc = parsed.secretEnc;
      last4 = parsed.last4;
    } else if (mode === 'bedrock_role') {
      const roleArn = str(credConfig.roleArn as string, 'config.roleArn');
      if (!roleArn.startsWith('arn:')) throw badRequest('config.roleArn must be a valid ARN');
      str(credConfig.region as string, 'config.region'); // validate required
    } else {
      // api_key or subscription_token: secret required
      const secret = str(body.secret as string, 'secret');
      if (!secret.trim()) throw badRequest('secret is required');
      secretEnc = encrypt(secret.trim(), config.secretKey);
      last4 = secret.trim().slice(-4);
    }

    if (isDefault) {
      await getCredentialsRepository().clearDefaults(req.user!.id, engine);
    }

    const created = await getCredentialsRepository().create({
      id, user_id: req.user!.id, engine, name, mode,
      secret_enc: secretEnc,
      extra_config: JSON.stringify(credConfig),
      is_default: isDefault ? 1 : 0,
      last4,
      created_at: ts, updated_at: ts, updated_by: req.user!.id,
    });

    appendAudit(getDb(), req.user!.id, 'credential.create', `credential:${id}`,
      { engine, mode, name }, req.ip);

    sendJson(res, 201, { credential: credView(created) });
  });

  // PUT /api/credentials/:id — update name or secret (browser only)
  router.put('/api/credentials/:id', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;
    const cred = await requireOwned(res, req.params.id, req.user!.id);
    if (!cred) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const ts = now();
    const fields: import('./repositories/credentials.ts').UpdateCredentialFields = {
      updated_at: ts,
      updated_by: req.user!.id,
    };

    if (typeof body.name === 'string' && body.name.trim()) {
      fields.name = body.name.trim().slice(0, 100);
    }

    if (String(cred.mode) === 'aws_keys' && body.awsKeys) {
      const parsed = parseAwsKeys(body.awsKeys);
      fields.secret_enc = parsed.secretEnc;
      fields.last4 = parsed.last4;
    }

    if (
      typeof body.secret === 'string' &&
      body.secret.trim() &&
      String(cred.mode) !== 'bedrock_role' &&
      String(cred.mode) !== 'aws_keys'
    ) {
      fields.secret_enc = encrypt(body.secret.trim(), config.secretKey);
      fields.last4 = body.secret.trim().slice(-4);
    }

    if (typeof body.config === 'object' && body.config !== null && String(cred.mode) === 'bedrock_role') {
      fields.extra_config = JSON.stringify(body.config);
    }

    const updated = await getCredentialsRepository().update(String(cred.id), fields);

    appendAudit(getDb(), req.user!.id, 'credential.update', `credential:${String(cred.id)}`,
      { name: fields.name }, req.ip);

    sendJson(res, 200, { credential: updated ? credView(updated) : null });
  });

  // DELETE /api/credentials/:id (browser only)
  router.delete('/api/credentials/:id', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;
    const cred = await requireOwned(res, req.params.id, req.user!.id);
    if (!cred) return;

    await getCredentialsRepository().delete(String(cred.id));
    if (cred.engine === 'kiro' && cred.is_default) {
      // Do not leave the person with Kiro sign-ins but none marked as the default.
      const next = await findUserCredential(req.user!.id, 'kiro');
      if (next) await getCredentialsRepository().setDefault(String(next.id), now());
    }
    appendAudit(getDb(), req.user!.id, 'credential.delete', `credential:${String(cred.id)}`,
      { engine: String(cred.engine), name: String(cred.name) }, req.ip);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/credentials/check — does this sign-in work? { engine, credentialId? } (no id: the one a session would use).
  // Lists the models with it, which is a real call for API keys, roles, Kiro and Bedrock. Browser only.
  router.post('/api/credentials/check', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const engine = String(body.engine ?? '');
    if (engine !== 'kiro' && engine !== 'claude-code') throw new HttpError(400, 'engine must be kiro or claude-code');
    const credentialId = body.credentialId ? String(body.credentialId) : null;
    if (credentialId && !isBedrockRuntimeChoice(engine, credentialId)) {
      const own = await getCredentialsRepository().getByIdAndUser(credentialId, req.user!.id);
      if (!own || own.engine !== engine) throw new HttpError(404, 'Sign-in not found');
      // A Claude plan token cannot be checked without starting a run.
      if (own.mode === 'subscription_token') {
        sendJson(res, 200, { ok: true, checked: false, message: 'Saved. A Claude plan token can only be confirmed by a run, so the first session will tell.' });
        return;
      }
    }
    const { getEngineModels } = await import('./models.ts');
    const r = await getEngineModels(engine, req.user!.id, credentialId, true);
    const n = r.models.length;
    if (r.error || n === 0) {
      sendJson(res, 200, { ok: false, checked: true, runsAs: r.runsAs.label, message: r.error || 'The sign-in answered, but no models are available to it.' });
      return;
    }
    sendJson(res, 200, { ok: true, checked: true, runsAs: r.runsAs.label, message: `Works. ${n} model${n === 1 ? '' : 's'} available (${r.runsAs.label}).` });
  });

  // POST /api/credentials/:id/set-default (browser only)
  router.post('/api/credentials/:id/set-default', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;
    const cred = await requireOwned(res, req.params.id, req.user!.id);
    if (!cred) return;

    await getCredentialsRepository().clearDefaults(req.user!.id, String(cred.engine));
    await getCredentialsRepository().setDefault(String(cred.id), now());

    const updated = await getCredentialsRepository().getById(String(cred.id));
    sendJson(res, 200, { credential: updated ? credView(updated) : null });
  });

  // POST /api/credentials/:id/device-poll — poll for SSO token (browser only)
  router.post('/api/credentials/:id/device-poll', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;
    const cred = await requireOwned(res, req.params.id, req.user!.id);
    if (!cred) return;

    if (String(cred.mode) !== 'identity_center') {
      sendJson(res, 400, { error: 'Not an identity_center credential' });
      return;
    }

    const extra = safeJson(cred.extra_config);
    const deviceCode = String(extra.pendingDeviceCode ?? '');

    // ── AgentCore login polling ────────────────────────────────────────────
    // When kiro-login was started via AgentCore, pendingDeviceCode is set to
    // 'agentcore' as a sentinel.  We check the in-process login state map.
    if (deviceCode === 'agentcore') {
      let poll = await pollAgentCoreLoginShared(String(cred.id));
      // Long-poll while pending: on Lambda the background login stream only makes progress while a
      // request is active, so holding this request open (up to ~6s; kept short because the account allows few concurrent Lambdas) lets it finish.
      for (let waited = 0; poll.status === 'pending' && waited < 6_000; waited += 1_000) {
        await new Promise((r) => setTimeout(r, 1_000));
        poll = await pollAgentCoreLoginShared(String(cred.id));
      }
      if (poll.status === 'pending') {
        sendJson(res, 200, { status: 'pending' });
        return;
      }
      if (poll.status === 'unknown') {
        // Map entry expired or was never set — treat as expired
        sendJson(res, 200, { status: 'expired' });
        return;
      }
      if (poll.status === 'failed') {
        sendJson(res, 200, { status: 'expired' });
        return;
      }
      // status === 'complete'
      const tp = poll.tokenPayload;
      if (!tp) {
        sendJson(res, 200, { status: 'expired' });
        return;
      }

      // Store the token received from AgentCore kiro-login
      const accessToken = String(tp.access_token ?? '');
      const tokenEnc = encrypt(accessToken, config.secretKey);
      const expiresAtStr = String(tp.expires_at ?? '');
      const tokenExpiry = expiresAtStr || new Date(Date.now() + 28_800_000).toISOString();
      // The runner returns the sign-in client kiro-cli registered; with it the token can be renewed
      // without asking the user to sign in again.
      const clientSecretExpiresAt = Number(tp.client_secret_expires_at ?? extra.pendingClientSecretExpiresAt ?? 0);
      const clientId = String(tp.client_id ?? extra.pendingClientId ?? extra.clientId ?? '');

      const newExtra: Record<string, unknown> = {
        startUrl: String(extra.startUrl ?? tp.start_url ?? ''),
        region: String(extra.region ?? tp.region ?? 'us-east-1'),
        tokenExpiry,
        signedInAt: now(),
        ...(clientId ? { clientId } : {}),
        ...(clientSecretExpiresAt ? { clientSecretExpiresAt } : {}),
        ...(tp.client_secret
          ? { clientSecretEnc: encrypt(tp.client_secret, config.secretKey) }
          : extra.clientSecretEnc ? { clientSecretEnc: String(extra.clientSecretEnc) } : {}),
      };
      if (tp.refresh_token) {
        newExtra.refreshTokenEnc = encrypt(tp.refresh_token, config.secretKey);
      }

      await getCredentialsRepository().updateToken(
        String(cred.id),
        tokenEnc,
        JSON.stringify(newExtra),
        accessToken.slice(-4),
        now(),
      );

      // Fetch profile asynchronously
      fetchAndStoreProfile(String(cred.id), accessToken, String(newExtra.region)).catch(() => { /* non-fatal */ });

      const updated = await getCredentialsRepository().getById(String(cred.id));
      sendJson(res, 200, { status: 'complete', credential: updated ? credView(updated) : null });
      return;
    }

    // ── Standard local OIDC polling (unchanged) ────────────────────────────
    const clientId = String(extra.pendingClientId ?? '');
    const clientSecret = extra.pendingClientSecretEnc
      ? decrypt(String(extra.pendingClientSecretEnc), config.secretKey) ?? ''
      : String(extra.pendingClientSecret ?? ''); // compatibility with existing pending logins
    const region = String(extra.region ?? 'us-east-1');
    const pendingExpireAt = Number(extra.pendingExpireAt ?? 0);

    if (!clientId || !clientSecret || !deviceCode || deviceCode === 'agentcore') {
      sendJson(res, 400, { error: 'Device code flow not started or already completed' });
      return;
    }

    if (pendingExpireAt && Date.now() > pendingExpireAt) {
      sendJson(res, 200, { status: 'expired' });
      return;
    }

    try {
      const oidc = await makeOIDCClient(region);
      const result = await oidc.createToken({
        clientId,
        clientSecret,
        deviceCode,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      });

      const tokenEnc = encrypt(result.accessToken, config.secretKey);
      const tokenExpiry = result.expiresIn
        ? new Date(Date.now() + result.expiresIn * 1000).toISOString()
        : null;

      const clientSecretExpiresAt = Number(extra.pendingClientSecretExpiresAt ?? 0);

      const newExtra: Record<string, unknown> = {
        startUrl: String(extra.startUrl ?? ''),
        region,
        tokenExpiry,
        signedInAt: now(),
        clientId,
        clientSecretExpiresAt,
      };
      if (clientSecret) {
        newExtra.clientSecretEnc = encrypt(clientSecret, config.secretKey);
      }
      if (result.refreshToken) {
        newExtra.refreshTokenEnc = encrypt(result.refreshToken, config.secretKey);
      }

      await getCredentialsRepository().updateToken(
        String(cred.id),
        tokenEnc,
        JSON.stringify(newExtra),
        result.accessToken.slice(-4),
        now(),
      );

      // Fetch and store the user's Kiro profile asynchronously — non-blocking.
      // If fetch fails, the credential's status will remain OK; profile is
      // fetched lazily before the first run via ensureKiroProfileFetched().
      fetchAndStoreProfile(String(cred.id), result.accessToken, region).catch(() => { /* non-fatal */ });

      const updated2 = await getCredentialsRepository().getById(String(cred.id));
      sendJson(res, 200, { status: 'complete', credential: updated2 ? credView(updated2) : null });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (matchSdkError(e, 'AuthorizationPendingException', 'authorization_pending')) {
        sendJson(res, 200, { status: 'pending' });
      } else if (matchSdkError(e, 'ExpiredTokenException', 'expired_token')) {
        sendJson(res, 200, { status: 'expired' });
      } else if (matchSdkError(e, 'SlowDownException', 'slow_down')) {
        sendJson(res, 200, { status: 'slow_down' });
      } else {
        throw new HttpError(502, `Device code poll failed: ${msg}`);
      }
    }
  });

  // POST /api/credentials/:id/refresh — refresh IDC access token via refresh_token grant (browser only)
  router.post('/api/credentials/:id/refresh', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;
    const cred = await requireOwned(res, req.params.id, req.user!.id);
    if (!cred) return;

    if (String(cred.mode) !== 'identity_center') {
      sendJson(res, 400, { error: 'Only identity_center credentials support token refresh' });
      return;
    }

    const extra = safeJson(cred.extra_config);
    // Fail fast before attempting OIDC if we know it will be rejected
    if (!extra.refreshTokenEnc) {
      sendJson(res, 409, { error: "Your sign-in can't be renewed. Sign in again.", needsSignIn: true });
      return;
    }
    const clientSecretExpiresAt = Number(extra.clientSecretExpiresAt ?? 0);
    if (clientSecretExpiresAt > 0 && clientSecretExpiresAt * 1000 < Date.now()) {
      sendJson(res, 409, { error: "Your sign-in can't be renewed. Sign in again.", needsSignIn: true });
      return;
    }

    const result = await attemptTokenRefresh(cred);
    if (!result.ok) {
      if (result.transient) {
        sendJson(res, 504, { error: "AWS sign-in service didn't respond. Try again." });
      } else {
        sendJson(res, 409, { error: result.message, needsSignIn: true });
      }
      return;
    }

    appendAudit(getDb(), req.user!.id, 'credential.refresh', `credential:${String(cred.id)}`,
      { name: String(cred.name) }, req.ip);

    const refreshed = await getCredentialsRepository().getById(String(cred.id));
    sendJson(res, 200, { credential: refreshed ? credView(refreshed) : null });
  });

  // POST /api/credentials/:id/reauth — start a new device-code flow for the same credential (browser only)
  router.post('/api/credentials/:id/reauth', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;
    const cred = await requireOwned(res, req.params.id, req.user!.id);
    if (!cred) return;

    if (String(cred.mode) !== 'identity_center') {
      sendJson(res, 400, { error: 'Only identity_center credentials support re-authentication' });
      return;
    }

    const extra = safeJson(cred.extra_config);
    const startUrl = String(extra.startUrl ?? '');
    const region = String(extra.region ?? 'us-east-1');

    if (!startUrl) {
      sendJson(res, 400, { error: 'Credential has no startUrl stored; cannot start a new sign-in flow' });
      return;
    }

    try {
      const oidc = await makeOIDCClient(region);

      // Reuse stored client registration if it is still valid (or no expiry recorded).
      // Otherwise register a new client. Old-scope credentials (no clientId) also
      // go through re-registration so they get the correct codewhisperer scopes.
      const storedClientId = String(extra.clientId ?? '');
      const storedClientSecretExpiresAt = Number(extra.clientSecretExpiresAt ?? 0);
      const storedClientSecretEnc = extra.clientSecretEnc as string | undefined;
      const clientRegStillValid =
        Boolean(storedClientId) &&
        Boolean(storedClientSecretEnc) &&
        (storedClientSecretExpiresAt === 0 || storedClientSecretExpiresAt * 1000 > Date.now());

      let clientId: string;
      let clientSecret: string;
      let clientSecretExpiresAt: number;
      let newClientId: string | null = null;
      let newClientSecretEnc: string | null = null;
      let newClientSecretExpiresAt: number | null = null;

      if (clientRegStillValid) {
        let decrypted: string | null = null;
        try { decrypted = decrypt(storedClientSecretEnc!, config.secretKey); } catch { /* fall through */ }
        if (decrypted !== null) {
          clientId = storedClientId;
          clientSecret = decrypted;
          clientSecretExpiresAt = storedClientSecretExpiresAt;
        } else {
          // Decryption failed — re-register
          const reg = await withOIDCTimeout(oidc.registerClient({
            clientName: 'agent-portal',
            clientType: 'public',
            scopes: [...KIRO_IDC_SCOPES],
            grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
          }), _oidcCallTimeoutMs ?? 15_000);
          clientId = reg.clientId;
          clientSecret = reg.clientSecret;
          clientSecretExpiresAt = reg.clientSecretExpiresAt ?? 0;
          newClientId = clientId;
          newClientSecretEnc = encrypt(clientSecret, config.secretKey);
          newClientSecretExpiresAt = clientSecretExpiresAt;
        }
      } else {
        const reg = await withOIDCTimeout(oidc.registerClient({
          clientName: 'agent-portal',
          clientType: 'public',
          scopes: [...KIRO_IDC_SCOPES],
          grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        }), _oidcCallTimeoutMs ?? 15_000);
        clientId = reg.clientId;
        clientSecret = reg.clientSecret;
        clientSecretExpiresAt = reg.clientSecretExpiresAt ?? 0;
        newClientId = clientId;
        newClientSecretEnc = encrypt(clientSecret, config.secretKey);
        newClientSecretExpiresAt = clientSecretExpiresAt;
      }

      const da = await withOIDCTimeout(oidc.startDeviceAuthorization({ clientId, clientSecret, startUrl }), _oidcCallTimeoutMs ?? 15_000);

      // Preserve existing completed-auth fields so the credential stays usable while
      // the re-auth flow is pending. Overwrite pending fields with the new flow.
      const extraForStore: Record<string, unknown> = {
        startUrl,
        region,
        ...(extra.tokenExpiry ? { tokenExpiry: String(extra.tokenExpiry) } : {}),
        ...(extra.signedInAt ? { signedInAt: String(extra.signedInAt) } : {}),
        ...(extra.clientId ? { clientId: String(extra.clientId) } : {}),
        ...(extra.clientSecretEnc ? { clientSecretEnc: String(extra.clientSecretEnc) } : {}),
        ...(extra.clientSecretExpiresAt ? { clientSecretExpiresAt: Number(extra.clientSecretExpiresAt) } : {}),
        ...(extra.refreshTokenEnc ? { refreshTokenEnc: String(extra.refreshTokenEnc) } : {}),
        // If we re-registered, update the stored client details
        ...(newClientId ? { clientId: newClientId } : {}),
        ...(newClientSecretEnc ? { clientSecretEnc: newClientSecretEnc } : {}),
        ...(newClientSecretExpiresAt !== null ? { clientSecretExpiresAt: newClientSecretExpiresAt } : {}),
        ...(extra.selectedProfileArn ? { selectedProfileArn: String(extra.selectedProfileArn) } : {}),
        ...(extra.selectedProfileName ? { selectedProfileName: String(extra.selectedProfileName) } : {}),
        // New pending device-code fields
        pendingClientId: clientId,
        pendingClientSecretEnc: encrypt(clientSecret, config.secretKey),
        pendingClientSecretExpiresAt: clientSecretExpiresAt,
        pendingDeviceCode: da.deviceCode,
        pendingExpireAt: Date.now() + da.expiresIn * 1000,
      };

      await getCredentialsRepository().updateExtraConfig(
        String(cred.id),
        JSON.stringify(extraForStore),
        now(),
      );

      appendAudit(getDb(), req.user!.id, 'credential.reauth', `credential:${String(cred.id)}`,
        { name: String(cred.name) }, req.ip);

      const reauthUpdated = await getCredentialsRepository().getById(String(cred.id));
      sendJson(res, 200, {
        credential: reauthUpdated ? credView(reauthUpdated) : null,
        deviceChallenge: {
          verificationUri: da.verificationUriComplete ?? da.verificationUri,
          userCode: da.userCode,
          expiresIn: da.expiresIn,
          interval: da.interval,
        },
      });
    } catch (e) {
      if (classifyOidcError(e) === 'transient') throw new HttpError(504, 'AWS sign-in is taking too long or is temporarily unavailable. Please try again.');
      throw new HttpError(502, `Failed to start re-authentication flow: ${(e as Error)?.message ?? e}`);
    }
  });

  // PUT /api/credentials/:id/profile — choose from multiple available profiles (browser only)
  router.put('/api/credentials/:id/profile', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;
    const cred = await requireOwned(res, req.params.id, req.user!.id);
    if (!cred) return;

    if (String(cred.mode) !== 'identity_center') {
      sendJson(res, 400, { error: 'Only identity_center credentials support profile selection' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const arn = str(body.arn as string, 'arn');
    const extra = safeJson(cred.extra_config);

    // Validate: arn must be in the available profiles list (if stored), or any valid ARN
    const available = Array.isArray(extra.availableProfiles)
      ? (extra.availableProfiles as Array<{ arn: string; profileName: string }>)
      : null;

    if (available && !available.some((p) => p.arn === arn)) {
      sendJson(res, 400, { error: `Profile ARN not in available profiles list: ${arn}` });
      return;
    }

    const profileName = available?.find((p) => p.arn === arn)?.profileName ?? '';

    const newExtra = {
      ...extra,
      selectedProfileArn: arn,
      selectedProfileName: profileName,
    };
    delete (newExtra as Record<string, unknown>).profileFetchError;

    await getCredentialsRepository().updateExtraConfig(String(cred.id), JSON.stringify(newExtra), now());

    appendAudit(getDb(), req.user!.id, 'credential.profile', `credential:${String(cred.id)}`,
      { arn }, req.ip);

    const profileUpdated = await getCredentialsRepository().getById(String(cred.id));
    sendJson(res, 200, { credential: profileUpdated ? credView(profileUpdated) : null });
  });

  // GET /api/credentials/summary — for the New Session dialog (browser only)
  router.get('/api/credentials/summary', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowser(req, res)) return;

    const engines: Engine[] = ['kiro', 'claude-code'];
    const summary = await Promise.all(engines.map(async (engine) => {
      const rows = await getCredentialsRepository().listByUser(req.user!.id);
      const engineRows = rows.filter((r) => r.engine === engine);

      return {
        engine,
        configured: engineRows.length > 0,
        credentials: engineRows.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          mode: String(r.mode),
          last4: String(r.last4 ?? ''),
          isDefault: Boolean(r.is_default),
        })),
      };
    }));

    // Cloud portal: Claude Code can always run on Bedrock with this AWS account's runtime role.
    const claude = summary.find((e) => e.engine === 'claude-code');
    if (claude && bedrockRuntimeAvailable()) {
      claude.credentials.push({
        id: BEDROCK_RUNTIME_SIGN_IN, name: 'Amazon Bedrock (this AWS account)', mode: 'bedrock_runtime', last4: '', isDefault: false, virtual: true,
      } as (typeof claude.credentials)[number]);
    }

    const codexConfigured = await hasCodexLogin(req.user!.id);
    sendJson(res, 200, { summary: [...summary, { engine: 'codex', configured: codexConfigured, credentials: [] }] });
  });
}
