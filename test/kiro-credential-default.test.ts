/**
 * A person who signed in to Kiro (for example with AWS IAM Identity Center) but never marked the sign-in as their default
 * must still get it everywhere Kiro is used, not "No Kiro credentials are configured".
 *
 *   - findUserCredential: the default wins; for Kiro the oldest usable sign-in is the fallback; Claude Code has no fallback
 *   - the first Kiro sign-in a person adds becomes their default; deleting the default promotes the next one
 *   - the models list the Automations run options use finds an unmarked Kiro sign-in
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { encrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';
import { now, generateId } from '../server/util.ts';
import { _clearEngineModelCache } from '../server/models.ts';
import { findUserCredential } from '../server/credential-default.ts';

interface Seed { engine?: 'kiro' | 'claude-code'; mode?: string; isDefault?: boolean; secret?: boolean; createdAt?: string; name?: string }

function seed(userId: string, o: Seed = {}): string {
  const id = generateId();
  const at = o.createdAt ?? now();
  getDb().prepare(
    `INSERT INTO engine_credentials (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '{"region":"us-east-1","clientId":"c","signedInAt":"2026-11-08T00:00:00Z"}', ?, '1234', ?, ?)`,
  ).run(id, userId, o.engine ?? 'kiro', o.name ?? 'cred', o.mode ?? 'identity_center', o.secret === false ? null : encrypt('token', config.secretKey), o.isDefault ? 1 : 0, at, at);
  return id;
}

async function setup(baseUrl: string): Promise<{ cookie: string; userId: string }> {
  const email = `kiro-${Date.now()}@test.com`;
  const r = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email, name: 'Kiro User', password: 'password1234' } });
  assert.equal(r.status, 200);
  const row = getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string };
  return { cookie: r.cookie ?? '', userId: row.id };
}

describe('findUserCredential', () => {
  let userId = '';
  let otherId = '';
  before(async () => {
    const ts = await createTestServer();
    ({ userId } = await setup(ts.baseUrl));
    otherId = generateId();
    getDb().prepare(`INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, 'Other', 'x', 0, ?)`).run(otherId, `other-${Date.now()}@test.com`, now());
  });
  after(async () => { await cleanup(); });
  beforeEach(() => { getDb().prepare('DELETE FROM engine_credentials').run(); delete process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN; });

  it('returns the one marked as the default', async () => {
    seed(userId, { name: 'older', createdAt: '2026-01-01T00:00:00Z' });
    const marked = seed(userId, { name: 'marked', isDefault: true, createdAt: '2026-02-01T00:00:00Z' });
    assert.equal((await findUserCredential(userId, 'kiro'))?.id, marked);
  });

  it('falls back to the oldest usable Kiro sign-in when none is marked', async () => {
    const first = seed(userId, { createdAt: '2026-01-01T00:00:00Z' });
    seed(userId, { createdAt: '2026-02-01T00:00:00Z' });
    assert.equal((await findUserCredential(userId, 'kiro'))?.id, first);
  });

  it('skips a half-finished sign-in that has no token yet', async () => {
    seed(userId, { secret: false, createdAt: '2026-01-01T00:00:00Z' });
    const ready = seed(userId, { createdAt: '2026-02-01T00:00:00Z' });
    assert.equal((await findUserCredential(userId, 'kiro'))?.id, ready);
  });

  it('on the cloud portal prefers an Identity Center sign-in over an older API key', async () => {
    process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/kiro';
    seed(userId, { mode: 'api_key', createdAt: '2026-01-01T00:00:00Z' });
    const sso = seed(userId, { mode: 'identity_center', createdAt: '2026-02-01T00:00:00Z' });
    assert.equal((await findUserCredential(userId, 'kiro'))?.id, sso);
  });

  it('returns nothing for a person with no Kiro sign-in, and never another person\'s', async () => {
    seed(otherId, { isDefault: true });
    assert.equal(await findUserCredential(userId, 'kiro'), null);
    assert.equal(await findUserCredential(null, 'kiro'), null);
  });

  it('does not guess for Claude Code, which can fall back to the portal\'s own account', async () => {
    seed(userId, { engine: 'claude-code', mode: 'api_key' });
    assert.equal(await findUserCredential(userId, 'claude-code'), null);
  });
});

describe('Kiro sign-ins and the default', () => {
  let baseUrl = '';
  let cookie = '';
  let userId = '';
  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, userId } = await setup(baseUrl));
  });
  after(async () => { await cleanup(); _clearEngineModelCache(); });
  beforeEach(() => { getDb().prepare('DELETE FROM engine_credentials').run(); _clearEngineModelCache(); });

  const isDefault = (id: string): number => (getDb().prepare('SELECT is_default AS d FROM engine_credentials WHERE id = ?').get(id) as { d: number }).d;

  it('the first Kiro sign-in a person adds becomes their default; the next one does not', async () => {
    const a = await fetchJson(baseUrl, '/api/credentials', { method: 'POST', cookie, body: { engine: 'kiro', mode: 'api_key', name: 'first', secret: 'key-aaaa' } });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const b = await fetchJson(baseUrl, '/api/credentials', { method: 'POST', cookie, body: { engine: 'kiro', mode: 'api_key', name: 'second', secret: 'key-bbbb' } });
    const idA = ((a.body as { credential: { id: string } }).credential).id;
    const idB = ((b.body as { credential: { id: string } }).credential).id;
    assert.equal(isDefault(idA), 1);
    assert.equal(isDefault(idB), 0);
  });

  it('the first Kiro sign-in is the default even when the form sends isDefault: false', async () => {
    const a = await fetchJson(baseUrl, '/api/credentials', { method: 'POST', cookie, body: { engine: 'kiro', mode: 'api_key', name: 'first', secret: 'key-cccc', isDefault: false } });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(isDefault(((a.body as { credential: { id: string } }).credential).id), 1);
  });

  it('a Claude Code sign-in is not made the default on its own', async () => {
    const a = await fetchJson(baseUrl, '/api/credentials', { method: 'POST', cookie, body: { engine: 'claude-code', mode: 'api_key', name: 'claude', secret: 'sk-ant-aaaa' } });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(isDefault(((a.body as { credential: { id: string } }).credential).id), 0);
  });

  it('deleting the default Kiro sign-in makes the next one the default', async () => {
    const first = seed(userId, { isDefault: true, createdAt: '2026-01-01T00:00:00Z' });
    const second = seed(userId, { createdAt: '2026-02-01T00:00:00Z' });
    const r = await fetchJson(baseUrl, `/api/credentials/${first}`, { method: 'DELETE', cookie });
    assert.equal(r.status, 200);
    assert.equal(isDefault(second), 1);
  });

  it('the models list finds a Kiro sign-in that was never marked as the default', async () => {
    seed(userId, { name: 'AWS SSO' });
    const r = await fetchJson(baseUrl, '/api/engines/kiro/models?refresh=1', { cookie });
    assert.equal(r.status, 200);
    const body = r.body as { runsAs: { kind: string; label: string }; error?: string };
    assert.equal(body.runsAs.kind, 'credential', 'it ran as the person\'s own sign-in');
    assert.equal(body.runsAs.label, 'AWS SSO');
    assert.doesNotMatch(body.error ?? '', /No Kiro credentials are configured/);
  });

  it('says no Kiro credentials only when the person really has none', async () => {
    const r = await fetchJson(baseUrl, '/api/engines/kiro/models?refresh=1', { cookie });
    assert.match((r.body as { error?: string }).error ?? '', /No Kiro credentials are configured/);
  });
});
