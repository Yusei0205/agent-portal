import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.ts';
import { CodexClient } from './codex-client.ts';
import { router, sendJson, requireCookieAuth } from './http.ts';
import { HttpError } from './util.ts';
import { CodexRuntimeError } from './codex-command.ts';
import { codexOAuthConfiguration, startCodexOAuth, completeCodexOAuth, readCodexAccount, disconnectCodexOAuth } from './codex-oauth.ts';
import { codexCloudAuthMode, startCloudCodexDevice, cloudCodexDeviceStatus, cancelCloudCodexDevice } from './codex-device.ts';

export function codexUsesCloud(): boolean {
  return Boolean(process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN || process.env.AWS_LAMBDA_FUNCTION_NAME
    || process.env.AWS_LAMBDA_RUNTIME_API || process.env.AWS_EXECUTION_ENV?.startsWith('AWS_Lambda'));
}

export function codexRuntimeSupport(): { supported: boolean; canImportHostLogin: boolean; code?: string; error?: string } {
  if (codexUsesCloud() && !process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN) {
    return { supported: false, canImportHostLogin: false, code: 'codex_worker_required',
      error: 'Configure the dedicated Codex AgentCore runner before using Codex device sign-in on this Lambda deployment.' };
  }
  if (codexUsesCloud() && codexCloudAuthMode() === 'oauth' && !codexOAuthConfiguration()) return { supported: false, canImportHostLogin: false,
    code: 'codex_oauth_configuration_required', error: 'Configure the registered OpenAI OAuth client ID and callback URL to enable cloud Codex sign-in.' };
  if (codexUsesCloud() && process.env.STORAGE_BACKEND !== 's3') return { supported: false, canImportHostLogin: false,
    code: 'codex_storage_required', error: 'Configure S3 file storage so cloud Codex can restore conversations and workspaces.' };
  if (codexUsesCloud()) return { supported: true, canImportHostLogin: false };
  return { supported: true, canImportHostLogin: config.deployTarget !== 'cloud' };
}

/** One persistent Codex home per portal user, never the agent's writable working folder. */
export function codexHome(userId: string): string {
  return path.join(config.dataDir, 'codex', createHash('sha256').update(userId).digest('hex'));
}

/** Never inherit portal, AWS, Anthropic, or OpenAI API credentials into Codex. */
export function codexEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keys = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE',
    'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS']);
  for (const [key, value] of Object.entries(process.env)) if (keys.has(key.toUpperCase()) && value) env[key] = value;
  return env;
}

type ClientFactory = (home: string, env: NodeJS.ProcessEnv, cwd?: string) => Promise<CodexClient>;
let clientFactory: ClientFactory = CodexClient.start;
export function setCodexClientFactoryForTests(factory: ClientFactory | null): void { clientFactory = factory ?? CodexClient.start; }

export async function openUserCodex(userId: string, cwd?: string): Promise<CodexClient> {
  if (codexUsesCloud()) throw new CodexRuntimeError('codex_remote_only', 'Cloud Codex must run through the configured AgentCore runner.');
  const support = codexRuntimeSupport();
  if (!support.supported) throw new CodexRuntimeError(support.code!, support.error!);
  const home = codexHome(userId);
  try { await fs.mkdir(home, { recursive: true, mode: 0o700 }); }
  catch { throw new CodexRuntimeError('codex_storage_unwritable', 'The portal cannot create your Codex login folder. Check write permissions and the persistent data volume.'); }
  try { return await clientFactory(home, codexEnv(), cwd); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new CodexRuntimeError('codex_startup_failed', 'Codex could not initialize its app server. Check the installed CLI version and runtime configuration.', 502);
  }
}

/** Quick readiness hint only. The engine checks account/read before every run. */
export async function hasCodexLogin(userId: string): Promise<boolean> {
  if (!codexRuntimeSupport().supported) return false;
  if (codexUsesCloud()) { try { const device = await cloudCodexDeviceStatus(userId, false); return device ? device.signedIn : Boolean(await readCodexAccount(userId)); } catch { return false; } }
  try { await fs.access(path.join(codexHome(userId), 'auth.json')); return true; } catch { return false; }
}

type Login = {
  client: CodexClient; loginId?: string; verificationUrl?: string; userCode?: string;
  status: 'starting' | 'pending' | 'complete' | 'failed'; error?: string;
  timer: ReturnType<typeof setTimeout>;
};
const logins = new Map<string, Login>();
const openingLogins = new Set<string>();

function cancelLogin(userId: string): void {
  const login = logins.get(userId);
  if (!login) return;
  logins.delete(userId);
  clearTimeout(login.timer);
  login.client.close();
}

export function registerCodexRoutes(): void {
  router.get('/api/codex/status', requireCookieAuth(async (req, res) => {
    const support = codexRuntimeSupport();
    if (!support.supported) { sendJson(res, 200, { ...support, installed: null, signedIn: false }); return; }
    if (codexUsesCloud()) {
      try {
        const device = await cloudCodexDeviceStatus(req.user!.id);
        if (device) { sendJson(res, 200, { ...support, installed: null, remote: true, authMode: 'device', ...device }); return; }
        const active = await readCodexAccount(req.user!.id);
        sendJson(res, 200, { ...support, installed: null, remote: true, authMode: codexCloudAuthMode(), signedIn: Boolean(active), email: active?.account.email ?? null });
      } catch {
        sendJson(res, 200, { ...support, installed: null, remote: true, authMode: codexCloudAuthMode(), signedIn: false,
          code: 'codex_reauthentication_required', error: 'Your saved Codex connection could not be opened. Sign in again.' });
      }
      return;
    }
    const login = logins.get(req.user!.id);
    const pending = login ? { status: login.status, verificationUrl: login.verificationUrl, userCode: login.userCode, error: login.error } : null;
    // A live login owns its own account updates; avoid creating a second process while it is starting.
    if (login && (login.status === 'pending' || login.status === 'starting')) {
      sendJson(res, 200, { ...support, installed: true, signedIn: false, login: pending });
      return;
    }
    let client: CodexClient | undefined;
    try {
      client = await openUserCodex(req.user!.id);
      const result = await client.request('account/read', { refreshToken: false });
      const account = result.account;
      sendJson(res, 200, { ...support, installed: true, signedIn: account?.type === 'chatgpt',
        email: account?.type === 'chatgpt' ? account.email : null,
        planType: account?.type === 'chatgpt' ? account.planType : null, login: pending });
    } catch (error) {
      const known = error instanceof CodexRuntimeError;
      sendJson(res, 200, { ...support, installed: known && error.code === 'codex_not_installed' ? false : null,
        signedIn: false, code: known ? error.code : 'codex_status_failed',
        error: known ? error.message : 'Codex could not read your account status. Refresh status or sign in again.', login: pending });
    } finally { client?.close(); }
  }));

  router.post('/api/codex/login', requireCookieAuth(async (req, res) => {
    const userId = req.user!.id;
    if (codexUsesCloud()) {
      const support = codexRuntimeSupport();
      if (!support.supported) throw new CodexRuntimeError(support.code!, support.error!);
      if (codexCloudAuthMode() === 'device') sendJson(res, 200, await startCloudCodexDevice(userId));
      else sendJson(res, 200, { status: 'redirect', authorizationUrl: await startCodexOAuth(userId) });
      return;
    }
    if (openingLogins.has(userId) || logins.get(userId)?.status === 'starting') throw new HttpError(409, 'Codex sign-in is already starting.');
    cancelLogin(userId);
    openingLogins.add(userId);
    let client: CodexClient;
    try { client = await openUserCodex(userId); }
    finally { openingLogins.delete(userId); }
    const login: Login = { client, status: 'starting', timer: setTimeout(() => cancelLogin(userId), 15 * 60_000) };
    login.timer.unref();
    logins.set(userId, login);
    client.onClose = () => {
      if (login.status === 'pending' || login.status === 'starting') {
        login.status = 'failed'; login.error = 'Codex sign-in ended. Please try again.';
      }
    };
    client.subscribe((method, params) => {
      if (method !== 'account/login/completed') return;
      if (login.loginId && params.loginId !== login.loginId) return;
      login.status = params.success ? 'complete' : 'failed';
      if (!params.success) login.error = 'Sign-in failed. Start again and complete the device authorization.';
      client.close();
    });
    try {
      const result = await client.request('account/login/start', { type: 'chatgptDeviceCode' }, 60_000);
      const url = new URL(result.verificationUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname)) {
        throw new Error('Unexpected sign-in URL');
      }
      login.loginId = result.loginId;
      login.verificationUrl = url.href;
      login.userCode = String(result.userCode);
      if (login.status === 'starting') login.status = 'pending';
      sendJson(res, 200, { status: login.status, verificationUrl: login.verificationUrl, userCode: login.userCode });
    } catch {
      cancelLogin(userId);
      throw new HttpError(502, 'Could not start Codex device sign-in. Check that your Codex CLI is current and device-code login is enabled for your account.');
    }
  }));

  router.get('/api/codex/oauth/callback', requireCookieAuth(async (req, res) => {
    // Never log the callback URL: it contains an authorization code.
    let location = '/#/connect/sign-ins';
    try { await completeCodexOAuth(req.user!.id, req.query); }
    catch { location += '?codex_error=authorization_failed'; }
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }));

  router.post('/api/codex/login/cancel', requireCookieAuth(async (req, res) => {
    if (codexUsesCloud()) { await cancelCloudCodexDevice(req.user!.id); sendJson(res, 200, { ok: true }); return; }
    cancelLogin(req.user!.id);
    sendJson(res, 200, { ok: true });
  }));
  router.post('/api/codex/logout', requireCookieAuth(async (req, res) => {
    if (codexUsesCloud()) {
      if (await cancelCloudCodexDevice(req.user!.id, true)) { sendJson(res, 200, { ok: true }); return; }
      const revoked = await disconnectCodexOAuth(req.user!.id);
      sendJson(res, 200, { ok: true, remoteRevocationConfirmed: revoked });
      return;
    }
    cancelLogin(req.user!.id);
    const client = await openUserCodex(req.user!.id);
    try { await client.request('account/logout'); sendJson(res, 200, { ok: true }); }
    finally { client.close(); }
  }));

  // Explicit opt-in for a single-user local installation. Never share the host login implicitly.
  router.post('/api/codex/import-host-login', requireCookieAuth(async (req, res) => {
    if (!req.user!.is_admin) throw new HttpError(403, 'Only administrators can use the host Codex sign-in.');
    const support = codexRuntimeSupport();
    if (!support.canImportHostLogin) throw new HttpError(409, support.error ?? 'Host-login import is only available for local installations. Use the supported cloud sign-in flow instead.');
    cancelLogin(req.user!.id);
    const source = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    let content: string;
    try {
      content = await fs.readFile(source, 'utf8');
      const auth = JSON.parse(content);
      if (!auth.tokens?.refresh_token || (auth.auth_mode && auth.auth_mode !== 'chatgpt')) throw new Error('Not a ChatGPT sign-in');
    } catch { throw new HttpError(400, 'No reusable ChatGPT Codex sign-in found on the host. Use Sign in with ChatGPT instead.'); }
    const home = codexHome(req.user!.id);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(home, 'auth.json'), content, { mode: 0o600 });
    sendJson(res, 200, { ok: true });
  }));
}
