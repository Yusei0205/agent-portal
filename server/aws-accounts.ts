/**
 * The AWS accounts screen: every CodeCommit repository and project the signed-in user can see, grouped by the AWS
 * account its credentials reach.
 *
 * A repository's credentials are, in order: the profile named in its address (codecommit://profile@repo, which the
 * git helper honours before anything else), then its project's own AWS account, then the Settings credentials.
 * "Check" asks AWS which account a set of credentials belongs to (sts get-caller-identity) and remembers the answer,
 * so credentials that reach the same account are shown together, whatever way they were entered.
 */
import { all, type Row } from './db.ts';
import { get, post } from './http.ts';
import { accessOf, listProjectsFor } from './projects.ts';
import { awsEnv, getSettings } from './settings.ts';
import { callerIdentity, identityFor, projectAwsEnv, saveIdentity, getProjectAws } from './project-aws.ts';
import { connectionEnv, connectionHow, getConnection, identityKey, listConnections, registerAwsConnectionRoutes } from './aws-connections.ts';
import { forbidden, badRequest } from './util.ts';

/** The profile a git-remote-codecommit address names, if any: codecommit::region://profile@repo. */
export function profileFromUrl(url: string): string | null {
  const m = url.match(/^codecommit(?:::[a-z0-9-]+)?:\/\/([A-Za-z0-9_.-]+)@/);
  return m ? m[1] : null;
}

interface KeyInfo {
  key: string;
  label: string;
  how: string;
  region: string;
}

interface GroupProject {
  id: string;
  name: string;
  access: string;
  own: boolean;
}

interface GroupRepo {
  id: string;
  name: string;
  url: string;
  status: string;
  projectId: string;
  projectName: string;
  viaAddress: string | null;
}

export interface AwsGroup {
  id: string;
  accountId: string | null;
  arn: string | null;
  checkedAt: string | null;
  title: string;
  /** The credential sets that reach this account, each of which can be checked on its own. */
  sources: { key: string; label: string; how: string; checkedAt: string | null; canCheck: boolean; connectionId: string | null }[];
  /** True when the Settings credentials (also used for the Bedrock model) are among them. */
  bedrock: boolean;
  projects: GroupProject[];
  repos: GroupRepo[];
}

function settingsHow(isAdmin: boolean): { how: string; region: string } {
  const a = getSettings().aws;
  if (!isAdmin) return { how: 'Shared credentials', region: a.region };
  const method: Record<string, string> = {
    ambient: "The server's own AWS identity",
    profile: `Named profile ${a.profile || '(not set)'}`,
    keys: 'Access keys',
    'bedrock-key': 'Bedrock API key',
    sso: 'AWS SSO',
  };
  return { how: method[a.auth] ?? a.auth, region: a.region };
}

function projectHow(projectId: string): { how: string; region: string } {
  const p = getProjectAws(projectId);
  return { how: p.auth === 'profile' ? `Named profile ${p.profile}` : p.auth === 'sso' ? `AWS SSO ${p.ssoRoleName}` : 'Access keys', region: p.region || getSettings().aws.region };
}

/** The identity key and label for the credentials a project uses. */
function projectKey(projectId: string, projectName: string): { key: string; label: string; how: string; region: string } | null {
  const own = getProjectAws(projectId);
  if (own.auth === 'inherit') return null;
  if (own.auth === 'connection') {
    const c = getConnection(own.connectionId);
    if (c) return { key: identityKey(c.id), label: c.name, how: connectionHow(c), region: c.region };
  }
  return { key: `project:${projectId}`, label: `${projectName}’s own credentials`, ...projectHow(projectId) };
}

/** Group what this user can see by AWS account. */
export function groupAwsAccounts(user: { id: string; is_admin: number; email: string; name: string }): AwsGroup[] {
  const isAdmin = Boolean(user.is_admin);
  const keys = new Map<string, KeyInfo & { connectionId?: string }>();
  const members = new Map<string, Map<string, GroupProject>>();
  const repoByKey = new Map<string, GroupRepo[]>();

  const ensure = (info: KeyInfo & { connectionId?: string }) => {
    if (!keys.has(info.key)) keys.set(info.key, info);
    if (!members.has(info.key)) members.set(info.key, new Map());
    if (!repoByKey.has(info.key)) repoByKey.set(info.key, []);
  };

  for (const p of listProjectsFor(user as any)) {
    if (p.archived) continue;
    const own = projectKey(p.id, p.name);
    const projKey = own ? own.key : 'settings';
    const repos = all<Row>("SELECT id, name, url, status FROM repos WHERE project_id = ? AND provider = 'codecommit' ORDER BY name", p.id);
    if (!own) {
      const s = settingsHow(isAdmin);
      ensure({ key: 'settings', label: 'Settings credentials', ...s });
    } else {
      ensure({ ...own, connectionId: own.key.startsWith('conn:') ? own.key.slice(5) : undefined });
    }
    if (own || repos.length) members.get(projKey)!.set(p.id, { id: p.id, name: p.name, access: p.access, own: Boolean(own) });
    for (const r of repos) {
      const named = profileFromUrl(r.url);
      const key = named ? `profile:${named}` : projKey;
      if (named) {
        ensure({ key, label: `Profile ${named}`, how: 'Named in the repository address', region: getSettings().aws.region });
        members.get(key)!.set(p.id, members.get(key)!.get(p.id) ?? { id: p.id, name: p.name, access: p.access, own: false });
      }
      repoByKey.get(key)!.push({ id: r.id, name: r.name, url: r.url, status: r.status, projectId: p.id, projectName: p.name, viaAddress: named });
    }
  }
  // Admins always see the Settings credentials (what the Bedrock model signs in with) and every AWS account set up here.
  if (isAdmin) {
    ensure({ key: 'settings', label: 'Settings credentials', ...settingsHow(true) });
    for (const c of listConnections()) ensure({ key: identityKey(c.id), label: c.name, how: connectionHow(c), region: c.region, connectionId: c.id });
  }

  const groups = new Map<string, AwsGroup>();
  for (const [key, info] of keys) {
    const idn = identityFor(key);
    const gid = idn ? `acct:${idn.account}` : key;
    let g = groups.get(gid);
    if (!g) {
      g = { id: gid, accountId: idn?.account ?? null, arn: idn?.arn ?? null, checkedAt: idn?.checkedAt ?? null, title: '', sources: [], bedrock: false, projects: [], repos: [] };
      groups.set(gid, g);
    }
    if (key === 'settings') g.bedrock = true;
    g.sources.push({ key, label: info.label, how: `${info.how} · ${info.region}`, checkedAt: idn?.checkedAt ?? null, canCheck: key === 'settings' || key.startsWith('conn:') ? isAdmin : true, connectionId: info.connectionId ?? null });
    for (const m of members.get(key)!.values()) if (!g.projects.some((x) => x.id === m.id)) g.projects.push(m);
    g.repos.push(...(repoByKey.get(key) ?? []));
  }
  for (const g of groups.values()) {
    g.title = g.accountId ? `AWS account ${g.accountId}` : g.sources.length === 1 ? g.sources[0].label : 'Not checked yet';
    g.projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    g.repos.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.name.localeCompare(b.name));
  }
  // Groups that have repositories first, then by title; unchecked groups after checked ones of the same size.
  return [...groups.values()].sort((a, b) => b.repos.length - a.repos.length || Number(Boolean(b.accountId)) - Number(Boolean(a.accountId)) || a.title.localeCompare(b.title));
}

/** Which credentials does `key` stand for, and may this user check them? Returns the AWS_* variables to ask with. */
async function envForKey(user: { id: string; is_admin: number }, key: string): Promise<Record<string, string>> {
  if (key === 'settings') {
    if (!user.is_admin) throw forbidden('Only admins can check the Settings credentials');
    return awsEnv();
  }
  const conn = key.match(/^conn:(.+)$/);
  if (conn) {
    if (!user.is_admin) throw forbidden('Only admins can check an AWS account');
    return connectionEnv(conn[1]);
  }
  const project = key.match(/^project:(.+)$/);
  if (project) {
    const access = accessOf(user as any, project[1]);
    if (!access) throw forbidden('You do not have access to that project');
    if (access === 'viewer') throw forbidden('You have view-only access to this project');
    return projectAwsEnv(project[1]);
  }
  const profile = key.match(/^profile:([A-Za-z0-9_.-]{1,64})$/);
  if (profile) {
    // Only someone who can edit a project with a repository that names this profile may use it.
    const rows = all<Row>("SELECT DISTINCT project_id FROM repos WHERE provider = 'codecommit' AND (url LIKE ? OR url LIKE ?)", `codecommit://${profile[1]}@%`, `codecommit::%://${profile[1]}@%`);
    const allowed = rows.some((r) => {
      const a = accessOf(user as any, r.project_id);
      return a === 'editor' || a === 'owner';
    });
    if (!allowed) throw forbidden('You cannot check that profile');
    const env: Record<string, string> = { AWS_PROFILE: profile[1], AWS_REGION: getSettings().aws.region, AWS_DEFAULT_REGION: getSettings().aws.region };
    for (const k of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) if (process.env[k]) env[k] = process.env[k]!;
    return env;
  }
  throw badRequest('Unknown credentials');
}

export function registerAwsAccountRoutes(): void {
  registerAwsConnectionRoutes({ callerIdentity, saveIdentity, identityFor });
  get('/api/aws/accounts', (ctx) => ({ groups: groupAwsAccounts(ctx.user!) }));

  // Ask AWS which account a set of credentials belongs to, and remember it.
  post('/api/aws/check', async (ctx) => {
    const body = await ctx.json();
    const key = String(body.key ?? '');
    const env = await envForKey(ctx.user!, key);
    const who = await callerIdentity(env);
    saveIdentity(key, who.account, who.arn, env.AWS_REGION ?? '');
    return { ok: true, key, ...who };
  });
}
