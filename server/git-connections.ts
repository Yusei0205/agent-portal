/**
 * Repository connections: reusable sign-ins that repositories clone and push with.
 *
 *   github     a personal access token (or fine-grained token)
 *   bitbucket  a username and an app password / API token, for one Bitbucket workspace
 *   codecommit one of the AWS accounts (AWS accounts page), so no git secret is stored at all
 *   git        any other HTTPS host: a username and a token
 *
 * A connection is shared with everyone ("team") or kept to its creator ("personal"). Secrets are write-only: the
 * browser only ever sees the last characters. Team connections can be changed by admins and by whoever made them;
 * personal ones only by their owner. A connection cannot be removed while repositories use it.
 */
import { all, insert, one, run as exec, update, type Row } from './db.ts';
import { del, get, post, put, type Ctx } from './http.ts';
import { deleteSecret, getSecret, secretInfo, setSecret } from './secrets.ts';
import { HttpError, badRequest, newId, notFound, now, str } from './util.ts';
import { connectionEnv, getConnection as getAwsConnection } from './aws-connections.ts';
import { listCodeCommitRepos } from './codecommit.ts';
import { gitConfigEnv } from './git.ts';

export type GitProvider = 'github' | 'bitbucket' | 'codecommit' | 'git';
const PROVIDERS: GitProvider[] = ['github', 'bitbucket', 'codecommit', 'git'];

export interface GitConnection {
  id: string;
  name: string;
  provider: GitProvider;
  scope: 'team' | 'personal';
  owner_id: string | null;
  host: string;
  username: string;
  workspace: string;
  aws_connection_id: string;
  test_ok: number | null;
  test_message: string;
  tested_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

const tokenSecret = (id: string) => `gitconn.${id}.token`;
type User = NonNullable<Ctx['user']>;

export function getGitConnection(id: string): GitConnection | null {
  return one<GitConnection>('SELECT * FROM git_connections WHERE id = ?', id) ?? null;
}

/** Team connections, plus this person's own. */
export function visibleConnections(user: User): GitConnection[] {
  return all<GitConnection>("SELECT * FROM git_connections WHERE scope = 'team' OR owner_id = ? ORDER BY scope DESC, name COLLATE NOCASE", user.id);
}

export function canUse(c: GitConnection, user: User): boolean {
  return c.scope === 'team' || c.owner_id === user.id;
}

function canManage(c: GitConnection, user: User): boolean {
  return c.scope === 'personal' ? c.owner_id === user.id : Boolean(user.is_admin) || c.created_by === user.id;
}

function mustUse(id: string, user: User): GitConnection {
  const c = getGitConnection(id);
  if (!c || !canUse(c, user)) throw notFound('Connection not found');
  return c;
}

export function usedBy(id: string): { id: string; name: string; project_id: string; project: string }[] {
  return all<any>('SELECT r.id, r.name, r.project_id, p.name AS project FROM repos r JOIN projects p ON p.id = r.project_id WHERE r.connection_id = ? ORDER BY p.name, r.name', id);
}

function view(c: GitConnection, user: User) {
  const aws = c.aws_connection_id ? getAwsConnection(c.aws_connection_id) : null;
  const users = usedBy(c.id);
  const creator = c.created_by ? one<Row>('SELECT name FROM users WHERE id = ?', c.created_by) : null;
  const editor = c.updated_by ? one<Row>('SELECT name FROM users WHERE id = ?', c.updated_by) : null;
  return {
    id: c.id,
    name: c.name,
    provider: c.provider,
    scope: c.scope,
    host: c.host,
    username: c.username,
    workspace: c.workspace,
    aws: aws ? { id: aws.id, name: aws.name, region: aws.region } : null,
    token: c.provider === 'codecommit' ? null : secretInfo(tokenSecret(c.id)),
    test: c.tested_at ? { ok: Boolean(c.test_ok), message: c.test_message, at: c.tested_at } : null,
    usedBy: users.length,
    usedByRepos: users.slice(0, 20),
    createdBy: creator?.name ?? null,
    updatedBy: editor?.name ?? null,
    updatedAt: c.updated_at,
    canManage: canManage(c, user),
  };
}

function checkHost(raw: unknown): string {
  const h = str(raw, 'Host', { max: 200 }).trim().replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[\w.~-]+)*$/.test(h)) throw badRequest('Use the https:// address of the git server, like https://gitlab.example.com');
  return h;
}

/** Validate a create or edit request; returns the columns to save and the token to store (if any). */
async function readBody(body: any, cur?: GitConnection) {
  const provider: GitProvider = cur?.provider ?? body.provider;
  if (!PROVIDERS.includes(provider)) throw badRequest('Choose GitHub, Bitbucket, CodeCommit or another git server');
  const name = str(body.name ?? cur?.name, 'Name', { max: 80 }).trim();
  if (!name) throw badRequest('Give the connection a name');
  const scope = (body.scope ?? cur?.scope) === 'personal' ? 'personal' : 'team';
  const row: Partial<GitConnection> = { name, scope, host: '', username: '', workspace: '', aws_connection_id: '' };
  if (provider === 'codecommit') {
    const awsId = str(body.awsConnectionId ?? cur?.aws_connection_id, 'AWS account', { max: 64 });
    if (!getAwsConnection(awsId)) throw badRequest('Pick one of the AWS accounts (add one on the AWS accounts page first)');
    row.aws_connection_id = awsId;
  } else {
    if (provider === 'git') row.host = checkHost(body.host ?? cur?.host);
    if (provider === 'bitbucket') {
      row.workspace = str(body.workspace ?? cur?.workspace, 'Bitbucket workspace', { max: 100 }).trim();
      if (!/^[\w.-]+$/.test(row.workspace)) throw badRequest('Enter the Bitbucket workspace id, as in bitbucket.org/<workspace>');
    }
    row.username = str(body.username ?? cur?.username ?? '', 'Username', { max: 100, optional: provider === 'github' }).trim();
    if (provider !== 'github' && !row.username) throw badRequest('Enter the username the token belongs to');
  }
  const token = body.token ? str(body.token, 'Token', { max: 4000 }).trim() : '';
  if (!cur && provider !== 'codecommit' && !token) throw badRequest('Paste the token (it is stored write-only)');
  return { provider, row, token };
}

/* ------------------------------------------------------------------ */
/* Using a connection                                                  */
/* ------------------------------------------------------------------ */

async function token(c: GitConnection): Promise<string> {
  const t = await getSecret(tokenSecret(c.id));
  if (!t) throw badRequest(`The connection "${c.name}" has no token. Add one on the Connections page.`);
  return t;
}

function awsCredentials(env: Record<string, string>) {
  return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN, profile: env.AWS_PROFILE };
}

/** Environment for git commands against a repository that uses this connection. */
export async function connectionGitEnv(c: GitConnection, url: string): Promise<Record<string, string>> {
  if (c.provider === 'codecommit') {
    const aws = await connectionEnv(c.aws_connection_id);
    if (!url.startsWith('https://')) return aws;
    return {
      ...aws,
      ...gitConfigEnv([
        ['credential.helper', ''],
        ['credential.helper', '!aws codecommit credential-helper $@'],
        ['credential.UseHttpPath', 'true'],
      ]),
    };
  }
  if (!url.startsWith('https://')) return {};
  const user = c.username || 'x-access-token';
  const origin = new URL(url).origin;
  return gitConfigEnv([[`http.${origin}/.extraheader`, `AUTHORIZATION: basic ${Buffer.from(`${user}:${await token(c)}`).toString('base64')}`]]);
}

/** The token of a GitHub connection, for the GitHub API (pull requests). */
export async function connectionToken(c: GitConnection): Promise<string | null> {
  return c.provider === 'codecommit' ? null : getSecret(tokenSecret(c.id));
}

export interface RemoteRepo {
  name: string;
  url: string;
  defaultBranch: string;
  description: string;
}

async function api(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'agent-portal', ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(res.status === 401 || res.status === 403 ? 400 : 502, `${new URL(url).host} said ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

const basic = (u: string, p: string) => ({ Authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });

/** Sign in once and say who the connection is. */
export async function testConnection(c: GitConnection): Promise<string> {
  if (c.provider === 'github') {
    const me = await api('https://api.github.com/user', { Authorization: `Bearer ${await token(c)}` });
    return `Signed in to GitHub as ${me.login}.`;
  }
  if (c.provider === 'bitbucket') {
    const me = await api('https://api.bitbucket.org/2.0/user', basic(c.username, await token(c)));
    await api(`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(c.workspace)}?pagelen=1`, basic(c.username, await token(c)));
    return `Signed in to Bitbucket as ${me.display_name ?? me.username}; workspace ${c.workspace} is readable.`;
  }
  if (c.provider === 'codecommit') {
    const aws = getAwsConnection(c.aws_connection_id);
    if (!aws) throw badRequest('Its AWS account was removed. Pick another one.');
    const repos = await listCodeCommitRepos(aws.region, awsCredentials(await connectionEnv(aws.id)));
    return `Signed in through the AWS account "${aws.name}"; ${repos.length} CodeCommit repositor${repos.length === 1 ? 'y is' : 'ies are'} listable in ${aws.region}.`;
  }
  // Another git server: there is no common API, so the check is a token being present; cloning proves the rest.
  await token(c);
  return `Token saved for ${c.host}. It is checked when a repository clones.`;
}

/** Repositories the connection can see, to pick from instead of typing addresses. */
export async function listRemoteRepos(c: GitConnection): Promise<RemoteRepo[]> {
  if (c.provider === 'github') {
    const list = await api('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', { Authorization: `Bearer ${await token(c)}` });
    return list.map((r: any) => ({ name: r.full_name, url: r.clone_url.replace(/\.git$/, ''), defaultBranch: r.default_branch ?? '', description: r.description ?? '' }));
  }
  if (c.provider === 'bitbucket') {
    const out: RemoteRepo[] = [];
    let next: string | null = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(c.workspace)}?pagelen=100&sort=-updated_on`;
    for (let page = 0; next && page < 5; page++) {
      const r: any = await api(next, basic(c.username, await token(c)));
      for (const x of r.values ?? []) out.push({ name: x.full_name, url: `https://bitbucket.org/${x.full_name}.git`, defaultBranch: x.mainbranch?.name ?? '', description: x.description ?? '' });
      next = r.next ?? null;
    }
    return out;
  }
  if (c.provider === 'codecommit') {
    const aws = getAwsConnection(c.aws_connection_id);
    if (!aws) throw badRequest('Its AWS account was removed. Pick another one.');
    const repos = await listCodeCommitRepos(aws.region, awsCredentials(await connectionEnv(aws.id)));
    return repos.map((r) => ({ name: r.name, url: r.cloneUrlHttp, defaultBranch: r.defaultBranch, description: r.description }));
  }
  return [];
}

/** The provider a repository row records for a connection (github keeps pull requests working). */
export function repoProviderFor(c: GitConnection): 'github' | 'codecommit' | 'git' {
  return c.provider === 'github' ? 'github' : c.provider === 'codecommit' ? 'codecommit' : 'git';
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

async function runTest(c: GitConnection) {
  let ok = true;
  let message: string;
  try {
    message = await testConnection(c);
  } catch (e: any) {
    ok = false;
    message = String(e?.message ?? e).slice(0, 400);
  }
  update('git_connections', c.id, { test_ok: ok ? 1 : 0, test_message: message, tested_at: now() });
  return { ok, message };
}

export function registerGitConnectionRoutes(): void {
  get('/api/git-connections', (ctx) => ({ connections: visibleConnections(ctx.user!).map((c) => view(c, ctx.user!)) }));

  post('/api/git-connections', async (ctx) => {
    const { provider, row, token: t } = await readBody(await ctx.json());
    const id = newId('gc_');
    insert('git_connections', { id, provider, ...row, owner_id: row.scope === 'personal' ? ctx.user!.id : null, created_by: ctx.user!.id, updated_by: ctx.user!.id, created_at: now(), updated_at: now() });
    if (t) await setSecret(tokenSecret(id), t);
    const c = getGitConnection(id)!;
    const test = await runTest(c);
    return { connection: view(getGitConnection(id)!, ctx.user!), test };
  });

  put('/api/git-connections/:id', async (ctx) => {
    const cur = mustUse(ctx.params.id, ctx.user!);
    if (!canManage(cur, ctx.user!)) throw new HttpError(403, cur.scope === 'personal' ? 'Only its owner can change a personal connection' : 'Only admins and whoever made it can change a team connection');
    const { row, token: t } = await readBody(await ctx.json(), cur);
    // Making a used team connection personal would cut other people's repositories off from it.
    if (cur.scope === 'team' && row.scope === 'personal' && usedBy(cur.id).length) throw badRequest('Repositories use this connection, so it stays shared with the team');
    update('git_connections', cur.id, { ...row, owner_id: row.scope === 'personal' ? ctx.user!.id : null, updated_by: ctx.user!.id, updated_at: now() });
    if (t) await setSecret(tokenSecret(cur.id), t);
    const test = await runTest(getGitConnection(cur.id)!);
    return { connection: view(getGitConnection(cur.id)!, ctx.user!), test };
  });

  post('/api/git-connections/:id/test', async (ctx) => {
    const c = mustUse(ctx.params.id, ctx.user!);
    const test = await runTest(c);
    return { connection: view(getGitConnection(c.id)!, ctx.user!), test };
  });

  get('/api/git-connections/:id/repos', async (ctx) => {
    const c = mustUse(ctx.params.id, ctx.user!);
    return { repos: await listRemoteRepos(c) };
  });

  del('/api/git-connections/:id', (ctx) => {
    const c = mustUse(ctx.params.id, ctx.user!);
    if (!canManage(c, ctx.user!)) throw new HttpError(403, 'Only admins, its owner or whoever made it can remove this connection');
    const users = usedBy(c.id);
    if (users.length) throw badRequest(`Still used by ${users.length} repositor${users.length === 1 ? 'y' : 'ies'} (${users.slice(0, 3).map((u) => `${u.project}/${u.name}`).join(', ')}). Remove them or switch them to another connection first.`);
    exec('DELETE FROM git_connections WHERE id = ?', c.id);
    deleteSecret(tokenSecret(c.id));
    return { ok: true };
  });
}
