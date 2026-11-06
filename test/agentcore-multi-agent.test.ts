/**
 * Several agents and several sessions for Claude runs on AgentCore (the portal side).
 *
 *   ✓ The run takes the project's agents (.claude/agents/*.md) and, with delegation on, the
 *     delegate_session switch; subagent progress is recorded and listed under the session's agents.
 *   ✓ A subagent's text is shown under its name and is not the run's answer.
 *   ✓ delegate_session starts a real child session (its own run); the agent gets its ID back,
 *     and the child's result is posted to the parent session.
 *   ✓ Requests that do not match their fingerprint, are blocked by a rule, or arrive with
 *     delegation off start nothing.
 *   ✓ A run after the first starts with a recap of earlier turns (each AgentCore run is a new
 *     engine session, so a parent resumed by its children's results keeps its context).
 *
 * A stand-in runtime (_setAgentCoreInvokerOverride) plays the runner.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one, all, insert } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { config } from '../server/config.ts';
import { setDelegationSettings } from '../server/delegation.ts';
import { _setAgentCoreInvokerOverride } from '../server/agent/kiro-agentcore.ts';
import { runClaudeViaAgentCore } from '../server/agent/claude-agentcore-bedrock.ts';
import { emitRunEvent } from '../server/agent/runner.ts';
import { inputFingerprint } from '../server/agent/tool-policy.ts';
import type { RunContext, AgentRun } from '../server/agent/types.ts';

const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/test-runtime';

let baseUrl = '';
let cookie = '';
let userId = '';

async function newSession(goal = 'Build the feature'): Promise<{ projectId: string; workflowId: string; projectDir: string }> {
  const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `Multi ${generateId().slice(0, 6)}` }, cookie });
  const projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
  // Demo engine: the session's own runs and any child session finish at once without a model.
  const w = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body: { goal, engine: 'demo' }, cookie });
  const workflowId = ((w.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
  const slug = String(one<{ slug: string }>('SELECT slug FROM projects WHERE id = ?', projectId)!.slug);
  return { projectId, workflowId, projectDir: path.join(config.dataDir, 'projects', slug) };
}

function makeCtx(ids: { projectId: string; workflowId: string }, opts: { rules?: unknown[]; owner?: string | null } = {}) {
  const runId = `run-${generateId()}`;
  insert('p6_runs', { id: runId, workflow_id: ids.workflowId, status: 'running', created_at: now() });
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ctrl = new AbortController();
  const run: AgentRun = {
    runId, workflowId: ids.workflowId, projectId: ids.projectId, goal: 'Build the feature', kind: null,
    engine: 'claude-code', trusted: false, dataDir: config.dataDir, workDir: config.dataDir, repoIds: [], leadAgent: null,
    permissions: { rules: (opts.rules ?? []) as never, toolRules: [], projectId: ids.projectId },
    credentialId: null, credentialOwnerId: opts.owner === undefined ? userId : opts.owner, model: 'claude-haiku-4-5', engineSessionId: null,
  };
  const ctx: RunContext = {
    run,
    emit: (type, payload) => {
      events.push({ type, payload: payload as Record<string, unknown> });
      emitRunEvent(runId, ids.projectId, ids.workflowId, type, payload);
    },
    awaitInput: async () => ({ decision: 'allow', remember: false, message: '' }),
    allowed: new Set(),
    signal: ctrl.signal,
  };
  return { ctx, events, runId };
}

const RESULT = {
  type: 'result', stop_reason: 'end_turn', subtype: 'success', costUsd: 0.01, costEstimated: false,
  model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', metrics: { inputTokens: 100, outputTokens: 20 },
};

/** A stand-in runner. `steps` yields its events; it can wait for the portal's answer to a request. */
function fakeRuntime(steps: (waitAnswer: () => Promise<Record<string, unknown>>) => AsyncGenerator<Record<string, unknown>>) {
  const calls: Array<Record<string, unknown>> = [];
  let answered: (p: Record<string, unknown>) => void = () => {};
  let answer = new Promise<Record<string, unknown>>((r) => { answered = r; });
  _setAgentCoreInvokerOverride(async function* (_arn, _sessionId, payload) {
    calls.push(payload);
    if (payload.mode === 'answer') {
      answered(payload);
      yield { type: 'answer-ack', requestId: payload.requestId } as never;
      return;
    }
    const waitAnswer = async () => {
      const a = await answer;
      answer = new Promise((r) => { answered = r; });
      return a;
    };
    for await (const ev of steps(waitAnswer)) yield ev as never;
  });
  return { calls };
}

async function waitFor<T>(check: () => T | undefined | null | false, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('Claude on AgentCore — several agents and several sessions', () => {
  before(async () => {
    ({ baseUrl } = await createTestServer());
    const r = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST', body: { email: 'multi@example.com', name: 'Multi', password: 'password1234', provider: 'demo' },
    });
    cookie = r.cookie ?? '';
    userId = String(one<{ id: string }>('SELECT id FROM users WHERE email = ?', 'multi@example.com')!.id);
  });
  after(async () => { _setAgentCoreInvokerOverride(null); await cleanup(); });

  it('sends the project\'s agents and the delegation switch; records subagent progress; the answer is the main agent\'s', async () => {
    const s = await newSession();
    fs.mkdirSync(path.join(s.projectDir, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(s.projectDir, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews changes for bugs\ntools: Read, Grep\nmodel: sonnet\n---\nYou review changes.\n');
    fs.writeFileSync(path.join(s.projectDir, '.claude', 'agents', 'README.md'), 'Not an agent: no front matter.');

    const rt = fakeRuntime(async function* () {
      yield { type: 'subagent-started', id: 'task-1', name: 'reviewer', description: 'Review the change', background: false, depth: 1 };
      yield { type: 'tool-start', toolName: 'Read', toolInput: '{"file_path":"a.ts"}', agent: 'reviewer' };
      yield { type: 'assistant-text', text: 'Two bugs in a.ts.', agent: 'reviewer' };
      yield { type: 'subagent-finished', id: 'task-1', name: 'reviewer', status: 'completed', summary: 'Two bugs', tokens: 900, toolUses: 1, extra: 'dropped' };
      yield { type: 'assistant-text', text: 'Reviewed: two bugs to fix.' };
      yield RESULT;
    });
    const t = makeCtx(s);
    const summary = await runClaudeViaAgentCore(t.ctx, ARN);

    const run = rt.calls.find((c) => c.mode === 'run')!;
    assert.deepEqual(run.agents, {
      reviewer: { description: 'Reviews changes for bugs', prompt: 'You review changes.', tools: ['Read', 'Grep'], model: 'sonnet' },
    }, 'the project\'s agent goes with the run; the README is not an agent');
    assert.deepEqual(run.delegation, { via: 'portal' }, 'delegation is on by default for a session with an owner');

    assert.equal(summary, 'Reviewed: two bugs to fix.', 'the subagent\'s text is not the run\'s answer');
    assert.ok(t.events.some((e) => e.type === 'assistant-text' && e.payload.agent === 'reviewer'), 'the subagent\'s text is shown under its name');
    assert.ok(t.events.some((e) => e.type === 'tool-start' && e.payload.agent === 'reviewer'), 'its tool calls say whose they are');
    const finished = t.events.find((e) => e.type === 'subagent-finished')!;
    assert.deepEqual(finished.payload, { id: 'task-1', name: 'reviewer', status: 'completed', summary: 'Two bugs', tokens: 900, toolUses: 1 }, 'only known fields are kept');

    const agents = await fetchJson(baseUrl, `/api/workflows/${s.workflowId}/agents`, { cookie });
    const listed = ((agents.body as Record<string, unknown>).agents as Array<Record<string, unknown>>).filter((a) => a.source === 'event');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'reviewer');
    assert.equal(listed[0].status, 'done');
    assert.equal(listed[0].description, 'Review the change');
  });

  it('delegate_session starts a child session; the agent gets its ID; the child\'s result reaches the parent', async () => {
    const s = await newSession('Ship the release');
    let answer: Record<string, unknown> = {};
    const input = { task: 'Write the release notes for version 2', title: 'Release notes' };
    fakeRuntime(async function* (waitAnswer) {
      yield { type: 'tool-start', toolName: 'mcp__portal__delegate_session', toolInput: JSON.stringify(input) };
      yield { type: 'delegate-request', requestId: 'dlg-1', input, inputHash: inputFingerprint('delegate_session', input) };
      answer = await waitAnswer();
      yield { type: 'tool-result', name: 'mcp__portal__delegate_session', output: String(answer.message) };
      yield { type: 'assistant-text', text: 'Delegated the notes.' };
      yield RESULT;
    });
    const t = makeCtx(s);
    await runClaudeViaAgentCore(t.ctx, ARN);

    assert.equal(answer.decision, 'allow', String(answer.message));
    assert.equal(answer.inputHash, inputFingerprint('delegate_session', input), 'the answer is bound to the exact call');
    const started = JSON.parse(String(answer.message)) as { childWorkflowId: string; title: string; status: string };
    assert.equal(started.status, 'started');
    assert.equal(started.title, 'Release notes');
    const child = one<{ parent_id: string; goal: string; project_id: string; engine: string }>(
      'SELECT parent_id, goal, project_id, engine FROM p6_workflows WHERE id = ?', started.childWorkflowId)!;
    assert.equal(child.parent_id, s.workflowId, 'the child belongs to this session');
    assert.equal(child.goal, input.task);
    assert.equal(child.project_id, s.projectId, 'same project');
    assert.equal(child.engine, 'demo', 'same engine as the parent');

    // The child runs on its own; when it finishes, its result is posted to the parent.
    const posted = await waitFor(
      () => all<{ data: string }>(`SELECT data FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'child-result'`, s.workflowId)
        .find((e) => JSON.parse(e.data).childId === started.childWorkflowId),
      'the child\'s result in the parent session',
    );
    assert.ok(posted);
  });

  it('starts nothing for a request that does not match, that a rule blocks, or when delegation is off', async () => {
    const s = await newSession();
    const childCount = () => all('SELECT id FROM p6_workflows WHERE parent_id = ?', s.workflowId).length;
    const ask = async (ev: Record<string, unknown>, opts: { rules?: unknown[] } = {}) => {
      let answer: Record<string, unknown> = {};
      const rt = fakeRuntime(async function* (waitAnswer) {
        yield ev;
        answer = await waitAnswer();
        yield RESULT;
      });
      await runClaudeViaAgentCore(makeCtx(s, opts).ctx, ARN);
      return { answer, run: rt.calls.find((c) => c.mode === 'run')! };
    };
    const input = { task: 'Do part two' };
    const good = { type: 'delegate-request', requestId: 'r', input, inputHash: inputFingerprint('delegate_session', input) };

    const mismatch = await ask({ ...good, inputHash: inputFingerprint('delegate_session', { task: 'something else' }) });
    assert.equal(mismatch.answer.decision, 'deny');
    assert.match(String(mismatch.answer.message), /did not match/);

    const blocked = await ask(good, {
      rules: [{ id: 'no-delegate', pattern: '^mcp__portal__delegate_session$', category: null, action: 'block', scope: 'always', reason: 'No child sessions in this project.' }],
    });
    assert.equal(blocked.answer.decision, 'deny');
    assert.match(String(blocked.answer.message), /No child sessions in this project/);

    setDelegationSettings({ enabled: false });
    try {
      const off = await ask(good);
      assert.equal(off.run.delegation, undefined, 'the runner does not get the tool');
      assert.equal(off.answer.decision, 'deny');
      assert.match(String(off.answer.message), /turned off/);
    } finally {
      setDelegationSettings({ enabled: true });
    }
    assert.equal(childCount(), 0, 'no child session was started');
  });

  it('delegate_session can name the agent that runs the child session; an agent the run does not have starts nothing', async () => {
    const s = await newSession('Ship the release');
    fs.mkdirSync(path.join(s.projectDir, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(s.projectDir, '.claude', 'agents', 'tech-writer.md'),
      '---\nname: tech-writer\ndescription: Writes documentation\n---\nYou write documentation.\n');
    const leadOf = (id: string) => one<{ lead_agent: string | null }>('SELECT lead_agent FROM p6_workflows WHERE id = ?', id)?.lead_agent ?? '';
    const ask = async (input: Record<string, unknown>) => {
      let answer: Record<string, unknown> = {};
      const rt = fakeRuntime(async function* (waitAnswer) {
        yield { type: 'delegate-request', requestId: `r-${generateId()}`, input, inputHash: inputFingerprint('delegate_session', input) };
        answer = await waitAnswer();
        yield RESULT;
      });
      await runClaudeViaAgentCore(makeCtx(s).ctx, ARN);
      return { answer, run: rt.calls.find((c) => c.mode === 'run')! };
    };

    const named = await ask({ task: 'Write the release notes', title: 'Notes', agent: 'tech-writer' });
    assert.ok(named.run.agents && 'tech-writer' in (named.run.agents as Record<string, unknown>), 'the runner knows the agent');
    assert.equal(named.answer.decision, 'allow', String(named.answer.message));
    const child = JSON.parse(String(named.answer.message)) as { childWorkflowId: string };
    assert.equal(leadOf(child.childWorkflowId), 'tech-writer', 'the named agent runs the child session');

    const plain = await ask({ task: 'Check the changelog' });
    assert.equal(plain.answer.decision, 'allow', String(plain.answer.message));
    assert.equal(leadOf(JSON.parse(String(plain.answer.message)).childWorkflowId), leadOf(s.workflowId), 'without one, the parent\'s lead agent');

    const before = all('SELECT id FROM p6_workflows WHERE parent_id = ?', s.workflowId).length;
    const unknown = await ask({ task: 'Do part two', agent: 'nobody' });
    assert.equal(unknown.answer.decision, 'deny');
    assert.match(String(unknown.answer.message), /no agent "nobody".*tech-writer/);
    const malformed = await ask({ task: 'Do part two', agent: 'not an agent name!' });
    assert.equal(malformed.answer.decision, 'deny');
    assert.match(String(malformed.answer.message), /did not match/);
    assert.equal(all('SELECT id FROM p6_workflows WHERE parent_id = ?', s.workflowId).length, before, 'neither started a session');
  });

  it('a streamed reply joins into one line of the answer; the next reply starts a new one', async () => {
    const s = await newSession();
    fakeRuntime(async function* () {
      for (const text of ['I\'ll del', 'egate th', 'is.']) yield { type: 'assistant-text', text, stream: true };
      yield { type: 'tool-start', toolName: 'Agent', toolInput: '{}' };
      yield { type: 'assistant-text', text: 'Subagent notes.', agent: 'reviewer' };
      for (const text of ['Both ', 'are done.']) yield { type: 'assistant-text', text, stream: true };
      yield { type: 'context', percent: 3 };
      for (const text of ['**DO', 'NE**']) yield { type: 'assistant-text', text, stream: true };
      yield { type: 'assistant-text', text: 'A whole reply.' };
      yield RESULT;
    });
    const t = makeCtx(s);
    const summary = await runClaudeViaAgentCore(t.ctx, ARN);
    assert.equal(summary, 'I\'ll delegate this.\nBoth are done.\n**DONE**\nA whole reply.');
    const shown = t.events.filter((e) => e.type === 'assistant-text' && !e.payload.agent);
    assert.deepEqual(shown.map((e) => e.payload.stream === true), [true, true, true, true, true, true, true, false],
      'the pieces are shown as pieces of one reply (the viewer joins them)');
  });

  it('a session without an owner cannot start child sessions', async () => {
    const s = await newSession();
    const rt = fakeRuntime(async function* () { yield RESULT; });
    await runClaudeViaAgentCore(makeCtx(s, { owner: null }).ctx, ARN);
    assert.equal(rt.calls.find((c) => c.mode === 'run')!.delegation, undefined);
  });

  it('a run after the first starts with a recap of earlier turns', async () => {
    const s = await newSession('Plan the migration');
    const earlier = `run-${generateId()}`;
    insert('p6_runs', { id: earlier, workflow_id: s.workflowId, status: 'done', created_at: now() });
    insert('p6_events', { run_id: earlier, type: 'run-complete', payload: JSON.stringify({ result: 'Started three child sessions for the schema, the data and the cut-over.' }), created_at: now() });
    const rt = fakeRuntime(async function* () { yield RESULT; });
    const t = makeCtx(s);
    t.ctx.run.goal = 'Child session "Schema" finished with status: done.';
    await runClaudeViaAgentCore(t.ctx, ARN);
    const prompt = String(rt.calls.find((c) => c.mode === 'run')!.prompt);
    assert.match(prompt, /Started three child sessions/, 'the earlier answer is in the prompt');
    assert.ok(prompt.endsWith('Child session "Schema" finished with status: done.'), 'the new input comes last');
    assert.ok(t.events.some((e) => e.type === 'status' && /recap/.test(String(e.payload.text))));
  });
});
