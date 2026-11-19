import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { parseLoginToken, daysLeft, looksLikeLoginToken, cursorAuthEnv } from '../server/cursor-login-token.ts';
import { createTestServer, cleanup, fetchJson, withPasswordConfirmed } from './fixtures.ts';
import { one } from '../server/db.ts';
import { generateId } from '../server/util.ts';
import { resolveCredentialEnv } from '../server/credentials.ts';
import { runCursor } from '../server/agent/cursor.ts';
import { isDeniedVar } from '../server/agent/env-scrub.ts';
import type { AgentRun, RunContext } from '../server/agent/types.ts';

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A token shaped like Cursor's (three dotted parts, an exp claim); the signature is meaningless. */
export const fakeToken = (expSecondsFromNow: number, extra: Record<string, unknown> = {}): string =>
  `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'user_test', exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, ...extra })}.${'s'.repeat(24)}`;

describe('parseLoginToken', () => {
  it('takes a bare token, a quoted one, and a whole auth.json (keeping only the access token)', () => {
    const t = fakeToken(30 * 86400);
    assert.equal(parseLoginToken(t).token, t);
    assert.equal(parseLoginToken(`  "${t}"\n`).token, t);
    const file = JSON.stringify({ accessToken: t, refreshToken: fakeToken(30 * 86400, { n: 2 }) }, null, 2);
    const parsed = parseLoginToken(file);
    assert.equal(parsed.token, t);
    assert.ok(!file.includes('refreshToken') || parsed.token === t, 'the refresh token is not kept');
    assert.ok(daysLeft(parsed.expiresAt)! >= 29);
  });

  it('survives a paste that lost its line breaks (a single-line input)', () => {
    const t = fakeToken(86400);
    const oneLine = JSON.stringify({ accessToken: t, refreshToken: 'x' }, null, 2).replace(/\n/g, '');
    assert.equal(parseLoginToken(oneLine).token, t);
  });

  it('rejects empty, malformed, expired, expiry-less and oversized input, each with its own message', () => {
    assert.throws(() => parseLoginToken('   '), /Paste the login token/);
    assert.throws(() => parseLoginToken('not-a-token'), /not a Cursor login token/);
    assert.throws(() => parseLoginToken('{broken'), /could not be read/);
    assert.throws(() => parseLoginToken('{"refreshToken":"x"}'), /No accessToken/);
    assert.throws(() => parseLoginToken(fakeToken(-86400)), /expired on \d{4}-\d{2}-\d{2}/);
    const noExp = `${b64({ alg: 'none' })}.${b64({ sub: 'u' })}.${'s'.repeat(24)}`;
    assert.throws(() => parseLoginToken(noExp), /no expiry/);
    assert.throws(() => parseLoginToken('x'.repeat(20_000)), /too long/);
  });

  it('daysLeft counts whole days and is null for nothing', () => {
    assert.equal(daysLeft(new Date(Date.now() + 3.5 * 86400_000).toISOString()), 3);
    assert.equal(daysLeft(new Date(Date.now() - 86400_000).toISOString()), -1);
    assert.equal(daysLeft(undefined), null);
  });

  it('checks the shape of a token arriving at the runner, and picks the right variable', () => {
    assert.equal(looksLikeLoginToken(fakeToken(100)), true);
    for (const v of ['', 'abc', 'a.b', 'has space.b.c', null, 42, 'a'.repeat(9000)]) assert.equal(looksLikeLoginToken(v), false);
    assert.deepEqual(cursorAuthEnv({ apiKey: 'k' }), { CURSOR_API_KEY: 'k' });
    assert.deepEqual(cursorAuthEnv({ authToken: 't' }), { CURSOR_AUTH_TOKEN: 't' });
    assert.ok(isDeniedVar('CURSOR_AUTH_TOKEN'), 'kept out of the agent shell');
  });
});

describe('Cursor login-token credential', () => {
  let baseUrl = '', cookie = '', projectId = '', userId = '';
  const password = 'password1234';
  const create = async (secret: string, extra: Record<string, unknown> = {}) => {
    const confirmed = await withPasswordConfirmed(baseUrl, cookie, password);
    return fetchJson(baseUrl, '/api/credentials', { method: 'POST', body: { engine: 'cursor', mode: 'login_token', name: 'my login', secret, ...extra }, cookie: confirmed });
  };

  before(async () => {
    process.env.PORTAL_CURSOR_FAKE = path.resolve('test/fake-cursor.mjs');
    const ts = await createTestServer(); baseUrl = ts.baseUrl;
    cookie = (await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: 'lt@example.com', name: 'L', password, provider: 'demo' } })).cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'lt' }, cookie });
    projectId = ((p.body as any).project).id;
    userId = String(one<{ id: string }>("SELECT id FROM users WHERE email = 'lt@example.com'")!.id);
  });
  after(async () => { delete process.env.PORTAL_CURSOR_FAKE; await cleanup(); });

  it('stores only the access token (encrypted) with its expiry, and never returns it', async () => {
    const t = fakeToken(30 * 86400);
    const r = await create(JSON.stringify({ accessToken: t, refreshToken: fakeToken(30 * 86400, { n: 9 }) }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const cred = (r.body as any).credential;
    assert.equal(cred.mode, 'login_token');
    assert.equal(cred.last4, t.slice(-4));
    assert.ok(cred.config.tokenExpiry, 'the card can show the days left');
    assert.ok(!JSON.stringify(r.body).includes(t), 'the token is never in a response');
    const row = one<any>('SELECT secret_enc FROM engine_credentials WHERE id = ?', cred.id)!;
    assert.ok(!String(row.secret_enc).includes(t.slice(0, 20)), 'stored encrypted');
    assert.equal(cred.status, 'ok');
  });

  it('refuses a token that is expired, malformed or empty, before storing anything', async () => {
    const before = one<any>("SELECT COUNT(*) n FROM engine_credentials WHERE engine = 'cursor'")!.n;
    assert.equal((await create(fakeToken(-86400))).status, 400);
    assert.equal((await create('hello')).status, 400);
    assert.equal((await create('')).status, 400);
    assert.equal(one<any>("SELECT COUNT(*) n FROM engine_credentials WHERE engine = 'cursor'")!.n, before);
  });

  it('gives a run CURSOR_AUTH_TOKEN (not an API key), and the CLI sees it', async () => {
    const t = fakeToken(20 * 86400);
    const id = ((await create(t)).body as any).credential.id as string;
    assert.deepEqual(await resolveCredentialEnv('cursor', userId, id), { CURSOR_AUTH_TOKEN: t });

    const wf = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body: { goal: 'x', engine: 'cursor' }, cookie });
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-lt-'));
    const events: Array<{ type: string; payload: any }> = [];
    const run = { runId: generateId(), workflowId: ((wf.body as any).workflow).id, projectId, goal: 'ECHO_KEY', kind: null, engine: 'cursor', trusted: false, dataDir: workDir, workDir, repoIds: [],
      leadAgent: null, permissions: { rules: [] }, credentialId: id, credentialOwnerId: userId, model: null, engineSessionId: null } as unknown as AgentRun;
    const ctx: RunContext = { run, emit: (type, payload) => events.push({ type, payload: payload as any }), awaitInput: async () => ({ decision: 'deny', remember: false, message: '' }), allowed: new Set(), signal: null };
    const text = await runCursor(ctx);
    assert.ok(text.includes(`token=${t}`) && text.includes('key=none'), text.slice(0, 120));
  });

  it('says plainly when a stored login token has expired', async () => {
    const t = fakeToken(86400);
    const id = ((await create(t)).body as any).credential.id as string;
    const past = new Date(Date.now() - 2 * 86400_000).toISOString();
    const { run: dbRun } = await import('../server/db.ts');
    dbRun('UPDATE engine_credentials SET extra_config = ? WHERE id = ?', JSON.stringify({ tokenExpiry: past }), id);
    await assert.rejects(resolveCredentialEnv('cursor', userId, id), /expired on \d{4}-\d{2}-\d{2}.*agent login/);
    const models = await fetchJson(baseUrl, `/api/engines/cursor/models?credentialId=${id}`, { cookie });
    assert.match(String((models.body as any).error), /expired/);
    const listed = await fetchJson(baseUrl, '/api/credentials', { cookie });
    const view = ((listed.body as any).credentials as any[]).find((c) => c.id === id);
    assert.equal(view.status, 'expired');
  });

  it('lists models with a login token', async () => {
    const id = ((await create(fakeToken(10 * 86400))).body as any).credential.id as string;
    const models = await fetchJson(baseUrl, `/api/engines/cursor/models?credentialId=${id}`, { cookie });
    assert.equal((models.body as any).models.length, 3);
    assert.match((models.body as any).runsAs.label, /Cursor login/);
  });

  it('replaces the token on update and refreshes the expiry', async () => {
    const id = ((await create(fakeToken(5 * 86400))).body as any).credential.id as string;
    const next = fakeToken(50 * 86400, { n: 5 });
    const confirmed = await withPasswordConfirmed(baseUrl, cookie, password);
    const r = await fetchJson(baseUrl, `/api/credentials/${id}`, { method: 'PUT', body: { secret: JSON.stringify({ accessToken: next }) }, cookie: confirmed });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(daysLeft((r.body as any).credential.config.tokenExpiry)! >= 49);
    assert.deepEqual(await resolveCredentialEnv('cursor', userId, id), { CURSOR_AUTH_TOKEN: next });
    const bad = await fetchJson(baseUrl, `/api/credentials/${id}`, { method: 'PUT', body: { secret: 'nope' }, cookie: await withPasswordConfirmed(baseUrl, cookie, password) });
    assert.equal(bad.status, 400);
  });
});
