import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson, withPasswordConfirmed, createTestConfig } from './fixtures.ts';
import { setConfig } from '../server/config.ts';
import { STEP_UP_WINDOW_MS, makeStepUpToken, stepUpTokenValid } from '../server/step-up.ts';

describe('confirmation token', () => {
  before(() => { setConfig(createTestConfig()); });
  const t0 = 1_700_000_000_000;
  it('is valid for its session inside the window', () => {
    const tok = makeStepUpToken('sess-a', t0);
    assert.equal(stepUpTokenValid(tok, 'sess-a', t0 + 1000), true);
  });
  it('is not valid for another session, after the window, or when altered', () => {
    const tok = makeStepUpToken('sess-a', t0);
    assert.equal(stepUpTokenValid(tok, 'sess-b', t0 + 1000), false);
    assert.equal(stepUpTokenValid(tok, 'sess-a', t0 + STEP_UP_WINDOW_MS + 1), false);
    const [exp, mac] = tok.split('.');
    assert.equal(stepUpTokenValid(`${Number(exp) + 60_000}.${mac}`, 'sess-a', t0 + 1000), false);
    assert.equal(stepUpTokenValid(undefined, 'sess-a', t0), false);
    assert.equal(stepUpTokenValid('garbage', 'sess-a', t0), false);
  });
  it('cannot be made to last longer than the window', () => {
    // A far-future expiry is refused even if it were signed.
    assert.equal(stepUpTokenValid(`${t0 + 10 * STEP_UP_WINDOW_MS}.abc`, 'sess-a', t0), false);
  });
});

describe('sensitive actions ask for the password', () => {
  let baseUrl: string;
  let admin = '';
  const password = 'password1234';
  const cred = { engine: 'kiro', mode: 'api_key', name: 'Step Up Kiro', secret: 'kiro-secret-1234' };

  before(async () => {
    baseUrl = (await createTestServer()).baseUrl;
    const r = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: 'admin@step-up.test', name: 'Admin', password } });
    assert.equal(r.status, 200);
    admin = r.cookie ?? '';
  });
  after(async () => { await cleanup(); });

  it('creating a credential without confirming is refused with reauth_required', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials', { method: 'POST', body: cred, cookie: admin, noAutoConfirm: true });
    assert.equal(r.status, 403);
    assert.equal((r.body as { code?: string }).code, 'reauth_required');
  });

  it('a wrong password does not confirm', async () => {
    const r = await fetchJson(baseUrl, '/api/auth/confirm', { method: 'POST', body: { password: 'nope-nope-nope' }, cookie: admin });
    assert.equal(r.status, 400);
    assert.equal(r.cookie, undefined);
  });

  it('confirming needs a signed-in session', async () => {
    const r = await fetchJson(baseUrl, '/api/auth/confirm', { method: 'POST', body: { password } });
    assert.equal(r.status, 401);
  });

  it('after confirming, the same action goes through', async () => {
    const confirmed = await withPasswordConfirmed(baseUrl, admin, password);
    const r = await fetchJson(baseUrl, '/api/credentials', { method: 'POST', body: cred, cookie: confirmed });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  it('creating a user and deleting a project also ask', async () => {
    const u = await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: 'x@step-up.test', name: 'X', password: 'password1234' }, cookie: admin, noAutoConfirm: true });
    assert.equal(u.status, 403);
    assert.equal((u.body as { code?: string }).code, 'reauth_required');
    const g = await fetchJson(baseUrl, '/api/governance/invitations', { method: 'POST', body: {}, cookie: admin, noAutoConfirm: true });
    assert.equal(g.status, 403);
    assert.equal((g.body as { code?: string }).code, 'reauth_required');
  });

  it('a confirmation from one session does not work on another', async () => {
    const confirmed = await withPasswordConfirmed(baseUrl, admin, password);
    const reauthCookie = confirmed.split('; ').pop() as string;
    const other = await fetchJson(baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'admin@step-up.test', password } });
    assert.equal(other.status, 200);
    const r = await fetchJson(baseUrl, '/api/credentials', { method: 'POST', body: cred, cookie: `${other.cookie}; ${reauthCookie}`, noAutoConfirm: true });
    assert.equal(r.status, 403);
  });

  it('reading is not affected', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials', { cookie: admin });
    assert.equal(r.status, 200);
  });
});
