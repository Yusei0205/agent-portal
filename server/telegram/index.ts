/**
 * Starts the Telegram bridge when TELEGRAM_BOT_TOKEN is set (see config.ts and docs/telegram.md).
 * A problem with the settings is logged and the portal carries on without the bridge.
 */

import path from 'node:path';
import { getApiTokenRepository } from '../repositories/api-tokens.ts';
import { now, sha256 } from '../util.ts';
import { readTelegramConfig } from './config.ts';
import { createTelegramApi, type TelegramApi } from './telegram-api.ts';
import { createPortalClient } from './portal-client.ts';
import { BOT_COMMANDS, TelegramBridge } from './bot.ts';

export interface StartOptions {
  /** Where the portal listens, as the bridge should call it (loopback). */
  baseUrl: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  telegram?: TelegramApi;
}

let running: TelegramBridge | null = null;

export async function startTelegramBridge(opts: StartOptions): Promise<TelegramBridge | null> {
  const cfg = readTelegramConfig(opts.env ?? process.env);
  if (!cfg.enabled) {
    if (cfg.misconfigured) console.warn(`[telegram] not started: ${cfg.reason}`);
    return null;
  }
  const { config } = cfg;

  // The portal token must be live and able to write; it decides what the bot may do.
  const token = await getApiTokenRepository().getByHash(sha256(config.portalToken)).catch(() => null);
  if (!token || token.revoked_at || token.user_disabled || (token.expires_at && token.expires_at < now())) {
    console.warn('[telegram] not started: TELEGRAM_PORTAL_TOKEN is not a valid, unrevoked API token in this portal');
    return null;
  }
  let scopes: string[] = [];
  try { scopes = JSON.parse(token.scopes || '[]') as string[]; } catch { /* legacy */ }
  if (!scopes.length) scopes = token.scope === 'write' ? ['read', 'write'] : ['read'];
  if (!scopes.includes('write')) {
    console.warn('[telegram] not started: TELEGRAM_PORTAL_TOKEN needs the write scope to start and message sessions');
    return null;
  }
  if (scopes.includes('merge')) {
    console.warn('[telegram] note: TELEGRAM_PORTAL_TOKEN has the merge scope. A token with read and write only is safer for a chat bot.');
  }

  const telegram = opts.telegram ?? createTelegramApi(config.botToken);
  try {
    const me = await telegram.getMe();
    console.log(`[telegram] bot @${me.username ?? me.id} is on, answering ${config.allowedChatIds.size} allowed chat(s)`);
    await telegram.setMyCommands(BOT_COMMANDS).catch(() => undefined);
  } catch (e) {
    console.warn(`[telegram] not started: ${(e as Error).message}. Check TELEGRAM_BOT_TOKEN and that this PC can reach api.telegram.org.`);
    return null;
  }

  running = new TelegramBridge({
    config,
    telegram,
    portal: createPortalClient(opts.baseUrl, config.portalToken),
    stateFile: path.join(opts.dataDir, 'telegram-state.json'),
    actorId: token.user_id,
  });
  running.start();
  return running;
}

export async function stopTelegramBridge(): Promise<void> {
  const b = running;
  running = null;
  await b?.stop();
}
