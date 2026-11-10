import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { setClaudePlanFetchForTests } from '../server/claude-plan-oauth.ts';

describe('Claude plan sign-in', () => {
  let baseUrl = '', cookie = '';
  let sent: { url: string; body: Record<string, unknown> } | null = null;

  before(async () => {
    const s = await createTestServer();
    baseUrl = s.baseUrl;
    cookie = (await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST', body: { email: `a-${Date.now()}@example.com`, name: 'A', password: 'password1234', provider: 'demo' } })).cookie ?? '';
    setClaudePlanFetchForTests((async (url: string, init: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init.body)) };
      return sent.body.code === 'good'
        ? new Response(JSON.stringify({ access_token: 'sk-ant-oat01-test' }), { status: 200 })
        : new Response('{}', { status: 401 });
    }) as unknown as typeof fetch);
  });
  after(() => { setClaudePlanFetchForTests(null); cleanup(); });

  const start = async () => (await fetchJson(baseUrl, '/api/credentials/claude-plan/start', { method: 'POST', body: {}, cookie })).body as { url: string; flow: string };
  const finish = (flow: string, code: string, c = cookie) => fetchJson(baseUrl, '/api/credentials/claude-plan/finish', { method: 'POST', body: { flow, code }, cookie: c });

  it('start returns a claude.ai PKCE url with the inference-only scope', async () => {
    const u = new URL((await start()).url);
    assert.equal(u.hostname, 'claude.com');
    assert.equal(u.searchParams.get('scope'), 'user:inference');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  });

  it('finish exchanges "code#state" with the matching verifier and returns the token', async () => {
    const { url, flow } = await start();
    const state = new URL(url).searchParams.get('state')!;
    const r = await finish(flow, `good#${state}`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { token: string }).token, 'sk-ant-oat01-test');
    const verifier = sent!.body.code_verifier as string;
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), new URL(url).searchParams.get('code_challenge'));
    assert.equal(sent!.body.expires_in, 31536000);
  });

  it('rejects a code from another sign-in, a rejected code, a tampered flow, and signed-out callers', async () => {
    const { flow } = await start();
    assert.equal((await finish(flow, 'good#other-state')).status, 400);
    assert.equal((await finish(flow, 'bad')).status, 400);
    assert.equal((await finish('garbage', 'good')).status, 400);
    assert.equal((await finish(flow, 'good', '')).status, 401);
  });
});
