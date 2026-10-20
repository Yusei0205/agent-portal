/**
 * AWS connections: AWS accounts set up once on the AWS accounts page (named profile, access keys, an AWS SSO
 * account/role from the portal's SSO sign-in, or the server's own identity) and then picked by projects.
 *
 * Keys are stored as secrets (`awsconn.<id>.*`), never returned to the browser. Only admins create, change, delete or
 * assign connections, because a connection hands its AWS access to every project that uses it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, one, run as exec, type Row } from './db.ts';
import { del, get, post, put } from './http.ts';
import { deleteSecret, getSecret, secretInfo, setSecret } from './secrets.ts';
import { ssoRoleCredentials } from './sso.ts';
import { clearModelListCache } from './model-cache.ts';
import { HttpError, badRequest, newId, now, str } from './util.ts';

export type ConnectionAuth = 'profile' | 'keys' | 'sso' | 'ambient';

export interface AwsConnection {
  id: string;
  name: string;
  auth: ConnectionAuth;
  profile: string;
  region: string;
  ssoAccountId: string;
  ssoRoleName: string;
}

const AUTHS: ConnectionAuth[] = ['profile', 'keys', 'sso', 'ambient'];
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const PROFILE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ACCOUNT_RE = /^\d{12}$/;
const ROLE_RE = /^[\w+=,.@-]{1,64}$/;
const secretName = (id: string, what: 'access_key_id' | 'secret_access_key' | 'session_token') => `awsconn.${id}.${what}`;
/** The key under which the AWS account a connection reaches is remembered (aws_identities). */
export const identityKey = (id: string) => `conn:${id}`;

function fromRow(r: Row): AwsConnection {
  return { id: r.id, name: r.name, auth: r.auth, profile: r.profile, region: r.region, ssoAccountId: r.sso_account_id, ssoRoleName: r.sso_role_name };
}

export function getConnection(id: string): AwsConnection | null {
  const r = one<Row>('SELECT * FROM aws_connections WHERE id = ?', id);
  return r ? fromRow(r) : null;
}

export function mustConnection(id: string): AwsConnection {
  const c = getConnection(id);
  if (!c) throw badRequest('That AWS account no longer exists. Pick another one under Project and team › Connection.');
  return c;
}

export function listConnections(): AwsConnection[] {
  return all<Row>('SELECT * FROM aws_connections ORDER BY name COLLATE NOCASE').map(fromRow);
}

/** A short description of how a connection signs in, for lists and badges. */
export function connectionHow(c: AwsConnection): string {
  if (c.auth === 'profile') return `Named profile ${c.profile}`;
  if (c.auth === 'keys') return 'Access keys';
  if (c.auth === 'sso') return `AWS SSO ${c.ssoRoleName} @ ${c.ssoAccountId}`;
  return "The server's own AWS identity";
}

/** AWS_* variables for a connection. */
export async function connectionEnv(id: string): Promise<Record<string, string>> {
  const c = mustConnection(id);
  const env: Record<string, string> = { AWS_REGION: c.region, AWS_DEFAULT_REGION: c.region };
  if (c.auth === 'profile') {
    env.AWS_PROFILE = c.profile;
    for (const k of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) if (process.env[k]) env[k] = process.env[k]!;
  } else if (c.auth === 'keys') {
    const keyId = await getSecret(secretName(c.id, 'access_key_id'));
    const secret = await getSecret(secretName(c.id, 'secret_access_key'));
    if (!keyId || !secret) throw badRequest(`The AWS account "${c.name}" has no access key saved. An admin can add it on the AWS accounts page.`);
    env.AWS_ACCESS_KEY_ID = keyId;
    env.AWS_SECRET_ACCESS_KEY = secret;
    const token = await getSecret(secretName(c.id, 'session_token'));
    if (token) env.AWS_SESSION_TOKEN = token;
  } else if (c.auth === 'sso') {
    try {
      Object.assign(env, await ssoRoleCredentials(c.ssoAccountId, c.ssoRoleName));
    } catch (e: any) {
      throw badRequest(`AWS account "${c.name}" (SSO ${c.ssoRoleName} @ ${c.ssoAccountId}): ${e?.message ?? e}`);
    }
  } else {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN']) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
  }
  return env;
}

/** Profile names in the server's ~/.aws files (names only), so the form can offer them. */
export function localProfiles(): string[] {
  const home = os.homedir();
  const files = [process.env.AWS_CONFIG_FILE || path.join(home, '.aws', 'config'), process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, '.aws', 'credentials')];
  const names = new Set<string>();
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^\s*\[(?:profile\s+)?([A-Za-z0-9_.-]{1,64})\]\s*$/gm)) names.add(m[1]);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Create or update a connection from a request body. Secrets are only replaced when new values are sent. */
export async function saveConnection(body: any, userId: string | null, existing?: AwsConnection): Promise<AwsConnection> {
  const name = str(body.name ?? existing?.name, 'Name', { max: 80 }).trim();
  if (!name) throw badRequest('Give this AWS account a name');
  const auth = (body.auth ?? existing?.auth) as ConnectionAuth;
  if (!AUTHS.includes(auth)) throw badRequest('Choose how this AWS account signs in');
  const region = str(body.region ?? existing?.region, 'Region', { max: 30 }).trim();
  if (!REGION_RE.test(region)) throw badRequest('AWS region looks wrong (for example ap-southeast-1)');
  const profile = auth === 'profile' ? str(body.profile ?? existing?.profile, 'Profile name', { max: 64 }).trim() : '';
  if (auth === 'profile' && !PROFILE_RE.test(profile)) throw badRequest('Enter the AWS profile name (letters, digits, dots, dashes)');
  const ssoAccountId = auth === 'sso' ? String(body.ssoAccountId ?? existing?.ssoAccountId ?? '').trim() : '';
  const ssoRoleName = auth === 'sso' ? String(body.ssoRoleName ?? existing?.ssoRoleName ?? '').trim() : '';
  if (auth === 'sso' && !ACCOUNT_RE.test(ssoAccountId)) throw badRequest('Choose the AWS account (12 digits)');
  if (auth === 'sso' && !ROLE_RE.test(ssoRoleName)) throw badRequest('Choose the IAM role');

  const id = existing?.id ?? newId('awc_');
  if (auth === 'keys') {
    const keyId = typeof body.accessKeyId === 'string' ? body.accessKeyId.trim() : '';
    const secret = typeof body.secretAccessKey === 'string' ? body.secretAccessKey.trim() : '';
    const token = typeof body.sessionToken === 'string' ? body.sessionToken.trim() : '';
    if (keyId && !/^[A-Z0-9]{16,128}$/.test(keyId)) throw badRequest('The access key ID looks wrong (it is 20 capital letters and digits, like AKIA… or ASIA…)');
    if (secret && (secret.length < 20 || secret.length > 200)) throw badRequest('The secret access key looks wrong');
    if (token.length > 4000) throw badRequest('The session token is too long');
    const hasId = Boolean(keyId) || secretInfo(secretName(id, 'access_key_id')).set;
    const hasSecret = Boolean(secret) || secretInfo(secretName(id, 'secret_access_key')).set;
    if (!hasId || !hasSecret) throw badRequest('Enter both the access key ID and the secret access key');
    if (keyId) await setSecret(secretName(id, 'access_key_id'), keyId);
    if (secret) await setSecret(secretName(id, 'secret_access_key'), secret);
    // Temporary credentials come with a token; replacing the key without one must not keep the old token.
    if (token) await setSecret(secretName(id, 'session_token'), token);
    else if (keyId || secret) deleteSecret(secretName(id, 'session_token'));
  } else {
    dropConnectionSecrets(id);
  }

  const t = now();
  exec(
    `INSERT INTO aws_connections (id, name, auth, profile, region, sso_account_id, sso_role_name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, auth = excluded.auth, profile = excluded.profile, region = excluded.region,
       sso_account_id = excluded.sso_account_id, sso_role_name = excluded.sso_role_name, updated_at = excluded.updated_at`,
    id,
    name,
    auth,
    profile,
    region,
    ssoAccountId,
    ssoRoleName,
    userId,
    t,
    t,
  );
  // A changed sign-in may reach a different account: forget what was checked before.
  if (existing && (existing.auth !== auth || existing.profile !== profile || existing.ssoAccountId !== ssoAccountId || existing.ssoRoleName !== ssoRoleName || body.accessKeyId)) {
    exec('DELETE FROM aws_identities WHERE key = ?', identityKey(id));
  }
  clearModelListCache();
  return mustConnection(id);
}

export function dropConnectionSecrets(id: string): void {
  for (const w of ['access_key_id', 'secret_access_key', 'session_token'] as const) deleteSecret(secretName(id, w));
}

/** Copy a project's own stored keys into a connection (used when moving projects onto connections). */
export async function copyProjectKeys(projectId: string, connectionId: string): Promise<void> {
  for (const w of ['access_key_id', 'secret_access_key', 'session_token'] as const) {
    const v = await getSecret(`project.${projectId}.aws.${w}`);
    if (v) await setSecret(secretName(connectionId, w), v);
  }
}

export function connectionUsers(id: string): { id: string; name: string }[] {
  return all<Row>("SELECT p.id, p.name FROM project_aws a JOIN projects p ON p.id = a.project_id WHERE a.auth = 'connection' AND a.connection_id = ? ORDER BY p.name COLLATE NOCASE", id).map((r) => ({ id: r.id, name: r.name }));
}

/* ------------------------------------------------------------------ */
/* Moving projects that had their own credentials onto connections     */
/* ------------------------------------------------------------------ */

/**
 * Projects set up before connections existed keep working as they are, but are moved onto a connection so the
 * AWS accounts page and the project page show the same thing. Same profile/SSO role and region → one shared
 * connection; access keys → one connection per project (the keys are copied). Runs once per project.
 */
export async function adoptProjectCredentials(): Promise<number> {
  const rows = all<Row>("SELECT a.*, p.name AS project_name FROM project_aws a JOIN projects p ON p.id = a.project_id WHERE a.auth IN ('profile', 'keys', 'sso')");
  let moved = 0;
  for (const r of rows) {
    const region = r.region || defaultRegion();
    let conn: AwsConnection | undefined;
    if (r.auth === 'profile') conn = listConnections().find((c) => c.auth === 'profile' && c.profile === r.profile && c.region === region);
    if (r.auth === 'sso') conn = listConnections().find((c) => c.auth === 'sso' && c.ssoAccountId === r.sso_account_id && c.ssoRoleName === r.sso_role_name && c.region === region);
    if (!conn) {
      const id = newId('awc_');
      const name = r.auth === 'profile' ? r.profile : r.auth === 'sso' ? `${r.sso_role_name} @ ${r.sso_account_id}` : `${r.project_name} keys`;
      const t = now();
      exec(
        'INSERT INTO aws_connections (id, name, auth, profile, region, sso_account_id, sso_role_name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
        id,
        name,
        r.auth,
        r.auth === 'profile' ? r.profile : '',
        region,
        r.auth === 'sso' ? r.sso_account_id : '',
        r.auth === 'sso' ? r.sso_role_name : '',
        t,
        t,
      );
      if (r.auth === 'keys') await copyProjectKeys(r.project_id, id);
      conn = mustConnection(id);
    }
    // Keep what was learnt about the account these credentials reach.
    const known = one<Row>('SELECT * FROM aws_identities WHERE key = ?', `project:${r.project_id}`);
    if (known && !one('SELECT 1 FROM aws_identities WHERE key = ?', identityKey(conn.id))) {
      exec('INSERT INTO aws_identities (key, account, arn, region, checked_at) VALUES (?, ?, ?, ?, ?)', identityKey(conn.id), known.account, known.arn, known.region, known.checked_at);
    }
    exec("UPDATE project_aws SET auth = 'connection', connection_id = ?, updated_at = ? WHERE project_id = ?", conn.id, now(), r.project_id);
    moved++;
  }
  return moved;
}

function defaultRegion(): string {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = 'aws'");
  try {
    return (row && JSON.parse(row.value).region) || 'us-east-1';
  } catch {
    return 'us-east-1';
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function registerAwsConnectionRoutes(deps: {
  callerIdentity: (env: Record<string, string>) => Promise<{ account: string; arn: string; userId: string }>;
  saveIdentity: (key: string, account: string, arn: string, region: string) => void;
  identityFor: (key: string) => { account: string; arn: string; region: string; checkedAt: string } | null;
}): void {
  const view = (c: AwsConnection, isAdmin: boolean) => {
    const idn = deps.identityFor(identityKey(c.id));
    const key = secretInfo(secretName(c.id, 'access_key_id'));
    return {
      id: c.id,
      name: c.name,
      auth: c.auth,
      how: connectionHow(c),
      region: c.region,
      profile: isAdmin ? c.profile : undefined,
      ssoAccountId: c.ssoAccountId,
      ssoRoleName: c.ssoRoleName,
      accessKey: c.auth === 'keys' ? { set: key.set, hint: isAdmin ? key.hint : undefined } : { set: false },
      account: idn?.account ?? (c.auth === 'sso' ? c.ssoAccountId : null),
      arn: idn?.arn ?? null,
      checkedAt: idn?.checkedAt ?? null,
      projects: connectionUsers(c.id),
    };
  };

  const check = async (c: AwsConnection) => {
    try {
      const env = await connectionEnv(c.id);
      const who = await deps.callerIdentity(env);
      deps.saveIdentity(identityKey(c.id), who.account, who.arn, c.region);
      return { ok: true as const, account: who.account, arn: who.arn };
    } catch (e: any) {
      return { ok: false as const, error: String(e?.message ?? e).slice(0, 400) };
    }
  };

  // Everyone may see the list (names, how, account, region; no secrets), to understand what a project uses.
  get('/api/aws/connections', (ctx) => ({ connections: listConnections().map((c) => view(c, Boolean(ctx.user!.is_admin))), canManage: Boolean(ctx.user!.is_admin) }));

  get('/api/aws/profiles', () => ({ profiles: localProfiles() }), { auth: 'admin' });

  // Save, then check straight away which account it reaches. A failed check does not undo the save.
  post('/api/aws/connections', async (ctx) => {
    const c = await saveConnection(await ctx.json(), ctx.user!.id);
    return { connection: view(c, true), check: await check(c) };
  }, { auth: 'admin' });

  put('/api/aws/connections/:id', async (ctx) => {
    const cur = getConnection(ctx.params.id);
    if (!cur) throw new HttpError(404, 'AWS account not found');
    const c = await saveConnection(await ctx.json(), ctx.user!.id, cur);
    return { connection: view(c, true), check: await check(c) };
  }, { auth: 'admin' });

  post('/api/aws/connections/:id/test', async (ctx) => {
    const c = getConnection(ctx.params.id);
    if (!c) throw new HttpError(404, 'AWS account not found');
    const r = await check(c);
    if (!r.ok) throw new HttpError(502, r.error);
    return { ...r, connection: view(c, true) };
  }, { auth: 'admin' });

  del('/api/aws/connections/:id', (ctx) => {
    const c = getConnection(ctx.params.id);
    if (!c) throw new HttpError(404, 'AWS account not found');
    const users = connectionUsers(c.id);
    if (users.length) throw badRequest(`Still used by ${users.map((u) => u.name).join(', ')}. Switch those projects to another AWS account first.`);
    exec('DELETE FROM aws_connections WHERE id = ?', c.id);
    exec('DELETE FROM aws_identities WHERE key = ?', identityKey(c.id));
    dropConnectionSecrets(c.id);
    return { ok: true };
  }, { auth: 'admin' });
}
