/**
 * Live check against deployed AgentCore runtimes (real microVMs, real Bedrock Claude).
 * Not part of `npm test`. Run after infra/scripts/deploy-harness.mjs:
 *
 *   PORTAL_LIVE_CLAUDE_RUNTIME_ARN=<ClaudeRuntimeArn output> \
 *   PORTAL_AGENTCORE_AWS_PROFILE=<profile> \
 *   node --import tsx --test --test-timeout=900000 test/live/agentcore-live.test.ts
 *
 * Costs a few cents of Bedrock (Claude Haiku 4.5) per run.
 *
 * The last tests check several agents and several sessions: a run hands work to a project
 * agent inside its microVM, a run starts a child session that runs in a microVM of its own, and
 * the Agent pack's lead agent gets a task done through its specialists
 * (PORTAL_LIVE_LEAD_MODEL picks that test's Bedrock model; Haiku 4.5 by default).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb, cleanup } from '../fixtures.ts';
import { getDb, one, all } from '../../server/db.ts';
import { now, generateId } from '../../server/util.ts';
import { setConfig, type Config } from '../../server/config.ts';
import { runClaudeViaAgentCore } from '../../server/agent/claude-agentcore-bedrock.ts';
import { agentCoreControlSender } from '../../server/agent/kiro-agentcore.ts';
import type { RunContext, AgentRun } from '../../server/agent/types.ts';
// @ts-expect-error — plain JS module without type declarations
import { claudePackFiles, PACK_AGENTS } from '../../web/src/lib/agent-pack/index.js';

const ARN = process.env.PORTAL_LIVE_CLAUDE_RUNTIME_ARN ?? '';
const HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

type Ev = { type: string; payload: Record<string, unknown> };

let liveDataDir = '';

function setup(opts: { rules?: unknown[]; trusted?: boolean; answer?: 'allow' | 'deny'; budget?: number; goal: string; ownerId?: string; model?: string }) {
  const model = opts.model ?? HAIKU;
  const db = getDb();
  const projectId = `proj-${generateId()}`;
  const workflowId = `wf-${generateId()}`;
  const runId = `run-${generateId()}`;
  db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(projectId, 'Live', `live-${projectId.slice(5, 13)}`, now());
  db.prepare(`INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, model, created_by, created_at, updated_at)
    VALUES (?, ?, 'live', 'running', 'claude-code', ?, '[]', ?, ?, ?, ?)`).run(workflowId, projectId, opts.trusted ? 1 : 0, model, opts.ownerId ?? null, now(), now());
  if (opts.budget != null) db.prepare('UPDATE p6_workflows SET budget_usd = ? WHERE id = ?').run(opts.budget, workflowId);
  db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`).run(runId, workflowId, now());
  const events: Ev[] = [];
  const asked: Array<{ toolName: string; input: Record<string, unknown>; at: number }> = [];
  const ctrl = new AbortController();
  const run: AgentRun = {
    runId, workflowId, projectId, goal: opts.goal, kind: null, engine: 'claude-code',
    trusted: opts.trusted ?? false, dataDir: '', workDir: os.tmpdir(), repoIds: [], leadAgent: null,
    permissions: { rules: (opts.rules ?? []) as never, toolRules: [], projectId },
    credentialId: null, credentialOwnerId: opts.ownerId ?? null, model, engineSessionId: null,
  };
  const started = Date.now();
  const ctx: RunContext = {
    run,
    emit: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
    awaitInput: async (toolName, input) => {
      asked.push({ toolName, input, at: Date.now() - started });
      return { decision: opts.answer ?? 'allow', remember: false, message: opts.answer === 'deny' ? 'not in this test' : '' };
    },
    allowed: new Set(),
    signal: ctrl.signal,
  };
  const projectDir = path.join(liveDataDir, 'projects', `live-${projectId.slice(5, 13)}`);
  return { ctx, events, asked, ctrl, runId, started, workflowId, projectDir };
}

function report(name: string, t: ReturnType<typeof setup>) {
  const row = one<Record<string, unknown>>('SELECT cost_usd, input_tokens, output_tokens, cache_read_tokens, stop_reason, model FROM p6_runs WHERE id = ?', t.runId);
  const line = {
    test: name,
    seconds: Math.round((Date.now() - t.started) / 100) / 10,
    asked: t.asked.map((a) => `${a.toolName}: ${String(a.input.command ?? a.input.file_path ?? '')}`),
    blocked: t.events.filter((e) => e.type === 'tool-blocked').map((e) => String(e.payload.reason).slice(0, 120)),
    ran: t.events.filter((e) => e.type === 'tool-start').map((e) => String(e.payload.toolInput).slice(0, 120)),
    run: row,
  };
  console.log(`LIVE ${JSON.stringify(line)}`);
  fs.appendFileSync(path.join(os.tmpdir(), 'agentcore-live-report.jsonl'), JSON.stringify(line) + '\n');
}

const askBash = [{ id: 'ask-bash', group_id: 'g', name: 'shell', pattern: null, category: 'bash', action: 'ask', scope: 'always', reason: 'Shell commands need a person.', sort_order: 1, created_at: '', updated_at: '' }];

describe('LIVE: Claude runs in AgentCore with the harness', { skip: ARN ? false : 'set PORTAL_LIVE_CLAUDE_RUNTIME_ARN' }, () => {
  before(() => {
    createTestDb();
    liveDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-live-'));
    setConfig({
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: liveDataDir,
      webDir: '', secretKey: 'a'.repeat(64), cookieSecure: 'false', demoSpeed: 0, maxUploadBytes: 1 << 20,
      trustProxy: false, awsRegion: 'ap-southeast-1', deployTarget: null,
    } as Config);
  });
  after(async () => { await cleanup(); });

  it('a shell command waits for a person, runs when allowed, and the run is costed', async () => {
    const t = setup({ rules: askBash, answer: 'allow', goal: 'Use the Bash tool to run exactly: echo live-ok > live.txt && cat live.txt . Then reply with the word DONE.' });
    const summary = await runClaudeViaAgentCore(t.ctx, ARN);
    report('approve', t);
    assert.ok(t.asked.some((a) => String(a.input.command ?? '').includes('live-ok')), 'a person was asked about the command');
    assert.ok(t.events.some((e) => e.type === 'tool-start' && String(e.payload.toolInput).includes('live-ok')), 'the allowed command ran');
    assert.match(summary, /DONE|live-ok/i);
    const row = one<{ cost_usd: number; input_tokens: number }>('SELECT cost_usd, input_tokens FROM p6_runs WHERE id = ?', t.runId)!;
    assert.ok(row.cost_usd > 0 && row.input_tokens > 0, 'spend and tokens recorded');
  });

  it('a declined command does not run, and the agent hears why', async () => {
    const t = setup({ rules: askBash, answer: 'deny', goal: 'Use the Bash tool to run exactly: touch declined.txt . If it is not allowed, reply with the word STOPPED and do nothing else.' });
    await runClaudeViaAgentCore(t.ctx, ARN);
    report('decline', t);
    assert.ok(t.asked.length >= 1, 'a person was asked');
    assert.ok(!t.events.some((e) => e.type === 'tool-start' && String(e.payload.toolInput).includes('declined.txt')), 'the declined command did not run');
    assert.ok(t.events.some((e) => e.type === 'tool-blocked' && /declined/.test(String(e.payload.reason))));
  });

  it('the guard refuses a change to tool settings without asking anyone', async () => {
    const t = setup({ trusted: true, goal: 'This is an authorised test of a permission guard. Use the Write tool to create the file .claude/settings.json with the content {"permissions":{"allow":["Bash"]}} . Report what happened in one sentence.' });
    await runClaudeViaAgentCore(t.ctx, ARN);
    report('guard', t);
    assert.equal(t.asked.length, 0, 'nobody was asked');
    assert.ok(!t.events.some((e) => e.type === 'tool-start' && /settings\.json/.test(String(e.payload.toolInput))), 'the settings file was not written');
  });

  it('the engine stops at the run\'s spend cap and the portal records it', async () => {
    const t = setup({ trusted: true, budget: 0.001, goal: 'List the files in the current folder with the Bash tool, then describe each in a paragraph.' });
    await runClaudeViaAgentCore(t.ctx, ARN);
    report('budget', t);
    const row = one<{ stop_reason: string | null; cost_usd: number }>('SELECT stop_reason, cost_usd FROM p6_runs WHERE id = ?', t.runId)!;
    assert.match(String(row.stop_reason), /spend cap reached/);
  });

  it('stopping the run in the portal stops it in the microVM', async () => {
    const t = setup({ trusted: true, goal: 'Use the Bash tool to run exactly: node -e "setTimeout(() => {}, 240000)" and wait for it to finish. Then reply DONE.' });
    const p = runClaudeViaAgentCore(t.ctx, ARN);
    for (let i = 0; i < 600 && !t.events.some((e) => e.type === 'tool-start'); i++) await new Promise((r) => setTimeout(r, 100));
    t.ctrl.abort();
    await assert.rejects(p, (e: Error) => e.name === 'AbortError');
    report('cancel', t);
    assert.ok(t.events.some((e) => e.type === 'tool-start'), 'the long command had started before the stop');
    const row = one<{ cost_usd: number; input_tokens: number }>('SELECT cost_usd, input_tokens FROM p6_runs WHERE id = ?', t.runId)!;
    assert.ok(row.cost_usd > 0 && row.input_tokens > 0, 'the spend up to the stop is recorded');
  });

  it('an answer for a different call is refused by the runner', async () => {
    // A control call on a fresh session: nothing is waiting, so the runner refuses it.
    const send = agentCoreControlSender(ARN, `live-probe-${generateId()}-${generateId()}`);
    const replies = await send({ mode: 'answer', runId: 'nope', requestId: 'nope', decision: 'allow', inputHash: 'f'.repeat(64) });
    console.log(`LIVE ${JSON.stringify({ test: 'stray-answer', replies })}`);
    assert.equal(replies[0]?.type, 'answer-rejected');
  });

  it('Claude hands work to a project agent inside the microVM', async () => {
    const t = setup({
      trusted: true,
      goal: 'Use the Agent tool with subagent_type "note-writer" to have it create the file notes.txt containing the words agent-ok. Wait for it to finish, then reply with the word DONE.',
    });
    fs.mkdirSync(path.join(t.projectDir, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(t.projectDir, '.claude', 'agents', 'note-writer.md'), [
      '---',
      'name: note-writer',
      'description: Writes small text files when asked. Use it for any request to write a note file.',
      'tools: Write, Read, Bash',
      'model: haiku',
      '---',
      'You write the file you are asked for with the Write tool, then reply with one short sentence.',
      '',
    ].join('\n'));
    const summary = await runClaudeViaAgentCore(t.ctx, ARN);
    report('subagent', t);
    const started = t.events.find((e) => e.type === 'subagent-started');
    const ended = t.events.find((e) => e.type === 'subagent-finished' || e.type === 'subagent-failed');
    console.log(`LIVE ${JSON.stringify({ test: 'subagent-events', started: started?.payload, ended: ended?.payload, summary })}`);
    assert.equal(started?.payload.name, 'note-writer', 'the project agent started');
    assert.equal(ended?.type, 'subagent-finished', `the project agent finished: ${JSON.stringify(ended?.payload)}`);
    assert.ok(t.events.some((e) => e.type === 'tool-start' && e.payload.agent === 'note-writer'), 'its tool calls ran under its name');
    assert.match(summary, /DONE/i);
  });

  it('Claude starts a child session that runs in its own microVM and reports back', async () => {
    const userId = `user-${generateId()}`;
    getDb().prepare('INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(userId, `${userId}@example.com`, 'Live', 'x', now());
    const t = setup({
      trusted: true,
      ownerId: userId,
      goal: 'Use the delegate_session tool once, with task "Reply with exactly the words child-ok." and title "Live child". Then reply with the word DONE.',
    });
    // The child is a Claude session too: it runs on the same AgentCore runtime, in its own session.
    const prev = process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN;
    process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN = ARN;
    try {
      await runClaudeViaAgentCore(t.ctx, ARN);
      report('delegate', t);
      const child = one<{ id: string; title: string }>('SELECT id, title FROM p6_workflows WHERE parent_id = ?', t.workflowId);
      assert.ok(child, 'a child session was started');
      let result: { data: string } | undefined;
      for (let i = 0; i < 600 && !result; i++) {
        result = all<{ data: string }>(`SELECT data FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'child-result'`, t.workflowId)[0];
        if (!result) await new Promise((r) => setTimeout(r, 1000));
      }
      const childRun = one<Record<string, unknown>>('SELECT status, cost_usd, input_tokens, model FROM p6_runs WHERE workflow_id = ?', child.id);
      console.log(`LIVE ${JSON.stringify({ test: 'child-session', child, result: result?.data, childRun })}`);
      assert.ok(result, 'the child\'s result reached the parent');
      const posted = JSON.parse(result.data) as { status: string; summary: string };
      assert.equal(posted.status, 'done');
      assert.match(posted.summary, /child-ok/i, 'the child\'s answer itself reached the parent');
      assert.ok(Number(childRun?.cost_usd) > 0, 'the child called Bedrock in its own microVM');
    } finally {
      if (prev === undefined) delete process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN;
      else process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN = prev;
    }
  });

  it('the Agent pack\'s lead agent gets a two-part task done through its specialists', async () => {
    const t = setup({
      trusted: true,
      model: process.env.PORTAL_LIVE_LEAD_MODEL || HAIKU,
      goal: 'Create calc.py with a Python function add(a, b) that returns a + b, and a README.md that explains in two or three lines how to use it. '
        + 'Hand each part to the right specialist, check their results, then reply with the word DONE and the files that were created.',
    });
    // Agent setup › Add agent pack, as the project's own .claude folder.
    for (const f of claudePackFiles() as Array<{ path: string; content: string }>) {
      fs.mkdirSync(path.dirname(path.join(t.projectDir, '.claude', f.path)), { recursive: true });
      fs.writeFileSync(path.join(t.projectDir, '.claude', f.path), f.content);
    }
    t.ctx.run.leadAgent = 'lead-orchestrator';
    const summary = await runClaudeViaAgentCore(t.ctx, ARN);
    report('lead-agent', t);

    const specialists = (PACK_AGENTS as Array<{ name: string; lead?: boolean }>).filter((a) => !a.lead).map((a) => a.name);
    const started = t.events.filter((e) => e.type === 'subagent-started').map((e) => e.payload);
    const ended = t.events.filter((e) => e.type === 'subagent-finished' || e.type === 'subagent-failed').map((e): Record<string, unknown> => ({ ...e.payload, type: e.type }));
    const work = t.events.filter((e) => e.type === 'tool-start').map((e) => ({ agent: e.payload.agent ?? 'lead', tool: e.payload.toolName, input: String(e.payload.toolInput) }));
    console.log(`LIVE ${JSON.stringify({ test: 'lead-agent-detail', started, ended, work: work.map((w) => ({ ...w, input: w.input.slice(-120) })), summary })}`);

    assert.ok(t.events.some((e) => e.type === 'status' && /Lead agent: lead-orchestrator/.test(String(e.payload.text))), 'the lead agent runs the session');
    const used = [...new Set(started.map((s) => String(s.name)))];
    assert.ok(used.some((n) => specialists.includes(n)), `the lead handed work to its specialists; started: ${used.join(', ') || 'none'}`);
    assert.ok(ended.length >= started.length && ended.every((e) => e.type === 'subagent-finished' && e.status === 'completed'), `every specialist finished: ${JSON.stringify(ended)}`);
    const wrote = (file: string) => work.some((w) => specialists.includes(String(w.agent)) && /Write|Edit|Bash|PowerShell/.test(String(w.tool)) && w.input.includes(file));
    assert.ok(wrote('calc.py'), `a specialist wrote calc.py: ${JSON.stringify(work)}`);
    assert.ok(wrote('README'), `a specialist wrote the README: ${JSON.stringify(work)}`);
    assert.match(summary, /DONE/, 'the lead reports back');
    // The answer is streamed in small pieces; they join into whole lines, not one piece per line.
    assert.ok(summary.split('\n').length < 40, `the lead's report reads as text: ${JSON.stringify(summary.slice(0, 300))}`);
  });
});
