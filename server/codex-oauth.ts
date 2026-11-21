import { createHash, randomBytes, randomUUID, createPublicKey, verify } from 'node:crypto';
import { config } from './config.ts';
import { encrypt, decrypt } from './secrets.ts';
import { getCodexStore } from './repositories/codex-store.ts';
import { HttpError } from './util.ts';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export interface CodexOAuthAccount {
  userId: string; subject: string; email: string; clientId: string;
  accessToken: string; refreshToken: string; idToken: string; expiresAt: number; scopes: string[];
}
type Transaction = { verifier: string; nonce: string; redirectUri: string; clientId: string; version: number; subject?: string };
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint?: string };
let fetcher: typeof fetch = fetch;
let discovery: { value: Discovery; until: number } | null = null;
export function setCodexOAuthFetchForTests(value: typeof fetch | null): void { fetcher = value ?? fetch; discovery = null; }

export function codexOAuthConfiguration(): { clientId: string; redirectUri: string } | null {
  const clientId = process.env.PORTAL_CODEX_OAUTH_CLIENT_ID?.trim();
  const redirectUri = process.env.PORTAL_CODEX_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !redirectUri || clientId === 'dynamic_agent_client') return null;
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) return null;
    if (url.pathname !== '/api/codex/oauth/callback' || url.search || url.hash || url.username || url.password) return null;
  } catch { return null; }
  return { clientId, redirectUri };
}

async function jsonResponse(response: Response): Promise<any> {
  if (!response.ok) throw new HttpError(502, 'OpenAI authorization request failed. Try signing in again.');
  const text = await response.text();
  if (text.length > 256_000) throw new HttpError(502, 'OpenAI authorization returned an invalid response.');
  try { return JSON.parse(text); } catch { throw new HttpError(502, 'OpenAI authorization returned an invalid response.'); }
}
async function oidc(): Promise<Discovery> {
  if (discovery && discovery.until > Date.now()) return discovery.value;
  const value = await jsonResponse(await fetcher(ISSUER + '/.well-known/openid-configuration', { signal: AbortSignal.timeout(15_000), redirect: 'error' })) as Discovery;
  if (value.issuer !== ISSUER) throw new HttpError(502, 'OpenAI authorization issuer did not match.');
  for (const endpoint of [value.authorization_endpoint, value.token_endpoint, value.jwks_uri, ...(value.revocation_endpoint ? [value.revocation_endpoint] : [])]) {
    const url = new URL(endpoint);
    if (url.origin !== ISSUER || url.username || url.password) throw new HttpError(502, 'OpenAI authorization endpoint did not match.');
  }
  discovery = { value, until: Date.now() + 5 * 60_000 };
  return value;
}

async function verifyIdentity(idToken: string, clientId: string, nonce?: string): Promise<{ subject: string; email: string }> {
  try {
    if (idToken.length > 64_000) throw new Error();
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit) throw new Error();
    const keys = await jsonResponse(await fetcher((await oidc()).jwks_uri, { signal: AbortSignal.timeout(15_000), redirect: 'error' }));
    const jwk = keys.keys?.find((key: any) => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
    if (!jwk || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error();
    if (claims.iss !== ISSUER || !(claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId)))
      || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId)
      || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()
      || (typeof claims.nbf === 'number' && claims.nbf * 1000 > Date.now() + 30_000)
      || (nonce !== undefined && claims.nonce !== nonce) || typeof claims.sub !== 'string' || !claims.sub) throw new Error();
    return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : '' };
  } catch { throw new HttpError(400, 'The OpenAI account identity could not be verified. Start sign-in again.'); }
}

async function tokenHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const method = process.env.PORTAL_CODEX_OAUTH_CLIENT_AUTH || 'none';
  if (!['none', 'client_secret_basic'].includes(method)) throw new HttpError(503, 'Unsupported OpenAI token-endpoint authentication setting.');
  if (method === 'client_secret_basic') {
    let secret = process.env.PORTAL_CODEX_OAUTH_CLIENT_SECRET;
    if (!secret && process.env.PORTAL_CODEX_OAUTH_CLIENT_SECRET_ARN) {
      const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
      secret = (await new SecretsManagerClient({ region: config.awsRegion, maxAttempts: 1,
        requestHandler: { connectionTimeout: 3000, requestTimeout: 10_000 } }).send(new GetSecretValueCommand({ SecretId: process.env.PORTAL_CODEX_OAUTH_CLIENT_SECRET_ARN }))).SecretString;
    }
    if (!secret) throw new HttpError(503, 'The registered OpenAI client secret has not been configured.');
    const encode = (value: string) => new URLSearchParams({ value }).toString().slice(6);
    headers.authorization = 'Basic ' + Buffer.from(encode(codexOAuthConfiguration()!.clientId) + ':' + encode(secret)).toString('base64');
  }
  return headers;
}
async function exchange(body: URLSearchParams): Promise<any> {
  return jsonResponse(await fetcher((await oidc()).token_endpoint, { method: 'POST', headers: await tokenHeaders(), body, signal: AbortSignal.timeout(15_000), redirect: 'error' }));
}
function requirePlanScopes(scopes: string[]): void {
  if (!scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke')) {
    throw new HttpError(400, 'This OpenAI registration has not granted ChatGPT plan inference access. Identity-only sign-in is not enough.');
  }
}
export async function readCodexAccount(userId: string): Promise<{ account: CodexOAuthAccount; version: number } | null> {
  const row = await (await getCodexStore()).get(userId);
  if (!row?.ciphertext) return null;
  try {
    const account = JSON.parse(decrypt(row.ciphertext, config.secretKey)) as CodexOAuthAccount;
    if (account.userId !== userId || !account.accessToken || !account.refreshToken) throw new Error();
    const configured = codexOAuthConfiguration();
    if (configured && account.clientId !== configured.clientId) throw new Error();
    requirePlanScopes(account.scopes);
    return { account, version: row.version };
  } catch { throw new HttpError(400, 'Your saved Codex account could not be opened. Sign in again.'); }
}

export async function startCodexOAuth(userId: string): Promise<string> {
  const configured = codexOAuthConfiguration();
  if (!configured) throw new HttpError(503, 'Configure the registered OpenAI client ID and callback URL before cloud Codex sign-in.');
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url'), nonce = randomBytes(32).toString('base64url');
  const current = await (await getCodexStore()).get(userId);
  let active: Awaited<ReturnType<typeof readCodexAccount>> = null;
  try { active = await readCodexAccount(userId); } catch { /* a newly verified sign-in can replace an unreadable connection */ }
  const transaction: Transaction = { verifier, nonce, ...configured, version: current?.version ?? 0, ...(active ? { subject: active.account.subject } : {}) };
  await (await getCodexStore()).createAttempt(userId, createHash('sha256').update(state).digest('hex'), {
    ciphertext: encrypt(JSON.stringify(transaction), config.secretKey), expiresAt: Date.now() + 10 * 60_000,
  });
  const url = new URL((await oidc()).authorization_endpoint);
  url.search = new URLSearchParams({ client_id: configured.clientId, redirect_uri: configured.redirectUri, response_type: 'code',
    scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
  return url.href;
}

export async function completeCodexOAuth(userId: string, query: URLSearchParams): Promise<void> {
  const state = query.get('state');
  if (!state || state.length > 256 || query.getAll('state').length !== 1 || query.getAll('code').length > 1) throw new HttpError(400, 'Sign-in state is missing or invalid.');
  const store = await getCodexStore();
  const row = await store.consumeAttempt(userId, createHash('sha256').update(state).digest('hex'), Date.now());
  if (!row) throw new HttpError(400, 'Sign-in expired, was already used, or belongs to another user.');
  const transaction = JSON.parse(decrypt(row.ciphertext, config.secretKey)) as Transaction;
  if (query.has('error')) throw new HttpError(400, 'OpenAI sign-in was declined or could not be completed.');
  const code = query.get('code');
  if (!code || code.length > 8192 || (query.has('client_id') && query.get('client_id') !== transaction.clientId)) throw new HttpError(400, 'Invalid OpenAI authorization callback.');
  const tokens = await exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: transaction.clientId,
    code, code_verifier: transaction.verifier, redirect_uri: transaction.redirectUri, resource: RESOURCE }));
  const identity = await verifyIdentity(tokens.id_token, transaction.clientId, transaction.nonce);
  if (transaction.subject && transaction.subject !== identity.subject) throw new HttpError(400, 'The account changed during reauthorization. Sign out before connecting a different account.');
  const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : [];
  requirePlanScopes(scopes);
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token
    || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new HttpError(502, 'OpenAI did not return renewable inference credentials.');
  const account: CodexOAuthAccount = { ...identity, userId, clientId: transaction.clientId, accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token, idToken: tokens.id_token, expiresAt: Date.now() + tokens.expires_in * 1000, scopes };
  if (!await store.put(userId, encrypt(JSON.stringify(account), config.secretKey), transaction.version)) throw new HttpError(409, 'The Codex connection changed. Start sign-in again.');
}

/** Distributed refresh lease + compare-and-swap prevents rotating-token races and logout resurrection. */
export async function codexAccessToken(userId: string): Promise<string> {
  let current = await readCodexAccount(userId);
  if (!current) throw new HttpError(400, 'Connect your ChatGPT account under Agent sign-ins before running cloud Codex.');
  if (current.account.expiresAt > Date.now() + 60_000) return current.account.accessToken;
  const store = await getCodexStore(), owner = randomUUID();
  if (!await store.lock(userId, owner, Date.now(), Date.now() + 120_000)) throw new HttpError(409, 'Your Codex sign-in is being refreshed. Try again shortly.');
  try {
    current = await readCodexAccount(userId);
    if (!current) throw new HttpError(400, 'Codex was disconnected. Sign in again.');
    if (current.account.expiresAt > Date.now() + 60_000) return current.account.accessToken;
    const old = current.account;
    const tokens = await exchange(new URLSearchParams({ grant_type: 'refresh_token', client_id: old.clientId, refresh_token: old.refreshToken, resource: RESOURCE }));
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : old.scopes;
    requirePlanScopes(scopes);
    if (tokens.id_token && (await verifyIdentity(tokens.id_token, old.clientId)).subject !== old.subject) throw new HttpError(400, 'OpenAI returned a different account during renewal.');
    if (typeof tokens.access_token !== 'string' || !tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new HttpError(502, 'OpenAI credential renewal returned an invalid response.');
    const next = { ...old, scopes, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || old.refreshToken,
      idToken: tokens.id_token || old.idToken, expiresAt: Date.now() + tokens.expires_in * 1000 };
    if (!await store.put(userId, encrypt(JSON.stringify(next), config.secretKey), current.version)) throw new HttpError(409, 'The Codex connection changed during renewal. Try again.');
    return next.accessToken;
  } finally { await store.unlock(userId, owner); }
}

export async function disconnectCodexOAuth(userId: string): Promise<boolean> {
  let current: Awaited<ReturnType<typeof readCodexAccount>>;
  try { current = await readCodexAccount(userId); }
  catch {
    const store = await getCodexStore(), row = await store.get(userId);
    if (row && !await store.remove(userId, row.version)) throw new HttpError(409, 'The Codex connection changed. Try signing out again.');
    return false;
  }
  if (!current) {
    const store = await getCodexStore(), row = await store.get(userId);
    const invalidated = row ? await store.remove(userId, row.version) : await store.put(userId, '', 0);
    if (!invalidated) throw new HttpError(409, 'The Codex connection changed. Try signing out again.');
    return true;
  }
  let revoked = false;
  try {
    const endpoint = (await oidc()).revocation_endpoint;
    if (endpoint) revoked = (await fetcher(endpoint, { method: 'POST', headers: await tokenHeaders(),
      body: new URLSearchParams({ token: current.account.refreshToken, token_type_hint: 'refresh_token', client_id: current.account.clientId }),
      signal: AbortSignal.timeout(15_000), redirect: 'error' })).status === 200;
  } catch { /* clear local access; the UI explains when remote revocation was not confirmed */ }
  if (!await (await getCodexStore()).remove(userId, current.version)) throw new HttpError(409, 'The Codex connection changed. Try signing out again.');
  return revoked;
}
