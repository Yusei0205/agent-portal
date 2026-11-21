import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface ChatgptAuthTokens { accessToken: string; chatgptAccountId: string; chatgptPlanType?: string }
const token = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64_000 && !/[\r\n\0]/.test(v);
export function validChatgptTokens(v: any): v is ChatgptAuthTokens {
  return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => ['accessToken', 'chatgptAccountId', 'chatgptPlanType'].includes(k))
    && token(v.accessToken) && token(v.chatgptAccountId) && v.chatgptAccountId.length <= 256
    && (v.chatgptPlanType === undefined || (typeof v.chatgptPlanType === 'string' && /^[a-z_]{1,64}$/.test(v.chatgptPlanType)));
}
/** Only accept the native ChatGPT credential format, never API keys or arbitrary config. */
export function nativeCredential(value: string): { json: string; tokens: ChatgptAuthTokens; expiresAt: number } {
  if (typeof value !== 'string' || value.length > 200_000) throw new Error('Invalid Codex credential');
  const auth = JSON.parse(value), t = auth.tokens;
  if ((auth.auth_mode && auth.auth_mode !== 'chatgpt') || auth.OPENAI_API_KEY || !t
    || !token(t.access_token) || !token(t.refresh_token) || !token(t.account_id)) throw new Error('Invalid Codex ChatGPT credential');
  let claims: any = {};
  try { claims = JSON.parse(Buffer.from(t.access_token.split('.')[1], 'base64url').toString()); } catch { /* refresh opaque or expired tokens through the native CLI */ }
  const plan = claims['https://api.openai.com/auth']?.chatgpt_plan_type;
  const tokens: ChatgptAuthTokens = { accessToken: t.access_token, chatgptAccountId: t.account_id,
    ...(typeof plan === 'string' && /^[a-z_]{1,64}$/.test(plan) ? { chatgptPlanType: plan } : {}) };
  if (!validChatgptTokens(tokens)) throw new Error('Invalid Codex account');
  return { json: JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { access_token: t.access_token, refresh_token: t.refresh_token, account_id: t.account_id,
      ...(token(t.id_token) ? { id_token: t.id_token } : {}) }, ...(typeof auth.last_refresh === 'string' ? { last_refresh: auth.last_refresh } : {}) }),
    tokens, expiresAt: typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : 0 };
}

function key(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value || '')) throw new Error('Invalid credential transport key');
  return Buffer.from(value, 'base64url');
}
/** The internal IAM-authenticated runner stream carries only sealed renewable credentials. */
export function sealDeviceCredential(value: string, transportKey: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(transportKey), iv);
  cipher.setAAD(Buffer.from('agent-portal-codex-device-v1'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function openDeviceCredential(value: string, transportKey: string): string {
  if (typeof value !== 'string' || value.length > 300_000) throw new Error('Invalid credential envelope');
  const bytes = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key(transportKey), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from('agent-portal-codex-device-v1')); decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
