/**
 * The Mail page: today's inbox of the signed-in person, from every mail account they connected
 * (Gmail now; see server/gmail.ts). Read only. The summary is not made here: the page starts a normal session
 * whose agent reads the same mail through the mail MCP server.
 *
 *   GET /api/mail/today?since=<ISO time of the start of the person's day>
 *   GET /api/mail/gmail/:id          one message in full
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { gmailAccount, listInboxSince, readMessageFull } from './gmail.ts';
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
    sendJson(res, 200, { since: new Date(since * 1000).toISOString(), accounts });
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
