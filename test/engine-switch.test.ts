/**
 * D-12: a Kiro session that cannot run never switches engine by itself. It pauses with a reason, the user is asked
 * (session workspace and Inbox), and only a yes moves it to Claude Code.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootServer, Client, waitFor, type TestServer } from './client.ts';

process.env.PORTAL_KIRO_FAKE = path.join(import.meta.dirname, 'fake-kiro-acp.mjs');
process.env.FAKE_KIRO_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-switch-')), 'log.jsonl');

let srv: TestServer;
let c: Client;
let pid: string;
let exec: typeof import('../server/db.ts').run;
let clearPackCache: () => void;

const wf = async (id: string) => (await c.get(`/api/workflows/${id}`)).workflow;
const settled = (id: string) => waitFor(async () => {
  const w = await wf(id);
  return w.status === 'paused' && w.engine_switch ? w : null;
}, 'the session to ask about the engine');

before(async () => {
  srv = await bootServer();
  ({ run: exec } = await import('../server/db.ts'));
  ({ clearPackCache } = await import('../server/tool-packs.ts'));
  c = new Client(srv.base);
  await c.post('/api/auth/setup', { email: 'sw@example.com', name: 'Switcher', password: 'a-long-password-1' });
  await c.put('/api/settings', { provider: { mode: 'anthropic' } });
  pid = (await c.post('/api/projects', { name: 'Engine switch' })).project.id;
  // A .claude agent that the old fallback would have picked up on Kiro.
  const dir = path.join(srv.dataDir, 'projects', 'engine-switch', '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lead-dev.md'), '---\nname: lead-dev\ndescription: A Claude agent\n---\nYou lead.\n');
});

after(() => srv.close());

async function kiroSession(extra: Record<string, unknown> = {}) {
  const { workflow } = await c.post(`/api/projects/${pid}/workflows`, { goal: 'Do the thing', engine: 'kiro', playground: true, start: false, ...extra });
  return workflow.id as string;
}

function addKiroAgent(): void {
  const dir = path.join(srv.dataDir, 'projects', 'engine-switch', '.kiro', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'builder.json'), JSON.stringify({ name: 'builder', description: 'A Kiro agent', prompt: 'You build things.' }));
}

async function resume(id: string) {
  await c.post(`/api/workflows/${id}/resume`);
}

test('no Kiro agent and no lead agent: the session still asks instead of running on Kiro', async () => {
  const id = await kiroSession();
  await resume(id);
  const w = await settled(id);
  assert.equal(w.engine, 'kiro');
  assert.equal(w.last_run_id, null, 'nothing ran');
  assert.match(w.engine_switch.reason, /no usable Kiro agent/);
  await c.post(`/api/workflows/${id}/engine-switch`, { accept: false });
});

test('no Kiro agent: the session asks, never falls back to the .claude agents, and never runs', async () => {
  const leads = await c.get(`/api/projects/${pid}/leads?engine=kiro`);
  assert.deepEqual(leads.leads, [], 'Kiro lists no .claude agents');
  const id = await kiroSession();
  exec("UPDATE workflows SET lead_agent = 'lead-dev' WHERE id = ?", id);
  await resume(id);
  const w = await settled(id);
  assert.equal(w.engine, 'kiro', 'the engine did not change by itself');
  assert.equal(w.last_run_id, null, 'nothing ran on either engine');
  assert.match(w.engine_switch.reason, /no usable Kiro agent/);
  assert.equal(w.engine_switch.claudeReady, true);

  const inbox = await c.get('/api/inbox?filter=needs_you');
  const item = inbox.items.find((i: any) => i.workflowId === id);
  assert.equal(item?.kind, 'engine_switch', 'the Inbox shows it as needing the user');
});

test('accept: the session continues on the Claude engine', async () => {
  const id = await kiroSession();
  exec("UPDATE workflows SET lead_agent = 'lead-dev' WHERE id = ?", id);
  await resume(id);
  await settled(id);
  const r = await c.post(`/api/workflows/${id}/engine-switch`, { accept: true });
  assert.equal(r.workflow.engine, 'claude');
  assert.equal(r.workflow.engine_switch, null);
  const after = await wf(id);
  assert.equal(after.engine, 'claude');
  assert.ok(!(await c.get('/api/inbox?filter=needs_you')).items.some((i: any) => i.workflowId === id), 'the Inbox item is gone');
  const again = await c.req('POST', `/api/workflows/${id}/engine-switch`, { accept: true });
  assert.equal(again.status, 400, 'nothing left to answer');
  await c.post(`/api/workflows/${id}/stop`);
});

test('decline: the session stays on Kiro and stays stopped', async () => {
  const id = await kiroSession();
  exec("UPDATE workflows SET lead_agent = 'lead-dev' WHERE id = ?", id);
  await resume(id);
  await settled(id);
  const r = await c.post(`/api/workflows/${id}/engine-switch`, { accept: false });
  assert.equal(r.workflow.engine, 'kiro');
  assert.equal(r.workflow.status, 'stopped');
  assert.equal(r.workflow.engine_switch, null);
  assert.ok(!(await c.get('/api/inbox?filter=needs_you')).items.some((i: any) => i.workflowId === id));
});

test('the answer needs a yes or no', async () => {
  const id = await kiroSession();
  assert.equal((await c.req('POST', `/api/workflows/${id}/engine-switch`, {})).status, 400);
  assert.equal((await c.req('POST', `/api/workflows/${id}/engine-switch`, { accept: true })).status, 400, 'nothing is waiting');
});

test('Kiro CLI missing: the session asks instead of just pausing', async () => {
  addKiroAgent();
  await c.put('/api/settings', { kiro: { command: path.join(srv.dataDir, 'nowhere', 'kiro-cli') } });
  clearPackCache();
  try {
    const id = await kiroSession();
    await resume(id);
    const w = await settled(id);
    assert.match(w.engine_switch.reason, /Kiro CLI is not available/);
    assert.equal(w.engine, 'kiro');
    await c.post(`/api/workflows/${id}/engine-switch`, { accept: false });
  } finally {
    await c.put('/api/settings', { kiro: { command: '' } });
    clearPackCache();
  }
});

test('Kiro run fails: the session asks instead of failing or retrying', async () => {
  clearPackCache();
  const id = await kiroSession({ goal: 'Break [fail]' });
  await resume(id);
  const w = await settled(id);
  assert.match(w.engine_switch.reason, /Kiro run failed/);
  assert.equal(w.engine, 'kiro');
  await c.post(`/api/workflows/${id}/engine-switch`, { accept: false });
});
