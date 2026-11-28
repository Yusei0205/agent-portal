/**
 * Telegram bridge settings, read from the environment (.env).
 *
 *   TELEGRAM_BOT_TOKEN         the token @BotFather gives for the bot
 *   TELEGRAM_ALLOWED_CHAT_IDS  comma-separated numeric chat IDs that may use the bot (private chats only)
 *   TELEGRAM_PORTAL_TOKEN      a portal API token (ap_…) with the write scope: the bot acts as its owner
 *   TELEGRAM_DEFAULT_ENGINE    optional engine for /new (claude-code, kiro, codex, cursor, demo)
 *   TELEGRAM_ENABLED           optional: 0 turns the bridge off without removing the settings
 *
 * The bridge only runs in a long-lived local process, never on Lambda.
 */

export const ENGINES = ['claude-code', 'kiro', 'codex', 'cursor', 'demo'] as const;
export type BridgeEngine = (typeof ENGINES)[number];

export interface TelegramConfig {
  botToken: string;
  allowedChatIds: Set<string>;
  portalToken: string;
  defaultEngine: BridgeEngine | null;
}

export type TelegramConfigResult =
  | { enabled: true; config: TelegramConfig }
  | { enabled: false; reason: string; misconfigured: boolean };

const BOT_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID_RE = /^-?\d{1,20}$/;

export function readTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfigResult {
  const botToken = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!botToken) return { enabled: false, reason: 'TELEGRAM_BOT_TOKEN is not set', misconfigured: false };
  if (env.TELEGRAM_ENABLED === '0' || env.TELEGRAM_ENABLED === 'false') {
    return { enabled: false, reason: 'TELEGRAM_ENABLED is off', misconfigured: false };
  }
  if (Boolean(env.AWS_LAMBDA_FUNCTION_NAME) || env.PORTAL_JOB_RUNNER === '1') {
    return { enabled: false, reason: 'the Telegram bridge runs only in a local portal, not on Lambda', misconfigured: false };
  }
  if (!BOT_TOKEN_RE.test(botToken)) {
    return { enabled: false, reason: 'TELEGRAM_BOT_TOKEN does not look like a bot token from @BotFather', misconfigured: true };
  }

  const rawIds = (env.TELEGRAM_ALLOWED_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const bad = rawIds.filter((s) => !CHAT_ID_RE.test(s));
  if (bad.length) {
    return { enabled: false, reason: `TELEGRAM_ALLOWED_CHAT_IDS has values that are not chat IDs: ${bad.join(', ')}`, misconfigured: true };
  }
  if (!rawIds.length) {
    return {
      enabled: false,
      reason: 'TELEGRAM_ALLOWED_CHAT_IDS is empty, so nobody could use the bot. Add your own chat ID',
      misconfigured: true,
    };
  }

  const portalToken = (env.TELEGRAM_PORTAL_TOKEN ?? '').trim();
  if (!portalToken.startsWith('ap_')) {
    return {
      enabled: false,
      reason: 'TELEGRAM_PORTAL_TOKEN must be a portal API token (starts with ap_) with the write scope',
      misconfigured: true,
    };
  }

  const engineRaw = (env.TELEGRAM_DEFAULT_ENGINE ?? '').trim();
  let defaultEngine: BridgeEngine | null = null;
  if (engineRaw) {
    if (!(ENGINES as readonly string[]).includes(engineRaw)) {
      return { enabled: false, reason: `TELEGRAM_DEFAULT_ENGINE must be one of: ${ENGINES.join(', ')}`, misconfigured: true };
    }
    defaultEngine = engineRaw as BridgeEngine;
  }

  return { enabled: true, config: { botToken, allowedChatIds: new Set(rawIds), portalToken, defaultEngine } };
}
