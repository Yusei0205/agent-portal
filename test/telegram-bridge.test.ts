/**
 * Telegram bridge: settings, the chat allowlist, and the commands end to end against a real
 * test portal (demo engine) with a fake Telegram.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { readTelegramConfig } from '../server/telegram/config.ts';
import { TelegramBridge, parseCommand, lastReply } from '../server/telegram/bot.ts';
import { createPortalClient, type PortalClient } from '../server/telegram/portal-client.ts';
import { clipText, type TelegramApi, type TgMessage, type TgUpdate } from '../server/telegram/telegram-api.ts';
import { startTelegramBridge, stopTelegramBridge, setTelegramApiFactory } from '../server/telegram/index.ts';

const BOT_TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-ra';
const ME = '1111';

function fakeTelegram() {
  const sent: Array<{ chatId: string; text: string }> = [];
  const api: TelegramApi = {
    getMe: async () => ({ id: 42, is_bot: true, username: 'kyuubit_test_bot' }),
    getUpdates: (_o: number, _t: number, signal?: AbortSignal) => new Promise<TgUpdate[]>((resolve) => {
      signal?.addEventListener('abort', () => resolve([]), { once: true });
    }),
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); },
    setMyCommands: async () => undefined,
  };
  return { api, sent };
}

let n = 0;
function msg(text: string, chatId = ME, type = 'private'): TgMessage {
  return { message_id: ++n, date: 0, chat: { id: Number(chatId), type }, from: { id: Number(chatId) }, text };
}

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_ALLOWED_CHAT_IDS: `${ME}, 2222`,
  TELEGRAM_PORTAL_TOKEN: 'ap_0123456789abcdef0123456789abcdef',
  ...extra,
});

describe('readTelegramConfig', () => {
  test('off without a bot token, and not reported as a problem', () => {
    const r = readTelegramConfig({});
    assert.equal(r.enabled, false);
    assert.equal(r.enabled === false && r.misconfigured, false);
  });

  test('reads a full configuration', () => {
    const r = readTelegramConfig(env({ TELEGRAM_DEFAULT_ENGINE: 'codex' }));
    assert.equal(r.enabled, true);
    if (!r.enabled) return;
    assert.deepEqual([...r.config.allowedChatIds], [ME, '2222']);
    assert.equal(r.config.defaultEngine, 'codex');
  });

  test('refuses an empty allowlist, a bad chat ID, a non-portal token and an unknown engine', () => {
    for (const bad of <Array<Record<string, string>>>[
      { TELEGRAM_ALLOWED_CHAT_IDS: '' },
      { TELEGRAM_ALLOWED_CHAT_IDS: '123,@me' },
      { TELEGRAM_PORTAL_TOKEN: 'secret' },
      { TELEGRAM_DEFAULT_ENGINE: 'gpt' },
      { TELEGRAM_BOT_TOKEN: 'not-a-token' },
    ]) {
      const r = readTelegramConfig(env(bad));
      assert.equal(r.enabled, false, JSON.stringify(bad));
      assert.equal(r.enabled === false && r.misconfigured, true, JSON.stringify(bad));
    }
  });

  test('never runs on Lambda, and TELEGRAM_ENABLED=0 turns it off', () => {
    assert.equal(readTelegramConfig(env({ AWS_LAMBDA_FUNCTION_NAME: 'portal' })).enabled, false);
    assert.equal(readTelegramConfig(env({ TELEGRAM_ENABLED: '0' })).enabled, false);
  });
});

describe('helpers', () => {
  test('parseCommand', () => {
    assert.deepEqual(parseCommand('/new fix the  login bug'), { command: 'new', args: 'fix the  login bug' });
    assert.deepEqual(parseCommand('/status@kyuubit_bot'), { command: 'status', args: '' });
    assert.deepEqual(parseCommand('hello /there'), { command: null, args: '' });
    assert.deepEqual(parseCommand('/src/app.ts fails'), { command: null, args: '' });
  });

  test('lastReply prefers the run result, then the newest text of that run', () => {
    const ev = (kind: string, payload: unknown, run_id = 'r1') => ({ src: 'r', kind, payload, run_id, created_at: '' });
    assert.equal(lastReply([ev('assistant-text', { text: 'newest' }), ev('assistant-text', { text: 'older' })], 'r1'), 'newest');
    assert.equal(lastReply([ev('run-complete', { result: 'final' }), ev('assistant-text', { text: 'x' })], 'r1'), 'final');
    assert.equal(lastReply([ev('assistant-text', { text: 'other run' }, 'r0')], 'r1'), null);
  });

  test('clipText keeps messages under the Telegram limit', () => {
    assert.ok(clipText('x'.repeat(10_000)).length <= 4000);
    assert.equal(clipText('  '), '(empty)');
  });
});

describe('bridge against a running portal', () => {
  let baseUrl: string;
  let cookie: string;
  let token: string;
  let readToken: string;
  let projectId: string;
  let portal: PortalClient;

  before(async () => {
    ({ baseUrl } = await createTestServer());
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'tg@example.com', password: 'adminpassword1', name: 'TG' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'tg@example.com', password: 'adminpassword1' } })).cookie ?? '';
    token = String(((await fetchJson(baseUrl, '/api/api-tokens', { body: { name: 'telegram', scopes: ['write'] }, cookie })).body as { token: string }).token);
    readToken = String(((await fetchJson(baseUrl, '/api/api-tokens', { body: { name: 'read only', scope: 'read' }, cookie })).body as { token: string }).token);
    const p = await fetchJson(baseUrl, '/api/projects', { body: { name: 'Remote project' }, cookie });
    projectId = String((p.body as { project: { id: string } }).project.id);
    portal = createPortalClient(baseUrl, token);
  });
  after(cleanup);

  function bridge(tg = fakeTelegram(), client: PortalClient = portal) {
    const cfg = readTelegramConfig(env({ TELEGRAM_PORTAL_TOKEN: token }));
    assert.ok(cfg.enabled);
    const b = new TelegramBridge({
      config: cfg.config, telegram: tg.api, portal: client, stateFile: null,
      log: () => undefined, watchIntervalMs: 50, watchMaxMs: 20_000,
    });
    return { b, sent: tg.sent };
  }

  test('ignores chats that are not on the allowlist, and group chats', async () => {
    let calls = 0;
    const spy = new Proxy(portal, { get: (t, k) => { calls++; return t[k as keyof PortalClient]; } });
    const { b, sent } = bridge(fakeTelegram(), spy);
    await b.handleMessage(msg('/projects', '9999'));
    await b.handleMessage(msg('/projects', ME, 'group'));
    assert.equal(sent.length, 0);
    assert.equal(calls, 0);
  });

  test('pick a project, start a session, get its reply, then message it again', async () => {
    const { b, sent } = bridge();
    await b.handleMessage(msg('/projects'));
    assert.match(sent.at(-1)!.text, /1\. Remote project/);
    await b.handleMessage(msg('/project 1'));
    assert.match(sent.at(-1)!.text, /Project: Remote project/);

    await b.handleMessage(msg('/new demo say hello'));
    assert.match(sent.at(-1)!.text, /Started a demo session/);
    await b.idle();
    const done = sent.at(-1)!.text;
    assert.match(done, /say hello: finished/);
    assert.match(done, /AGENT_PLAN\.md/);

    const before = sent.length;
    await b.handleMessage(msg('and now a follow-up'));
    assert.equal(sent.length, before, 'no noise while the turn runs');
    await b.idle();
    assert.equal(sent.length, before + 1);
    assert.match(sent.at(-1)!.text, /finished/);

    await b.handleMessage(msg('/status'));
    assert.match(sent.at(-1)!.text, /Status: finished/);
    await b.handleMessage(msg('/sessions'));
    assert.match(sent.at(-1)!.text, /1\. say hello .*\(picked\)/);
    await b.handleMessage(msg('/stop'));
    assert.match(sent.at(-1)!.text, /is not running/);
    await b.handleMessage(msg('/inbox'));
    assert.match(sent.at(-1)!.text, /Nothing is waiting/);
  });

  test('/newproject creates a project, picks it, and a session can start in it', async () => {
    const { b, sent } = bridge();
    await b.handleMessage(msg('/newproject'));
    assert.match(sent.at(-1)!.text, /Give it a name/);
    await b.handleMessage(msg('/newproject   Phone   project '));
    assert.match(sent.at(-1)!.text, /Created the project Phone project and picked it/);
    const projects = await portal.listProjects();
    const created = projects.find((p) => p.name === 'Phone project');
    assert.ok(created, 'the project exists in the portal');
    await b.handleMessage(msg('/new demo first task'));
    assert.match(sent.at(-1)!.text, /Started a demo session/);
    await b.idle();
    const sessions = await portal.listWorkflows(created!.id);
    assert.equal(sessions.length, 1);
    await b.handleMessage(msg('/projects'));
    assert.match(sent.at(-1)!.text, /Phone project  \(picked\)/);
  });

  test('stop asks first, and only "yes" stops the session', async () => {
    const cancelled: string[] = [];
    const running: PortalClient = {
      ...portal,
      listProjects: async () => [{ id: 'p1', name: 'P' }],
      getWorkflow: async () => ({
        workflow: { id: 'w1', project_id: 'p1', title: 'Long job', goal: '', status: 'running', stop_reason: '', engine: 'demo', updated_at: '' },
        latestRun: { id: 'r1', status: 'running' },
      }),
      cancel: async (_p, w) => { cancelled.push(w); },
      message: async () => { throw new Error('should not be sent'); },
    };
    const { b, sent } = bridge(fakeTelegram(), running);
    await b.handleMessage(msg('/projects'));
    await b.handleMessage(msg('/project 1'));
    await b.handleMessage(msg('/session w1'));
    await b.handleMessage(msg('/stop'));
    assert.match(sent.at(-1)!.text, /Reply yes/);
    await b.handleMessage(msg('no'));
    assert.equal(sent.at(-1)!.text, 'Not stopped.');
    assert.deepEqual(cancelled, []);
    await b.handleMessage(msg('/stop'));
    await b.handleMessage(msg('yes'));
    assert.match(sent.at(-1)!.text, /^Stopped/);
    assert.deepEqual(cancelled, ['w1']);
  });

  test('a read-only token gets the portal\'s refusal back', async () => {
    const { b, sent } = bridge(fakeTelegram(), createPortalClient(baseUrl, readToken));
    await b.handleMessage(msg('/projects'));
    await b.handleMessage(msg('/project 1'));
    await b.handleMessage(msg('/new demo anything'));
    assert.match(sent.at(-1)!.text, /The portal said: write scope required/);
    await b.handleMessage(msg('/newproject Not allowed'));
    assert.match(sent.at(-1)!.text, /The portal said: write scope required/);
    assert.ok(!(await portal.listProjects()).some((p) => p.name === 'Not allowed'));
  });

  test('startTelegramBridge checks the portal token before starting', async () => {
    const tg = fakeTelegram();
    assert.equal(await startTelegramBridge({ baseUrl, dataDir: '/tmp', env: env({ TELEGRAM_PORTAL_TOKEN: 'ap_doesnotexist' }), telegram: tg.api }), null);
    assert.equal(await startTelegramBridge({ baseUrl, dataDir: '/tmp', env: env({ TELEGRAM_PORTAL_TOKEN: readToken }), telegram: tg.api }), null);
    const b = await startTelegramBridge({ baseUrl, dataDir: '/tmp', env: env({ TELEGRAM_PORTAL_TOKEN: token }), telegram: tg.api });
    assert.ok(b);
    await stopTelegramBridge();
  });
});

describe('Connect > Telegram settings (saved in the portal, applied without a restart)', () => {
  let baseUrl: string;
  let cookie: string;
  let userCookie: string;

  before(async () => {
    setTelegramApiFactory(() => fakeTelegram().api);
    ({ baseUrl } = await createTestServer());
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'tgadmin@example.com', password: 'adminpassword1', name: 'Admin' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'tgadmin@example.com', password: 'adminpassword1' } })).cookie ?? '';
    await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: 'tguser@example.com', name: 'U', password: 'userpassword1', isAdmin: false }, cookie });
    userCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'tguser@example.com', password: 'userpassword1' } })).cookie ?? '';
  });
  after(async () => { await stopTelegramBridge(); setTelegramApiFactory(null); await cleanup(); });

  test('admins only, and never with an API token', async () => {
    assert.equal((await fetchJson(baseUrl, '/api/telegram', { cookie: userCookie })).status, 403);
    const tok = String(((await fetchJson(baseUrl, '/api/api-tokens', { body: { name: 'x', scopes: ['write'] }, cookie })).body as { token: string }).token);
    assert.equal((await fetchJson(baseUrl, '/api/telegram', { headers: { Authorization: `Bearer ${tok}` } })).status, 403);
  });

  test('save, create the bot\'s access, test, turn off, forget', async () => {
    let r = await fetchJson(baseUrl, '/api/telegram', { cookie });
    assert.equal(r.status, 200);
    assert.equal((r.body as { saved: boolean }).saved, false);

    r = await fetchJson(baseUrl, '/api/telegram', { method: 'PUT', cookie, body: { botToken: BOT_TOKEN, allowedChatIds: '12, abc' } });
    assert.equal(r.status, 400);
    assert.match(String((r.body as { error: string }).error), /abc/);

    r = await fetchJson(baseUrl, '/api/telegram', { method: 'PUT', cookie, body: { botToken: BOT_TOKEN, allowedChatIds: `${ME}, 2222`, defaultEngine: 'demo' } });
    assert.equal(r.status, 200);
    let b = r.body as Record<string, any>;
    assert.equal(b.saved, true);
    assert.equal(b.botTokenHint, `…${BOT_TOKEN.slice(-4)}`);
    assert.deepEqual(b.allowedChatIds, [ME, '2222']);
    assert.equal(b.status.running, false, 'no portal access yet');
    assert.match(String(b.status.error), /API token/);

    r = await fetchJson(baseUrl, '/api/telegram/token', { method: 'POST', cookie, body: {} });
    assert.equal(r.status, 201);
    b = r.body as Record<string, any>;
    assert.equal(b.portalToken.valid, true);
    assert.equal(b.status.running, true);
    assert.equal(b.status.source, 'portal');
    assert.equal(b.status.botUsername, 'kyuubit_test_bot');
    const raw = JSON.stringify(b);
    assert.ok(!raw.includes(BOT_TOKEN) && !/ap_[0-9a-f]{32}/.test(raw), 'secrets never go back to the browser');

    // Replacing the access revokes the old token: only one "Telegram bot" token is live.
    await fetchJson(baseUrl, '/api/telegram/token', { method: 'POST', cookie, body: {} });
    const list = (await fetchJson(baseUrl, '/api/api-tokens', { cookie })).body as { tokens: Array<{ name: string; active: boolean }> };
    assert.equal(list.tokens.filter((t) => t.name === 'Telegram bot' && t.active).length, 1);

    r = await fetchJson(baseUrl, '/api/telegram/test', { method: 'POST', cookie, body: {} });
    assert.deepEqual(r.body, { ok: true, botUsername: 'kyuubit_test_bot' });

    r = await fetchJson(baseUrl, '/api/telegram', { method: 'PUT', cookie, body: { enabled: false } });
    b = r.body as Record<string, any>;
    assert.equal(b.status.running, false);
    assert.equal(b.status.error, null);
    r = await fetchJson(baseUrl, '/api/telegram', { method: 'PUT', cookie, body: { enabled: true } });
    assert.equal((r.body as Record<string, any>).status.running, true, 'back on without a portal restart');

    r = await fetchJson(baseUrl, '/api/telegram', { method: 'DELETE', cookie });
    b = r.body as Record<string, any>;
    assert.equal(b.saved, false);
    assert.equal(b.status.running, false);
    const after = (await fetchJson(baseUrl, '/api/api-tokens', { cookie })).body as { tokens: Array<{ name: string; active: boolean }> };
    assert.equal(after.tokens.filter((t) => t.name === 'Telegram bot' && t.active).length, 0, 'the bot\'s access is revoked');
  });
});
