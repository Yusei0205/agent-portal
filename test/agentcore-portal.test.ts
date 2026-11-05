/**
 * The portal side of AgentCore runs (Claude and Kiro): what it sends to the runner, how it
 * relays approval requests to people and answers back, and what it records.
 *
 * A stand-in runtime (_setAgentCoreInvokerOverride) plays the runner: it streams an
 * approval-request, waits for the "answer" invocation on the same session, then finishes.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb, cleanup } from './fixtures.ts';
import { getDb, one } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { setConfig, type Config } from '../server/config.ts';
import { _setAgentCoreInvokerOverride, runKiroViaAgentCore } from '../server/agent/kiro-agentcore.ts';
import { runClaudeViaAgentCore, bedrockModelFor, _setCancelGraceMs } from '../server/agent/claude-agentcore-bedrock.ts';
import { runClaudeViaAgentCore as runUserCredential, submitRepoChanges } from '../server/agent/claude-agentcore.ts';
import { _setSessionPrDeps } from '../server/session-pr.ts';
import { setPullRequestSettings } from '../server/project-settings-pr.ts';
import { inputFingerprint } from '../server/agent/tool-policy.ts';
import type { RunContext, AgentRun } from '../server/agent/types.ts';

const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/test-runtime';

function makeConfig(): Config {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-agentcore-harness-'));
  return {
    root: process.cwd(), port: 0, host: '127.0.0.1', dataDir,
    webDir: path.join(process.cwd(), 'dist', 'web'), secretKey: 'a'.repeat(64), cookieSecure: 'false',
    demoSpeed: 0, maxUploadBytes: 50 * 1024 * 1024, trustProxy: false, awsRegion: 'ap-southeast-1', deployTarget: null,
  } as Config;
}

function makeRun(engine: 'claude-code' | 'kiro', budget: number | null = null) {
  const db = getDb();
  const projectId = `proj-${generateId()}`;
  const workflowId = `wf-${generateId()}`;
  const runId = `run-${generateId()}`;
  db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(projectId, 'AC', `ac-${projectId.slice(5, 13)}`, now());
  db.prepare(
    `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, 0, '[]', ?, ?)`,
  ).run(workflowId, projectId, 'goal', engine, now(), now());
  if (budget != null) db.prepare('UPDATE p6_workflows SET budget_usd = ? WHERE id = ?').run(budget, workflowId);
  db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`).run(runId, workflowId, now());
  return { projectId, workflowId, runId };
}

type Asked = { toolName: string; input: Record<string, unknown> };

function makeCtx(
  ids: { projectId: string; workflowId: string; runId: string },
  opts: { engine: 'claude-code' | 'kiro'; answer?: 'allow' | 'deny'; remember?: boolean; rules?: unknown[]; trusted?: boolean },
) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const asked: Asked[] = [];
  const ctrl = new AbortController();
  const run: AgentRun = {
    runId: ids.runId, workflowId: ids.workflowId, projectId: ids.projectId, goal: 'do the thing', kind: null,
    engine: opts.engine, trusted: opts.trusted ?? false, dataDir: '', workDir: os.tmpdir(), repoIds: [], leadAgent: null,
    permissions: { rules: (opts.rules ?? []) as never, toolRules: [], projectId: ids.projectId },
    credentialId: null, credentialOwnerId: null, model: 'claude-haiku-4-5', engineSessionId: null,
  };
  const ctx: RunContext = {
    run,
    emit: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
    awaitInput: async (toolName, input) => {
      asked.push({ toolName, input });
      return { decision: opts.answer ?? 'allow', remember: opts.remember ?? false, message: opts.answer === 'deny' ? 'not now' : '' };
    },
    allowed: new Set(),
    signal: ctrl.signal,
  };
  return { ctx, events, asked, ctrl };
}

/**
 * A stand-in runner: records every invocation; a run waits for its answer before finishing.
 * With holdOpen, the run streams until the portal closes it, or, with cancelResult, until a
 * cancel arrives: then, like the real runner, it flushes a tool end and sends its final result.
 */
function fakeRuntime(script: {
  request?: { toolName: string; input: Record<string, unknown>; inputHash?: string };
  result?: Record<string, unknown>;
  holdOpen?: boolean;
  cancelResult?: Record<string, unknown>;
}) {
  const calls: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];
  let answered: (p: Record<string, unknown>) => void = () => {};
  const answer = new Promise<Record<string, unknown>>((r) => { answered = r; });
  let cancelled: () => void = () => {};
  const cancelSeen = new Promise<void>((r) => { cancelled = r; });
  _setAgentCoreInvokerOverride(async function* (_arn, sessionId, payload, signal) {
    calls.push({ sessionId, payload });
    if (payload.mode === 'answer') {
      answered(payload);
      yield { type: 'answer-ack', requestId: payload.requestId } as never;
      return;
    }
    if (payload.mode === 'cancel') {
      cancelled();
      yield { type: 'cancel-ack', runId: payload.runId } as never;
      return;
    }
    yield { type: 'assistant-text', text: 'Working on it.' } as never;
    if (script.request) {
      const { toolName, input } = script.request;
      yield {
        type: 'approval-request', requestId: 'req-1', toolName, input,
        inputHash: script.request.inputHash ?? inputFingerprint(toolName, input), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      } as never;
      const a = await answer;
      if (a.decision === 'allow') yield { type: 'tool-start', toolName, toolInput: JSON.stringify(input) } as never;
      else yield { type: 'tool-blocked', toolName, toolInput: JSON.stringify(input), reason: String(a.message) } as never;
    }
    if (script.holdOpen) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        if (script.cancelResult) void cancelSeen.then(resolve);
      });
      if (script.cancelResult) {
        yield { type: 'tool-result', name: 'Bash', output: '(completed)' } as never;
        yield script.cancelResult as never;
        return;
      }
    }
    yield (script.result ?? {
      type: 'result', runId: payload.runId, stop_reason: 'end_turn', subtype: 'success', costUsd: 0.0123, costEstimated: false,
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      metrics: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300 },
    }) as never;
  });
  return { calls, answer };
}

describe('Claude on AgentCore — harness parity', () => {
  before(() => { createTestDb(); setConfig(makeConfig()); });
  after(async () => { _setAgentCoreInvokerOverride(null); await cleanup(); });

  it('sends the run\'s rules, trust, limits and approval expiry; relays an approval and answers the same session', async () => {
    const ids = makeRun('claude-code', 2.5);
    const rules = [{ id: 'ask-push', group_id: 'g', name: 'push', pattern: '^git push', category: null, action: 'ask', scope: 'always', reason: 'Pushing needs a person.', sort_order: 1, created_at: '', updated_at: '' }];
    const { ctx, events, asked } = makeCtx(ids, { engine: 'claude-code', answer: 'allow', remember: true, rules });
    const input = { command: 'git push origin main', description: 'push' };
    const rt = fakeRuntime({ request: { toolName: 'Bash', input } });

    const summary = await runClaudeViaAgentCore(ctx, ARN);
    assert.match(summary, /Working on it/);

    const run = rt.calls.find((c) => c.payload.mode === 'run')!;
    assert.equal(run.payload.maxBudgetUsd, 2.5, 'the workflow budget goes to the runner');
    assert.equal(run.payload.model, 'global.anthropic.claude-haiku-4-5-20251001-v1:0');
    assert.deepEqual((run.payload.policy as { rules: Array<{ id: string; action: string }> }).rules.map((r) => [r.id, r.action]), [['ask-push', 'ask']]);
    assert.equal((run.payload.policy as { trusted: boolean }).trusted, false);
    assert.equal((run.payload.approvals as { via: string }).via, 'portal');
    assert.ok(!JSON.stringify(run.payload).match(/secret|token|apiKey/i), 'no credentials are sent to the microVM');

    assert.deepEqual(asked, [{ toolName: 'Bash', input }], 'a person was asked about the exact call');
    const ans = rt.calls.find((c) => c.payload.mode === 'answer')!;
    assert.equal(ans.sessionId, run.sessionId, 'the answer goes to the same session (same microVM)');
    assert.equal(ans.payload.decision, 'allow');
    assert.equal(ans.payload.remember, true);
    assert.equal(ans.payload.inputHash, inputFingerprint('Bash', input));
    assert.ok(events.some((e) => e.type === 'tool-start'), 'the allowed call ran');

    const row = one<Record<string, number | string>>('SELECT cost_usd, input_tokens, cache_read_tokens, model FROM p6_runs WHERE id = ?', ids.runId)!;
    assert.equal(row.cost_usd, 0.0123);
    assert.equal(row.input_tokens, 1000);
    assert.equal(row.cache_read_tokens, 5000);
    const spend = one<{ n: number }>('SELECT COUNT(*) AS n FROM budget_usage WHERE workflow_id = ?', ids.workflowId)!;
    assert.equal(spend.n, 1, 'spend is recorded in the budget');
  });

  it('declines without asking when the request does not match its call, or the portal\'s guard refuses it', async () => {
    for (const request of [
      { toolName: 'Bash', input: { command: 'ls' }, inputHash: 'f'.repeat(64) },
      { toolName: 'Write', input: { file_path: '.claude/settings.json', content: '{}' } },
    ]) {
      const ids = makeRun('claude-code');
      const { ctx, asked } = makeCtx(ids, { engine: 'claude-code' });
      const rt = fakeRuntime({ request });
      await runClaudeViaAgentCore(ctx, ARN);
      assert.equal(asked.length, 0, 'nobody was asked');
      const ans = rt.calls.find((c) => c.payload.mode === 'answer')!;
      assert.equal(ans.payload.decision, 'deny', JSON.stringify(request));
    }
  });

  it('passes a person\'s refusal back to the agent', async () => {
    const ids = makeRun('claude-code');
    const { ctx, events } = makeCtx(ids, { engine: 'claude-code', answer: 'deny' });
    const rt = fakeRuntime({ request: { toolName: 'Bash', input: { command: 'rm notes.txt' } } });
    await runClaudeViaAgentCore(ctx, ARN);
    const ans = rt.calls.find((c) => c.payload.mode === 'answer')!;
    assert.equal(ans.payload.decision, 'deny');
    assert.match(String(ans.payload.message), /declined: not now/);
    assert.ok(events.some((e) => e.type === 'tool-blocked'));
  });

  it('records a spend-cap stop and a time-limit stop', async () => {
    for (const [stop, expected] of [['budget', /spend cap reached \(\$1\)/], ['time_limit', /time limit reached/]] as const) {
      const ids = makeRun('claude-code', 1);
      const { ctx } = makeCtx(ids, { engine: 'claude-code' });
      fakeRuntime({ result: { type: 'result', runId: ids.runId, stop_reason: stop, subtype: stop === 'budget' ? 'error_max_budget_usd' : null, costUsd: 1.02, costEstimated: stop !== 'budget', metrics: { inputTokens: 10, outputTokens: 1 } } });
      await runClaudeViaAgentCore(ctx, ARN);
      const row = one<{ stop_reason: string; cost_usd: number }>('SELECT stop_reason, cost_usd FROM p6_runs WHERE id = ?', ids.runId)!;
      assert.match(row.stop_reason, expected);
      assert.equal(row.cost_usd, 1.02);
    }
  });

  it('a cancelled run still records the spend the runner reports when it stops', async () => {
    const ids = makeRun('claude-code');
    const { ctx, ctrl, events } = makeCtx(ids, { engine: 'claude-code' });
    const rt = fakeRuntime({
      holdOpen: true,
      cancelResult: {
        type: 'result', runId: ids.runId, stop_reason: 'cancelled', subtype: null, costUsd: 0.0042, costEstimated: true,
        model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', metrics: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 900 },
      },
    });
    const p = runClaudeViaAgentCore(ctx, ARN);
    await new Promise((r) => setTimeout(r, 50));
    const before = events.length;
    ctrl.abort();
    await assert.rejects(p, (e: Error) => e.name === 'AbortError');

    assert.ok(rt.calls.some((c) => c.payload.mode === 'cancel' && c.payload.runId === ids.runId), 'cancel was sent');
    assert.equal(events.length, before, 'nothing after the stop is relayed to the run');
    const row = one<{ cost_usd: number; input_tokens: number; cache_read_tokens: number }>('SELECT cost_usd, input_tokens, cache_read_tokens FROM p6_runs WHERE id = ?', ids.runId)!;
    assert.equal(row.cost_usd, 0.0042, 'the spend up to the stop is on the run');
    assert.equal(row.input_tokens, 300);
    assert.equal(row.cache_read_tokens, 900);
    const spend = one<{ n: number; usd: number }>('SELECT COUNT(*) AS n, SUM(cost_usd) AS usd FROM budget_usage WHERE workflow_id = ?', ids.workflowId)!;
    assert.deepEqual([spend.n, spend.usd], [1, 0.0042], 'and counts toward the budget');
  });

  it('a runner that never answers the cancel is cut off after the grace period', async () => {
    _setCancelGraceMs(50);
    try {
      const ids = makeRun('claude-code');
      const { ctx, ctrl } = makeCtx(ids, { engine: 'claude-code' });
      const rt = fakeRuntime({ holdOpen: true });
      const p = runClaudeViaAgentCore(ctx, ARN);
      await new Promise((r) => setTimeout(r, 50));
      const stoppedAt = Date.now();
      ctrl.abort();
      await assert.rejects(p, (e: Error) => e.name === 'AbortError');
      assert.ok(Date.now() - stoppedAt < 2_000, 'the portal does not wait past the grace period');
      assert.ok(rt.calls.some((c) => c.payload.mode === 'cancel' && c.payload.runId === ids.runId), 'cancel was sent');
      const row = one<{ cost_usd: number }>('SELECT cost_usd FROM p6_runs WHERE id = ?', ids.runId)!;
      assert.equal(row.cost_usd, 0, 'no result, so no spend to record');
    } finally {
      _setCancelGraceMs(null);
    }
  });

  it('maps model names to Bedrock IDs', () => {
    assert.equal(bedrockModelFor('claude-sonnet-4-5'), 'global.anthropic.claude-sonnet-4-5-20250929-v1:0');
    assert.equal(bedrockModelFor('apac.anthropic.claude-3-haiku-20240307-v1:0'), 'apac.anthropic.claude-3-haiku-20240307-v1:0');
    assert.equal(bedrockModelFor(''), undefined);
  });
});

describe('Kiro on AgentCore — approvals and trust', () => {
  before(() => { createTestDb(); setConfig(makeConfig()); });
  after(async () => { _setAgentCoreInvokerOverride(null); await cleanup(); });

  const token = { accessToken: 'a', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), region: 'us-east-1', startUrl: 'https://d-1.awsapps.com/start' };

  it('sends the trust level and relays approval requests from an untrusted run', async () => {
    const ids = makeRun('kiro');
    const { ctx, asked } = makeCtx(ids, { engine: 'kiro', answer: 'allow' });
    const input = { command: 'npm install left-pad' };
    const rt = fakeRuntime({ request: { toolName: 'execute_bash', input }, result: { type: 'result', runId: ids.runId, exitCode: 0, durationMs: 1, coldStartMs: 1, tokenRefreshed: false } });
    await runKiroViaAgentCore(ctx, { runtimeArn: ARN, runId: ids.runId, prompt: 'x', token, credentialId: null, expectedCiphertext: null });
    const run = rt.calls.find((c) => c.payload.mode === 'kiro-run')!;
    assert.deepEqual(run.payload.policy, { trusted: false });
    assert.equal((run.payload.approvals as { via: string }).via, 'portal');
    assert.deepEqual(asked, [{ toolName: 'execute_bash', input }]);
    const ans = rt.calls.find((c) => c.payload.mode === 'answer')!;
    assert.equal(ans.payload.decision, 'allow');
    assert.equal(ans.sessionId, run.sessionId);
  });
});

describe('Claude on AgentCore — repository changes go to the pull request step', () => {
  before(() => { createTestDb(); setConfig(makeConfig()); });
  after(async () => { _setAgentCoreInvokerOverride(null); _setSessionPrDeps(); await cleanup(); });

  const spec = [{ name: 'api', url: 'https://example.invalid/api.git' }] as never;
  const change = { type: 'repo-changes', repo: 'api', base: 'main', commits: 1, files: 2 };
  const done = { type: 'result', stop_reason: 'end_turn', costUsd: 0.01, metrics: { inputTokens: 10, outputTokens: 2 } };

  function stub(events: Array<Record<string, unknown>>, onCall?: (p: Record<string, unknown>) => void) {
    const sent: Array<Record<string, unknown>> = [];
    _setAgentCoreInvokerOverride(async function* (_a, _s, payload) { sent.push(payload); onCall?.(payload); for (const e of events) yield e as never; });
    return sent;
  }
  function hook(fail = false) {
    const calls: Array<{ ctx: Record<string, unknown>; changes: unknown[] }> = [];
    _setSessionPrDeps({ onRepoChanges: async (c, ch) => { calls.push({ ctx: c as never, changes: ch }); if (fail) throw new Error('push exploded'); } });
    return calls;
  }
  const withRepos = (o: ReturnType<typeof makeCtx>) => { o.ctx.run.runnerRepos = spec; return o; };

  it('harness path: asks for the check only with repositories and a reason, and hands the changes over', async () => {
    const ids = makeRun('claude-code');
    const c = withRepos(makeCtx(ids, { engine: 'claude-code' }));
    const sent = stub([change, { type: 'assistant-text', text: 'ok' }, done]);
    const calls = hook();
    await runClaudeViaAgentCore(c.ctx, ARN);
    assert.equal(sent[0]!.finalizeCheck, true, 'setting is on by default');
    assert.deepEqual(sent[0]!.repos, spec);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.changes, [{ repo: 'api', base: 'main', commits: 1, files: 2 }]);
    assert.deepEqual(calls[0]!.ctx, { workflowId: ids.workflowId, runId: ids.runId, projectId: ids.projectId, userId: null, engine: 'claude-code' });
    assert.ok(!c.events.some((e) => e.type === 'repo-changes'), 'not a run event');
    assert.ok(c.events.some((e) => e.type === 'run-complete'));
  });

  it('harness path: the flag follows the project setting and the ticket; no repositories means no flag', async () => {
    const ids = makeRun('claude-code');
    await setPullRequestSettings(ids.projectId, { openPullRequests: false });
    let sent = stub([done]);
    await runClaudeViaAgentCore(withRepos(makeCtx(ids, { engine: 'claude-code' })).ctx, ARN);
    assert.equal(sent[0]!.finalizeCheck, undefined, 'setting off and no ticket');

    getDb().prepare('UPDATE p6_workflows SET jira_key = ? WHERE id = ?').run('RLP-1', ids.workflowId);
    sent = stub([done]);
    await runClaudeViaAgentCore(withRepos(makeCtx(ids, { engine: 'claude-code' })).ctx, ARN);
    assert.equal(sent[0]!.finalizeCheck, true, 'a ticket asks even with the setting off');

    const other = makeRun('claude-code');
    sent = stub([done]);
    await runClaudeViaAgentCore(makeCtx(other, { engine: 'claude-code' }).ctx, ARN);
    assert.equal(sent[0]!.finalizeCheck, undefined, 'no repositories');
    assert.equal(sent[0]!.repos, undefined);
  });

  it('harness path: no changes means no call; a failure in the step does not fail the run; a cancelled run does not call it', async () => {
    const ids = makeRun('claude-code');
    stub([done]);
    let calls = hook();
    await runClaudeViaAgentCore(withRepos(makeCtx(ids, { engine: 'claude-code' })).ctx, ARN);
    assert.equal(calls.length, 0);

    stub([change, done]);
    calls = hook(true);
    const summary = await runClaudeViaAgentCore(withRepos(makeCtx(ids, { engine: 'claude-code' })).ctx, ARN);
    assert.equal(calls.length, 1);
    assert.equal(summary, 'Run complete.');

    const c = withRepos(makeCtx(ids, { engine: 'claude-code' }));
    stub([change, done], () => c.ctrl.abort());
    calls = hook();
    await assert.rejects(() => runClaudeViaAgentCore(c.ctx, ARN), (e: Error) => e.name === 'AbortError');
    assert.equal(calls.length, 0);
  });

  it('user-credential path: flag in the payload, changes on the result, and the same handover', async () => {
    const ids = makeRun('claude-code');
    const c = makeCtx(ids, { engine: 'claude-code' });
    const sent = stub([change, { type: 'assistant-text', text: 'hi' }, done]);
    const calls = hook();
    const o = { runtimeArn: ARN, runId: ids.runId, prompt: 'x', model: 'claude-sonnet-4-5', auth: { kind: 'api_key' as const, secret: 'k' }, trustTools: false, repos: spec };
    const res = await runUserCredential(c.ctx, o);
    assert.equal(sent[0]!.finalizeCheck, true);
    assert.deepEqual(res.repoChanges, [{ repo: 'api', base: 'main', commits: 1, files: 2 }]);
    assert.ok(!c.events.some((e) => e.type === 'repo-changes'));
    assert.equal(calls.length, 0, 'the caller hands them over after it has recorded the spend');

    await submitRepoChanges(c.ctx.run, null, res.repoChanges);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.ctx.engine, 'claude-code');

    await setPullRequestSettings(ids.projectId, { openPullRequests: false });
    const sent2 = stub([done]);
    const res2 = await runUserCredential(makeCtx(ids, { engine: 'claude-code' }).ctx, o);
    assert.equal(sent2[0]!.finalizeCheck, undefined);
    assert.equal(res2.repoChanges, undefined);
    const sent3 = stub([done]);
    await runUserCredential(makeCtx(ids, { engine: 'claude-code' }).ctx, { ...o, repos: undefined });
    assert.equal(sent3[0]!.finalizeCheck, undefined);
  });

  it('submitRepoChanges never throws and does not wait past its bound', async () => {
    const ids = makeRun('claude-code');
    const run = makeCtx(ids, { engine: 'claude-code' }).ctx.run;
    hook(true);
    await submitRepoChanges(run, null, [{ repo: 'api', base: 'main', commits: 1, files: 1 }]);
    _setSessionPrDeps({ onRepoChanges: () => new Promise<void>(() => {}) });
    const t0 = Date.now();
    await submitRepoChanges(run, null, [{ repo: 'api', base: 'main', commits: 1, files: 1 }], 50);
    assert.ok(Date.now() - t0 < 2000);
  });
});
