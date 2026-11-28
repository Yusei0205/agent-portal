/**
 * Branch scans reviewed with the person's own engine (their Claude, Kiro or ChatGPT sign-in and a chosen model) instead of the
 * portal's LiteLLM / Anthropic setting.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { _scanProviders, buildScanPrompts, engineCredentialOf } from '../server/scan.ts';
import { one, run } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { getCredentialsRepository } from '../server/repositories/credentials.ts';

async function pollUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('scan prompts', () => {
  it('asks for a JSON array of findings and carries the file and the background', () => {
    const { system, user } = buildScanPrompts('src/a.ts', 'const x = 1;', 'Payments rules');
    assert.match(system, /senior code reviewer/);
    assert.match(system, /Background context:\nPayments rules/);
    assert.match(user, /Review this file: src\/a\.ts/);
    assert.match(user, /const x = 1;/);
    assert.match(user, /JSON array only/);
    assert.doesNotMatch(buildScanPrompts('a', 'b', '').system, /Background/);
  });
  it('reads the sign-in out of an engine provider id', () => {
    assert.equal(engineCredentialOf('engine:abc'), 'abc');
    assert.equal(engineCredentialOf('engine:codex-account'), 'codex-account');
    assert.equal(engineCredentialOf('engine:'), null);
    assert.equal(engineCredentialOf('litellm'), null);
    assert.equal(engineCredentialOf(null), null);
  });
});

describe('scan on the person\'s own engine', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let repoId: string;
  let userId: string;
  const credId = generateId();
  const origTree = _scanProviders.fetchFileTree;
  const origContent = _scanProviders.fetchFileContent;
  const origEngine = _scanProviders.engineReview;
  const origLite = _scanProviders.liteLLMReview;
  const calls: Array<{ userId: string; credentialId: string | null; model: string | null }> = [];

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    const r = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `a-${Date.now()}@example.com`, name: 'A', password: 'password1234', provider: 'demo' } });
    cookie = r.cookie ?? '';
    userId = one<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
    const pr = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `Scan engine ${Date.now()}` }, cookie });
    projectId = ((pr.body as any).project as any).id;
    repoId = generateId();
    run('INSERT INTO repositories (id, project_id, name, url, provider, status, created_at) VALUES (?,?,?,?,?,?,?)', repoId, projectId, 'r', 'https://github.com/o/r.git', 'github', 'ready', now());
    await getCredentialsRepository().create({ id: credId, user_id: userId, engine: 'claude-code', name: 'Mine', mode: 'api_key', secret_enc: null, extra_config: '{}', is_default: 1, last4: '', created_at: now(), updated_at: now() } as never);
    _scanProviders.fetchFileTree = async () => ({ files: [{ path: 'a.ts', size: 400, sha: 's1' }, { path: 'b.ts', size: 400, sha: 's2' }], pinnedSha: 'c1' });
    _scanProviders.fetchFileContent = async (_r, p) => `// ${p}\n`.repeat(20);
    _scanProviders.engineReview = async (_c, _p, _b, opts) => { calls.push(opts); return { text: '[]', inputTokens: 100, outputTokens: 20 }; };
    _scanProviders.liteLLMReview = async () => { throw new Error('LiteLLM must not be used'); };
  });

  after(async () => {
    _scanProviders.fetchFileTree = origTree;
    _scanProviders.fetchFileContent = origContent;
    _scanProviders.engineReview = origEngine;
    _scanProviders.liteLLMReview = origLite;
    await cleanup();
  });

  const create = async (body: Record<string, unknown>) => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/scans`, { method: 'POST', body: { repoId, ...body }, cookie });
    return r;
  };
  const ready = async (scanId: string) => pollUntil(() => one<{ status: string }>('SELECT status FROM p10_scans WHERE id = ?', scanId)?.status === 'estimate_ready');
  const finish = async (scanId: string) => {
    const c = await fetchJson(baseUrl, `/api/projects/${projectId}/scans/${scanId}/confirm`, { method: 'POST', body: { budgetTokens: 100000 }, cookie });
    assert.equal(c.status, 200);
    await pollUntil(() => ['completed', 'failed'].includes(String(one<{ status: string }>('SELECT status FROM p10_scans WHERE id = ?', scanId)?.status)));
    return one<{ status: string; provider_id: string | null; model_id: string | null; files_done: number }>('SELECT status, provider_id, model_id, files_done FROM p10_scans WHERE id = ?', scanId)!;
  };

  it('reviews every file with the chosen sign-in and model, and records them', async () => {
    const r = await create({ credentialId: credId, model: 'claude-sonnet-4-5' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const scanId = ((r.body as any).scan as any).id as string;
    await ready(scanId);
    calls.length = 0;
    const done = await finish(scanId);
    assert.equal(done.status, 'completed');
    assert.equal(done.files_done, 2);
    assert.equal(done.provider_id, `engine:${credId}`);
    assert.equal(done.model_id, 'claude-sonnet-4-5');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { userId, credentialId: credId, model: 'claude-sonnet-4-5' });
  });

  it('with no portal provider, the creator\'s own default sign-in reviews instead of refusing', async () => {
    const r = await create({});
    const scanId = ((r.body as any).scan as any).id as string;
    await ready(scanId);
    calls.length = 0;
    const done = await finish(scanId);
    assert.equal(done.status, 'completed');
    assert.equal(done.provider_id, 'engine:');
    assert.equal(calls[0]?.credentialId, null, 'null means their default sign-in');
  });

  it('refuses a sign-in that is not the creator\'s', async () => {
    const r = await create({ credentialId: 'someone-elses' });
    assert.equal(r.status, 400);
  });
});
