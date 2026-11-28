/**
 * The few Telegram Bot API calls the bridge uses. Long polling (getUpdates) only: no webhook,
 * so the portal needs no public address. All traffic goes out from this machine to api.telegram.org.
 */

export interface TgUser { id: number; is_bot?: boolean; username?: string; first_name?: string }
export interface TgChat { id: number; type: string }
export interface TgMessage { message_id: number; chat: TgChat; from?: TgUser; text?: string; date: number }
export interface TgUpdate { update_id: number; message?: TgMessage }

export interface TelegramApi {
  getMe(): Promise<TgUser>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
}

/** Telegram refuses messages over 4096 characters. */
export const TG_MAX_TEXT = 4000;

export function clipText(text: string, max = TG_MAX_TEXT): string {
  const t = text.trim() || '(empty)';
  return t.length <= max ? t : `${t.slice(0, max - 40).trimEnd()}\n\n… (cut, open the portal for the rest)`;
}

export class TelegramApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function createTelegramApi(botToken: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  const base = `https://api.telegram.org/bot${botToken}`;

  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetchImpl(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    let data: { ok?: boolean; result?: T; description?: string } = {};
    try { data = await res.json() as typeof data; } catch { /* handled below */ }
    if (!res.ok || !data.ok) {
      // The description never contains the bot token; the URL (which does) is never logged.
      throw new TelegramApiError(`Telegram ${method} failed: ${data.description ?? `HTTP ${res.status}`}`, res.status);
    }
    return data.result as T;
  }

  return {
    getMe: () => call<TgUser>('getMe', {}),
    getUpdates: (offset, timeoutSec, signal) =>
      call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, signal),
    sendMessage: async (chatId, text) => {
      await call('sendMessage', { chat_id: chatId, text: clipText(text), disable_web_page_preview: true });
    },
    setMyCommands: async (commands) => { await call('setMyCommands', { commands }); },
  };
}
