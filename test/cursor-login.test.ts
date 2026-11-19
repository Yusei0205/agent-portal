import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { startCursorLogin, pollCursorLogin } from '../server/cursor-login.ts';
import { createTestServer, cleanup, fetchJson, withPasswordConfirmed } from './fixtures.ts';
import { one } from '../server/db.ts';
import { resolveCredentialEnv } from '../server/credentials.ts';
import { run as dbRun } from '../server/db.ts';

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (days: number, n = 0): string => `${b64({ alg: 'none' })}.${b64({ sub: 'u', n, exp: Math.floor(Date.now() / 1000) + days * 86400 })}.${'s'.repeat(24)}`;

/** A stand-in for Cursor's login service, shaped like the real one: POST /auth/poll {uuid, verifier} → 404 until approved, then 200. */
function fakeCursor() {
  const approved = new Map<string, string>(); // uuid → access token
  const challenges = new Map<string, string>();
  const calls: Array<{ method: string; body: any }> = [];
  let mode: 'normal' | 'forbidden' | 'down' | 'badtoken' = 'normal';
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method: req.method ?? '', body });
    if (req.url !== '/auth/poll' || req.method !== 'POST') { res.writeHead(404); res.end('Not Found'); return; }
    if (mode === 'down') { res.writeHead(503); res.end('busy'); return; }
    if (mode === 'forbidden') { res.writeHead(403); res.end('no'); return; }
    const t = approved.get(String(body.uuid));
    // Like the real service: the verifier must hash to the challenge the link carried.
    const ok = t && createHash('sha256').update(String(body.verifier)).digest('base64url') === challenges.get(String(body.uuid));
    if (!ok) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accessToken: mode === 'badtoken' ? 'garbage' : t, refreshToken: token(60, 9), challenge: 'x', authId: 'auth0|u', uuid: body.uuid, token_type: 'Bearer' }));
  });
  return {
    server, calls,
    setMode: (m: typeof mode) => { mode = m; },
    /** The person opens the link and approves: the link's uuid and challenge become known to the service. */
    approve: (loginUrl: string, accessToken: string) => { const u = new URL(loginUrl); approved.set(u.searchParams.get('uuid')!, accessToken); challenges.set(u.searchParams.get('uuid')!, u.searchParams.get('challenge')!); },
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

describe('Cursor browser sign-in client', () => {
  const fake = fakeCursor();
  before(async () => { await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r)); process.env.PORTAL_CURSOR_API_URL = fake.url(); process.env.PORTAL_CURSOR_WEBSITE_URL = fake.url(); });
  after(async () => { delete process.env.PORTAL_CURSOR_API_URL; delete process.env.PORTAL_CURSOR_WEBSITE_URL; await new Promise<void>((r) => fake.server.close(() => r())); });

  it('builds the same link the CLI does: challenge = base64url(sha256(verifier)), a uuid, mode login, target cli', () => {
    const a = startCursorLogin(); const b = startCursorLogin();
    const u = new URL(a.loginUrl);
    assert.equal(u.origin, fake.url()); assert.equal(u.pathname, '/loginDeepControl');
    assert.equal(u.searchParams.get('uuid'), a.uuid);
    assert.equal(u.searchParams.get('mode'), 'login'); assert.equal(u.searchParams.get('redirectTarget'), 'cli');
    assert.equal(u.searchParams.get('challenge'), createHash('sha256').update(a.verifier).digest('base64url'));
    assert.ok(a.verifier.length >= 43 && a.verifier !== b.verifier && a.uuid !== b.uuid);
    assert.ok(!a.loginUrl.includes(a.verifier), 'the verifier never appears in the link');
  });

  it('waits while pending, finishes with the access token when approved, and posts {uuid, verifier}', async () => {
    const s = startCursorLogin();
    assert.deepEqual(await pollCursorLogin(s.uuid, s.verifier), { status: 'pending' });
    const t = token(60);
    fake.approve(s.loginUrl, t);
    const done = await pollCursorLogin(s.uuid, s.verifier);
    assert.equal(done.status, 'complete');
    assert.equal((done as any).token, t);
    assert.ok(Date.parse((done as any).expiresAt) > Date.now() + 59 * 86400_000);
    const last = fake.calls.at(-1)!;
    assert.deepEqual([last.method, Object.keys(last.body).sort()], ['POST', ['uuid', 'verifier']]);
    const wrong = await pollCursorLogin(s.uuid, 'someone-elses-verifier');
    assert.deepEqual(wrong, { status: 'pending' }, 'a different verifier never gets the token');
  });

  it('treats server trouble as pending, a refusal or a bad token as failed', async () => {
    const s = startCursorLogin(); fake.approve(s.loginUrl, token(60));
    fake.setMode('down'); assert.deepEqual(await pollCursorLogin(s.uuid, s.verifier), { status: 'pending' });
    fake.setMode('forbidden'); const f = await pollCursorLogin(s.uuid, s.verifier); assert.equal(f.status, 'failed'); assert.match((f as any).message, /HTTP 403/);
    fake.setMode('badtoken'); const b = await pollCursorLogin(s.uuid, s.verifier); assert.equal(b.status, 'failed');
    fake.setMode('normal');
    assert.equal((await pollCursorLogin(s.uuid, s.verifier)).status, 'complete');
  });

  it('only talks to https (or this machine), so a bad setting cannot send the sign-in elsewhere', async () => {
    process.env.PORTAL_CURSOR_API_URL = 'http://evil.example.com';
    await assert.rejects(pollCursorLogin('u', 'v'), /must be an https URL/);
    process.env.PORTAL_CURSOR_API_URL = fake.url();
  });
});

describe('Cursor sign-in through the credentials API', () => {
  const fake = fakeCursor();
  let baseUrl = '', cookie = '', userId = '';
  const password = 'password1234';
  const start = async (extra: Record<string, unknown> = {}) => {
    const confirmed = await withPasswordConfirmed(baseUrl, cookie, password);
    return fetchJson(baseUrl, '/api/credentials', { method: 'POST', body: { engine: 'cursor', mode: 'login_token', signIn: true, name: 'my cursor', ...extra }, cookie: confirmed });
  };
  const poll = (id: string) => fetchJson(baseUrl, `/api/credentials/${id}/device-poll`, { method: 'POST', body: {}, cookie });

  before(async () => {
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
    process.env.PORTAL_CURSOR_API_URL = fake.url(); process.env.PORTAL_CURSOR_WEBSITE_URL = fake.url();
    const ts = await createTestServer(); baseUrl = ts.baseUrl;
    cookie = (await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: 'si@example.com', name: 'S', password, provider: 'demo' } })).cookie ?? '';
    userId = String(one<{ id: string }>("SELECT id FROM users WHERE email = 'si@example.com'")!.id);
  });
  after(async () => { delete process.env.PORTAL_CURSOR_API_URL; delete process.env.PORTAL_CURSOR_WEBSITE_URL; await new Promise<void>((r) => fake.server.close(() => r())); await cleanup(); });

  it('starts a sign-in: a pending credential, a link and no code, nothing secret in the response', async () => {
    const r = await start();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { credential, deviceChallenge } = r.body as any;
    assert.equal(credential.status, 'pending');
    assert.equal(deviceChallenge.userCode, '');
    assert.equal(new URL(deviceChallenge.verificationUri).pathname, '/loginDeepControl');
    assert.equal(deviceChallenge.expiresIn, 600);
    const text = JSON.stringify(r.body);
    const row = one<any>('SELECT secret_enc, extra_config FROM engine_credentials WHERE id = ?', credential.id)!;
    const verifier = JSON.parse(row.extra_config);
    assert.equal(row.secret_enc, null);
    assert.ok(verifier.pendingVerifierEnc && !verifier.pendingVerifierEnc.includes(new URL(deviceChallenge.verificationUri).searchParams.get('challenge')));
    assert.ok(!text.includes('pendingVerifierEnc') && !text.includes('pendingUuid'), 'pending fields are not returned');
    assert.equal((await poll(credential.id)).body && ((await poll(credential.id)).body as any).status, 'pending');
  });

  it('finishes when the person approves: stores only the access token, with its expiry', async () => {
    const r = await start();
    const { credential, deviceChallenge } = r.body as any;
    const t = token(60, 1);
    fake.approve(deviceChallenge.verificationUri, t);
    const done = (await poll(credential.id)).body as any;
    assert.equal(done.status, 'complete');
    assert.equal(done.credential.status, 'ok');
    assert.equal(done.credential.last4, t.slice(-4));
    assert.ok(done.credential.config.tokenExpiry);
    assert.ok(!JSON.stringify(done).includes(t), 'the token is never returned');
    assert.deepEqual(await resolveCredentialEnv('cursor', userId, credential.id), { CURSOR_AUTH_TOKEN: t });
    const stored = JSON.parse(one<any>('SELECT extra_config FROM engine_credentials WHERE id = ?', credential.id)!.extra_config);
    assert.ok(!('pendingUuid' in stored) && !('pendingVerifierEnc' in stored) && !('refreshToken' in stored), 'pending state and the refresh token are gone');
    assert.equal((await poll(credential.id)).status, 400, 'nothing is left to poll');
  });

  it('reports a sign-in that was never approved in time as expired', async () => {
    const { credential } = (await start()).body as any;
    const cfg = JSON.parse(one<any>('SELECT extra_config FROM engine_credentials WHERE id = ?', credential.id)!.extra_config);
    dbRun('UPDATE engine_credentials SET extra_config = ? WHERE id = ?', JSON.stringify({ ...cfg, pendingExpireAt: Date.now() - 1000 }), credential.id);
    assert.equal(((await poll(credential.id)).body as any).status, 'expired');
  });

  it('reports a refused sign-in as expired with the reason', async () => {
    const { credential } = (await start()).body as any;
    fake.setMode('forbidden');
    const r = (await poll(credential.id)).body as any;
    fake.setMode('normal');
    assert.equal(r.status, 'expired'); assert.match(r.error, /refused/);
  });

  it('signs in again without cutting off the current token, then replaces it', async () => {
    const { credential, deviceChallenge } = (await start()).body as any;
    const old = token(3, 7);
    fake.approve(deviceChallenge.verificationUri, old);
    assert.equal(((await poll(credential.id)).body as any).status, 'complete');
    assert.equal(((await fetchJson(baseUrl, '/api/credentials', { cookie })).body as any).credentials.find((c: any) => c.id === credential.id).status, 'expiring', 'three days left is "expiring"');

    const again = await fetchJson(baseUrl, `/api/credentials/${credential.id}/reauth`, { method: 'POST', body: {}, cookie });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal((again.body as any).deviceChallenge.userCode, '');
    assert.deepEqual(await resolveCredentialEnv('cursor', userId, credential.id), { CURSOR_AUTH_TOKEN: old }, 'the old token still works meanwhile');
    assert.equal(((await poll(credential.id)).body as any).status, 'pending');

    const fresh = token(60, 8);
    fake.approve((again.body as any).deviceChallenge.verificationUri, fresh);
    const done = (await poll(credential.id)).body as any;
    assert.equal(done.status, 'complete'); assert.equal(done.credential.status, 'ok');
    assert.deepEqual(await resolveCredentialEnv('cursor', userId, credential.id), { CURSOR_AUTH_TOKEN: fresh });
  });

  it('keeps pasting a token working for people who cannot sign in here', async () => {
    const confirmed = await withPasswordConfirmed(baseUrl, cookie, password);
    const r = await fetchJson(baseUrl, '/api/credentials', { method: 'POST', body: { engine: 'cursor', mode: 'login_token', name: 'pasted', secret: token(40) }, cookie: confirmed });
    assert.equal(r.status, 201);
    assert.equal((r.body as any).credential.status, 'ok');
    assert.equal((r.body as any).deviceChallenge, undefined);
  });
});
