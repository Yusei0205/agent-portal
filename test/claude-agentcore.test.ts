/**
 * Claude on AgentCore: event mapping, credential selection, errors, cancel.
 * Uses a fake AgentCore invoker, so no AWS or Anthropic calls are made.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setAgentCoreInvokerOverride } from '../server/agent/kiro-agentcore.ts';
import type { AgentCoreSSEEvent } from '../server/agent/kiro-agentcore.ts';
import { runClaudeViaAgentCore, anthropicAuthFromEnv, submitRepoChanges } from '../server/agent/claude-agentcore.ts';
import { _setSessionPrDeps } from '../server/session-pr.ts';
import type { RunContext } from '../server/agent/types.ts';

type Ev = Record<string, unknown>;

function makeCtx(signal: AbortSignal | null = null) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    run: {},
    emit: (type: string, payload: object) => { events.push({ type, payload: payload as Record<string, unknown> }); },
    awaitInput: async () => ({ decision: 'allow', remember: false, message: '' }),
    allowed: new Set<string>(),
    signal,
  } as unknown as RunContext;
  return { ctx, events };
}

const opts = (over: Record<string, unknown> = {}) => ({
  runtimeArn: 'arn:aws:bedrock-agentcore:ap-southeast-1:1:runtime/x',
  runId: 'run-1',
  prompt: 'do it',
  model: 'claude-sonnet-4-5',
  auth: { kind: 'api_key' as const, secret: 'sk-ant-SECRET123' },
  trustTools: false,
  ...over,
});

describe('anthropicAuthFromEnv', () => {
  it('prefers an API key, then a subscription token, and ignores Bedrock', () => {
    assert.deepEqual(anthropicAuthFromEnv({ ANTHROPIC_API_KEY: 'k' }), { kind: 'api_key', secret: 'k' });
    assert.deepEqual(anthropicAuthFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 't' }), { kind: 'oauth_token', secret: 't' });
    assert.equal(anthropicAuthFromEnv({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1' }), null);
    assert.equal(anthropicAuthFromEnv({}), null);
  });
});

describe('runClaudeViaAgentCore', () => {
  afterEach(() => _setAgentCoreInvokerOverride(null));

  it('sends the credential and limits, and maps runner events to run events', async () => {
    let sent: Record<string, unknown> = {};
    _setAgentCoreInvokerOverride(async function* (_arn, _sid, payload) {
      sent = payload;
      yield { type: 'status', text: 'Work dir: /tmp/x' } as unknown as AgentCoreSSEEvent;
      yield { type: 'status', text: 'Cloning repo' } as unknown as AgentCoreSSEEvent;
      yield { type: 'tool-call', name: 'Read', input: '{"file_path":"a"}' } as unknown as AgentCoreSSEEvent;
      yield { type: 'tool-result', name: 'Read', output: 'contents' } as unknown as AgentCoreSSEEvent;
      yield { type: 'tool-blocked', toolName: 'Bash', toolInput: '{}', reason: 'needs approval' } as unknown as AgentCoreSSEEvent;
      yield { type: 'assistant-text', text: 'Hello' } as unknown as AgentCoreSSEEvent;
      yield { type: 'assistant-text', text: 'World' } as unknown as AgentCoreSSEEvent;
      yield { type: 'result', stop_reason: 'end_turn', metrics: { costUsd: 0.12, inputTokens: 100, outputTokens: 50, cacheReadTokens: 7, cacheWriteTokens: 3 } } as unknown as AgentCoreSSEEvent;
    });
    const { ctx, events } = makeCtx();
    const res = await runClaudeViaAgentCore(ctx, opts({ maxBudgetUsd: 2, maxTurns: 30 }));

    assert.deepEqual(sent.auth, { kind: 'api_key', secret: 'sk-ant-SECRET123' });
    assert.equal(sent.trustTools, false);
    assert.equal(sent.model, 'claude-sonnet-4-5');
    assert.equal(sent.maxBudgetUsd, 2);
    assert.equal(sent.maxTurns, 30);

    assert.equal(res.text, 'Hello\nWorld');
    assert.equal(res.costUsd, 0.12);
    assert.equal(res.inputTokens, 100);
    assert.equal(res.outputTokens, 50);
    assert.equal(res.cacheReadTokens, 7);
    assert.equal(res.cacheWriteTokens, 3);

    const types = events.map((e) => e.type);
    assert.ok(types.includes('tool-start') && types.includes('tool-end') && types.includes('tool-blocked'));
    assert.deepEqual(events.filter((e) => e.type === 'assistant-text').map((e) => e.payload.text), ['Hello', 'World']);
    const statusTexts = events.filter((e) => e.type === 'status').map((e) => e.payload.text).filter(Boolean);
    assert.deepEqual(statusTexts, ['Running Claude via AgentCore…', 'Cloning repo'], 'work-dir noise is hidden');
  });

  it('turns a runner error into an error without leaking the key', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'error', message: 'Invalid API key sk-ant-SECRET123 rejected' } as unknown as AgentCoreSSEEvent;
    });
    const { ctx } = makeCtx();
    await assert.rejects(
      () => runClaudeViaAgentCore(ctx, opts()),
      (e: Error) => /AgentCore Claude run error/.test(e.message) && !e.message.includes('SECRET123'),
    );
  });

  it('stops when the run is cancelled', async () => {
    const ac = new AbortController();
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'assistant-text', text: 'part' } as unknown as AgentCoreSSEEvent;
      ac.abort();
      yield { type: 'assistant-text', text: 'late' } as unknown as AgentCoreSSEEvent;
    });
    const { ctx } = makeCtx(ac.signal);
    await assert.rejects(() => runClaudeViaAgentCore(ctx, opts()), (e: Error) => e.name === 'AbortError');
  });

  it('times out when the runner never finishes', async () => {
    process.env.PORTAL_RUN_TIMEOUT_MS = '50';
    try {
      _setAgentCoreInvokerOverride(async function* (_a, _s, _p, signal) {
        await new Promise<void>((_r, rej) => signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
        yield { type: 'status', text: 'never' } as unknown as AgentCoreSSEEvent;
      });
      const { ctx } = makeCtx();
      await assert.rejects(() => runClaudeViaAgentCore(ctx, opts()), (e: Error) => /aborted|timed out/.test(e.message));
    } finally {
      delete process.env.PORTAL_RUN_TIMEOUT_MS;
    }
  });
});

describe('repo-changes events', () => {
  afterEach(() => { _setAgentCoreInvokerOverride(null); _setSessionPrDeps(); });

  it('are collected on the result and not forwarded as run events; no repositories means no finalizeCheck', async () => {
    let sent: Record<string, unknown> = {};
    _setAgentCoreInvokerOverride(async function* (_a, _s, payload) {
      sent = payload;
      yield { type: 'repo-changes', repo: 'api', base: 'main', commits: 2, files: 5 } as unknown as AgentCoreSSEEvent;
      yield { type: 'result', stop_reason: 'end_turn', metrics: {} } as unknown as AgentCoreSSEEvent;
    });
    const { ctx, events } = makeCtx();
    const res = await runClaudeViaAgentCore(ctx, opts());
    assert.deepEqual(res.repoChanges, [{ repo: 'api', base: 'main', commits: 2, files: 5 }]);
    assert.ok(!events.some((e) => e.type === 'repo-changes'));
    assert.equal(sent.finalizeCheck, undefined);
  });

  it('submitRepoChanges calls the pull request step once, skips an empty list, and swallows its failure', async () => {
    const calls: unknown[][] = [];
    let fail = false;
    _setSessionPrDeps({ onRepoChanges: async (c, ch) => { calls.push([c, ch]); if (fail) throw new Error('boom'); } });
    const run = { runId: 'r1', workflowId: 'w1', projectId: 'p1', credentialOwnerId: 'u1' };
    await submitRepoChanges(run, null, []);
    await submitRepoChanges(run, null, undefined);
    assert.equal(calls.length, 0);
    const ch = [{ repo: 'api', base: 'main', commits: 1, files: 1 }];
    await submitRepoChanges(run, 'creator', ch);
    assert.deepEqual(calls[0], [{ workflowId: 'w1', runId: 'r1', projectId: 'p1', userId: 'u1', engine: 'claude-code' }, ch]);
    fail = true;
    await submitRepoChanges(run, null, ch);
    assert.equal(calls.length, 2);
  });
});
