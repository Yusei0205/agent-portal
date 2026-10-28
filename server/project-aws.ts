/**
 * A project's own AWS account.
 *
 * Settings holds the credentials the portal uses to call Amazon Bedrock (the model). A project can have its own,
 * separate AWS credentials for its CodeCommit repositories and for the AWS commands its agents run, so one developer
 * can work on projects in different AWS accounts. A project without its own credentials uses the Settings ones.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { one, run as exec } from './db.ts';
import { dataPath } from './config.ts';
import { get, post, put } from './http.ts';
import { deleteSecret, getSecret, secretInfo, setSecret } from './secrets.ts';
import { awsEnv, getSettings, type ProviderMode } from './settings.ts';
import { ssoRoleCredentials } from './sso.ts';
import { connectionEnv, connectionHow, getConnection, identityKey } from './aws-connections.ts';
import { requireProject, writeClaudeMd } from './projects.ts';
import { HttpError, badRequest, now, str } from './util.ts';
import { clearModelListCache } from './model-cache.ts';

const execFileP = promisify(execFile);

/** 'connection' = one of the AWS accounts set up on the AWS accounts page. profile / keys / sso are the older per-project forms. */
export type ProjectAwsAuth = 'inherit' | 'connection' | 'profile' | 'keys' | 'sso';
/** The model provider a project uses; 'inherit' follows Settings. */
export type ProjectProvider = 'inherit' | ProviderMode;

export interface ProjectAws {
  auth: ProjectAwsAuth;
  profile: string;
  region: string;
  provider: ProjectProvider;
  ssoAccountId: string;
  ssoRoleName: string;
  connectionId: string;
}

const PROVIDERS: ProjectProvider[] = ['inherit', 'demo', 'anthropic', 'bedrock', 'kiro'];
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const PROFILE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ACCOUNT_RE = /^\d{12}$/;
const ROLE_RE = /^[\w+=,.@-]{1,64}$/;
const secretName = (projectId: string, what: 'access_key_id' | 'secret_access_key' | 'session_token') => `project.${projectId}.aws.${what}`;

export function getProjectAws(projectId: string): ProjectAws {
  const r = one<{ auth: ProjectAwsAuth; profile: string; region: string; provider: ProjectProvider; sso_account_id: string; sso_role_name: string; connection_id: string }>(
    'SELECT auth, profile, region, provider, sso_account_id, sso_role_name, connection_id FROM project_aws WHERE project_id = ?',
    projectId,
  );
  return r
    ? { auth: r.auth, profile: r.profile, region: r.region, provider: r.provider || 'inherit', ssoAccountId: r.sso_account_id, ssoRoleName: r.sso_role_name, connectionId: r.connection_id || '' }
    : { auth: 'inherit', profile: '', region: '', provider: 'inherit', ssoAccountId: '', ssoRoleName: '', connectionId: '' };
}

/** True when the project has its own AWS account (so the Settings credentials are for Bedrock only). */
export const projectHasOwnAws = (projectId: string) => getProjectAws(projectId).auth !== 'inherit';

/** The model provider runs in this project use: the project's own choice, or the Settings one. */
export function effectiveProvider(projectId?: string | null): ProviderMode {
  if (projectId) {
    const p = getProjectAws(projectId).provider;
    if (p && p !== 'inherit') return p;
  }
  return getSettings().provider.mode;
}

export type Engine = 'claude' | 'kiro';

/** The Claude provider a run would use in this project (its own, else Settings), or null when none is set up. */
export function claudeProvider(projectId?: string | null): ProviderMode | null {
  const own = effectiveProvider(projectId);
  if (own === 'anthropic' || own === 'bedrock') return own;
  const s = getSettings().provider.mode;
  return s === 'anthropic' || s === 'bedrock' ? s : null;
}

/**
 * The provider for a run that picked an engine: Kiro, or Claude through whichever Claude provider applies. Without a
 * choice the project's connection decides, as before. Demo mode stays demo whatever is picked.
 */
export function engineProvider(projectId: string | null | undefined, engine?: string | null): ProviderMode {
  const base = effectiveProvider(projectId);
  if (!engine || base === 'demo') return base;
  if (engine === 'kiro') return 'kiro';
  if (engine === 'claude') {
    const p = claudeProvider(projectId);
    if (!p) throw badRequest('Claude is not set up: choose Anthropic or Amazon Bedrock under Settings › Model provider, or for this project under Project and team.');
    return p;
  }
  throw badRequest('Choose the Claude or the Kiro engine');
}

/**
 * True when the project chose Bedrock itself and has its own AWS account: then that one account serves the model,
 * CodeCommit and the agents' AWS commands. A project that inherits the provider keeps the Settings credentials for
 * the model (the older split, kept so existing projects behave as before).
 */
export function projectModelUsesOwnAws(projectId?: string | null): boolean {
  if (!projectId) return false;
  const p = getProjectAws(projectId);
  return p.provider === 'bedrock' && p.auth !== 'inherit';
}

/** AWS_* variables for this project's account. A project without its own credentials gets the Settings ones. */
export async function projectAwsEnv(projectId: string): Promise<Record<string, string>> {
  const p = getProjectAws(projectId);
  if (p.auth === 'inherit') return awsEnv();
  if (p.auth === 'connection') return connectionEnv(p.connectionId);
  const region = p.region || getSettings().aws.region;
  const env: Record<string, string> = { AWS_REGION: region, AWS_DEFAULT_REGION: region };
  if (p.auth === 'sso') {
    if (!p.ssoAccountId || !p.ssoRoleName) throw badRequest('Choose the AWS SSO account and role for this project under Project and team › Connection');
    try {
      Object.assign(env, await ssoRoleCredentials(p.ssoAccountId, p.ssoRoleName));
    } catch (e: any) {
      throw badRequest(`AWS SSO for this project (account ${p.ssoAccountId}, role ${p.ssoRoleName}): ${e?.message ?? e}`);
    }
    return env;
  }
  if (p.auth === 'profile') {
    if (!p.profile) throw badRequest("Set an AWS profile name for this project under Project and team › AWS account");
    env.AWS_PROFILE = p.profile;
    for (const k of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) if (process.env[k]) env[k] = process.env[k]!;
    return env;
  }
  const id = await getSecret(secretName(projectId, 'access_key_id'));
  const secret = await getSecret(secretName(projectId, 'secret_access_key'));
  if (!id || !secret) throw badRequest("Add this project's AWS access key under Project and team › AWS account");
  env.AWS_ACCESS_KEY_ID = id;
  env.AWS_SECRET_ACCESS_KEY = secret;
  const token = await getSecret(secretName(projectId, 'session_token'));
  if (token) env.AWS_SESSION_TOKEN = token;
  return env;
}

/** The same account, for the AWS SDK (CodeCommit repository list). */
export async function projectAwsCredentials(projectId: string): Promise<{ region: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; profile?: string }> {
  const p = getProjectAws(projectId);
  const env = await projectAwsEnv(projectId);
  return {
    region: env.AWS_REGION || p.region || getSettings().aws.region,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    profile: p.auth === 'profile' ? p.profile : env.AWS_PROFILE && !env.AWS_ACCESS_KEY_ID ? env.AWS_PROFILE : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Agent runs: route the agent's `aws` command to the project account  */
/* ------------------------------------------------------------------ */

// Where Claude Code keeps the model's credentials from the commands it starts (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB in
// settings.ts), it drops every variable that looks like a secret (AWS_SECRET_ACCESS_KEY, *_TOKEN, *_API_KEY, even
// PROJECT_AWS_SECRET_ACCESS_KEY). The project's own account is meant for the agent, so for each run its keys are
// written to a private credentials file outside the project (runAwsDir), named by PROJECT_AWS_FILES, on every platform.
// These two small scripts, first on the agent's PATH, point `aws` (and, on request, Terraform or SDK code) at it.
const AWS_SHIM = `#!/usr/bin/env bash
# Sends the AWS CLI to this project's AWS account. Installed by Agent Portal; do not edit.
if [ -n "\${PROJECT_AWS_FILES:-}\${PROJECT_AWS_PROFILE:-}" ]; then
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_BEARER_TOKEN_BEDROCK
  if [ -n "\${PROJECT_AWS_FILES:-}" ]; then
    export AWS_SHARED_CREDENTIALS_FILE="$PROJECT_AWS_FILES/credentials" AWS_CONFIG_FILE="$PROJECT_AWS_FILES/config" AWS_PROFILE=project
  fi
  [ -n "\${PROJECT_AWS_PROFILE:-}" ] && export AWS_PROFILE="$PROJECT_AWS_PROFILE"
  [ -n "\${PROJECT_AWS_REGION:-}" ] && export AWS_REGION="$PROJECT_AWS_REGION" AWS_DEFAULT_REGION="$PROJECT_AWS_REGION"
fi
self_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
real=""
IFS=: read -ra dirs <<< "$PATH"
for d in "\${dirs[@]}"; do
  [ "$d" = "$self_dir" ] && continue
  for n in aws aws.exe aws.cmd; do
    # never pick this script itself (compared by file identity, so a different spelling of the path cannot cause a loop)
    if [ -f "$d/$n" ] && ! [ "$d/$n" -ef "\${BASH_SOURCE[0]}" ]; then real="$d/$n"; break 2; fi
  done
done
if [ -z "$real" ]; then echo "The aws command was not found on this machine." >&2; exit 127; fi
exec "$real" "$@"
`;

const ENV_SHIM = `#!/usr/bin/env bash
# Prints export lines for this project's AWS account, for Terraform or SDK code:  eval "$(portal-aws-env)"
if [ -z "\${PROJECT_AWS_FILES:-}\${PROJECT_AWS_PROFILE:-}" ]; then
  echo "echo 'This project has no AWS account of its own; nothing to set.' >&2"
  exit 0
fi
echo "unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_BEARER_TOKEN_BEDROCK"
if [ -n "\${PROJECT_AWS_FILES:-}" ]; then
  printf 'export AWS_SHARED_CREDENTIALS_FILE=%q AWS_CONFIG_FILE=%q AWS_PROFILE=project\n' "$PROJECT_AWS_FILES/credentials" "$PROJECT_AWS_FILES/config"
fi
if [ -n "\${PROJECT_AWS_PROFILE:-}" ]; then printf 'export AWS_PROFILE=%q\n' "$PROJECT_AWS_PROFILE"; fi
if [ -n "\${PROJECT_AWS_REGION:-}" ]; then printf 'export AWS_REGION=%q AWS_DEFAULT_REGION=%q\n' "$PROJECT_AWS_REGION" "$PROJECT_AWS_REGION"; fi
exit 0
`;

export const SHIM_FILES: Record<string, string> = { aws: AWS_SHIM, 'portal-aws-env': ENV_SHIM };

/** Write the two scripts (once, and again when they change) and return their folder. */
export function ensureAwsShims(): string {
  const dir = dataPath('bin');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(SHIM_FILES)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text, { mode: 0o755 });
  }
  return dir;
}

/** The private folder holding one run's copy of its project's AWS keys. Outside the project, so no run-files API serves it. */
export function runAwsDir(runId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error('Bad run id');
  return dataPath('run-aws', runId);
}

/** Remove a run's AWS credentials file (when the run ends). */
export function removeRunAwsFiles(runId: string): void {
  try {
    fs.rmSync(runAwsDir(runId), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

/** Remove every run's AWS credentials file (at start-up: no run is active then). */
export function clearRunAwsFiles(): void {
  fs.rmSync(dataPath('run-aws'), { recursive: true, force: true });
}

/** Write the project's keys as an AWS shared credentials file plus config, readable by the server user only. */
function writeRunAwsFiles(runId: string, aws: Record<string, string>): string {
  const dir = runAwsDir(runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const line = (k: string, v: string | undefined) => (v ? `${k} = ${v.replace(/[\r\n]/g, '')}\n` : '');
  const creds = '[project]\n' + line('aws_access_key_id', aws.AWS_ACCESS_KEY_ID) + line('aws_secret_access_key', aws.AWS_SECRET_ACCESS_KEY) + line('aws_session_token', aws.AWS_SESSION_TOKEN);
  fs.writeFileSync(path.join(dir, 'credentials'), creds, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'config'), '[profile project]\n' + line('region', aws.AWS_REGION), { mode: 0o600 });
  return dir;
}

/**
 * Extra environment for an agent run in this project: its own AWS account for the agent's `aws` command (through the
 * shims above), and for the model too when a Bedrock model runs on this account. Keys go to a per-run credentials file
 * (removed when the run ends); a named profile and the region travel as PROJECT_AWS_* variables. Without a run id
 * (model lists) only those plain variables are set.
 */
export async function projectRunEnv(projectId: string, modelIsBedrock: boolean, runId?: string): Promise<{ env: Record<string, string>; pathPrefix?: string }> {
  const p = getProjectAws(projectId);
  if (p.auth === 'inherit') return { env: {} };
  const aws = await projectAwsEnv(projectId);
  const env: Record<string, string> = modelIsBedrock && projectModelUsesOwnAws(projectId) ? { ...aws } : {};
  env.PROJECT_AWS_REGION = aws.AWS_REGION;
  if (aws.AWS_ACCESS_KEY_ID && runId) env.PROJECT_AWS_FILES = writeRunAwsFiles(runId, aws);
  if (aws.AWS_PROFILE && !aws.AWS_ACCESS_KEY_ID) env.PROJECT_AWS_PROFILE = aws.AWS_PROFILE;
  return { env, pathPrefix: ensureAwsShims() };
}

/** Ask AWS which account these AWS_* variables belong to. Only these variables are used, never the server's own. */
/** Delete the encrypted keys saved for a project (used when the project is deleted). */
export function dropProjectAwsSecrets(projectId: string): void {
  for (const w of ['access_key_id', 'secret_access_key', 'session_token'] as const) deleteSecret(secretName(projectId, w));
}

export async function callerIdentity(env: Record<string, string>): Promise<{ account: string; arn: string; userId: string }> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^AWS_/.test(k)) clean[k] = v;
  const bin = process.env.PORTAL_AWS_BIN || 'aws';
  const lead: string[] = process.env.PORTAL_AWS_BIN_ARGS ? JSON.parse(process.env.PORTAL_AWS_BIN_ARGS) : [];
  try {
    const { stdout } = await execFileP(bin, [...lead, 'sts', 'get-caller-identity', '--output', 'json'], { env: { ...clean, ...env }, timeout: 25_000 });
    const j = JSON.parse(stdout);
    return { account: String(j.Account ?? ''), arn: String(j.Arn ?? ''), userId: String(j.UserId ?? '') };
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw new HttpError(502, 'The AWS CLI is not installed on the server, so the connection cannot be tested.');
    // Windows output ends lines with \r\n; keep the last two real lines of what the CLI said.
    const said = (s: unknown) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const lines = [...said(e?.stderr), ...said(e?.stdout)];
    let err = lines.slice(-2).join(' ');
    if (e?.killed || e?.signal) {
      const why = `The AWS CLI did not answer within 25 s, so these credentials could not be checked (network, proxy or VPN?)${err ? `: ${err}` : ''}`;
      console.error('[aws] sts get-caller-identity timed out:', why);
      throw new HttpError(504, why.slice(0, 400));
    }
    if (!err) err = `the AWS CLI exited with code ${e?.code ?? '?'} without saying why${e?.message ? ` (${said(e.message)[0]})` : ''}`;
    console.error('[aws] sts get-caller-identity failed:', err);
    throw new HttpError(502, `AWS did not accept these credentials: ${err.slice(0, 300)}`);
  }
}

/** Remember which AWS account a set of credentials belongs to. Keys: "settings", "project:<id>", "profile:<name>". */
export function saveIdentity(key: string, account: string, arn: string, region: string): void {
  exec(
    'INSERT INTO aws_identities (key, account, arn, region, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET account = excluded.account, arn = excluded.arn, region = excluded.region, checked_at = excluded.checked_at',
    key,
    account,
    arn,
    region,
    now(),
  );
}

export function identityFor(key: string): { account: string; arn: string; region: string; checkedAt: string } | null {
  const r = one<{ account: string; arn: string; region: string; checked_at: string }>('SELECT account, arn, region, checked_at FROM aws_identities WHERE key = ?', key);
  return r ? { account: r.account, arn: r.arn, region: r.region, checkedAt: r.checked_at } : null;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function view(projectId: string, isOwner: boolean) {
  const p = getProjectAws(projectId);
  const key = secretInfo(secretName(projectId, 'access_key_id'));
  const conn = p.auth === 'connection' ? getConnection(p.connectionId) : null;
  const idn = conn ? identityFor(identityKey(conn.id)) : null;
  return {
    auth: p.auth,
    profile: p.profile,
    region: p.region,
    provider: p.provider,
    connectionId: p.auth === 'connection' ? p.connectionId : '',
    connection: conn ? { id: conn.id, name: conn.name, how: connectionHow(conn), region: conn.region, account: idn?.account ?? (conn.auth === 'sso' ? conn.ssoAccountId : null) } : null,
    ssoAccountId: p.auth === 'sso' ? p.ssoAccountId : '',
    ssoRoleName: p.auth === 'sso' ? p.ssoRoleName : '',
    defaultRegion: getSettings().aws.region,
    defaultProvider: getSettings().provider.mode,
    // The key ID is not secret, but only the owner needs to see which key is stored.
    accessKey: p.auth === 'keys' ? { set: key.set, hint: isOwner ? key.hint : undefined } : { set: false },
    secretSet: p.auth === 'keys' && secretInfo(secretName(projectId, 'secret_access_key')).set,
    tokenSet: p.auth === 'keys' && secretInfo(secretName(projectId, 'session_token')).set,
  };
}

/** What a project's runs connect to, for the badge on session and run pages. No secrets. */
export function connectionSummary(projectId: string) {
  const p = getProjectAws(projectId);
  const s = getSettings();
  const provider = effectiveProvider(projectId);
  const ownAws = p.auth !== 'inherit';
  const conn = p.auth === 'connection' ? getConnection(p.connectionId) : null;
  const region = conn ? conn.region : (ownAws && p.region) || s.aws.region;
  const awsHow = conn
    ? conn.name
    : p.auth === 'sso'
      ? `SSO ${p.ssoRoleName}`
      : p.auth === 'profile'
        ? `profile ${p.profile}`
        : p.auth === 'keys'
          ? 'access keys'
          : s.aws.auth === 'sso'
            ? `SSO ${s.aws.ssoRoleName ?? ''}`.trim()
            : s.aws.auth === 'profile'
              ? `profile ${s.aws.profile}`
              : s.aws.auth;
  const known = identityFor(conn ? identityKey(conn.id) : ownAws ? `project:${projectId}` : 'settings');
  const account = conn
    ? known?.account ?? (conn.auth === 'sso' ? conn.ssoAccountId : '')
    : p.auth === 'sso'
      ? p.ssoAccountId
      : !ownAws && s.aws.auth === 'sso'
        ? s.aws.ssoAccountId ?? known?.account ?? ''
        : known?.account ?? '';
  return {
    provider,
    providerSource: p.provider !== 'inherit' ? 'project' : 'settings',
    // Where the model's credentials come from (Bedrock only).
    modelAws: provider === 'bedrock' ? (projectModelUsesOwnAws(projectId) ? 'project' : 'settings') : null,
    aws: { source: ownAws ? 'project' : 'settings', how: awsHow, account, region },
  };
}

export function registerProjectAwsRoutes(): void {
  get('/api/projects/:pid/aws', (ctx) => {
    const { project, access } = requireProject(ctx, ctx.params.pid);
    return view(project.id, access === 'owner');
  });

  get('/api/projects/:pid/connection', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return connectionSummary(project.id);
  });

  put('/api/projects/:pid/aws', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'owner');
    const body = await ctx.json();
    const cur = getProjectAws(project.id);
    const auth = body.auth as ProjectAwsAuth;
    if (!['inherit', 'connection', 'profile', 'keys', 'sso'].includes(auth)) throw badRequest('Choose how this project signs in to AWS');
    const provider = (body.provider === undefined ? cur.provider : body.provider) as ProjectProvider;
    if (!PROVIDERS.includes(provider)) throw badRequest('Unknown model provider');
    let connectionId = '';
    if (auth === 'connection') {
      connectionId = String(body.connectionId ?? '').trim();
      if (!connectionId || !getConnection(connectionId)) throw badRequest('Choose one of the AWS accounts set up on the AWS accounts page');
      // An AWS account is shared access set up by an admin; only an admin may hand it to a project.
      const changed = cur.auth !== 'connection' || cur.connectionId !== connectionId;
      if (changed && !ctx.user!.is_admin) throw new HttpError(403, 'Only a portal admin can connect a project to an AWS account.');
    }
    const region = str(body.region, 'Region', { max: 30, optional: true }).trim();
    if (region && !REGION_RE.test(region)) throw badRequest('AWS region looks wrong (for example ap-southeast-1)');
    const profile = str(body.profile, 'Profile name', { max: 64, optional: true }).trim();
    if (auth === 'profile' && !PROFILE_RE.test(profile)) throw badRequest('Enter the AWS profile name (letters, digits, dots, dashes)');

    let ssoAccountId = '';
    let ssoRoleName = '';
    if (auth === 'sso') {
      ssoAccountId = str(body.ssoAccountId, 'AWS account', { max: 12, optional: true }).trim();
      ssoRoleName = str(body.ssoRoleName, 'Role', { max: 64, optional: true }).trim();
      if (!ACCOUNT_RE.test(ssoAccountId)) throw badRequest('Choose the AWS account (12 digits)');
      if (!ROLE_RE.test(ssoRoleName)) throw badRequest('Choose the IAM role');
      // The SSO sign-in belongs to the portal admin; only an admin may hand one of its roles to a project.
      const changed = cur.auth !== 'sso' || cur.ssoAccountId !== ssoAccountId || cur.ssoRoleName !== ssoRoleName;
      if (changed && !ctx.user!.is_admin) throw new HttpError(403, 'Only a portal admin can give a project an AWS SSO account, because it uses the admin’s SSO sign-in.');
    }

    if (auth === 'keys') {
      const id = typeof body.accessKeyId === 'string' ? body.accessKeyId.trim() : '';
      const secret = typeof body.secretAccessKey === 'string' ? body.secretAccessKey.trim() : '';
      const token = typeof body.sessionToken === 'string' ? body.sessionToken.trim() : '';
      if (id && !/^[A-Z0-9]{16,128}$/.test(id)) throw badRequest('The access key ID looks wrong (it is 20 capital letters and digits, like AKIA… or ASIA…)');
      if (secret && (secret.length < 20 || secret.length > 200)) throw badRequest('The secret access key looks wrong');
      if (token.length > 4000) throw badRequest('The session token is too long');
      const hasId = Boolean(id) || secretInfo(secretName(project.id, 'access_key_id')).set;
      const hasSecret = Boolean(secret) || secretInfo(secretName(project.id, 'secret_access_key')).set;
      if (!hasId || !hasSecret) throw badRequest('Enter both the access key ID and the secret access key');
      if (id) await setSecret(secretName(project.id, 'access_key_id'), id);
      if (secret) await setSecret(secretName(project.id, 'secret_access_key'), secret);
      // Temporary credentials come with a token; replacing the key without one must not keep the old token.
      if (token) await setSecret(secretName(project.id, 'session_token'), token);
      else if (id || secret) deleteSecret(secretName(project.id, 'session_token'));
    } else {
      for (const w of ['access_key_id', 'secret_access_key', 'session_token'] as const) deleteSecret(secretName(project.id, w));
    }
    exec(
      'INSERT INTO project_aws (project_id, auth, profile, region, provider, sso_account_id, sso_role_name, connection_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET auth = excluded.auth, profile = excluded.profile, region = excluded.region, provider = excluded.provider, sso_account_id = excluded.sso_account_id, sso_role_name = excluded.sso_role_name, connection_id = excluded.connection_id, updated_at = excluded.updated_at',
      project.id,
      auth,
      auth === 'profile' ? profile : '',
      auth === 'connection' ? '' : region,
      provider,
      ssoAccountId,
      ssoRoleName,
      connectionId,
      now(),
    );
    clearModelListCache();
    await writeClaudeMd(project.id, 'Update AWS account notes').catch(() => undefined);
    return view(project.id, true);
  });

  // Which AWS account does this project really connect to?
  post('/api/projects/:pid/aws/test', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const env = await projectAwsEnv(project.id);
    const who = await callerIdentity(env);
    const pa = getProjectAws(project.id);
    saveIdentity(pa.auth === 'inherit' ? 'settings' : pa.auth === 'connection' ? identityKey(pa.connectionId) : `project:${project.id}`, who.account, who.arn, env.AWS_REGION ?? '');
    return { ok: true, ...who, region: env.AWS_REGION ?? '' };
  });
}
