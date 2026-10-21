import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, Client, type TestServer } from './client.ts';

let srv: TestServer;
let admin: Client;
let pid: string;
let exec: typeof import('../server/db.ts').run;

/** A script's request: a bearer token, no cookie, no browser header. */
async function call(token: string, method: string, url: string, body?: unknown) {
  const res = await fetch(srv.base + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, data };
}

before(async () => {
  srv = await bootServer();
  ({ run: exec } = await import('../server/db.ts'));
  admin = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
  pid = (await admin.post('/api/projects', { name: 'Api', description: 'd' })).project.id;
});

after(() => srv.close());

test('a token is shown once, acts as its owner, and reads without a browser', async () => {
  const { token, info } = await admin.post('/api/tokens', { name: 'CI', days: 30 });
  assert.match(token, /^ap_[A-Za-z0-9_-]{40}$/);
  assert.equal(info.scope, 'read');
  assert.equal(info.prefix, token.slice(0, 10));
  assert.ok(!JSON.stringify(await admin.get('/api/tokens')).includes(token), 'the token is never listed again');
  const projects = await call(token, 'GET', '/api/projects');
  assert.equal(projects.status, 200);
  assert.ok(projects.data.projects.some((p: any) => p.id === pid));
  const write = await call(token, 'POST', `/api/projects/${pid}/workflows`, { goal: 'x', start: false });
  assert.equal(write.status, 403);
  assert.match(write.data.error, /can only read/);
});

test('a write token starts and steers sessions, without the browser-only header', async () => {
  const { token } = await admin.post('/api/tokens', { name: 'Bot', scope: 'write', days: 90 });
  const created = await call(token, 'POST', `/api/projects/${pid}/workflows`, { goal: 'Started from a script', start: false, playground: true });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.workflow.id;
  assert.equal((await call(token, 'POST', `/api/workflows/${id}/messages`, { body: 'and go' })).status, 200);
  const d = await call(token, 'GET', `/api/workflows/${id}`);
  assert.ok(d.data.events.some((e: any) => e.kind === 'human' && e.data.by === 'Ann'), 'it acts as the person who made it');
  await call(token, 'POST', `/api/workflows/${id}/stop`);
});

test('browser-only endpoints refuse tokens, so a leaked one cannot escalate', async () => {
  const { token } = await admin.post('/api/tokens', { name: 'Leaky', scope: 'write', days: 30 });
  for (const [method, url, body] of [
    ['GET', '/api/tokens'],
    ['POST', '/api/tokens', { name: 'more' }],
    ['GET', '/api/users'],
    ['GET', '/api/settings'],
    ['GET', '/api/git-connections'],
    ['POST', '/api/integrations', { kind: 'http', name: 'x', url: 'https://x' }],
    ['GET', '/api/aws/connections'],
    ['POST', '/api/runs/r_x/push', {}],
    ['DELETE', `/api/projects/${pid}`],
    ['PUT', `/api/projects/${pid}/config/file`, { path: '.claude/settings.json', content: '{}' }],
  ] as [string, string, unknown?][]) {
    const r = await call(token, method, url, body);
    assert.equal(r.status, 403, `${method} ${url} -> ${r.status}`);
  }
  // Even an admin's token cannot touch protected configuration.
  const agent = await call(token, 'PUT', `/api/projects/${pid}/config/file`, { path: '.claude/agents/bot.md', content: '---\nname: bot\ndescription: d\n---\nx\n' });
  assert.equal(agent.status, 200, 'ordinary agent files can be edited with a write token');
});

test('revoked, expired, unknown tokens and disabled owners are refused; at most 10 active', async () => {
  const { token, info } = await admin.post('/api/tokens', { name: 'Short', days: 30 });
  assert.equal((await call('ap_not-a-real-token', 'GET', '/api/projects')).status, 401);
  await admin.del(`/api/tokens/${info.id}`);
  assert.equal((await call(token, 'GET', '/api/projects')).status, 401, 'revoked');

  const { token: t2, info: i2 } = await admin.post('/api/tokens', { name: 'Old', days: 30 });
  exec('UPDATE api_tokens SET expires_at = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', i2.id);
  assert.equal((await call(t2, 'GET', '/api/projects')).status, 401, 'expired');

  const { token: t3 } = await admin.post('/api/tokens', { name: 'Gone', days: 30 });
  const uid = (await admin.get('/api/auth/state')).user.id;
  exec('UPDATE users SET disabled = 1 WHERE id = ?', uid);
  assert.equal((await call(t3, 'GET', '/api/projects')).status, 401, 'owner removed');
  exec('UPDATE users SET disabled = 0 WHERE id = ?', uid);

  assert.equal((await admin.req('POST', '/api/tokens', { name: 'Odd', days: 7 })).status, 400);
  const active = (await admin.get('/api/tokens')).tokens.filter((t: any) => t.active).length;
  for (let i = active; i < 10; i++) await admin.post('/api/tokens', { name: `n${i}`, days: 30 });
  const over = await admin.req('POST', '/api/tokens', { name: 'eleventh', days: 30 });
  assert.equal(over.status, 400);
  assert.match(over.data.error, /10 active tokens/);
});
