import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type http from 'node:http';
import { createCursorRunnerServer } from '../cursor-runner/src/service.ts';
import { restoreCursorState, saveCursorState } from '../cursor-runner/src/state.ts';

async function events(response: Response, visit?: (event: any) => Promise<void>): Promise<any[]> {
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  const out: any[] = []; let buffer = '';
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      if (!block.startsWith('data: ')) continue;
      const event = JSON.parse(block.slice(6)); out.push(event); await visit?.(event);
    }
  }
  return out;
}

const KEY = 'crsr_fixture_key_0123456789';

describe('Cursor AgentCore runner HTTP contract', () => {
  let root: string, server: http.Server, base: string;
  let saved = 0;
  const payload = (prompt = 'Test goal') => ({ mode: 'cursor-run', runId: 'run-fixture', workflowId: 'workflow-fixture', prompt, apiKey: KEY,
    stateSnapshot: { putUrl: 'https://example.s3.amazonaws.com/state?signature=fixture' } });
  const post = (body: object) => fetch(base + '/invocations', { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) });
  const text = (evs: any[]): string => evs.filter(e => e.type === 'portal-event' && e.eventType === 'assistant-text').map(e => e.payload.text).join('');
  beforeEach(async () => {
    process.env.PORTAL_CURSOR_FAKE = path.resolve('test/fake-cursor.mjs');
    saved = 0;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-cursor-runner-test-'));
    server = createCursorRunnerServer({ root, restoreState: async () => true, saveState: async () => { saved++; return true; } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    delete process.env.PORTAL_CURSOR_FAKE;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('portal-cursor-runner-test-')) await fs.rm(root, { recursive: true, force: true });
  });

  it('reports health and validates the invocation', async () => {
    assert.equal((await (await fetch(base + '/ping')).json() as any).status, 'Healthy');
    assert.equal((await post({ ...payload(), apiKey: '' })).status, 400);
    assert.equal((await post({ ...payload(), apiKey: 'has space' })).status, 400);
    assert.equal((await post({ ...payload(), workflowId: '../other' })).status, 400);
    assert.equal((await post({ ...payload(), model: '--force' })).status, 400);
    assert.equal((await post({ ...payload(), sessionId: '--api-key=x' })).status, 400);
    assert.equal((await post({ mode: 'codex-run' })).status, 400);
    assert.equal((await post({ mode: 'unknown' })).status, 400);
  });

  it('streams a turn once, reports session, tokens and durable state, then resumes the same chat', async () => {
    const first = await events(await post(payload()));
    const result = first.find(e => e.type === 'result');
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 'fake-session-0001');
    assert.equal(result.stateSaved, true);
    assert.equal(result.usage.inputTokens, 100);
    assert.equal(text(first), 'Working on it.\n\nDone.');
    assert.ok(first.some(e => e.type === 'portal-event' && e.eventType === 'tool-start' && e.payload.toolName === 'Read'));
    assert.equal(saved, 1);
    const second = await events(await post({ ...payload('ECHO_ARGS'), sessionId: 'abc-resume-0002', trusted: true }));
    const args = JSON.parse(text(second).replace('Working on it.', '').replace(/^\n+/, '')) as string[];
    assert.equal(args[args.indexOf('--resume') + 1], 'abc-resume-0002');
    assert.ok(args.includes('--force'));
    assert.equal((await post({ ...payload(), workflowId: 'different-owner-session' })).status, 403);
  });

  it('never sends the API key back: it is redacted from events and not given to anything else', async () => {
    const evs = await events(await post(payload('ECHO_KEY')));
    assert.ok(!JSON.stringify(evs).includes(KEY));
    assert.match(text(evs), /key=\*\*\*/);
  });

  it('reports a failed turn with exit code 1, the CLI error, and no durable state claim', async () => {
    const evs = await events(await post(payload('FAIL')));
    assert.match(evs.find(e => e.type === 'error').message, /exited with code 1.*model unavailable/);
    const result = evs.find(e => e.type === 'result');
    assert.equal(result.exitCode, 1);
    assert.equal(result.stateSaved, undefined);
  });

  it('cancels a running turn, keeps the conversation, and refuses overlapping work meanwhile', async () => {
    let busy: Response | undefined;
    const evs = await events(await post(payload('HANG')), async (event) => {
      if (event.type !== 'portal-event' || busy) return;
      busy = await post(payload());
      assert.equal(busy.status, 409);
      assert.equal(((await (await fetch(base + '/ping')).json()) as any).status, 'HealthyBusy');
      assert.equal((await (await post({ mode: 'cancel', runId: 'wrong' })).status), 409);
      assert.equal((await post({ mode: 'cancel', runId: 'run-fixture' })).status, 200);
    });
    const result = evs.find(e => e.type === 'result');
    assert.equal(result.exitCode, 130); assert.equal(result.cancelled, true);
    assert.equal(result.sessionId, 'fake-session-0001'); assert.equal(result.stateSaved, true);
  });

  it('writes the saved rules into the workspace and refuses files that are not rules', async () => {
    await events(await post({ ...payload(), cursorConfig: [{ path: 'rules/team.mdc', content: 'be kind' }, { path: 'mcp.json', content: '{}' }] }));
    await assert.rejects(fs.access(path.join(root, 'work', '.cursor', 'rules')), 'a bundle with a non-rule file applies nothing');
    const evs = await events(await post({ ...payload(), cursorConfig: [{ path: 'rules/team.mdc', content: 'be kind' }] }));
    assert.equal(await fs.readFile(path.join(root, 'work', '.cursor', 'rules', 'portal-user-team.mdc'), 'utf8'), 'be kind');
    assert.ok(!evs.some(e => e.type === 'status' && /not applied/.test(e.text)));
  });

  it('accepts a login token instead of an API key, gives it to the CLI as CURSOR_AUTH_TOKEN, and redacts it', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = b64({ alg: 'none' }) + '.' + b64({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 86400 }) + '.' + 's'.repeat(24);
    const { apiKey: _drop, ...rest } = payload('ECHO_KEY');
    const evs = await events(await post({ ...rest, authToken: token }));
    assert.ok(!JSON.stringify(evs).includes(token), 'the token never leaves the runner');
    assert.ok(text(evs).includes('key=none;token=***'), text(evs));
    assert.equal(evs.find(e => e.type === 'result').exitCode, 0);
    const models = await events(await post({ mode: 'cursor-models', authToken: token }));
    assert.equal(models.find(e => e.type === 'models').models.length, 3);
    assert.ok(!JSON.stringify(models).includes(token));
  });

  it('needs exactly one credential, and checks the token is shaped like one', async () => {
    const token = 'aaaaaaaa.bbbbbbbb.cccccccc';
    const { apiKey: _drop, ...rest } = payload();
    assert.equal((await post({ ...payload(), authToken: token })).status, 400, 'both');
    assert.equal((await post({ ...rest })).status, 400, 'neither');
    assert.equal((await post({ ...rest, authToken: 'not a token' })).status, 400, 'bad shape');
    assert.equal((await post({ ...rest, authToken: 'a'.repeat(9000) })).status, 400, 'too long');
    assert.equal((await post({ mode: 'cursor-models' })).status, 400);
  });

  it('says MCP integrations are unavailable instead of dropping them silently', async () => {
    const evs = await events(await post({ ...payload(), mcpServers: [{ name: 'jira', url: 'https://example.com/mcp', headers: {} }] }));
    assert.ok(evs.some(e => e.type === 'status' && /MCP integrations are not available/.test(e.text)));
  });

  it('lists models through the CLI', async () => {
    const evs = await events(await post({ mode: 'cursor-models', apiKey: KEY }));
    const models = evs.find(e => e.type === 'models');
    assert.deepEqual(models.models.map((m: any) => m.id), ['auto', 'composer-2.5', 'grok-4.7-low-fast']);
  });
});

describe('Cursor conversation snapshot allowlist', () => {
  it('saves and restores only the chat store, never config or credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-cursor-state-test-'));
    const home = path.join(root, 'original'), restored = path.join(root, 'restored');
    await fs.mkdir(path.join(home, '.cursor', 'chats', 'hash1', 'sess-0001'), { recursive: true });
    await fs.writeFile(path.join(home, '.cursor', 'chats', 'hash1', 'sess-0001', 'store.db'), 'conversation');
    await fs.writeFile(path.join(home, '.cursor', 'cli-config.json'), 'private-config');
    await fs.writeFile(path.join(home, '.cursor', 'mcp.json'), 'private-mcp');
    const originalFetch = globalThis.fetch; let archive: Uint8Array | undefined;
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === 'PUT') { archive = new Uint8Array(init.body as Buffer); return new Response('', { status: 200 }); }
      return new Response(archive as any, { status: 200 });
    }) as typeof fetch;
    try {
      const snap = { getUrl: 'https://example.s3.amazonaws.com/state', putUrl: 'https://example.s3.amazonaws.com/state' };
      assert.equal(await saveCursorState(home, snap), true);
      assert.equal(await restoreCursorState(restored, snap), true);
      assert.equal(await fs.readFile(path.join(restored, '.cursor', 'chats', 'hash1', 'sess-0001', 'store.db'), 'utf8'), 'conversation');
      await assert.rejects(fs.access(path.join(restored, '.cursor', 'cli-config.json')));
      await assert.rejects(fs.access(path.join(restored, '.cursor', 'mcp.json')));
    } finally {
      globalThis.fetch = originalFetch;
      if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('portal-cursor-state-test-')) await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to save when the CLI produced no chat, and restores nothing without a download link', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-cursor-empty-test-'));
    try {
      await assert.rejects(saveCursorState(home, { putUrl: 'https://example.s3.amazonaws.com/state' }), /did not produce/);
      assert.equal(await restoreCursorState(home, { putUrl: 'https://example.s3.amazonaws.com/state' }), false);
      assert.equal(await saveCursorState(home, null), false);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
});
