import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type http from 'node:http';
import { CodexClient } from '../server/codex-client.ts';
import { createCodexRunnerServer } from '../codex-runner/src/service.ts';
import { restoreCodexState, saveCodexState } from '../codex-runner/src/state.ts';

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

describe('Codex AgentCore runner HTTP contract', () => {
  let root: string, server: http.Server, base: string;
  const payload = (prompt = 'Test goal') => ({ mode: 'codex-run', runId: 'run-fixture', workflowId: 'workflow-fixture', prompt, accessToken: 'fake-short-lived-access-token',
    stateSnapshot: { putUrl: 'https://example.s3.amazonaws.com/state?signature=fixture' } });
  const post = (body: object) => fetch(base + '/invocations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-codex-runner-test-'));
    server = createCodexRunnerServer({ root, restoreState: async () => true, saveState: async () => true,
      openClient: async (home, env, cwd, options) => {
        const client = new CodexClient(spawn(process.execPath, [path.resolve('test/fake-codex.mjs')], {
          cwd, env: { ...env, CODEX_HOME: home, ACCESS_TOKEN: options?.accessToken, ...options?.extraEnv }, stdio: 'pipe', windowsHide: true,
        }));
        await client.request('initialize', { clientInfo: { name: 'runner-test', version: '1' } }); return client;
      },
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('portal-codex-runner-test-')) await fs.rm(root, { recursive: true, force: true });
  });

  it('validates authentication payloads, rejects refresh credentials, and reports health', async () => {
    assert.equal((await (await fetch(base + '/ping')).json() as any).status, 'Healthy');
    assert.equal((await post({ ...payload(), accessToken: '' })).status, 400);
    assert.equal((await post({ ...payload(), refreshToken: 'never-deliver-to-worker' })).status, 400);
    assert.equal((await post({ ...payload(), workflowId: '../other' })).status, 400);
    assert.equal((await post({ mode: 'unknown' })).status, 400);
    assert.equal((await post({ ...payload(), accessToken: undefined, chatgptAuthTokens: { accessToken: 'native-token' } })).status, 400);
    assert.equal((await post({ ...payload(), chatgptAuthTokens: { accessToken: 'native-token', chatgptAccountId: 'account' } })).status, 400);
    assert.equal((await post({ ...payload(), accessToken: undefined, chatgptAuthTokens: { accessToken: 'native-token', chatgptAccountId: 'account', refresh_token: 'must-not-reach-workspace' } })).status, 400);
  });
  it('streams a turn, reports tokens and durable state, then resumes on the same thread', async () => {
    const first = await events(await post(payload()));
    const result = first.find(e => e.type === 'result');
    assert.equal(result.exitCode, 0); assert.equal(result.text, 'Hello from Codex');
    assert.equal(result.inputTokens, 100); assert.equal(result.stateSaved, true);
    assert.equal(first.some(e => e.type === 'portal-event' && e.eventType === 'tool-start'), true);
    const second = await events(await post({ ...payload('Continue'), threadId: result.threadId }));
    assert.equal(second.find(e => e.type === 'result').threadId, result.threadId);
    assert.equal((await post({ ...payload(), workflowId: 'different-owner-session' })).status, 403);
  });
  it('redacts the access token from all streamed output and keeps it out of files', async () => {
    const output = await events(await post(payload('ECHO_TOKEN')));
    assert.equal(JSON.stringify(output).includes('fake-short-lived-access-token'), false);
    assert.equal(output.find(e => e.type === 'result').text, '***');
    await assert.rejects(fs.access(path.join(root, 'home', 'auth.json')));
  });
  it('uses the selected Codex role and setup in cloud turns', async () => {
    const output = await events(await post({ ...payload('ECHO_SETUP'), leadAgent: 'backend', codexConfig: [
      { path: 'AGENTS.md', content: 'Follow team conventions.' },
      { path: 'config.toml', content: 'model_reasoning_effort = "high"' },
      { path: 'agents/backend.toml', content: 'name="backend"\ndescription="Backend specialist"\ndeveloper_instructions="Own the backend implementation."' },
    ] }));
    const result = output.find(e => e.type === 'result');
    assert.equal(result.exitCode, 0);
    const setup = JSON.parse(result.text);
    assert.match(setup.instructions, /Own the backend implementation/);
    assert.equal(setup.config.model_reasoning_effort, 'high');
    assert.ok(setup.config.agents.backend.config_file.endsWith('backend.toml'));
    assert.equal(setup.config['sandbox_workspace_write.network_access'], false);
  });
  it('supports isolated portal AI generation and denies its tool approvals', async () => {
    const output = await events(await post({ mode: 'codex-text', prompt: 'ASK_PERMISSION', accessToken: 'short-lived' }));
    assert.equal(output.find(e => e.type === 'result').text, 'Declined action');
    assert.equal(output.some(e => e.type === 'approval-request'), false);
    assert.equal((await post({ mode: 'codex-text', prompt: 123, accessToken: 'short-lived' })).status, 400);
  });
  it('binds approvals to the exact command and accepts only the matching answer', async () => {
    let asked = false;
    const output = await events(await post(payload('ASK_PERMISSION')), async event => {
      if (event.type !== 'approval-request') return;
      asked = true;
      const answer = { mode: 'answer', runId: 'run-fixture', requestId: event.requestId, decision: 'allow', inputHash: event.inputHash };
      const wrong = (await events(await post({ ...answer, inputHash: '0'.repeat(64) })))[0];
      assert.equal(wrong.type, 'answer-rejected');
      const right = (await events(await post(answer)))[0];
      assert.equal(right.type, 'answer-accepted');
    });
    assert.equal(asked, true); assert.equal(output.find(e => e.type === 'result').text, 'Approved action');
  });
  it('cancels active work, rejects overlapping runs, and reports HealthyBusy while waiting', async () => {
    const running = post(payload('HANG_FOREVER'));
    const response = await running;
    assert.equal((await (await fetch(base + '/ping')).json() as any).status, 'HealthyBusy');
    assert.equal((await post(payload())).status, 409);
    assert.equal((await post({ mode: 'cancel', runId: 'wrong-run' })).status, 409);
    assert.equal((await post({ mode: 'cancel', runId: 'run-fixture' })).status, 200);
    const output = await events(response);
    assert.equal(output.find(e => e.type === 'result').cancelled, true);
  });
  it('returns failure instead of a successful result when the agent turn fails', async () => {
    const output = await events(await post(payload('FAIL_TURN')));
    assert.equal(output.find(e => e.type === 'result').exitCode, 1);
    assert.equal(output.some(e => e.type === 'error'), true);
  });
});

describe('Codex conversation snapshot allowlist', () => {
  it('restores conversation files without auth.json or MCP configuration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-codex-state-test-'));
    const home = path.join(root, 'original'), restored = path.join(root, 'restored');
    await fs.mkdir(path.join(home, 'sessions', '2026'), { recursive: true });
    await fs.writeFile(path.join(home, 'sessions', '2026', 'turn.jsonl'), 'conversation');
    await fs.writeFile(path.join(home, 'state_5.sqlite'), 'fixture-state');
    await fs.writeFile(path.join(home, 'auth.json'), 'private-refresh-token');
    await fs.writeFile(path.join(home, 'config.toml'), 'private-mcp-config');
    const originalFetch = globalThis.fetch; let archive: Uint8Array | undefined;
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === 'PUT') { archive = new Uint8Array(init.body as Buffer); return new Response('', { status: 200 }); }
      return new Response(archive as any, { status: 200 });
    }) as typeof fetch;
    try {
      assert.equal(await saveCodexState(home, { putUrl: 'https://example.s3.amazonaws.com/state' }), true);
      assert.equal(await restoreCodexState(restored, { getUrl: 'https://example.s3.amazonaws.com/state', putUrl: 'https://example.s3.amazonaws.com/state' }), true);
      assert.equal(await fs.readFile(path.join(restored, 'sessions', '2026', 'turn.jsonl'), 'utf8'), 'conversation');
      await assert.rejects(fs.access(path.join(restored, 'auth.json')));
      await assert.rejects(fs.access(path.join(restored, 'config.toml')));
    } finally {
      globalThis.fetch = originalFetch;
      if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('portal-codex-state-test-')) await fs.rm(root, { recursive: true, force: true });
    }
  });
});
