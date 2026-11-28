/**
 * Telegram settings saved from the portal (Connect > Telegram). The whole record, including the
 * bot token and the bot's portal API token, is kept as one encrypted secret and never sent back
 * to the browser; the page sees only the last characters of each token.
 */

import { getSecret, setSecret, deleteSecret } from '../secrets.ts';
import type { BridgeEngine } from './config.ts';

const SECRET_NAME = 'telegram.settings';

export interface SavedTelegramSettings {
  enabled: boolean;
  botToken: string;
  allowedChatIds: string[];
  defaultEngine: BridgeEngine | null;
  /** The portal API token the bot acts with, created from the Telegram page. */
  portalToken: string;
  portalTokenId: string | null;
}

export async function loadSavedTelegramSettings(): Promise<SavedTelegramSettings | null> {
  const raw = await getSecret(SECRET_NAME).catch(() => null);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<SavedTelegramSettings>;
    return {
      enabled: s.enabled !== false,
      botToken: String(s.botToken ?? ''),
      allowedChatIds: Array.isArray(s.allowedChatIds) ? s.allowedChatIds.map(String) : [],
      defaultEngine: (s.defaultEngine ?? null) as BridgeEngine | null,
      portalToken: String(s.portalToken ?? ''),
      portalTokenId: s.portalTokenId ? String(s.portalTokenId) : null,
    };
  } catch {
    return null;
  }
}

export async function saveTelegramSettings(s: SavedTelegramSettings): Promise<void> {
  await setSecret(SECRET_NAME, JSON.stringify(s));
}

export async function clearTelegramSettings(): Promise<void> {
  await deleteSecret(SECRET_NAME);
}

/** The saved settings in the shape readTelegramConfig() reads, so both sources are checked the same way. */
export function savedSettingsAsEnv(s: SavedTelegramSettings): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: s.botToken,
    TELEGRAM_ENABLED: s.enabled ? '1' : '0',
    TELEGRAM_ALLOWED_CHAT_IDS: s.allowedChatIds.join(','),
    TELEGRAM_PORTAL_TOKEN: s.portalToken,
    TELEGRAM_DEFAULT_ENGINE: s.defaultEngine ?? '',
  };
}

export function tail(secret: string): string | null {
  return secret ? `…${secret.slice(-4)}` : null;
}
