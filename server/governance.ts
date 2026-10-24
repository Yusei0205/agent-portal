/**
 * Stage 3 — User management and governance (Workstream E).
 *
 * 1. Google OIDC sign-in (PKCE + state + nonce, RS256 JWK verification).
 * 2. Invitations via copy-paste link (single-use, expiring, hashed at rest).
 * 3. User lifecycle: deactivate/reactivate, password reset links, self-service profile.
 * 4. Teams: CRUD, member roles, project access, monthly budgets.
 * 5. Roles / permissions matrix documented and enforced.
 * 6. API tokens: optional project scope enforced.
 * 7. SCIM 2.0 minimal: /scim/v2/Users, /scim/v2/Groups.
 * 8. Per-user usage API (own usage; admins all) by month with team grouping.
 * 9. Audit log entries for all of the above.
 */
import { createHash, randomBytes } from 'node:crypto';
import { all, insert, one, run as exec, update, type Row } from './db.ts';
import { get, post, patch, del, put, type Ctx, type User } from './http.ts';
import { HttpError, badRequest, forbidden, newId, notFound, now, sha256, str, monthStart } from './util.ts';
import { audit, auditRaw, type AuditAction } from './audit.ts';
import { type Access, getProject } from './projects.ts';
import { hashPassword, checkPassword, startSessionFor } from './auth.ts';
import { monthSpend, getSettings } from './settings.ts';
import { getSecret, setSecret } from './secrets.ts';
import { TOKEN_PREFIX } from './api-tokens.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PortalRole = 'admin' | 'member';
export type TeamRole = 'maintainer' | 'member';
export type ProjectAccess = 'viewer' | 'editor' | 'owner';

/** Full permissions matrix exposed by GET /api/roles-matrix */
export const PERMISSIONS_MATRIX = {
  portalAdmin: [
    'manage users (create, edit, disable, delete)',
    'manage all projects',
    'manage all teams',
    'manage portal settings',
    'manage API tokens (any user)',
    'view audit log',
    'manage SCIM tokens',
    'create invitations for any role / project',
    'view usage for all users',
    'manage Google OIDC settings',
  ],
  portalMember: [
    'view and join projects they are a member of',
    'create and manage own API tokens',
    'update own profile and password',
    'accept invitations',
    'view own usage',
  ],
  projectOwner: [
    'full project configuration',
    'add / remove project members',
    'create invitations for the project',
    'manage loop specs, repositories, agents, skills',
    'start, stop, and delete any session in the project',
    'push changes and approve any request in the project',
    'manage project budget',
  ],
  projectEditor: [
    'start sessions and runs',
    'manage loop specs',
    'upload and manage knowledge documents',
    'push changes',
    'answer own session requests',
  ],
  projectViewer: [
    'view sessions, runs, documents, and review findings',
    'take knowledge quizzes',
  ],
  teamMaintainer: [
    'manage team members',
    'manage team project access',
    'manage team budget',
    'invite new users to the team',
  ],
  teamMember: [
    'inherit project access granted to the team',
    'view team details',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function checkEmail(e: unknown): string {
  const email = str(e, 'Email', { max: 200 }).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('Enter a valid email address');
  return email;
}

/**
 * Effective access to a project for a user, considering both direct membership and team grants.
 * Returns the highest of direct access and all team grants.
 */
export function effectiveAccess(user: User, projectId: string): Access | null {
  if (user.is_admin) return 'owner';
  const RANK: Record<Access, number> = { viewer: 1, editor: 2, owner: 3 };
  const RRANK: Record<number, Access> = { 1: 'viewer', 2: 'editor', 3: 'owner' };
  let best = 0;
  // Direct project membership
  const direct = one<{ access: Access }>('SELECT access FROM project_members WHERE project_id = ? AND user_id = ?', projectId, user.id);
  if (direct) best = Math.max(best, RANK[direct.access] ?? 0);
  // Team grants
  const teamGrants = all<{ access: Access }>(
    `SELECT tp.access FROM team_projects tp
       JOIN team_members tm ON tm.team_id = tp.team_id
      WHERE tp.project_id = ? AND tm.user_id = ?`,
    projectId, user.id,
  );
  for (const tg of teamGrants) {
    best = Math.max(best, RANK[tg.access] ?? 0);
  }
  return best > 0 ? RRANK[best] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// OIDC / Google sign-in
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Invitation helpers
// ─────────────────────────────────────────────────────────────────────────────

const INVITE_EXPIRY_HOURS = 7 * 24; // 7 days

function hashInviteToken(token: string): string {
  return sha256(token);
}

function generateInviteToken(): string {
  return `inv_${randomBytes(30).toString('base64url')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Team helpers
// ─────────────────────────────────────────────────────────────────────────────

function getTeam(id: string): Row {
  const t = one('SELECT * FROM teams WHERE id = ?', id);
  if (!t) throw notFound('Team not found');
  return t;
}

function requireTeamMaintainer(ctx: Ctx, teamId: string): void {
  if (ctx.user!.is_admin) return;
  const m = one<{ role: string }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, ctx.user!.id);
  if (!m || m.role !== 'maintainer') throw forbidden('Only team maintainers or admins can do this');
}

// ─────────────────────────────────────────────────────────────────────────────
// SCIM helpers
// ─────────────────────────────────────────────────────────────────────────────

const SCIM_CONTENT_TYPE = 'application/scim+json';

function scimError(status: number, detail: string, scimType?: string): never {
  throw Object.assign(new HttpError(status, detail), { scimType });
}

function checkScimBearer(ctx: Ctx): void {
  const auth = String(ctx.req.headers.authorization || '');
  if (!/^Bearer\s+/i.test(auth)) scimError(401, 'Bearer token required');
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const h = sha256(token);
  const row = one<{ id: string; revoked_at: string | null }>('SELECT id, revoked_at FROM scim_tokens WHERE token_hash = ?', h);
  if (!row || row.revoked_at) scimError(401, 'Invalid or revoked SCIM token');
}

function scimUser(u: Row) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: u.id,
    externalId: u.google_sub ?? undefined,
    userName: u.email,
    name: { formatted: u.name },
    emails: [{ value: u.email, primary: true }],
    active: !u.disabled,
    meta: { resourceType: 'User', created: u.created_at, lastModified: u.created_at },
  };
}

function scimGroup(t: Row, members: Row[]) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: t.id,
    displayName: t.name,
    members: members.map((m) => ({ value: m.user_id, display: m.name })),
    meta: { resourceType: 'Group', created: t.created_at, lastModified: t.updated_at },
  };
}

function scimListResponse(resources: unknown[], totalResults: number, startIndex: number) {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults,
    startIndex,
    itemsPerPage: Array.isArray(resources) ? resources.length : 0,
    Resources: resources,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerGovernanceRoutes(): void {
  // ── Roles / permissions matrix ────────────────────────────────────────────
  get('/api/roles-matrix', () => ({ matrix: PERMISSIONS_MATRIX }), { auth: 'user' });

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

  // ── Invitations ───────────────────────────────────────────────────────────

  /**
   * POST /api/invitations — create an invite link.
   * Admins: any fields. Project owners: only project-scoped invites for that project.
   */
  post('/api/invitations', async (ctx) => {
    const body = await ctx.json();
    const u = ctx.user!;

    // Determine if this is an admin-level invite or a project-scoped invite
    const isAdmin = !!u.is_admin;

    // If project_id provided, check the requester is at least a project owner or admin
    let projectId: string | null = null;
    let projectAccess: ProjectAccess | null = null;
    if (body.project_id) {
      const project = getProject(body.project_id);
      const myAccess = effectiveAccess(u, project.id);
      if (!isAdmin && myAccess !== 'owner') {
        throw forbidden('Only project owners or admins can invite people to a project');
      }
      projectId = project.id;
      const a = body.project_access;
      if (!['viewer', 'editor', 'owner'].includes(a)) throw badRequest('project_access must be viewer, editor, or owner');
      projectAccess = a as ProjectAccess;
    }

    // Team id (optional)
    let teamId: string | null = null;
    if (body.team_id) {
      if (!isAdmin) {
        const tm = one<{ role: string }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', body.team_id, u.id);
        if (!tm || tm.role !== 'maintainer') throw forbidden('Only team maintainers or admins can invite to a team');
      }
      teamId = body.team_id;
    }

    // Portal role — only admin can set is_admin
    const portalRole: PortalRole = (isAdmin && body.portal_role === 'admin') ? 'admin' : 'member';

    const expiryHours = Math.min(7 * 24, Math.max(1, Number(body.expiry_hours || INVITE_EXPIRY_HOURS)));
    const expiresAt = new Date(Date.now() + expiryHours * 3_600_000).toISOString();
    const email = body.email ? checkEmail(body.email) : null;

    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token);

    insert('invitations', {
      token_hash: tokenHash,
      email: email ?? null,
      is_admin: portalRole === 'admin' ? 1 : 0,
      portal_role: portalRole,
      project_id: projectId ?? null,
      project_access: projectAccess ?? null,
      team_id: teamId ?? null,
      expires_at: expiresAt,
      created_by: u.id,
      created_at: now(),
    });

    audit(ctx, 'invitation.create' as AuditAction, null, {
      email: email ?? null, portalRole, projectId, expiresAt,
    });

    return { token, expires_at: expiresAt };
  }, { auth: 'user' });

  /** GET /api/invitations — list pending (admin: all, project owner: their project's) */
  get('/api/invitations', (ctx) => {
    const u = ctx.user!;
    let rows: Row[];
    if (u.is_admin) {
      rows = all<Row>(
        `SELECT i.*, u.name AS creator_name FROM invitations i
           LEFT JOIN users u ON u.id = i.created_by
          ORDER BY i.created_at DESC LIMIT 200`,
      );
    } else {
      rows = all<Row>(
        `SELECT i.*, u.name AS creator_name FROM invitations i
           LEFT JOIN users u ON u.id = i.created_by
          WHERE i.created_by = ? OR (i.project_id IN (
            SELECT pm.project_id FROM project_members pm WHERE pm.user_id = ? AND pm.access = 'owner'
          ))
          ORDER BY i.created_at DESC LIMIT 200`,
        u.id, u.id,
      );
    }
    return {
      invitations: rows.map((r) => ({
        id: r.token_hash.slice(0, 12),  // non-reversible short ID for display
        email: r.email,
        portal_role: r.portal_role,
        project_id: r.project_id,
        project_access: r.project_access,
        team_id: r.team_id,
        expires_at: r.expires_at,
        created_by: r.created_by,
        creator_name: r.creator_name,
        created_at: r.created_at,
        used_at: r.used_at,
        used_by: r.used_by,
        active: !r.used_at && r.expires_at > now(),
      })),
    };
  }, { auth: 'user' });

  /** DELETE /api/invitations/:tokenHash — revoke (mark used_at) */
  del('/api/invitations/:tokenHash', (ctx) => {
    const u = ctx.user!;
    const row = one<{ created_by: string; used_at: string | null }>(
      'SELECT created_by, used_at FROM invitations WHERE token_hash = ?',
      ctx.params.tokenHash,
    );
    if (!row) throw notFound('Invitation not found');
    if (row.used_at) throw badRequest('Invitation has already been used');
    if (!u.is_admin && row.created_by !== u.id) throw forbidden('You cannot revoke this invitation');
    exec('UPDATE invitations SET used_at = ? WHERE token_hash = ?', now(), ctx.params.tokenHash);
    audit(ctx, 'invitation.revoke' as AuditAction, null, {});
    return { ok: true };
  }, { auth: 'user' });

  /** GET /api/invitations/accept/:token — preview an invite (public, shows what it will do). */
  get('/api/invitations/accept/:token', (ctx) => {
    const token = ctx.params.token;
    const tokenHash = hashInviteToken(token);
    const row = one<Row>('SELECT * FROM invitations WHERE token_hash = ?', tokenHash);
    if (!row) throw notFound('Invitation not found or has expired');
    if (row.used_at) throw new HttpError(410, 'This invitation has already been used');
    if (row.expires_at < now()) throw new HttpError(410, 'This invitation has expired');

    let projectName: string | null = null;
    if (row.project_id) {
      const p = one<{ name: string }>('SELECT name FROM projects WHERE id = ?', row.project_id);
      projectName = p?.name ?? null;
    }
    let teamName: string | null = null;
    if (row.team_id) {
      const t = one<{ name: string }>('SELECT name FROM teams WHERE id = ?', row.team_id);
      teamName = t?.name ?? null;
    }

    return {
      email: row.email,
      portal_role: row.portal_role,
      project_id: row.project_id,
      project_name: projectName,
      project_access: row.project_access,
      team_id: row.team_id,
      team_name: teamName,
      expires_at: row.expires_at,
      // Signed out: the accept form creates an account. Signed in: it links the invite to that account.
      newUser: !ctx.user,
      signedInEmail: ctx.user?.email ?? null,
    };
  }, { auth: 'public' });

  /**
   * POST /api/invitations/accept/:token — accept an invite.
   * If signed in: links the invite to the current user.
   * If not signed in: creates a new user (requires name + password, or google_token).
   */
  post('/api/invitations/accept/:token', async (ctx) => {
    const token = ctx.params.token;
    const tokenHash = hashInviteToken(token);
    const row = one<Row>('SELECT * FROM invitations WHERE token_hash = ?', tokenHash);
    if (!row) throw notFound('Invitation not found or has expired');
    if (row.used_at) throw new HttpError(410, 'This invitation has already been used');
    if (row.expires_at < now()) throw new HttpError(410, 'This invitation has expired');

    const body = await ctx.json();
    let userId: string;

    if (ctx.user) {
      // Signed in: apply invite to existing user
      userId = ctx.user.id;
    } else {
      // Not signed in: need to create account or sign in via Google
      if (!body.name || !body.password) throw badRequest('Provide a name and password to create your account');
      const email = row.email ? row.email : checkEmail(body.email);
      if (one('SELECT id FROM users WHERE email = ?', email)) {
        throw badRequest('An account with that email already exists. Sign in first, then accept the invite.');
      }
      const name = str(body.name, 'Name', { max: 120 }).trim();
      const passwordHash = hashPassword(checkPassword(body.password));
      const uid = newId('u_');
      const isAdmin = row.is_admin ? 1 : 0;
      exec(
        `INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`,
        uid, email, name, passwordHash, isAdmin, now(),
      );
      userId = uid;
      await startSessionFor(ctx, userId);
      auditRaw(userId, 'user.create', `user:${userId}`, { via: 'invitation', email });
    }

    // Apply project membership
    if (row.project_id && row.project_access) {
      const existing = one('SELECT access FROM project_members WHERE project_id = ? AND user_id = ?', row.project_id, userId);
      if (!existing) {
        exec(
          'INSERT INTO project_members (project_id, user_id, access) VALUES (?, ?, ?)',
          row.project_id, userId, row.project_access,
        );
      }
    }
    // Apply team membership
    if (row.team_id) {
      const existing = one('SELECT user_id FROM team_members WHERE team_id = ? AND user_id = ?', row.team_id, userId);
      if (!existing) {
        exec('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)', row.team_id, userId, 'member');
      }
    }
    // Apply admin role
    if (row.is_admin) {
      exec('UPDATE users SET is_admin = 1 WHERE id = ?', userId);
    }

    // Mark invite used
    exec('UPDATE invitations SET used_at = ?, used_by = ? WHERE token_hash = ?', now(), userId, tokenHash);
    auditRaw(userId, 'invitation.accept' as AuditAction, null, { project_id: row.project_id, team_id: row.team_id });

    const user = one<Row>('SELECT id, email, name, is_admin FROM users WHERE id = ?', userId);
    return { ok: true, user };
  }, { auth: 'public' });

  // ── User lifecycle ────────────────────────────────────────────────────────

  /** PATCH /api/users/:id/deactivate — deactivate + revoke sessions */
  post('/api/users/:id/deactivate', async (ctx) => {
    const target = one<Row>('SELECT id, email FROM users WHERE id = ?', ctx.params.id);
    if (!target) throw notFound('User not found');
    if (ctx.params.id === ctx.user!.id) throw badRequest('You cannot deactivate your own account');
    exec('UPDATE users SET disabled = 1 WHERE id = ?', target.id);
    exec('DELETE FROM sessions WHERE user_id = ?', target.id);
    exec("UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", now(), target.id);
    // Stop any running sessions owned by this user
    const running = all<Row>("SELECT id FROM workflows WHERE created_by = ? AND status = 'running'", target.id);
    for (const wf of running) {
      exec("UPDATE workflows SET status = 'stopped', stop_reason = 'account_disabled', updated_at = ? WHERE id = ?", now(), wf.id);
    }
    audit(ctx, 'user.disable', `user:${target.id}`, { stopped_sessions: running.length });
    return { ok: true, stopped_sessions: running.length };
  }, { auth: 'admin' });

  /** POST /api/users/:id/reactivate */
  post('/api/users/:id/reactivate', (ctx) => {
    const target = one<{ id: string; email: string }>('SELECT id, email FROM users WHERE id = ?', ctx.params.id);
    if (!target) throw notFound('User not found');
    exec('UPDATE users SET disabled = 0 WHERE id = ?', target.id);
    audit(ctx, 'user.enable', `user:${target.id}`, {});
    return { ok: true };
  }, { auth: 'admin' });

  /**
   * POST /api/users/:id/password-reset-link — admin generates a copy-paste password reset link.
   * Returns the token once; it is only stored hashed.
   */
  post('/api/users/:id/password-reset-link', async (ctx) => {
    const target = one<{ id: string; email: string }>('SELECT id, email FROM users WHERE id = ?', ctx.params.id);
    if (!target) throw notFound('User not found');

    // Invalidate any previous reset links for this user
    exec('DELETE FROM password_resets WHERE user_id = ?', target.id);

    const token = `pr_${randomBytes(30).toString('base64url')}`;
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();  // 24 hours
    insert('password_resets', {
      token_hash: tokenHash,
      user_id: target.id,
      expires_at: expiresAt,
      created_by: ctx.user!.id,
      created_at: now(),
    });
    audit(ctx, 'user.password_reset_link' as AuditAction, `user:${target.id}`, {});
    return { token, expires_at: expiresAt };
  }, { auth: 'admin' });

  /** POST /api/auth/reset-password — consume a password reset token */
  post('/api/auth/reset-password', async (ctx) => {
    const body = await ctx.json();
    const token = str(body.token, 'Token');
    const password = checkPassword(body.password);
    const tokenHash = sha256(token);
    const row = one<Row>('SELECT * FROM password_resets WHERE token_hash = ?', tokenHash);
    if (!row || row.used_at || row.expires_at < now()) {
      throw new HttpError(400, 'This reset link has expired or has already been used');
    }
    exec('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), row.user_id);
    exec('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', now(), tokenHash);
    // Revoke all existing sessions for security
    exec('DELETE FROM sessions WHERE user_id = ?', row.user_id);
    auditRaw(row.user_id, 'auth.password_change', `user:${row.user_id}`, { via: 'reset_link' });
    return { ok: true };
  }, { auth: 'public' });

  /** PATCH /api/profile — self-service profile update */
  patch('/api/profile', async (ctx) => {
    const body = await ctx.json();
    const u = ctx.user!;
    const p: Record<string, string> = {};
    if (body.name !== undefined) p.name = str(body.name, 'Name', { max: 120 }).trim();
    update('users', u.id, p);
    audit(ctx, 'user.update', `user:${u.id}`, { fields: Object.keys(p) });
    return { ok: true };
  });

  /** GET /api/profile — current user profile with spend */
  get('/api/profile', (ctx) => {
    const u = ctx.user!;
    const row = one<Row>('SELECT id, email, name, is_admin, created_at, google_sub, google_email FROM users WHERE id = ?', u.id);
    const spendUsd = monthSpend(undefined, u.id);
    const userRow = one<{ monthly_budget_usd: number | null }>('SELECT monthly_budget_usd FROM users WHERE id = ?', u.id);
    return {
      ...row,
      has_google: !!row?.google_sub,
      month_spend_usd: spendUsd,
      monthly_budget_usd: userRow?.monthly_budget_usd ?? null,
    };
  });

  // ── Teams ─────────────────────────────────────────────────────────────────

  /** GET /api/teams */
  get('/api/teams', (ctx) => {
    const u = ctx.user!;
    let teams: Row[];
    if (u.is_admin) {
      teams = all<Row>(
        `SELECT t.*, COUNT(tm.user_id) AS member_count
           FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id
          GROUP BY t.id ORDER BY t.name`,
      );
    } else {
      teams = all<Row>(
        `SELECT t.*, COUNT(tm2.user_id) AS member_count
           FROM teams t
           JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
           LEFT JOIN team_members tm2 ON tm2.team_id = t.id
          GROUP BY t.id ORDER BY t.name`,
        u.id,
      );
    }
    return { teams };
  });

  /** POST /api/teams */
  post('/api/teams', async (ctx) => {
    const body = await ctx.json();
    const name = str(body.name, 'Team name', { max: 80 }).trim();
    if (!name) throw badRequest('Team name is required');
    const id = newId('tm_');
    insert('teams', {
      id,
      name,
      description: str(body.description || '', 'Description', { max: 1000, optional: true }),
      monthly_budget_usd: body.monthly_budget_usd != null ? Number(body.monthly_budget_usd) : null,
      created_by: ctx.user!.id,
      created_at: now(),
      updated_at: now(),
    });
    // Auto-add creator as maintainer
    insert('team_members', { team_id: id, user_id: ctx.user!.id, role: 'maintainer' });
    audit(ctx, 'team.create' as AuditAction, `team:${id}`, { name });
    return { team: one('SELECT * FROM teams WHERE id = ?', id) };
  }, { auth: 'admin' });

  /** GET /api/teams/:id */
  get('/api/teams/:id', (ctx) => {
    const t = getTeam(ctx.params.id);
    const members = all<Row>(
      `SELECT tm.user_id, tm.role, u.email, u.name, u.disabled
         FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ? ORDER BY u.name`,
      t.id,
    );
    const projects = all<Row>(
      `SELECT tp.project_id, tp.access, p.name, p.slug
         FROM team_projects tp JOIN projects p ON p.id = tp.project_id
        WHERE tp.team_id = ? ORDER BY p.name`,
      t.id,
    );
    return { team: t, members, projects };
  }, { auth: 'user' });

  /** PUT /api/teams/:id */
  put('/api/teams/:id', async (ctx) => {
    const body = await ctx.json();
    const t = getTeam(ctx.params.id);
    requireTeamMaintainer(ctx, t.id as string);
    const p: Record<string, string | number | null> = { updated_at: now() };
    if (body.name !== undefined) p.name = str(body.name, 'Name', { max: 80 }).trim();
    if (body.description !== undefined) p.description = str(body.description, 'Description', { max: 1000, optional: true });
    if (body.monthly_budget_usd !== undefined) {
      const v = body.monthly_budget_usd;
      if (v !== null && (typeof v !== 'number' || v < 0)) throw badRequest('Budget must be a positive number or null');
      p.monthly_budget_usd = v ?? null;
    }
    update('teams', t.id as string, p);
    audit(ctx, 'team.update' as AuditAction, `team:${t.id}`, { name: p.name });
    return { team: one('SELECT * FROM teams WHERE id = ?', t.id) };
  }, { auth: 'user' });

  /** DELETE /api/teams/:id */
  del('/api/teams/:id', (ctx) => {
    const t = getTeam(ctx.params.id);
    if (!ctx.user!.is_admin) throw forbidden('Only admins can delete teams');
    exec('DELETE FROM teams WHERE id = ?', t.id);
    audit(ctx, 'team.delete' as AuditAction, `team:${t.id}`, { name: t.name });
    return { ok: true };
  }, { auth: 'admin' });

  /** POST /api/teams/:id/members — add a member */
  post('/api/teams/:id/members', async (ctx) => {
    const body = await ctx.json();
    getTeam(ctx.params.id);
    requireTeamMaintainer(ctx, ctx.params.id);
    const email = checkEmail(body.email);
    const user = one<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
    if (!user) throw notFound('User not found');
    const role: TeamRole = body.role === 'maintainer' ? 'maintainer' : 'member';
    const existing = one('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', ctx.params.id, user.id);
    if (existing) {
      exec('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?', role, ctx.params.id, user.id);
    } else {
      insert('team_members', { team_id: ctx.params.id, user_id: user.id, role });
    }
    audit(ctx, 'team.member_add' as AuditAction, `team:${ctx.params.id}`, { user_id: user.id, role });
    return { ok: true };
  }, { auth: 'user' });

  /** DELETE /api/teams/:id/members/:userId — remove a member */
  del('/api/teams/:id/members/:userId', (ctx) => {
    getTeam(ctx.params.id);
    requireTeamMaintainer(ctx, ctx.params.id);
    exec('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', ctx.params.id, ctx.params.userId);
    audit(ctx, 'team.member_remove' as AuditAction, `team:${ctx.params.id}`, { user_id: ctx.params.userId });
    return { ok: true };
  }, { auth: 'user' });

  /** POST /api/teams/:id/projects — grant team access to a project */
  post('/api/teams/:id/projects', async (ctx) => {
    const body = await ctx.json();
    getTeam(ctx.params.id);
    requireTeamMaintainer(ctx, ctx.params.id);
    const projectId = str(body.project_id, 'project_id');
    const project = getProject(projectId);
    const access: ProjectAccess = ['viewer', 'editor', 'owner'].includes(body.access) ? body.access : 'viewer';
    const existing = one('SELECT access FROM team_projects WHERE team_id = ? AND project_id = ?', ctx.params.id, project.id);
    if (existing) {
      exec('UPDATE team_projects SET access = ? WHERE team_id = ? AND project_id = ?', access, ctx.params.id, project.id);
    } else {
      insert('team_projects', { team_id: ctx.params.id, project_id: project.id, access });
    }
    audit(ctx, 'team.project_add' as AuditAction, `team:${ctx.params.id}`, { project_id: project.id, access });
    return { ok: true };
  }, { auth: 'user' });

  /** DELETE /api/teams/:id/projects/:projectId */
  del('/api/teams/:id/projects/:projectId', (ctx) => {
    getTeam(ctx.params.id);
    requireTeamMaintainer(ctx, ctx.params.id);
    exec('DELETE FROM team_projects WHERE team_id = ? AND project_id = ?', ctx.params.id, ctx.params.projectId);
    audit(ctx, 'team.project_remove' as AuditAction, `team:${ctx.params.id}`, { project_id: ctx.params.projectId });
    return { ok: true };
  }, { auth: 'user' });

  // ── API token project scope enforcement ──────────────────────────────────

  /**
   * POST /api/tokens/scoped — create a project-scoped token.
   * Identical to POST /api/tokens but requires project_id and project access.
   */
  post('/api/tokens/scoped', async (ctx) => {
    const body = await ctx.json();
    if (!body.project_id) throw badRequest('project_id is required for scoped tokens');
    const project = getProject(body.project_id);
    const access = effectiveAccess(ctx.user!, project.id);
    if (!access) throw forbidden('You do not have access to this project');

    const token = `${TOKEN_PREFIX}${randomBytes(30).toString('base64url')}`;
    const days = Number(body.days ?? 90);
    if (![30, 90, 365].includes(days)) throw badRequest('Choose 30, 90 or 365 days');
    const scope: 'read' | 'write' = body.scope === 'write' ? 'write' : 'read';
    const name = str(body.name, 'Token name', { max: 80 }).trim();
    if (!name) throw badRequest('Name the token');
    const id = newId('tk_');
    insert('api_tokens', {
      id,
      user_id: ctx.user!.id,
      name,
      token_hash: sha256(token),
      prefix: token.slice(0, 10),
      scope,
      project_id: project.id,
      expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
      created_at: now(),
    });
    audit(ctx, 'api_token.create', `project:${project.id}`, { name, scope, project_id: project.id });
    return { token };
  });

  // ── SCIM token management ─────────────────────────────────────────────────

  get('/api/admin/scim-tokens', (_ctx) => {
    const tokens = all<Row>('SELECT id, hint, created_by, created_at, revoked_at FROM scim_tokens ORDER BY created_at DESC');
    return { tokens };
  }, { auth: 'admin' });

  post('/api/admin/scim-tokens', async (ctx) => {
    const token = `scim_${randomBytes(30).toString('base64url')}`;
    const h = sha256(token);
    const hint = `…${token.slice(-4)}`;
    const id = newId('sc_');
    insert('scim_tokens', { id, token_hash: h, hint, created_by: ctx.user!.id, created_at: now() });
    audit(ctx, 'scim_token.create' as AuditAction, null, {});
    return { token, hint };
  }, { auth: 'admin' });

  del('/api/admin/scim-tokens/:id', (ctx) => {
    const row = one('SELECT id FROM scim_tokens WHERE id = ?', ctx.params.id);
    if (!row) throw notFound('SCIM token not found');
    exec('UPDATE scim_tokens SET revoked_at = ? WHERE id = ?', now(), ctx.params.id);
    audit(ctx, 'scim_token.revoke' as AuditAction, null, {});
    return { ok: true };
  }, { auth: 'admin' });

  // ── SCIM 2.0 endpoints ────────────────────────────────────────────────────

  const SCIM_BASE = '/scim/v2';

  /** GET /scim/v2/Users */
  get(`${SCIM_BASE}/Users`, async (ctx) => {
    checkScimBearer(ctx);
    const startIndex = Math.max(1, Number(ctx.query.get('startIndex') || 1));
    const count = Math.min(100, Math.max(1, Number(ctx.query.get('count') || 100)));
    const filter = ctx.query.get('filter') || '';
    let condition = '';
    const params: string[] = [];
    // Minimal filter: userName eq "email@example.com"
    const m = filter.match(/userName\s+eq\s+"([^"]+)"/i);
    if (m) { condition = 'WHERE u.email = ?'; params.push(m[1].toLowerCase()); }
    const totalResults = Number(
      one<{ n: number }>(`SELECT COUNT(*) AS n FROM users u ${condition}`, ...params)?.n ?? 0,
    );
    const users = all<Row>(
      `SELECT * FROM users u ${condition} ORDER BY u.created_at LIMIT ? OFFSET ?`,
      ...params, count, startIndex - 1,
    );
    ctx.res.setHeader('Content-Type', SCIM_CONTENT_TYPE);
    return scimListResponse(users.map(scimUser), totalResults, startIndex);
  }, { auth: 'public' });

  /** GET /scim/v2/Users/:id */
  get(`${SCIM_BASE}/Users/:id`, async (ctx) => {
    checkScimBearer(ctx);
    const u = one<Row>('SELECT * FROM users WHERE id = ?', ctx.params.id);
    if (!u) scimError(404, 'User not found');
    ctx.res.setHeader('Content-Type', SCIM_CONTENT_TYPE);
    return scimUser(u!);
  }, { auth: 'public' });

  /** POST /scim/v2/Users — provision a new user */
  post(`${SCIM_BASE}/Users`, async (ctx) => {
    checkScimBearer(ctx);
    const body = await ctx.json();
    const email = (body.userName ?? body.emails?.[0]?.value ?? '').toLowerCase().trim();
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) scimError(400, 'userName must be a valid email');
    if (one('SELECT id FROM users WHERE email = ?', email)) scimError(409, 'User already exists');
    const name = body.name?.formatted ?? body.displayName ?? email.split('@')[0];
    const googleSub = body.externalId ?? null;
    const id = newId('u_');
    exec(
      `INSERT INTO users (id, email, name, password_hash, is_admin, disabled, google_sub, created_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
      id, email, name, '', googleSub, now(),
    );
    auditRaw(null, 'user.create', `user:${id}`, { via: 'scim', email });
    ctx.res.statusCode = 201;
    ctx.res.setHeader('Content-Type', SCIM_CONTENT_TYPE);
    return scimUser(one<Row>('SELECT * FROM users WHERE id = ?', id)!);
  }, { auth: 'public' });

  /** PATCH /scim/v2/Users/:id — update (IdP typically uses active:false to deactivate) */
  patch(`${SCIM_BASE}/Users/:id`, async (ctx) => {
    checkScimBearer(ctx);
    const u = one<Row>('SELECT * FROM users WHERE id = ?', ctx.params.id);
    if (!u) scimError(404, 'User not found');
    const body = await ctx.json();
    // Support SCIM PATCH operations array
    const ops: Array<{ op: string; path?: string; value: unknown }> = body.Operations ?? [];
    for (const op of ops) {
      if (op.op?.toLowerCase() === 'replace') {
        if (op.path === 'active' || (op.value && typeof op.value === 'object' && 'active' in (op.value as object))) {
          const active = op.path === 'active' ? op.value : (op.value as Record<string, unknown>).active;
          const disabled = active === false || active === 'false' ? 1 : 0;
          exec('UPDATE users SET disabled = ? WHERE id = ?', disabled, u!.id);
          if (disabled) {
            exec('DELETE FROM sessions WHERE user_id = ?', u!.id);
            exec("UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", now(), u!.id);
          }
          auditRaw(null, disabled ? 'user.disable' : 'user.enable', `user:${u!.id}`, { via: 'scim' });
        }
        if (op.path === 'displayName' || op.path === 'name.formatted') {
          exec('UPDATE users SET name = ? WHERE id = ?', String(op.value ?? ''), u!.id);
        }
      }
    }
    ctx.res.setHeader('Content-Type', SCIM_CONTENT_TYPE);
    return scimUser(one<Row>('SELECT * FROM users WHERE id = ?', u!.id)!);
  }, { auth: 'public' });

  /** DELETE /scim/v2/Users/:id */
  del(`${SCIM_BASE}/Users/:id`, (ctx) => {
    checkScimBearer(ctx);
    const u = one<Row>('SELECT id FROM users WHERE id = ?', ctx.params.id);
    if (!u) scimError(404, 'User not found');
    exec('DELETE FROM sessions WHERE user_id = ?', u!.id);
    exec('DELETE FROM users WHERE id = ?', u!.id);
    auditRaw(null, 'user.delete', `user:${u!.id}`, { via: 'scim' });
    ctx.res.statusCode = 204;
    return undefined;
  }, { auth: 'public' });

  /** GET /scim/v2/Groups */
  get(`${SCIM_BASE}/Groups`, async (ctx) => {
    checkScimBearer(ctx);
    const startIndex = Math.max(1, Number(ctx.query.get('startIndex') || 1));
    const count = Math.min(100, Math.max(1, Number(ctx.query.get('count') || 100)));
    const totalResults = Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM teams')?.n ?? 0);
    const teams = all<Row>('SELECT * FROM teams ORDER BY created_at LIMIT ? OFFSET ?', count, startIndex - 1);
    const result = teams.map((t) => {
      const members = all<Row>(
        `SELECT tm.user_id, u.name FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ?`,
        t.id,
      );
      return scimGroup(t, members);
    });
    ctx.res.setHeader('Content-Type', SCIM_CONTENT_TYPE);
    return scimListResponse(result, totalResults, startIndex);
  }, { auth: 'public' });

  /** GET /scim/v2/Groups/:id */
  get(`${SCIM_BASE}/Groups/:id`, async (ctx) => {
    checkScimBearer(ctx);
    const t = one<Row>('SELECT * FROM teams WHERE id = ?', ctx.params.id);
    if (!t) scimError(404, 'Group not found');
    const members = all<Row>(
      `SELECT tm.user_id, u.name FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ?`,
      t!.id,
    );
    ctx.res.setHeader('Content-Type', SCIM_CONTENT_TYPE);
    return scimGroup(t!, members);
  }, { auth: 'public' });

  /** POST /scim/v2/Groups — create team */
  post(`${SCIM_BASE}/Groups`, async (ctx) => {
    checkScimBearer(ctx);
    const body = await ctx.json();
    const name = String(body.displayName ?? '').trim();
    if (!name) scimError(400, 'displayName is required');
    const id = newId('tm_');
    insert('teams', { id, name, description: '', created_at: now(), updated_at: now(), created_by: null });
    // Add members if provided
    if (Array.isArray(body.members)) {
      for (const m of body.members) {
        const uid = m.value;
        if (uid && one('SELECT id FROM users WHERE id = ?', uid)) {
          exec('INSERT OR IGNORE INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)', id, uid, 'member');
        }
      }
    }
    auditRaw(null, 'team.create' as AuditAction, `team:${id}`, { via: 'scim', name });
    ctx.res.statusCode = 201;
    ctx.res.setHeader('Content-Type', SCIM_CONTENT_TYPE);
    const members = all<Row>(`SELECT tm.user_id, u.name FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ?`, id);
    return scimGroup(one<Row>('SELECT * FROM teams WHERE id = ?', id)!, members);
  }, { auth: 'public' });

  /** PATCH /scim/v2/Groups/:id — update team / membership */
  patch(`${SCIM_BASE}/Groups/:id`, async (ctx) => {
    checkScimBearer(ctx);
    const t = one<Row>('SELECT * FROM teams WHERE id = ?', ctx.params.id);
    if (!t) scimError(404, 'Group not found');
    const body = await ctx.json();
    const ops: Array<{ op: string; path?: string; value: unknown }> = body.Operations ?? [];
    for (const op of ops) {
      const o = op.op?.toLowerCase();
      if (o === 'replace' && op.path === 'displayName') {
        exec('UPDATE teams SET name = ?, updated_at = ? WHERE id = ?', String(op.value ?? ''), now(), t!.id);
      }
      if (o === 'add' && op.path === 'members' && Array.isArray(op.value)) {
        for (const m of op.value as Array<{ value: string }>) {
          if (m.value && one('SELECT id FROM users WHERE id = ?', m.value)) {
            exec('INSERT OR IGNORE INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)', t!.id, m.value, 'member');
          }
        }
      }
      if (o === 'remove' && op.path === 'members' && Array.isArray(op.value)) {
        for (const m of op.value as Array<{ value: string }>) {
          exec('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', t!.id, m.value);
        }
      }
    }
    ctx.res.setHeader('Content-Type', SCIM_CONTENT_TYPE);
    const members = all<Row>(`SELECT tm.user_id, u.name FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ?`, t!.id);
    return scimGroup(one<Row>('SELECT * FROM teams WHERE id = ?', t!.id)!, members);
  }, { auth: 'public' });

  /** DELETE /scim/v2/Groups/:id */
  del(`${SCIM_BASE}/Groups/:id`, (ctx) => {
    checkScimBearer(ctx);
    const t = one<Row>('SELECT id FROM teams WHERE id = ?', ctx.params.id);
    if (!t) scimError(404, 'Group not found');
    exec('DELETE FROM teams WHERE id = ?', t!.id);
    auditRaw(null, 'team.delete' as AuditAction, `team:${t!.id}`, { via: 'scim' });
    ctx.res.statusCode = 204;
    return undefined;
  }, { auth: 'public' });

  // ── Per-user usage API ────────────────────────────────────────────────────

  /**
   * GET /api/usage/me — current user's own usage by month.
   * GET /api/usage/users/:id — admin-only, or own id.
   * GET /api/usage/users — admin-only: all users with team grouping.
   */
  get('/api/usage/me', (ctx) => {
    return buildUserUsage(ctx.user!.id);
  });

  get('/api/usage/users', (ctx) => {
    if (!ctx.user!.is_admin) throw forbidden('Only admins can view all users\' usage');
    const since = monthStart();
    const users = all<Row>(
      `SELECT u.id, u.email, u.name,
              COALESCE(SUM(r.cost_usd), 0) AS month_usd,
              COUNT(r.id) AS month_runs,
              u.monthly_budget_usd
         FROM users u
         LEFT JOIN agent_runs r ON r.created_by = u.id AND r.created_at >= ?
        GROUP BY u.id ORDER BY month_usd DESC`,
      since,
    );
    // Attach team memberships for grouping
    const teams = all<Row>('SELECT tm.user_id, t.id AS team_id, t.name AS team_name FROM team_members tm JOIN teams t ON t.id = tm.team_id');
    const teamsByUser = new Map<string, Array<{ team_id: string; team_name: string }>>();
    for (const t of teams) {
      if (!teamsByUser.has(t.user_id)) teamsByUser.set(t.user_id, []);
      teamsByUser.get(t.user_id)!.push({ team_id: t.team_id, team_name: t.team_name });
    }
    return {
      since,
      users: users.map((u) => ({
        ...u,
        teams: teamsByUser.get(u.id) ?? [],
      })),
    };
  }, { auth: 'admin' });

  get('/api/usage/users/:id', (ctx) => {
    if (!ctx.user!.is_admin && ctx.user!.id !== ctx.params.id) {
      throw forbidden('You can only view your own usage');
    }
    return buildUserUsage(ctx.params.id);
  });
}

function buildUserUsage(userId: string) {
  const since = monthStart();
  const user = one<Row>('SELECT id, email, name, monthly_budget_usd FROM users WHERE id = ?', userId);
  if (!user) throw notFound('User not found');

  const byProject = all<Row>(
    `SELECT p.id, p.name, COALESCE(SUM(r.cost_usd), 0) AS usd, COUNT(r.id) AS runs
       FROM projects p
       LEFT JOIN agent_runs r ON r.project_id = p.id AND r.created_by = ? AND r.created_at >= ?
      WHERE r.id IS NOT NULL
      GROUP BY p.id ORDER BY usd DESC`,
    userId, since,
  );

  const byMonth = all<Row>(
    `SELECT strftime('%Y-%m', r.created_at) AS month,
            COALESCE(SUM(r.cost_usd), 0) AS usd,
            COUNT(r.id) AS runs
       FROM agent_runs r
      WHERE r.created_by = ? AND r.created_at >= date('now', '-12 months')
      GROUP BY month ORDER BY month DESC`,
    userId,
  );

  const teams = all<Row>(
    `SELECT t.id, t.name, t.monthly_budget_usd FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
      WHERE tm.user_id = ?`,
    userId,
  );

  return {
    user: { id: user.id, email: user.email, name: user.name, monthly_budget_usd: user.monthly_budget_usd },
    since,
    month_usd: byProject.reduce((s, p) => s + Number(p.usd), 0),
    by_project: byProject,
    by_month: byMonth,
    teams,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export effectiveAccess so projects.ts can use it (circular dependency avoided
// by accessing it via governance module exports).
// ─────────────────────────────────────────────────────────────────────────────
