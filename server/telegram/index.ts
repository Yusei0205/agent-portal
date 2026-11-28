/**
 * Runs the Telegram bridge (see bot.ts and docs/telegram.md).
 *
 * Settings come from the portal (Connect > Telegram, stored encrypted) and, when nothing is saved
 * there, from .env. Saving settings in the portal restarts the bot at once; no portal restart is needed.
 * A problem with the settings is recorded (shown on the Telegram page and logged) and the portal
 * carries on without the bridge.
 */

import path from 'node:path';
import { getApiTokenRepository } from '../repositories/api-tokens.ts';
import { now, sha256 } from '../util.ts';
import { readTelegramConfig } from './config.ts';
import { createTelegramApi, type TelegramApi } from './telegram-api.ts';
import { createPortalClient } from './portal-client.ts';
import { BOT_COMMANDS, TelegramBridge } from './bot.ts';
import { loadSavedTelegramSettings, savedSettingsAsEnv } from './settings.ts';

export interface StartOptions {
  /** Where the portal listens, as the bridge should call it (loopback). */
  baseUrl: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  telegram?: TelegramApi;
}

export interface BridgeStatus {
  running: boolean;
  /** Where the settings in use came from. */
  source: 'portal' | 'env' | 'none';
  botUsername: string | null;
  /** Why the bot is not running, when it should be. */
  error: string | null;
  allowedChats: number;
}

let running: TelegramBridge | null = null;
let context: { baseUrl: string; dataDir: string } | null = null;
let status: BridgeStatus = { running: false, source: 'none', botUsername: null, error: null, allowedChats: 0 };
let apiFactory: (botToken: string) => TelegramApi = (t) => createTelegramApi(t);
let reloading: Promise<BridgeStatus> = Promise.resolve(status);

/** For tests: the Telegram API the bridge and the "Test" button use. */
export function setTelegramApiFactory(fn: ((botToken: string) => TelegramApi) | null): void {
  apiFactory = fn ?? ((t) => createTelegramApi(t));
}

export function telegramApiFor(botToken: string): TelegramApi {
  return apiFactory(botToken);
}

export function getTelegramStatus(): BridgeStatus {
  return { ...status };
}

/** Called once the portal listens: where the bridge reaches the portal, and where it keeps its state. */
export function configureTelegramBridge(ctx: { baseUrl: string; dataDir: string }): void {
  context = ctx;
}

/** (Re)starts the bot with the current settings: saved in the portal, else .env. Calls are queued. */
export function reloadTelegramBridge(env: NodeJS.ProcessEnv = process.env): Promise<BridgeStatus> {
  reloading = reloading.catch(() => status).then(async () => {
    await stopTelegramBridge();
    if (!context) {
      status = { running: false, source: 'none', botUsername: null, error: null, allowedChats: 0 };
      return getTelegramStatus();
    }
    const saved = await loadSavedTelegramSettings();
    const source: BridgeStatus['source'] = saved ? 'portal' : env.TELEGRAM_BOT_TOKEN ? 'env' : 'none';
    const effectiveEnv: NodeJS.ProcessEnv = saved ? { ...savedSettingsAsEnv(saved), AWS_LAMBDA_FUNCTION_NAME: env.AWS_LAMBDA_FUNCTION_NAME, PORTAL_JOB_RUNNER: env.PORTAL_JOB_RUNNER } : env;
    const result = await startWith({ ...context, env: effectiveEnv });
    status = { ...result, source };
    return getTelegramStatus();
  });
  return reloading;
}

/** Starts the bridge with the given settings (default .env). Kept for direct use and tests. */
export async function startTelegramBridge(opts: StartOptions): Promise<TelegramBridge | null> {
  await stopTelegramBridge();
  const r = await startWith(opts);
  status = { ...r, source: (opts.env ?? process.env).TELEGRAM_BOT_TOKEN ? 'env' : 'none' };
  return running;
}

async function startWith(opts: StartOptions): Promise<Omit<BridgeStatus, 'source'>> {
  const off = (error: string | null, allowedChats = 0) => {
    if (error) console.warn(`[telegram] not started: ${error}`);
    return { running: false, botUsername: null, error, allowedChats };
  };
  const cfg = readTelegramConfig(opts.env ?? process.env);
  if (!cfg.enabled) return off(cfg.misconfigured ? cfg.reason : null);
  const { config } = cfg;

  // The portal token must be live and able to write; it decides what the bot may do.
  const token = await getApiTokenRepository().getByHash(sha256(config.portalToken)).catch(() => null);
  if (!token || token.revoked_at || token.user_disabled || (token.expires_at && token.expires_at < now())) {
    return off('the portal API token for the bot is not valid any more (revoked, expired or unknown). Create a new one', config.allowedChatIds.size);
  }
  let scopes: string[] = [];
  try { scopes = JSON.parse(token.scopes || '[]') as string[]; } catch { /* legacy */ }
  if (!scopes.length) scopes = token.scope === 'write' ? ['read', 'write'] : ['read'];
  if (!scopes.includes('write')) return off('the portal API token for the bot needs the write scope', config.allowedChatIds.size);
  if (scopes.includes('merge')) {
    console.warn('[telegram] note: the bot\'s API token has the merge scope. A token with read and write only is safer for a chat bot.');
  }

  const telegram = opts.telegram ?? apiFactory(config.botToken);
  let username: string | null = null;
  try {
    const me = await telegram.getMe();
    username = me.username ?? String(me.id);
    await telegram.setMyCommands(BOT_COMMANDS).catch(() => undefined);
  } catch (e) {
    return off(`${(e as Error).message}. Check the bot token and that this PC can reach api.telegram.org`, config.allowedChatIds.size);
  }

  running = new TelegramBridge({
    config,
    telegram,
    portal: createPortalClient(opts.baseUrl, config.portalToken),
    stateFile: path.join(opts.dataDir, 'telegram-state.json'),
    actorId: token.user_id,
  });
  running.start();
  console.log(`[telegram] bot @${username} is on, answering ${config.allowedChatIds.size} allowed chat(s)`);
  return { running: true, botUsername: username, error: null, allowedChats: config.allowedChatIds.size };
}

export async function stopTelegramBridge(): Promise<void> {
  const b = running;
  running = null;
  if (status.running) status = { ...status, running: false };
  await b?.stop();
}
