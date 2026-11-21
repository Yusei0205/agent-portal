/**
 * Gmail for agents: search and read mail, and (only when the person allows it) draft and send.
 *
 * Works like Google Workspace (server/google-workspace.ts): each person connects their own Gmail once (Integrations →
 * Connected services). The portal keeps the refresh token encrypted and never gives it to an agent. A session gets a
 * "gmail" MCP server whose address is this portal (POST /api/mcp/gmail) and whose only credential is a short-lived
 * signed token naming the person.
 *
 *   GET    /api/gmail/status      {available, connected, email, allowSend}
 *   GET    /api/gmail/connect     redirects to Google (same redirect URI as sign-in, told apart by the state prefix "gm.")
 *   PUT    /api/gmail/settings    {allowSend}
 *   DELETE /api/gmail/connection  forget the refresh token and revoke it at Google
 *   POST   /api/mcp/gmail         MCP endpoint used by sessions (Bearer gm_<token>)
 *
 * Reading tools are always offered; drafting and sending only when the person turned "let agents draft and send" on.
 * It is a separate connection from Google Workspace so that people who only want Drive are never asked for mail access.
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
import { appendAudit } from './audit.ts';

const GM_COOKIE = 'portal_gmail_connect';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const GMAIL_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

const TOKEN_TTL_SECONDS = 8 * 3600;
const MAX_TEXT = 60_000;

interface StoredConnection {
  refreshToken: string;
  email: string;
  allowSend: boolean;
  connectedAt: string;
}

function auditLog(userId: string, action: string, target: string | null): void {
  try { appendAudit(null, userId, action, target, null, null); } catch { /* audit must not break a tool */ }
}

const secretName = (userId: string): string => `gmail:${userId}`;

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
  return createHmac('sha256', config.secretKey).update(`gmail:${payload}`).digest('base64url');
}

export function issueGmailToken(userId: string, now = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: now + TOKEN_TTL_SECONDS })).toString('base64url');
  return `gm_${payload}.${sign(payload)}`;
}

export function verifyGmailToken(token: string, now = Math.floor(Date.now() / 1000)): string | null {
  if (!token.startsWith('gm_')) return null;
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

/** The MCP server entry for a run, or null when the person has not connected Gmail. */
export async function gmailMcpSpec(userId: string | null, publicUrl: string | undefined): Promise<
  { name: string; url: string; headers: Record<string, string>; allowWrites: boolean } | null
> {
  if (!userId || !publicUrl || !/^https:\/\//i.test(publicUrl)) return null;
  const c = await loadConnection(userId);
  if (!c) return null;
  return {
    name: 'gmail',
    url: `${publicUrl.replace(/\/+$/, '')}/api/mcp/gmail`,
    headers: { Authorization: `Bearer ${issueGmailToken(userId)}` },
    allowWrites: c.allowSend === true,
  };
}

// ── Google access tokens ──────────────────────────────────────────────────────

const accessCache = new Map<string, { token: string; expires: number }>();

async function accessTokenFor(userId: string): Promise<string> {
  const conn = await loadConnection(userId);
  if (!conn) throw new Error('Gmail is not connected for this person. Connect it under Integrations.');
  const hit = accessCache.get(userId);
  if (hit && hit.expires > Date.now() + 60_000) return hit.token;
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
    throw new Error('Google no longer accepts the saved Gmail connection. Disconnect and connect Gmail again under Integrations.');
  }
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  accessCache.set(userId, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

async function gfetch(userId: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const token = await accessTokenFor(userId);
  const res = await fetch(`${GMAIL_API}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* keep text */ }
    throw new Error(`Gmail said ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

// ── Pure helpers (unit tested) ────────────────────────────────────────────────

interface Part { mimeType?: string; filename?: string; body?: { data?: string; size?: number }; parts?: Part[]; headers?: { name: string; value: string }[] }

/** Value of a header (case-insensitive), or ''. */
export function headerValue(headers: { name: string; value: string }[] | undefined, name: string): string {
  const h = (headers ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

const decode = (data: string): string => Buffer.from(data, 'base64url').toString('utf8');

/** Gmail's snippet and HTML mail carry entities such as &#39; and &amp;: this turns them into the characters. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Readable text of a message: the plain part when there is one, else the HTML part as text. */
export function messageText(payload: Part | undefined): string {
  let plain = '';
  let html = '';
  const walk = (p: Part | undefined): void => {
    if (!p) return;
    if (p.body?.data && !p.filename) {
      if (p.mimeType === 'text/plain' && !plain) plain = decode(p.body.data);
      else if (p.mimeType === 'text/html' && !html) html = decode(p.body.data);
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return (plain || htmlToText(html)).trim();
}

/** Names of the attachments (they are listed, never downloaded). */
export function attachmentNames(payload: Part | undefined): string[] {
  const out: string[] = [];
  const walk = (p: Part | undefined): void => {
    if (!p) return;
    if (p.filename) out.push(p.filename);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return out;
}

const NO_BREAKS = /[\r\n]/;

/** An address list for a header: refuses line breaks (header injection) and anything that is not an address. */
export function cleanAddresses(v: string, field: string): string {
  const s = v.trim();
  if (!s) return '';
  if (NO_BREAKS.test(s)) throw new Error(`${field} must be on one line.`);
  for (const part of s.split(',')) {
    const m = part.match(/<([^<>]+)>\s*$/);
    const addr = (m ? m[1] : part).trim();
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(addr)) throw new Error(`${field} has something that is not an email address: ${addr.slice(0, 60)}`);
  }
  return s;
}

/** Marks a draft an agent saved, so the Mail page lists those and not the person's own drafts. */
export const AGENT_DRAFT_HEADER = 'X-Portal-Agent-Draft';

/** The raw message Gmail wants (base64url of an RFC 2822 message). */
export function buildRawMessage(m: { to: string; cc?: string; bcc?: string; subject: string; body: string; inReplyTo?: string; agentDraft?: boolean }): string {
  const to = cleanAddresses(m.to, 'to');
  if (!to) throw new Error('to is required.');
  const cc = cleanAddresses(m.cc ?? '', 'cc');
  const bcc = cleanAddresses(m.bcc ?? '', 'bcc');
  if (NO_BREAKS.test(m.subject)) throw new Error('subject must be on one line.');
  if (m.inReplyTo && NO_BREAKS.test(m.inReplyTo)) throw new Error('inReplyTo must be on one line.');
  const subject = /^[\x20-\x7e]*$/.test(m.subject) ? m.subject : `=?UTF-8?B?${Buffer.from(m.subject, 'utf8').toString('base64')}?=`;
  const lines = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`,
    ...(m.agentDraft ? [`${AGENT_DRAFT_HEADER}: 1`] : []),
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[cut: ${s.length - MAX_TEXT} more characters]` : s);

// ── The MCP server a session talks to ─────────────────────────────────────────

export function createGmailMcpServer(userId: string): McpServer {
  const server = new McpServer({ name: 'gmail', version: '1.0.0' });
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text: clip(text) }] });
  const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true as const });
  const audit = (action: string, target: string): void => auditLog(userId, `gmail.${action}`, target);
  const sendAllowed = async (): Promise<void> => {
    const c = await loadConnection(userId);
    if (!c?.allowSend) throw new Error('Drafting and sending are switched off. The owner can allow it under Integrations → Gmail.');
  };
  const ro = { readOnlyHint: true, destructiveHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false };

  server.registerTool('search_mail', {
    description: 'Search Gmail. `query` uses Gmail search syntax (e.g. "from:alice newer_than:7d invoice"). Returns id, from, subject, date and a snippet.',
    inputSchema: { query: z.string().min(1).max(300), limit: z.number().int().min(1).max(25).optional() },
    annotations: ro,
  }, async ({ query, limit }) => {
    try {
      const list = await gfetch(userId, `/messages?maxResults=${limit ?? 10}&q=${encodeURIComponent(query)}`) as { messages?: { id: string }[] };
      const out = [];
      for (const m of (list.messages ?? []).slice(0, limit ?? 10)) {
        const d = await gfetch(userId, `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`) as { id: string; threadId: string; snippet?: string; payload?: Part };
        out.push({
          id: d.id, threadId: d.threadId,
          from: headerValue(d.payload?.headers, 'From'), subject: headerValue(d.payload?.headers, 'Subject'),
          date: headerValue(d.payload?.headers, 'Date'), snippet: d.snippet ?? '',
        });
      }
      audit('search', query.slice(0, 80));
      return ok(out.length ? JSON.stringify(out, null, 1) : 'No messages found.');
    } catch (e) { return fail(e); }
  });

  server.registerTool('read_message', {
    description: 'Read one email: headers, text and the names of its attachments (attachments are not downloaded).',
    inputSchema: { messageId: z.string().min(5).max(100) },
    annotations: ro,
  }, async ({ messageId }) => {
    try {
      const d = await gfetch(userId, `/messages/${encodeURIComponent(messageId)}?format=full`) as { id: string; threadId: string; payload?: Part };
      const h = d.payload?.headers;
      const att = attachmentNames(d.payload);
      audit('read', messageId);
      return ok([
        `From: ${headerValue(h, 'From')}`, `To: ${headerValue(h, 'To')}`,
        ...(headerValue(h, 'Cc') ? [`Cc: ${headerValue(h, 'Cc')}`] : []),
        `Date: ${headerValue(h, 'Date')}`, `Subject: ${headerValue(h, 'Subject')}`,
        `Message-ID: ${headerValue(h, 'Message-ID')}`, `Thread: ${d.threadId}`,
        ...(att.length ? [`Attachments: ${att.join(', ')}`] : []),
        '', messageText(d.payload),
      ].join('\n'));
    } catch (e) { return fail(e); }
  });

  server.registerTool('list_labels', {
    description: 'List the Gmail labels (use a label in a search as label:name).',
    inputSchema: {},
    annotations: ro,
  }, async () => {
    try {
      const r = await gfetch(userId, '/labels') as { labels?: { id: string; name: string; type?: string }[] };
      return ok(JSON.stringify((r.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type })), null, 1));
    } catch (e) { return fail(e); }
  });

  // ── Tools that change things (hidden by the runner unless the person allowed them) ──

  const composeShape = {
    to: z.string().min(3).max(500),
    cc: z.string().max(500).optional(),
    bcc: z.string().max(500).optional(),
    subject: z.string().max(300),
    body: z.string().min(1).max(50_000),
    inReplyTo: z.string().max(300).optional(),
    threadId: z.string().max(100).optional(),
  };

  server.registerTool('create_draft', {
    description: 'Save an email as a draft in Gmail (nothing is sent). The person can review and send it themselves.',
    inputSchema: composeShape,
    annotations: rw,
  }, async (a) => {
    try {
      await sendAllowed();
      const raw = buildRawMessage({ ...a, agentDraft: true });
      const r = await gfetch(userId, '/drafts', { method: 'POST', body: { message: { raw, ...(a.threadId ? { threadId: a.threadId } : {}) } } }) as { id?: string };
      audit('create_draft', a.to.slice(0, 80));
      return ok(`Draft saved (id ${r.id ?? '?'}). It is in the Drafts folder, not sent.`);
    } catch (e) { return fail(e); }
  });

  server.registerTool('send_mail', {
    description: 'Send an email from the person\'s Gmail. This really sends it: check the recipients and text first, and prefer create_draft unless asked to send.',
    inputSchema: composeShape,
    annotations: rw,
  }, async (a) => {
    try {
      await sendAllowed();
      const raw = buildRawMessage(a);
      const r = await gfetch(userId, '/messages/send', { method: 'POST', body: { raw, ...(a.threadId ? { threadId: a.threadId } : {}) } }) as { id?: string };
      audit('send', a.to.slice(0, 80));
      return ok(`Sent (id ${r.id ?? '?'}).`);
    } catch (e) { return fail(e); }
  });

  return server;
}

// ── Routes ────────────────────────────────────────────────────────────────────

function redirect(res: PortalResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/** Called by the Google callback when the state starts with "gm." (a Gmail connect, not a sign-in). */
export async function handleGmailCallback(
  req: PortalRequest,
  res: PortalResponse,
  creds: { clientId: string; clientSecret: string },
): Promise<void> {
  const secure = req.secure;
  const back = (msg: string, good = false): void => {
    setCookie(res, GM_COOKIE, '', { maxAge: 0, secure });
    redirect(res, `/#/integrations?gmail=${good ? 'connected' : 'error'}&msg=${encodeURIComponent(msg)}`);
  };
  if (!req.user) { back('Sign in to the portal first, then connect Gmail.'); return; }
  const state = req.query.get('state') ?? '';
  const cookie = decodeURIComponent(parseCookies(req.headers.cookie)[GM_COOKIE] ?? '');
  if (!state || state !== cookie) { back('The connection attempt expired. Please try again.'); return; }
  if (req.query.get('error')) { back(req.query.get('error') === 'access_denied' ? 'Google access was not granted.' : 'Gmail connection failed.'); return; }
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
    const missing = GMAIL_SCOPES.filter((s) => s.startsWith('https://') && !granted.includes(s));
    if (!body.refresh_token) { back('Google did not return a long-lived sign-in. Remove the portal under your Google account\'s third-party access and connect again.'); return; }
    if (missing.length) { back('Not every permission was ticked. Connect again and allow reading and drafting mail.'); return; }
    let email = '';
    try {
      const p = JSON.parse(Buffer.from((body.id_token ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: string };
      email = p.email ?? '';
    } catch { /* email is only shown */ }
    const previous = await loadConnection(req.user.id);
    await saveConnection(req.user.id, {
      refreshToken: body.refresh_token,
      email,
      allowSend: previous?.allowSend === true,
      connectedAt: new Date().toISOString(),
    });
    accessCache.delete(req.user.id);
    auditLog(req.user.id, 'gmail.connect', email);
    back(email ? `Gmail connected as ${email}.` : 'Gmail connected.', true);
  } catch (e) {
    console.error('[gmail] connect failed', e instanceof Error ? e.message : e);
    back('Could not reach Google. Please try again.');
  }
}

export function registerGmailRoutes(): void {
  router.get('/api/gmail/status', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const creds = await loadGoogleCredentials();
    const available = Boolean(creds && process.env.PORTAL_PUBLIC_URL);
    const c = await loadConnection(req.user!.id);
    sendJson(res, 200, {
      available,
      connected: Boolean(c),
      email: c?.email ?? null,
      allowSend: c?.allowSend === true,
      connectedAt: c?.connectedAt ?? null,
    });
  }));

  router.get('/api/gmail/connect', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const creds = await loadGoogleCredentials();
    if (!creds || !process.env.PORTAL_PUBLIC_URL) {
      redirect(res, `/#/integrations?gmail=error&msg=${encodeURIComponent('Google is not set up on this portal.')}`);
      return;
    }
    const state = `gm.${randomBytes(24).toString('base64url')}`;
    setCookie(res, GM_COOKIE, state, { maxAge: 600, secure: req.secure });
    const u = new URL(GOOGLE_AUTH_URL);
    u.searchParams.set('client_id', creds.clientId);
    u.searchParams.set('redirect_uri', googleRedirectUri());
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', GMAIL_SCOPES.join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    redirect(res, u.toString());
  }));

  router.put('/api/gmail/settings', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const c = await loadConnection(req.user!.id);
    if (!c) { sendJson(res, 404, { error: 'Gmail is not connected' }); return; }
    const body = (req.body ?? {}) as { allowSend?: unknown };
    if (typeof body.allowSend !== 'boolean') { sendJson(res, 400, { error: 'allowSend must be true or false' }); return; }
    await saveConnection(req.user!.id, { ...c, allowSend: body.allowSend });
    auditLog(req.user!.id, 'gmail.settings', `allowSend=${body.allowSend}`);
    sendJson(res, 200, { ok: true, allowSend: body.allowSend });
  }));

  router.delete('/api/gmail/connection', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const c = await loadConnection(req.user!.id);
    if (c) {
      await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(c.refreshToken)}`, { method: 'POST' }).catch(() => {});
      await deleteSecret(secretName(req.user!.id));
      accessCache.delete(req.user!.id);
      auditLog(req.user!.id, 'gmail.disconnect', c.email);
    }
    sendJson(res, 200, { ok: true });
  }));

  // The endpoint sessions use. Bearer gm_ token only; a fresh server and transport per request.
  router.rawPost('/api/mcp/gmail', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const auth = String((req.headers as Record<string, unknown>).authorization ?? '');
    const userId = auth.startsWith('Bearer gm_') ? verifyGmailToken(auth.slice(7)) : null;
    if (!userId) { sendJson(res, 401, { error: 'Invalid or expired token' }); return; }
    const server = createGmailMcpServer(userId);
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
  router.rawGet('/api/mcp/gmail', (_req: PortalRequest, res: PortalResponse): void => {
    sendJson(res, 405, { error: 'This MCP endpoint is stateless. Use POST.' });
  });
}

// ── Listing for the portal's Mail page ───────────────────────────────────────

export interface MailItem { id: string; from: string; subject: string; date: string; snippet: string; unread: boolean }

/** Inbox messages received since `sinceSec` (unix seconds), newest first. */
export async function listInboxSince(userId: string, sinceSec: number, limit = 50): Promise<MailItem[]> {
  const q = `in:inbox after:${Math.floor(sinceSec)}`;
  const list = await gfetch(userId, `/messages?maxResults=${limit}&q=${encodeURIComponent(q)}`) as { messages?: { id: string }[] };
  const out: MailItem[] = [];
  for (const m of (list.messages ?? []).slice(0, limit)) {
    const d = await gfetch(userId, `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`) as { id: string; snippet?: string; labelIds?: string[]; payload?: Part };
    out.push({
      id: d.id,
      from: headerValue(d.payload?.headers, 'From'),
      subject: headerValue(d.payload?.headers, 'Subject') || '(no subject)',
      date: headerValue(d.payload?.headers, 'Date'),
      snippet: decodeEntities(d.snippet ?? ''),
      unread: (d.labelIds ?? []).includes('UNREAD'),
    });
  }
  return out;
}

export async function gmailAccount(userId: string): Promise<{ connected: boolean; email: string; allowSend: boolean }> {
  const c = await loadConnection(userId);
  return { connected: Boolean(c), email: c?.email ?? '', allowSend: c?.allowSend === true };
}

// ── Drafts the person reviews on the Mail page (the agent saves them, the person sends) ──

export interface DraftItem {
  id: string; threadId: string;
  to: string; cc: string; bcc: string; subject: string; body: string;
  /** The message this replies to, when the draft sits in a thread. */
  replyingTo: { id: string; from: string; subject: string; date: string; snippet: string } | null;
}

interface RawDraft { id: string; message?: { threadId?: string; payload?: Part } }

function toDraftItem(d: RawDraft): DraftItem {
  const h = d.message?.payload?.headers;
  return {
    id: d.id, threadId: d.message?.threadId ?? '',
    to: headerValue(h, 'To'), cc: headerValue(h, 'Cc'), bcc: headerValue(h, 'Bcc'),
    subject: headerValue(h, 'Subject'),
    body: messageText(d.message?.payload).slice(0, 50_000),
    replyingTo: null,
  };
}

async function requireSendAllowed(userId: string): Promise<void> {
  const c = await loadConnection(userId);
  if (!c?.allowSend) throw new Error('Drafting and sending are switched off. Allow it under Connect › Tools & services › Gmail.');
}

const DRAFT_ID = /^[A-Za-z0-9_-]{3,100}$/;
function checkDraftId(id: string): void { if (!DRAFT_ID.test(id)) throw new Error('Invalid draft id'); }

/** The message a draft answers: the newest non-draft message of its thread, else the one its In-Reply-To names. */
async function originalOf(userId: string, threadId: string, inReplyTo: string): Promise<DraftItem['replyingTo']> {
  const q = '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date';
  type Msg = { id: string; snippet?: string; labelIds?: string[]; payload?: Part };
  const pick = (m: Msg | undefined): DraftItem['replyingTo'] => m ? {
    id: m.id,
    from: headerValue(m.payload?.headers, 'From'),
    subject: headerValue(m.payload?.headers, 'Subject') || '(no subject)',
    date: headerValue(m.payload?.headers, 'Date'),
    snippet: decodeEntities(m.snippet ?? ''),
  } : null;
  try {
    if (threadId) {
      const t = await gfetch(userId, `/threads/${threadId}${q}`) as { messages?: Msg[] };
      const real = (t.messages ?? []).filter((m) => !(m.labelIds ?? []).includes('DRAFT'));
      if (real.length) return pick(real[real.length - 1]);
    }
    const mid = inReplyTo.trim();
    if (/^<[^<>\s]+>$/.test(mid)) {
      const r = await gfetch(userId, `/messages?maxResults=1&q=${encodeURIComponent(`rfc822msgid:${mid}`)}`) as { messages?: { id: string }[] };
      if (r.messages?.[0]) return pick(await gfetch(userId, `/messages/${r.messages[0].id}${q}`) as Msg);
    }
  } catch { /* the original is only context */ }
  return null;
}

/** The reply drafts an agent saved (up to 20 of the newest), with the sender and subject of the message each one answers.
 *  Drafts the person wrote themselves in Gmail are not listed: only those carrying the agent marker header. */
export async function listDrafts(userId: string): Promise<DraftItem[]> {
  await requireSendAllowed(userId);
  const list = await gfetch(userId, '/drafts?maxResults=50') as { drafts?: { id: string }[] };
  const out: DraftItem[] = [];
  for (const { id } of list.drafts ?? []) {
    if (out.length >= 20) break;
    const head = await gfetch(userId, `/drafts/${encodeURIComponent(id)}?format=metadata&metadataHeaders=${AGENT_DRAFT_HEADER}&metadataHeaders=In-Reply-To`) as RawDraft;
    if (!headerValue(head.message?.payload?.headers, AGENT_DRAFT_HEADER)) continue;
    const d = toDraftItem(await gfetch(userId, `/drafts/${encodeURIComponent(id)}?format=full`) as RawDraft);
    d.replyingTo = await originalOf(userId, d.threadId, headerValue(head.message?.payload?.headers, 'In-Reply-To'));
    out.push(d);
  }
  return out;
}

/** Save the person's edits (recipients, subject, text) to a draft, keeping its thread. */
export async function updateDraft(
  userId: string, draftId: string,
  edit: { to: string; cc?: string; bcc?: string; subject: string; body: string },
): Promise<void> {
  await requireSendAllowed(userId);
  checkDraftId(draftId);
  const cur = await gfetch(userId, `/drafts/${encodeURIComponent(draftId)}?format=metadata&metadataHeaders=In-Reply-To`) as RawDraft;
  const inReplyTo = headerValue(cur.message?.payload?.headers, 'In-Reply-To') || undefined;
  const raw = buildRawMessage({ ...edit, inReplyTo, agentDraft: true }); // only agent drafts are listed, so edits keep the marker
  const threadId = cur.message?.threadId;
  await gfetch(userId, `/drafts/${encodeURIComponent(draftId)}`, { method: 'PUT', body: { message: { raw, ...(threadId ? { threadId } : {}) } } });
  auditLog(userId, 'gmail.edit_draft', edit.to.slice(0, 80));
}

/** Send a draft the person reviewed. */
export async function sendDraft(userId: string, draftId: string): Promise<void> {
  await requireSendAllowed(userId);
  checkDraftId(draftId);
  const cur = toDraftItem(await gfetch(userId, `/drafts/${encodeURIComponent(draftId)}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc`) as RawDraft);
  if (!cleanAddresses(cur.to, 'to')) throw new Error('Add at least one recipient before sending.');
  await gfetch(userId, '/drafts/send', { method: 'POST', body: { id: draftId } });
  auditLog(userId, 'gmail.send_reviewed', cur.to.slice(0, 80));
}

export async function deleteDraft(userId: string, draftId: string): Promise<void> {
  await requireSendAllowed(userId);
  checkDraftId(draftId);
  await gfetch(userId, `/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
  auditLog(userId, 'gmail.discard_draft', draftId);
}

/** One message in full, for the Mail page. */
export async function readMessageFull(userId: string, messageId: string): Promise<{
  id: string; from: string; to: string; cc: string; date: string; subject: string; text: string; attachments: string[];
}> {
  const d = await gfetch(userId, `/messages/${encodeURIComponent(messageId)}?format=full`) as { id: string; payload?: Part };
  const h = d.payload?.headers;
  return {
    id: d.id,
    from: headerValue(h, 'From'), to: headerValue(h, 'To'), cc: headerValue(h, 'Cc'),
    date: headerValue(h, 'Date'), subject: headerValue(h, 'Subject') || '(no subject)',
    text: messageText(d.payload).slice(0, MAX_TEXT),
    attachments: attachmentNames(d.payload),
  };
}
