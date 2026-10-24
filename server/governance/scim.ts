/** SCIM 2.0 minimal: token management plus /scim/v2/Users and /scim/v2/Groups. */
import { randomBytes } from 'node:crypto';
import { all, insert, one, run as exec, type Row } from '../db.ts';
import { get, post, patch, del, type Ctx } from '../http.ts';
import { HttpError, newId, notFound, now, sha256 } from '../util.ts';
import { audit, auditRaw, type AuditAction } from '../audit.ts';

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

export function registerScimRoutes(): void {
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
}
