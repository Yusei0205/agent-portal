import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one, insert } from '../server/db.ts';
import { generateId } from '../server/util.ts';
import { encrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';
import { resolveCredentialEnv } from '../server/credentials.ts';
import { callCursorText } from '../server/agent/cursor-text.ts';
import { pickTextEngine } from '../server/testing/model-provider.ts';
import { sessionSignIn } from '../server/session-sign-in.ts';

const KEY = 'crsr_portal_key_9999';

describe('Cursor as the portal provider (Settings > Model provider)', () => {
  let baseUrl = '', cookie = '', userId = '';
  const put = (body: object) => fetchJson(baseUrl, '/api/settings', { method: 'PUT', body, cookie });

  before(async () => {
    process.env.PORTAL_CURSOR_FAKE = path.resolve('test/fake-cursor.mjs');
    const ts = await createTestServer(); baseUrl = ts.baseUrl;
    cookie = (await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: 'pv@example.com', name: 'P', password: 'password1234', provider: 'demo' } })).cookie ?? '';
    userId = String(one<{ id: string }>("SELECT id FROM users WHERE email = 'pv@example.com'")!.id);
  });
  after(async () => { delete process.env.PORTAL_CURSOR_FAKE; await cleanup(); });

  it('accepts Cursor as the provider and stores its key encrypted, never returning it', async () => {
    const r = await put({ provider: { mode: 'cursor' }, cursorApiKey: KEY });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const view = (await fetchJson(baseUrl, '/api/settings', { cookie })).body as any;
    assert.equal(view.provider.mode, 'cursor');
    assert.equal(view.cursorApiKeySet, true);
    assert.ok(!JSON.stringify(view).includes(KEY), 'the key is never returned');
    const row = one<any>("SELECT value FROM settings WHERE key = 'cursor.key.enc'")!;
    assert.ok(!String(row.value).includes('9999'), 'stored encrypted');
    assert.equal((await put({ provider: { mode: 'not-a-provider' } })).status, 400);
    assert.equal((await put({ cursorApiKey: '***' })).status, 200, 'the masked value does not overwrite the key');
    assert.equal(one<any>("SELECT value FROM settings WHERE key = 'cursor.key.enc'")!.value, row.value);
  });

  it('tests the connection and lists models through the portal key', async () => {
    const t = await fetchJson(baseUrl, '/api/settings/test', { method: 'POST', body: { modeOverride: 'cursor' }, cookie });
    assert.equal((t.body as any).ok, true, JSON.stringify(t.body));
    assert.deepEqual((t.body as any).models, ['auto', 'composer-2.5', 'grok-4.7-low-fast']);
    const m = await fetchJson(baseUrl, '/api/settings/models?provider=cursor', { cookie });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal((m.body as any).groups[0].models.length, 3);
  });

  it('gives a Cursor session with no sign-in of its own the portal key, and says so', async () => {
    assert.deepEqual(await resolveCredentialEnv('cursor', userId, null), { ...(await resolveCredentialEnv('cursor', userId, null)), CURSOR_API_KEY: KEY });
    const mine = generateId();
    insert('engine_credentials', { id: mine, user_id: userId, engine: 'cursor', name: 'mine', mode: 'api_key', secret_enc: encrypt('crsr_personal_1234', config.secretKey), is_default: 1, last4: '1234' });
    assert.equal((await resolveCredentialEnv('cursor', userId, null)).CURSOR_API_KEY, 'crsr_personal_1234', 'a personal key wins over the portal one');
    assert.equal((await sessionSignIn({ engine: 'cursor', created_by: userId }))?.label, 'Cursor API key');
    assert.equal((await sessionSignIn({ engine: 'cursor', created_by: 'someone-else' }))?.label, 'Portal Cursor key');
  });

  it('writes AI text through Cursor: one answer, with the key but no tools', async () => {
    const text = await callCursorText('ECHO_KEY', 'someone-else', null);
    assert.ok(text.includes(`key=${KEY}`), text);
    assert.equal(await pickTextEngine(userId, null), 'cursor', 'a person whose only sign-in is Cursor gets Cursor text');
    assert.equal(await pickTextEngine('someone-else', null), null, 'with no sign-in the portal provider decides');
  });
});
