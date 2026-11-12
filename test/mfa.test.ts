import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson, createTestConfig } from './fixtures.ts';
import { setConfig } from '../server/config.ts';
import { codeForStep, stepAt } from '../server/totp.ts';

const email = 'mfa@test.local';
const password = 'password1234';

describe('two-step sign-in', () => {
  let baseUrl: string;
  let cookie = '';
  let secret = '';
  let recovery: string[] = [];
  let usedStep = 0;

  const login = (body: Record<string, unknown>) => fetchJson(baseUrl, '/api/auth/login', { method: 'POST', body: { email, password, ...body } });
  // The next code that is allowed and unused: codes work once, and one step of clock drift either side is accepted,
  // so three codes are available around "now" (enough for this file's two uses).
  const freshCode = () => {
    const now = stepAt(Date.now());
    const step = Math.max(now - 1, usedStep + 1);
    assert.ok(step <= now + 1, 'ran out of codes inside the drift window');
    usedStep = step;
    return codeForStep(secret, step);
  };

  before(async () => {
    setConfig(createTestConfig());
    baseUrl = (await createTestServer()).baseUrl;
    const r = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email, name: 'Mfa', password } });
    assert.equal(r.status, 200);
    cookie = r.cookie ?? '';
  });
  after(async () => { await cleanup(); });

  it('starts off, and sign-in needs only the password', async () => {
    const s = await fetchJson(baseUrl, '/api/auth/mfa', { cookie });
    assert.deepEqual(s.body, { available: true, enabled: false, recoveryLeft: 0 });
    assert.equal((await login({})).status, 200);
  });

  it('setup gives a secret; a wrong code does not switch it on', async () => {
    const r = await fetchJson(baseUrl, '/api/auth/mfa/setup', { method: 'POST', body: {}, cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    secret = (r.body as { secret: string }).secret;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    const bad = await fetchJson(baseUrl, '/api/auth/mfa/enable', { method: 'POST', body: { code: '000000' }, cookie });
    assert.equal(bad.status, 400);
    assert.equal(((await fetchJson(baseUrl, '/api/auth/mfa', { cookie })).body as { enabled: boolean }).enabled, false);
  });

  it('a right code switches it on and returns 8 recovery codes once', async () => {
    const r = await fetchJson(baseUrl, '/api/auth/mfa/enable', { method: 'POST', body: { code: freshCode() }, cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    recovery = (r.body as { recoveryCodes: string[] }).recoveryCodes;
    assert.equal(recovery.length, 8);
    assert.match(recovery[0], /^[0-9a-f]{5}-[0-9a-f]{5}$/);
    const s = await fetchJson(baseUrl, '/api/auth/mfa', { cookie });
    assert.deepEqual(s.body, { available: true, enabled: true, recoveryLeft: 8 });
  });

  it('sign-in now asks for the code; the right password alone gets no session', async () => {
    const r = await login({});
    assert.equal(r.status, 401);
    assert.equal((r.body as { mfaRequired?: boolean }).mfaRequired, true);
    assert.equal(r.cookie, undefined);
  });

  it('a wrong code is refused', async () => {
    const r = await login({ code: '123456' });
    assert.equal(r.status, 401);
    assert.equal(r.cookie, undefined);
  });

  it('the right code signs in, and the same code cannot be used twice', async () => {
    const code = freshCode();
    const ok = await login({ code });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.cookie);
    const again = await login({ code });
    assert.equal(again.status, 401);
  });

  it('a recovery code signs in once', async () => {
    const ok = await login({ code: recovery[0] });
    assert.equal(ok.status, 200);
    const again = await login({ code: recovery[0] });
    assert.equal(again.status, 401);
    assert.equal(((await fetchJson(baseUrl, '/api/auth/mfa', { cookie })).body as { recoveryLeft: number }).recoveryLeft, 7);
  });

  it('wrong codes count towards the sign-in limits', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await login({ code: '000000' })).status;
    assert.equal(last, 429);
  });
});
