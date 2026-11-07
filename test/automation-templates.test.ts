/**
 * Workflow templates: every one is a valid, publishable graph, renders its inputs, and can be created through the API.
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { parseGraph } from '../server/automations/schema.ts';
import { automationTemplates } from '../server/automations/templates.ts';
import { renderInstructions, stopLocalAutomationTimers } from '../server/automations/engine.ts';

describe('workflow templates', () => {
  const templates = automationTemplates();

  it('offers SDLC first, then development and testing', () => {
    assert.deepEqual(templates.map((t) => t.id), ['sdlc', 'development', 'testing']);
    for (const t of templates) assert.ok(t.name && t.description, `${t.id} has a name and a description`);
  });

  for (const t of templates) {
    it(`${t.id}: publishes as is, every agent step has instructions, and {{input}} renders`, () => {
      const g = parseGraph(t.graph, true);
      for (const n of g.nodes.filter((x) => x.kind === 'agent')) {
        assert.ok(n.prompt.trim(), `${n.label} has instructions`);
        assert.doesNotThrow(() => renderInstructions(n.prompt.replace(/\{\{\s*steps\.[^}]*\}\}/g, ''), 'ABC-123', []), n.label);
      }
    });
  }

  it('development follows the ticket-to-QA order and loops review fixes back to review', () => {
    const g = parseGraph(templates.find((t) => t.id === 'development')!.graph, true);
    const next = (from: string, branch = 'next') => g.edges.find((e) => e.source === from && e.branch === branch)?.target;
    const order = ['start', 'ticket', 'design', 'code', 'approve_deploy', 'deploy', 'pr', 'review', 'review_ok'];
    for (let i = 0; i < order.length - 1; i++) assert.equal(next(order[i]), order[i + 1], `${order[i]} -> ${order[i + 1]}`);
    assert.equal(next('review_ok', 'yes'), 'jira');
    assert.equal(next('review_ok', 'no'), 'fixes');
    assert.equal(next('fixes'), 'review');
    assert.equal(next('jira'), 'end');
    assert.equal(g.nodes.find((n) => n.id === 'approve_deploy')?.kind, 'approval', 'a person approves the deploy to dev');
    // The review verdict is what the Yes/No decision reads.
    assert.match(g.nodes.find((n) => n.id === 'review')!.checks[0].cmd, /VERDICT: APPROVED/);
    // Reading the ticket, deploying and the QA comment are in the instructions.
    const prompt = (id: string) => g.nodes.find((n) => n.id === id)!.prompt;
    assert.match(prompt('ticket'), /attachment/);
    assert.match(prompt('design'), /reusable/);
    assert.match(prompt('deploy'), /without the CI\/CD pipeline/);
    assert.match(prompt('deploy'), /Never deploy to staging or production/);
    assert.match(prompt('jira'), /step-by-step test instructions/);
  });

  it('testing reads the ticket, tests the fix and edge cases, and reports failures, screenshots and links on the ticket', () => {
    const g = parseGraph(templates.find((t) => t.id === 'testing')!.graph, true);
    assert.deepEqual(g.nodes.map((n) => n.id), ['start', 'ticket', 'functional', 'edge', 'report', 'jira', 'end']);
    const prompt = (id: string) => g.nodes.find((n) => n.id === id)!.prompt;
    assert.match(prompt('edge'), /NOT COVERED/);
    assert.match(prompt('functional'), /screenshots/);
    assert.match(prompt('jira'), /failed or not-covered/);
    assert.match(prompt('jira'), /frontend links/);
  });
});

describe('workflow templates through the API', () => {
  let baseUrl = ''; let cookie = ''; let projectId = '';
  before(async () => {
    ({ baseUrl } = await createTestServer());
    const setup = await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'tpl@example.com', name: 'Admin', password: 'password1234', provider: 'demo' } });
    cookie = setup.cookie!;
    projectId = ((await fetchJson(baseUrl, '/api/projects', { cookie, body: { name: 'Templates' } })).body as { project: { id: string } }).project.id;
  });
  after(async () => { stopLocalAutomationTimers(); await cleanup(); });

  it('lists the templates and creates a workflow from the chosen one', async () => {
    const list = await fetchJson(baseUrl, `/api/projects/${projectId}/automations`, { cookie });
    const ids = ((list.body as { templates: Array<{ id: string }> }).templates).map((t) => t.id);
    assert.deepEqual(ids, ['sdlc', 'development', 'testing']);

    const made = await fetchJson(baseUrl, `/api/projects/${projectId}/automations`, { cookie, body: { name: 'Dev flow', templateId: 'development' } });
    assert.equal(made.status, 201);
    const graph = (made.body as { definition: { graph: { nodes: Array<{ id: string }> } } }).definition.graph;
    assert.ok(graph.nodes.some((n) => n.id === 'approve_deploy'));

    const plain = await fetchJson(baseUrl, `/api/projects/${projectId}/automations`, { cookie, body: { name: 'Default' } });
    assert.equal((plain.body as { definition: { graph: { nodes: unknown[] } } }).definition.graph.nodes.length, 10, 'no template still gives the SDLC workflow');
  });

  it('refuses an unknown template', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/automations`, { cookie, body: { name: 'x', templateId: 'nope' } });
    assert.equal(r.status, 400);
  });
});
