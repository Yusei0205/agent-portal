/**
 * Git connections API routes — shared credential store.
 *
 * Routes:
 *   GET    /api/git-connections        — list user's own + shared connections (no credentials)
 *   POST   /api/git-connections        — create connection
 *   PUT    /api/git-connections/:id    — update connection
 *   DELETE /api/git-connections/:id    — delete connection
 *   POST   /api/git-connections/:id/test — test connection via git ls-remote
 */

import { spawn } from 'node:child_process';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run, insert } from './db.ts';
import { generateId, now, str, parseJson } from './util.ts';
import { encrypt, decrypt } from './secrets.ts';
import { config } from './config.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GitConnection {
  id: string;
  name: string;
  provider: string;
  credentials_enc: string | null;
  scope: string;
  owner_id: string | null;
  created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip credentials from a connection before sending to the browser. */
function safeConnection(c: GitConnection) {
  const { credentials_enc: _cred, ...rest } = c;
  return rest;
}

/** Run git ls-remote with optional credentials in the environment. */
function testGitRemote(url: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['ls-remote', '--exit-code', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    const err: Buffer[] = [];
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(Buffer.concat(err).toString('utf8').trim() || `git exited with ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

/** Build git credential environment from decrypted credentials object. */
function buildGitEnv(credentials: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  if (credentials.token) {
    // GitHub token: use as password via helper
    env.GIT_ASKPASS = 'echo';
    env.GIT_USERNAME = credentials.username || 'git';
    env.GIT_PASSWORD = credentials.token;
  } else if (credentials.username && credentials.password) {
    env.GIT_ASKPASS = 'echo';
    env.GIT_USERNAME = credentials.username;
    env.GIT_PASSWORD = credentials.password;
  }
  return env;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerGitConnectionRoutes(): void {

  // GET /api/git-connections
  router.get('/api/git-connections', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const connections = all<GitConnection>(
      `SELECT * FROM git_connections_v2
        WHERE owner_id = ? OR scope = 'shared'
        ORDER BY created_at`,
      req.user.id,
    );

    sendJson(res, 200, { connections: connections.map(safeConnection) });
  });

  // POST /api/git-connections
  router.post('/api/git-connections', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const body = req.body as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 120 }).trim();
    const provider = str(body.provider, 'provider', { max: 32 }).trim();
    const scope = typeof body.scope === 'string' ? body.scope : 'personal';

    if (!['github', 'codecommit', 'bitbucket', 'git'].includes(provider)) {
      sendJson(res, 400, { error: 'provider must be github, codecommit, bitbucket, or git' });
      return;
    }
    if (!['personal', 'shared'].includes(scope)) {
      sendJson(res, 400, { error: 'scope must be personal or shared' });
      return;
    }

    let credentialsEnc: string | null = null;
    if (body.credentials && typeof body.credentials === 'object') {
      const plain = JSON.stringify(body.credentials);
      credentialsEnc = encrypt(plain, config.secretKey);
    }

    const id = generateId();
    const ts = now();

    insert('git_connections_v2', {
      id,
      name,
      provider,
      credentials_enc: credentialsEnc,
      scope,
      owner_id: req.user.id,
      created_at: ts,
    });

    const conn = one<GitConnection>('SELECT * FROM git_connections_v2 WHERE id = ?', id);
    sendJson(res, 201, { connection: conn ? safeConnection(conn) : null });
  });

  // PUT /api/git-connections/:id
  router.put('/api/git-connections/:id', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const conn = one<GitConnection>(
      'SELECT * FROM git_connections_v2 WHERE id = ?',
      req.params.id,
    );
    if (!conn) { sendJson(res, 404, { error: 'Connection not found' }); return; }

    // Only owner or admin can update
    if (!req.user.is_admin && conn.owner_id !== req.user.id) {
      sendJson(res, 403, { error: 'You do not have access to this connection' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const patch: Record<string, string | null> = {};

    if (body.name !== undefined) patch.name = str(body.name, 'name', { max: 120 }).trim();
    if (body.scope !== undefined) {
      const scope = String(body.scope);
      if (!['personal', 'shared'].includes(scope)) {
        sendJson(res, 400, { error: 'scope must be personal or shared' });
        return;
      }
      patch.scope = scope;
    }
    if (body.credentials !== undefined && typeof body.credentials === 'object') {
      const plain = JSON.stringify(body.credentials);
      patch.credentials_enc = encrypt(plain, config.secretKey);
    }

    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'Nothing to update' });
      return;
    }

    const keys = Object.keys(patch);
    run(
      `UPDATE git_connections_v2 SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => patch[k]),
      conn.id,
    );

    const updated = one<GitConnection>('SELECT * FROM git_connections_v2 WHERE id = ?', conn.id);
    sendJson(res, 200, { connection: updated ? safeConnection(updated) : null });
  });

  // DELETE /api/git-connections/:id
  router.delete('/api/git-connections/:id', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const conn = one<GitConnection>(
      'SELECT * FROM git_connections_v2 WHERE id = ?',
      req.params.id,
    );
    if (!conn) { sendJson(res, 404, { error: 'Connection not found' }); return; }

    if (!req.user.is_admin && conn.owner_id !== req.user.id) {
      sendJson(res, 403, { error: 'You do not have access to this connection' });
      return;
    }

    run('DELETE FROM git_connections_v2 WHERE id = ?', conn.id);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/git-connections/:id/test
  router.post('/api/git-connections/:id/test', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const body = req.body as Record<string, unknown>;
    const url = str(body.url ?? '', 'url', { max: 1000, optional: true }).trim();

    if (!url) {
      sendJson(res, 400, { error: 'url is required for test' });
      return;
    }

    const conn = one<GitConnection>(
      'SELECT * FROM git_connections_v2 WHERE id = ?',
      req.params.id,
    );
    if (!conn) { sendJson(res, 404, { error: 'Connection not found' }); return; }

    if (!req.user.is_admin && conn.owner_id !== req.user.id) {
      sendJson(res, 403, { error: 'You do not have access to this connection' });
      return;
    }

    try {
      let gitEnv: Record<string, string> = {};
      if (conn.credentials_enc) {
        const plain = decrypt(conn.credentials_enc, config.secretKey);
        const creds = parseJson<Record<string, string>>(plain, {});
        gitEnv = buildGitEnv(creds);
      }

      await testGitRemote(url, gitEnv);
      sendJson(res, 200, { ok: true, identity: null });
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      sendJson(res, 200, { ok: false, error: error.slice(0, 500) });
    }
  });
}
