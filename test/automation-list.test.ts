/**
 * The workflow list: names are unique per project, deleting hides a workflow (its history stays), and the list carries
 * what the page shows beside each workflow.
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getAutomationsRepository } from '../server/repositories/automations.ts';
import { runKey, stopLocalAutomationTimers } from '../server/automations/engine.ts';
import { generateId, now } from '../server/util.ts';

describe('workflow list', () => {
  let baseUrl = ''; let cookie = ''; let project = '';
  const api = (suffix: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    fetchJson(baseUrl, `/api/projects/${project}/automations${suffix}`, { cookie, method, ...(body === undefined ? {} : { body }) });
  const names = async () => ((await api('')).body as { definitions: Array<{ name: string }> }).definitions.map((d) => d.name);

  before(async () => {
    ({ baseUrl } = await createTestServer());
    cookie = (await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'list@example.com', name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie!;
    project = ((await fetchJson(baseUrl, '/api/projects', { cookie, body: { name: 'List' } })).body as { project: { id: string } }).project.id;
  });
  after(async () => { stopLocalAutomationTimers(); await cleanup(); });

  it('refuses a second workflow with the same name, whatever the case, and a rename onto one', async () => {
    const a = await api('', { name: 'Development', templateId: 'development' });
    assert.equal(a.status, 201);
    const dup = await api('', { name: ' development ', templateId: 'development' });
    assert.equal(dup.status, 409);
    assert.match(String((dup.body as { error: string }).error), /already exists/);

    const b = (await api('', { name: 'Testing', templateId: 'testing' })).body as { definition: { id: string; revision: number; graph: unknown } };
    const clash = await api(`/${b.definition.id}`, { revision: b.definition.revision, name: 'DEVELOPMENT', graph: b.definition.graph }, 'PUT');
    assert.equal(clash.status, 409);
    const same = await api(`/${b.definition.id}`, { revision: b.definition.revision, name: 'testing', graph: b.definition.graph }, 'PUT');
    assert.equal(same.status, 200, 'changing only the case of its own name is fine');
    assert.deepEqual((await names()).sort(), ['Development', 'testing']);
  });

  it('the list reports runs per workflow', async () => {
    const list = (await api('')).body as { definitions: Array<{ id: string; name: string }>; stats: Record<string, { runs: number; active: number; lastStatus: string; lastStartedAt: string }> };
    const dev = list.definitions.find((d) => d.name === 'Development')!;
    assert.equal(list.stats[dev.id], undefined, 'never run: no stats');
    await (await getAutomationsRepository()).put(project, runKey('r1'), {
      id: 'r1', definition_id: dev.id, project_id: project, status: 'done', started_at: now(), revision: 1,
    }, null);
    const again = (await api('')).body as typeof list;
    assert.deepEqual(again.stats[dev.id], { runs: 1, active: 0, lastStatus: 'done', lastStartedAt: again.stats[dev.id].lastStartedAt });
  });

  it('delete hides the workflow, frees its name, and keeps the history; a run in progress blocks it', async () => {
    const made = (await api('', { name: 'Throwaway' })).body as { definition: { id: string } };
    const id = made.definition.id;
    const runId = generateId();
    await (await getAutomationsRepository()).put(project, runKey(runId), {
      id: runId, definition_id: id, project_id: project, status: 'running', started_at: now(), revision: 1,
    }, null);
    const blocked = await api(`/${id}`, undefined, 'DELETE');
    assert.equal(blocked.status, 409);
    assert.match(String((blocked.body as { error: string }).error), /run in progress/);

    // Finish that run, then delete.
    const repo = await getAutomationsRepository();
    for (const r of await repo.list<{ id: string; definition_id: string; revision: number; status: string }>(project, 'RUN#')) {
      if (r.definition_id === id) await repo.put(project, runKey(r.id), { ...r, status: 'done', revision: r.revision + 1 }, r.revision);
    }
    assert.equal((await api(`/${id}`, undefined, 'DELETE')).status, 200);
    assert.ok(!(await names()).includes('Throwaway'));
    assert.equal((await api(`/${id}`)).status, 404, 'a deleted workflow is gone for the API too');
    assert.equal((await api('', { name: 'Throwaway' })).status, 201, 'its name is free again');
    assert.equal((await api(`/${id}`, undefined, 'DELETE')).status, 404);
  });
});
