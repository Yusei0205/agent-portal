import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { encrypt, decrypt } from './secrets.ts';
import { getCodexStore } from './repositories/codex-store.ts';
import { invokeAgentCore } from './agent/kiro-agentcore.ts';
import { codexAccessToken } from './codex-oauth.ts';
import { nativeCredential, openDeviceCredential, sealDeviceCredential, type ChatgptAuthTokens } from './codex-device-protocol.ts';
import { HttpError } from './util.ts';

interface Pending { session: string; transportKey: string; expiresAt: number; verificationUrl?: string; userCode?: string }
interface DeviceAccount { kind: 'device'; userId: string; auth?: string; pending?: Pending }
export function codexCloudAuthMode(): 'device' | 'oauth' { return process.env.PORTAL_CODEX_AUTH_MODE === 'oauth' ? 'oauth' : 'device'; }
async function readDevice(userId: string): Promise<{ account: DeviceAccount; version: number } | null> {
  const row = await (await getCodexStore()).get(userId);
  if (!row?.ciphertext) return null;
  try {
    const account = JSON.parse(decrypt(row.ciphertext, config.secretKey));
    if (account.kind !== 'device') return null;
    if (account.userId !== userId) throw new Error();
    if (account.auth) nativeCredential(account.auth);
    return { account, version: row.version };
  } catch { throw new HttpError(400, 'Your saved Codex sign-in could not be opened. Sign in again.'); }
}
async function save(userId: string, account: DeviceAccount, version: number): Promise<boolean> {
  return (await getCodexStore()).put(userId, encrypt(JSON.stringify(account), config.secretKey), version);
}
async function request(session: string, payload: Record<string, unknown>, timeout = 55_000): Promise<any> {
  const arn = process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN;
  if (!arn) throw new HttpError(503, 'The Codex cloud runner is not configured.');
  for await (const value of invokeAgentCore(arn, session, { ...payload, attemptId: session }, AbortSignal.timeout(timeout))) {
    const event = value as Record<string, any>;
    if (event.type === 'device-auth') return event;
    if (event.type === 'error') throw new HttpError(502, typeof event.message === 'string' ? event.message : 'Codex authorization failed. Sign in again.');
  }
  throw new HttpError(502, 'The Codex authorization runner returned no result. Start sign-in again.');
}
async function stop(pending: Pending | undefined): Promise<void> {
  if (pending) await request(pending.session, { mode: 'device-cancel' }, 10_000).catch(() => {});
}
export async function startCloudCodexDevice(userId: string): Promise<object> {
  const store = await getCodexStore(), row = await store.get(userId);
  let old: Awaited<ReturnType<typeof readDevice>> = null;
  try { old = await readDevice(userId); } catch { /* a fresh sign-in replaces unreadable credentials */ }
  const pending: Pending = { session: 'codex-device-' + randomUUID(), transportKey: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 10 * 60_000 };
  const account: DeviceAccount = { kind: 'device', userId, ...(old?.account.auth ? { auth: old.account.auth } : {}), pending };
  if (!await save(userId, account, row?.version ?? 0)) throw new HttpError(409, 'Your Codex connection changed. Try starting sign-in again.');
  await stop(old?.account.pending);
  const version = (row?.version ?? 0) + 1;
  try {
    const result = await request(pending.session, { mode: 'device-start' });
    const url = new URL(result.verificationUrl);
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password
      || typeof result.userCode !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(result.userCode)) throw new Error();
    pending.verificationUrl = url.href; pending.userCode = result.userCode;
    if (!await save(userId, account, version)) throw new HttpError(409, 'The Codex connection changed while sign-in was starting. Try again.');
    return { status: 'pending', verificationUrl: pending.verificationUrl, userCode: pending.userCode };
  } catch (error) {
    // Invalidate this attempt only. A newer login or logout must win.
    const current = await readDevice(userId).catch(() => null);
    if (current?.account.pending?.session === pending.session) {
      delete current.account.pending;
      if (current.account.auth) await save(userId, current.account, current.version);
      else await store.remove(userId, current.version);
    }
    await stop(pending);
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'Could not start Codex device sign-in. Enable device-code login in your ChatGPT security settings and try again.');
  }
}
function metadata(account: DeviceAccount): { signedIn: boolean; email?: string; planType?: string } {
  if (!account.auth) return { signedIn: false };
  const credential = nativeCredential(account.auth);
  let email: string | undefined;
  try { const id = JSON.parse(account.auth).tokens.id_token; email = JSON.parse(Buffer.from(id.split('.')[1], 'base64url').toString()).email; } catch { /* optional display metadata only */ }
  return { signedIn: true, ...(typeof email === 'string' ? { email } : {}), planType: credential.tokens.chatgptPlanType };
}
export async function cloudCodexDeviceStatus(userId: string, poll = true): Promise<(ReturnType<typeof metadata> & { login?: object }) | null> {
  const current = await readDevice(userId);
  if (!current) return null;
  const { account, version } = current, pending = account.pending;
  if (!pending || !poll) return metadata(account);
  let event: any;
  if (pending.expiresAt <= Date.now()) event = { status: 'failed' };
  else event = await request(pending.session, { mode: 'device-poll', transportKey: pending.transportKey }, 15_000);
  if (event.status === 'pending') {
    // Recover the challenge even if the Lambda starting it ended before saving its response.
    const verificationUrl = event.verificationUrl || pending.verificationUrl, userCode = event.userCode || pending.userCode;
    if (!verificationUrl || !userCode) return { signedIn: false, login: { status: 'starting' } };
    const url = new URL(verificationUrl);
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password
      || typeof userCode !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(userCode)) throw new HttpError(502, 'The Codex device challenge could not be verified. Start again.');
    return { signedIn: false, login: { status: 'pending', verificationUrl: url.href, userCode } };
  }
  if (event.status === 'complete') {
    account.auth = nativeCredential(openDeviceCredential(event.envelope, pending.transportKey)).json;
    delete account.pending;
    if (!await save(userId, account, version)) {
      const next = await readDevice(userId);
      if (next && !next.account.pending) return metadata(next.account);
      return { signedIn: false };
    }
    await stop(pending);
    return metadata(account);
  }
  delete account.pending;
  if (account.auth) await save(userId, account, version); else await (await getCodexStore()).remove(userId, version);
  await stop(pending);
  return { ...metadata(account), login: { status: 'failed', error: 'Codex sign-in expired or ended. Start again and enable device-code login in ChatGPT security settings.' } };
}
export async function cancelCloudCodexDevice(userId: string, logout = false): Promise<boolean> {
  const store = await getCodexStore();
  let current: Awaited<ReturnType<typeof readDevice>>;
  try { current = await readDevice(userId); }
  catch {
    const row = await store.get(userId);
    if (row && !await store.remove(userId, row.version)) throw new HttpError(409, 'The Codex connection changed. Try again.');
    return true;
  }
  if (!current) {
    const row = await store.get(userId);
    if (row?.ciphertext) return false; // An existing hosted OAuth account uses its own revocation flow.
    if (!(row ? await store.remove(userId, row.version) : await store.put(userId, '', 0))) throw new HttpError(409, 'The Codex connection changed. Try again.');
    return true;
  }
  const { pending, ...account } = current.account;
  const changed = !logout && account.auth ? await save(userId, account, current.version) : await store.remove(userId, current.version);
  if (!changed) throw new HttpError(409, 'The Codex connection changed. Try again.');
  await stop(pending); return true;
}

export type CloudCodexAuth = { accessToken: string } | { chatgptAuthTokens: ChatgptAuthTokens };
/** Only short-lived native access tokens reach model/workspace runners. Refresh tokens stay in auth-only sessions. */
export async function cloudCodexAuth(userId: string, forceRefresh = false): Promise<CloudCodexAuth> {
  let current = await readDevice(userId);
  if (!current) return { accessToken: await codexAccessToken(userId) };
  if (!current.account.auth) throw new HttpError(400, 'Complete Codex device sign-in under Connect > Agent sign-ins.');
  let credential = nativeCredential(current.account.auth);
  if (!forceRefresh && credential.expiresAt > Date.now() + 120_000) return { chatgptAuthTokens: credential.tokens };
  const store = await getCodexStore(), owner = randomUUID();
  if (!await store.lock(userId, owner, Date.now(), Date.now() + 90_000)) throw new HttpError(409, 'Your Codex account is being renewed. Try again shortly.');
  try {
    current = await readDevice(userId);
    if (!current?.account.auth) throw new HttpError(400, 'Codex was disconnected. Sign in again.');
    credential = nativeCredential(current.account.auth);
    if (!forceRefresh && credential.expiresAt > Date.now() + 120_000) return { chatgptAuthTokens: credential.tokens };
    const transportKey = randomBytes(32).toString('base64url');
    const session = 'codex-renew-' + createHash('sha256').update(userId).digest('hex').slice(0, 40);
    const result = await request(session, { mode: 'device-refresh', envelope: sealDeviceCredential(credential.json, transportKey), transportKey });
    const next = nativeCredential(openDeviceCredential(result.envelope, transportKey));
    if (result.status !== 'complete' || next.tokens.chatgptAccountId !== credential.tokens.chatgptAccountId) throw new Error('Account changed');
    current.account.auth = next.json;
    if (!await save(userId, current.account, current.version)) throw new HttpError(409, 'Codex was changed or disconnected during renewal. Sign in again.');
    return { chatgptAuthTokens: next.tokens };
  } finally { await store.unlock(userId, owner); }
}
