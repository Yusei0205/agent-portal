import { it } from 'node:test';
import assert from 'node:assert/strict';
import { openCodexPrTool, parseCodexPrRequest, CODEX_PR_TOOL, type CodexPrRequest } from '../server/agent/codex-pr-tool.ts';
import { McpHttpClient } from '../server/agent/runner-mcp.ts';
import type { CodexSessionContext } from '../server/agent/codex-session.ts';

it('validates attached repositories and exact base branch names', () => {
  assert.deepEqual(parseCodexPrRequest({ repo: 'portal', base: 'main_v3' }, ['portal']), { repo: 'portal', base: 'main_v3' });
  for (const input of [{ repo: 'other', base: 'main_v3' }, { repo: 'portal', base: '--all' }, { repo: 'portal', base: 'a..b' },
    { repo: 'portal', base: 'main', token: 'forbidden' }]) assert.throws(() => parseCodexPrRequest(input, ['portal']));
});

it('offers a credential-free MCP PR handoff, respects policy/approval, and refuses calls after cancellation', async () => {
  const controller = new AbortController();
  let prompts = 0;
  const queued: CodexPrRequest[] = [];
  const ctx: CodexSessionContext = { run: { workDir: process.cwd(), goal: '', trusted: true, model: null, engineSessionId: null, permissions: { rules: [] } },
    allowed: new Set(), signal: controller.signal, emit: () => {}, awaitInput: async (tool, input) => {
      assert.equal(tool, CODEX_PR_TOOL); assert.deepEqual(input, { repo: 'portal', base: 'main_v3' });
      prompts++; return { decision: 'deny', remember: false, message: '' };
    } };
  const tool = await openCodexPrTool(ctx, ['portal'], request => queued.push(request));
  try {
    const client = new McpHttpClient(tool.url, {});
    const tools = await client.listTools();
    assert.equal(tools[0].name, 'create_pull_request');
    const request = { repo: 'portal', base: 'main_v3' };
    const result = await client.callTool('create_pull_request', request) as any;
    assert.equal(result.isError, false); assert.match(result.content[0].text, /queued.*main_v3/);
    assert.deepEqual(queued, [request]); assert.equal(prompts, 0);
    assert.equal((await client.callTool('create_pull_request', { ...request, repo: 'unattached' }) as any).isError, true);
    ctx.run.trusted = false;
    assert.equal((await client.callTool('create_pull_request', request) as any).isError, true);
    assert.equal(prompts, 1); assert.equal(queued.length, 1);
    ctx.run.trusted = true;
    ctx.run.permissions.rules = [{ id: 'block', pattern: 'create_pull_request', category: null, action: 'block', scope: 'always', reason: 'PRs blocked' }];
    assert.equal((await client.callTool('create_pull_request', request) as any).isError, true);
    assert.equal(queued.length, 1);
    ctx.run.permissions.rules = [];
    controller.abort();
    assert.equal((await client.callTool('create_pull_request', request) as any).isError, true);
    assert.equal(queued.length, 1);
  } finally { tool.close(); }
  await assert.rejects(fetch(tool.url));
});
