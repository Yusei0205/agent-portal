/**
 * Run options: what the person picks when starting a run (agent, model, trusting tools, integrations) is checked,
 * stored on the run, and applied to the session the workflow's agent steps run in.
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { sdlcTemplate, type AutomationGraph } from '../server/automations/schema.ts';
import { getAutomationsRepository } from '../server/repositories/automations.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { generateId } from '../server/util.ts';
import { tickAutomation, runKey, setAutomationSchedulerForTests, stopLocalAutomationTimers, type AutomationRun } from '../server/automations/engine.ts';

function agentGraph(): AutomationGraph {
  const g = sdlcTemplate(); g.engine = 'demo';
  g.nodes = g.nodes.filter((n) => ['start', 'design', 'end'].includes(n.id)).map((n) => n.id === 'design' ? { ...n, agent: 'step-agent', model: 'step-model', prompt: 'Describe the plan' } : n);
  g.edges = [{ id: 'a', source: 'start', target: 'design', branch: 'next' }, { id: 'b', source: 'design', target: 'end', branch: 'next' }];
  return g;
}

describe('workflow run options', () => {
  let base = ''; let cookie = ''; let project = ''; let defId = ''; let revision = 0;
  const api = (path: string, body?: unknown, method?: string, c = cookie, headers?: Record<string, string>) =>
    fetchJson(base, `/api/projects/${project}/automations${path}`, { cookie: c, body, method, headers });
  const state = async (id: string) => (await getAutomationsRepository()).get<AutomationRun>(project, runKey(id));
  const start = (options?: unknown, extra: { c?: string; headers?: Record<string, string> } = {}) =>
    api(`/${defId}/runs`, { requestId: generateId(), input: 'x', ...(options === undefined ? {} : { options }) }, undefined, extra.c ?? cookie, extra.headers);

  before(async () => {
    setAutomationSchedulerForTests(async () => {});
    ({ baseUrl: base } = await createTestServer());
    cookie = (await fetchJson(base, '/api/auth/setup', { method: 'POST', body: { email: 'opts@example.com', name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie!;
    project = ((await fetchJson(base, '/api/projects', { cookie, method: 'POST', body: { name: 'Options' } })).body as { project: { id: string } }).project.id;
    const made = (await api('', { name: 'With agent', graph: agentGraph() })).body as { definition: { id: string; revision: number } };
    defId = made.definition.id; revision = made.definition.revision;
    await api(`/${defId}/publish`, { revision });
  });
  after(async () => { stopLocalAutomationTimers(); setAutomationSchedulerForTests(null); await cleanup(); });

  it('without options the run follows the workflow: its agent and model, tools ask first', async () => {
    const r = (await start()).body as { run: AutomationRun };
    assert.deepEqual(r.run.options, { agent: '', model: '', trustTools: false, integrationIds: null });
    await tickAutomation(project, r.run.id); await tickAutomation(project, r.run.id);
    const session = (await getSessionsRepository().getWorkflowById((await state(r.run.id))!.session_id))!;
    assert.equal(session.lead_agent, 'step-agent');
    assert.equal(session.model, 'step-model');
    assert.equal(session.trust_tools, 0);
  });

  it('options override every agent step and the session is created with them', async () => {
    const r = (await start({ agent: 'reviewer', model: 'claude-test-1', trustTools: true })).body as { run: AutomationRun };
    assert.deepEqual(r.run.options, { agent: 'reviewer', model: 'claude-test-1', trustTools: true, integrationIds: null });
    await tickAutomation(project, r.run.id); await tickAutomation(project, r.run.id);
    const session = (await getSessionsRepository().getWorkflowById((await state(r.run.id))!.session_id))!;
    assert.equal(session.lead_agent, 'reviewer', 'the run\'s agent wins over the step\'s');
    assert.equal(session.model, 'claude-test-1');
    assert.equal(session.trust_tools, 1);
  });

  it('refuses a bad model, unknown integrations, and trusting tools through an API token', async () => {
    assert.equal((await start({ model: 'bad model!' })).status, 400);
    assert.equal((await start({ integrationIds: ['not-mine'] })).status, 400);
    assert.equal((await start({ integrationIds: [] })).status, 202, 'no integrations at all is a valid choice');

    const token = ((await fetchJson(base, '/api/api-tokens', { cookie, method: 'POST', body: { name: 'ci', scopes: ['write'] } })).body as { token: string }).token;
    const viaToken = (options: unknown) => api(`/${defId}/runs`, { requestId: generateId(), input: 'x', options }, undefined, '', { authorization: `Bearer ${token}` });
    assert.equal((await viaToken({ trustTools: true })).status, 403);
    assert.equal((await viaToken({ agent: 'reviewer' })).status, 202, 'the other options are fine for a token');
  });
});
