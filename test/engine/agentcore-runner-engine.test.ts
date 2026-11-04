/**
 * End to end without AWS: the portal's AgentCore path → the real agent-runner HTTP server →
 * the real Claude Code engine (the runner's installed Agent SDK) → a stand-in Anthropic API
 * that scripts the model's replies (test/mock-anthropic-api.ts).
 *
 * Only the AgentCore transport is replaced: a small invoker POSTs to the runner on localhost
 * with the session header, as InvokeAgentRuntime does. Run with `npm run test:engine`.
 * Skipped when agent-runner/node_modules is not installed.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createTestDb, cleanup } from '../fixtures.ts';
import { getDb, one } from '../../server/db.ts';
import { now, generateId } from '../../server/util.ts';
import { setConfig, type Config } from '../../server/config.ts';
import { _setAgentCoreInvokerOverride } from '../../server/agent/kiro-agentcore.ts';
import { runClaudeViaAgentCore } from '../../server/agent/claude-agentcore-bedrock.ts';
import type { RunContext, AgentRun } from '../../server/agent/types.ts';
import { startMockAnthropic } from '../mock-anthropic-api.ts';

const ROOT = process.cwd();
const RUNNER = path.join(ROOT, 'agent-runner');
const installed = fs.existsSync(path.join(RUNNER, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'));
const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/local-runner';

let api: Awaited<ReturnType<typeof startMockAnthropic>>;
let runner: ChildProcess;
let port = 0;
let workRoot = '';
let runnerLog = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

/** InvokeAgentRuntime stand-in: POST /invocations on the local runner, yield its SSE events. */
async function* localInvoker(_arn: string, sessionId: string, payload: Record<string, unknown>, signal?: AbortSignal) {
  const body = JSON.stringify(payload);
  const queue: unknown[] = [];
  let done = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  const req = http.request({
    host: '127.0.0.1', port, path: '/invocations', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId },
  }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (line.startsWith('data:')) { queue.push(JSON.parse(line.slice(5))); notify(); }
      }
    });
    res.on('end', () => { if (res.statusCode !== 200) failure = new Error(`runner HTTP ${res.statusCode}: ${buf}`); done = true; notify(); });
    res.on('close', () => { if (!done) { failure = failure ?? new DOMException('Aborted', 'AbortError'); done = true; notify(); } });
  });
  req.on('error', (e) => { failure = signal?.aborted ? new DOMException('Aborted', 'AbortError') : e; done = true; notify(); });
  // Like the real client: destroying with an error ends the stream with an AbortError.
  signal?.addEventListener('abort', () => req.destroy(new DOMException('Aborted', 'AbortError')), { once: true });
  req.end(body);
  while (true) {
    if (queue.length) { yield queue.shift() as never; continue; }
    if (done) break;
    await new Promise<void>((r) => { wake = r; });
  }
  if (failure) throw failure;
}

async function ping(): Promise<string> {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/ping' }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(JSON.parse(b).status));
    }).on('error', () => resolve('down'));
  });
}

function setup(opts: { rules?: unknown[]; trusted?: boolean; answer?: 'allow' | 'deny'; budget?: number }) {
  const db = getDb();
  const projectId = `proj-${generateId()}`;
  const workflowId = `wf-${generateId()}`;
  const runId = `run-${generateId()}`;
  db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(projectId, 'E2E', `e2e-${projectId.slice(5, 13)}`, now());
  db.prepare(`INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
    VALUES (?, ?, 'e2e', 'running', 'claude-code', ?, '[]', ?, ?)`).run(workflowId, projectId, opts.trusted ? 1 : 0, now(), now());
  if (opts.budget != null) db.prepare('UPDATE p6_workflows SET budget_usd = ? WHERE id = ?').run(opts.budget, workflowId);
  db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`).run(runId, workflowId, now());
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const asked: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  const ctrl = new AbortController();
  const run: AgentRun = {
    runId, workflowId, projectId, goal: 'Do the scripted steps', kind: null, engine: 'claude-code',
    trusted: opts.trusted ?? false, dataDir: '', workDir: os.tmpdir(), repoIds: [], leadAgent: null,
    permissions: { rules: (opts.rules ?? []) as never, toolRules: [], projectId },
    credentialId: null, credentialOwnerId: null, model: 'claude-haiku-4-5', engineSessionId: null,
  };
  const ctx: RunContext = {
    run,
    emit: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
    awaitInput: async (toolName, input) => {
      asked.push({ toolName, input });
      return { decision: opts.answer ?? 'allow', remember: false, message: opts.answer === 'deny' ? 'not this one' : '' };
    },
    allowed: new Set(),
    signal: ctrl.signal,
  };
  return { ctx, events, asked, ctrl, runId, workflowId };
}

/** Every tool result the engine sent back to the model. */
function toolResults(): string {
  const out: string[] = [];
  for (const q of api.requests) {
    for (const m of (q.body?.messages ?? []) as Array<{ content?: unknown }>) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_result') out.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
      }
    }
  }
  return out.join('\n');
}

const askBash = [{ id: 'ask-bash', group_id: 'g', name: 'shell', pattern: null, category: 'bash', action: 'ask', scope: 'always', reason: 'Shell commands need a person.', sort_order: 1, created_at: '', updated_at: '' }];

describe('AgentCore runner + real Claude Code engine', { skip: installed ? false : 'agent-runner/node_modules is not installed' }, () => {
  before(async () => {
    createTestDb();
    setConfig({
      root: ROOT, port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ac-e2e-data-')),
      webDir: path.join(ROOT, 'dist', 'web'), secretKey: 'a'.repeat(64), cookieSecure: 'false', demoSpeed: 0,
      maxUploadBytes: 1 << 20, trustProxy: false, awsRegion: 'ap-southeast-1', deployTarget: null,
    } as Config);
    execFileSync(process.execPath, [path.join(RUNNER, 'build.mjs')], { stdio: 'ignore' }); // copies shared/ portal modules
    api = await startMockAnthropic();
    port = await freePort();
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-e2e-work-'));
    runner = spawn(process.execPath, ['--import', 'tsx', path.join(RUNNER, 'src', 'index.ts')], {
      cwd: RUNNER,
      env: {
        ...process.env,
        AGENT_RUNNER_PORT: String(port),
        AGENT_RUNNER_ANTHROPIC_BASE_URL: api.url,
        AGENT_RUNNER_WORK_ROOT: workRoot,
        ANTHROPIC_API_KEY: 'sk-ant-RUNNER-E2E-KEY',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runner.stdout?.on('data', (c) => { runnerLog += c; });
    runner.stderr?.on('data', (c) => { runnerLog += c; });
    for (let i = 0; i < 100 && (await ping()) === 'down'; i++) await new Promise((r) => setTimeout(r, 200));
    assert.notEqual(await ping(), 'down', `runner did not start:\n${runnerLog}`);
    _setAgentCoreInvokerOverride(localInvoker as never);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    runner?.kill();
    await api?.close();
    await cleanup();
  });

  it('a person approves a shell command in the microVM; the guard blocks a settings write without asking', { timeout: 200_000 }, async () => {
    api.setScript([
      { tool: 'Bash', input: { command: 'echo harness-ok > out.txt', description: 'Write a file' } },
      { tool: 'Write', input: { file_path: '.claude/settings.json', content: '{"permissions":{"allow":["Bash"]}}' } },
      { tool: 'Bash', input: { command: 'cp out.txt copy.txt', description: 'Copy it' } },
      { tool: 'Bash', input: { command: 'cat copy.txt', description: 'Read it back' } },
      { text: 'Done.' },
    ]);
    const t = setup({ rules: askBash, answer: 'allow' });
    const summary = await runClaudeViaAgentCore(t.ctx, ARN);
    assert.match(summary, /Done/, runnerLog.slice(-2000));

    // Claude Code runs commands it judges read-only (cat) without asking the host, so only the
    // two writing commands reach the portal's "ask" rule. Same on the local engine.
    assert.deepEqual(t.asked.map((a) => a.input.command), ['echo harness-ok > out.txt', 'cp out.txt copy.txt'], 'a person was asked about each exact command');
    assert.ok(t.events.some((e) => e.type === 'tool-blocked' && /configures tools/.test(String(e.payload.reason))), 'the guard blocked the settings write');
    assert.match(toolResults(), /harness-ok/, 'the approved commands ran in the runner');
    assert.ok(api.requests.some((q) => q.headers['x-api-key'] === 'sk-ant-RUNNER-E2E-KEY'), 'the engine called the model');
    const row = one<{ cost_usd: number; input_tokens: number }>('SELECT cost_usd, input_tokens FROM p6_runs WHERE id = ?', t.runId)!;
    assert.ok(row.input_tokens > 0, 'tokens are recorded');
    assert.equal(await ping(), 'Healthy', 'the runner is idle again');
  });

  it('a person declines: the command does not run and the agent is told why', { timeout: 200_000 }, async () => {
    api.setScript([
      { tool: 'Bash', input: { command: 'echo should-not-run > declined.txt', description: 'Write' } },
      { text: 'Understood.' },
    ]);
    const t = setup({ rules: askBash, answer: 'deny' });
    await runClaudeViaAgentCore(t.ctx, ARN);
    assert.equal(t.asked.length, 1);
    assert.match(toolResults(), /declined: not this one/);
    const found = fs.readdirSync(workRoot, { recursive: true }).some((f) => String(f).endsWith('declined.txt'));
    assert.equal(found, false, 'the declined command did not run');
  });

  it('the engine stops at the run\'s spend cap and the portal records it', { timeout: 200_000 }, async () => {
    api.setUsage({ input_tokens: 3_000_000, output_tokens: 20 });
    try {
      api.setScript([
        { tool: 'Bash', input: { command: 'echo one', description: 'Step one' } },
        { tool: 'Bash', input: { command: 'echo two', description: 'Step two' } },
        { text: 'Done.' },
      ]);
      const t = setup({ trusted: true, budget: 1 });
      await runClaudeViaAgentCore(t.ctx, ARN);
      const row = one<{ stop_reason: string; cost_usd: number }>('SELECT stop_reason, cost_usd FROM p6_runs WHERE id = ?', t.runId)!;
      assert.match(row.stop_reason, /spend cap reached \(\$1\)/);
      assert.ok(row.cost_usd > 1, `spend recorded: ${row.cost_usd}`);
    } finally {
      api.setUsage({ input_tokens: 100, output_tokens: 20 });
    }
  });

  it('stopping the run in the portal stops it in the runner', { timeout: 200_000 }, async () => {
    api.setScript([
      // Claude Code refuses long `sleep` commands, so wait with node instead.
      { tool: 'Bash', input: { command: 'node -e "setTimeout(() => {}, 60000)"', description: 'Wait' } },
      { text: 'Done.' },
    ]);
    const t = setup({ trusted: true });
    const p = runClaudeViaAgentCore(t.ctx, ARN);
    for (let i = 0; i < 200 && !t.events.some((e) => e.type === 'tool-start'); i++) await new Promise((r) => setTimeout(r, 100));
    t.ctrl.abort();
    await assert.rejects(p, (e: Error) => e.name === 'AbortError');
    let status = '';
    for (let i = 0; i < 100 && (status = await ping()) !== 'Healthy'; i++) await new Promise((r) => setTimeout(r, 200));
    assert.equal(status, 'Healthy', 'the runner stopped the run and is idle');
  });
});
