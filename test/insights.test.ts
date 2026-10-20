import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, Client, waitFor, type TestServer } from './client.ts';

// Insights aggregates: known runs and events are inserted, then every figure is checked.
let srv: TestServer;
let admin: Client;
let viewer: Client;
let insert: typeof import('../server/db.ts').insert;
const P: Record<string, string> = {};
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const H = 3_600_000;
const D = 24 * H;

function run(id: string, project: string, o: Partial<Record<string, any>>) {
  const created = o.created ?? iso(H);
  insert('runs', {
    id,
    project_id: project,
    kind: o.kind ?? 'chat',
    title: o.title ?? id,
    prompt: 'p',
    status: o.status ?? 'completed',
    model: o.model ?? 'sonnet',
    provider: o.provider ?? 'bedrock',
    cost_usd: o.cost ?? 0,
    input_tokens: o.inTok ?? 0,
    output_tokens: o.outTok ?? 0,
    meta: JSON.stringify(o.meta ?? {}),
    error: o.error ?? null,
    created_at: created,
    started_at: created,
    finished_at: o.durationMs === null ? null : new Date(Date.parse(created) + (o.durationMs ?? 10_000)).toISOString(),
  });
}
let seq = 0;
function ev(runId: string, type: string, data: unknown, parent: string | null = null, tsMs = now - H) {
  insert('run_events', { run_id: runId, seq: ++seq, ts: new Date(tsMs).toISOString(), type, parent_tool_use_id: parent, data: JSON.stringify(data) });
}

before(async () => {
  srv = await bootServer();
  ({ insert } = await import('../server/db.ts'));
  admin = new Client(srv.base);
  viewer = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'a-long-password-1' });
  await admin.post('/api/users', { email: 'v@example.com', name: 'Vic', password: 'a-long-password-2' });
  await viewer.post('/api/auth/login', { email: 'v@example.com', password: 'a-long-password-2' });
  P.a = (await admin.post('/api/projects', { name: 'Alpha', description: 'd' })).project.id;
  P.b = (await admin.post('/api/projects', { name: 'Beta', description: 'd' })).project.id;
  await admin.post(`/api/projects/${P.a}/members`, { email: 'v@example.com', access: 'viewer', role: 'QA' });

  // Alpha: two Bedrock runs (one with a QA subagent), one failed Bedrock run, one Kiro run, one old run (last period).
  run('r1', P.a, { cost: 1.5, inTok: 1000, outTok: 200, durationMs: 20_000, meta: { leadAgent: 'solution-architect' } });
  ev('r1', 'system:init', { model: 'global.anthropic.claude-sonnet-4-5' });
  ev('r1', 'assistant', { message: { id: 'm1', model: 'claude-sonnet-4-5', usage: { input_tokens: 600, output_tokens: 100 }, content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }, { type: 'tool_use', id: 'task1', name: 'Task', input: { subagent_type: 'qa-engineer' } }] } }, null, now - H);
  ev('r1', 'assistant', { message: { id: 'm2', model: 'claude-haiku-4-5', usage: { input_tokens: 400, output_tokens: 100 }, content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'npm test' } }] } }, 'task1', now - H + 1000);
  ev('r1', 'user', { message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'Blocked by Agent Portal: no', is_error: true }] } }, 'task1', now - H + 2000);
  ev('r1', 'user', { message: { content: [{ type: 'tool_result', tool_use_id: 'task1', content: 'done' }] } }, null, now - H + 5000);
  run('r2', P.a, { cost: 0.5, inTok: 500, outTok: 100, durationMs: 40_000, created: iso(2 * D) });
  run('r3', P.a, { status: 'failed', cost: 0.25, inTok: 100, outTok: 0, durationMs: 5_000, error: 'boom' });
  run('r4', P.a, { provider: 'kiro', model: 'sonnet', meta: { kiroCredits: 0.4 }, durationMs: 60_000 });
  ev('r4', 'system:init', { model: 'claude-sonnet-5.5' });
  run('r0', P.a, { cost: 9, inTok: 9, created: iso(40 * D) });
  // Beta: one Anthropic connection test.
  run('r5', P.b, { provider: 'anthropic', kind: 'connection', cost: 0.01, inTok: 20, outTok: 2, durationMs: 1_000 });
  insert('inputs', { id: 'i1', project_id: P.a, run_id: 'r1', type: 'approval', tool_name: 'Bash', payload: '{}', status: 'answered', response: JSON.stringify({ decision: 'deny' }), created_by: null, created_at: iso(H) });
  insert('inputs', { id: 'i2', project_id: P.a, run_id: 'r1', type: 'approval', tool_name: 'Write', payload: '{}', status: 'answered', response: JSON.stringify({ decision: 'allow' }), created_by: null, created_at: iso(H) });
});

after(() => srv.close());

test('totals, previous period, latency and success rate', async () => {
  const x = await admin.get('/api/insights?days=30');
  assert.equal(x.totals.runs, 5);
  assert.equal(x.totals.completed, 4);
  assert.equal(x.totals.failed, 1);
  assert.equal(x.totals.successRate, 0.8);
  assert.ok(Math.abs(x.totals.costUsd - 2.26) < 1e-9);
  assert.ok(Math.abs(x.totals.credits - 0.4) < 1e-9);
  assert.equal(x.totals.inputTokens, 1620);
  assert.equal(x.totals.outputTokens, 302);
  assert.equal(x.totals.prev.runs, 1);
  assert.equal(x.totals.prev.costUsd, 9);
  assert.equal(x.totals.medianDurationMs, 20_000);
  assert.equal(x.totals.p95DurationMs, 60_000);
  assert.equal(x.daily.length, 30);
  assert.equal(x.daily.reduce((s: number, d: any) => s + d.runs, 0), 5);
});

test('models use the model the run really ran on; providers and run types are grouped', async () => {
  const x = await admin.get('/api/insights?days=30');
  const m = Object.fromEntries(x.models.map((r: any) => [r.model, r]));
  assert.equal(m['global.anthropic.claude-sonnet-4-5'].runs, 1);
  assert.equal(m['claude-sonnet-5.5'].credits, 0.4);
  assert.equal(m['claude-sonnet-5.5'].provider, 'kiro');
  const p = Object.fromEntries(x.providers.map((r: any) => [r.provider, r]));
  assert.equal(p.bedrock.runs, 3);
  assert.equal(p.kiro.runs, 1);
  assert.equal(p.anthropic.runs, 1);
  assert.equal(Object.fromEntries(x.kinds.map((r: any) => [r.kind, r.runs])).connection, 1);
  const day = x.daily.find((d: any) => d.byProvider.kiro);
  assert.ok(day.tokensByModel['global.anthropic.claude-sonnet-4-5'] === 1200);
});

test('agents: lead agent and subagent with tokens, estimated cost, tools, success and duration', async () => {
  const x = await admin.get(`/api/insights?days=30&projectId=${P.a}`);
  const lead = x.agents.find((a: any) => a.name === 'solution-architect');
  assert.equal(lead.kind, 'main');
  assert.equal(lead.runs, 1);
  assert.equal(lead.inputTokens, 600);
  assert.ok(lead.estCostUsd > 0, 'estimated from the agent’s own usage');
  assert.deepEqual(lead.topTools.map((t: any) => t.name).sort(), ['Read', 'Task']);
  const qa = x.agents.find((a: any) => a.name === 'qa-engineer');
  assert.equal(qa.kind, 'subagent');
  assert.equal(qa.runs, 1);
  assert.equal(qa.completed, 1);
  assert.equal(qa.inputTokens, 400);
  assert.equal(qa.avgDurationMs, 5000);
  assert.ok(qa.estCostUsd < lead.estCostUsd, 'haiku costs less than sonnet');
  const bash = x.tools.find((t: any) => t.name === 'Bash');
  assert.deepEqual([bash.calls, bash.errors], [1, 1]);
  assert.equal(x.blocked, 1);
  assert.deepEqual(x.approvals, { asked: 2, denied: 1 });
  assert.equal(x.failures[0].id, 'r3');
  assert.equal(x.slowest[0].id, 'r4');
});

test('projects, filters and access', async () => {
  const all = await admin.get('/api/insights?days=30');
  const alpha = all.projects.find((p: any) => p.name === 'Alpha');
  assert.equal(alpha.runs, 4);
  assert.equal(alpha.successRate, 0.75);
  assert.equal(alpha.connection.provider, 'demo');
  const kiro = await admin.get('/api/insights?days=30&provider=kiro');
  assert.equal(kiro.totals.runs, 1);
  assert.equal(kiro.totals.inputTokens, 0, 'Kiro runs carry credits, not tokens');
  const tests = await admin.get('/api/insights?days=30&kind=connection');
  assert.equal(tests.totals.runs, 1);
  const week = await admin.get('/api/insights?days=7');
  assert.equal(week.totals.runs, 5);

  // A viewer of Alpha sees Alpha only, and cannot ask for Beta.
  const mine = await viewer.get('/api/insights?days=30');
  assert.deepEqual(mine.projects.map((p: any) => p.name), ['Alpha']);
  assert.equal(mine.totals.runs, 4);
  // Non-members get "not found" so they cannot even tell the project exists.
  assert.equal((await viewer.req('GET', `/api/insights?days=30&projectId=${P.b}`)).status, 404);
  assert.equal((await admin.req('GET', '/api/insights?days=5')).status, 400);
  assert.equal((await admin.req('GET', '/api/insights?days=30&provider=x')).status, 400);
});

test('a real Demo run shows up with its subagents', async () => {
  const pid = (await admin.post('/api/projects', { name: 'Gamma', description: 'd' })).project.id;
  await admin.post(`/api/projects/${pid}/roles`, { role: 'qa-engineer' }).catch(() => undefined);
  const { run } = await admin.post(`/api/projects/${pid}/runs`, { prompt: 'Design and build the refund approval flow', permissionMode: 'acceptEdits' });
  await waitFor(async () => {
    const r = await admin.get(`/api/runs/${run.id}`);
    for (const i of r.inputs.filter((x: any) => x.status === 'pending')) {
      await admin.post(`/api/inputs/${i.id}/answer`, i.type === 'question' ? { answers: Object.fromEntries((i.payload.questions || []).map((q: any) => [q.question, q.options?.[0]?.label ?? 'yes'])) } : { decision: 'allow' });
    }
    return ['completed', 'failed'].includes(r.run.status) ? r : null;
  }, 'demo run', 60_000);
  const x = await admin.get(`/api/insights?days=7&projectId=${pid}`);
  assert.equal(x.totals.runs, 1);
  assert.ok(x.agents.some((a: any) => a.kind === 'main'));
  assert.ok(x.tools.length > 0);
});
