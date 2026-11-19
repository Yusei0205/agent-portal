/**
 * AgentCore evaluations: a transcript becomes Strands-format spans (turns, tool calls, answers), the evaluators score it, results are
 * stored, a stable share of finished sessions is sampled, and the routes are for admins only.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { hashPassword } from '../server/auth.ts';
import { now } from '../server/util.ts';
import { setSetting } from '../server/settings.ts';
import {
  buildSessionSpans, groupTurns, isSampled, evaluateWorkflow, listEvaluations, sweepEvaluations, _setEvalClient, EVALUATORS,
} from '../server/agentcore-eval.ts';
import type { TranscriptRow } from '../server/repositories/sessions.ts';

const t = (n: number) => new Date(Date.UTC(2026, 10, 19, 10, 0, n)).toISOString();
const row = (src: 'r' | 'w', id: number, n: number, kind: string, body: unknown, run: string | null = 'run-1'): TranscriptRow =>
  ({ src, id, created_at: t(n), kind, body: typeof body === 'string' ? body : JSON.stringify(body), run_id: src === 'w' ? null : run });

const rows: TranscriptRow[] = [
  row('w', 1, 0, 'human', 'Fix the failing test'),
  row('r', 2, 1, 'assistant-text', { text: 'Looking ', stream: true }),
  row('r', 3, 2, 'assistant-text', { text: 'now', stream: true }),
  row('r', 4, 3, 'tool-start', { toolCallId: 'c1', toolName: 'Read', toolInput: '{"path":"utils.ts"}' }),
  row('r', 5, 4, 'tool-end', { toolCallId: 'c1', toolName: 'Read', output: 'export const x = 1' }),
  row('r', 6, 5, 'run-complete', { result: 'Fixed the off-by-one.' }),
  row('w', 7, 6, 'human', 'Thanks, now add a test'),
  row('r', 8, 7, 'run-complete', { result: 'Added a test.' }, 'run-2'),
];

describe('buildSessionSpans', () => {
  test('groups rows into one turn per run with the person\'s message and the tool calls', () => {
    const turns = groupTurns(rows);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].user, 'Fix the failing test');
    assert.equal(turns[0].text, 'Looking now');
    assert.equal(turns[0].calls.length, 1);
    assert.equal(turns[0].calls[0].output, 'export const x = 1');
    assert.equal(turns[1].user, 'Thanks, now add a test');
  });

  test('builds Strands spans: an agent span, a chat and a tool span per call, and a final chat', () => {
    const { spans, turns, toolCalls } = buildSessionSpans(rows, 'wf-1');
    assert.equal(turns, 2);
    assert.equal(toolCalls, 1);
    const ops = spans.map((s) => (s.attributes as Record<string, string>)['gen_ai.operation.name']);
    assert.deepEqual(ops, ['invoke_agent', 'chat', 'execute_tool', 'chat', 'invoke_agent', 'chat']);
    assert.ok(spans.every((s) => (s.scope as { name: string }).name === 'strands.telemetry.tracer'));
    assert.ok(spans.every((s) => (s.attributes as Record<string, string>)['session.id'] === 'wf-1'));
    const tool = spans.find((s) => (s.attributes as Record<string, string>)['gen_ai.tool.name'] === 'Read');
    assert.ok(tool);
    // A span ends after it starts, and the spans of one turn share a trace.
    assert.ok(spans.every((s) => (s.endTimeUnixNano as number) > (s.startTimeUnixNano as number)));
    assert.equal(new Set(spans.slice(0, 4).map((s) => s.traceId)).size, 1);
    assert.notEqual(spans[0].traceId, spans[4].traceId);
  });

  test('a long session keeps its first and last tool calls', () => {
    const many: TranscriptRow[] = [row('w', 1, 0, 'human', 'go')];
    for (let i = 0; i < 100; i++) many.push(row('r', 10 + i, 1 + i, 'tool-start', { toolCallId: `c${i}`, toolName: `T${i}`, toolInput: '{}' }));
    const { toolCalls, spans } = buildSessionSpans(many, 'wf-2');
    assert.equal(toolCalls, 30);
    const names = spans.filter((s) => (s.attributes as Record<string, string>)['gen_ai.tool.name']).map((s) => (s.attributes as Record<string, string>)['gen_ai.tool.name']);
    assert.ok(names.includes('T0') && names.includes('T99') && !names.includes('T50'));
  });

  test('a session with no turns builds no spans', () => {
    assert.equal(buildSessionSpans([], 'wf-3').spans.length, 0);
  });
});

describe('isSampled', () => {
  test('0 never and 100 always; the same session and turn always land the same way', () => {
    assert.equal(isSampled('w', 'x', 0), false);
    assert.equal(isSampled('w', 'x', 100), true);
    assert.equal(isSampled('w', 'x', 50), isSampled('w', 'x', 50));
  });
  test('about the asked share of sessions', () => {
    let hits = 0;
    for (let i = 0; i < 1000; i++) if (isSampled(`wf-${i}`, 'ts', 20)) hits++;
    assert.ok(hits > 140 && hits < 260, `got ${hits}`);
  });
});

describe('evaluateWorkflow, sweep and routes', () => {
  let baseUrl: string;
  let adminCookie = '';
  let memberCookie = '';
  const sent: Array<{ evaluatorId: string; spans: number }> = [];

  before(async () => {
    ({ baseUrl } = await createTestServer());
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@eval.test', password: 'adminpass1', name: 'Admin' } });
    adminCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@eval.test', password: 'adminpass1' } })).cookie ?? '';
    getDb().prepare('INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run('user-eval-member', 'member@eval.test', 'Member', hashPassword('memberpass1'), now());
    memberCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'member@eval.test', password: 'memberpass1' } })).cookie ?? '';
    _setEvalClient({
      Cmd: class { constructor(public input: { evaluatorId: string; evaluationInput: { sessionSpans: unknown[] } }) {} },
      client: {
        async send(cmd: { input: { evaluatorId: string; evaluationInput: { sessionSpans: unknown[] } } }) {
          sent.push({ evaluatorId: cmd.input.evaluatorId, spans: cmd.input.evaluationInput.sessionSpans.length });
          // Tool evaluators have nothing to score without tool calls: the service returns no result.
          if (/Tool/.test(cmd.input.evaluatorId) && sent.length > 0 && cmd.input.evaluationInput.sessionSpans.length < 4) return { evaluationResults: [] };
          return { evaluationResults: [{ value: 0.83, label: 'Very Helpful', explanation: 'ok', tokenUsage: { inputTokens: 100, outputTokens: 10 } }] };
        },
      },
    });
  });
  after(async () => { _setEvalClient(null); await cleanup(); });
  beforeEach(() => {
    sent.length = 0;
    getDb().prepare('DELETE FROM p6_events').run();
    getDb().prepare('DELETE FROM p6_workflows').run();
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'agentcore.eval%'").run();
  });

  const seed = (wid: string, minutesAgo = 30): void => {
    const ts = now();
    getDb().prepare(`INSERT INTO p6_workflows (id, goal, title, status, engine, trust_tools, lead_agent, created_at, updated_at, last_turn_at, stop_reason)
      VALUES (?, 'g', 'My session', 'done', 'codex', 0, 'default', ?, ?, ?, '')`).run(wid, ts, ts, new Date(Date.now() - minutesAgo * 60_000).toISOString());
    getDb().prepare('INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, ?, ?)').run(`run-${wid}`, wid, 'done', ts);
    const ins = getDb().prepare('INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)');
    ins.run(`run-${wid}`, 'assistant-text', JSON.stringify({ text: 'Hello' }), ts);
    ins.run(`run-${wid}`, 'run-complete', JSON.stringify({ result: 'Done.' }), ts);
  };

  test('scores a session with every evaluator, stores it, and lists it', async () => {
    seed('wf-eval-1');
    const rec = await evaluateWorkflow('wf-eval-1');
    assert.equal(rec.turns, 1);
    assert.equal(sent.length, EVALUATORS.length);
    const helpful = rec.scores.find((s) => s.evaluator === 'Helpfulness');
    assert.equal(helpful?.value, 0.83);
    // No tool calls: the tool evaluators say so instead of leaving a gap or failing the rest.
    assert.match(rec.scores.find((s) => s.evaluator === 'ToolSelectionAccuracy')?.explanation ?? '', /no tool calls/);
    assert.equal(rec.inputTokens, 100 * 2);
    assert.equal(listEvaluations()[0].workflowId, 'wf-eval-1');
  });

  test('an unknown session is 404 and an empty one is refused', async () => {
    await assert.rejects(evaluateWorkflow('nope'), /not found/i);
    const ts = now();
    getDb().prepare(`INSERT INTO p6_workflows (id, goal, title, status, engine, trust_tools, lead_agent, created_at, updated_at) VALUES ('wf-empty', 'g', 't', 'done', 'codex', 0, 'default', ?, ?)`).run(ts, ts);
    await assert.rejects(evaluateWorkflow('wf-empty'), /no turns/i);
  });

  test('the sweep scores nothing at 0%, and a quiet sampled session once at 100%', async () => {
    seed('wf-eval-2', 30);
    assert.equal(await sweepEvaluations(), 0);
    await setSetting(getDb(), 'agentcore.eval.sample_percent', '100');
    assert.equal(await sweepEvaluations(), 1);
    assert.equal(await sweepEvaluations(), 0);
  });

  test('the sweep leaves a session that has not been quiet for five minutes', async () => {
    seed('wf-eval-3', 1);
    await setSetting(getDb(), 'agentcore.eval.sample_percent', '100');
    assert.equal(await sweepEvaluations(), 0);
  });

  test('routes are for admins only, and validate input', async () => {
    assert.equal((await fetchJson(baseUrl, '/api/agentcore/evals', { cookie: memberCookie })).status, 403);
    assert.equal((await fetchJson(baseUrl, '/api/agentcore/evals', { method: 'POST', cookie: memberCookie, body: { workflowId: 'x' } })).status, 403);
    const post = (body: unknown) => fetchJson(baseUrl, '/api/agentcore/evals', { method: 'POST', cookie: adminCookie, body });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ recent: 99 })).status, 400);
    assert.equal((await post({ workflowId: 'missing' })).status, 404);
    const put = (body: unknown) => fetchJson(baseUrl, '/api/agentcore/evals', { method: 'PUT', cookie: adminCookie, body });
    assert.equal((await put({ samplePercent: 150 })).status, 400);
    assert.equal((await put({ samplePercent: 10 })).status, 200);
    const list = await fetchJson(baseUrl, '/api/agentcore/evals', { cookie: adminCookie });
    assert.equal((list.body as { samplePercent: number }).samplePercent, 10);
  });

  test('POST with a workflowId returns the stored score', async () => {
    seed('wf-eval-4');
    const r = await fetchJson(baseUrl, '/api/agentcore/evals', { method: 'POST', cookie: adminCookie, body: { workflowId: 'wf-eval-4' } });
    assert.equal(r.status, 200);
    assert.equal((r.body as { evaluations: Array<{ workflowId: string }> }).evaluations[0].workflowId, 'wf-eval-4');
  });
});
