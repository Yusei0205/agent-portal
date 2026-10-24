/** Google OIDC sign-in: settings, PKCE login flow and ID-token verification. */
import { createHash, randomBytes } from 'node:crypto';
import { one, run as exec, type Row } from '../db.ts';
import { get, put } from '../http.ts';
import { HttpError, badRequest, newId, now } from '../util.ts';
import { audit, auditRaw } from '../audit.ts';
import { startSessionFor } from '../auth.ts';
import { getSecret, setSecret } from '../secrets.ts';

/** Injectable OIDC endpoints — replaced in tests to avoid real network calls. */
/** Minimal JWK shape needed for RS256 verification. */
type Jwk = { kid?: string; kty?: string; alg?: string; n?: string; e?: string; [k: string]: unknown };

export interface OidcEndpoints {
  discovery: (issuer: string) => Promise<{ authorization_endpoint: string; token_endpoint: string; jwks_uri: string }>;
  jwks: (uri: string) => Promise<{ keys: Jwk[] }>;
  token: (tokenEndpoint: string, params: URLSearchParams) => Promise<{ id_token: string; access_token: string }>;
}

let _oidcEndpoints: OidcEndpoints = {
  async discovery(issuer) {
    const url = issuer.endsWith('/') ? `${issuer}.well-known/openid-configuration` : `${issuer}/.well-known/openid-configuration`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
    return r.json() as Promise<{ authorization_endpoint: string; token_endpoint: string; jwks_uri: string }>;
  },
  async jwks(uri) {
    const r = await fetch(uri, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`JWKS fetch failed: ${r.status}`);
    return r.json() as Promise<{ keys: Jwk[] }>;
  },
  async token(tokenEndpoint, params) {
    const r = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Token exchange failed: ${r.status} ${body.slice(0, 200)}`);
    }
    return r.json() as Promise<{ id_token: string; access_token: string }>;
  },
};

export function setOidcEndpoints(e: OidcEndpoints): void {
  _oidcEndpoints = e;
}

/** Google OIDC settings stored in the settings table under key "oidc". */
export interface OidcSettings {
  enabled: boolean;
  clientId: string;
  /** Client secret is stored encrypted in the secrets table as "oidc.client_secret". */
  allowedDomains: string[];  // Workspace hd restrictions, empty = any google account
  autoCreate: boolean;       // Auto-create user on first login from allowed domain
  defaultAccess: 'member' | 'admin';
  adminEmails: string[];     // These users become admin on first Google login
  disablePasswordLogin: boolean;
}

export const OIDC_SECRET_NAME = 'oidc.client_secret';
const GOOGLE_ISSUER = 'https://accounts.google.com';

function getOidcSettings(): OidcSettings {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = 'oidc'");
  const v = row ? JSON.parse(row.value) : {};
  return {
    enabled: v.enabled === true,
    clientId: typeof v.clientId === 'string' ? v.clientId : '',
    allowedDomains: Array.isArray(v.allowedDomains) ? v.allowedDomains.filter((d: unknown) => typeof d === 'string') : [],
    autoCreate: v.autoCreate !== false,
    defaultAccess: v.defaultAccess === 'admin' ? 'admin' : 'member',
    adminEmails: Array.isArray(v.adminEmails) ? v.adminEmails.filter((e: unknown) => typeof e === 'string') : [],
    disablePasswordLogin: v.disablePasswordLogin === true,
  };
}

function saveOidcSettings(s: OidcSettings): void {
  exec(
    "INSERT INTO settings (key, value) VALUES ('oidc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify(s),
  );
}

/** Pending OIDC flows stored in memory (short-lived; not persisted — PKCE is a one-round-trip protocol). */
const oidcFlows = new Map<string, { state: string; nonce: string; codeVerifier: string; expiresAt: number }>();

function cleanOidcFlows(): void {
  const now2 = Date.now();
  for (const [k, v] of oidcFlows) if (v.expiresAt < now2) oidcFlows.delete(k);
}

/** Base64url-encode a buffer. */
function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Generate a PKCE code verifier and its S256 challenge. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = b64u(randomBytes(64));
  const challenge = b64u(Buffer.from(createHash('sha256').update(verifier).digest()));
  return { verifier, challenge };
}

/** Decode a JWT segment (without signature verification — verification comes separately). */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Malformed ID token');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

/** Decode JWT header to get kid and alg. */
function decodeJwtHeader(token: string): { kid?: string; alg?: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Malformed ID token');
  return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
}

/** Verify RS256 JWT signature using JWKS. Returns parsed payload. */
async function verifyIdToken(token: string, jwksUri: string, clientId: string, nonce: string): Promise<Record<string, unknown>> {
  const header = decodeJwtHeader(token);
  if (header.alg !== 'RS256') throw new HttpError(401, `Expected RS256 ID token, got ${header.alg}`);

  const { keys } = await _oidcEndpoints.jwks(jwksUri);
  const key = keys.find((k) => !header.kid || k.kid === header.kid);
  if (!key) throw new HttpError(401, 'No matching JWK for ID token kid');

  // Build a PEM public key from the JWK using Node.js crypto (no DOM needed).
  const { createPublicKey, createVerify } = await import('node:crypto');
  const parts = token.split('.');
  const sigInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  let ok = false;
  try {
    // Node 22 supports createPublicKey({ key: <JWK object>, format: 'jwk' }).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pub = createPublicKey({ key: key as any, format: 'jwk' });
    const v = createVerify('RSA-SHA256');
    v.update(sigInput);
    ok = v.verify(pub, sig);
  } catch (e) {
    throw new HttpError(401, `ID token signature verification failed: ${(e as Error).message}`);
  }
  if (!ok) throw new HttpError(401, 'ID token signature is not valid');

  const payload = decodeJwtPayload(token);

  // Standard claims
  if (payload.iss !== GOOGLE_ISSUER) throw new HttpError(401, `ID token issuer mismatch: ${payload.iss}`);
  if (payload.aud !== clientId && !(Array.isArray(payload.aud) && (payload.aud as string[]).includes(clientId))) {
    throw new HttpError(401, 'ID token audience mismatch');
  }
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (exp < Date.now() / 1000) throw new HttpError(401, 'ID token has expired');
  if (payload.nonce !== nonce) throw new HttpError(401, 'ID token nonce mismatch');
  if (payload.email_verified !== true) throw new HttpError(401, 'Google account email is not verified');

  return payload;
}

export function registerOidcRoutes(): void {
  // ── OIDC Settings (admin) ─────────────────────────────────────────────────
  get('/api/admin/oidc', async (_ctx) => {
    const s = getOidcSettings();
    const secretSet = !!(await getSecret(OIDC_SECRET_NAME));
    return { ...s, clientSecretSet: secretSet };  // client_secret never returned — stored in secrets
  }, { auth: 'admin' });

  put('/api/admin/oidc', async (ctx) => {
    const body = await ctx.json();
    const prev = getOidcSettings();
    const next: OidcSettings = {
      enabled: body.enabled === true,
      clientId: typeof body.clientId === 'string' ? body.clientId.trim().slice(0, 500) : prev.clientId,
      allowedDomains: Array.isArray(body.allowedDomains)
        ? body.allowedDomains.filter((d: unknown) => typeof d === 'string' && d.length > 0).map((d: string) => d.toLowerCase().trim())
        : prev.allowedDomains,
      autoCreate: body.autoCreate !== false,
      defaultAccess: body.defaultAccess === 'admin' ? 'admin' : 'member',
      adminEmails: Array.isArray(body.adminEmails)
        ? body.adminEmails.filter((e: unknown) => typeof e === 'string').map((e: string) => e.toLowerCase().trim())
        : prev.adminEmails,
      disablePasswordLogin: body.disablePasswordLogin === true,
    };
    // Protect: if disablePasswordLogin is being enabled, there must be at least one non-disabled user with google_sub
    if (next.disablePasswordLogin && !prev.disablePasswordLogin) {
      const googleUsers = one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE google_sub IS NOT NULL AND disabled = 0');
      if (!googleUsers || googleUsers.n === 0) {
        throw badRequest('Cannot disable password login: no users have signed in with Google yet. Sign in with Google first, then disable passwords.');
      }
    }
    // Validate client secret if provided
    if (typeof body.clientSecret === 'string' && body.clientSecret.trim()) {
      await setSecret(OIDC_SECRET_NAME, body.clientSecret.trim());
    }
    saveOidcSettings(next);
    audit(ctx, 'settings.update', null, { section: 'oidc', enabled: next.enabled });
    return { ...next };
  }, { auth: 'admin' });

  // ── OIDC login flow ───────────────────────────────────────────────────────
  get(
    '/api/auth/oidc/start',
    async (ctx) => {
      const s = getOidcSettings();
      if (!s.enabled) throw badRequest('Google sign-in is not enabled');
      if (!s.clientId) throw badRequest('Google sign-in is not configured (missing client ID)');

      cleanOidcFlows();
      const { verifier, challenge } = pkce();
      const state = b64u(randomBytes(32));
      const nonce = b64u(randomBytes(32));

      oidcFlows.set(state, { state, nonce, codeVerifier: verifier, expiresAt: Date.now() + 10 * 60_000 });

      const { authorization_endpoint } = await _oidcEndpoints.discovery(GOOGLE_ISSUER);
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: s.clientId,
        redirect_uri: `${ctx.req.headers['x-forwarded-proto'] || (ctx.secure ? 'https' : 'http')}://${ctx.req.headers.host}/api/auth/oidc/callback`,
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'select_account',
      });
      if (s.allowedDomains.length === 1) params.set('hd', s.allowedDomains[0]);

      return { url: `${authorization_endpoint}?${params}` };
    },
    { auth: 'public' },
  );

  get(
    '/api/auth/oidc/callback',
    async (ctx) => {
      const s = getOidcSettings();
      if (!s.enabled) throw badRequest('Google sign-in is not enabled');

      const code = ctx.query.get('code');
      const state = ctx.query.get('state');
      const error = ctx.query.get('error');
      if (error) throw new HttpError(400, `Google returned an error: ${error}`);
      if (!code || !state) throw badRequest('Missing code or state parameter');

      const flow = oidcFlows.get(state);
      if (!flow || flow.expiresAt < Date.now()) {
        oidcFlows.delete(state ?? '');
        throw new HttpError(400, 'Sign-in session expired or state mismatch. Please try again.');
      }
      oidcFlows.delete(state);

      const clientSecret = await getSecret(OIDC_SECRET_NAME);
      if (!clientSecret) throw badRequest('Google sign-in is not configured (missing client secret)');

      const proto = ctx.req.headers['x-forwarded-proto'] || (ctx.secure ? 'https' : 'http');
      const redirectUri = `${proto}://${ctx.req.headers.host}/api/auth/oidc/callback`;

      const { token_endpoint, jwks_uri } = await _oidcEndpoints.discovery(GOOGLE_ISSUER);
      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: s.clientId,
        client_secret: clientSecret,
        code_verifier: flow.codeVerifier,
      });
      const tokens = await _oidcEndpoints.token(token_endpoint, tokenParams);
      const payload = await verifyIdToken(tokens.id_token, jwks_uri, s.clientId, flow.nonce);

      const googleSub = String(payload.sub ?? '');
      const googleEmail = String(payload.email ?? '').toLowerCase().trim();
      const googleName = String(payload.name ?? '') || googleEmail.split('@')[0];
      const hd = typeof payload.hd === 'string' ? payload.hd : '';

      // Hosted domain check
      if (s.allowedDomains.length > 0 && !s.allowedDomains.includes(hd) && !s.allowedDomains.includes(googleEmail.split('@')[1])) {
        throw new HttpError(403, `Your Google account domain (${hd || googleEmail.split('@')[1]}) is not allowed to sign in to this portal.`);
      }

      // Find or create user
      let user = one<Row>('SELECT * FROM users WHERE google_sub = ?', googleSub)
        ?? one<Row>('SELECT * FROM users WHERE email = ?', googleEmail);

      if (!user) {
        if (!s.autoCreate) {
          throw new HttpError(403, 'Your Google account is not registered. Ask an admin to send you an invitation.');
        }
        // Create new user
        const isAdmin = s.adminEmails.includes(googleEmail) || s.defaultAccess === 'admin';
        const userId = newId('u_');
        exec(
          `INSERT INTO users (id, email, name, password_hash, is_admin, disabled, google_sub, google_email, google_name, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
          userId, googleEmail, googleName, '', isAdmin ? 1 : 0, googleSub, googleEmail, googleName, now(),
        );
        user = one<Row>('SELECT * FROM users WHERE id = ?', userId)!;
        auditRaw(userId, 'user.create', `user:${userId}`, { via: 'google_oidc', email: googleEmail });
      } else {
        // Update Google sub if missing (linking existing account)
        if (!user.google_sub || user.google_sub !== googleSub) {
          exec('UPDATE users SET google_sub = ?, google_email = ?, google_name = ? WHERE id = ?', googleSub, googleEmail, googleName, user.id);
        }
      }

      if (user.disabled) throw new HttpError(403, 'Your account has been disabled. Contact an admin.');

      // Promote to admin if their email is listed
      if (!user.is_admin && s.adminEmails.includes(googleEmail)) {
        exec('UPDATE users SET is_admin = 1 WHERE id = ?', user.id);
      }

      // Start a session cookie
      await startSessionFor(ctx, user.id);
      audit(ctx, 'auth.login', `user:${user.id}`, { via: 'google_oidc', email: googleEmail });

      return { ok: true, user: { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin } };
    },
    { auth: 'public' },
  );

  // ── OIDC enabled check (public — lets the login page show/hide the Google button) ──
  get('/api/auth/oidc/enabled', () => {
    const s = getOidcSettings();
    return { enabled: s.enabled && !!s.clientId };
  }, { auth: 'public' });
}
