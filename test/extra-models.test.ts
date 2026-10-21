import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, Client, type TestServer } from './client.ts';

let srv: TestServer;
let admin: Client;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
});

after(() => srv.close());

test('extra Claude models reach the picker without a deploy, even when the provider list cannot be read', async () => {
  const bad = await admin.req('PUT', '/api/settings', { modelList: { extra: 'claude-ok\nnot a model id!' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Line 2/);

  const saved = await admin.put('/api/settings', { provider: { mode: 'anthropic' }, modelList: { extra: '# new this week\nclaude-opus-5-5 | Claude Opus 5.5\n  claude-haiku-5-5  \nclaude-opus-5-5 | duplicate' } });
  assert.equal(saved.modelList.extra, 'claude-opus-5-5 | Claude Opus 5.5\nclaude-haiku-5-5', 'cleaned, comments and duplicates dropped');

  // No API key is stored, so Anthropic's own list fails; the extras are still offered.
  const r = await admin.get('/api/models');
  assert.equal(r.mode, 'anthropic');
  assert.ok(r.error, 'the provider list itself failed');
  assert.deepEqual(r.models.map((m: any) => [m.id, m.name, m.family]), [
    ['claude-opus-5-5', 'Claude Opus 5.5', 'opus'],
    ['claude-haiku-5-5', 'claude-haiku-5-5', 'haiku'],
  ]);

  await admin.put('/api/settings', { provider: { mode: 'kiro' } });
  const k = await admin.get('/api/models');
  assert.ok(!k.models.some((m: any) => m.id === 'claude-opus-5-5'), 'Kiro has its own model ids, so the extras are not added there');
});
