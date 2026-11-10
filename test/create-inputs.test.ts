import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectInputFiles, writeInputFiles, collectRunnerFiles } from '../server/agent/runner-files.ts';
import { resolveCreateAi } from '../server/create-ai.ts';
import { setCredentialsRepository, clearCredentialsRepository } from '../server/repositories/credentials.ts';

let tmp = '';
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'create-in-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('files staged for the runner', () => {
  test('attachments and project documents travel, nothing else', () => {
    fs.mkdirSync(path.join(tmp, 'attachments'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'docs', 'md'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'repos', 'x'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'attachments', 'brief.pdf'), 'pdf');
    fs.writeFileSync(path.join(tmp, 'docs', 'md', 'spec.md'), '# spec');
    fs.writeFileSync(path.join(tmp, 'repos', 'x', 'secret.md'), 'no');
    fs.writeFileSync(path.join(tmp, 'notes.md'), 'no');
    const files = collectInputFiles(tmp);
    assert.deepEqual(files.map((f) => f.path).sort(), ['attachments/brief.pdf', 'docs/md/spec.md']);
  });

  test('the runner writes them back and refuses anything outside the two folders', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'create-out-'));
    try {
      const b = (s: string) => Buffer.from(s).toString('base64');
      const n = writeInputFiles(out, [
        { path: 'docs/md/spec.md', data: b('# spec') },
        { path: 'attachments/a.csv', data: b('a,b') },
        { path: '../escape.md', data: b('x') },
        { path: 'repos/x/evil.md', data: b('x') },
        { path: '/etc/passwd', data: b('x') },
        { path: 'docs/md/run.sh', data: b('x') },
      ]);
      assert.equal(n, 2);
      assert.equal(fs.readFileSync(path.join(out, 'docs', 'md', 'spec.md'), 'utf8'), '# spec');
      assert.equal(fs.existsSync(path.join(out, '..', 'escape.md')), false);
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  });

  test('staged inputs are not sent back as results', () => {
    fs.mkdirSync(path.join(tmp, 'docs', 'md'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs', 'md', 'spec.md'), '# spec');
    fs.writeFileSync(path.join(tmp, 'document.md'), '# result');
    assert.deepEqual(collectRunnerFiles(tmp).files.map((f) => f.rel), ['document.md']);
  });
});

describe('which sign-in a Create run uses', () => {
  const cred = (id: string, engine: string, isDefault = 0) => ({ id, user_id: 'u1', engine, name: id, mode: 'api_key', secret_enc: null, extra_config: '{}', is_default: isDefault, last4: '', created_at: '', updated_at: '', updated_by: null });
  const stub = (list: ReturnType<typeof cred>[]) => setCredentialsRepository({
    getByIdAndUser: async (id: string, uid: string) => list.find((c) => c.id === id && c.user_id === uid) ?? null,
    getDefaultByUserAndEngine: async (_u: string, e: string) => list.find((c) => c.engine === e && c.is_default) ?? null,
    listByUser: async () => list,
  } as never);
  afterEach(() => { clearCredentialsRepository(); delete process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN; });

  test('the chosen sign-in and model win', async () => {
    stub([cred('k1', 'kiro', 1), cred('c1', 'claude-code')]);
    assert.deepEqual(await resolveCreateAi('u1', { credentialId: 'c1', model: 'claude-sonnet-4' }), { engine: 'claude-code', credential_id: 'c1', model: 'claude-sonnet-4' });
  });
  test('without a choice the default sign-in is used', async () => {
    stub([cred('k1', 'kiro', 1)]);
    assert.deepEqual(await resolveCreateAi('u1', {}), { engine: 'kiro', credential_id: 'k1', model: '' });
  });
  test('someone else\'s sign-in is refused', async () => {
    stub([cred('k1', 'kiro', 1)]);
    await assert.rejects(resolveCreateAi('u2', { credentialId: 'k1' }));
  });
  test('no sign-in: the cloud asks for one, a local portal keeps the simulated engine', async () => {
    stub([]);
    assert.equal((await resolveCreateAi('u1', {})).engine, 'demo');
    process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = 'arn:x';
    await assert.rejects(resolveCreateAi('u1', {}), /Agent sign-ins/);
  });
});
