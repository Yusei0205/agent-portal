/**
 * Portal-handled slash commands (/tools, /rename, /cost, /status, /help) in an engine session:
 * they change the session or answer from saved data, and nothing is sent to the engine.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

describe('slash commands', () => {
  let baseUrl = '';
  let cookie = '';
  let projectId = '';
  let wfId = '';

  before(async () => {
    const s = await createTestServer();
    baseUrl = s.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: `admin-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Slash' }, cookie });
    projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    const w = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST', body: { goal: 'g', engine: 'kiro' }, cookie,
    });
    wfId = ((w.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
  });

  after(() => cleanup());

  const send = (message: string) =>
    fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}/message`, { method: 'POST', body: { message }, cookie });

  async function lastCommandResult(): Promise<string> {
    const { all } = await import('../server/db.ts');
    const rows = all<{ body: string }>(
      "SELECT body FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'command-result' ORDER BY id DESC LIMIT 1", wfId);
    return rows[0]?.body ?? '';
  }

  it('lists the commands for the chat menu', async () => {
    const r = await fetchJson(baseUrl, '/api/slash-commands', { cookie });
    assert.equal(r.status, 200);
    const names = ((r.body as { commands: Array<{ name: string }> }).commands).map((c) => c.name);
    for (const n of ['help', 'model', 'agent', 'cost', 'tools', 'rename']) assert.ok(names.includes(n), n);
  });

  it('/tools trust and /tools ask change the tool mode', async () => {
    const { one } = await import('../server/db.ts');
    const r = await send('/tools trust');
    assert.equal((r.body as Record<string, unknown>).handled, true);
    assert.equal(one<{ trust_tools: number }>('SELECT trust_tools FROM p6_workflows WHERE id = ?', wfId)?.trust_tools, 1);
    await send('/tools ask');
    assert.equal(one<{ trust_tools: number }>('SELECT trust_tools FROM p6_workflows WHERE id = ?', wfId)?.trust_tools, 0);
  });

  it('/rename changes the title, and the answer is saved with the command', async () => {
    const { one } = await import('../server/db.ts');
    await send('/rename Better title');
    assert.equal(one<{ title: string }>('SELECT title FROM p6_workflows WHERE id = ?', wfId)?.title, 'Better title');
    assert.match(await lastCommandResult(), /^\/rename Better title\n---\nSession renamed/);
  });

  it('/cost and /status answer without starting a run', async () => {
    const { all } = await import('../server/db.ts');
    assert.equal(((await send('/cost')).body as Record<string, unknown>).handled, true);
    assert.match(await lastCommandResult(), /Session total/);
    await send('/status');
    assert.match(await lastCommandResult(), /Engine: kiro/);
    assert.equal(all('SELECT id FROM p6_runs WHERE workflow_id = ?', wfId).length, 0);
  });

  it('an unknown command is not handled by the portal', async () => {
    const r = await send('/something-else');
    assert.notEqual((r.body as Record<string, unknown>).handled, true);
  });
});
