import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestServer, cleanup } from './fixtures.ts';
import {
  setMcpOAuthFetchForTests, startMcpSignIn, finishMcpSignIn, mcpAccessToken, mcpSignedIn,
  skipMcpForRun, mcpSkippedForRun, MCP_OAUTH_REDIRECT_URI,
} from '../server/mcp-oauth.ts';

const MCP = 'https://93.184.216.34/v2/mcp';
const AS = 'https://93.184.216.34';
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

describe('MCP OAuth sign-in', () => {
  let tokenCalls: URLSearchParams[] = [];
  let expiresIn = 3600;

  before(async () => {
    await createTestServer();
    setMcpOAuthFetchForTests((async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: MCP, authorization_servers: [AS], scopes_supported: ['read:jira-work'] });
      if (u.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return json({ authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, registration_endpoint: `${AS}/register` });
      }
      if (u.pathname === '/register') return json({ client_id: 'client-1' });
      if (u.pathname === '/token') {
        const p = new URLSearchParams(String(init?.body));
        tokenCalls.push(p);
        if (p.get('grant_type') === 'authorization_code' && p.get('code') !== 'good') return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: `at-${tokenCalls.length}`, refresh_token: `rt-${tokenCalls.length}`, expires_in: expiresIn });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch);
  });
  after(() => { setMcpOAuthFetchForTests(null); cleanup(); });

  const callback = (state: string, code = 'good') => `${MCP_OAUTH_REDIRECT_URI}?code=${code}&state=${state}`;

  it('start builds a PKCE url with the resource and registered client', async () => {
    const { url } = await startMcpSignIn('u1', 'i1', MCP);
    const q = new URL(url).searchParams;
    assert.equal(new URL(url).pathname, '/authorize');
    assert.equal(q.get('client_id'), 'client-1');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('redirect_uri'), MCP_OAUTH_REDIRECT_URI);
    assert.equal(q.get('resource'), MCP);
  });

  it('finish exchanges the pasted address with the matching verifier and stores the token', async () => {
    tokenCalls = [];
    const { url, flow } = await startMcpSignIn('u2', 'i2', MCP);
    const q = new URL(url).searchParams;
    assert.equal(await mcpAccessToken('i2', 'u2'), null);
    await finishMcpSignIn('u2', 'i2', flow, callback(q.get('state')!));
    const p = tokenCalls[0]!;
    assert.equal(createHash('sha256').update(p.get('code_verifier')!).digest('base64url'), q.get('code_challenge'));
    assert.equal(await mcpAccessToken('i2', 'u2'), 'at-1');
    assert.equal(await mcpSignedIn('i2', 'u2'), true);
    assert.equal(await mcpSignedIn('i2', 'other-user'), false);
  });

  it('rejects another state, another user, a foreign address and a refused code', async () => {
    const { url, flow } = await startMcpSignIn('u3', 'i3', MCP);
    const state = new URL(url).searchParams.get('state')!;
    await assert.rejects(finishMcpSignIn('u3', 'i3', flow, callback('wrong')), /different sign-in/);
    await assert.rejects(finishMcpSignIn('someone-else', 'i3', flow, callback(state)), /expired/);
    await assert.rejects(finishMcpSignIn('u3', 'i3', flow, `https://evil.example/?code=good&state=${state}`), /not from the sign-in/);
    await assert.rejects(finishMcpSignIn('u3', 'i3', flow, callback(state, 'bad')), /did not accept/);
    assert.equal(await mcpSignedIn('i3', 'u3'), false);
  });

  it('refreshes an expired token and keeps the rotated refresh token', async () => {
    tokenCalls = []; expiresIn = 1; // expires inside the 60s skew, so every read refreshes
    const { url, flow } = await startMcpSignIn('u4', 'i4', MCP);
    await finishMcpSignIn('u4', 'i4', flow, callback(new URL(url).searchParams.get('state')!));
    expiresIn = 3600;
    assert.equal(await mcpAccessToken('i4', 'u4'), 'at-2');
    assert.equal(tokenCalls[1]!.get('grant_type'), 'refresh_token');
    assert.equal(tokenCalls[1]!.get('refresh_token'), 'rt-1');
    assert.equal(await mcpAccessToken('i4', 'u4'), 'at-2'); // fresh now: no third call
    assert.equal(tokenCalls.length, 2);
  });

  it('remembers "continue without it" per run and server', async () => {
    assert.equal(await mcpSkippedForRun('r1', 'i1'), false);
    await skipMcpForRun('r1', 'i1');
    assert.equal(await mcpSkippedForRun('r1', 'i1'), true);
    assert.equal(await mcpSkippedForRun('r2', 'i1'), false);
  });
});
