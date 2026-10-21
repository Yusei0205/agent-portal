import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { bootServer, Client, waitFor, type TestServer } from './client.ts';
import { makeRepo } from './fixtures.ts';

// GitHub's API is answered here; everything else (the portal itself) goes through.
const realFetch = globalThis.fetch;
const githubCalls: { url: string; auth: string | null }[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
  const auth = new Headers(init?.headers).get('authorization');
  githubCalls.push({ url, auth });
  if (auth !== 'Bearer ghp_good_token_1234') return new Response('{"message":"Bad credentials"}', { status: 401 });
  if (url.endsWith('/user')) return Response.json({ login: 'octo' });
  if (url.includes('/user/repos')) return Response.json([{ full_name: 'octo/refunds', clone_url: 'https://github.com/octo/refunds.git', default_branch: 'main', description: 'Refund service' }]);
  return new Response('not found', { status: 404 });
}) as typeof fetch;

let srv: TestServer;
let admin: Client;
let bob: Client;
let pid: string;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  bob = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
  await admin.post('/api/users', { email: 'b@example.com', name: 'Bob', password: 'a-long-password-2' });
  await bob.post('/api/auth/login', { email: 'b@example.com', password: 'a-long-password-2' });
  pid = (await admin.post('/api/projects', { name: 'Conn', description: 'd' })).project.id;
});

after(async () => {
  globalThis.fetch = realFetch;
  await srv.close();
});

test('connections: saved write-only, tested on save, shared or personal, and listing repositories', async () => {
  const bad = await admin.post('/api/git-connections', { provider: 'github', name: 'Wrong', token: 'ghp_wrong' });
  assert.equal(bad.test.ok, false, 'a failing test does not undo the save');
  assert.match(bad.test.message, /401/);
  const { connection: gh, test: t } = await admin.post('/api/git-connections', { provider: 'github', name: 'Company GitHub', token: 'ghp_good_token_1234' });
  assert.equal(t.ok, true);
  assert.equal(t.message, 'Signed in to GitHub as octo.');
  assert.equal(gh.token.hint, '…1234');
  assert.equal(gh.test.ok, true);
  assert.ok(!JSON.stringify(await admin.get('/api/git-connections')).includes('ghp_good_token_1234'), 'the token never comes back');

  const { repos } = await bob.get(`/api/git-connections/${gh.id}/repos`);
  assert.deepEqual(repos, [{ name: 'octo/refunds', url: 'https://github.com/octo/refunds', defaultBranch: 'main', description: 'Refund service' }]);

  // Team connections: everyone sees them; only admins and their maker change them.
  const bobView = (await bob.get('/api/git-connections')).connections.find((c: any) => c.id === gh.id);
  assert.equal(bobView.canManage, false);
  assert.equal((await bob.req('PUT', `/api/git-connections/${gh.id}`, { name: 'Mine now' })).status, 403);
  assert.equal((await bob.req('DELETE', `/api/git-connections/${gh.id}`)).status, 403);

  // Personal connections are invisible to others.
  const { connection: own } = await bob.post('/api/git-connections', { provider: 'git', name: 'Bob GitLab', scope: 'personal', host: 'https://gitlab.example.com', username: 'bob', token: 'glpat-secret-9876' });
  assert.equal(own.canManage, true);
  assert.ok(!(await admin.get('/api/git-connections')).connections.some((c: any) => c.id === own.id), 'admins do not see personal connections either');
  assert.equal((await admin.req('POST', `/api/git-connections/${own.id}/test`)).status, 404);

  // Checks on what is saved.
  assert.equal((await admin.req('POST', '/api/git-connections', { provider: 'git', name: 'x', host: 'http://insecure', username: 'u', token: 't' })).status, 400);
  assert.equal((await admin.req('POST', '/api/git-connections', { provider: 'bitbucket', name: 'x', workspace: 'team', username: 'u' })).status, 400, 'a token is required');
  assert.equal((await admin.req('POST', '/api/git-connections', { provider: 'codecommit', name: 'x', awsConnectionId: 'nope' })).status, 400);
});

test('a repository can clone through a connection, which then cannot be removed while in use', async () => {
  const { connection } = await admin.post('/api/git-connections', { provider: 'git', name: 'Local git', host: 'https://git.example.com', username: 'agent', token: 'tok-local-5555' });
  const bare = makeRepo(path.join(srv.dataDir, 'conn-fixture'));
  const url = `file:///${bare.replace(/\\/g, '/').replace(/^\//, '')}`;
  const { repo } = await admin.post(`/api/projects/${pid}/repos`, { connectionId: connection.id, url, name: 'via-connection' });
  assert.equal(repo.connection.id, connection.id);
  assert.equal(repo.provider, 'git');
  await waitFor(async () => {
    const r = (await admin.get(`/api/projects/${pid}/repos`)).repos.find((x: any) => x.id === repo.id);
    return r.status === 'ready' ? r : r.status === 'error' ? Promise.reject(new Error(r.error)) : null;
  }, 'clone through the connection');
  const listed = (await admin.get('/api/git-connections')).connections.find((c: any) => c.id === connection.id);
  assert.equal(listed.usedBy, 1);
  assert.equal(listed.usedByRepos[0].name, 'via-connection');

  const blocked = await admin.req('DELETE', `/api/git-connections/${connection.id}`);
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /Still used by 1 repository/);
  assert.equal((await admin.req('PUT', `/api/git-connections/${connection.id}`, { scope: 'personal' })).status, 400, 'a used team connection stays shared');

  // Someone else's personal connection cannot be borrowed.
  const { connection: bobs } = await bob.post('/api/git-connections', { provider: 'git', name: 'Bob only', scope: 'personal', host: 'https://git.example.com', username: 'b', token: 'tok-b-1111' });
  assert.equal((await admin.req('POST', `/api/projects/${pid}/repos`, { connectionId: bobs.id, url: 'https://git.example.com/x.git' })).status, 400);

  await admin.del(`/api/repos/${repo.id}`);
  await admin.del(`/api/git-connections/${connection.id}`);
  assert.ok(!(await admin.get('/api/git-connections')).connections.some((c: any) => c.id === connection.id));
});
