/**
 * OAuth sign-in for remote MCP servers that do not take a static header (Atlassian MCP v2).
 *
 * The portal does the whole OAuth dance (discovery, dynamic client registration, PKCE, token exchange, refresh) and
 * keeps the tokens. A run only ever receives a short-lived access token as an Authorization header, so the runner and
 * its MCP proxy need no OAuth support and never see a refresh token.
 *
 * Sign-in is a "paste the address" flow, like the Claude plan sign-in: the redirect goes to a loopback address
 * (http://127.0.0.1:38951/...) that does not load in the person's browser; they copy that address from the address bar
 * and paste it back. Nothing is stored between start and finish: the PKCE verifier travels in `flow`, an encrypted blob
 * bound to the user that expires after 10 minutes.
 *
 * Secrets (names are per integration, tokens per integration and user):
 *   mcp-oauth-client:<integration>        registered client + the server's endpoints
 *   mcp-oauth:<integration>:<user>        access token, refresh token, expiry
 *   mcp-oauth-skip:<run>:<integration>    "continue this run without it"
 */

import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { encrypt, decrypt, getSecret, setSecret, deleteSecret } from './secrets.ts';
import { HttpError, withLock } from './util.ts';
import { assertNotBlocked } from './testing/ssrf.ts';

export const MCP_OAUTH_REDIRECT_URI = 'http://127.0.0.1:38951/oauth/callback';
const FLOW_TTL_MS = 10 * 60_000;
const SKEW_MS = 60_000;
const FETCH_MS = 20_000;

let fetcher: typeof fetch = fetch;
export function setMcpOAuthFetchForTests(value: typeof fetch | null): void { fetcher = value ?? fetch; }

interface Client {
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resource: string;
  scope?: string;
}

interface Tokens { accessToken: string; refreshToken?: string; expiresAt: number }
interface Flow { v: 1; user: string; integration: string; state: string; verifier: string; exp: number }

const b64url = (b: Buffer) => b.toString('base64url');
const clientKey = (integration: string) => `mcp-oauth-client:${integration}`;
const tokenKey = (integration: string, user: string) => `mcp-oauth:${integration}:${user}`;
const skipKey = (run: string, integration: string) => `mcp-oauth-skip:${run}:${integration}`;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function guarded(url: string, init: RequestInit = {}): Promise<Response> {
  await assertNotBlocked(url, false);
  return fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_MS) });
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await guarded(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' ? body as Record<string, unknown> : null;
  } catch { return null; }
}

function httpsUrl(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new HttpError(502, `The server did not say where its ${what} is.`);
  let u: URL;
  try { u = new URL(value); } catch { throw new HttpError(502, `The server gave an invalid ${what} address.`); }
  if (u.protocol !== 'https:') throw new HttpError(502, `The server's ${what} address is not https.`);
  return u.href;
}

// ── Discovery and registration ────────────────────────────────────────────────

/** RFC 9728 protected-resource metadata, then RFC 8414 / OIDC authorization-server metadata. */
async function discover(mcpUrl: string): Promise<Omit<Client, 'clientId' | 'clientSecret'> & { registrationEndpoint?: string }> {
  const u = new URL(mcpUrl);
  const path = u.pathname.replace(/\/+$/, '');
  const prm = (await getJson(`${u.origin}/.well-known/oauth-protected-resource${path}`))
    ?? (await getJson(`${u.origin}/.well-known/oauth-protected-resource`));
  const issuer = Array.isArray(prm?.authorization_servers) && typeof prm.authorization_servers[0] === 'string'
    ? new URL(prm.authorization_servers[0]) : u;
  const ipath = issuer.pathname.replace(/\/+$/, '');
  const meta = (await getJson(`${issuer.origin}/.well-known/oauth-authorization-server${ipath}`))
    ?? (await getJson(`${issuer.origin}/.well-known/openid-configuration${ipath}`));
  if (!meta) throw new HttpError(502, 'This server does not offer OAuth sign-in.');
  const scopes = Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.filter((s): s is string => typeof s === 'string') : [];
  return {
    authorizationEndpoint: httpsUrl(meta.authorization_endpoint, 'sign-in page'),
    tokenEndpoint: httpsUrl(meta.token_endpoint, 'token endpoint'),
    registrationEndpoint: typeof meta.registration_endpoint === 'string' ? httpsUrl(meta.registration_endpoint, 'registration endpoint') : undefined,
    resource: typeof prm?.resource === 'string' ? prm.resource : mcpUrl,
    scope: scopes.length ? scopes.join(' ') : undefined,
  };
}

/** The registered client for an integration, registering it (RFC 7591) the first time. */
async function clientFor(integration: string, mcpUrl: string): Promise<Client> {
  const stored = await getSecret(clientKey(integration));
  if (stored) {
    try { const c = JSON.parse(stored) as Client; if (c.clientId && c.tokenEndpoint) return c; } catch { /* register again */ }
  }
  const d = await discover(mcpUrl);
  if (!d.registrationEndpoint) throw new HttpError(502, 'This server needs a pre-registered OAuth app, which the portal does not support yet.');
  let res: Response;
  try {
    res = await guarded(d.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Agent Portal',
        redirect_uris: [MCP_OAUTH_REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(d.scope ? { scope: d.scope } : {}),
      }),
    });
  } catch { throw new HttpError(502, 'Could not reach the server to register for sign-in. Try again.'); }
  if (!res.ok) throw new HttpError(502, 'The server refused to register the portal for sign-in.');
  const reg = (await res.json().catch(() => ({}))) as { client_id?: unknown; client_secret?: unknown };
  if (typeof reg.client_id !== 'string' || !reg.client_id) throw new HttpError(502, 'The server did not return a client id.');
  const client: Client = {
    clientId: reg.client_id,
    clientSecret: typeof reg.client_secret === 'string' ? reg.client_secret : undefined,
    authorizationEndpoint: d.authorizationEndpoint,
    tokenEndpoint: d.tokenEndpoint,
    resource: d.resource,
    scope: d.scope,
  };
  await setSecret(clientKey(integration), JSON.stringify(client));
  return client;
}

// ── Sign-in ───────────────────────────────────────────────────────────────────

export async function startMcpSignIn(userId: string, integration: string, mcpUrl: string): Promise<{ url: string; flow: string }> {
  const c = await clientFor(integration, mcpUrl);
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(32));
  const url = new URL(c.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', c.clientId);
  url.searchParams.set('redirect_uri', MCP_OAUTH_REDIRECT_URI);
  url.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('resource', c.resource);
  if (c.scope) url.searchParams.set('scope', c.scope);
  const flow: Flow = { v: 1, user: userId, integration, state, verifier, exp: Date.now() + FLOW_TTL_MS };
  return { url: url.href, flow: encrypt(JSON.stringify(flow), config.secretKey) };
}

function openFlow(blob: unknown, userId: string, integration: string): Flow {
  const expired = new HttpError(400, 'This sign-in has expired. Start again.');
  if (typeof blob !== 'string' || blob.length > 4096) throw expired;
  let flow: Flow;
  try { flow = JSON.parse(decrypt(blob, config.secretKey)); } catch { throw expired; }
  if (flow?.v !== 1 || flow.user !== userId || flow.integration !== integration || !(flow.exp > Date.now())) throw expired;
  return flow;
}

async function tokenRequest(c: Client, params: Record<string, string>): Promise<Tokens> {
  const body = new URLSearchParams({ ...params, client_id: c.clientId, resource: c.resource });
  if (c.clientSecret) body.set('client_secret', c.clientSecret);
  let res: Response;
  try {
    res = await guarded(c.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch { throw new HttpError(502, 'Could not reach the server to finish sign-in. Try again.'); }
  if (res.status === 400 || res.status === 401) throw new HttpError(400, 'The server did not accept that sign-in. It may have expired or been used already. Start again.');
  if (!res.ok) throw new HttpError(502, 'The server could not finish sign-in. Try again.');
  const t = (await res.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof t.access_token !== 'string' || !t.access_token) throw new HttpError(502, 'The server did not return a token. Start again.');
  const ttl = typeof t.expires_in === 'number' && t.expires_in > 0 ? t.expires_in * 1000 : 3600_000;
  return {
    accessToken: t.access_token,
    refreshToken: typeof t.refresh_token === 'string' ? t.refresh_token : undefined,
    expiresAt: Date.now() + ttl,
  };
}

/** Takes the address the person pasted (or a bare code), checks it belongs to this sign-in, and stores the tokens. */
export async function finishMcpSignIn(userId: string, integration: string, blob: unknown, pasted: unknown): Promise<void> {
  const flow = openFlow(blob, userId, integration);
  const hint = 'Paste the whole address from your browser after you approved the access.';
  if (typeof pasted !== 'string' || !pasted.trim() || pasted.length > 4096) throw new HttpError(400, hint);
  let code: string | null; let state: string | null; let denied: string | null = null;
  const text = pasted.trim();
  if (/^https?:\/\//i.test(text)) {
    let u: URL;
    try { u = new URL(text); } catch { throw new HttpError(400, hint); }
    if (u.origin !== new URL(MCP_OAUTH_REDIRECT_URI).origin) throw new HttpError(400, 'That address is not from the sign-in. ' + hint);
    code = u.searchParams.get('code'); state = u.searchParams.get('state'); denied = u.searchParams.get('error');
  } else { code = text; state = null; }
  if (denied) throw new HttpError(400, 'Access was not approved. Start again and approve it.');
  if (!code) throw new HttpError(400, hint);
  if (state !== null && state !== flow.state) throw new HttpError(400, 'That address is from a different sign-in. Start again and use the newest link.');
  const stored = await getSecret(clientKey(integration));
  if (!stored) throw new HttpError(400, 'This sign-in has expired. Start again.');
  const c = JSON.parse(stored) as Client;
  const tokens = await tokenRequest(c, {
    grant_type: 'authorization_code', code, redirect_uri: MCP_OAUTH_REDIRECT_URI, code_verifier: flow.verifier,
  });
  await setSecret(tokenKey(integration, userId), JSON.stringify(tokens));
}

// ── Tokens for a run ──────────────────────────────────────────────────────────

/** A valid access token for this person, refreshing it when needed. Null = they have to sign in. */
export async function mcpAccessToken(integration: string, userId: string): Promise<string | null> {
  const raw = await getSecret(tokenKey(integration, userId));
  if (!raw) return null;
  let t: Tokens;
  try { t = JSON.parse(raw) as Tokens; } catch { return null; }
  if (t.expiresAt - SKEW_MS > Date.now()) return t.accessToken;
  if (!t.refreshToken) return null;
  // One refresh at a time: refresh tokens may rotate, so a second concurrent use would burn it.
  return withLock(tokenKey(integration, userId), async () => {
    const again = await getSecret(tokenKey(integration, userId));
    if (again) {
      try { const a = JSON.parse(again) as Tokens; if (a.expiresAt - SKEW_MS > Date.now()) return a.accessToken; } catch { /* use ours */ }
    }
    const stored = await getSecret(clientKey(integration));
    if (!stored) return null;
    try {
      const next = await tokenRequest(JSON.parse(stored) as Client, { grant_type: 'refresh_token', refresh_token: t.refreshToken! });
      if (!next.refreshToken) next.refreshToken = t.refreshToken;
      await setSecret(tokenKey(integration, userId), JSON.stringify(next));
      return next.accessToken;
    } catch {
      await deleteSecret(tokenKey(integration, userId));
      return null;
    }
  });
}

export async function mcpSignedIn(integration: string, userId: string): Promise<boolean> {
  return (await mcpAccessToken(integration, userId)) !== null;
}

/** Forget the client registered for an integration (its server address changed, so it has to register again). */
export async function forgetMcpClient(integration: string): Promise<void> {
  await deleteSecret(clientKey(integration));
}

export async function mcpSignOut(integration: string, userId: string): Promise<void> {
  await deleteSecret(tokenKey(integration, userId));
}

/** "Continue this run without that server" (set from the session card, read by the run that is waiting). */
export async function skipMcpForRun(runId: string, integration: string): Promise<void> {
  await setSecret(skipKey(runId, integration), '1');
}
export async function mcpSkippedForRun(runId: string, integration: string): Promise<boolean> {
  return (await getSecret(skipKey(runId, integration))) === '1';
}
