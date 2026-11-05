import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one } from '../server/db.ts';
import { CodexClient } from '../server/codex-client.ts';
import { codexHome, setCodexClientFactoryForTests } from '../server/codex-auth.ts';
import { getCodexConfigFiles, isCacheExcluded, shouldIncludeLocalFile } from '../server/user-config.ts';
import { parseCodexFiles, applyCodexConfig, codexAgents } from '../server/agent/codex-config.ts';
import { callTextModel, pickTextEngine } from '../server/testing/model-provider.ts';
// @ts-expect-error plain JS pack definition
import { agentPackFiles, PACK_AGENTS, PACK_SKILLS } from '../web/src/lib/agent-pack/index.js';

describe('Codex Portal AI provider and Agent setup', () => {
  let base: string, cookie: string, userId: string, otherId: string;
  const pack = agentPackFiles('codex') as Array<{ path: string; content: string }>;
  before(async () => {
    ({ baseUrl: base } = await createTestServer());
    const setup = await fetchJson(base, '/api/auth/setup', { method: 'POST', body: { name: 'Admin', email: 'codex-setup@example.test', password: 'password1234' } });
    cookie = setup.cookie!; userId = one<any>('SELECT id FROM users WHERE email = ?', 'codex-setup@example.test').id;
    const other = await fetchJson(base, '/api/users', { method: 'POST', cookie, body: { name: 'Other', email: 'codex-other@example.test', password: 'password1234' } });
    assert.equal(other.status, 201); otherId = (other.body as any).user.id;
    await fs.mkdir(codexHome(userId), { recursive: true });
    await fs.writeFile(path.join(codexHome(userId), 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"refresh_token":"fixture"}}');
    setCodexClientFactoryForTests(async (home, env, cwd) => {
      const client = new CodexClient(spawn(process.execPath, [path.resolve('test/fake-codex.mjs')], { cwd, env: { ...env, CODEX_HOME: home }, windowsHide: true, stdio: 'pipe' }));
      await client.request('initialize', {}); return client;
    });
  });
  after(async () => { setCodexClientFactoryForTests(null); await cleanup(); });
  it('saves the provider, lists the requesting account models, and checks its connection', async () => {
    const saved = await fetchJson(base, '/api/settings', { method: 'PUT', cookie, body: { provider: { mode: 'codex' }, defaultModel: 'fixture-model' } });
    assert.equal(saved.status, 200); assert.equal((saved.body as any).provider.mode, 'codex');
    const models = await fetchJson(base, '/api/settings/models?provider=codex', { cookie });
    assert.equal(models.status, 200); assert.ok((models.body as any).groups[0].models.length);
    const check = await fetchJson(base, '/api/settings/test', { method: 'POST', cookie, body: { modeOverride: 'codex' } });
    assert.equal((check.body as any).ok, true);
    assert.equal(JSON.stringify(check.body).includes('refresh_token'), false);
  });
  it('runs portal generation using the user sign-in and never borrows the administrator connection', async () => {
    assert.equal(await callTextModel('Return only the answer', 'Test request', { createdBy: userId }), 'Hello from Codex');
    assert.equal(await pickTextEngine(userId, 'codex-account'), 'codex');
    assert.equal(await callTextModel('Return JSON', '{}', { createdBy: userId, credentialId: 'codex-account' }), 'Hello from Codex');
    await assert.rejects(callTextModel('Test', 'Test', { createdBy: otherId }), /Connect your ChatGPT account/);
    await assert.rejects(callTextModel('Test', 'Test'), /signed-in portal user/);
    await assert.rejects(callTextModel('Test', 'Test', { createdBy: userId, images: [{ data: Buffer.from('image'), mimeType: 'image/png', filename: 'image.png' }] }), /text only/);
  });
  it('installs the Codex agent pack, lists roles, and publishes and restores team defaults', async () => {
    parseCodexFiles(pack);
    assert.equal(codexAgents(pack).length, PACK_AGENTS.length);
    assert.equal(pack.filter(f => f.path.endsWith('/SKILL.md')).length, PACK_SKILLS.length);
    for (const file of pack) {
      const write = await fetchJson(base, '/api/user-config/codex/file', { method: 'POST', cookie, body: file });
      assert.equal(write.status, 201, JSON.stringify(write.body));
    }
    const agents = await fetchJson(base, '/api/user-config/agents?engine=codex', { cookie });
    assert.equal((agents.body as any).agents.length, PACK_AGENTS.length);
    assert.ok((agents.body as any).agents.some((a: any) => a.name === 'lead-orchestrator'));
    assert.equal((await getCodexConfigFiles(userId)).length, pack.length);
    const published = await fetchJson(base, '/api/admin/user-config/codex/publish', { method: 'POST', cookie, body: {} });
    assert.equal(published.status, 201);
    await fetchJson(base, '/api/user-config/codex/file', { method: 'PUT', cookie, body: { path: 'AGENTS.md', content: 'Personal version' } });
    assert.equal((await fetchJson(base, '/api/user-config/codex/reset', { method: 'POST', cookie, body: {} })).status, 200);
    assert.match((await getCodexConfigFiles(userId)).find(f => f.path === 'AGENTS.md')!.content, /Agent Portal team/);
    const exported = await fetch(base + '/api/user-config/codex/export', { headers: { cookie } });
    const zip = await JSZip.loadAsync(Buffer.from(await exported.arrayBuffer()));
    assert.ok(zip.file('agents/lead-orchestrator.toml')); assert.equal(zip.file('auth.json'), null);
  });
  it('rejects unsafe setup and malformed TOML even with force enabled', async () => {
    for (const file of [
      { path: 'auth.json', content: '{}' }, { path: 'config.toml', content: 'model_provider = "foreign"' },
      { path: 'config.toml', content: 'hooks = [' },
      { path: 'agents/escape.toml', content: 'name="escape"\ndescription="invalid"\ndeveloper_instructions="test"\nsandbox_mode="danger-full-access"' },
    ]) {
      assert.equal((await fetchJson(base, '/api/user-config/codex/file', { method: 'PUT', cookie, body: { ...file, force: true } })).status, 400);
    }
    assert.equal(shouldIncludeLocalFile('codex', 'auth.json', 10).include, false);
    assert.equal(shouldIncludeLocalFile('codex', 'skills/task/SKILL.md', 10).include, true);
    assert.equal(isCacheExcluded('auth.json'), true);
    assert.throws(() => parseCodexFiles([...pack, pack[0]]), /duplicate/);
    assert.throws(() => parseCodexFiles([{ path: 'skills/../../auth.json', content: '{}' }]), /Unsupported/);
  });
  it('applies the selected role and removes obsolete setup without changing credentials or threads', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-setup-test-'));
    try {
      await fs.writeFile(path.join(home, 'auth.json'), 'private');
      await fs.writeFile(path.join(home, 'state_5.sqlite'), 'conversation');
      const configured = applyCodexConfig(home, pack, 'backend-engineer');
      assert.match(configured.instructions, /backend/i);
      assert.equal(Object.keys(configured.config.agents as object).length, PACK_AGENTS.length);
      assert.throws(() => applyCodexConfig(home, pack, 'missing-agent'), /not in your Agent setup/);
      applyCodexConfig(home, [], null);
      await assert.rejects(fs.access(path.join(home, 'agents', 'backend-engineer.toml')));
      assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), 'private');
      assert.equal(await fs.readFile(path.join(home, 'state_5.sqlite'), 'utf8'), 'conversation');
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
});
