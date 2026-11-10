/**
 * Every portal-handled slash command, in a session of each engine (Kiro, Claude Code, Codex).
 *
 * A command must be answered by the portal and saved as one "command-result" event: nothing is saved as a message
 * to the agent and no run starts. The model chip in the status bar sends "/model <id>" through the same route, so
 * switching a model is checked here too.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

const ENGINES = ['kiro', 'claude-code', 'codex'] as const;

describe('slash commands in each engine', () => {
  let baseUrl = '';
  let cookie = '';
  let projectId = '';
  let planCredentialId = '';

  before(async () => {
    const s = await createTestServer();
    baseUrl = s.baseUrl;
    cookie = (await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST', body: { email: `engines-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
    })).cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Engines' }, cookie });
    projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    const made = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST', cookie, body: { engine: 'claude-code', mode: 'subscription_token', name: 'Plan', secret: 'oauth-token-abcd' },
    });
    planCredentialId = ((made.body as Record<string, unknown>).credential as Record<string, unknown>).id as string;
  });
  after(() => cleanup());

  async function session(engine: string): Promise<string> {
    const body: Record<string, unknown> = { goal: 'g', engine };
    if (engine === 'claude-code') body.credentialId = planCredentialId;
    const w = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body, cookie });
    assert.equal(w.status, 201, `${engine}: ${JSON.stringify(w.body)}`);
    return ((w.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
  }

  async function run(wfId: string, message: string): Promise<{ answer: string; status: number; body: Record<string, unknown> }> {
    const { all } = await import('../server/db.ts');
    const before = all<{ id: number }>("SELECT id FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'command-result'", wfId).length;
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}/message`, { method: 'POST', body: { message }, cookie });
    const rows = all<{ body: string }>(
      "SELECT body FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'command-result' ORDER BY id", wfId);
    return { answer: rows.length > before ? rows[rows.length - 1].body : '', status: r.status, body: r.body as Record<string, unknown> };
  }

  for (const engine of ENGINES) {
    describe(engine, () => {
      let wfId = '';
      before(async () => { wfId = await session(engine); });

      const field = async (name: string) =>
        (await import('../server/db.ts')).one<Record<string, unknown>>(`SELECT ${name} AS v FROM p6_workflows WHERE id = ?`, wfId)?.v;

      it('/help lists the portal commands', async () => {
        const r = await run(wfId, '/help');
        assert.equal(r.body.handled, true);
        for (const c of ['/model', '/status', '/cost', '/tools', '/rename', '/compact', '/clear']) assert.match(r.answer, new RegExp(c), r.answer);
      });

      it('/status names the engine', async () => {
        const r = await run(wfId, '/status');
        assert.equal(r.body.handled, true);
        assert.match(r.answer, new RegExp(`Engine: ${engine}`));
        assert.match(r.answer, /Tools: ask before use/);
      });

      it('/tools trust, /tools and /tools ask', async () => {
        assert.match((await run(wfId, '/tools trust')).answer, /trust all/);
        assert.equal(Number(await field('trust_tools')), 1);
        assert.match((await run(wfId, '/tools')).answer, /Tool mode: trust all/);
        assert.match((await run(wfId, '/tools ask')).answer, /ask before running/);
        assert.equal(Number(await field('trust_tools')), 0);
      });

      it('/cost answers without a run', async () => {
        const r = await run(wfId, '/cost');
        assert.equal(r.body.handled, true);
        assert.match(r.answer, engine === 'codex' ? /ChatGPT plan/ : /This turn: .*\nSession total:/);
      });

      it('/rename changes the title, and needs a title', async () => {
        assert.match((await run(wfId, '/rename')).answer, /Usage: \/rename/);
        assert.match((await run(wfId, `/rename ${engine} renamed`)).answer, /renamed/);
        assert.equal(await field('title'), `${engine} renamed`);
      });

      it('/model answers, and /model default clears the session model', async () => {
        const list = await run(wfId, '/model');
        assert.equal(list.body.handled, true);
        assert.ok(list.answer.length > 0, 'a model list or the reason there is none');
        const reset = await run(wfId, '/model default');
        assert.match(reset.answer, /engine default/);
        assert.equal(await field('model'), '');
      });

      it('/agent answers', async () => {
        const r = await run(wfId, '/agent');
        assert.equal(r.body.handled, true);
        assert.ok(r.answer.length > 0);
        if (engine === 'codex') assert.match(r.answer, /Codex uses its native agent instructions/);
      });

      it('/compact starts a new engine session on the next message', async () => {
        const r = await run(wfId, '/compact');
        assert.match(r.answer, /new engine session/);
        assert.equal(await field('engine_session_id'), null);
      });

      it('an unknown command is answered, not sent to the agent', async () => {
        const r = await run(wfId, '/definitely-not-a-command');
        assert.equal(r.body.handled, true);
        assert.match(r.answer, /definitely-not-a-command/);
      });

      it('/clear is accepted', async () => {
        const r = await run(wfId, '/clear');
        assert.equal(r.status, 200, JSON.stringify(r.body));
      });

      it('no command became a message to the agent, and no run started', async () => {
        const { all } = await import('../server/db.ts');
        const humans = all<{ kind: string; body: string }>(
          "SELECT kind, body FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'human' AND body LIKE '/%'", wfId);
        assert.deepEqual(humans, []);
        const runs = all<{ id: string }>('SELECT id FROM p6_runs WHERE workflow_id = ?', wfId);
        assert.deepEqual(runs, []);
      });
    });
  }

  it('the model chip: choosing a model sends "/model <id>", which switches it and can be undone with default', async () => {
    const wfId = await session('claude-code');
    const { one } = await import('../server/db.ts');
    const model = () => one<{ model: string }>('SELECT model FROM p6_workflows WHERE id = ?', wfId)?.model;
    const listed = await fetchJson(baseUrl, `/api/engines/claude-code/models?credentialId=${encodeURIComponent(planCredentialId)}`, { cookie });
    const models = ((listed.body as Record<string, unknown>).models ?? []) as Array<{ id: string }>;
    assert.ok(models.length > 0, 'the picker has models to offer');
    for (const m of models.slice(0, 3)) {
      const r = await run(wfId, `/model ${m.id}`);
      assert.equal(r.body.handled, true);
      assert.match(r.answer, /Model switched to/, `${m.id}: ${r.answer}`);
      assert.equal(model(), m.id);
    }
    const bar = async () => ((await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}/status-bar`, { cookie })).body as { model: string | null }).model;
    assert.equal(await bar(), models[2].id, 'the status bar shows the new model before any run');
    await run(wfId, '/model default');
    assert.equal(model(), '');
    assert.equal(await bar(), null, 'no model of its own and no run yet');
  });
});
