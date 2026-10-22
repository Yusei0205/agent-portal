/**
 * Jira integration (Jira Cloud, Atlassian OAuth 2.0 "3LO").
 *
 *  - Nothing about Jira is global. A project owner enters that project's own Atlassian OAuth app (client ID and secret),
 *    so each project can use a different Atlassian account or organisation.
 *  - Each portal project has its own shared Jira sign-in: a project owner clicks "Connect Jira" and approves in the
 *    browser, so different projects can use different Atlassian accounts and sites. Tokens are stored encrypted per
 *    project and refreshed automatically; every member of the project reads tickets through that sign-in.
 *  - A portal project is mapped to a Jira project key. Developers list its tickets, pick one and start an analysis run
 *    that reads the ticket and the project's repository. The result can be posted back as a Jira comment, only when a
 *    person clicks the button.
 *
 * Ticket text comes from Jira and is untrusted: it is passed to the agent as data, never as instructions.
 */
import { cleanModel } from './models.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, one, run as exec, type Row } from './db.ts';
import { del, get, post, put, HANDLED } from './http.ts';
import { getProject, projectDir, requireProject } from './projects.ts';
import { deleteSecret, getSecret, setSecret } from './secrets.ts';
import { HttpError, badRequest, now, parseJson, str, withLock } from './util.ts';
import { adfComment, adfToMarkdown } from './jira-adf.ts';
import { KEY_RE, buildJql, clip, composeAnalysisPrompt, ticketMarkdown, type Mapping, type TicketDetail } from './jira-text.ts';
import { ensureFresh, getRepo } from './repos.ts';
import { getRun, startRun } from './agent/runner.ts';

// Overridable so tests can point the integration at a local fake Atlassian.
const AUTH_BASE = () => process.env.JIRA_AUTH_URL || 'https://auth.atlassian.com';
const API_BASE = () => process.env.JIRA_API_URL || 'https://api.atlassian.com';
const SCOPES = 'read:jira-work write:jira-work read:jira-user offline_access';
const projectSecret = (projectId: string) => `jira.project.${projectId}`;
const appSecret = (projectId: string) => `jira.app.${projectId}`;

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}$/;

/* ------------------------------------------------------------------ */
/* Settings and tokens                                                 */
/* ------------------------------------------------------------------ */

/** A project's Atlassian OAuth app, stored encrypted. */
interface JiraApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

async function loadApp(projectId: string): Promise<JiraApp | null> {
  const raw = await getSecret(appSecret(projectId));
  const v = raw ? parseJson<Partial<JiraApp> | null>(raw, null) : null;
  return v?.clientId && v.clientSecret ? { clientId: v.clientId, clientSecret: v.clientSecret, redirectUri: v.redirectUri ?? '' } : null;
}

interface Site {
  cloudId: string;
  url: string;
  name: string;
}

interface Conn {
  access: string;
  refresh: string;
  expiresAt: number;
  site: Site;
  sites: Site[];
  accountId: string;
  displayName: string;
  email: string;
}

async function loadConn(projectId: string): Promise<Conn | null> {
  const raw = await getSecret(projectSecret(projectId));
  return raw ? (parseJson<Conn | null>(raw, null)) : null;
}

const saveConn = (projectId: string, c: Conn) => setSecret(projectSecret(projectId), JSON.stringify(c));

/** Forget a project's Jira sign-in (also used when the project is deleted). */
export const dropJiraConnection = (projectId: string) => deleteSecret(projectSecret(projectId));

/** Forget everything Jira-related stored for a project: its sign-in and its Atlassian app. */
export function dropJira(projectId: string): void {
  deleteSecret(projectSecret(projectId));
  deleteSecret(appSecret(projectId));
}

/** Read a JSON response; turn Atlassian's several error shapes into one readable message. */
async function jfetch(url: string, init: RequestInit = {}): Promise<{ status: number; data: any }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(25_000) });
  } catch (e: any) {
    throw new HttpError(502, `Could not reach Jira (${e?.name === 'TimeoutError' ? 'timed out' : (e?.cause?.code ?? e?.message ?? e)})`);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

function jiraError(status: number, data: any): HttpError {
  const msg = (data?.errorMessages?.[0] ?? data?.message ?? data?.error_description ?? data?.error ?? '').toString().slice(0, 300);
  if (status === 429) return new HttpError(429, 'Jira is limiting requests. Wait a moment and try again.');
  if (status === 401) return new HttpError(401, 'This project’s Jira connection is not valid any more. A project owner needs to connect Jira again.');
  if (status === 403) return new HttpError(403, `Jira says the connected account does not have permission${msg ? `: ${msg}` : ''}`);
  if (status === 404) return new HttpError(404, `Not found in Jira${msg ? `: ${msg}` : ''}`);
  return new HttpError(502, `Jira returned ${status}${msg ? `: ${msg}` : ''}`);
}

async function clientCreds(projectId: string): Promise<{ id: string; secret: string; redirectUri: string }> {
  const app = await loadApp(projectId);
  if (!app) throw badRequest('Jira is not set up for this project yet. A project owner needs to add the project’s Atlassian app first.');
  return { id: app.clientId, secret: app.clientSecret, redirectUri: app.redirectUri };
}

async function tokenCall(body: Record<string, string>): Promise<{ access: string; refresh: string; expiresAt: number }> {
  const { status, data } = await jfetch(`${AUTH_BASE()}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (status >= 400 || !data?.access_token) {
    // The token endpoint's errors are about the app or the sign-in code, not about Jira permissions.
    const why = (data?.error_description ?? data?.error ?? data?.message ?? `status ${status}`).toString().slice(0, 200);
    throw new HttpError(status === 429 ? 429 : 400, `Atlassian refused the sign-in: ${why}`);
  }
  return { access: data.access_token, refresh: data.refresh_token ?? '', expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
}

/** A valid access token for this project's Jira sign-in, refreshed (and the rotated refresh token saved) when it is about to expire. */
async function connection(projectId: string): Promise<Conn> {
  const first = await loadConn(projectId);
  if (!first) throw new HttpError(409, 'This project is not connected to Jira yet. A project owner can connect it on the Tickets page.');
  if (first.expiresAt - Date.now() > 60_000) return first;
  return withLock(`jira:${projectId}`, async () => {
    const c = (await loadConn(projectId)) ?? first;
    if (c.expiresAt - Date.now() > 60_000) return c; // another request already refreshed it
    if (!c.refresh) {
      dropJiraConnection(projectId);
      throw new HttpError(401, 'This project’s Jira connection expired. A project owner needs to connect Jira again.');
    }
    const { id, secret } = await clientCreds(projectId);
    try {
      const t = await tokenCall({ grant_type: 'refresh_token', client_id: id, client_secret: secret, refresh_token: c.refresh });
      const next = { ...c, access: t.access, refresh: t.refresh || c.refresh, expiresAt: t.expiresAt };
      await saveConn(projectId, next);
      return next;
    } catch (e) {
      dropJiraConnection(projectId);
      throw new HttpError(401, 'This project’s Jira connection expired. A project owner needs to connect Jira again.');
    }
  });
}

/** Call the Jira REST API with this project's sign-in. */
async function jira(projectId: string, apiPath: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  const c = await connection(projectId);
  const { status, data } = await jfetch(`${API_BASE()}/ex/jira/${c.site.cloudId}/rest/api/3${apiPath}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${c.access}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (status >= 400) throw jiraError(status, data);
  return data;
}

/* ------------------------------------------------------------------ */
/* Tickets                                                             */
/* ------------------------------------------------------------------ */

function getMapping(projectId: string): Mapping | null {
  const r = one<Row>('SELECT project_key, jql FROM project_jira WHERE project_id = ?', projectId);
  return r ? { projectKey: r.project_key, jql: r.jql } : null;
}

export function mustMapping(projectId: string): Mapping {
  const m = getMapping(projectId);
  if (!m) throw badRequest('This project is not linked to a Jira project yet. Choose the Jira project key first.');
  return m;
}

export function checkKey(mapping: Mapping, key: string): string {
  if (!KEY_RE.test(key)) throw badRequest('That is not a Jira ticket key (like ABC-123)');
  if (!key.startsWith(mapping.projectKey + '-')) throw badRequest(`${key} is not in the linked Jira project ${mapping.projectKey}`);
  return key;
}

const LIST_FIELDS = 'summary,status,assignee,priority,updated,issuetype,labels';

function issueRow(i: any) {
  const f = i.fields ?? {};
  return {
    key: i.key as string,
    summary: (f.summary ?? '') as string,
    status: { name: f.status?.name ?? '', category: f.status?.statusCategory?.key ?? '' },
    assignee: (f.assignee?.displayName ?? null) as string | null,
    priority: (f.priority?.name ?? null) as string | null,
    type: (f.issuetype?.name ?? null) as string | null,
    updated: (f.updated ?? '') as string,
    labels: (f.labels ?? []) as string[],
  };
}

export async function issueDetail(projectId: string, mapping: Mapping, key: string): Promise<TicketDetail> {
  checkKey(mapping, key);
  const c = await connection(projectId);
  const i = await jira(projectId, `/issue/${key}?fields=summary,description,status,assignee,reporter,priority,labels,issuetype,created,updated,comment,attachment,issuelinks,parent,subtasks,components,fixVersions`);
  const f = i.fields ?? {};
  return {
    key: i.key as string,
    url: `${c.site.url}/browse/${i.key}`,
    summary: (f.summary ?? '') as string,
    type: f.issuetype?.name ?? null,
    status: { name: f.status?.name ?? '', category: f.status?.statusCategory?.key ?? '' },
    priority: f.priority?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    labels: (f.labels ?? []) as string[],
    components: (f.components ?? []).map((x: any) => x.name),
    fixVersions: (f.fixVersions ?? []).map((x: any) => x.name),
    created: f.created ?? '',
    updated: f.updated ?? '',
    description: adfToMarkdown(f.description),
    comments: ((f.comment?.comments ?? []) as any[]).map((cm) => ({ author: cm.author?.displayName ?? 'Unknown', created: cm.created ?? '', body: adfToMarkdown(cm.body) })),
    attachments: ((f.attachment ?? []) as any[]).map((a) => ({ filename: a.filename, size: a.size, mimeType: a.mimeType })),
    links: ((f.issuelinks ?? []) as any[]).map((l) => {
      const other = l.outwardIssue ?? l.inwardIssue;
      return { relation: l.outwardIssue ? l.type?.outward : l.type?.inward, key: other?.key, summary: other?.fields?.summary ?? '', status: other?.fields?.status?.name ?? '' };
    }),
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary ?? '' } : null,
    subtasks: ((f.subtasks ?? []) as any[]).map((s) => ({ key: s.key, summary: s.fields?.summary ?? '', status: s.fields?.status?.name ?? '' })),
  };
}

/**
 * Search Jira issues with a JQL query. Used by the loop trigger poller.
 * Returns a lightweight list suitable for template variable injection.
 */
export async function searchJiraIssues(projectId: string, jql: string, maxResults = 25): Promise<{ key: string; summary: string; status: string }[]> {
  const data = await jira(projectId, `/search/jql?${new URLSearchParams({ jql, fields: LIST_FIELDS, maxResults: String(maxResults) })}`);
  return ((data.issues ?? []) as any[]).map((i) => ({
    key: String(i.key ?? ''),
    summary: String(i.fields?.summary ?? ''),
    status: String(i.fields?.status?.name ?? ''),
  }));
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const states = new Map<string, { userId: string; projectId: string; returnTo: string; exp: number }>();

function safeReturn(v: string | null): string {
  return v && /^#\/[A-Za-z0-9_\/.-]{0,120}$/.test(v) ? v : '#/projects';
}

function redirect(ctx: { res: import('node:http').ServerResponse }, to: string): typeof HANDLED {
  ctx.res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
  ctx.res.end();
  return HANDLED;
}

function defaultRedirect(ctx: { req: import('node:http').IncomingMessage; secure: boolean }): string {
  return `${ctx.secure ? 'https' : 'http'}://${ctx.req.headers.host}/api/jira/callback`;
}

export function registerJiraRoutes(): void {
  // ---- This project's Atlassian app (client ID and secret), entered by a project owner ----
  get('/api/projects/:pid/jira/app', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'owner');
    const app = await loadApp(project.id);
    return { clientId: app?.clientId ?? '', secretSet: Boolean(app), redirectUri: app?.redirectUri || defaultRedirect(ctx), scopes: SCOPES.split(' ') };
  });

  put('/api/projects/:pid/jira/app', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'owner');
    const body = await ctx.json();
    const clientId = str(body.clientId, 'Client ID', { max: 100 }).trim();
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(clientId)) throw badRequest('The client ID looks wrong. Copy it from the Atlassian developer console.');
    let redirectUri = str(body.redirectUri, 'Callback URL', { max: 300, optional: true }).trim() || defaultRedirect(ctx);
    try {
      const u = new URL(redirectUri);
      if (!/^https?:$/.test(u.protocol)) throw new Error('scheme');
      redirectUri = u.toString();
    } catch {
      throw badRequest('The callback URL must be a full http(s) address, like http://localhost:8787/api/jira/callback');
    }
    const before = await loadApp(project.id);
    const clientSecret = typeof body.clientSecret === 'string' && body.clientSecret.trim() ? body.clientSecret.trim() : before?.clientSecret;
    if (!clientSecret) throw badRequest('Enter the client secret from the Atlassian developer console.');
    await setSecret(appSecret(project.id), JSON.stringify({ clientId, clientSecret, redirectUri }));
    // A sign-in made through a different app no longer refreshes, so drop it when the app changes.
    if (before && before.clientId !== clientId) dropJiraConnection(project.id);
    return { ok: true };
  });

  del('/api/projects/:pid/jira/app', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'owner');
    dropJira(project.id);
    return { ok: true };
  });

  // ---- Connect / disconnect (per project, by a project owner) ----
  get('/api/projects/:pid/jira/connect', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'owner');
    const { id, redirectUri } = await clientCreds(project.id);
    const state = crypto.randomBytes(24).toString('base64url');
    for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
    states.set(state, { userId: ctx.user!.id, projectId: project.id, returnTo: safeReturn(ctx.query.get('return')), exp: Date.now() + 10 * 60_000 });
    const url = new URL('/authorize', AUTH_BASE());
    url.search = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: id,
      scope: SCOPES,
      redirect_uri: redirectUri || defaultRedirect(ctx),
      state,
      response_type: 'code',
      prompt: 'consent',
    }).toString();
    return redirect(ctx, url.toString());
  });

  get('/api/jira/callback', async (ctx) => {
    const s = states.get(ctx.query.get('state') ?? '');
    states.delete(ctx.query.get('state') ?? '');
    const back = (flag: string, reason = '') => redirect(ctx, `/?jira=${flag}${reason ? `&reason=${encodeURIComponent(reason.slice(0, 140))}` : ''}${s?.returnTo ?? '#/projects'}`);
    if (!s || s.exp < Date.now() || s.userId !== ctx.user!.id) return back('error', 'The sign-in link expired. Click Connect Jira again.');
    const denied = ctx.query.get('error');
    if (denied) return back('error', ctx.query.get('error_description') || denied);
    const code = ctx.query.get('code');
    if (!code) return back('error', 'Atlassian did not send a sign-in code.');
    let saved = false;
    try {
      requireProject(ctx, s.projectId, 'owner'); // still an owner of the project now
      const { id, secret, redirectUri } = await clientCreds(s.projectId);
      const t = await tokenCall({ grant_type: 'authorization_code', client_id: id, client_secret: secret, code, redirect_uri: redirectUri || defaultRedirect(ctx) });
      const probe = await jfetch(`${API_BASE()}/oauth/token/accessible-resources`, { headers: { authorization: `Bearer ${t.access}`, accept: 'application/json' } });
      if (probe.status >= 400) throw jiraError(probe.status, probe.data);
      const sites: Site[] = (probe.data as any[]).map((r) => ({ cloudId: r.id, url: String(r.url).replace(/\/$/, ''), name: r.name }));
      if (!sites.length) throw badRequest('That Atlassian account has no Jira site that this app can use.');
      const conn: Conn = { access: t.access, refresh: t.refresh, expiresAt: t.expiresAt, site: sites[0], sites, accountId: '', displayName: '', email: '' };
      await saveConn(s.projectId, conn);
      saved = true;
      const me = await jira(s.projectId, '/myself');
      await saveConn(s.projectId, { ...conn, accountId: me.accountId ?? '', displayName: me.displayName ?? '', email: me.emailAddress ?? '' });
      return back('connected');
    } catch (e: any) {
      // A failed reconnect leaves an earlier working connection alone; only a half-finished new one is removed.
      if (saved) dropJiraConnection(s.projectId);
      return back('error', e?.message ?? 'Could not finish connecting to Jira.');
    }
  });

  post('/api/projects/:pid/jira/site', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'owner');
    const c = await connection(project.id);
    const body = await ctx.json();
    const site = c.sites.find((x) => x.cloudId === body.cloudId);
    if (!site) throw badRequest('That Jira site is not one this sign-in can reach');
    await saveConn(project.id, { ...c, site });
    return { ok: true };
  });

  del('/api/projects/:pid/jira/connection', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'owner');
    dropJiraConnection(project.id);
    return { ok: true };
  });

  // ---- A portal project's Jira link ----
  get('/api/projects/:pid/jira', async (ctx) => {
    const { project, access } = requireProject(ctx, ctx.params.pid);
    const app = await loadApp(project.id);
    const conn = await loadConn(project.id);
    return {
      configured: Boolean(app),
      mapping: getMapping(project.id),
      connected: Boolean(conn),
      site: conn ? { name: conn.site.name, url: conn.site.url } : null,
      sites: conn ? conn.sites.map((x) => ({ cloudId: x.cloudId, name: x.name, url: x.url })) : [],
      account: conn ? { name: conn.displayName, email: access === 'viewer' ? '' : conn.email } : null,
      canConnect: access === 'owner',
    };
  });

  put('/api/projects/:pid/jira', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'owner');
    const body = await ctx.json();
    const projectKey = str(body.projectKey, 'Jira project key', { max: 20 }).trim().toUpperCase();
    if (!PROJECT_KEY_RE.test(projectKey)) throw badRequest('A Jira project key is capital letters and digits, like RLP');
    const jql = str(body.jql, 'Extra JQL', { max: 500, optional: true }).trim();
    if (/order\s+by/i.test(jql)) throw badRequest('Leave ORDER BY out of the extra JQL; the list is always newest first.');
    exec(
      'INSERT INTO project_jira (project_id, project_key, jql, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET project_key = excluded.project_key, jql = excluded.jql, updated_at = excluded.updated_at',
      project.id,
      projectKey,
      jql,
      now(),
    );
    return { mapping: { projectKey, jql } };
  });

  del('/api/projects/:pid/jira', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'owner');
    exec('DELETE FROM project_jira WHERE project_id = ?', project.id);
    return { ok: true };
  });

  // ---- Tickets ----
  get('/api/projects/:pid/jira/statuses', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const m = mustMapping(project.id);
    const data = await jira(project.id, `/project/${encodeURIComponent(m.projectKey)}/statuses`);
    const names = new Set<string>();
    for (const t of data as any[]) for (const s of t.statuses ?? []) names.add(s.name);
    return { statuses: [...names].sort((a, b) => a.localeCompare(b)) };
  });

  get('/api/projects/:pid/jira/issues', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const m = mustMapping(project.id);
    const jql = buildJql(m, { scope: ctx.query.get('scope') ?? 'mine', status: ctx.query.get('status') ?? '', q: ctx.query.get('q') ?? '' });
    const next = ctx.query.get('next');
    const qs = new URLSearchParams({ jql, fields: LIST_FIELDS, maxResults: '25' });
    if (next) qs.set('nextPageToken', next);
    const data = await jira(project.id, `/search/jql?${qs}`);
    const c = await connection(project.id);
    return { issues: (data.issues ?? []).map(issueRow), next: data.isLast === false || data.nextPageToken ? (data.nextPageToken ?? null) : null, siteUrl: c.site.url, jql };
  });

  get('/api/projects/:pid/jira/issues/:key', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return { issue: await issueDetail(project.id, mustMapping(project.id), ctx.params.key) };
  });

  get('/api/projects/:pid/jira/issues/:key/runs', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const key = checkKey(mustMapping(project.id), ctx.params.key);
    const rows = all<Row>('SELECT id, title, status, created_at, finished_at, cost_usd, meta FROM runs WHERE project_id = ? AND meta LIKE ? ORDER BY created_at DESC LIMIT 20', project.id, `%"jiraKey":"${key}"%`);
    return { runs: rows.map((r) => ({ id: r.id, title: r.title, status: r.status, created_at: r.created_at, finished_at: r.finished_at, cost_usd: r.cost_usd, comment: parseJson<any>(r.meta, {}).jiraComment ?? null })) };
  });

  // Start an analysis run for one ticket against one repository.
  post('/api/projects/:pid/jira/issues/:key/analyze', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const mapping = mustMapping(project.id);
    const body = await ctx.json();
    const repo = getRepo(String(body.repoId ?? ''));
    if (repo.project_id !== project.id) throw badRequest('That repository belongs to another project');
    const ticket = await issueDetail(project.id, mapping, ctx.params.key);
    await ensureFresh(repo);
    const notes = str(body.notes, 'Notes', { max: 2000, optional: true });
    const model = cleanModel(body.model);
    const { run } = await startRun({
      projectId: project.id,
      userId: ctx.user!.id,
      kind: 'chat',
      title: `Analyze ${ticket.key}: ${ticket.summary}`.slice(0, 200),
      prompt: composeAnalysisPrompt(getRepo(repo.id), ticketMarkdown(ticket), ticket.key, notes),
      permissionMode: 'acceptEdits', // the agent can only write inside its own run folder
      model,
      meta: { jiraKey: ticket.key, jiraUrl: ticket.url, jiraSummary: ticket.summary, repoName: repo.name },
    });
    return { run };
  });

  // Post a finished run's analysis to the ticket as a comment. Only ever called from a button.
  post('/api/runs/:id/jira-comment', async (ctx) => {
    const r = getRun(ctx.params.id);
    const { project } = requireProject(ctx, r.project_id, 'editor');
    const meta = parseJson<any>(r.meta, {});
    if (!meta.jiraKey) throw badRequest('This run was not started from a Jira ticket');
    if (r.status !== 'completed') throw badRequest('Wait for the run to finish before posting it to Jira');
    const body = await ctx.json().catch(() => ({}));
    if (meta.jiraComment && !body?.again) throw new HttpError(409, 'This analysis was already posted to Jira. Post it again?');
    const mapping = mustMapping(project.id);
    checkKey(mapping, meta.jiraKey);
    // Prefer the full analysis file the agent wrote; fall back to its final answer.
    let text = String(r.result ?? '');
    const file = path.join(projectDir(getProject(project.id)), meta.workDir ?? '', 'analysis.md');
    try {
      if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
    } catch {
      /* the final answer is enough */
    }
    text = text.trim();
    if (!text) throw badRequest('The run has no analysis to post');
    const header = `**Analysis from Agent Portal** (run ${r.id}, requested by ${ctx.user!.name})\n\n`;
    const footer = '\n\n---\n_Generated by an AI agent from the ticket and the repository. Review before acting on it._';
    const posted = await jira(project.id, `/issue/${meta.jiraKey}/comment`, { method: 'POST', body: { body: adfComment(header + clip(text, 28_000) + footer) } });
    const c = await connection(project.id);
    const comment = { id: posted.id, url: `${c.site.url}/browse/${meta.jiraKey}?focusedCommentId=${posted.id}`, at: now(), by: ctx.user!.name };
    exec('UPDATE runs SET meta = ? WHERE id = ?', JSON.stringify({ ...meta, jiraComment: comment }), r.id);
    return { comment };
  });
}
