/**
 * AWS IAM Identity Center (SSO) device-authorization flow.
 *
 * Flow overview (RFC 8628 / AWS IAM Identity Center OIDC):
 *  1. POST /api/sso/start  — RegisterClient (cached), StartDeviceAuthorization
 *                           → returns { userCode, verificationUriComplete, expiresIn, interval }
 *  2. GET  /api/sso/status — background poller calls CreateToken; returns { state, accountId?, roleName?, expiresAt? }
 *  3. GET  /api/sso/accounts — ListAccounts (paginated)
 *  4. GET  /api/sso/roles?accountId=… — ListAccountRoles (paginated)
 *  5. POST /api/sso/select  — saves chosen accountId + roleName to settings
 *  6. DELETE /api/sso/session — signs out (deletes stored tokens)
 *
 * Credentials (awsEnv for Bedrock / CodeCommit):
 *  - GetRoleCredentials with the stored access token + selected account/role
 *  - Short-term creds cached in memory until shortly before expiry
 *  - If access token has expired and a refresh token exists, refresh via CreateToken grant_type=refresh_token
 *
 * NOTE: This module does NOT import from settings.ts to avoid a circular dependency.
 * It reads the aws sub-object directly from the DB and calls the DB update functions
 * to persist account/role selection. settings.ts imports ssoCredentials/ssoStatus from here.
 */

import { SSOOIDCClient, RegisterClientCommand, StartDeviceAuthorizationCommand, CreateTokenCommand } from '@aws-sdk/client-sso-oidc';
import { SSOClient, ListAccountsCommand, ListAccountRolesCommand, GetRoleCredentialsCommand } from '@aws-sdk/client-sso';
import { get, post, del } from './http.ts';
import { encrypt, decrypt } from './secrets.ts';
import { badRequest } from './util.ts';
import { one, run as dbRun } from './db.ts';
import { clearModelListCache } from './model-cache.ts';

// ---- Helpers to read/write AWS settings directly from DB --------
// (avoids importing from settings.ts which would create a circular dep)

interface AwsSsoSettings {
  region: string;
  ssoStartUrl?: string;
  ssoRegion?: string;
  ssoAccountId?: string;
  ssoRoleName?: string;
}

function readAwsSsoSettings(): AwsSsoSettings {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = 'aws'");
  if (!row) return { region: 'us-east-1' };
  try {
    return JSON.parse(row.value) as AwsSsoSettings;
  } catch {
    return { region: 'us-east-1' };
  }
}

function patchAwsSettings(patch: Partial<AwsSsoSettings>): void {
  const cur = readAwsSsoSettings();
  const next = { ...cur, ...patch };
  dbRun(
    "INSERT INTO settings (key, value) VALUES ('aws', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify(next),
  );
}

// ---- In-memory caches -------------------------------------------

interface ClientReg {
  clientId: string;
  clientSecret: string;
  expiresAt: number; // ms epoch
  region: string;
}

interface ShortCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: number; // ms epoch
}

interface PollState {
  state: 'pending' | 'authorised' | 'expired' | 'error';
  error?: string;
}

let clientReg: ClientReg | null = null;
let pollState: PollState = { state: 'pending' };
let pollTimer: ReturnType<typeof setTimeout> | null = null;
/** Temporary role credentials per "account/role", so several projects can use different SSO accounts at once. */
const roleCredsCache = new Map<string, ShortCreds>();

/**
 * Reset all in-memory SSO state (test helper).
 * Not called by production code.
 */
export function resetSsoState(): void {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  clientReg = null;
  pollState = { state: 'pending' };
  roleCredsCache.clear();
}

// ---- Validation constants ----------------------------------------

const SSO_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const START_URL_RE = /^https:\/\/.+/;

// ---- AWS SDK client factories -----------------------------------
// Default factories use the real AWS SDK. Tests override these via
// setOidcClientFactory / setSsoClientFactory before importing the server.

type OidcFactory = (region: string) => SSOOIDCClient;
type SsoFactory = (region: string) => SSOClient;

let _oidcFactory: OidcFactory = (region) => new SSOOIDCClient({ region });
let _ssoFactory: SsoFactory = (region) => new SSOClient({ region });

/** Override the OIDC client factory (test seam). */
export function setOidcClientFactory(f: OidcFactory): void {
  _oidcFactory = f;
}

/** Override the SSO client factory (test seam). */
export function setSsoClientFactory(f: SsoFactory): void {
  _ssoFactory = f;
}

function oidcClient(region: string): SSOOIDCClient {
  return _oidcFactory(region);
}

function ssoClient(region: string): SSOClient {
  return _ssoFactory(region);
}

// ---- Client registration (cached per region) --------------------

async function getClientReg(region: string): Promise<ClientReg> {
  const now = Date.now();
  if (clientReg && clientReg.expiresAt > now + 60_000 && clientReg.region === region) {
    return clientReg;
  }
  const client = oidcClient(region);
  const res = await client.send(
    new RegisterClientCommand({
      clientName: 'agent-portal',
      clientType: 'public',
    }),
  );
  if (!res.clientId || !res.clientSecret) {
    throw new Error('RegisterClient returned incomplete response');
  }
  clientReg = {
    clientId: res.clientId,
    clientSecret: res.clientSecret,
    // clientSecretExpiresAt is a Unix timestamp in seconds
    expiresAt: (res.clientSecretExpiresAt ?? 0) * 1000 || now + 90 * 24 * 3600_000,
    region,
  };
  return clientReg;
}

// ---- Background poller ------------------------------------------

function stopPoller(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function startPoller(deviceCode: string, interval: number, expiresIn: number, reg: ClientReg): void {
  stopPoller();
  pollState = { state: 'pending' };
  const deadline = Date.now() + expiresIn * 1000;
  let currentInterval = (interval || 5) * 1000;

  const poll = async (): Promise<void> => {
    if (Date.now() > deadline) {
      pollState = { state: 'expired', error: 'Device authorisation timed out. Start again.' };
      return;
    }
    try {
      const client = oidcClient(reg.region);
      const res = await client.send(
        new CreateTokenCommand({
          clientId: reg.clientId,
          clientSecret: reg.clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode,
        }),
      );
      if (!res.accessToken) {
        pollState = { state: 'error', error: 'No access token in response' };
        return;
      }
      const expiresAt = Date.now() + (res.expiresIn ?? 28800) * 1000;
      const payload = JSON.stringify({
        accessToken: res.accessToken,
        refreshToken: res.refreshToken ?? null,
        expiresAt,
      });
      dbRun(
        "INSERT INTO settings (key, value) VALUES ('sso_tokens', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        encrypt(payload),
      );
      pollState = { state: 'authorised' };
      roleCredsCache.clear();
      clearModelListCache();
    } catch (e: any) {
      const code: string = e?.name ?? e?.code ?? '';
      if (code === 'AuthorizationPendingException' || code === 'authorization_pending') {
        pollTimer = setTimeout(poll, currentInterval);
      } else if (code === 'SlowDownException' || code === 'slow_down') {
        currentInterval += 5000;
        pollTimer = setTimeout(poll, currentInterval);
      } else if (
        code === 'ExpiredTokenException' ||
        code === 'expired_token' ||
        code === 'AccessDeniedException'
      ) {
        pollState = { state: 'expired', error: 'Device authorisation expired. Start again.' };
      } else {
        pollState = { state: 'error', error: (e as Error).message ?? String(e) };
      }
    }
  };

  pollTimer = setTimeout(poll, currentInterval);
}

// ---- Stored token helpers ---------------------------------------

interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

function loadStoredTokens(): StoredTokens | null {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = 'sso_tokens'");
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.value)) as StoredTokens;
  } catch {
    return null;
  }
}

function deleteStoredTokens(): void {
  dbRun("DELETE FROM settings WHERE key = 'sso_tokens'");
  roleCredsCache.clear();
}

async function refreshAccessToken(tokens: StoredTokens): Promise<StoredTokens | null> {
  if (!tokens.refreshToken) return null;
  const s = readAwsSsoSettings();
  const region = s.ssoRegion || s.region;
  try {
    const reg = await getClientReg(region);
    const client = oidcClient(region);
    const res = await client.send(
      new CreateTokenCommand({
        clientId: reg.clientId,
        clientSecret: reg.clientSecret,
        grantType: 'refresh_token',
        refreshToken: tokens.refreshToken,
      }),
    );
    if (!res.accessToken) return null;
    const refreshed: StoredTokens = {
      accessToken: res.accessToken,
      refreshToken: res.refreshToken ?? tokens.refreshToken,
      expiresAt: Date.now() + (res.expiresIn ?? 28800) * 1000,
    };
    dbRun(
      "INSERT INTO settings (key, value) VALUES ('sso_tokens', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      encrypt(JSON.stringify(refreshed)),
    );
    roleCredsCache.clear();
    return refreshed;
  } catch {
    return null;
  }
}

/** Returns a valid access token or throws if session is expired. */
async function requireAccessToken(): Promise<string> {
  let tokens = loadStoredTokens();
  if (!tokens) {
    throw badRequest('Not signed in with AWS SSO. Go to Settings and sign in with AWS SSO.');
  }
  // Refresh if within 5 min of expiry
  if (tokens.expiresAt < Date.now() + 300_000) {
    const refreshed = await refreshAccessToken(tokens);
    if (!refreshed) {
      deleteStoredTokens();
      throw badRequest('AWS SSO session expired. Go to Settings and sign in again.');
    }
    tokens = refreshed;
  }
  return tokens.accessToken;
}

// ---- Public: get temporary AWS credentials ----------------------

/**
 * Called by awsEnv() in settings.ts when auth === 'sso'.
 * Returns { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN }.
 */
export async function ssoCredentials(): Promise<Record<string, string>> {
  const s = readAwsSsoSettings();
  if (!s.ssoAccountId || !s.ssoRoleName) {
    throw badRequest('Select an AWS account and role in Settings › AWS sign-in first.');
  }
  return ssoRoleCredentials(s.ssoAccountId, s.ssoRoleName);
}

/**
 * Temporary credentials for any account and role the portal's SSO sign-in can use. A project picks its own
 * account/role this way, so one IAM Identity Center sign-in serves every project.
 */
export async function ssoRoleCredentials(accountId: string, roleName: string): Promise<Record<string, string>> {
  const key = `${accountId}/${roleName}`;
  const cached = roleCredsCache.get(key);
  // Serve from cache if still fresh (5-minute buffer before expiry)
  if (cached && cached.expiresAt > Date.now() + 300_000) {
    return {
      AWS_ACCESS_KEY_ID: cached.accessKeyId,
      AWS_SECRET_ACCESS_KEY: cached.secretAccessKey,
      AWS_SESSION_TOKEN: cached.sessionToken,
    };
  }

  const s = readAwsSsoSettings();
  const accessToken = await requireAccessToken();
  const region = s.ssoRegion || s.region;
  const client = ssoClient(region);

  const res = await client.send(new GetRoleCredentialsCommand({ accessToken, accountId, roleName }));

  const creds = res.roleCredentials;
  if (!creds?.accessKeyId || !creds?.secretAccessKey) {
    throw badRequest('AWS SSO did not return credentials. Check the account/role selection.');
  }

  const fresh: ShortCreds = {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken ?? '',
    // expiration is ms epoch
    expiresAt: creds.expiration ?? Date.now() + 3600_000,
  };
  roleCredsCache.set(key, fresh);

  return {
    AWS_ACCESS_KEY_ID: fresh.accessKeyId,
    AWS_SECRET_ACCESS_KEY: fresh.secretAccessKey,
    AWS_SESSION_TOKEN: fresh.sessionToken,
  };
}

// ---- Public: SSO status for the UI / publicSettings -------------

export function ssoStatus(): {
  signedIn: boolean;
  accountId?: string;
  roleName?: string;
  expiresAt?: number;
  polling?: boolean;
} {
  const tokens = loadStoredTokens();
  const s = readAwsSsoSettings();
  if (!tokens) {
    return { signedIn: false, polling: pollState.state === 'pending' };
  }
  return {
    signedIn: true,
    accountId: s.ssoAccountId,
    roleName: s.ssoRoleName,
    expiresAt: tokens.expiresAt,
  };
}

// ---- Route registration -----------------------------------------

export function registerSsoRoutes(): void {
  // POST /api/sso/start — kick off device authorisation
  post(
    '/api/sso/start',
    async (ctx) => {
      const body = await ctx.json<{ startUrl?: unknown; ssoRegion?: unknown }>();
      const startUrl: string = String(body.startUrl ?? '').trim();
      const ssoRegion: string = String(body.ssoRegion ?? '').trim();

      if (!START_URL_RE.test(startUrl)) {
        throw badRequest('SSO start URL must begin with https://');
      }
      if (!SSO_REGION_RE.test(ssoRegion)) {
        throw badRequest('SSO region looks wrong (for example us-east-1)');
      }

      // Persist SSO URL + region (non-secret)
      patchAwsSettings({ ssoStartUrl: startUrl, ssoRegion });

      const reg = await getClientReg(ssoRegion);
      const client = oidcClient(ssoRegion);
      const res = await client.send(
        new StartDeviceAuthorizationCommand({
          clientId: reg.clientId,
          clientSecret: reg.clientSecret,
          startUrl,
        }),
      );

      if (!res.deviceCode || !res.userCode || !res.verificationUriComplete) {
        throw badRequest('StartDeviceAuthorization returned an incomplete response');
      }

      startPoller(res.deviceCode, res.interval ?? 5, res.expiresIn ?? 600, reg);

      // Return only what the browser needs — never the device code or secrets
      return {
        userCode: res.userCode,
        verificationUriComplete: res.verificationUriComplete,
        expiresIn: res.expiresIn ?? 600,
        interval: res.interval ?? 5,
      };
    },
    { auth: 'admin' },
  );

  // GET /api/sso/status — browser polls this while waiting for device authorisation
  get(
    '/api/sso/status',
    (_ctx) => {
      const tokens = loadStoredTokens();
      const s = readAwsSsoSettings();

      if (tokens) {
        return {
          state: 'authorised',
          accountId: s.ssoAccountId ?? null,
          roleName: s.ssoRoleName ?? null,
          expiresAt: tokens.expiresAt,
        };
      }
      if (pollState.state === 'expired') {
        return { state: 'expired', error: pollState.error };
      }
      if (pollState.state === 'error') {
        return { state: 'error', error: pollState.error };
      }
      return { state: 'pending' };
    },
    { auth: 'admin' },
  );

  // GET /api/sso/accounts — list all accessible accounts
  get(
    '/api/sso/accounts',
    async (_ctx) => {
      const accessToken = await requireAccessToken();
      const s = readAwsSsoSettings();
      const region = s.ssoRegion || s.region;
      const client = ssoClient(region);

      const accounts: { accountId: string; accountName: string; emailAddress: string }[] = [];
      let nextToken: string | undefined;
      do {
        const res = await client.send(
          new ListAccountsCommand({ accessToken, nextToken, maxResults: 100 }),
        );
        for (const a of res.accountList ?? []) {
          accounts.push({
            accountId: a.accountId ?? '',
            accountName: a.accountName ?? '',
            emailAddress: a.emailAddress ?? '',
          });
        }
        nextToken = res.nextToken;
      } while (nextToken);

      return { accounts };
    },
    { auth: 'admin' },
  );

  // GET /api/sso/roles?accountId=… — list roles for an account
  get(
    '/api/sso/roles',
    async (ctx) => {
      const accountId = ctx.query.get('accountId') ?? '';
      if (!accountId) throw badRequest('accountId query parameter is required');

      const accessToken = await requireAccessToken();
      const s = readAwsSsoSettings();
      const region = s.ssoRegion || s.region;
      const client = ssoClient(region);

      const roles: { roleName: string; accountId: string }[] = [];
      let nextToken: string | undefined;
      do {
        const res = await client.send(
          new ListAccountRolesCommand({ accessToken, accountId, nextToken, maxResults: 100 }),
        );
        for (const r of res.roleList ?? []) {
          roles.push({ roleName: r.roleName ?? '', accountId: r.accountId ?? '' });
        }
        nextToken = res.nextToken;
      } while (nextToken);

      return { roles };
    },
    { auth: 'admin' },
  );

  // POST /api/sso/select — save chosen account + role
  post(
    '/api/sso/select',
    async (ctx) => {
      const body = await ctx.json<{ accountId?: unknown; roleName?: unknown }>();
      const accountId = String(body.accountId ?? '').trim();
      const roleName = String(body.roleName ?? '').trim();
      if (!accountId || !roleName) throw badRequest('accountId and roleName are required');
      roleCredsCache.clear();
      patchAwsSettings({ ssoAccountId: accountId, ssoRoleName: roleName });
      clearModelListCache();
      return { ok: true };
    },
    { auth: 'admin' },
  );

  // DELETE /api/sso/session — sign out
  del(
    '/api/sso/session',
    (_ctx) => {
      stopPoller();
      pollState = { state: 'pending' };
      deleteStoredTokens();
      roleCredsCache.clear();
      clearModelListCache();
      return { ok: true };
    },
    { auth: 'admin' },
  );
}
