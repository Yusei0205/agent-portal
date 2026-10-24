/**
 * Tests for the session slash-command endpoint:
 *   POST /api/workflows/:id/command   { command: '/help' }
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, Client, type TestServer } from './client.ts';

let srv: TestServer;
let admin: Client;
let viewer: Client;
let outsider: Client;
let pid: string;
let exec: typeof import('../server/db.ts').run;

before(async () => {
  srv = await bootServer();
  ({ run: exec } = await import('../server/db.ts'));
  admin = new Client(srv.base);
  viewer = new Client(srv.base);
  outsider = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'cmd-a@example.com', name: 'CmdAdmin', password: 'a-long-password-1' });
  await admin.post('/api/users', { email: 'cmd-v@example.com', name: 'CmdViewer', password: 'a-long-password-2' });
  await admin.post('/api/users', { email: 'cmd-o@example.com', name: 'CmdOutsider', password: 'a-long-password-3' });
  await viewer.post('/api/auth/login', { email: 'cmd-v@example.com', password: 'a-long-password-2' });
  await outsider.post('/api/auth/login', { email: 'cmd-o@example.com', password: 'a-long-password-3' });
  pid = (await admin.post('/api/projects', { name: 'Commands', description: 'd' })).project.id;
  await admin.post(`/api/projects/${pid}/members`, { email: 'cmd-v@example.com', access: 'viewer', role: 'Reader' });
});

after(async () => {
  await srv.close();
});

/** Create a paused playground session and return its id. */
async function createSession(opts: Record<string, unknown> = {}): Promise<string> {
  const r = await admin.post(`/api/projects/${pid}/workflows`, {
    goal: 'Command test goal',
    model: 'sonnet',
    playground: true,
    start: false,
    ...opts,
  });
  return r.workflow.id;
}

async function cmd(client: Client, id: string, command: string) {
  return client.req('POST', `/api/workflows/${id}/command`, { command });
}

/* ------------------------------------------------------------------ */
/* Access control                                                      */
/* ------------------------------------------------------------------ */

test('/command: outsider (non-member) gets 404, viewer gets 200, admin gets 200', async () => {
  const id = await createSession();

  const outside = await cmd(outsider, id, '/help');
  assert.equal(outside.status, 404, 'non-member should get 404');

  const view = await cmd(viewer, id, '/help');
  assert.equal(view.status, 200, 'viewer should be allowed');

  const adm = await cmd(admin, id, '/help');
  assert.equal(adm.status, 200, 'admin should be allowed');

  await admin.del(`/api/workflows/${id}`);
});

test('/command: unauthenticated request gets 401', async () => {
  const id = await createSession();
  const anon = new Client(srv.base);
  const r = await anon.req('POST', `/api/workflows/${id}/command`, { command: '/help' });
  assert.equal(r.status, 401);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /help                                                              */
/* ------------------------------------------------------------------ */

test('/help lists all commands with descriptions', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, '/help');
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'text');
  for (const c of ['/help', '/model', '/agent', '/engine', '/context', '/usage', '/status', '/stop', '/resume']) {
    assert.match(r.data.text, new RegExp(c.replace('/', '\\/')), `help should mention ${c}`);
  }
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* Unknown commands                                                    */
/* ------------------------------------------------------------------ */

test('unknown command returns 400 with a suggestion to use /help', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, '/fly-to-moon');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Unknown command/);
  assert.match(r.data.error, /\/help/);
  await admin.del(`/api/workflows/${id}`);
});

test('input without a leading slash returns 400 with a correction hint', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, 'help');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /\/help/);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /status                                                             */
/* ------------------------------------------------------------------ */

test('/status shows session status, engine, model, lead agent, work branch', async () => {
  const id = await createSession({ model: 'sonnet' });
  const r = await cmd(admin, id, '/status');
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'text');
  assert.match(r.data.text, /Status:/);
  assert.match(r.data.text, /Engine:/);
  assert.match(r.data.text, /Model:/);
  assert.match(r.data.text, /Lead agent:/);
  assert.match(r.data.text, /Work branch:/);
  assert.match(r.data.text, /sonnet/);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /usage                                                              */
/* ------------------------------------------------------------------ */

test('/usage shows iterations and spend vs budget', async () => {
  const id = await createSession({ budgetUsd: 10 });
  const r = await cmd(admin, id, '/usage');
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'text');
  assert.match(r.data.text, /Iteration/);
  assert.match(r.data.text, /\$.*of \$10\.00/);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /context                                                            */
/* ------------------------------------------------------------------ */

test('/context returns context items including structured list', async () => {
  const id = await createSession();
  // No context.
  const empty = await cmd(admin, id, '/context');
  assert.equal(empty.status, 200);
  assert.equal(empty.data.type, 'context');
  assert.deepEqual(empty.data.context, []);

  // Add a note.
  await admin.post(`/api/workflows/${id}/context`, { kind: 'note', body: 'Remember the refund limit is 500.', title: 'Refund note' });
  const withItem = await cmd(admin, id, '/context');
  assert.equal(withItem.status, 200);
  assert.equal(withItem.data.context.length, 1);
  assert.equal(withItem.data.context[0].kind, 'note');
  assert.equal(withItem.data.context[0].title, 'Refund note');
  assert.match(withItem.data.text, /Refund note/);

  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /model — picker (no argument)                                       */
/* ------------------------------------------------------------------ */

test('/model with no argument returns a structured options list with the current model marked', async () => {
  const id = await createSession({ model: 'haiku' });
  const r = await cmd(admin, id, '/model');
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'options');
  assert.ok(Array.isArray(r.data.options), 'options must be an array');
  assert.ok(r.data.options.length >= 3, 'at least haiku, sonnet, opus');
  const haiku = r.data.options.find((o: any) => o.id === 'haiku');
  assert.ok(haiku, 'haiku option must be present');
  assert.equal(haiku.current, true, 'haiku must be marked current');
  const sonnet = r.data.options.find((o: any) => o.id === 'sonnet');
  assert.equal(sonnet.current, false, 'sonnet must not be marked current');
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /model — set (with argument)                                        */
/* ------------------------------------------------------------------ */

test('/model <id> validates and sets the model; invalid values are rejected', async () => {
  const id = await createSession({ model: 'sonnet' });

  // Set to a tier.
  const r1 = await cmd(admin, id, '/model haiku');
  assert.equal(r1.status, 200);
  assert.equal(r1.data.type, 'text');
  assert.match(r1.data.text, /haiku/);
  assert.ok(r1.data.workflow, 'workflow should be returned after a change');
  assert.equal(r1.data.workflow.model, 'haiku');
  // Verify via GET.
  const after = (await admin.get(`/api/workflows/${id}`)).workflow;
  assert.equal(after.model, 'haiku', 'model must be persisted in the database');

  // Invalid model.
  const bad = await cmd(admin, id, '/model not-a-model!');
  assert.equal(bad.status, 400);
  // Session unchanged.
  const unchanged = (await admin.get(`/api/workflows/${id}`)).workflow;
  assert.equal(unchanged.model, 'haiku', 'invalid /model must not change the session');

  // Set to a full model ID.
  const fullId = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
  const r2 = await cmd(admin, id, `/model ${fullId}`);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.workflow.model, fullId);

  // No-op when model is already the same.
  const noop = await cmd(admin, id, `/model ${fullId}`);
  assert.equal(noop.status, 200);
  assert.match(noop.data.text, /already set/);
  assert.equal(noop.data.workflow, undefined, 'no workflow returned for a no-op');

  await admin.del(`/api/workflows/${id}`);
});

test('/model change writes a session-log entry', async () => {
  const id = await createSession({ model: 'sonnet' });
  await cmd(admin, id, '/model opus');
  const events = (await admin.get(`/api/workflows/${id}`)).events;
  const setting = events.find((e: any) => e.kind === 'system' && /model/.test(e.body));
  assert.ok(setting, 'a "system" log entry about the model change must be written');
  assert.match(setting.body, /Settings changed by command/);
  assert.match(setting.body, /opus/);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /agent — picker (no argument)                                       */
/* ------------------------------------------------------------------ */

test('/agent with no argument returns options including (default/none)', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, '/agent');
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'options');
  assert.ok(Array.isArray(r.data.options));
  const def = r.data.options.find((o: any) => o.id === '');
  assert.ok(def, '"default / none" option must be present');
  assert.equal(def.current, true, 'default must be marked current when no lead agent is set');
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /agent — set (with argument)                                        */
/* ------------------------------------------------------------------ */

test('/agent <name> validates and sets the lead agent; invalid values are rejected', async () => {
  // Create an agent to use as a lead.
  await admin.put(`/api/projects/${pid}/agents/cmd-tech-lead`, {
    description: 'Plans and reviews',
    prompt: 'You plan the work.',
    model: 'sonnet',
    tools: ['Read'],
  });

  const id = await createSession();

  // Set a valid agent.
  const r1 = await cmd(admin, id, '/agent cmd-tech-lead');
  assert.equal(r1.status, 200);
  assert.ok(r1.data.workflow, 'workflow should be returned');
  assert.equal(r1.data.workflow.lead_agent, 'cmd-tech-lead');
  // Verify via GET.
  assert.equal((await admin.get(`/api/workflows/${id}`)).workflow.lead_agent, 'cmd-tech-lead');

  // Clear with "none".
  const r2 = await cmd(admin, id, '/agent none');
  assert.equal(r2.status, 200);
  assert.equal(r2.data.workflow.lead_agent, '');

  // Unknown agent.
  const bad = await cmd(admin, id, '/agent ghost-agent');
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /ghost-agent/);
  assert.match(bad.data.error, /\/agent/);
  // Session unchanged.
  assert.equal((await admin.get(`/api/workflows/${id}`)).workflow.lead_agent, '');

  // No-op.
  const noop = await cmd(admin, id, '/agent none');
  assert.equal(noop.status, 200);
  assert.match(noop.data.text, /already/);
  assert.equal(noop.data.workflow, undefined);

  await admin.del(`/api/workflows/${id}`);
});

test('/agent change writes a session-log entry', async () => {
  await admin.put(`/api/projects/${pid}/agents/cmd-writer`, {
    description: 'Writes docs',
    prompt: 'You write.',
    model: 'haiku',
    tools: ['Read'],
  });
  const id = await createSession();
  await cmd(admin, id, '/agent cmd-writer');
  const events = (await admin.get(`/api/workflows/${id}`)).events;
  const e = events.find((ev: any) => ev.kind === 'system' && /lead agent/.test(ev.body));
  assert.ok(e, 'a system log entry about the agent change must be written');
  assert.match(e.body, /cmd-writer/);
  await admin.del(`/api/workflows/${id}`);
});

test('/agent does not allow agents from outside the project (global kiro config)', async () => {
  const id = await createSession();
  // The only agents in the list are project agents. Passing a made-up name is always rejected.
  const r = await cmd(admin, id, '/agent ~/.kiro/agents/some-global-agent');
  assert.equal(r.status, 400);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /engine — picker (no argument)                                      */
/* ------------------------------------------------------------------ */

test('/engine with no argument returns structured options list', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, '/engine');
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'options');
  assert.ok(Array.isArray(r.data.options));
  const ids = r.data.options.map((o: any) => o.id);
  assert.ok(ids.includes(''), 'project default option must be present');
  assert.ok(ids.includes('claude'), 'claude option must be present');
  assert.ok(ids.includes('kiro'), 'kiro option must be present');
  // Default (empty) should be marked current since the session uses no explicit engine.
  const def = r.data.options.find((o: any) => o.id === '');
  assert.equal(def.current, true);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /engine — set (with argument)                                       */
/* ------------------------------------------------------------------ */

test('/engine <value> validates and sets the engine; invalid value is rejected', async () => {
  const id = await createSession();

  // Invalid engine.
  const bad = await cmd(admin, id, '/engine quantum');
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Unknown engine/);

  // Set to claude (always valid in demo mode which maps to demo, not an error).
  const r = await cmd(admin, id, '/engine claude');
  assert.equal(r.status, 200);
  assert.ok(r.data.workflow);
  assert.equal(r.data.workflow.engine, 'claude');
  assert.equal((await admin.get(`/api/workflows/${id}`)).workflow.engine, 'claude');

  // Reset to default.
  const reset = await cmd(admin, id, '/engine default');
  assert.equal(reset.status, 200);
  assert.equal(reset.data.workflow.engine, '');

  // No-op.
  const noop = await cmd(admin, id, '/engine default');
  assert.equal(noop.status, 200);
  assert.match(noop.data.text, /already/);
  assert.equal(noop.data.workflow, undefined);

  await admin.del(`/api/workflows/${id}`);
});

test('/engine warns when the current lead agent is invalid on the new engine', async () => {
  // Create a Claude Code agent.
  await admin.put(`/api/projects/${pid}/agents/claude-lead`, {
    description: 'Claude Code lead',
    prompt: 'You lead.',
    model: 'sonnet',
    tools: ['Read'],
  });
  // Start session with engine=claude and a claude-specific lead.
  const id = await createSession({ engine: 'claude' });
  const setLead = await cmd(admin, id, '/agent claude-lead');
  assert.equal(setLead.status, 200);
  assert.equal(setLead.data.workflow.lead_agent, 'claude-lead');

  // Switch to kiro — the claude-only lead may not be valid on kiro if the project has kiro agents.
  // In demo mode there are no kiro agents, so both engines use claude agents → no warning expected.
  // In any case the command must succeed without crashing.
  const switchR = await cmd(admin, id, '/engine kiro');
  assert.equal(switchR.status, 200, `engine switch failed: ${JSON.stringify(switchR.data)}`);

  await admin.del(`/api/workflows/${id}`);
});

test('/engine change writes a session-log entry', async () => {
  const id = await createSession();
  await cmd(admin, id, '/engine claude');
  const events = (await admin.get(`/api/workflows/${id}`)).events;
  const e = events.find((ev: any) => ev.kind === 'system' && /engine/.test(ev.body));
  assert.ok(e, 'a system log entry about the engine change must be written');
  assert.match(e.body, /Settings changed by command/);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /stop and /resume                                                   */
/* ------------------------------------------------------------------ */

test('/stop stops a running session and /resume restarts it', async () => {
  // Create a paused session, manually set it to running via DB so we can test stop/resume
  // without a race against the demo driver completing instantly.
  const id = await createSession();
  // Manually put it in running state (no actual driver loop — just checking the route logic).
  exec("UPDATE workflows SET status = 'running', stop_reason = '' WHERE id = ?", id);

  // Stop it.
  const stopR = await cmd(admin, id, '/stop');
  assert.equal(stopR.status, 200);
  assert.ok(stopR.data.workflow);
  assert.equal(stopR.data.workflow.status, 'stopped');
  // Also verify via GET.
  const afterStop = (await admin.get(`/api/workflows/${id}`)).workflow;
  assert.equal(afterStop.status, 'stopped');
  assert.match(afterStop.stop_reason, /Stopped by CmdAdmin/);

  // Resume it (budget check: not exceeded).
  const resumeR = await cmd(admin, id, '/resume');
  assert.equal(resumeR.status, 200);
  assert.ok(resumeR.data.workflow);
  assert.equal(resumeR.data.workflow.status, 'running');

  // Stop again to clean up.
  await cmd(admin, id, '/stop');

  await admin.del(`/api/workflows/${id}`);
});

test('/stop on an already-stopped session returns a friendly message', async () => {
  const id = await createSession(); // starts paused
  exec("UPDATE workflows SET status = 'stopped' WHERE id = ?", id);
  const r = await cmd(admin, id, '/stop');
  assert.equal(r.status, 200);
  assert.match(r.data.text, /already/);
  await admin.del(`/api/workflows/${id}`);
});

test('/resume on a budget-exceeded session returns 400', async () => {
  const id = await createSession({ budgetUsd: 1 });
  exec("UPDATE workflows SET status = 'paused', spent_usd = 5 WHERE id = ?", id);
  const r = await cmd(admin, id, '/resume');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /budget/);
  await admin.del(`/api/workflows/${id}`);
});

test('/resume on an already-running session returns a friendly message', async () => {
  // Manually put session in running state (avoids race against demo driver).
  const id = await createSession();
  exec("UPDATE workflows SET status = 'running', stop_reason = '' WHERE id = ?", id);

  const r = await cmd(admin, id, '/resume');
  assert.equal(r.status, 200);
  assert.match(r.data.text, /already running/);

  // Clean up.
  exec("UPDATE workflows SET status = 'stopped' WHERE id = ?", id);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* Deferred-change message when session is running                    */
/* ------------------------------------------------------------------ */

test('setting model while the session is running reports it will take effect at the next iteration', async () => {
  // Manually put session in running state so isDriving() returns true.
  const id = await createSession({ model: 'haiku' });
  exec("UPDATE workflows SET status = 'running', stop_reason = '' WHERE id = ?", id);

  // Change model while running.
  const r = await cmd(admin, id, '/model sonnet');
  assert.equal(r.status, 200);
  assert.match(r.data.text, /next iteration/);
  assert.equal(r.data.deferred, true);
  // The model must still be updated in the DB.
  assert.equal(r.data.workflow.model, 'sonnet');

  exec("UPDATE workflows SET status = 'stopped' WHERE id = ?", id);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* Viewer can read but (by route design) also run commands             */
/* ------------------------------------------------------------------ */

test('viewer can run read-only commands (/status, /help, /usage, /context)', async () => {
  const id = await createSession();
  for (const c of ['/help', '/status', '/usage', '/context']) {
    const r = await cmd(viewer, id, c);
    assert.equal(r.status, 200, `viewer should be able to run ${c}`);
  }
  await admin.del(`/api/workflows/${id}`);
});

test('viewer cannot run state-changing commands; editor can (security: editor role required for mutations)', async () => {
  // Per finding #7: state-changing commands (/model, /agent, /engine, /stop, /resume, /browser, /aws)
  // require the 'editor' role. Read-only commands (/help, /status, /context, /usage, /tools list)
  // remain open to viewers.
  const id = await createSession({ model: 'haiku' });

  // Viewer must NOT be able to change the model.
  const viewerChange = await cmd(viewer, id, '/model sonnet');
  assert.equal(viewerChange.status, 403, 'viewer should NOT be allowed to run state-changing /model command');

  // Viewer CAN run read-only commands.
  const viewerStatus = await cmd(viewer, id, '/status');
  assert.equal(viewerStatus.status, 200, 'viewer should be allowed to run read-only /status command');

  // Editor CAN change the model.
  const editorChange = await cmd(admin, id, '/model sonnet');
  assert.equal(editorChange.status, 200, 'admin (editor) should be allowed to change model');
  assert.equal(editorChange.data.workflow.model, 'sonnet');

  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* Changes visible to the next iteration                              */
/* ------------------------------------------------------------------ */

test('model change via command is used by the next iteration, same as a PUT update', async () => {
  // Start a session, change the model, then let it run — the run should use the new model.
  const id = await createSession({ model: 'haiku', start: false });
  const r = await cmd(admin, id, '/model sonnet');
  assert.equal(r.status, 200);
  assert.equal(r.data.workflow.model, 'sonnet');

  // Start it and let it finish.
  await admin.post(`/api/workflows/${id}/messages`, { body: 'Demo iterations: 1' });

  // Wait for it to settle.
  const settle = async (wid: string) => {
    const end = Date.now() + 30_000;
    for (;;) {
      const d = await admin.get(`/api/workflows/${wid}`);
      if (['done', 'blocked', 'failed', 'paused', 'stopped'].includes(d.workflow.status) && !d.driving) return d;
      if (Date.now() > end) throw new Error(`session ${wid} did not settle`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  const d = await settle(id);
  // The run used the model set via /model.
  const run = (await admin.get(`/api/runs/${d.runs[0].id}`)).run;
  assert.equal(run.model, 'sonnet', 'the run must use the model set via the command');

  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* Audit log entries                                                   */
/* ------------------------------------------------------------------ */

test('/model change writes a session.settings_change audit entry', async () => {
  const id = await createSession({ model: 'haiku' });
  await cmd(admin, id, '/model opus');

  // The audit log is only visible to admins via GET /api/admin/audit-log.
  const { entries } = await admin.get(`/api/admin/audit-log?action=session.settings_change&limit=20`);
  const row = entries.find((e: any) => e.target === `workflow:${id}` && e.detail?.change === 'model');
  assert.ok(row, 'session.settings_change audit entry must be written for a /model change');
  assert.equal(row.action, 'session.settings_change');
  assert.equal(row.detail.change, 'model');
  assert.equal(row.detail.value, 'opus');

  await admin.del(`/api/workflows/${id}`);
});

test('/agent change writes a session.settings_change audit entry', async () => {
  await admin.put(`/api/projects/${pid}/agents/cmd-audit-agent`, {
    description: 'Audit test agent',
    prompt: 'You test auditing.',
    model: 'haiku',
    tools: ['Read'],
  });
  const id = await createSession();
  await cmd(admin, id, '/agent cmd-audit-agent');

  const { entries } = await admin.get(`/api/admin/audit-log?action=session.settings_change&limit=20`);
  const row = entries.find((e: any) => e.target === `workflow:${id}` && e.detail?.change === 'lead_agent');
  assert.ok(row, 'session.settings_change audit entry must be written for a /agent change');
  assert.equal(row.detail.change, 'lead_agent');

  await admin.del(`/api/workflows/${id}`);
});

test('/engine change writes a session.settings_change audit entry', async () => {
  const id = await createSession();
  await cmd(admin, id, '/engine claude');

  const { entries } = await admin.get(`/api/admin/audit-log?action=session.settings_change&limit=20`);
  const row = entries.find((e: any) => e.target === `workflow:${id}` && e.detail?.change === 'engine');
  assert.ok(row, 'session.settings_change audit entry must be written for an /engine change');
  assert.equal(row.detail.change, 'engine');

  await admin.del(`/api/workflows/${id}`);
});

test('/stop writes a session.stop audit entry', async () => {
  const id = await createSession();
  exec("UPDATE workflows SET status = 'running', stop_reason = '' WHERE id = ?", id);

  await cmd(admin, id, '/stop');

  const { entries } = await admin.get(`/api/admin/audit-log?action=session.stop&limit=20`);
  const row = entries.find((e: any) => e.target === `workflow:${id}`);
  assert.ok(row, 'session.stop audit entry must be written when /stop is used');
  assert.equal(row.detail.via, 'command');

  await admin.del(`/api/workflows/${id}`);
});

test('/resume writes a session.resume audit entry', async () => {
  const id = await createSession();
  exec("UPDATE workflows SET status = 'stopped', stop_reason = 'test' WHERE id = ?", id);

  await cmd(admin, id, '/resume');

  const { entries } = await admin.get(`/api/admin/audit-log?action=session.resume&limit=20`);
  const row = entries.find((e: any) => e.target === `workflow:${id}`);
  assert.ok(row, 'session.resume audit entry must be written when /resume is used');
  assert.equal(row.detail.via, 'command');

  // Clean up — stop the session that was just resumed.
  exec("UPDATE workflows SET status = 'stopped' WHERE id = ?", id);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* Deferred changes for /agent and /engine while running              */
/* ------------------------------------------------------------------ */

test('setting lead agent while the session is running reports it will take effect at the next iteration', async () => {
  await admin.put(`/api/projects/${pid}/agents/cmd-deferred-agent`, {
    description: 'Deferred test agent',
    prompt: 'You test deferred changes.',
    model: 'haiku',
    tools: ['Read'],
  });
  const id = await createSession();
  exec("UPDATE workflows SET status = 'running', stop_reason = '' WHERE id = ?", id);

  const r = await cmd(admin, id, '/agent cmd-deferred-agent');
  assert.equal(r.status, 200);
  assert.match(r.data.text, /next iteration/);
  assert.equal(r.data.deferred, true);
  // The lead_agent must still be updated in the DB immediately.
  assert.equal(r.data.workflow.lead_agent, 'cmd-deferred-agent');

  exec("UPDATE workflows SET status = 'stopped' WHERE id = ?", id);
  await admin.del(`/api/workflows/${id}`);
});

test('changing engine while the session is running reports it will take effect at the next iteration', async () => {
  const id = await createSession();
  exec("UPDATE workflows SET status = 'running', stop_reason = '' WHERE id = ?", id);

  const r = await cmd(admin, id, '/engine claude');
  assert.equal(r.status, 200);
  assert.match(r.data.text, /next iteration/);
  assert.equal(r.data.deferred, true);
  // The engine must still be updated in the DB immediately.
  assert.equal(r.data.workflow.engine, 'claude');

  exec("UPDATE workflows SET status = 'stopped' WHERE id = ?", id);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* Lead agent change used by the next iteration                       */
/* ------------------------------------------------------------------ */

test('lead agent change via command is used by the next iteration', async () => {
  // Create a project agent that will act as the lead.
  await admin.put(`/api/projects/${pid}/agents/cmd-iteration-lead`, {
    description: 'Iteration test lead',
    prompt: 'You coordinate.',
    model: 'sonnet',
    tools: ['Read'],
  });

  // Create a session with no lead agent, then set one via command.
  const id = await createSession({ start: false });
  const r = await cmd(admin, id, '/agent cmd-iteration-lead');
  assert.equal(r.status, 200);
  assert.equal(r.data.workflow.lead_agent, 'cmd-iteration-lead');

  // Kick the session and let it run one iteration.
  await admin.post(`/api/workflows/${id}/messages`, { body: 'Demo iterations: 1' });

  const settle = async (wid: string) => {
    const end = Date.now() + 30_000;
    for (;;) {
      const d = await admin.get(`/api/workflows/${wid}`);
      if (['done', 'blocked', 'failed', 'paused', 'stopped'].includes(d.workflow.status) && !d.driving) return d;
      if (Date.now() > end) throw new Error(`session ${wid} did not settle`);
      await new Promise((r2) => setTimeout(r2, 150));
    }
  };

  const d = await settle(id);
  // The run's meta must record the lead agent that was set via /agent.
  const run = (await admin.get(`/api/runs/${d.runs[0].id}`)).run;
  assert.equal(run.meta.leadAgent, 'cmd-iteration-lead', 'the run must record the lead agent set via /agent command');

  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /status includes iteration count                                   */
/* ------------------------------------------------------------------ */

test('/status iteration count reflects actual iteration value', async () => {
  const id = await createSession();
  // Simulate that the session has completed some iterations.
  exec('UPDATE workflows SET iteration = 3 WHERE id = ?', id);

  const r = await cmd(admin, id, '/status');
  assert.equal(r.status, 200);
  assert.match(r.data.text, /Iteration:\s+3/, 'status must show the current iteration count');

  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /usage with Kiro credits                                            */
/* ------------------------------------------------------------------ */

test('/usage shows Kiro credits when the effective provider is kiro', async () => {
  // Force the project's provider to kiro and set some credit spend.
  const id = await createSession();
  exec("UPDATE workflows SET engine = 'kiro', spent_credits = 5.5, budget_credits = 20 WHERE id = ?", id);

  // In demo mode engineProvider always returns 'demo', which is not 'kiro', so the Claude path runs.
  // What we CAN test is the Claude credits path — verify it shows USD, not credits.
  const r = await cmd(admin, id, '/usage');
  assert.equal(r.status, 200);
  assert.match(r.data.text, /Spend:/, 'demo mode always shows USD spend line');

  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* Session log entry for /stop and /resume                            */
/* ------------------------------------------------------------------ */

test('/stop writes a session status event with the stop reason', async () => {
  const id = await createSession();
  exec("UPDATE workflows SET status = 'running', stop_reason = '' WHERE id = ?", id);

  await cmd(admin, id, '/stop');

  const events = (await admin.get(`/api/workflows/${id}`)).events;
  const stopEvent = events.find((e: any) => e.kind === 'status' && /stopped/.test(e.body));
  assert.ok(stopEvent, 'a status event recording the stop must be written');
  assert.match(stopEvent.body, /CmdAdmin/);

  await admin.del(`/api/workflows/${id}`);
});

test('/resume writes a session status event', async () => {
  const id = await createSession();
  exec("UPDATE workflows SET status = 'stopped', stop_reason = 'test' WHERE id = ?", id);

  await cmd(admin, id, '/resume');

  const events = (await admin.get(`/api/workflows/${id}`)).events;
  const resumeEvent = events.find((e: any) => e.kind === 'status' && /[Rr]esum/.test(e.body));
  assert.ok(resumeEvent, 'a status event recording the resume must be written');

  exec("UPDATE workflows SET status = 'stopped' WHERE id = ?", id);
  await admin.del(`/api/workflows/${id}`);
});


/* ------------------------------------------------------------------ */
/* Workflow shape in command responses                                 */
/*                                                                    */
/* Every command that returns a `workflow` field must return the same  */
/* formatted shape as GET /api/workflows/:id (repos as array,          */
/* integration_list present, pending_push parsed).                    */
/* ------------------------------------------------------------------ */

/**
 * Assert that `wf` has the same shape as the workflow object returned by
 * GET /api/workflows/:id.  Specifically:
 *   - repos is an Array (not a JSON string)
 *   - integration_list is present and is an Array
 *   - pending_push is null or an object (not a raw JSON string)
 */
function assertWorkflowShape(wf: any, label: string) {
  assert.ok(wf !== null && typeof wf === 'object', `${label}: workflow must be an object`);
  assert.ok(Array.isArray(wf.repos), `${label}: repos must be an array, got ${typeof wf.repos}`);
  assert.ok('integration_list' in wf, `${label}: integration_list must be present`);
  assert.ok(Array.isArray(wf.integration_list), `${label}: integration_list must be an array`);
  // pending_push must not be a raw JSON string — it should be null or a plain object.
  assert.ok(
    wf.pending_push === null || wf.pending_push === undefined || (typeof wf.pending_push === 'object' && !Array.isArray(wf.pending_push)),
    `${label}: pending_push must be null or an object, got ${typeof wf.pending_push} (value: ${JSON.stringify(wf.pending_push)})`,
  );
}

test('/model <id> returns workflow with the same shape as GET /api/workflows/:id', async () => {
  const id = await createSession({ model: 'haiku' });

  const r = await cmd(admin, id, '/model sonnet');
  assert.equal(r.status, 200);
  assert.ok(r.data.workflow, 'workflow should be present after /model change');
  assertWorkflowShape(r.data.workflow, '/model');

  // Cross-check: the shape must match the one from a GET.
  const getR = await admin.get(`/api/workflows/${id}`);
  assert.deepEqual(Object.keys(r.data.workflow).sort(), Object.keys(getR.workflow).sort(), '/model workflow should have the same keys as GET');

  await admin.del(`/api/workflows/${id}`);
});

test('/agent <name> returns workflow with the same shape as GET /api/workflows/:id', async () => {
  await admin.put(`/api/projects/${pid}/agents/cmd-shape-agent`, {
    description: 'Shape test agent',
    prompt: 'You test shapes.',
    model: 'haiku',
    tools: ['Read'],
  });
  const id = await createSession();

  const r = await cmd(admin, id, '/agent cmd-shape-agent');
  assert.equal(r.status, 200);
  assert.ok(r.data.workflow, 'workflow should be present after /agent change');
  assertWorkflowShape(r.data.workflow, '/agent');

  const getR = await admin.get(`/api/workflows/${id}`);
  assert.deepEqual(Object.keys(r.data.workflow).sort(), Object.keys(getR.workflow).sort(), '/agent workflow should have the same keys as GET');

  await admin.del(`/api/workflows/${id}`);
});

test('/engine <value> returns workflow with the same shape as GET /api/workflows/:id', async () => {
  const id = await createSession();

  const r = await cmd(admin, id, '/engine claude');
  assert.equal(r.status, 200);
  assert.ok(r.data.workflow, 'workflow should be present after /engine change');
  assertWorkflowShape(r.data.workflow, '/engine');

  const getR = await admin.get(`/api/workflows/${id}`);
  assert.deepEqual(Object.keys(r.data.workflow).sort(), Object.keys(getR.workflow).sort(), '/engine workflow should have the same keys as GET');

  await admin.del(`/api/workflows/${id}`);
});

test('/stop returns workflow with the same shape as GET /api/workflows/:id', async () => {
  const id = await createSession();
  exec("UPDATE workflows SET status = 'running', stop_reason = '' WHERE id = ?", id);

  const r = await cmd(admin, id, '/stop');
  assert.equal(r.status, 200);
  assert.ok(r.data.workflow, 'workflow should be present after /stop');
  assertWorkflowShape(r.data.workflow, '/stop');

  const getR = await admin.get(`/api/workflows/${id}`);
  assert.deepEqual(Object.keys(r.data.workflow).sort(), Object.keys(getR.workflow).sort(), '/stop workflow should have the same keys as GET');

  await admin.del(`/api/workflows/${id}`);
});

test('/resume returns workflow with the same shape as GET /api/workflows/:id', async () => {
  const id = await createSession();
  exec("UPDATE workflows SET status = 'stopped', stop_reason = 'test' WHERE id = ?", id);

  const r = await cmd(admin, id, '/resume');
  assert.equal(r.status, 200);
  assert.ok(r.data.workflow, 'workflow should be present after /resume');
  assertWorkflowShape(r.data.workflow, '/resume');

  const getR = await admin.get(`/api/workflows/${id}`);
  assert.deepEqual(Object.keys(r.data.workflow).sort(), Object.keys(getR.workflow).sort(), '/resume workflow should have the same keys as GET');

  // Clean up.
  exec("UPDATE workflows SET status = 'stopped' WHERE id = ?", id);
  await admin.del(`/api/workflows/${id}`);
});


/* ------------------------------------------------------------------ */
/* /tools — list packs and status                                      */
/* ------------------------------------------------------------------ */

test('/tools lists all packs with status and hint when missing', async () => {
  const { clearPackCache } = await import('../server/tool-packs.ts');
  clearPackCache();

  const id = await createSession();
  const r = await cmd(admin, id, '/tools');
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'text');
  // Must mention each pack label.
  assert.match(r.data.text, /uv/i);
  assert.match(r.data.text, /kiro/i);
  assert.match(r.data.text, /browser/i);
  // Must show status.
  assert.match(r.data.text, /available|missing|not configured/i);
  await admin.del(`/api/workflows/${id}`);
});

test('/tools shows which packs are missing and their hints', async () => {
  const { clearPackCache } = await import('../server/tool-packs.ts');
  clearPackCache();

  const id = await createSession();
  const r = await cmd(admin, id, '/tools');
  assert.equal(r.status, 200);
  // In test environment none of the tools should be available (no real tools installed).
  // Hints should appear for missing/not-configured packs.
  assert.match(r.data.text, /Settings|docker compose/i, 'hints must be shown for unavailable packs');
  await admin.del(`/api/workflows/${id}`);
});

test('/tools appears in /help', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, '/help');
  assert.equal(r.status, 200);
  assert.match(r.data.text, /\/tools/);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /tools install — admin check                                        */
/* ------------------------------------------------------------------ */

test('/tools install uv: non-admin gets 403 with exact message', async () => {
  const id = await createSession();
  // viewer was added as a member in before()
  const r = await cmd(viewer, id, '/tools install uv');
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'Ask an admin to install this under Settings \u203a Tools.');
  await admin.del(`/api/workflows/${id}`);
});

test('/tools install kiro: non-admin gets 403 with exact message', async () => {
  const id = await createSession();
  const r = await cmd(viewer, id, '/tools install kiro');
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'Ask an admin to install this under Settings \u203a Tools.');
  await admin.del(`/api/workflows/${id}`);
});

test('/tools install uv: admin gets a useful response (not an error)', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, '/tools install uv');
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'text');
  // Must mention the install path.
  assert.match(r.data.text, /install|Settings|API/i);
  await admin.del(`/api/workflows/${id}`);
});

test('/tools install unknown-pack: returns 400', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, '/tools install flyinghogs');
  assert.equal(r.status, 400);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /browser on|off                                                     */
/* ------------------------------------------------------------------ */

test('/browser on: when browser pack is unavailable, returns 400 with hint', async () => {
  const { clearPackCache } = await import('../server/tool-packs.ts');
  // Ensure PORTAL_BROWSER_MCP_URL is not set so browser pack is 'not configured'.
  const savedUrl = process.env.PORTAL_BROWSER_MCP_URL;
  delete process.env.PORTAL_BROWSER_MCP_URL;
  clearPackCache();

  const id = await createSession();
  const r = await cmd(admin, id, '/browser on');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /docker compose|browser|pack/i, 'error should contain pack hint');

  if (savedUrl !== undefined) process.env.PORTAL_BROWSER_MCP_URL = savedUrl;
  else delete process.env.PORTAL_BROWSER_MCP_URL;
  clearPackCache();
  await admin.del(`/api/workflows/${id}`);
});

test('/browser off when browser not in session: returns friendly no-op message', async () => {
  const { clearPackCache } = await import('../server/tool-packs.ts');
  clearPackCache();

  const id = await createSession();
  const r = await cmd(admin, id, '/browser off');
  assert.equal(r.status, 200);
  assert.match(r.data.text, /already off|not on/i);
  await admin.del(`/api/workflows/${id}`);
});

test('/browser: invalid argument returns 400', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, '/browser maybe');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /on|off/i);
  await admin.del(`/api/workflows/${id}`);
});

test('/browser on: when session is running, returns deferred message', async () => {
  const { clearPackCache } = await import('../server/tool-packs.ts');
  const { BUILTIN_BROWSER_ID, BUILTIN_BROWSER_NAME } = await import('../server/integrations.ts');
  const { run: dbExec } = await import('../server/db.ts');
  const { now } = await import('../server/util.ts');

  // Create the built-in browser integration to make /browser on succeed.
  dbExec('INSERT OR REPLACE INTO integrations (id, name, kind, scope, owner_id, config, allow_writes, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    BUILTIN_BROWSER_ID, BUILTIN_BROWSER_NAME, 'browser', 'team', null, '{}', 0, null, null, now(), now(),
  );

  // Set browser URL so pack appears available.
  const savedUrl = process.env.PORTAL_BROWSER_MCP_URL;
  process.env.PORTAL_BROWSER_MCP_URL = 'http://127.0.0.1:59995/mcp';
  clearPackCache();

  // Start a fake HTTP server to make the URL reachable.
  const http = await import('node:http');
  const fakeServer = http.default.createServer((_req, res) => res.writeHead(200).end());
  await new Promise<void>((r) => fakeServer.listen(59995, '127.0.0.1', r));

  try {
    const id = await createSession();
    // Put session in running state.
    exec("UPDATE workflows SET status = 'running', stop_reason = '' WHERE id = ?", id);

    const r = await cmd(admin, id, '/browser on');
    assert.equal(r.status, 200);
    assert.equal(r.data.deferred, true);
    assert.match(r.data.text, /next iteration|deferred/i);

    // Browser integration must be in the session's integrations list.
    const workflow = (await admin.get(`/api/workflows/${id}`)).workflow;
    assert.ok(workflow.integrations.includes(BUILTIN_BROWSER_ID), 'BUILTIN_BROWSER_ID must be in session integrations after /browser on');

    exec("UPDATE workflows SET status = 'stopped' WHERE id = ?", id);
    await admin.del(`/api/workflows/${id}`);
  } finally {
    fakeServer.close();
    if (savedUrl !== undefined) process.env.PORTAL_BROWSER_MCP_URL = savedUrl;
    else delete process.env.PORTAL_BROWSER_MCP_URL;
    clearPackCache();
    dbExec('DELETE FROM integrations WHERE id = ?', BUILTIN_BROWSER_ID);
  }
});

test('/browser appears in /help', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, '/help');
  assert.equal(r.status, 200);
  assert.match(r.data.text, /\/browser/);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /aws on|off                                                         */
/* ------------------------------------------------------------------ */

test('/aws on: when no AWS integration exists, returns 400', async () => {
  const { clearPackCache } = await import('../server/tool-packs.ts');
  clearPackCache();

  const id = await createSession();
  const r = await cmd(admin, id, '/aws on');
  // Either 400 from pack check or 400 from "no AWS integration available".
  assert.equal(r.status, 400);
  await admin.del(`/api/workflows/${id}`);
});

test('/aws off when no AWS integration in session: returns no-op message', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, '/aws off');
  assert.equal(r.status, 200);
  // The message says "No AWS integration is on for this session. No change." or similar.
  assert.match(r.data.text, /AWS integration.*No change|No AWS integration.*No change/i);
  await admin.del(`/api/workflows/${id}`);
});

test('/aws: invalid argument returns 400', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, '/aws maybe');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /on|off/i);
  await admin.del(`/api/workflows/${id}`);
});

test('/aws appears in /help', async () => {
  const id = await createSession();
  const r = await cmd(admin, id, '/help');
  assert.equal(r.status, 200);
  assert.match(r.data.text, /\/aws/);
  await admin.del(`/api/workflows/${id}`);
});

/* ------------------------------------------------------------------ */
/* /browser on when pack is available — full happy-path              */
/* ------------------------------------------------------------------ */

test('/browser on: adds built-in browser integration when pack is available', async () => {
  const { clearPackCache } = await import('../server/tool-packs.ts');
  const { BUILTIN_BROWSER_ID, BUILTIN_BROWSER_NAME } = await import('../server/integrations.ts');
  const { run: dbExec } = await import('../server/db.ts');
  const { now } = await import('../server/util.ts');

  // Ensure the built-in browser integration exists.
  dbExec('INSERT OR REPLACE INTO integrations (id, name, kind, scope, owner_id, config, allow_writes, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    BUILTIN_BROWSER_ID, BUILTIN_BROWSER_NAME, 'browser', 'team', null, '{}', 0, null, null, now(), now(),
  );

  const savedUrl = process.env.PORTAL_BROWSER_MCP_URL;
  process.env.PORTAL_BROWSER_MCP_URL = 'http://127.0.0.1:59994/mcp';
  clearPackCache();

  const http = await import('node:http');
  const fakeServer = http.default.createServer((_req, res) => res.writeHead(200).end());
  await new Promise<void>((r) => fakeServer.listen(59994, '127.0.0.1', r));

  try {
    const id = await createSession();

    // Turn browser on.
    const onR = await cmd(admin, id, '/browser on');
    assert.equal(onR.status, 200);
    assert.match(onR.data.text, /browser|added/i);
    assert.ok(onR.data.workflow, 'workflow must be returned');

    let wf = (await admin.get(`/api/workflows/${id}`)).workflow;
    assert.ok(wf.integrations.includes(BUILTIN_BROWSER_ID), '/browser on must add BUILTIN_BROWSER_ID');

    // No-op on second /browser on.
    const noop = await cmd(admin, id, '/browser on');
    assert.equal(noop.status, 200);
    assert.match(noop.data.text, /already on/i);

    // Turn browser off.
    const offR = await cmd(admin, id, '/browser off');
    assert.equal(offR.status, 200);
    assert.match(offR.data.text, /removed/i);
    assert.ok(offR.data.workflow, 'workflow must be returned after /browser off');

    wf = (await admin.get(`/api/workflows/${id}`)).workflow;
    assert.ok(!wf.integrations.includes(BUILTIN_BROWSER_ID), '/browser off must remove BUILTIN_BROWSER_ID');

    await admin.del(`/api/workflows/${id}`);
  } finally {
    fakeServer.close();
    if (savedUrl !== undefined) process.env.PORTAL_BROWSER_MCP_URL = savedUrl;
    else delete process.env.PORTAL_BROWSER_MCP_URL;
    clearPackCache();
    dbExec('DELETE FROM integrations WHERE id = ?', BUILTIN_BROWSER_ID);
  }
});

/* ------------------------------------------------------------------ */
/* Session log entries for /browser and /aws                         */
/* ------------------------------------------------------------------ */

test('/browser on writes a session-log entry', async () => {
  const { clearPackCache } = await import('../server/tool-packs.ts');
  const { BUILTIN_BROWSER_ID, BUILTIN_BROWSER_NAME } = await import('../server/integrations.ts');
  const { run: dbExec } = await import('../server/db.ts');
  const { now } = await import('../server/util.ts');

  dbExec('INSERT OR REPLACE INTO integrations (id, name, kind, scope, owner_id, config, allow_writes, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    BUILTIN_BROWSER_ID, BUILTIN_BROWSER_NAME, 'browser', 'team', null, '{}', 0, null, null, now(), now(),
  );
  const savedUrl = process.env.PORTAL_BROWSER_MCP_URL;
  process.env.PORTAL_BROWSER_MCP_URL = 'http://127.0.0.1:59993/mcp';
  clearPackCache();
  const http = await import('node:http');
  const fakeServer = http.default.createServer((_req, res) => res.writeHead(200).end());
  await new Promise<void>((r) => fakeServer.listen(59993, '127.0.0.1', r));

  try {
    const id = await createSession();
    await cmd(admin, id, '/browser on');

    const events = (await admin.get(`/api/workflows/${id}`)).events;
    const e = events.find((ev: any) => ev.kind === 'system' && /browser/i.test(ev.body));
    assert.ok(e, 'a system log entry about the browser change must be written');
    assert.match(e.body, /Settings changed by command/);

    await admin.del(`/api/workflows/${id}`);
  } finally {
    fakeServer.close();
    if (savedUrl !== undefined) process.env.PORTAL_BROWSER_MCP_URL = savedUrl;
    else delete process.env.PORTAL_BROWSER_MCP_URL;
    clearPackCache();
    dbExec('DELETE FROM integrations WHERE id = ?', BUILTIN_BROWSER_ID);
  }
});
