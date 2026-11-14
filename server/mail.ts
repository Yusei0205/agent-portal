/**
 * The Mail page: today's inbox of the signed-in person, from every mail account they connected
 * (Gmail now; see server/gmail.ts). Read only. The summary is not made here: the page starts a normal session
 * whose agent reads the same mail through the mail MCP server.
 *
 *   GET /api/mail/today?since=<ISO time of the start of the person's day>
 *   GET /api/mail/gmail/:id          one message in full
 *   GET|PUT|DELETE /api/mail/drafts[/:id], POST /api/mail/drafts/:id/send   reply drafts the person reviews, edits, sends
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { gmailAccount, listInboxSince, readMessageFull, listDrafts, updateDraft, sendDraft, deleteDraft } from './gmail.ts';
import { requireStepUp } from './step-up.ts';
import type { MailItem } from './gmail.ts';

export interface MailAccount { provider: 'gmail'; email: string; messages: MailItem[]; error?: string }

/** The start of the day the page asks about: a valid time not in the future and at most 3 days back. */
export function parseSince(raw: string | null, now = Date.now()): number {
  const t = raw ? Date.parse(raw) : NaN;
  const earliest = now - 3 * 24 * 3600 * 1000;
  if (!Number.isFinite(t)) return Math.floor((now - 24 * 3600 * 1000) / 1000);
  return Math.floor(Math.min(Math.max(t, earliest), now) / 1000);
}

export function registerMailRoutes(): void {
  router.get('/api/mail/today', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const userId = req.user!.id;
    const since = parseSince(req.query.get('since'));
    const accounts: MailAccount[] = [];

    const g = await gmailAccount(userId);
    if (g.connected) {
      try {
        accounts.push({ provider: 'gmail', email: g.email, messages: await listInboxSince(userId, since) });
      } catch (e) {
        accounts.push({ provider: 'gmail', email: g.email, messages: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    sendJson(res, 200, { since: new Date(since * 1000).toISOString(), accounts, allowSend: g.allowSend });
  }));

  // Reply drafts the agent saved. The person reviews and edits them here, and only the person sends.
  const failure = (res: PortalResponse, e: unknown): void => {
    sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) });
  };
  const draftBody = (b: unknown): { to: string; cc: string; bcc: string; subject: string; body: string } | null => {
    const o = (b ?? {}) as Record<string, unknown>;
    if (typeof o.to !== 'string' || typeof o.subject !== 'string' || typeof o.body !== 'string') return null;
    if (o.body.length > 50_000 || o.subject.length > 300) return null;
    const opt = (v: unknown): string => (typeof v === 'string' ? v : '');
    return { to: o.to, cc: opt(o.cc), bcc: opt(o.bcc), subject: o.subject, body: o.body };
  };

  router.get('/api/mail/drafts', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    try { sendJson(res, 200, { drafts: await listDrafts(req.user!.id) }); } catch (e) { failure(res, e); }
  }));

  router.put('/api/mail/drafts/:id', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const edit = draftBody(req.body);
    if (!edit) { sendJson(res, 400, { error: 'to, subject and body are required' }); return; }
    try { await updateDraft(req.user!.id, req.params.id, edit); sendJson(res, 200, { ok: true }); } catch (e) { failure(res, e); }
  }));

  router.post('/api/mail/drafts/:id/send', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!await requireStepUp(req, res)) return;
    try { await sendDraft(req.user!.id, req.params.id); sendJson(res, 200, { ok: true }); } catch (e) { failure(res, e); }
  }));

  router.delete('/api/mail/drafts/:id', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    try { await deleteDraft(req.user!.id, req.params.id); sendJson(res, 200, { ok: true }); } catch (e) { failure(res, e); }
  }));

  // One message in full, for the page to show when a row is opened. Gmail only for now.
  router.get('/api/mail/gmail/:id', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const id = req.params.id;
    if (!/^[A-Za-z0-9_-]{5,100}$/.test(id)) { sendJson(res, 400, { error: 'Invalid message id' }); return; }
    if (!(await gmailAccount(req.user!.id)).connected) { sendJson(res, 404, { error: 'Gmail is not connected' }); return; }
    try {
      sendJson(res, 200, { message: await readMessageFull(req.user!.id, id) });
    } catch (e) {
      sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) });
    }
  }));
}
