/**
 * AWS accounts for agents, per project.
 *
 * A project keeps AWS accounts (a name, a region and an access key, stored encrypted) and picks one as the
 * account its agents use. When a cloud session starts, the portal decrypts that account's keys and passes them to
 * the runner as AWS_* environment variables, so `aws` and the SDKs work in the agent's shell. The keys are never
 * sent to a browser, never written to a transcript by the portal, and live only in the session's machine.
 *
 *   GET    /api/projects/:id/aws-accounts            accounts (no secrets) and which one is the default
 *   POST   /api/projects/:id/aws-accounts            add one
 *   PUT    /api/projects/:id/aws-accounts/:aid       rename, change region, or replace the keys
 *   DELETE /api/projects/:id/aws-accounts/:aid       remove one
 *   PUT    /api/projects/:id/aws-default             { accountId } or { accountId: null }
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getDb } from './db.ts';
import { generateId, now } from './util.ts';
import { encrypt, decrypt } from './secrets.ts';
import { config } from './config.ts';
import { getSetting, setSetting } from './settings.ts';
import { appendAudit } from './audit.ts';
import { getMemberRow, getProjectRow } from './project-access.ts';
import { getAwsAccountsRepository } from './repositories/aws-accounts.ts';
import type { AwsAccountRecord } from './repositories/aws-accounts.ts';

interface StoredKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const ACCESS_KEY_RE = /^[A-Z0-9]{16,128}$/;

const defaultKey = (projectId: string): string => `aws.default.${projectId}`;

function auditLog(userId: string, action: string, target: string | null): void {
  try { appendAudit(null, userId, action, target, null, null); } catch { /* audit must not break a request */ }
}

function readKeys(acc: AwsAccountRecord): StoredKeys | null {
  if (!acc.credentials_enc) return null;
  try {
    const k = JSON.parse(decrypt(acc.credentials_enc, config.secretKey)) as Partial<StoredKeys>;
    return k.accessKeyId && k.secretAccessKey ? { accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey, ...(k.sessionToken ? { sessionToken: k.sessionToken } : {}) } : null;
  } catch {
    return null;
  }
}

/** What a browser may see of an account: never the secret, only the end of the key id. */
function safeAccount(acc: AwsAccountRecord, defaultId: string | null) {
  const keys = readKeys(acc);
  return {
    id: acc.id,
    name: acc.name,
    region: acc.region,
    accessKeyIdTail: keys ? keys.accessKeyId.slice(-4) : null,
    temporary: Boolean(keys?.sessionToken),
    hasKeys: Boolean(keys),
    isDefault: acc.id === defaultId,
    createdAt: acc.created_at,
  };
}

async function requireEditor(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const project = await getProjectRow(projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (!['editor', 'owner'].includes(String(member.access ?? ''))) {
    sendJson(res, 403, { error: 'Project editor access is needed to change AWS accounts' });
    return false;
  }
  return true;
}

async function requireMember(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const project = await getProjectRow(projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  if (!(await getMemberRow(projectId, req.user.id))) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  return true;
}

function readDefaultId(projectId: string): string | null {
  try {
    const raw = getSetting(getDb(), defaultKey(projectId));
    if (!raw) return null;
    const v = JSON.parse(raw);
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/** Check and normalise the keys from a request body. Throws a message fit for the person. */
function keysFromBody(body: Record<string, unknown>): StoredKeys {
  const accessKeyId = String(body.accessKeyId ?? '').trim();
  const secretAccessKey = String(body.secretAccessKey ?? '').trim();
  const sessionToken = String(body.sessionToken ?? '').trim();
  if (!ACCESS_KEY_RE.test(accessKeyId)) throw new Error('The access key id looks wrong: it is 16 to 128 capital letters and digits, such as AKIA…');
  if (secretAccessKey.length < 20 || secretAccessKey.length > 128 || /\s/.test(secretAccessKey)) throw new Error('The secret access key looks wrong: it is one piece of 20 to 128 characters.');
  if (sessionToken.length > 4096 || /\s/.test(sessionToken)) throw new Error('The session token looks wrong: it must be one piece, no spaces.');
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

function regionFromBody(v: unknown): string {
  const region = String(v ?? '').trim();
  if (!REGION_RE.test(region)) throw new Error('The region looks wrong, for example ap-southeast-1.');
  return region;
}

function nameFromBody(v: unknown): string {
  const name = String(v ?? '').trim();
  if (!name || name.length > 80) throw new Error('Give the account a name of up to 80 characters.');
  return name;
}

/**
 * The AWS_* variables for a project's default account, or null when the project has none.
 * Called when a cloud session starts; the result goes to the runner and nowhere else.
 */
export async function projectAwsEnv(projectId: string | null): Promise<Record<string, string> | null> {
  if (!projectId) return null;
  const id = readDefaultId(projectId);
  if (!id) return null;
  const acc = await getAwsAccountsRepository().getByIdAndProject(id, projectId);
  const keys = acc ? readKeys(acc) : null;
  if (!acc || !keys) return null;
  const region = acc.region || 'us-east-1';
  return {
    AWS_ACCESS_KEY_ID: keys.accessKeyId,
    AWS_SECRET_ACCESS_KEY: keys.secretAccessKey,
    ...(keys.sessionToken ? { AWS_SESSION_TOKEN: keys.sessionToken } : {}),
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
  };
}

export function registerProjectAwsRoutes(): void {
  router.get('/api/projects/:id/aws-accounts', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const pid = req.params.id;
    if (!await requireMember(req, res, pid)) return;
    const defaultId = readDefaultId(pid);
    const accounts = await getAwsAccountsRepository().listByProject(pid);
    sendJson(res, 200, { accounts: accounts.map((a) => safeAccount(a, defaultId)), defaultId });
  });

  router.post('/api/projects/:id/aws-accounts', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const pid = req.params.id;
    if (!await requireEditor(req, res, pid)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    let name: string, region: string, keys: StoredKeys;
    try { name = nameFromBody(body.name); region = regionFromBody(body.region); keys = keysFromBody(body); } catch (e) {
      sendJson(res, 400, { error: (e as Error).message });
      return;
    }
    const acc = await getAwsAccountsRepository().create({
      id: generateId(),
      project_id: pid,
      name,
      auth_method: 'keys',
      region,
      credentials_enc: encrypt(JSON.stringify(keys), config.secretKey),
      profile_name: null,
      created_by: req.user!.id,
      created_at: now(),
    });
    // The first account of a project becomes the one its agents use.
    if (!readDefaultId(pid)) await setSetting(getDb(), defaultKey(pid), JSON.stringify(acc.id));
    auditLog(req.user!.id, 'aws-account.create', `${pid}:${acc.id}`);
    sendJson(res, 201, { account: safeAccount(acc, readDefaultId(pid)) });
  });

  router.put('/api/projects/:id/aws-accounts/:aid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const pid = req.params.id;
    if (!await requireEditor(req, res, pid)) return;
    const repo = getAwsAccountsRepository();
    const existing = await repo.getByIdAndProject(req.params.aid, pid);
    if (!existing) { sendJson(res, 404, { error: 'AWS account not found' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: { name?: string; region?: string; credentials_enc?: string } = {};
    try {
      if (body.name !== undefined) fields.name = nameFromBody(body.name);
      if (body.region !== undefined) fields.region = regionFromBody(body.region);
      // New keys replace the old ones as a pair; leaving the key fields empty keeps what is stored.
      if (body.accessKeyId || body.secretAccessKey || body.sessionToken) {
        fields.credentials_enc = encrypt(JSON.stringify(keysFromBody(body)), config.secretKey);
      }
    } catch (e) {
      sendJson(res, 400, { error: (e as Error).message });
      return;
    }
    const updated = await repo.update(req.params.aid, pid, fields);
    auditLog(req.user!.id, 'aws-account.update', `${pid}:${req.params.aid}`);
    sendJson(res, 200, { account: safeAccount(updated ?? existing, readDefaultId(pid)) });
  });

  router.delete('/api/projects/:id/aws-accounts/:aid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const pid = req.params.id;
    if (!await requireEditor(req, res, pid)) return;
    const ok = await getAwsAccountsRepository().delete(req.params.aid, pid);
    if (!ok) { sendJson(res, 404, { error: 'AWS account not found' }); return; }
    if (readDefaultId(pid) === req.params.aid) await setSetting(getDb(), defaultKey(pid), JSON.stringify(''));
    auditLog(req.user!.id, 'aws-account.delete', `${pid}:${req.params.aid}`);
    sendJson(res, 200, { ok: true });
  });

  router.put('/api/projects/:id/aws-default', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const pid = req.params.id;
    if (!await requireEditor(req, res, pid)) return;
    const accountId = (req.body as { accountId?: unknown } | undefined)?.accountId;
    if (accountId !== null && typeof accountId !== 'string') { sendJson(res, 400, { error: 'accountId must be an account id or null' }); return; }
    if (accountId && !(await getAwsAccountsRepository().getByIdAndProject(accountId, pid))) { sendJson(res, 404, { error: 'AWS account not found' }); return; }
    await setSetting(getDb(), defaultKey(pid), JSON.stringify(accountId ?? ''));
    auditLog(req.user!.id, 'aws-account.default', `${pid}:${accountId ?? 'none'}`);
    sendJson(res, 200, { defaultId: accountId ?? null });
  });
}
