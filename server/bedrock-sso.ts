/**
 * Portal-wide Bedrock SSO (AWS IAM Identity Center).
 *
 * One shared identity for the portal. An admin signs in once via device-code
 * flow; all Bedrock usage (Converse, model listing, test connection, agent env,
 * branch scans) uses short-lived role credentials vended from that identity.
 *
 * Tokens are stored encrypted in the settings table using the portal secret key.
 * Role credentials are cached in memory and refreshed 5 min before expiry.
 *
 * All routes are admin + browser-session only. API-token requests are rejected.
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getSetting, setSetting } from './settings.ts';
import { encrypt, decrypt } from './secrets.ts';
import { config } from './config.ts';
import { getDb } from './db.ts';
import { HttpError, now } from './util.ts';
import { appendAudit } from './audit.ts';
import { getSettingsRepository, _updateSnapshotKey, _deleteSnapshotKeys } from './repositories/settings.ts';

// ── Injectable clients (overridden in tests) ──────────────────────────────────

export interface SSOOIDCClientLike {
  registerClient(input: {
    clientName: string;
    clientType: string;
    scopes?: string[];
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
    refreshToken?: string;
    grantType: string;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  }>;
}

export interface SSOClientLike {
  listAccounts(input: {
    accessToken: string;
  }): Promise<{
    accountList?: Array<{ accountId?: string; accountName?: string; emailAddress?: string }>;
  }>;
  listAccountRoles(input: {
    accessToken: string;
    accountId: string;
  }): Promise<{ roleList?: Array<{ roleName?: string }> }>;
  getRoleCredentials(input: {
    accessToken: string;
    accountId: string;
    roleName: string;
  }): Promise<{
    roleCredentials?: {
      accessKeyId?: string;
      secretAccessKey?: string;
      sessionToken?: string;
      expiration?: number;
    };
  }>;
}

let _oidcClientFactory: ((region: string) => SSOOIDCClientLike) | null = null;
let _ssoClientFactory: ((region: string) => SSOClientLike) | null = null;

/** Override the SSO OIDC client factory (pass null to restore real SDK). */
export function setSSOOIDCClientFactory(
  fn: ((region: string) => SSOOIDCClientLike) | null,
): void {
  _oidcClientFactory = fn;
}

/** Override the SSO client factory (pass null to restore real SDK). */
export function setSSOClientFactory(
  fn: ((region: string) => SSOClientLike) | null,
): void {
  _ssoClientFactory = fn;
}

async function makeSSOOIDCClient(region: string): Promise<SSOOIDCClientLike> {
  if (_oidcClientFactory) return _oidcClientFactory(region);

  type OIDCMod = {
    SSOOIDCClient: new (opts: object) => { send(cmd: object): Promise<unknown> };
    RegisterClientCommand: new (input: object) => object;
    StartDeviceAuthorizationCommand: new (input: object) => object;
    CreateTokenCommand: new (input: object) => object;
  };
  const mod = await (Function('m', 'return import(m)')('@aws-sdk/client-sso-oidc') as Promise<OIDCMod>);
  const client = new mod.SSOOIDCClient({ region });

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
      client.send(new mod.CreateTokenCommand(input)) as Promise<{
        accessToken: string; refreshToken?: string; expiresIn?: number;
      }>,
  };
}

async function makeSSOClient(region: string): Promise<SSOClientLike> {
  if (_ssoClientFactory) return _ssoClientFactory(region);

  type SSOMod = {
    SSOClient: new (opts: object) => { send(cmd: object): Promise<unknown> };
    ListAccountsCommand: new (input: object) => object;
    ListAccountRolesCommand: new (input: object) => object;
    GetRoleCredentialsCommand: new (input: object) => object;
  };
  const mod = await (Function('m', 'return import(m)')('@aws-sdk/client-sso') as Promise<SSOMod>);
  const client = new mod.SSOClient({ region });

  return {
    listAccounts: (input) =>
      client.send(new mod.ListAccountsCommand(input)) as Promise<{
        accountList?: Array<{ accountId?: string; accountName?: string; emailAddress?: string }>;
      }>,
    listAccountRoles: (input) =>
      client.send(new mod.ListAccountRolesCommand(input)) as Promise<{
        roleList?: Array<{ roleName?: string }>;
      }>,
    getRoleCredentials: (input) =>
      client.send(new mod.GetRoleCredentialsCommand(input)) as Promise<{
        roleCredentials?: {
          accessKeyId?: string; secretAccessKey?: string;
          sessionToken?: string; expiration?: number;
        };
      }>,
  };
}

// ── Settings-table keys ───────────────────────────────────────────────────────

const K = {
  oidcClientIdEnc: 'bedrock.sso.oidc.clientId.enc',
  oidcClientSecretEnc: 'bedrock.sso.oidc.clientSecret.enc',
  accessTokenEnc: 'bedrock.sso.accessToken.enc',
  refreshTokenEnc: 'bedrock.sso.refreshToken.enc',
  accessTokenExpiry: 'bedrock.sso.accessToken.expiry',
  pendingDeviceCode: 'bedrock.sso.pending.deviceCode',
  pendingClientId: 'bedrock.sso.pending.clientId',
  pendingClientSecretEnc: 'bedrock.sso.pending.clientSecret.enc',
  pendingExpireAt: 'bedrock.sso.pending.expireAt',
} as const;

// ── In-memory role credential cache ──────────────────────────────────────────

interface RoleCredCache {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiry: number; // Unix ms
}

let _roleCredCache: RoleCredCache | null = null;

/** @internal Clear role credential cache (for tests). */
export function _clearRoleCredCache(): void {
  _roleCredCache = null;
}

// ── SSO state helpers ─────────────────────────────────────────────────────────

function dbGet(key: string): string | null {
  return getSetting(getDb(), key);
}

async function dbSet(key: string, value: string): Promise<void> {
  const repo = getSettingsRepository();
  if (repo) {
    await repo.setKey(key, value);
    _updateSnapshotKey(key, value);
  } else {
    setSetting(getDb(), key, value);
  }
}

async function dbDel(key: string): Promise<void> {
  const repo = getSettingsRepository();
  if (repo) {
    await repo.deleteKey(key);
    _deleteSnapshotKeys([key]);
  } else {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}

function enc(plain: string): string {
  return encrypt(plain, config.secretKey);
}

function dec(cipher: string): string {
  return decrypt(cipher, config.secretKey);
}

// ── Signed-in state query ─────────────────────────────────────────────────────

/** Returns the current SSO sign-in state for the public settings response. */
export function getSsoSignedInState(): {
  signedIn: boolean;
  expiresAt: string | null;
  accountId: string | null;
  roleName: string | null;
} {
  const db = getDb();
  const hasToken = Boolean(getSetting(db, K.accessTokenEnc));
  const expiresAt = getSetting(db, K.accessTokenExpiry);
  const accountId = getSetting(db, 'bedrock.sso.accountId');
  const roleName = getSetting(db, 'bedrock.sso.roleName');
  return {
    signedIn: hasToken,
    expiresAt: expiresAt ?? null,
    accountId: accountId ?? null,
    roleName: roleName ?? null,
  };
}

// ── Access token management ───────────────────────────────────────────────────

const SSO_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns a valid SSO access token, refreshing if needed.
 * Throws HttpError(401) with a clear sign-in message if the session cannot be refreshed.
 */
export async function getActiveSsoAccessToken(): Promise<string> {
  const db = getDb();
  const accessTokenEnc = getSetting(db, K.accessTokenEnc);
  if (!accessTokenEnc) {
    throw new HttpError(
      401,
      'SSO session expired — sign in again in Settings › Provider',
    );
  }

  const expiryStr = getSetting(db, K.accessTokenExpiry);
  const expiry = expiryStr ? new Date(expiryStr).getTime() : 0;
  const now2 = Date.now();

  if (expiry > 0 && now2 < expiry - SSO_EXPIRY_BUFFER_MS) {
    // Token is still valid
    try {
      return dec(accessTokenEnc);
    } catch {
      throw new HttpError(500, 'Could not decrypt SSO access token. Re-sign in via Settings › Provider.');
    }
  }

  // Token is expired or expiring soon — try refresh token grant
  const refreshTokenEnc = getSetting(db, K.refreshTokenEnc);
  if (!refreshTokenEnc) {
    // No refresh token; session must be re-authenticated
    throw new HttpError(
      401,
      'SSO session expired — sign in again in Settings › Provider',
    );
  }

  const region = getSetting(db, 'bedrock.sso.region') ?? 'us-east-1';
  let clientId: string;
  let clientSecret: string;
  let refreshToken: string;

  try {
    const clientIdEnc = getSetting(db, K.oidcClientIdEnc);
    const clientSecretEnc = getSetting(db, K.oidcClientSecretEnc);
    if (!clientIdEnc || !clientSecretEnc) {
      throw new Error('Missing OIDC client registration');
    }
    clientId = dec(clientIdEnc);
    clientSecret = dec(clientSecretEnc);
    refreshToken = dec(refreshTokenEnc);
  } catch {
    throw new HttpError(
      401,
      'SSO session expired — sign in again in Settings › Provider',
    );
  }

  try {
    const oidc = await makeSSOOIDCClient(region);
    const result = await oidc.createToken({
      clientId,
      clientSecret,
      refreshToken,
      grantType: 'refresh_token',
    });

    const newExpiry = result.expiresIn
      ? new Date(Date.now() + result.expiresIn * 1000).toISOString()
      : null;

    await dbSet(K.accessTokenEnc, enc(result.accessToken));
    if (newExpiry) await dbSet(K.accessTokenExpiry, newExpiry);
    if (result.refreshToken) await dbSet(K.refreshTokenEnc, enc(result.refreshToken));

    // Invalidate role credential cache
    _roleCredCache = null;

    return result.accessToken;
  } catch {
    throw new HttpError(
      401,
      'SSO session expired — sign in again in Settings › Provider',
    );
  }
}

// ── Role credentials ──────────────────────────────────────────────────────────

const ROLE_CRED_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

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

export interface BedrockSsoCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiry: number; // Unix ms
}

/**
 * Returns fresh short-lived role credentials for use with the Bedrock client.
 * Caches them in memory and refreshes automatically before expiry.
 * Throws HttpError(401) when the SSO session is expired.
 */
export async function getBedrockSsoCredentials(): Promise<BedrockSsoCredentials> {
  const db = getDb();
  const now2 = Date.now();

  // Return cached creds if still valid
  if (_roleCredCache && now2 < _roleCredCache.expiry - ROLE_CRED_BUFFER_MS) {
    return _roleCredCache;
  }

  const region = getSetting(db, 'bedrock.sso.region') ?? 'us-east-1';
  const accountId = getSetting(db, 'bedrock.sso.accountId') ?? '';
  const roleName = getSetting(db, 'bedrock.sso.roleName') ?? '';

  if (!accountId || !roleName) {
    throw new HttpError(
      400,
      'Choose an AWS account and role in Settings › Amazon Bedrock → AWS SSO to load your models.',
    );
  }

  const accessToken = await getActiveSsoAccessToken(); // throws if expired

  try {
    const sso = await makeSSOClient(region);
    const result = await sso.getRoleCredentials({ accessToken, accountId, roleName });
    const creds = result.roleCredentials;

    if (!creds?.accessKeyId || !creds?.secretAccessKey) {
      throw new Error('getRoleCredentials returned empty credentials');
    }

    const expiry = creds.expiration
      ? creds.expiration // AWS returns milliseconds since epoch
      : Date.now() + 3600_000; // 1 hour default

    _roleCredCache = {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken ?? '',
      expiry,
    };

    return _roleCredCache;
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e);
    if (
      matchSdkError(
        e,
        'UnauthorizedException',
        'InvalidGrantException',
        'AccessDeniedException',
        'expired',
        'invalid',
        '401',
      )
    ) {
      throw new HttpError(
        401,
        'SSO session expired — sign in again in Settings › Provider',
      );
    }
    throw new HttpError(502, `Could not obtain Bedrock role credentials: ${msg}`);
  }
}

// ── SSO account / role listing ────────────────────────────────────────────────

export async function listSsoAccounts(): Promise<
  Array<{ accountId: string; accountName: string; emailAddress: string }>
> {
  const db = getDb();
  const region = getSetting(db, 'bedrock.sso.region') ?? 'us-east-1';
  const accessToken = await getActiveSsoAccessToken();

  try {
    const sso = await makeSSOClient(region);
    const result = await sso.listAccounts({ accessToken });
    return (result.accountList ?? []).map((a) => ({
      accountId: a.accountId ?? '',
      accountName: a.accountName ?? '',
      emailAddress: a.emailAddress ?? '',
    }));
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e);
    if (matchSdkError(e, 'UnauthorizedException', 'expired')) {
      throw new HttpError(
        401,
        'SSO session expired — sign in again in Settings › Provider',
      );
    }
    throw new HttpError(502, `Could not list SSO accounts: ${msg}`);
  }
}

export async function listSsoRoles(
  accountId: string,
): Promise<Array<{ roleName: string }>> {
  const db = getDb();
  const region = getSetting(db, 'bedrock.sso.region') ?? 'us-east-1';
  const accessToken = await getActiveSsoAccessToken();

  try {
    const sso = await makeSSOClient(region);
    const result = await sso.listAccountRoles({ accessToken, accountId });
    return (result.roleList ?? []).map((r) => ({ roleName: r.roleName ?? '' }));
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e);
    if (matchSdkError(e, 'UnauthorizedException', 'expired')) {
      throw new HttpError(
        401,
        'SSO session expired — sign in again in Settings › Provider',
      );
    }
    throw new HttpError(502, `Could not list SSO roles: ${msg}`);
  }
}

// ── Sign-out ──────────────────────────────────────────────────────────────────

export async function signOutSso(): Promise<void> {
  const keys = Object.values(K);
  const repo = getSettingsRepository();
  if (repo) {
    await repo.deleteKeys(keys);
    _deleteSnapshotKeys(keys);
  } else {
    for (const key of keys) {
      getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
    }
  }
  _roleCredCache = null;
}

// ── Route auth helpers ────────────────────────────────────────────────────────

function requireAdminBrowser(req: PortalRequest, res: PortalResponse): boolean {
  const authHeader = String(req.headers.authorization ?? '');
  if (authHeader.startsWith('Bearer ')) {
    sendJson(res, 403, {
      error: 'Bedrock SSO routes can only be accessed from a signed-in browser, not via API tokens',
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

export function registerBedrockSsoRoutes(): void {
  // POST /api/settings/bedrock-sso/start — begin device-code flow
  router.post(
    '/api/settings/bedrock-sso/start',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdminBrowser(req, res)) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const startUrl = String(body.startUrl ?? '').trim();
      const region = String(body.region ?? '').trim();

      if (!startUrl || !startUrl.startsWith('https://')) {
        sendJson(res, 400, { error: 'startUrl must be a valid https URL' });
        return;
      }
      if (!region) {
        sendJson(res, 400, { error: 'region is required' });
        return;
      }

      try {
        const oidc = await makeSSOOIDCClient(region);
        const reg = await oidc.registerClient({
          clientName: 'agent-portal',
          clientType: 'public',
          scopes: ['sso:account:access'],
        });
        const da = await oidc.startDeviceAuthorization({
          clientId: reg.clientId,
          clientSecret: reg.clientSecret,
          startUrl,
        });

        const pairsToSet: Array<[string, string]> = [
          ['bedrock.sso.startUrl', startUrl],
          ['bedrock.sso.region', region],
          [K.oidcClientIdEnc, enc(reg.clientId)],
          [K.oidcClientSecretEnc, enc(reg.clientSecret)],
          [K.pendingDeviceCode, da.deviceCode],
          [K.pendingClientId, reg.clientId],
          [K.pendingClientSecretEnc, enc(reg.clientSecret)],
          [K.pendingExpireAt, String(Date.now() + da.expiresIn * 1000)],
        ];
        const repo = getSettingsRepository();
        if (repo) {
          await repo.setKeys(pairsToSet);
          const { _updateSnapshotKeys } = await import('./repositories/settings.ts');
          _updateSnapshotKeys(pairsToSet);
        } else {
          const db = getDb();
          for (const [key, value] of pairsToSet) setSetting(db, key, value);
        }

        appendAudit(getDb(), req.user!.id, 'bedrock-sso.start', null, { startUrl, region }, req.ip);

        sendJson(res, 200, {
          verificationUri: da.verificationUri,
          verificationUriComplete: da.verificationUriComplete ?? da.verificationUri,
          userCode: da.userCode,
          expiresIn: da.expiresIn,
          interval: da.interval,
        });
      } catch (e: unknown) {
        const msg = String((e as Error)?.message ?? e);
        throw new HttpError(502, `Failed to start Bedrock SSO flow: ${msg}`);
      }
    },
  );

  // POST /api/settings/bedrock-sso/poll — poll for token
  router.post(
    '/api/settings/bedrock-sso/poll',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdminBrowser(req, res)) return;

      const db = getDb();
      const deviceCode = getSetting(db, K.pendingDeviceCode);
      const pendingClientId = getSetting(db, K.pendingClientId);
      const pendingClientSecretEnc = getSetting(db, K.pendingClientSecretEnc);
      const expireAtStr = getSetting(db, K.pendingExpireAt);
      const region = getSetting(db, 'bedrock.sso.region') ?? 'us-east-1';

      if (!deviceCode || !pendingClientId || !pendingClientSecretEnc) {
        sendJson(res, 400, { error: 'No active SSO flow. Call /start first.' });
        return;
      }

      if (expireAtStr && Date.now() > Number(expireAtStr)) {
        sendJson(res, 200, { status: 'expired' });
        return;
      }

      let pendingClientSecret: string;
      try {
        pendingClientSecret = dec(pendingClientSecretEnc);
      } catch {
        sendJson(res, 500, { error: 'Could not decrypt pending client secret' });
        return;
      }

      try {
        const oidc = await makeSSOOIDCClient(region);
        const result = await oidc.createToken({
          clientId: pendingClientId,
          clientSecret: pendingClientSecret,
          deviceCode,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        });

        const expiresIn = result.expiresIn ?? 28800;
        const expiryIso = new Date(Date.now() + expiresIn * 1000).toISOString();

        const completePairs: Array<[string, string]> = [
          [K.accessTokenEnc, enc(result.accessToken)],
          [K.accessTokenExpiry, expiryIso],
        ];
        if (result.refreshToken) {
          completePairs.push([K.refreshTokenEnc, enc(result.refreshToken)]);
        }
        const repo = getSettingsRepository();
        if (repo) {
          await repo.setKeys(completePairs);
          const { _updateSnapshotKeys, _deleteSnapshotKeys: _delKeys } = await import('./repositories/settings.ts');
          _updateSnapshotKeys(completePairs);
          const pendingKeys = [K.pendingDeviceCode, K.pendingClientId, K.pendingClientSecretEnc, K.pendingExpireAt];
          await repo.deleteKeys(pendingKeys);
          _delKeys(pendingKeys);
        } else {
          for (const [key, value] of completePairs) setSetting(db, key, value);
          for (const key of [K.pendingDeviceCode, K.pendingClientId, K.pendingClientSecretEnc, K.pendingExpireAt]) {
            db.prepare('DELETE FROM settings WHERE key = ?').run(key);
          }
        }

        // Invalidate role credential cache
        _roleCredCache = null;

        appendAudit(
          getDb(),
          req.user!.id,
          'bedrock-sso.complete',
          null,
          { expiresAt: expiryIso },
          req.ip,
        );

        sendJson(res, 200, { status: 'complete' });
      } catch (e: unknown) {
        const msg = String((e as Error)?.message ?? e);
        if (matchSdkError(e, 'AuthorizationPendingException', 'authorization_pending')) {
          sendJson(res, 200, { status: 'pending' });
        } else if (matchSdkError(e, 'SlowDownException', 'slow_down')) {
          sendJson(res, 200, { status: 'pending', error: 'slow_down' });
        } else if (matchSdkError(e, 'ExpiredTokenException', 'expired_token')) {
          sendJson(res, 200, { status: 'expired' });
        } else if (matchSdkError(e, 'AccessDeniedException', 'access_denied')) {
          sendJson(res, 200, { status: 'denied' });
        } else {
          throw new HttpError(502, `SSO poll failed: ${msg}`);
        }
      }
    },
  );

  // GET /api/settings/bedrock-sso/accounts — list accessible accounts
  router.get(
    '/api/settings/bedrock-sso/accounts',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdminBrowser(req, res)) return;

      try {
        const accounts = await listSsoAccounts();
        sendJson(res, 200, { accounts });
      } catch (e: unknown) {
        if (e instanceof HttpError) {
          sendJson(res, e.status, { error: e.message });
        } else {
          throw e;
        }
      }
    },
  );

  // GET /api/settings/bedrock-sso/roles?accountId= — list roles for an account
  router.get(
    '/api/settings/bedrock-sso/roles',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdminBrowser(req, res)) return;

      const accountId = String(req.query.get('accountId') ?? '').trim();
      if (!accountId) {
        sendJson(res, 400, { error: 'accountId query parameter is required' });
        return;
      }

      try {
        const roles = await listSsoRoles(accountId);
        sendJson(res, 200, { roles });
      } catch (e: unknown) {
        if (e instanceof HttpError) {
          sendJson(res, e.status, { error: e.message });
        } else {
          throw e;
        }
      }
    },
  );

  // POST /api/settings/bedrock-sso/sign-out — clear tokens
  router.post(
    '/api/settings/bedrock-sso/sign-out',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdminBrowser(req, res)) return;

      await signOutSso();

      appendAudit(getDb(), req.user!.id, 'bedrock-sso.sign-out', null, {}, req.ip);

      sendJson(res, 200, { ok: true });
    },
  );

  // POST /api/settings/bedrock-sso/_test_set_signed_in — inject fake SSO state.
  // Only registered in NODE_ENV=test so it never appears in production.
  if (process.env['NODE_ENV'] === 'test') {
    router.post(
      '/api/settings/bedrock-sso/_test_set_signed_in',
      async (req: PortalRequest, res: PortalResponse): Promise<void> => {
        if (!requireAdminBrowser(req, res)) return;
        // Store a plaintext "fake" token encrypted with the portal key.
        const fakeToken = enc('fake-sso-access-token-for-smoke-test');
        const expiry = new Date(Date.now() + 8 * 3600_000).toISOString();
        await dbSet(K.accessTokenEnc, fakeToken);
        await dbSet(K.accessTokenExpiry, expiry);
        // Clear any leftover pending flow data
        await dbDel(K.pendingDeviceCode);
        await dbDel(K.pendingClientId);
        await dbDel(K.pendingClientSecretEnc);
        await dbDel(K.pendingExpireAt);
        _roleCredCache = null;
        sendJson(res, 200, { ok: true, expiresAt: expiry });
      },
    );
  }
}
