import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { parseGraph, sdlcTemplate, type AutomationGraph } from '../server/automations/schema.ts';
import { getAutomationsRepository } from '../server/repositories/automations.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { getProjectRepository } from '../server/repositories/projects.ts';
import { createUser } from '../server/auth.ts';
import { generateId, now } from '../server/util.ts';
import { tickAutomation, runKey, renderInstructions, setAutomationSchedulerForTests, stopLocalAutomationTimers, type AutomationRun } from '../server/automations/engine.ts';

function simpleGraph(): AutomationGraph {
  const g = sdlcTemplate(); g.engine = 'demo';
  g.nodes = g.nodes.filter((n) => ['start', 'approve', 'end'].includes(n.id));
  g.edges = [{ id: 'a', source: 'start', target: 'approve', branch: 'next' }, { id: 'b', source: 'approve', target: 'end', branch: 'next' }];
  return g;
}
describe('Workflow graph validation', () => {
  it('maps only explicit input and completed step outputs without evaluating expressions', () => {
    assert.equal(renderInstructions('Request {{ input }} / {{steps.design.output}}', '$&', [{ nodeId: 'design', label: 'Design', visit: 1, status: 'passed', output: 'design text', startedAt: now() }]), 'Request $& / design text');
    assert.throws(() => renderInstructions('{{steps.missing.output}}', '', []), /no output/);
    assert.equal(renderInstructions('{{process.env.SECRET}}', '', []), '{{process.env.SECRET}}');
  });
  it('accepts the bounded SDLC retry loop and removes unknown configuration', () => {
    const raw = { ...sdlcTemplate(), secrets: { token: 'never-store-this' } };
    assert.equal(parseGraph(raw, true).nodes.length, 10);
    assert.equal('secrets' in parseGraph(raw), false);
  });
  it('allows disconnected drafts but refuses to publish them', () => {
    const g = simpleGraph(); g.edges = [];
    assert.doesNotThrow(() => parseGraph(g)); assert.throws(() => parseGraph(g, true), /connect/);
  });
  it('rejects dangling edges, duplicate IDs, invalid branches, and missing Start', () => {
    const g = simpleGraph();
    assert.throws(() => parseGraph({ ...g, edges: [{ ...g.edges[0], target: 'missing' }] }), /missing/);
    assert.throws(() => parseGraph({ ...g, nodes: [...g.nodes, g.nodes[0]] }), /unique/);
    assert.throws(() => parseGraph({ ...g, edges: [{ ...g.edges[0], branch: 'maybe' }] }), /connection/);
    assert.throws(() => parseGraph({ ...g, nodes: [], edges: [] }, true), /Start/);
  });
  it('rejects unreachable islands and loops without a path to End', () => {
    const g = simpleGraph(); g.nodes.push({ ...g.nodes[1], id: 'island' }); g.edges.push({ id: 'c', source: 'island', target: 'island', branch: 'next' });
    assert.throws(() => parseGraph(g, true), /reachable/);
  });
  it('requires exactly Yes/No for conditions and bounds execution limits', () => {
    const g = sdlcTemplate(); g.edges = g.edges.filter((e) => e.branch !== 'no');
    assert.throws(() => parseGraph(g, true), /Yes/);
    assert.throws(() => parseGraph({ ...simpleGraph(), maxSteps: 101 }), /number/);
    assert.throws(() => parseGraph({ ...simpleGraph(), timeoutMinutes: Infinity }), /number/);
    assert.throws(() => parseGraph({ ...simpleGraph(), budgetUsd: -1 }), /Budget/);
  });
  it('refuses unsafe checks, excessive check time, and unmeasurable dollar budgets', () => {
    const g = sdlcTemplate(); const n = g.nodes.find((n) => n.id === 'tests')!;
    n.checks = [{ step: 'push', cmd: 'git push origin main' }]; assert.throws(() => parseGraph(g), /not allowed/);
    n.checks = [{ step: 'slow', cmd: 'npm test', timeout: 900 }]; assert.throws(() => parseGraph(g), /10 minutes/);
    assert.throws(() => parseGraph({ ...sdlcTemplate(), budgetUsd: 5 }), /dollar cost/);
  });
});

describe('Workflow API and durable transitions', () => {
  let base: string; let cookie: string; let project: string; let d: any;
  const api = async (path: string, body?: unknown, method?: string) => fetchJson(base, `/api/projects/${project}/automations${path}`, { cookie, body, method });
  const state = async (id: string) => (await getAutomationsRepository()).get<AutomationRun>(project, runKey(id));
  before(async () => {
    setAutomationSchedulerForTests(async () => {});
    ({ baseUrl: base } = await createTestServer());
    const setup = await fetchJson(base, '/api/auth/setup', { method: 'POST', body: { email: 'automation@example.com', name: 'Admin', password: 'password1234', provider: 'demo' } });
    cookie = setup.cookie!;
    const p = await fetchJson(base, '/api/projects', { cookie, method: 'POST', body: { name: 'Automation project' } }); project = (p.body as any).project.id;
  });
  after(async () => { stopLocalAutomationTimers(); setAutomationSchedulerForTests(null); await cleanup(); });
  it('requires authentication and rejects repositories outside the project', async () => {
    assert.equal((await fetchJson(base, `/api/projects/${project}/automations`)).status, 401);
    assert.equal((await api('', { name: 'Bad', graph: { ...simpleGraph(), repoIds: ['foreign'] } })).status, 400);
    const viewer = await createUser({ email: 'workflow-viewer@example.com', name: 'Viewer', password: 'password1234', isAdmin: false });
    await getProjectRepository().addMember(project, viewer.id, 'viewer');
    const login = await fetchJson(base, '/api/auth/login', { body: { email: viewer.email, password: 'password1234' } });
    assert.equal((await fetchJson(base, `/api/projects/${project}/automations`, { cookie: login.cookie })).status, 200);
    assert.equal((await fetchJson(base, `/api/projects/${project}/automations`, { cookie: login.cookie, body: { name: 'Forbidden' } })).status, 403);
  });
  it('saves drafts with compare-and-swap and publishes immutable versions', async () => {
    const r = await api('', { name: 'Approval workflow', graph: simpleGraph() }); assert.equal(r.status, 201); d = (r.body as any).definition;
    assert.equal((await api(`/${d.id}`, { revision: 999, name: d.name, graph: d.graph }, 'PUT')).status, 409);
    const pub = await api(`/${d.id}/publish`, { revision: d.revision }); assert.equal(pub.status, 200); d = (pub.body as any).definition;
    const saved = await api(`/${d.id}`, { revision: d.revision, name: 'Edited draft', graph: { ...d.graph, timeoutMinutes: 90 } }, 'PUT');
    assert.equal(saved.status, 200); d = (saved.body as any).definition;
    const versions = (await api(`/${d.id}/versions`)).body as any;
    assert.equal(versions.versions.length, 1); assert.equal(versions.versions[0].graph.timeoutMinutes, 120); assert.equal(d.graph.timeoutMinutes, 90);
  });
  it('pins runs to published versions and deduplicates retries of a start request', async () => {
    const requestId = generateId();
    const a = await api(`/${d.id}/runs`, { requestId, input: 'build this' }); assert.equal(a.status, 202, JSON.stringify(a.body));
    const b = await api(`/${d.id}/runs`, { requestId, input: 'build this' }); assert.equal(b.status, 200);
    const run = (a.body as any).run; assert.equal(run.version, 1); assert.equal((b.body as any).run.id, run.id);
    await tickAutomation(project, run.id); await tickAutomation(project, run.id);
    const waiting = (await state(run.id))!; assert.equal(waiting.status, 'waiting'); assert.equal(waiting.cursor, 'approve');
    await tickAutomation(project, run.id); await tickAutomation(project, run.id);
    assert.equal((await state(run.id))!.revision, waiting.revision, 'unchanged approval polls must preserve the revision shown to the reviewer');
    assert.equal((await api(`/${d.id}/runs/${run.id}/approve`, { revision: waiting.revision - 1, nodeId: 'approve', visit: 1 })).status, 409);
    assert.equal((await api(`/${d.id}/runs/${run.id}/approve`, { revision: waiting.revision, nodeId: 'wrong', visit: 1 })).status, 400);
    const approved = await api(`/${d.id}/runs/${run.id}/approve`, { revision: waiting.revision, nodeId: 'approve', visit: 1 }); assert.equal(approved.status, 200);
    await tickAutomation(project, run.id); assert.equal((await state(run.id))!.status, 'done');
    assert.deepEqual((await state(run.id))!.attempts.map((a) => a.status), ['passed', 'approved', 'passed']);
  });
  it('honors cancellation and never crosses project boundaries', async () => {
    const created = await api(`/${d.id}/runs`, { requestId: generateId() }); const run = (created.body as any).run;
    assert.equal((await api(`/${d.id}/runs/${run.id}/cancel`, { revision: run.revision })).status, 200);
    await tickAutomation(project, run.id); assert.equal((await state(run.id))!.status, 'cancelled'); assert.equal((await state(run.id))!.attempts.length, 0);
    const p = await fetchJson(base, '/api/projects', { cookie, method: 'POST', body: { name: 'Other project' } });
    const other = (p.body as any).project.id;
    assert.equal((await fetchJson(base, `/api/projects/${other}/automations/${d.id}`, { cookie })).status, 404);
    assert.equal((await fetchJson(base, `/api/projects/${other}/automations/${d.id}/runs/${run.id}`, { cookie })).status, 404);
  });
  it('serializes concurrent ticks and fails bounded loops and expired runs', async () => {
    const created = await api(`/${d.id}/runs`, { requestId: generateId() }); const run = (created.body as any).run;
    await Promise.all([tickAutomation(project, run.id), tickAutomation(project, run.id)]);
    assert.equal((await state(run.id))!.attempts.length, 1);
    const r = (await state(run.id))!;
    await (await getAutomationsRepository()).put(project, runKey(r.id), { ...r, revision: r.revision + 1, started_at: '2000-01-01T00:00:00.000Z' }, r.revision);
    await tickAutomation(project, r.id); assert.equal((await state(r.id))!.status, 'failed'); assert.match((await state(r.id))!.error!, /time limit/);
  });
  it('runs a real demo task asynchronously and continues in the same session', async () => {
    const g = simpleGraph(); g.nodes = g.nodes.map((n) => n.id === 'approve' ? { ...n, kind: 'agent', prompt: 'Explain a small implementation plan' } : n);
    let response = await api('', { name: 'Demo execution', graph: g }); const def = (response.body as any).definition;
    await api(`/${def.id}/publish`, { revision: def.revision });
    response = await api(`/${def.id}/runs`, { requestId: generateId() }); const run = (response.body as any).run;
    await tickAutomation(project, run.id); await tickAutomation(project, run.id);
    const active = (await state(run.id))!; assert.equal(active.attempts.at(-1)!.status, 'running');
    const session = (await getSessionsRepository().getWorkflowById(active.session_id))!;
    assert.equal(session.kind, 'automation'); assert.equal(session.trust_tools, 0);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await state(run.id))!.status === 'running') { await new Promise((r) => setTimeout(r, 250)); await tickAutomation(project, run.id); }
    assert.equal((await state(run.id))!.status, 'done', JSON.stringify(await state(run.id)));
    assert.match((await state(run.id))!.attempts[1].output!, /Demo|plan|done|complete/i);
  });
  it('branches on persisted failed check results and stops at a visit limit', async () => {
    const g = sdlcTemplate(); g.engine = 'demo';
    g.nodes = g.nodes.filter((n) => ['start', 'tests', 'passed', 'end'].includes(n.id));
    g.nodes.find((n) => n.id === 'tests')!.maxVisits = 1;
    g.edges = [
      { id: 'a', source: 'start', target: 'tests', branch: 'next' }, { id: 'b', source: 'tests', target: 'passed', branch: 'next' },
      { id: 'c', source: 'passed', target: 'end', branch: 'yes' }, { id: 'd', source: 'passed', target: 'tests', branch: 'no' },
    ];
    const created = await api('', { name: 'Failed tests', graph: g }); const def = (created.body as any).definition;
    await api(`/${def.id}/publish`, { revision: def.revision });
    const launched = await api(`/${def.id}/runs`, { requestId: generateId() }); const r = (launched.body as any).run;
    await tickAutomation(project, r.id);
    // Restore a finished agent attempt, as a new worker sees it after a restart.
    const sessions = getSessionsRepository(); const turnId = generateId();
    await sessions.createWorkflow({ id: r.session_id, project_id: project, goal: 'tests', engine: 'demo', trust_tools: 0, status: 'done', lead_agent: null, workspace_id: null, output_files_enabled: 0, repo_ids: '[]', iteration_count: 1, max_iterations: 10, credential_id: null, model: '', created_by: r.created_by, created_at: now(), updated_at: now(), kind: 'automation' });
    await sessions.createRun({ id: turnId, workflow_id: r.session_id, status: 'done', started_at: now(), finished_at: '2000-01-01T00:00:00Z', cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: now() });
    await sessions.appendRunEvent(turnId, 'check-result', JSON.stringify({ ok: false, ranAt: now(), steps: [{ step: 'Tests', ok: false, output: 'assertion failed' }] }), now());
    const current = (await state(r.id))!;
    current.attempts.push({ nodeId: 'tests', label: 'Run tests', visit: 1, status: 'running', startedAt: now(), runId: turnId }); current.visits.tests = 1;
    await (await getAutomationsRepository()).put(project, runKey(r.id), { ...current, revision: current.revision + 1 }, current.revision);
    await tickAutomation(project, r.id); assert.equal((await state(r.id))!.lastPassed, false);
    await tickAutomation(project, r.id); assert.equal((await state(r.id))!.cursor, 'tests');
    await tickAutomation(project, r.id); assert.equal((await state(r.id))!.status, 'failed'); assert.match((await state(r.id))!.error!, /visit limit/);
  });
});
