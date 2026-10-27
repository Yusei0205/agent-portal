/**
 * AWS Accounts API routes — per-project AWS account management.
 *
 * Routes:
 *   GET    /api/projects/:id/aws-accounts          — list
 *   POST   /api/projects/:id/aws-accounts          — create
 *   PUT    /api/projects/:id/aws-accounts/:aid     — update
 *   DELETE /api/projects/:id/aws-accounts/:aid     — delete
 *   POST   /api/projects/:id/aws-accounts/:aid/test — test connection
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run, insert } from './db.ts';
import { generateId, now, str } from './util.ts';
import { encrypt, decrypt } from './secrets.ts';
import { config } from './config.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

const VALID_AUTH_METHODS = ['keys', 'profile', 'instance-role', 'sso'] as const;
type AwsAuthMethod = (typeof VALID_AUTH_METHODS)[number];

interface AwsAccount {
  id: string;
  project_id: string | null;
  name: string;
  auth_method: AwsAuthMethod;
  region: string | null;
  credentials_enc: string | null;
  profile_name: string | null;
  created_by: string | null;
  created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireProjectAccess(req: PortalRequest, res: PortalResponse, projectId: string): boolean {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const project = one<{ id: string }>('SELECT id FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = one<{ user_id: string }>(
    'SELECT user_id FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId, req.user.id,
  );
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  return true;
}

function safeAccount(a: AwsAccount) {
  const { credentials_enc: _c, ...rest } = a;
  return rest;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerAwsAccountRoutes(): void {

  // GET /api/projects/:id/aws-accounts
  router.get('/api/projects/:id/aws-accounts', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;
    const accounts = all<AwsAccount>(
      'SELECT * FROM aws_accounts WHERE project_id = ? ORDER BY created_at',
      req.params.id,
    );
    sendJson(res, 200, { accounts: accounts.map(safeAccount) });
  });

  // POST /api/projects/:id/aws-accounts
  router.post('/api/projects/:id/aws-accounts', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 120 }).trim();
    const authMethod = str(body.authMethod, 'authMethod', { max: 32 }).trim() as AwsAuthMethod;

    if (!VALID_AUTH_METHODS.includes(authMethod)) {
      sendJson(res, 400, { error: `authMethod must be one of: ${VALID_AUTH_METHODS.join(', ')}` });
      return;
    }

    const region = typeof body.region === 'string' ? body.region.trim() || null : null;
    const profileName = typeof body.profileName === 'string' ? body.profileName.trim() || null : null;

    let credentialsEnc: string | null = null;
    if (body.credentials && typeof body.credentials === 'object') {
      credentialsEnc = encrypt(JSON.stringify(body.credentials), config.secretKey);
    }

    const id = generateId();
    const ts = now();

    insert('aws_accounts', {
      id,
      project_id: req.params.id,
      name,
      auth_method: authMethod,
      region,
      credentials_enc: credentialsEnc,
      profile_name: profileName,
      created_by: req.user!.id,
      created_at: ts,
    });

    const account = one<AwsAccount>('SELECT * FROM aws_accounts WHERE id = ?', id);
    sendJson(res, 201, { account: account ? safeAccount(account) : null });
  });

  // PUT /api/projects/:id/aws-accounts/:aid
  router.put('/api/projects/:id/aws-accounts/:aid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const account = one<AwsAccount>(
      'SELECT * FROM aws_accounts WHERE id = ? AND project_id = ?',
      req.params.aid, req.params.id,
    );
    if (!account) { sendJson(res, 404, { error: 'AWS account not found' }); return; }

    const body = req.body as Record<string, unknown>;
    const patch: Record<string, string | null> = {};

    if (body.name !== undefined) patch.name = str(body.name, 'name', { max: 120 }).trim();
    if (body.region !== undefined) patch.region = typeof body.region === 'string' ? body.region.trim() || null : null;
    if (body.profileName !== undefined) patch.profile_name = typeof body.profileName === 'string' ? body.profileName.trim() || null : null;
    if (body.credentials !== undefined && typeof body.credentials === 'object') {
      patch.credentials_enc = encrypt(JSON.stringify(body.credentials), config.secretKey);
    }

    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'Nothing to update' });
      return;
    }

    const keys = Object.keys(patch);
    run(
      `UPDATE aws_accounts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => patch[k]),
      account.id,
    );

    const updated = one<AwsAccount>('SELECT * FROM aws_accounts WHERE id = ?', account.id);
    sendJson(res, 200, { account: updated ? safeAccount(updated) : null });
  });

  // DELETE /api/projects/:id/aws-accounts/:aid
  router.delete('/api/projects/:id/aws-accounts/:aid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const result = run(
      'DELETE FROM aws_accounts WHERE id = ? AND project_id = ?',
      req.params.aid, req.params.id,
    );
    if (result.changes === 0) { sendJson(res, 404, { error: 'AWS account not found' }); return; }

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/aws-accounts/:aid/test
  router.post('/api/projects/:id/aws-accounts/:aid/test', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const account = one<AwsAccount>(
      'SELECT * FROM aws_accounts WHERE id = ? AND project_id = ?',
      req.params.aid, req.params.id,
    );
    if (!account) { sendJson(res, 404, { error: 'AWS account not found' }); return; }

    // For access keys: try sts.getCallerIdentity()
    if (account.auth_method === 'keys' && account.credentials_enc) {
      try {
        const plain = decrypt(account.credentials_enc, config.secretKey);
        const creds = JSON.parse(plain) as { accessKeyId?: string; secretAccessKey?: string };

        if (creds.accessKeyId && creds.secretAccessKey) {
          const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
          const client = new STSClient({
            region: account.region ?? 'us-east-1',
            credentials: {
              accessKeyId: creds.accessKeyId,
              secretAccessKey: creds.secretAccessKey,
            },
          });
          const identity = await client.send(new GetCallerIdentityCommand({}));
          sendJson(res, 200, {
            ok: true,
            identity: {
              account: identity.Account,
              arn: identity.Arn,
              userId: identity.UserId,
            },
          });
          return;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        sendJson(res, 200, { ok: false, error: msg.slice(0, 500) });
        return;
      }
    }

    sendJson(res, 200, { ok: true, note: 'Instance role / profile verification requires an agent run' });
  });
}
