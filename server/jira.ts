/**
 * Jira integration — OAuth 2.0 3LO and API-token auth.
 *
 *  - Per portal project: a project owner configures either an Atlassian OAuth app
 *    (3LO flow) or API-token credentials (email + API token + site URL).
 *  - Each project maps to zero or more Jira project keys (empty = all visible).
 *  - Ticket text comes from Jira and is untrusted: always passed to agents as fenced data.
 *
 * Auth types:
 *   oauth     — Atlassian 3LO; requires an Atlassian developer app with client ID/secret.
 *   api_token — Atlassian email + API token + site URL; Basic auth; no OAuth app needed.
 */
import { publicBaseUrl } from './public-url.ts';
import { getSetting, setSetting } from './settings.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, one, run as exec, getDb } from './db.ts';
import type { Row } from './db.ts';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { config } from './config.ts';
import { deleteSecret, getSecret, setSecret } from './secrets.ts';
import { HttpError, badRequest, now, parseJson, str, withLock } from './util.ts';import { adfComment, adfToMarkdown } from './jira-adf.ts';
import {
  KEY_RE,
  buildJql,
  clip,
  ticketMarkdown,
  type Mapping,
  type TicketDetail,
} from './jira-text.ts';

import { getMemberRow, getProjectRow } from './project-access.ts';
// ── Environment overrides (for tests) ────────────────────────────────────────
const AUTH_BASE = (): string => process.env.JIRA_AUTH_URL || 'https://auth.atlassian.com';
const API_BASE = (): string => process.env.JIRA_API_URL || 'https://api.atlassian.com';

const SCOPES = 'read:jira-work write:jira-work read:jira-user offline_access';
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}$/;

const projectSecretKey = (projectId: string) => `jira.project.${projectId}`;
const appSecretKey = (projectId: string) => `jira.app.${projectId}`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface JiraApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface Site {
  cloudId: string;
  url: string;
  name: string;
}

/** Common fields for both auth types. */
interface ConnBase {
  site: Site;
  sites: Site[];
  accountId: string;
  displayName: string;
  email: string;
}

interface OAuthConn extends ConnBase {
  authType: 'oauth';
  access: string;
  refresh: string;
  expiresAt: number;
}

interface ApiTokenConn extends ConnBase {
  authType: 'api_token';
  apiEmail: string;
  apiToken: string;
}

type Conn = OAuthConn | ApiTokenConn;

// ── Secret helpers ────────────────────────────────────────────────────────────

async function loadApp(projectId: string): Promise<JiraApp | null> {
  const raw = await getSecret(appSecretKey(projectId));
  const v = raw ? parseJson<Partial<JiraApp> | null>(raw, null) : null;
  return v?.clientId && v.clientSecret
    ? { clientId: v.clientId, clientSecret: v.clientSecret, redirectUri: v.redirectUri ?? '' }
    : null;
}

/** Whether the project has a Jira connection (sign-in done). Used to tell a generated workflow whether {{jira.ticket}} works. */
export async function jiraConnected(projectId: string): Promise<boolean> {
  try { return Boolean(await loadConn(projectId)); } catch { return false; }
}

async function loadConn(projectId: string): Promise<Conn | null> {
  const raw = await getSecret(projectSecretKey(projectId));
  return raw ? parseJson<Conn | null>(raw, null) : null;
}

// ── Project-list in-memory cache ──────────────────────────────────────────────

const PROJECT_LIST_TTL_MS = 5 * 60 * 1000;
const PROJECT_LIST_CAP = 2_000;

interface ProjectListEntry {
  key: string;
  name: string;
  avatarUrl: string;
  type: string;
}

interface ProjectListCacheEntry {
  projects: ProjectListEntry[];
  total: number;
  truncated: boolean;
  cachedAt: number;
}

/** Cache keyed by portalProjectId → (jiraQuery → entry). */
const projectListCache = new Map<string, Map<string, ProjectListCacheEntry>>();

function invalidateProjectListCache(projectId: string): void {
  projectListCache.delete(projectId);
}

// ─────────────────────────────────────────────────────────────────────────────

const saveConn = (projectId: string, c: Conn): Promise<void> => {
  invalidateProjectListCache(projectId);
  return setSecret(projectSecretKey(projectId), JSON.stringify(c));
};

/** Drop the Jira connection for a project (tokens only; app config is kept). */
export const dropJiraConnection = async (projectId: string): Promise<void> => {
  invalidateProjectListCache(projectId);
  await deleteSecret(projectSecretKey(projectId));
};

/** Drop everything Jira-related for a project (connection + app config). */
export async function dropJira(projectId: string): Promise<void> {
  invalidateProjectListCache(projectId);
  await deleteSecret(projectSecretKey(projectId));
  await deleteSecret(appSecretKey(projectId));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function jiraHttpError(status: number, data: unknown): HttpError {
  const msg = (
    (data as any)?.errorMessages?.[0] ??
    (data as any)?.message ??
    (data as any)?.error_description ??
    (data as any)?.error ??
    ''
  )
    .toString()
    .slice(0, 300);
  if (status === 429) return new HttpError(429, 'Jira is limiting requests. Wait a moment and try again.');
  if (status === 401)
    return new HttpError(401, "This project's Jira connection is not valid any more. A project owner needs to connect Jira again.");
  if (status === 403)
    return new HttpError(403, `Jira says the connected account does not have permission${msg ? `: ${msg}` : ''}`);
  if (status === 404)
    return new HttpError(404, `Not found in Jira${msg ? `: ${msg}` : ''}`);
  return new HttpError(502, `Jira returned ${status}${msg ? `: ${msg}` : ''}`);
}

async function jfetch(url: string, init: RequestInit = {}): Promise<{ status: number; data: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(25_000) });
  } catch (e: any) {
    throw new HttpError(
      502,
      `Could not reach Jira (${e?.name === 'TimeoutError' ? 'timed out' : (e?.cause?.code ?? e?.message ?? e)})`,
    );
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

// ── OAuth helpers ─────────────────────────────────────────────────────────────

async function tokenCall(body: Record<string, string>): Promise<{ access: string; refresh: string; expiresAt: number }> {
  const { status, data } = await jfetch(`${AUTH_BASE()}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (status >= 400 || !(data as any)?.access_token) {
    const why = (
      (data as any)?.error_description ??
      (data as any)?.error ??
      (data as any)?.message ??
      `status ${status}`
    )
      .toString()
      .slice(0, 200);
    throw new HttpError(status === 429 ? 429 : 400, `Atlassian refused the sign-in: ${why}`);
  }
  return {
    access: (data as any).access_token,
    refresh: (data as any).refresh_token ?? '',
    expiresAt: Date.now() + (Number((data as any).expires_in) || 3600) * 1000,
  };
}

/** Return a valid OAuth connection, refreshing the access token if it is about to expire. */
async function oauthConnection(projectId: string, conn: OAuthConn): Promise<OAuthConn> {
  if (conn.expiresAt - Date.now() > 60_000) return conn;
  return withLock(`jira:${projectId}`, async () => {
    const fresh = (await loadConn(projectId)) as OAuthConn | null;
    if (fresh?.authType === 'oauth' && fresh.expiresAt - Date.now() > 60_000) return fresh;
    const c = fresh?.authType === 'oauth' ? fresh : conn;
    if (!c.refresh) {
      await dropJiraConnection(projectId);
      throw new HttpError(401, "This project's Jira connection expired. A project owner needs to connect Jira again.");
    }
    const app = await loadApp(projectId);
    if (!app) {
      await dropJiraConnection(projectId);
      throw new HttpError(401, "This project's Jira connection expired. A project owner needs to connect Jira again.");
    }
    try {
      const t = await tokenCall({
        grant_type: 'refresh_token',
        client_id: app.clientId,
        client_secret: app.clientSecret,
        refresh_token: c.refresh,
      });
      const next: OAuthConn = {
        ...c,
        access: t.access,
        refresh: t.refresh || c.refresh,
        expiresAt: t.expiresAt,
      };
      await saveConn(projectId, next);
      return next;
    } catch {
      await dropJiraConnection(projectId);
      throw new HttpError(401, "This project's Jira connection expired. A project owner needs to connect Jira again.");
    }
  });
}

/** Get the current connection for a project, or throw 409 if not connected. */
async function connection(projectId: string): Promise<Conn> {
  const first = await loadConn(projectId);
  if (!first) throw new HttpError(409, 'This project is not connected to Jira yet. A project owner can connect it on the Tickets page.');
  if (first.authType === 'oauth') return oauthConnection(projectId, first);
  return first;
}

// ── Jira API call ─────────────────────────────────────────────────────────────

async function jira(projectId: string, apiPath: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const c = await connection(projectId);

  let url: string;
  let authHeader: string;

  if (c.authType === 'api_token') {
    url = `${c.site.url}/rest/api/3${apiPath}`;
    authHeader = 'Basic ' + Buffer.from(`${c.apiEmail}:${c.apiToken}`).toString('base64');
  } else {
    url = `${API_BASE()}/ex/jira/${c.site.cloudId}/rest/api/3${apiPath}`;
    authHeader = `Bearer ${c.access}`;
  }

  const { status, data } = await jfetch(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: authHeader,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (status >= 400) throw jiraHttpError(status, data);
  return data;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

const mappingKey = (projectId: string): string => `jira.mapping.${projectId}`;

function getMapping(projectId: string): Mapping | null {
  // Stored in the settings store (persistent on DynamoDB). Older local installs keep it in project_jira.
  const raw = getSetting(getDb(), mappingKey(projectId));
  if (raw) {
    try {
      const m = JSON.parse(raw) as { projectKeys?: string[]; jql?: string };
      return { projectKeys: Array.isArray(m.projectKeys) ? m.projectKeys : [], jql: m.jql ?? '' };
    } catch { /* fall through to the old table */ }
  }
  const r = one<Row>('SELECT project_keys, jql FROM project_jira WHERE project_id = ?', projectId);
  if (!r) return null;
  return {
    projectKeys: parseJson<string[]>(r.project_keys as string, []),
    jql: (r.jql as string) ?? '',
  };
}

export function mustMapping(projectId: string): Mapping {
  const m = getMapping(projectId);
  // No row yet → treat as "all projects" (empty projectKeys, no extra JQL)
  return m ?? { projectKeys: [], jql: '' };
}

/**
 * Validate that `key` is a valid Jira ticket key and (if the mapping has a list)
 * that it belongs to one of the allowed Jira projects.
 */
export function checkKey(mapping: Mapping, key: string): string {
  if (!KEY_RE.test(key)) throw badRequest('That is not a Jira ticket key (like ABC-123)');
  if (mapping.projectKeys.length > 0) {
    const keyProject = key.slice(0, key.lastIndexOf('-'));
    if (!mapping.projectKeys.includes(keyProject))
      throw badRequest(`${key} is not in any of the linked Jira projects (${mapping.projectKeys.join(', ')})`);
  }
  return key;
}

// ── Issue helpers ─────────────────────────────────────────────────────────────

const LIST_FIELDS = 'summary,status,assignee,priority,updated,issuetype,labels';

function issueRow(i: unknown) {
  const f = (i as any).fields ?? {};
  return {
    key: (i as any).key as string,
    summary: (f.summary ?? '') as string,
    status: { name: f.status?.name ?? '', category: f.status?.statusCategory?.key ?? '' },
    statusCategory: (f.status?.statusCategory?.key ?? '') as string,
    assignee: (f.assignee?.displayName ?? null) as string | null,
    priority: (f.priority?.name ?? null) as string | null,
    type: (f.issuetype?.name ?? null) as string | null,
    updated: (f.updated ?? '') as string,
    url: '',
  };
}

export async function issueDetail(projectId: string, mapping: Mapping, key: string): Promise<TicketDetail> {
  checkKey(mapping, key);
  const c = await connection(projectId);
  const i = await jira(
    projectId,
    `/issue/${key}?fields=summary,description,status,assignee,reporter,priority,labels,issuetype,created,updated,comment,attachment,issuelinks,parent,subtasks,components,fixVersions`,
  );
  const f = (i as any).fields ?? {};

  const siteUrl = c.authType === 'api_token' ? c.site.url : c.site.url;

  return {
    key: (i as any).key as string,
    url: `${siteUrl}/browse/${(i as any).key}`,
    summary: (f.summary ?? '') as string,
    type: f.issuetype?.name ?? null,
    status: { name: f.status?.name ?? '', category: f.status?.statusCategory?.key ?? '' },
    priority: f.priority?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    labels: (f.labels ?? []) as string[],
    components: ((f.components ?? []) as any[]).map((x) => x.name),
    fixVersions: ((f.fixVersions ?? []) as any[]).map((x) => x.name),
    created: f.created ?? '',
    updated: f.updated ?? '',
    description: adfToMarkdown(f.description),
    descriptionMarkdown: adfToMarkdown(f.description),
    comments: ((f.comment?.comments ?? []) as any[]).map((cm) => ({
      author: cm.author?.displayName ?? 'Unknown',
      created: cm.created ?? '',
      body: adfToMarkdown(cm.body),
      bodyMarkdown: adfToMarkdown(cm.body),
    })),
    attachments: ((f.attachment ?? []) as any[]).map((a) => ({
      id: a.id ? String(a.id) : undefined,
      filename: a.filename,
      size: a.size,
      mimeType: a.mimeType,
    })),
    links: ((f.issuelinks ?? []) as any[]).map((l) => {
      const other = l.outwardIssue ?? l.inwardIssue;
      return {
        relation: l.outwardIssue ? l.type?.outward : l.type?.inward,
        key: other?.key,
        summary: other?.fields?.summary ?? '',
        status: other?.fields?.status?.name ?? '',
      };
    }),
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary ?? '' } : null,
    subtasks: ((f.subtasks ?? []) as any[]).map((s) => ({
      key: s.key,
      summary: s.fields?.summary ?? '',
      status: s.fields?.status?.name ?? '',
    })),
  };
}

// ── Attachments ───────────────────────────────────────────────────────────────

export const ATTACHMENT_LIMITS = {
  maxFiles: 30,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
};

function projectDir(projectSlug: string): string {
  return path.join(config.dataDir, 'projects', projectSlug);
}

async function getProjectSlug(projectId: string): Promise<string> {
  // S1-TODO(projects): This should use getProjectRepository().getProjectBySlug() or
  // getProjectById() once the jira module is converted to async. Leave on direct SQLite.
  const r = await getProjectRow(projectId);
  if (!r) throw badRequest('Project not found');
  return r.slug as string;
}

export async function attachmentDir(projectId: string, key: string): Promise<string> {
  return path.join(projectDir(await getProjectSlug(projectId)), 'work', 'jira-attachments', key);
}

function attachmentFileName(id: string, filename: string): string {
  const clean = path
    .basename(String(filename || 'file'))
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'file';
  return `${id}-${clean}`;
}

export async function downloadAttachments(projectId: string, t: TicketDetail, workDir?: string): Promise<TicketDetail> {
  if (!t.attachments.length) return t;
  const dir = workDir
    ? path.join(workDir, 'jira-attachments', t.key)
    : await attachmentDir(projectId, t.key);
  const c = await connection(projectId);

  let authHeader: string;
  let attachmentBaseUrl: string;
  if (c.authType === 'api_token') {
    authHeader = 'Basic ' + Buffer.from(`${c.apiEmail}:${c.apiToken}`).toString('base64');
    attachmentBaseUrl = `${c.site.url}/rest/api/3/attachment/content`;
  } else {
    authHeader = `Bearer ${c.access}`;
    attachmentBaseUrl = `${API_BASE()}/ex/jira/${c.site.cloudId}/rest/api/3/attachment/content`;
  }

  let total = 0;
  const out: TicketDetail['attachments'] = [];

  for (const [i, a] of t.attachments.entries()) {
    if (!a.id || !/^\d+$/.test(a.id)) {
      out.push({ ...a, skipped: 'no attachment id' });
      continue;
    }
    if (i >= ATTACHMENT_LIMITS.maxFiles) {
      out.push({ ...a, skipped: `more than ${ATTACHMENT_LIMITS.maxFiles} attachments` });
      continue;
    }
    if (a.size > ATTACHMENT_LIMITS.maxFileBytes) {
      out.push({ ...a, skipped: `larger than ${ATTACHMENT_LIMITS.maxFileBytes / 1048576} MB` });
      continue;
    }
    if (total + a.size > ATTACHMENT_LIMITS.maxTotalBytes) {
      out.push({ ...a, skipped: `the attachments together are over ${ATTACHMENT_LIMITS.maxTotalBytes / 1048576} MB` });
      continue;
    }
    const file = path.join(dir, attachmentFileName(a.id, a.filename));
    try {
      if (!(fs.existsSync(file) && fs.statSync(file).size === a.size)) {
        const res = await fetch(`${attachmentBaseUrl}/${a.id}`, {
          headers: { authorization: authHeader, accept: '*/*' },
          redirect: 'follow',
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`Jira returned ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > ATTACHMENT_LIMITS.maxFileBytes) throw new Error('larger than allowed');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, buf);
      }
      total += fs.statSync(file).size;
      out.push({ ...a, path: file });
    } catch (e: any) {
      out.push({ ...a, skipped: String(e?.message ?? e).slice(0, 120) });
    }
  }
  return { ...t, attachments: out };
}

/**
 * One attachment of a ticket, with the project's own Jira connection. Only ids that belong to the ticket are fetched
 * (the ticket's attachment list is read first), so this cannot be used to read other Jira content. Returns null when
 * the ticket has no such attachment.
 */
export async function fetchTicketAttachment(
  projectId: string, mapping: Mapping, key: string, attachmentId: string, maxBytes = ATTACHMENT_LIMITS.maxFileBytes,
): Promise<{ filename: string; mimeType: string; size: number; data: Buffer } | null> {
  if (!/^\d+$/.test(attachmentId)) return null;
  const ticket = await issueDetail(projectId, mapping, key);
  const meta = ticket.attachments.find((a) => a.id === attachmentId);
  if (!meta) return null;
  if (meta.size > maxBytes) throw new HttpError(413, `This attachment is larger than ${Math.round(maxBytes / 1048576)} MB`);
  const c = await connection(projectId);
  const auth = c.authType === 'api_token' ? 'Basic ' + Buffer.from(`${c.apiEmail}:${c.apiToken}`).toString('base64') : `Bearer ${c.access}`;
  const base = c.authType === 'api_token' ? `${c.site.url}/rest/api/3/attachment/content` : `${API_BASE()}/ex/jira/${c.site.cloudId}/rest/api/3/attachment/content`;
  const res = await fetch(`${base}/${attachmentId}`, { headers: { authorization: auth, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new HttpError(502, `Jira returned ${res.status} for this attachment`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new HttpError(413, 'This attachment is larger than allowed');
  return { filename: meta.filename, mimeType: meta.mimeType, size: data.length, data };
}

// ── Access helpers ────────────────────────────────────────────────────────────

function requireAuth(req: PortalRequest, res: PortalResponse): boolean {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  return true;
}

async function requireProjectAccess(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): Promise<Row | null> {
  if (!requireAuth(req, res)) return null;
  // S1-TODO(projects): requireProjectAccess is a sync helper called from sync route handlers
  // in jira.ts. Converting all callers to async would require reworking the OAuth callback
  // flow. Leave on direct SQLite until jira module is converted.
  const p = await getProjectRow(projectId);
  if (!p) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user!.is_admin) return p;
  const m = await getMemberRow(projectId, req.user!.id);
  if (!m) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  return p;
}

async function requireOwnerAccess(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): Promise<Row | null> {
  if (!requireAuth(req, res)) return null;
  // S1-TODO(projects): requireOwnerAccess is a sync helper. Leave on direct SQLite
  // until jira module is converted to async.
  const p = await getProjectRow(projectId);
  if (!p) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user!.is_admin) return p;
  const m = await getMemberRow(projectId, req.user!.id);
  if (!m) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (m.access !== 'owner') {
    sendJson(res, 403, { error: 'Project owner access required' });
    return null;
  }
  return p;
}

async function isOwner(req: PortalRequest, projectId: string): Promise<boolean> {
  if (!req.user) return false;
  if (req.user.is_admin) return true;
  // S1-TODO(projects): isOwner is a sync helper. Leave on direct SQLite
  // until jira module is converted to async.
  const m = await getMemberRow(projectId, req.user.id);
  return m?.access === 'owner';
}

// ── OAuth state map ───────────────────────────────────────────────────────────

interface OAuthState { userId: string; projectId: string; returnTo: string; exp: number }

// The OAuth `state` is a signed value (not an in-memory map) so the callback can be handled by any Lambda instance.
function stateKey(): Buffer {
  return crypto.createHmac('sha256', config.secretKey).update('jira-oauth-state-v1').digest();
}
function makeState(payload: OAuthState): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
// Best-effort single use: a state already seen by this instance is refused. (Another instance cannot know,
// but the authorization code Atlassian issues for it is single-use as well.)
const usedStates = new Map<string, number>();
function readState(state: string): OAuthState | null {
  for (const [k, exp] of usedStates) if (exp < Date.now()) usedStates.delete(k);
  if (usedStates.has(state)) return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthState;
    usedStates.set(state, parsed.exp);
    return parsed;
  } catch { return null; }
}

function safeReturn(v: string | null): string {
  return v && /^#\/[A-Za-z0-9_\/.-]{0,120}$/.test(v) ? v : '';
}

function defaultRedirect(req: PortalRequest): string {
  return `${publicBaseUrl(req)}/api/jira/callback`;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerJiraRoutes(): void {

  // ---- GET /api/projects/:pid/jira — status overview ----
  router.get('/api/projects/:pid/jira', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireProjectAccess(req, res, req.params.pid);
    if (!p) return;
    const projectId = String(p.id);

    const app = await loadApp(projectId);
    const conn = await loadConn(projectId);
    const mapping = getMapping(projectId);
    const canManage = await isOwner(req, projectId);

    const siteOut = conn ? { id: conn.site.cloudId, name: conn.site.name, url: conn.site.url } : null;
    const sitesOut = conn?.authType === 'oauth'
      ? conn.sites.map((x) => ({ id: x.cloudId, name: x.name, url: x.url }))
      : [];

    sendJson(res, 200, {
      connected: Boolean(conn),
      authType: conn?.authType ?? null,
      site: siteOut,
      sites: sitesOut,
      app: { configured: Boolean(app), clientId: app?.clientId ?? null },
      account: conn ? { name: conn.displayName, email: conn.email } : null,
      mapping: mapping ?? { projectKeys: [], jql: '' },
      canManage,
    });
  });

  // ---- GET /api/projects/:pid/jira/app — OAuth app details (owner only) ----
  router.get('/api/projects/:pid/jira/app', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireOwnerAccess(req, res, req.params.pid);
    if (!p) return;
    const app = await loadApp(String(p.id));
    sendJson(res, 200, {
      clientId: app?.clientId ?? '',
      secretSet: Boolean(app),
      redirectUri: app?.redirectUri || defaultRedirect(req),
      scopes: SCOPES.split(' '),
    });
  });

  // ---- PUT /api/projects/:pid/jira/app — save OAuth app ----
  router.put('/api/projects/:pid/jira/app', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireOwnerAccess(req, res, req.params.pid);
    if (!p) return;
    const projectId = String(p.id);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const clientId = str(body.clientId as string, 'Client ID', { max: 100 }).trim();
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(clientId))
      throw badRequest('The client ID looks wrong. Copy it from the Atlassian developer console.');

    let redirectUri = str(body.redirectUri as string ?? '', 'Callback URL', { max: 300, optional: true }).trim() || defaultRedirect(req);
    try {
      const u = new URL(redirectUri);
      if (!/^https?:$/.test(u.protocol)) throw new Error('scheme');
      redirectUri = u.toString();
    } catch {
      throw badRequest('The callback URL must be a full http(s) address, like http://localhost:8787/api/jira/callback');
    }

    const before = await loadApp(projectId);
    const clientSecret =
      typeof body.clientSecret === 'string' && body.clientSecret.trim()
        ? body.clientSecret.trim()
        : before?.clientSecret;
    if (!clientSecret) throw badRequest('Enter the client secret from the Atlassian developer console.');

    await setSecret(appSecretKey(projectId), JSON.stringify({ clientId, clientSecret, redirectUri }));
    if (before && before.clientId !== clientId) dropJiraConnection(projectId);
    sendJson(res, 200, { ok: true });
  });

  // ---- DELETE /api/projects/:pid/jira/app — remove app + connection ----
  router.delete('/api/projects/:pid/jira/app', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireOwnerAccess(req, res, req.params.pid);
    if (!p) return;
    dropJira(String(p.id));
    sendJson(res, 200, { ok: true });
  });

  // ---- GET /api/projects/:pid/jira/connect — begin OAuth flow (redirect) ----
  router.get('/api/projects/:pid/jira/connect', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireOwnerAccess(req, res, req.params.pid);
    if (!p) return;
    const projectId = String(p.id);

    const app = await loadApp(projectId);
    if (!app) {
      sendJson(res, 400, { error: 'Jira is not set up for this project yet. A project owner needs to add the project\'s Atlassian app first.' });
      return;
    }

    const state = makeState({
      userId: req.user!.id,
      projectId,
      returnTo: safeReturn(req.query.get('return')) || `#/p/${projectId}/tickets`,
      exp: Date.now() + 10 * 60_000,
    });

    const url = new URL('/authorize', AUTH_BASE());
    url.search = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: app.clientId,
      scope: SCOPES,
      redirect_uri: app.redirectUri || defaultRedirect(req),
      state,
      response_type: 'code',
      prompt: 'consent',
    }).toString();

    res.writeHead(302, { Location: url.toString(), 'Cache-Control': 'no-store' });
    res.end();
  });

  // ---- POST /api/projects/:pid/jira/connect — begin OAuth flow (JSON, returns { url }) ----
  router.post('/api/projects/:pid/jira/connect', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireOwnerAccess(req, res, req.params.pid);
    if (!p) return;
    const projectId = String(p.id);

    const app = await loadApp(projectId);
    if (!app) {
      sendJson(res, 400, { error: 'Jira is not set up for this project yet. A project owner needs to add the project\'s Atlassian app first.' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const state = makeState({
      userId: req.user!.id,
      projectId,
      returnTo: safeReturn(typeof body.return === 'string' ? body.return : '') || `#/p/${projectId}/tickets`,
      exp: Date.now() + 10 * 60_000,
    });

    const url = new URL('/authorize', AUTH_BASE());
    url.search = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: app.clientId,
      scope: SCOPES,
      redirect_uri: app.redirectUri || defaultRedirect(req),
      state,
      response_type: 'code',
      prompt: 'consent',
    }).toString();

    sendJson(res, 200, { url: url.toString() });
  });

  // ---- GET /api/jira/callback — OAuth callback ----
  router.get('/api/jira/callback', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const back = (flag: string, reason = '', returnTo = '') => {
      const r = returnTo || '#/projects';
      const u = `/?jira=${flag}${reason ? `&reason=${encodeURIComponent(reason.slice(0, 140))}` : ''}${r}`;
      res.writeHead(302, { Location: u, 'Cache-Control': 'no-store' });
      res.end();
    };

    const s = readState(req.query.get('state') ?? '');

    if (!s || s.exp < Date.now() || !req.user || s.userId !== req.user.id) {
      back('error', 'The sign-in link expired. Click Connect Jira again.');
      return;
    }

    const denied = req.query.get('error');
    if (denied) {
      back('error', req.query.get('error_description') || denied, s.returnTo);
      return;
    }

    const code = req.query.get('code');
    if (!code) {
      back('error', 'Atlassian did not send a sign-in code.', s.returnTo);
      return;
    }

    const projectMember = await getMemberRow(s.projectId, req.user.id);
    if (!req.user.is_admin && (!projectMember || projectMember.access !== 'owner')) {
      back('error', 'You are no longer a project owner.', s.returnTo);
      return;
    }

    const app = await loadApp(s.projectId);
    if (!app) {
      back('error', 'The Atlassian app was removed while signing in.', s.returnTo);
      return;
    }

    let saved = false;
    try {
      const t = await tokenCall({
        grant_type: 'authorization_code',
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
        redirect_uri: app.redirectUri || defaultRedirect(req),
      });

      const probe = await jfetch(`${API_BASE()}/oauth/token/accessible-resources`, {
        headers: { authorization: `Bearer ${t.access}`, accept: 'application/json' },
      });
      if (probe.status >= 400) throw jiraHttpError(probe.status, probe.data);

      const sites: Site[] = ((probe.data as any[]) ?? []).map((r) => ({
        cloudId: r.id,
        url: String(r.url).replace(/\/$/, ''),
        name: r.name,
      }));
      if (!sites.length) throw badRequest('That Atlassian account has no Jira site that this app can use.');

      const conn: OAuthConn = {
        authType: 'oauth',
        access: t.access,
        refresh: t.refresh,
        expiresAt: t.expiresAt,
        site: sites[0],
        sites,
        accountId: '',
        displayName: '',
        email: '',
      };
      await saveConn(s.projectId, conn);
      saved = true;

      const me = await jira(s.projectId, '/myself');
      await saveConn(s.projectId, {
        ...conn,
        accountId: (me as any).accountId ?? '',
        displayName: (me as any).displayName ?? '',
        email: (me as any).emailAddress ?? '',
      });

      back('connected', '', s.returnTo);
    } catch (e: any) {
      if (saved) dropJiraConnection(s.projectId);
      back('error', e?.message ?? 'Could not finish connecting to Jira.', s.returnTo);
    }
  });

  // ---- POST /api/projects/:pid/jira/token — API-token auth ----
  router.post('/api/projects/:pid/jira/token', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireOwnerAccess(req, res, req.params.pid);
    if (!p) return;
    const projectId = String(p.id);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const siteUrl = str(body.siteUrl as string, 'Site URL', { max: 300 }).trim().replace(/\/$/, '');
    const email = str(body.email as string, 'Email', { max: 300 }).trim();
    const apiToken = str(body.apiToken as string, 'API token', { max: 500 }).trim();

    try { new URL(siteUrl); } catch { throw badRequest('Site URL must be a valid https URL like https://acme.atlassian.net'); }

    // Validate credentials by calling /myself
    const authHeader = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
    const { status, data } = await jfetch(`${siteUrl}/rest/api/3/myself`, {
      headers: { authorization: authHeader, accept: 'application/json' },
    });
    if (status >= 400) {
      const msg =
        status === 401
          ? 'Invalid email or API token.'
          : `Jira returned ${status}: ${((data as any)?.message ?? '').toString().slice(0, 200)}`;
      sendJson(res, status >= 500 ? 502 : 400, { error: msg });
      return;
    }

    const me = data as any;
    const site: Site = { cloudId: '', url: siteUrl, name: new URL(siteUrl).hostname };

    const conn: ApiTokenConn = {
      authType: 'api_token',
      apiEmail: email,
      apiToken,
      site,
      sites: [site],
      accountId: me.accountId ?? '',
      displayName: me.displayName ?? '',
      email: me.emailAddress ?? email,
    };
    await saveConn(projectId, conn);

    const app = await loadApp(projectId);
    const mapping = getMapping(projectId);
    sendJson(res, 200, {
      connected: true,
      authType: 'api_token',
      site: { id: site.cloudId, name: site.name, url: site.url },
      sites: [],
      app: { configured: Boolean(app), clientId: app?.clientId ?? null },
      account: { name: conn.displayName, email: conn.email },
      mapping: mapping ?? { projectKeys: [], jql: '' },
      canManage: true,
    });
  });

  // ---- PUT /api/projects/:pid/jira/site — switch OAuth site ----
  router.put('/api/projects/:pid/jira/site', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireOwnerAccess(req, res, req.params.pid);
    if (!p) return;
    const projectId = String(p.id);
    const c = await connection(projectId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const site = (c.sites ?? []).find((x) => x.cloudId === body.siteId);
    if (!site) {
      sendJson(res, 400, { error: 'That Jira site is not one this sign-in can reach' });
      return;
    }
    await saveConn(projectId, { ...c, site });
    sendJson(res, 200, { ok: true });
  });

  // ---- DELETE /api/projects/:pid/jira/connection — disconnect ----
  router.delete('/api/projects/:pid/jira/connection', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireOwnerAccess(req, res, req.params.pid);
    if (!p) return;
    dropJiraConnection(String(p.id));
    sendJson(res, 200, { ok: true });
  });

  // ---- GET /api/projects/:pid/jira/projects — list Jira projects ----
  router.get('/api/projects/:pid/jira/projects', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireProjectAccess(req, res, req.params.pid);
    if (!p) return;
    const projectId = String(p.id);

    const q = (req.query.get('q') ?? '').trim();
    const refresh = req.query.get('refresh') === '1';

    if (!refresh) {
      const cached = projectListCache.get(projectId)?.get(q);
      if (cached && Date.now() - cached.cachedAt < PROJECT_LIST_TTL_MS) {
        sendJson(res, 200, { projects: cached.projects, total: cached.total, truncated: cached.truncated });
        return;
      }
    }

    const allProjects: ProjectListEntry[] = [];
    let startAt = 0;
    let truncated = false;
    let jiraTotal = 0;

    for (;;) {
      const qs = new URLSearchParams({ startAt: String(startAt), maxResults: '50', orderBy: 'name' });
      if (q) qs.set('query', q);
      const data = await jira(projectId, `/project/search?${qs}`);
      const items = ((data as any).values ?? []) as any[];
      jiraTotal = (data as any).total ?? (startAt + items.length);

      for (const proj of items) {
        allProjects.push({
          key: proj.key as string,
          name: proj.name as string,
          avatarUrl: (proj.avatarUrls?.['48x48'] ?? '') as string,
          type: (proj.projectTypeKey ?? '') as string,
        });
      }

      startAt += items.length;
      const isLast: boolean = (data as any).isLast ?? (startAt >= jiraTotal);
      if (isLast || items.length === 0) break;
      if (allProjects.length >= PROJECT_LIST_CAP) {
        allProjects.splice(PROJECT_LIST_CAP);
        truncated = true;
        break;
      }
    }

    allProjects.sort((a, b) => a.name.localeCompare(b.name));

    const cacheEntry: ProjectListCacheEntry = { projects: allProjects, total: jiraTotal, truncated, cachedAt: Date.now() };
    if (!projectListCache.has(projectId)) projectListCache.set(projectId, new Map());
    projectListCache.get(projectId)!.set(q, cacheEntry);

    sendJson(res, 200, { projects: allProjects, total: jiraTotal, truncated });
  });

  // ---- PUT /api/projects/:pid/jira — update project-key mapping ----
  router.put('/api/projects/:pid/jira', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireOwnerAccess(req, res, req.params.pid);
    if (!p) return;
    const projectId = String(p.id);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const rawKeys = Array.isArray(body.projectKeys) ? (body.projectKeys as unknown[]).map(String) : [];
    for (const k of rawKeys) {
      if (!PROJECT_KEY_RE.test(k))
        throw badRequest(`"${k}" is not a valid Jira project key (capital letters and digits, like RLP)`);
    }
    const jql = str((body.jql as string) ?? '', 'Extra JQL', { max: 500, optional: true }).trim();
    if (/order\s+by/i.test(jql)) throw badRequest('Leave ORDER BY out of the extra JQL; the list is always newest first.');

    await setSetting(getDb(), mappingKey(projectId), JSON.stringify({ projectKeys: rawKeys, jql }));
    sendJson(res, 200, { mapping: { projectKeys: rawKeys, jql } });
  });

  // ---- DELETE /api/projects/:pid/jira — remove mapping ----
  router.delete('/api/projects/:pid/jira', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireOwnerAccess(req, res, req.params.pid);
    if (!p) return;
    await setSetting(getDb(), mappingKey(String(p.id)), '');
    exec('DELETE FROM project_jira WHERE project_id = ?', String(p.id));
    sendJson(res, 200, { ok: true });
  });

  // ---- GET /api/projects/:pid/jira/statuses?project=KEY ----
  router.get('/api/projects/:pid/jira/statuses', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireProjectAccess(req, res, req.params.pid);
    if (!p) return;
    const projectId = String(p.id);
    const mapping = mustMapping(projectId);

    const project = req.query.get('project') ?? '';

    if (project) {
      // Specific project key requested
      if (!PROJECT_KEY_RE.test(project)) throw badRequest('Invalid project key');
      if (mapping.projectKeys.length > 0 && !mapping.projectKeys.includes(project))
        throw badRequest(`Project ${project} is not in the allowed list`);
      const data = await jira(projectId, `/project/${encodeURIComponent(project)}/statuses`);
      const names = new Set<string>();
      for (const t of (data as any[]) ?? []) for (const s of t.statuses ?? []) names.add(s.name);
      sendJson(res, 200, { statuses: [...names].sort((a, b) => a.localeCompare(b)) });
    } else if (mapping.projectKeys.length === 0) {
      // No allowed list and no project param — cannot enumerate all projects' statuses
      sendJson(res, 200, { statuses: [] });
    } else {
      // Union across allowed projects (cap at 10 to avoid too many round-trips)
      const keysToCheck = mapping.projectKeys.slice(0, 10);
      const names = new Set<string>();
      for (const key of keysToCheck) {
        const data = await jira(projectId, `/project/${encodeURIComponent(key)}/statuses`).catch(() => null);
        if (!data) continue;
        for (const t of (data as any[]) ?? []) for (const s of t.statuses ?? []) names.add(s.name);
      }
      sendJson(res, 200, { statuses: [...names].sort((a, b) => a.localeCompare(b)) });
    }
  });

  // ---- GET /api/projects/:pid/jira/issues?project=KEY&q=&status=&assignee=me|any&page=<token> ----
  router.get('/api/projects/:pid/jira/issues', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireProjectAccess(req, res, req.params.pid);
    if (!p) return;
    const projectId = String(p.id);
    const mapping = mustMapping(projectId);

    const projectParam = req.query.get('project') ?? '';
    // Resolve the list of project keys to filter on
    let projectFilterKeys: string[];
    if (projectParam) {
      if (!PROJECT_KEY_RE.test(projectParam)) throw badRequest('Invalid project key');
      if (mapping.projectKeys.length > 0 && !mapping.projectKeys.includes(projectParam))
        throw badRequest(`Project ${projectParam} is not in the allowed list`);
      projectFilterKeys = [projectParam];
    } else if (mapping.projectKeys.length > 0) {
      // No project param: search across all allowed projects
      projectFilterKeys = mapping.projectKeys;
    } else {
      // No project param, no allowed list: search all visible projects (no project clause)
      projectFilterKeys = [];
    }

    const jql = buildJql(mapping, {
      projectKeys: projectFilterKeys,
      status: req.query.get('status') ?? '',
      q: req.query.get('q') ?? '',
      assignee: req.query.get('assignee') ?? '',
    });

    // Pagination: /rest/api/3/search/jql uses nextPageToken (opaque string), not numeric startAt
    const pageToken = req.query.get('page') ?? '';
    const qs = new URLSearchParams({ jql, fields: LIST_FIELDS, maxResults: '25' });
    if (pageToken) qs.set('nextPageToken', pageToken);

    const data = await jira(projectId, `/search/jql?${qs}`);
    const c = await connection(projectId);
    const siteUrl = c.site.url;

    const issues = ((data as any).issues ?? []).map((i: any) => {
      const row = issueRow(i);
      return { ...row, url: `${siteUrl}/browse/${row.key}` };
    });

    // Return nextPage as the opaque token string (or null when no more pages)
    const nextPage: string | null = (data as any).nextPageToken ?? null;

    sendJson(res, 200, { issues, nextPage });
  });

  // ---- GET /api/projects/:pid/jira/issues/:key ----
  router.get('/api/projects/:pid/jira/issues/:key', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireProjectAccess(req, res, req.params.pid);
    if (!p) return;
    const projectId = String(p.id);
    const ticket = await issueDetail(projectId, mustMapping(projectId), req.params.key);
    sendJson(res, 200, { ticket });
  });

  // ---- GET /api/projects/:pid/jira/issues/:key/attachments/:id — one attachment of the ticket ----
  // Images open inline (so the Tickets tab can show them); every other type is a download. The bytes are never
  // interpreted by the browser as a page (nosniff, a sandboxing policy, and SVG/HTML are always downloads).
  router.get('/api/projects/:pid/jira/issues/:key/attachments/:id', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await requireProjectAccess(req, res, req.params.pid);
    if (!p) return;
    const projectId = String(p.id);
    const found = await fetchTicketAttachment(projectId, mustMapping(projectId), req.params.key, req.params.id);
    if (!found) { sendJson(res, 404, { error: 'This ticket has no such attachment' }); return; }
    const inlineTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    const inline = inlineTypes.has(found.mimeType.toLowerCase());
    const safeName = path.basename(found.filename).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'attachment';
    const raw = res as import('node:http').ServerResponse;
    raw.writeHead(200, {
      'Content-Type': inline ? found.mimeType : 'application/octet-stream',
      'Content-Length': found.data.length,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, max-age=300',
    });
    raw.end(found.data);
  });

  // ---- POST /api/runs/:id/jira-comment — post result back to Jira ----
  router.post('/api/runs/:id/jira-comment', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireAuth(req, res)) return;

    // Find the run in agent_runs (reference model) or p6_runs
    const r = one<Row>(
      'SELECT ar.*, w.project_id FROM agent_runs ar LEFT JOIN workflows w ON w.id = ar.workflow_id WHERE ar.id = ?',
      req.params.id,
    );
    if (!r) {
      sendJson(res, 404, { error: 'Run not found' });
      return;
    }
    const projectId = String(r.project_id ?? '');
    const projectP = await requireProjectAccess(req, res, projectId);
    if (!projectP) return;

    const meta = parseJson<Record<string, unknown>>(r.meta as string, {});
    if (!meta.jiraKey) {
      sendJson(res, 400, { error: 'This run was not started from a Jira ticket' });
      return;
    }
    if (r.status !== 'completed') {
      sendJson(res, 400, { error: 'Wait for the run to finish before posting it to Jira' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (meta.jiraComment && !body?.again) {
      sendJson(res, 409, { error: 'This analysis was already posted to Jira. Post it again?' });
      return;
    }

    const mapping = mustMapping(projectId);
    checkKey(mapping, String(meta.jiraKey));

    let text = String(r.result ?? '');
    const workDir = meta.workDir ? String(meta.workDir) : '';
    if (workDir) {
      const slug = await getProjectSlug(projectId);
      const file = path.join(projectDir(slug), workDir, 'analysis.md');
      try {
        if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
      } catch { /* fall back to result */ }
    }
    text = text.trim();
    if (!text) {
      sendJson(res, 400, { error: 'The run has no analysis to post' });
      return;
    }

    const header = `**Analysis from Agent Portal** (run ${r.id}, requested by ${req.user!.name})\n\n`;
    const footer = '\n\n---\n_Generated by an AI agent from the ticket and the repository. Review before acting on it._';
    const posted = await jira(projectId, `/issue/${meta.jiraKey}/comment`, {
      method: 'POST',
      body: { body: adfComment(header + clip(text, 28_000) + footer) },
    }) as any;

    const c = await connection(projectId);
    const comment = {
      id: posted.id,
      url: `${c.site.url}/browse/${meta.jiraKey}?focusedCommentId=${posted.id}`,
      at: now(),
      by: req.user!.name,
    };
    exec('UPDATE agent_runs SET meta = ? WHERE id = ?', JSON.stringify({ ...meta, jiraComment: comment }), String(r.id));
    sendJson(res, 200, { comment });
  });
}
