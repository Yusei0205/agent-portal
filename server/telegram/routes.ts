/**
 * Connect > Telegram: set the bot up from the portal instead of .env.
 *
 *   GET    /api/telegram          what is set (tokens shown as their last characters only) and whether the bot runs
 *   PUT    /api/telegram          save bot token, allowed chat IDs, default engine, on/off; the bot restarts at once
 *   POST   /api/telegram/token    create (or replace) the portal API token the bot acts with: read + write, yours
 *   POST   /api/telegram/test     check a bot token with Telegram (getMe) without saving it
 *   DELETE /api/telegram          forget the portal settings (and revoke the bot's API token); .env applies again
 *
 * Admins only, from a signed-in browser (API tokens are refused): the bot can act on the portal.
 */

import { randomBytes } from 'node:crypto';
import { router, sendJson, requireCookieAuth } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { auditRaw } from '../audit.ts';
import { generateId, now, sha256 } from '../util.ts';
import { getApiTokenRepository } from '../repositories/api-tokens.ts';
import { ENGINES, type BridgeEngine } from './config.ts';
import { clearTelegramSettings, loadSavedTelegramSettings, saveTelegramSettings, tail, type SavedTelegramSettings } from './settings.ts';
import { getTelegramStatus, reloadTelegramBridge, telegramApiFor } from './index.ts';

const BOT_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID_RE = /^-?\d{1,20}$/;
const BOT_API_TOKEN_DAYS = 365;

const onLambda = (): boolean => Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) || process.env.PORTAL_JOB_RUNNER === '1';

function admin(handler: (req: PortalRequest, res: PortalResponse) => Promise<void>) {
  return requireCookieAuth(async (req, res) => {
    if (!req.user?.is_admin) { sendJson(res, 403, { error: 'Only an admin can set up the Telegram bot' }); return; }
    await handler(req, res);
  });
}

function empty(): SavedTelegramSettings {
  return { enabled: true, botToken: '', allowedChatIds: [], defaultEngine: null, portalToken: '', portalTokenId: null };
}

async function view(): Promise<Record<string, unknown>> {
  const saved = await loadSavedTelegramSettings();
  let portalToken: Record<string, unknown> | null = null;
  if (saved?.portalToken) {
    const t = await getApiTokenRepository().getByHash(sha256(saved.portalToken)).catch(() => null);
    const live = Boolean(t && !t.revoked_at && !t.user_disabled && !(t.expires_at && t.expires_at < now()));
    portalToken = { hint: tail(saved.portalToken), valid: live, expiresAt: t?.expires_at ?? null, owner: t?.user_name ?? null };
  }
  return {
    available: !onLambda(),
    saved: Boolean(saved),
    envConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    enabled: saved ? saved.enabled : true,
    botTokenHint: saved ? tail(saved.botToken) : null,
    allowedChatIds: saved?.allowedChatIds ?? [],
    defaultEngine: saved?.defaultEngine ?? '',
    engines: ENGINES,
    portalToken,
    status: getTelegramStatus(),
  };
}

function parseChatIds(v: unknown): string[] | string {
  const list = (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((s) => !CHAT_ID_RE.test(s));
  if (bad.length) return `These are not chat IDs: ${bad.join(', ')}. A chat ID is a number, like 123456789.`;
  if (list.length > 50) return 'Allow at most 50 chats.';
  return [...new Set(list)];
}

async function revokeBotToken(s: SavedTelegramSettings | null): Promise<void> {
  if (!s?.portalTokenId) return;
  const repo = getApiTokenRepository();
  const t = await repo.getByHash(sha256(s.portalToken)).catch(() => null);
  if (t && !t.revoked_at) await repo.revoke(t.id, t.user_id, now()).catch(() => undefined);
}

export function registerTelegramRoutes(): void {
  router.get('/api/telegram', admin(async (_req, res) => {
    sendJson(res, 200, await view());
  }));

  router.put('/api/telegram', admin(async (req, res) => {
    if (onLambda()) { sendJson(res, 400, { error: 'The Telegram bot runs only in a portal on your own computer, not in the cloud deployment.' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = (await loadSavedTelegramSettings()) ?? empty();
    const next: SavedTelegramSettings = { ...current };

    if (typeof body.botToken === 'string' && body.botToken.trim()) {
      const t = body.botToken.trim();
      if (!BOT_TOKEN_RE.test(t)) { sendJson(res, 400, { error: 'That does not look like a bot token from @BotFather (it looks like 123456789:AAE…).' }); return; }
      next.botToken = t;
    }
    if (body.allowedChatIds !== undefined) {
      const ids = parseChatIds(body.allowedChatIds);
      if (typeof ids === 'string') { sendJson(res, 400, { error: ids }); return; }
      next.allowedChatIds = ids;
    }
    if (body.defaultEngine !== undefined) {
      const e = String(body.defaultEngine ?? '').trim();
      if (e && !(ENGINES as readonly string[]).includes(e)) { sendJson(res, 400, { error: `The engine must be one of: ${ENGINES.join(', ')}` }); return; }
      next.defaultEngine = (e || null) as BridgeEngine | null;
    }
    if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);

    await saveTelegramSettings(next);
    auditRaw(req.user!.id, 'telegram.settings', 'telegram', {
      enabled: next.enabled, chats: next.allowedChatIds.length, botTokenChanged: next.botToken !== current.botToken,
    });
    await reloadTelegramBridge();
    sendJson(res, 200, await view());
  }));

  router.post('/api/telegram/token', admin(async (req, res) => {
    if (onLambda()) { sendJson(res, 400, { error: 'The Telegram bot runs only in a portal on your own computer.' }); return; }
    const repo = getApiTokenRepository();
    const current = (await loadSavedTelegramSettings()) ?? empty();
    await revokeBotToken(current);
    if ((await repo.countActive(req.user!.id)) >= 10) {
      sendJson(res, 400, { error: 'You already have 10 active API tokens. Revoke one under API access first.' });
      return;
    }
    const token = `ap_${randomBytes(16).toString('hex')}`;
    const id = generateId();
    await repo.create({
      id,
      user_id: req.user!.id,
      name: 'Telegram bot',
      token_hash: sha256(token),
      prefix: token.slice(0, 10),
      scope: 'write',
      // Read and write only: enough to list, start, message and stop sessions; never merge.
      scopes: JSON.stringify(['read', 'write']),
      project_id: null,
      expires_at: new Date(Date.now() + BOT_API_TOKEN_DAYS * 86_400_000).toISOString(),
      created_at: now(),
    });
    await saveTelegramSettings({ ...current, portalToken: token, portalTokenId: id });
    auditRaw(req.user!.id, 'telegram.token', `api-token:${id}`, { replaced: Boolean(current.portalTokenId) });
    await reloadTelegramBridge();
    sendJson(res, 201, await view());
  }));

  router.post('/api/telegram/test', admin(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const given = typeof body.botToken === 'string' ? body.botToken.trim() : '';
    const botToken = given || (await loadSavedTelegramSettings())?.botToken || '';
    if (!botToken) { sendJson(res, 400, { error: 'Enter the bot token from @BotFather first.' }); return; }
    if (!BOT_TOKEN_RE.test(botToken)) { sendJson(res, 400, { error: 'That does not look like a bot token from @BotFather.' }); return; }
    try {
      const me = await telegramApiFor(botToken).getMe();
      sendJson(res, 200, { ok: true, botUsername: me.username ?? String(me.id) });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: `${(e as Error).message}. If the token is right, this PC may not reach api.telegram.org.` });
    }
  }));

  router.delete('/api/telegram', admin(async (req, res) => {
    const current = await loadSavedTelegramSettings();
    await revokeBotToken(current);
    await clearTelegramSettings();
    auditRaw(req.user!.id, 'telegram.settings', 'telegram', { cleared: true });
    await reloadTelegramBridge();
    sendJson(res, 200, await view());
  }));
}
