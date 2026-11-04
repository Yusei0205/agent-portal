/**
 * End to end without AWS: the portal's AgentCore path → the real agent-runner HTTP server →
 * the real Claude Code engine (the runner's installed Agent SDK) → a stand-in Anthropic API
 * that scripts the model's replies (test/mock-anthropic-api.ts).
 *
 * Only the AgentCore transport is replaced: a small invoker POSTs to a runner on localhost
 * with the session header, as InvokeAgentRuntime does. Two runner processes stand in for two
 * microVMs: runner A takes the sessions of the runs a test starts itself, runner B every other
 * session (a child session's run, which the portal starts). Each runner gets a microVM's
 * environment: none of the host's own Claude Code or Anthropic settings.
 *
 * Run with `npm run test:engine`. Skipped when agent-runner/node_modules is not installed.
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
import { getDb, one, all } from '../../server/db.ts';
import { now, generateId } from '../../server/util.ts';
import { setConfig, type Config } from '../../server/config.ts';
import { _setAgentCoreInvokerOverride } from '../../server/agent/kiro-agentcore.ts';
import { runClaudeViaAgentCore } from '../../server/agent/claude-agentcore.ts';
import type { RunContext, AgentRun } from '../../server/agent/types.ts';
import { startMockAnthropic, type MockRequest, type MockScriptStep } from '../mock-anthropic-api.ts';

const ROOT = process.cwd();
const RUNNER = path.join(ROOT, 'agent-runner');
const installed = fs.existsSync(path.join(RUNNER, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'));
const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/local-runner';
const DELEGATE = 'mcp__portal__delegate_session';

type RunnerName = 'A' | 'B';
interface Runner { name: RunnerName; port: number; workRoot: string; proc: ChildProcess | null; log: string }

let api: Awaited<ReturnType<typeof startMockAnthropic>>;
let dataDir = '';
let workRoot = '';
const runners = {} as Record<RunnerName, Runner>;
/** Runs the tests start themselves: their sessions (`<runId>-<uuid>`) go to runner A. */
const ownRuns = new Set<string>();
/** Every invocation the portal made: its session, the runner that took it, and its mode. */
const invocations: Array<{ sessionId: string; runner: RunnerName; mode: string }> = [];

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The runner (microVM) a session belongs to. */
function runnerFor(sessionId: string): Runner {
  return [...ownRuns].some((id) => sessionId.startsWith(`${id}-`)) ? runners.A : runners.B;
}

/** The runners' recent output, for assertion messages. */
function logs(): string {
  return Object.values(runners).map((r) => `[runner ${r.name}]\n${r.log.slice(-1500)}`).join('\n');
}

/** InvokeAgentRuntime stand-in: POST /invocations on the session's runner, yield its SSE events. */
async function* localInvoker(_arn: string, sessionId: string, payload: Record<string, unknown>, signal?: AbortSignal) {
  const runner = runnerFor(sessionId);
  invocations.push({ sessionId, runner: runner.name, mode: String(payload.mode ?? '') });
  const body = JSON.stringify(payload);
  const queue: unknown[] = [];
  let done = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  const req = http.request({
    host: '127.0.0.1', port: runner.port, path: '/invocations', method: 'POST',
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

async function ping(runner: Runner = runners.A): Promise<string> {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: runner.port, path: '/ping' }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(JSON.parse(b).status));
    }).on('error', () => resolve('down'));
  });
}

/** Waits until the runner has no run in progress. */
async function idle(runner: Runner): Promise<string> {
  let status = '';
  for (let i = 0; i < 150 && (status = await ping(runner)) !== 'Healthy'; i++) await sleep(200);
  return status;
}

async function waitFor<T>(check: () => T | undefined | null | false, what: string, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}\n${logs()}`);
}

/**
 * A microVM's environment. This test may itself run inside a Claude Code session, whose settings
 * (its login, remote-session headers, subagent limits) the engine would otherwise pick up.
 */
function microVmEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|CCR_|ANTHROPIC_)/.test(k) || k === 'MAX_THINKING_TOKENS') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

async function startRunner(name: RunnerName): Promise<Runner> {
  const runner: Runner = { name, port: await freePort(), workRoot: path.join(workRoot, name), proc: null, log: '' };
  fs.mkdirSync(runner.workRoot, { recursive: true });
  runner.proc = spawn(process.execPath, ['--import', 'tsx', path.join(RUNNER, 'src', 'index.ts')], {
    cwd: RUNNER,
    env: microVmEnv({
      AGENT_RUNNER_PORT: String(runner.port),
      AGENT_RUNNER_ANTHROPIC_BASE_URL: api.url,
      AGENT_RUNNER_WORK_ROOT: runner.workRoot,
      ANTHROPIC_API_KEY: 'sk-ant-RUNNER-E2E-KEY',
      // Tool search on, as the engine has it for first-party hosts (it is off for a stand-in API
      // by default): MCP tools are then deferred behind it unless their server is always loaded.
      ENABLE_TOOL_SEARCH: 'true',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runner.proc.stdout?.on('data', (c) => { runner.log += c; });
  runner.proc.stderr?.on('data', (c) => { runner.log += c; });
  for (let i = 0; i < 100 && (await ping(runner)) === 'down'; i++) await sleep(200);
  assert.notEqual(await ping(runner), 'down', `runner ${name} did not start:\n${runner.log}`);
  return runner;
}

function setup(opts: { rules?: unknown[]; trusted?: boolean; answer?: 'allow' | 'deny'; budget?: number; owner?: string }) {
  const db = getDb();
  const projectId = `proj-${generateId()}`;
  const workflowId = `wf-${generateId()}`;
  const runId = `run-${generateId()}`;
  const slug = `e2e-${projectId.slice(5, 13)}`;
  db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(projectId, 'E2E', slug, now());
  db.prepare(`INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
    VALUES (?, ?, 'e2e', 'running', 'claude-code', ?, '[]', ?, ?)`).run(workflowId, projectId, opts.trusted ? 1 : 0, now(), now());
  if (opts.budget != null) db.prepare('UPDATE p6_workflows SET budget_usd = ? WHERE id = ?').run(opts.budget, workflowId);
  if (opts.owner) db.prepare('UPDATE p6_workflows SET created_by = ? WHERE id = ?').run(opts.owner, workflowId);
  db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`).run(runId, workflowId, now());
  ownRuns.add(runId);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const asked: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  const ctrl = new AbortController();
  const run: AgentRun = {
    runId, workflowId, projectId, goal: 'Do the scripted steps', kind: null, engine: 'claude-code',
    trusted: opts.trusted ?? false, dataDir: '', workDir: os.tmpdir(), repoIds: [], leadAgent: null,
    permissions: { rules: (opts.rules ?? []) as never, toolRules: [], projectId },
    credentialId: null, credentialOwnerId: opts.owner ?? null, model: 'claude-haiku-4-5', engineSessionId: null,
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
  return { ctx, events, asked, ctrl, runId, workflowId, projectId, slug };
}

/** Every tool result the engine sent back to the model (from request `from` on). */
function toolResults(from = 0): string {
  const out: string[] = [];
  for (const q of api.requests.slice(from)) {
    for (const m of (q.body?.messages ?? []) as Array<{ content?: unknown }>) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_result') out.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
      }
    }
  }
  return out.join('\n');
}

/** The tools a model request offers. */
function toolsOf(q: MockRequest | undefined): Array<Record<string, unknown>> {
  return Array.isArray(q?.body?.tools) ? q.body.tools as Array<Record<string, unknown>> : [];
}

/** Files named `name` under a folder, with their text. */
function findFiles(dir: string, name: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => path.basename(String(f)) === name)
    .map((f) => fs.readFileSync(path.join(dir, String(f)), 'utf8'));
}

const askBash = [{ id: 'ask-bash', group_id: 'g', name: 'shell', pattern: null, category: 'bash', action: 'ask', scope: 'always', reason: 'Shell commands need a person.', sort_order: 1, created_at: '', updated_at: '' }];

/** In the file-writer agent's prompt, so a request can be told apart as the agent's. */
const AGENT_MARKER = 'prompt marker FW-7F3A';

/** The project's own agent, as Claude Code writes agent files. */
function writeFileWriterAgent(slug: string): void {
  const dir = path.join(dataDir, 'projects', slug, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'file-writer.md'), [
    '---',
    'name: file-writer',
    'description: Writes files in the work folder with shell commands',
    'tools: Bash',
    '---',
    `You are the file-writer agent (${AGENT_MARKER}). Write the files you are asked for, then report.`,
    '',
  ].join('\n'));
}

const isAgentRequest = (q: MockRequest): boolean => JSON.stringify(q.body?.system ?? '').includes(AGENT_MARKER);

/** The engine tells the main agent that a background agent ended with a task notification. */
const toldAgentEnded = (q: MockRequest): boolean => JSON.stringify(q.body?.messages ?? '').includes('<task-notification>');

/**
 * A step that hands work to the file-writer agent. The engine names the tool Agent (Task in
 * older versions): the step takes the name from the tools the request offers.
 */
function handOff(input: Record<string, unknown>, seen: { tool: string; offered: string[] }): MockScriptStep {
  return (req) => {
    seen.offered = toolsOf(req).map((x) => String(x.name));
    seen.tool = seen.offered.find((n) => n === 'Agent' || n === 'Task') ?? '';
    return { tool: seen.tool || 'Agent', input: { subagent_type: 'file-writer', ...input } };
  };
}

/** Replies by who asks, each from its own list: the main agent or the file-writer agent. */
function byAgent(main: MockScriptStep[], agent: MockScriptStep[]): MockScriptStep {
  let m = 0;
  let a = 0;
  return (req) => {
    const next = isAgentRequest(req) ? agent[Math.min(a++, agent.length - 1)] : main[Math.min(m++, main.length - 1)];
    return typeof next === 'function' ? next(req) : next;
  };
}

describe('AgentCore runner + real Claude Code engine', { skip: installed ? false : 'agent-runner/node_modules is not installed' }, () => {
  before(async () => {
    createTestDb();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-e2e-data-'));
    setConfig({
      root: ROOT, port: 0, host: '127.0.0.1', dataDir,
      webDir: path.join(ROOT, 'dist', 'web'), secretKey: 'a'.repeat(64), cookieSecure: 'false', demoSpeed: 0,
      maxUploadBytes: 1 << 20, trustProxy: false, awsRegion: 'ap-southeast-1', deployTarget: null,
    } as Config);
    execFileSync(process.execPath, [path.join(RUNNER, 'build.mjs')], { stdio: 'ignore' }); // copies shared/ portal modules
    api = await startMockAnthropic();
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-e2e-work-'));
    runners.A = await startRunner('A');
    runners.B = await startRunner('B');
    _setAgentCoreInvokerOverride(localInvoker as never);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    for (const r of Object.values(runners)) r.proc?.kill();
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
    assert.match(summary, /Done/, logs());

    // Claude Code runs commands it judges read-only (cat) without asking the host, so only the
    // two writing commands reach the portal's "ask" rule. Same on the local engine.
    assert.deepEqual(t.asked.map((a) => a.input.command), ['echo harness-ok > out.txt', 'cp out.txt copy.txt'], 'a person was asked about each exact command');
    assert.ok(t.events.some((e) => e.type === 'tool-blocked' && /configures tools/.test(String(e.payload.reason))), 'the guard blocked the settings write');
    assert.match(toolResults(), /harness-ok/, 'the approved commands ran in the runner');
    assert.ok(t.events.filter((e) => e.type === 'tool-start').every((e) => e.payload.agent === undefined), 'the main agent\'s tool calls carry no agent name');
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
    for (let i = 0; i < 200 && !t.events.some((e) => e.type === 'tool-start'); i++) await sleep(100);
    t.ctrl.abort();
    await assert.rejects(p, (e: Error) => e.name === 'AbortError');
    assert.equal(await idle(runners.A), 'Healthy', 'the runner stopped the run and is idle');
    // The model answered once before the stop: the runner's final result carries that spend.
    const row = one<{ cost_usd: number; input_tokens: number }>('SELECT cost_usd, input_tokens FROM p6_runs WHERE id = ?', t.runId)!;
    assert.ok(row.input_tokens > 0 && row.cost_usd > 0, `spend up to the stop recorded: ${JSON.stringify(row)}`);
  });

  it('Claude hands work to a project agent: its prompt, approvals, progress and tool calls reach the portal', { timeout: 200_000 }, async () => {
    const t = setup({ rules: askBash, answer: 'allow' });
    writeFileWriterAgent(t.slug);

    // Agents run in the background by default; this hand-off waits for the agent
    // (run_in_background: false), so the replies come in the order scripted here.
    const seen = { tool: '', offered: [] as string[] };
    const from = api.requests.length;
    api.setScript([
      handOff({ description: 'Write the marker file', prompt: 'Write subagent-ok to marker.txt.', run_in_background: false }, seen),
      { tool: 'Bash', input: { command: 'echo subagent-ok > marker.txt', description: 'Write the marker' } },
      { text: 'SUBAGENT REPORT: marker.txt written.' },
      { text: 'MAIN ANSWER: the file-writer agent wrote marker.txt.' },
    ]);
    const summary = await runClaudeViaAgentCore(t.ctx, ARN);
    assert.ok(seen.tool, `the engine offers the Agent tool; offered: ${seen.offered.join(', ')}`);

    // The agent's definition reaches the model: its prompt (as the system prompt) and its tools.
    const agentRequests = api.requests.slice(from).filter(isAgentRequest);
    assert.ok(agentRequests.length > 0, `the agent's prompt reached the model\n${logs()}`);
    assert.deepEqual(toolsOf(agentRequests[0]).map((x) => x.name), ['Bash'], 'with the agent\'s own tools');

    // The subagent's command went through the run's "ask" rule, was approved and ran.
    assert.deepEqual(t.asked.map((a) => [a.toolName, a.input.command]), [['Bash', 'echo subagent-ok > marker.txt']], 'a person was asked about the subagent\'s command');
    assert.deepEqual(findFiles(runners.A.workRoot, 'marker.txt').map((x) => x.trim()), ['subagent-ok'], 'the command ran in the microVM');

    // Its start and end reached the portal.
    const started = t.events.find((e) => e.type === 'subagent-started');
    assert.ok(started, `subagent-started arrived\n${logs()}`);
    assert.equal(started.payload.name, 'file-writer');
    assert.equal(started.payload.background, false);
    const finished = t.events.find((e) => e.type === 'subagent-finished');
    assert.ok(finished, `subagent-finished arrived: ${JSON.stringify(t.events.filter((e) => e.type.startsWith('subagent')))}`);
    assert.equal(finished.payload.id, started.payload.id, 'the same subagent');
    assert.equal(finished.payload.name, 'file-writer');
    assert.equal(finished.payload.status, 'completed');

    // The run's answer is the main agent's text only. The agent's report reaches the portal under
    // its name: an agent the main agent waits for hands its report back at its end, not as text.
    assert.equal(summary, 'MAIN ANSWER: the file-writer agent wrote marker.txt.');
    assert.equal(finished.payload.summary, 'SUBAGENT REPORT: marker.txt written.', 'the agent\'s report is shown under its name');
    assert.ok(!t.events.some((e) => e.type === 'assistant-text' && !e.payload.agent && /SUBAGENT REPORT/.test(String(e.payload.text))),
      'the agent\'s report is not shown as the main agent\'s text');

    // Tool calls inside the subagent say whose they are. (The engine starts the agent without
    // asking the host, so the hand-off itself shows as subagent-started, not as a tool call.)
    const bash = t.events.find((e) => e.type === 'tool-start' && e.payload.toolName === 'Bash');
    assert.equal(bash?.payload.agent, 'file-writer', `the subagent's tool call carries its name: ${JSON.stringify(bash?.payload)}`);
    assert.equal(await ping(), 'Healthy', 'the runner is idle again');
  });

  it('a project agent in the background: the main agent is told when it ends, and the run waits for it', { timeout: 200_000 }, async () => {
    const t = setup({ rules: askBash, answer: 'allow' });
    writeFileWriterAgent(t.slug);
    const seen = { tool: '', offered: [] as string[] };
    const from = api.requests.length;
    api.setScript([byAgent(
      [
        handOff({ description: 'Write the marker file', prompt: 'Write background-ok to marker-bg.txt.' }, seen),
        // The main agent answers once the engine tells it the agent ended (a task notification).
        (req) => toldAgentEnded(req)
          ? { text: 'MAIN ANSWER: the file-writer agent wrote marker-bg.txt.' }
          : { text: 'MAIN: the file-writer agent is on it.' },
      ],
      [
        { tool: 'Bash', input: { command: 'echo background-ok > marker-bg.txt', description: 'Write the marker' } },
        { text: 'SUBAGENT REPORT: marker-bg.txt written.' },
      ],
    )]);
    const summary = await runClaudeViaAgentCore(t.ctx, ARN);
    assert.ok(seen.tool, `the engine offers the Agent tool; offered: ${seen.offered.join(', ')}`);

    const started = t.events.find((e) => e.type === 'subagent-started');
    assert.equal(started?.payload.background, true, 'the agent ran in the background (the engine\'s default)');
    assert.deepEqual(t.asked.map((a) => [a.toolName, a.input.command]), [['Bash', 'echo background-ok > marker-bg.txt']]);
    assert.deepEqual(findFiles(runners.A.workRoot, 'marker-bg.txt').map((x) => x.trim()), ['background-ok'], 'the command ran');
    const finished = t.events.find((e) => e.type === 'subagent-finished');
    assert.equal(finished?.payload.status, 'completed', 'its end reached the portal');
    const bash = t.events.find((e) => e.type === 'tool-start' && e.payload.toolName === 'Bash');
    assert.equal(bash?.payload.agent, 'file-writer', 'its tool call carries its name');

    // The main agent was told when the agent ended, with its report, and then answered. The run
    // kept going until then, though the main agent's first turn may have ended before.
    const told = api.requests.slice(from).filter((q) => !isAgentRequest(q) && toldAgentEnded(q));
    assert.ok(told.some((q) => JSON.stringify(q.body.messages).includes('SUBAGENT REPORT: marker-bg.txt written.')), `the main agent got the agent's report\n${logs()}`);
    const lines = summary.split('\n');
    assert.equal(lines.at(-1), 'MAIN ANSWER: the file-writer agent wrote marker-bg.txt.', `the run's answer ends with the main agent's last reply: ${summary}`);
    assert.ok(lines.every((l) => l.startsWith('MAIN')), `the answer is the main agent's text only: ${summary}`);
    assert.ok(t.events.some((e) => e.type === 'assistant-text' && e.payload.agent === 'file-writer'), 'the agent\'s text is shown under its name');
    assert.equal(await ping(), 'Healthy', 'the runner is idle again');
  });

  it('Claude starts a child session: it runs in another microVM and its result reaches the parent', { timeout: 300_000 }, async () => {
    // A session with an owner may start child sessions (Settings › Delegation is on by default).
    const userId = `user-${generateId()}`;
    getDb().prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, `${userId}@example.com`, 'E2E owner', 'not-a-password-hash', now());
    const t = setup({ owner: userId, answer: 'allow' });

    // The child is started by the portal's driver, which takes the AgentCore path only with the runtime set.
    const savedArn = process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN;
    process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN = ARN;
    try {
      const from = api.requests.length;
      api.setScript([
        { tool: DELEGATE, input: { task: 'Write the release notes for version 2.', title: 'Release notes' } },
        // The parent's and the child's next replies, in whichever order they ask.
        { text: 'Release notes are ready.' },
        { text: 'Started a child session for the release notes.' },
      ]);
      await runClaudeViaAgentCore(t.ctx, ARN);

      // The tool is offered from the first turn, not deferred behind tool search.
      const first = api.requests.slice(from).find((q) => toolsOf(q).length > 0);
      const tool = toolsOf(first).find((x) => x.name === DELEGATE);
      assert.ok(tool, `${DELEGATE} is offered; tools: ${toolsOf(first).map((x) => x.name).join(', ')}\n${logs()}`);
      assert.notEqual(tool.defer_loading, true, 'the tool is always loaded');

      // A child session of this one was started, and the agent got its ID back.
      const child = await waitFor(
        () => one<{ id: string; parent_id: string }>('SELECT id, parent_id FROM p6_workflows WHERE parent_id = ?', t.workflowId),
        'the child session',
      );
      assert.equal(child.parent_id, t.workflowId);
      const results = toolResults(from);
      assert.match(results, /childWorkflowId/, 'the parent\'s tool result names the child session');
      assert.ok(results.includes(child.id), 'with the child\'s ID');

      // The child ran on its own; its result was posted to the parent.
      const posted = await waitFor(
        () => all<{ data: string }>(`SELECT data FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'child-result'`, t.workflowId)
          .map((e) => JSON.parse(e.data) as { childId: string; status: string })
          .find((d) => d.childId === child.id),
        'the child\'s result in the parent session',
      );
      assert.equal(posted.status, 'done', `the child finished: ${JSON.stringify(posted)}`);

      // Its run went to the other microVM (runner B, another session); the parent's stayed on A.
      const childRuns = all<{ id: string }>('SELECT id FROM p6_runs WHERE workflow_id = ?', child.id).map((r) => r.id);
      const childCalls = invocations.filter((i) => childRuns.some((id) => i.sessionId.startsWith(`${id}-`)));
      const parentCalls = invocations.filter((i) => i.sessionId.startsWith(`${t.runId}-`));
      assert.ok(childCalls.some((i) => i.mode === 'run'), `the child's run was invoked: ${JSON.stringify(invocations.slice(-6))}`);
      assert.deepEqual([...new Set(childCalls.map((i) => i.runner))], ['B'], 'the child ran on runner B');
      assert.deepEqual([...new Set(parentCalls.map((i) => i.runner))], ['A'], 'the parent ran on runner A');
      assert.ok(childCalls.every((c) => !parentCalls.some((p) => p.sessionId === c.sessionId)), 'in another session');
      const childSession = childCalls.find((i) => i.mode === 'run')!.sessionId;
      assert.ok(fs.existsSync(path.join(runners.B.workRoot, childSession, 'work')), 'runner B made the child\'s work folder');
      assert.ok(!fs.existsSync(path.join(runners.A.workRoot, childSession)), 'runner A did not');
    } finally {
      if (savedArn === undefined) delete process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN;
      else process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN = savedArn;
    }
    assert.equal(await idle(runners.B), 'Healthy', 'runner B is idle again');
    assert.equal(await idle(runners.A), 'Healthy', 'runner A is idle again');
  });
});
