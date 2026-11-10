/**
 * Google Workspace for agents: Drive, Docs, Sheets and Slides.
 *
 * Each person connects their own Google account once (Integrations → Connected services). The portal keeps the refresh
 * token encrypted and never gives it to an agent. A session gets a "google" MCP server instead, whose address is this
 * portal (POST /api/mcp/google) and whose only credential is a short-lived signed token naming the person. The portal
 * turns each tool call into a Google API call as that person.
 *
 *   GET    /api/google/status      {available, connected, email, allowWrites}
 *   GET    /api/google/connect     redirects to Google (reuses the sign-in redirect URI, told apart by the state prefix "ws.")
 *   PUT    /api/google/settings    {allowWrites}
 *   DELETE /api/google/connection  forget the refresh token and revoke it at Google
 *   POST   /api/mcp/google         MCP endpoint used by sessions (Bearer gw_<token>)
 *
 * Reading tools are always offered; tools that change files only when the person turned "let agents edit my files" on.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { router, sendJson, requireAuth, parseCookies, setCookie } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getSecret, setSecret, deleteSecret } from './secrets.ts';
import { config } from './config.ts';
import { loadGoogleCredentials, googleRedirectUri } from './google-auth.ts';
import { publicBaseUrl } from './public-url.ts';
import { appendAudit } from './audit.ts';

const WS_COOKIE = 'portal_google_ws';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const WORKSPACE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
];

const TOKEN_TTL_SECONDS = 8 * 3600;
const MAX_TEXT = 60_000;

interface StoredConnection {
  refreshToken: string;
  email: string;
  allowWrites: boolean;
  connectedAt: string;
}

function auditLog(userId: string, action: string, target: string | null): void {
  try { appendAudit(null, userId, action, target, null, null); } catch { /* audit must not break a tool */ }
}

const secretName = (userId: string): string => `google-workspace:${userId}`;

async function loadConnection(userId: string): Promise<StoredConnection | null> {
  const raw = await getSecret(secretName(userId));
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as StoredConnection;
    return c && typeof c.refreshToken === 'string' ? c : null;
  } catch { return null; }
}

async function saveConnection(userId: string, c: StoredConnection): Promise<void> {
  await setSecret(secretName(userId), JSON.stringify(c));
}

// ── Run tokens (what a session holds instead of any Google credential) ──────────

function sign(payload: string): string {
  return createHmac('sha256', config.secretKey).update(`google-workspace:${payload}`).digest('base64url');
}

/** A token for one person, valid for a working day. */
export function issueWorkspaceToken(userId: string, now = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: now + TOKEN_TTL_SECONDS })).toString('base64url');
  return `gw_${payload}.${sign(payload)}`;
}

export function verifyWorkspaceToken(token: string, now = Math.floor(Date.now() / 1000)): string | null {
  if (!token.startsWith('gw_')) return null;
  const [payload, mac] = token.slice(3).split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: string; e?: number };
    if (!p.u || !p.e || p.e < now) return null;
    return p.u;
  } catch { return null; }
}

/**
 * The MCP server entry for a run, or null when the person has not connected Google (or the portal has no Google client).
 * `publicUrl` is where the runner can reach this portal.
 */
export async function workspaceMcpSpec(userId: string | null, publicUrl: string | undefined): Promise<
  { name: string; url: string; headers: Record<string, string>; allowWrites: boolean } | null
> {
  if (!userId || !publicUrl || !/^https:\/\//i.test(publicUrl)) return null;
  const c = await loadConnection(userId);
  if (!c) return null;
  return {
    name: 'google',
    url: `${publicUrl.replace(/\/+$/, '')}/api/mcp/google`,
    headers: { Authorization: `Bearer ${issueWorkspaceToken(userId)}` },
    allowWrites: c.allowWrites === true,
  };
}

// ── Google access tokens ──────────────────────────────────────────────────────

const accessCache = new Map<string, { token: string; expires: number }>();

async function accessTokenFor(userId: string): Promise<{ token: string; conn: StoredConnection }> {
  const conn = await loadConnection(userId);
  if (!conn) throw new Error('Google is not connected for this person. Connect it under Integrations.');
  const hit = accessCache.get(userId);
  if (hit && hit.expires > Date.now() + 60_000) return { token: hit.token, conn };
  const creds = await loadGoogleCredentials();
  if (!creds) throw new Error('Google is not set up on this portal.');
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: conn.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) {
    accessCache.delete(userId);
    throw new Error('Google no longer accepts the saved connection. Disconnect and connect Google again under Integrations.');
  }
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  accessCache.set(userId, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return { token: body.access_token, conn };
}

async function gfetch(userId: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const { token } = await accessTokenFor(userId);
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* keep text */ }
    throw new Error(`Google said ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

// ── Pure helpers (unit tested) ────────────────────────────────────────────────

/** Plain text of a Google Docs document body. */
export function docText(doc: { body?: { content?: unknown[] } }): string {
  const out: string[] = [];
  const walk = (content: unknown[] | undefined): void => {
    for (const el of content ?? []) {
      const e = el as { paragraph?: { elements?: { textRun?: { content?: string } }[] }; table?: { tableRows?: { tableCells?: { content?: unknown[] }[] }[] } };
      if (e.paragraph) out.push((e.paragraph.elements ?? []).map((x) => x.textRun?.content ?? '').join(''));
      if (e.table) {
        for (const row of e.table.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) walk(cell.content);
        }
      }
    }
  };
  walk(doc.body?.content);
  return out.join('');
}

/** Text of each slide of a presentation. */
export function slidesText(pres: { slides?: { pageElements?: unknown[] }[] }): string {
  const lines: string[] = [];
  (pres.slides ?? []).forEach((slide, i) => {
    lines.push(`--- Slide ${i + 1} ---`);
    for (const el of slide.pageElements ?? []) {
      const e = el as { shape?: { text?: { textElements?: { textRun?: { content?: string } }[] } } };
      const t = (e.shape?.text?.textElements ?? []).map((x) => x.textRun?.content ?? '').join('').trim();
      if (t) lines.push(t);
    }
  });
  return lines.join('\n');
}

/** Escapes a value for a Drive search query string literal. */
export function driveQueryLiteral(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[cut: ${s.length - MAX_TEXT} more characters]` : s);

// ── The MCP server a session talks to ─────────────────────────────────────────

export function createWorkspaceMcpServer(userId: string): McpServer {
  const server = new McpServer({ name: 'google-workspace', version: '1.0.0' });
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text: clip(text) }] });
  const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true as const });
  const audit = (action: string, target: string): void => auditLog(userId, `google.${action}`, target);
  const writesAllowed = async (): Promise<void> => {
    const c = await loadConnection(userId);
    if (!c?.allowWrites) throw new Error('Editing is switched off. The owner can allow it under Integrations → Google Workspace.');
  };
  const ro = { readOnlyHint: true, destructiveHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false };

  server.registerTool('search_drive', {
    description: 'Search Google Drive. `query` is plain words matched against file names and contents. Returns id, name, type and link.',
    inputSchema: { query: z.string().min(1).max(300), limit: z.number().int().min(1).max(50).optional() },
    annotations: ro,
  }, async ({ query, limit }) => {
    try {
      const q = `fullText contains '${driveQueryLiteral(query)}' and trashed = false`;
      const r = await gfetch(userId, `https://www.googleapis.com/drive/v3/files?pageSize=${limit ?? 15}&q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      audit('search', query.slice(0, 80));
      return ok(JSON.stringify(r, null, 1));
    } catch (e) { return fail(e); }
  });

  server.registerTool('get_file_info', {
    description: 'Details of one Drive file: name, type, owner, modified time and link.',
    inputSchema: { fileId: z.string().min(5).max(200) },
    annotations: ro,
  }, async ({ fileId }) => {
    try {
      const r = await gfetch(userId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,webViewLink,owners(displayName),size&supportsAllDrives=true`);
      return ok(JSON.stringify(r, null, 1));
    } catch (e) { return fail(e); }
  });

  server.registerTool('read_doc', {
    description: 'Read the text of a Google Doc.',
    inputSchema: { documentId: z.string().min(5).max(200) },
    annotations: ro,
  }, async ({ documentId }) => {
    try {
      const d = await gfetch(userId, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`) as { title?: string; body?: { content?: unknown[] } };
      audit('read_doc', documentId);
      return ok(`# ${d.title ?? ''}\n\n${docText(d)}`);
    } catch (e) { return fail(e); }
  });

  server.registerTool('list_sheet_tabs', {
    description: 'List the tabs of a Google Sheet with their sizes.',
    inputSchema: { spreadsheetId: z.string().min(5).max(200) },
    annotations: ro,
  }, async ({ spreadsheetId }) => {
    try {
      const r = await gfetch(userId, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties`);
      return ok(JSON.stringify(r, null, 1));
    } catch (e) { return fail(e); }
  });

  server.registerTool('read_sheet', {
    description: 'Read cells from a Google Sheet. `range` is A1 notation, e.g. "Sheet1!A1:D20".',
    inputSchema: { spreadsheetId: z.string().min(5).max(200), range: z.string().min(1).max(200) },
    annotations: ro,
  }, async ({ spreadsheetId, range }) => {
    try {
      const r = await gfetch(userId, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
      audit('read_sheet', spreadsheetId);
      return ok(JSON.stringify(r, null, 1));
    } catch (e) { return fail(e); }
  });

  server.registerTool('read_slides', {
    description: 'Read the text of every slide of a Google Slides presentation.',
    inputSchema: { presentationId: z.string().min(5).max(200) },
    annotations: ro,
  }, async ({ presentationId }) => {
    try {
      const p = await gfetch(userId, `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`) as { title?: string; slides?: { pageElements?: unknown[] }[] };
      audit('read_slides', presentationId);
      return ok(`# ${p.title ?? ''}\n${slidesText(p)}`);
    } catch (e) { return fail(e); }
  });

  // ── Tools that change things (hidden by the runner unless the person allowed editing) ──

  server.registerTool('create_doc', {
    description: 'Create a new Google Doc with the given title and optional text. Returns its id and link.',
    inputSchema: { title: z.string().min(1).max(200), text: z.string().max(50_000).optional() },
    annotations: rw,
  }, async ({ title, text }) => {
    try {
      await writesAllowed();
      const d = await gfetch(userId, 'https://docs.googleapis.com/v1/documents', { method: 'POST', body: { title } }) as { documentId: string };
      if (text) {
        await gfetch(userId, `https://docs.googleapis.com/v1/documents/${d.documentId}:batchUpdate`, {
          method: 'POST', body: { requests: [{ insertText: { location: { index: 1 }, text } }] },
        });
      }
      audit('create_doc', d.documentId);
      return ok(JSON.stringify({ documentId: d.documentId, link: `https://docs.google.com/document/d/${d.documentId}/edit` }));
    } catch (e) { return fail(e); }
  });

  server.registerTool('append_to_doc', {
    description: 'Add text to the end of an existing Google Doc.',
    inputSchema: { documentId: z.string().min(5).max(200), text: z.string().min(1).max(50_000) },
    annotations: rw,
  }, async ({ documentId, text }) => {
    try {
      await writesAllowed();
      await gfetch(userId, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
        method: 'POST', body: { requests: [{ insertText: { endOfSegmentLocation: {}, text } }] },
      });
      audit('append_to_doc', documentId);
      return ok('Added.');
    } catch (e) { return fail(e); }
  });

  server.registerTool('update_sheet_cells', {
    description: 'Write values into a range of a Google Sheet. `values` is a list of rows.',
    inputSchema: {
      spreadsheetId: z.string().min(5).max(200),
      range: z.string().min(1).max(200),
      values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))).max(500),
    },
    annotations: rw,
  }, async ({ spreadsheetId, range, values }) => {
    try {
      await writesAllowed();
      const r = await gfetch(userId, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
        method: 'PUT', body: { range, majorDimension: 'ROWS', values },
      });
      audit('update_sheet_cells', spreadsheetId);
      return ok(JSON.stringify(r));
    } catch (e) { return fail(e); }
  });

  server.registerTool('append_sheet_rows', {
    description: 'Add rows below the existing data of a Google Sheet tab. `range` names the tab, e.g. "Sheet1".',
    inputSchema: {
      spreadsheetId: z.string().min(5).max(200),
      range: z.string().min(1).max(200),
      values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))).max(500),
    },
    annotations: rw,
  }, async ({ spreadsheetId, range, values }) => {
    try {
      await writesAllowed();
      const r = await gfetch(userId, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, {
        method: 'POST', body: { majorDimension: 'ROWS', values },
      });
      audit('append_sheet_rows', spreadsheetId);
      return ok(JSON.stringify(r));
    } catch (e) { return fail(e); }
  });

  return server;
}

// ── Routes ────────────────────────────────────────────────────────────────────

function redirect(res: PortalResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/** Called by the Google sign-in callback when the state starts with "ws." (a Workspace connect, not a sign-in). */
export async function handleWorkspaceCallback(
  req: PortalRequest,
  res: PortalResponse,
  creds: { clientId: string; clientSecret: string },
): Promise<void> {
  const secure = req.secure;
  const back = (msg: string, good = false): void => {
    setCookie(res, WS_COOKIE, '', { maxAge: 0, secure });
    redirect(res, `/#/integrations?google=${good ? 'connected' : 'error'}&msg=${encodeURIComponent(msg)}`);
  };
  if (!req.user) { back('Sign in to the portal first, then connect Google.'); return; }
  const state = req.query.get('state') ?? '';
  const cookie = decodeURIComponent(parseCookies(req.headers.cookie)[WS_COOKIE] ?? '');
  if (!state || state !== cookie) { back('The connection attempt expired. Please try again.'); return; }
  if (req.query.get('error')) { back(req.query.get('error') === 'access_denied' ? 'Google access was not granted.' : 'Google connection failed.'); return; }
  const code = req.query.get('code') ?? '';
  if (!code) { back('Google did not send a code. Please try again.'); return; }

  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: creds.clientId, client_secret: creds.clientSecret,
        redirect_uri: googleRedirectUri(), grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenRes.ok) { back('Google refused the connection. Please try again.'); return; }
    const body = (await tokenRes.json()) as { refresh_token?: string; scope?: string; id_token?: string };
    const granted = (body.scope ?? '').split(' ');
    const missing = WORKSPACE_SCOPES.filter((s) => s.startsWith('https://') && !granted.includes(s));
    if (!body.refresh_token) { back('Google did not return a long-lived sign-in. Remove the portal under your Google account\'s third-party access and connect again.'); return; }
    if (missing.length) { back('Not every permission was ticked. Connect again and allow Drive, Docs, Sheets and Slides.'); return; }
    let email = '';
    try {
      const p = JSON.parse(Buffer.from((body.id_token ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: string };
      email = p.email ?? '';
    } catch { /* email is only shown */ }
    const previous = await loadConnection(req.user.id);
    await saveConnection(req.user.id, {
      refreshToken: body.refresh_token,
      email,
      allowWrites: previous?.allowWrites === true,
      connectedAt: new Date().toISOString(),
    });
    accessCache.delete(req.user.id);
    auditLog(req.user.id, 'google.connect', email);
    back(email ? `Google connected as ${email}.` : 'Google connected.', true);
  } catch (e) {
    console.error('[google-workspace] connect failed', e instanceof Error ? e.message : e);
    back('Could not reach Google. Please try again.');
  }
}

export function registerGoogleWorkspaceRoutes(): void {
  router.get('/api/google/status', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const creds = await loadGoogleCredentials();
    const available = Boolean(creds && process.env.PORTAL_PUBLIC_URL);
    const c = await loadConnection(req.user!.id);
    sendJson(res, 200, {
      available,
      connected: Boolean(c),
      email: c?.email ?? null,
      allowWrites: c?.allowWrites === true,
      connectedAt: c?.connectedAt ?? null,
    });
  }));

  router.get('/api/google/connect', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const creds = await loadGoogleCredentials();
    if (!creds || !process.env.PORTAL_PUBLIC_URL) {
      redirect(res, `/#/integrations?google=error&msg=${encodeURIComponent('Google is not set up on this portal.')}`);
      return;
    }
    const state = `ws.${randomBytes(24).toString('base64url')}`;
    setCookie(res, WS_COOKIE, state, { maxAge: 600, secure: req.secure });
    const u = new URL(GOOGLE_AUTH_URL);
    u.searchParams.set('client_id', creds.clientId);
    u.searchParams.set('redirect_uri', googleRedirectUri());
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', WORKSPACE_SCOPES.join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('include_granted_scopes', 'true');
    redirect(res, u.toString());
  }));

  router.put('/api/google/settings', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const c = await loadConnection(req.user!.id);
    if (!c) { sendJson(res, 404, { error: 'Google is not connected' }); return; }
    const body = (req.body ?? {}) as { allowWrites?: unknown };
    if (typeof body.allowWrites !== 'boolean') { sendJson(res, 400, { error: 'allowWrites must be true or false' }); return; }
    await saveConnection(req.user!.id, { ...c, allowWrites: body.allowWrites });
    auditLog(req.user!.id, 'google.settings', `allowWrites=${body.allowWrites}`);
    sendJson(res, 200, { ok: true, allowWrites: body.allowWrites });
  }));

  router.delete('/api/google/connection', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const c = await loadConnection(req.user!.id);
    if (c) {
      await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(c.refreshToken)}`, { method: 'POST' }).catch(() => {});
      await deleteSecret(secretName(req.user!.id));
      accessCache.delete(req.user!.id);
      auditLog(req.user!.id, 'google.disconnect', c.email);
    }
    sendJson(res, 200, { ok: true });
  }));

  // The endpoint sessions use. Bearer gw_ token only; a fresh server and transport per request.
  router.rawPost('/api/mcp/google', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const auth = String((req.headers as Record<string, unknown>).authorization ?? '');
    const userId = auth.startsWith('Bearer gw_') ? verifyWorkspaceToken(auth.slice(7)) : null;
    if (!userId) { sendJson(res, 401, { error: 'Invalid or expired token' }); return; }
    const server = createWorkspaceMcpServer(userId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: `MCP transport error: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      await transport.close().catch(() => {});
    }
  });
  router.rawGet('/api/mcp/google', (_req: PortalRequest, res: PortalResponse): void => {
    sendJson(res, 405, { error: 'This MCP endpoint is stateless. Use POST.' });
  });
}

export { publicBaseUrl };
