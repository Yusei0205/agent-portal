import fs from 'node:fs/promises';
import path from 'node:path';
import { CodexClient } from '../../server/codex-client.ts';
import { nativeCredential, openDeviceCredential, sealDeviceCredential } from '../../server/codex-device-protocol.ts';

type Login = { id: string; client: CodexClient; home: string; status: 'pending' | 'complete' | 'failed';
  challenge?: { verificationUrl: string; userCode: string }; timer: ReturnType<typeof setTimeout>; finishing?: Promise<void> };
/** Auth-only session: no repositories, shell tools, model turns, or workspace inspection. */
export function deviceAuthHandler(root: string, open: typeof CodexClient.start, environment: () => NodeJS.ProcessEnv) {
  let login: Login | null = null, busy = false, bound: string | null = null;
  const close = async (value: Login) => { value.client.close(); await value.client.waitClosed(); };
  const dispose = async () => {
    if (!login) return;
    const old = login; login = null; clearTimeout(old.timer);
    await close(old); await fs.rm(old.home, { recursive: true, force: true });
  };
  const handle = async (body: Record<string, any>): Promise<Record<string, any>> => {
    if (typeof body.attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.attemptId)
      || (bound && bound !== body.attemptId)) throw new Error('Invalid Codex authorization attempt');
    if (busy) {
      if (body.mode === 'device-poll') return { status: 'pending', ...login?.challenge };
      throw new Error('Codex authorization is busy; try again.');
    }
    bound = body.attemptId; busy = true;
    try {
      if (body.mode === 'device-cancel') { await dispose(); return { status: 'cancelled' }; }
      if (body.mode === 'device-start') {
        if (login) return { status: login.status, ...login.challenge };
        const home = path.join(root, 'device-auth');
        await fs.rm(home, { recursive: true, force: true }); await fs.mkdir(home, { recursive: true, mode: 0o700 });
        const client = await open(home, environment(), home);
        const value: Login = { id: body.attemptId, client, home, status: 'pending', timer: setTimeout(() => { void dispose().catch(() => {}); }, 10 * 60_000) };
        value.timer.unref(); login = value;
        client.onClose = () => { if (value.status === 'pending') value.status = 'failed'; };
        client.subscribe((method, params) => {
          if (method !== 'account/login/completed') return;
          value.status = params.success ? 'complete' : 'failed';
          value.finishing = close(value);
          void value.finishing.catch(() => { value.status = 'failed'; });
        });
        try {
          const challenge = await client.request('account/login/start', { type: 'chatgptDeviceCode' }, 45_000);
          const url = new URL(challenge.verificationUrl);
          if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password
            || typeof challenge.userCode !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(challenge.userCode)) throw new Error('Invalid device challenge');
          value.challenge = { verificationUrl: url.href, userCode: challenge.userCode };
          return { status: 'pending', ...value.challenge };
        } catch { await dispose(); throw new Error('Could not start Codex device sign-in. Enable device-code login in your ChatGPT security settings and try again.'); }
      }
      if (body.mode === 'device-poll') {
        if (!login || login.status === 'failed') return { status: 'failed' };
        if (login.status !== 'complete') return { status: 'pending', ...login.challenge };
        await login.finishing;
        const credential = nativeCredential(await fs.readFile(path.join(login.home, 'auth.json'), 'utf8'));
        return { status: 'complete', envelope: sealDeviceCredential(credential.json, body.transportKey) };
      }
      if (body.mode === 'device-refresh') {
        if (login) throw new Error('Authorization session is already used');
        const home = path.join(root, 'device-refresh');
        const credential = nativeCredential(openDeviceCredential(body.envelope, body.transportKey));
        await fs.mkdir(home, { recursive: true, mode: 0o700 });
        let client: CodexClient | undefined;
        try {
          await fs.writeFile(path.join(home, 'auth.json'), credential.json, { mode: 0o600 });
          client = await open(home, environment(), home);
          const result = await client.request('account/read', { refreshToken: true }, 45_000);
          if (result.account?.type !== 'chatgpt') throw new Error('Account is no longer connected');
          client.close(); await client.waitClosed(); client = undefined;
          const next = nativeCredential(await fs.readFile(path.join(home, 'auth.json'), 'utf8'));
          if (next.tokens.chatgptAccountId !== credential.tokens.chatgptAccountId) throw new Error('Account changed during renewal');
          return { status: 'complete', envelope: sealDeviceCredential(next.json, body.transportKey) };
        } finally { if (client) { client.close(); await client.waitClosed(); } await fs.rm(home, { recursive: true, force: true }); }
      }
      throw new Error('Unsupported authorization request');
    } finally { busy = false; }
  };
  return { handle, active: () => busy || login?.status === 'pending' };
}
