import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { config } from '../server/config.ts';
import { encrypt } from '../server/secrets.ts';
import { setCallTextModelOverride } from '../server/testing/model-provider.ts';
import { setGuidePathForTest } from '../server/assistant/guide.ts';
import { resetLimitsForTest } from '../server/assistant/limits.ts';
import { setAssistantTimeoutForTest, setAssistantRetrieveForTest } from '../server/assistant/routes.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let baseUrl = '';
let admin = '', member = '', outsider = '', noCred = '';
let projectId = '';
let calls: Array<{ sys: string; usr: string }> = [];
let reply = 'Open the Inbox.\nLINKS: inbox, admin-secrets';
let guideFile = '';

const ask = (cookie: string | undefined, body: unknown) =>
  fetchJson(baseUrl, '/api/assistant/chat', { method: 'POST', body, ...(cookie ? { cookie } : {}) });

function addCredential(userId: string): void {
  const ts = new Date().toISOString();
  getDb().prepare(`INSERT INTO engine_credentials (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at, updated_by)
    VALUES (?, ?, 'claude-code', 'Key', 'api_key', ?, '{}', 1, 'fake', ?, ?, ?)`)
    .run(`cred-${userId}`, userId, encrypt('sk-ant-fake', config.secretKey), ts, ts, userId);
}

before(async () => {
  baseUrl = (await createTestServer()).baseUrl;
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@ar.test', password: 'adminpassword1', name: 'Admin' } });
  admin = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@ar.test', password: 'adminpassword1' } })).cookie ?? '';
  for (const e of ['mem@ar.test', 'out@ar.test', 'nocred@ar.test']) {
    await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: e, name: e, password: 'memberpass1234', isAdmin: false }, cookie: admin });
  }
  const login = async (e: string) => (await fetchJson(baseUrl, '/api/auth/login', { body: { email: e, password: 'memberpass1234' } })).cookie ?? '';
  member = await login('mem@ar.test'); outsider = await login('out@ar.test'); noCred = await login('nocred@ar.test');
  const p = await fetchJson(baseUrl, '/api/projects', { body: { name: 'Route project' }, cookie: admin });
  projectId = (p.body as { project: { id: string } }).project.id;
  const users = ((await fetchJson(baseUrl, '/api/users', { cookie: admin })).body as { users: { id: string; email: string }[] }).users;
  const id = (email: string) => users.find((u) => u.email === email)!.id;
  for (const email of ['mem@ar.test', 'nocred@ar.test']) {
    await fetchJson(baseUrl, `/api/projects/${projectId}/members`, { method: 'POST', body: { userId: id(email), role: 'viewer' }, cookie: admin });
  }
  addCredential(id('mem@ar.test')); addCredential(id('out@ar.test'));
  const ts = new Date().toISOString();
  getDb().prepare(`INSERT INTO p6_workflows (id, project_id, goal, title, status, engine, trust_tools, lead_agent, created_at, updated_at)
    VALUES ('wf-ar-1', ?, 'SECRETGOAL transcript text', 'SECRETTITLE session', 'running', 'codex', 0, 'default', ?, ?)`).run(projectId, ts, ts);
  guideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-guide-')), 'guide.md');
  fs.writeFileSync(guideFile, '# Guide\n\n## Auto-fix\nTurn on auto-fix in Setup to repair failing pipelines.\n');
  setGuidePathForTest(guideFile);
});
after(() => { setCallTextModelOverride(null); setGuidePathForTest(null); setAssistantTimeoutForTest(null); setAssistantRetrieveForTest(null); return cleanup(); });
beforeEach(() => {
  calls = []; reply = 'Open the Inbox.\nLINKS: inbox, admin-secrets';
  resetLimitsForTest();
  setAssistantTimeoutForTest(null);
  setAssistantRetrieveForTest(async () => ({ passages: [], via: 'keyword' }));
  setCallTextModelOverride(async (sys, usr) => { calls.push({ sys, usr }); return reply; });
});

describe('POST /api/assistant/chat', () => {
  it('401 when signed out', async () => {
    const r = await ask(undefined, { question: 'hi' });
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0);
  });

  it('403 for a non-member with a projectId, no model call', async () => {
    const r = await ask(outsider, { question: 'hi', projectId });
    assert.equal(r.status, 403);
    assert.equal(calls.length, 0);
  });

  it('402 no_sign_in without a credential, no model call', async () => {
    const r = await ask(noCred, { question: 'hi', projectId });
    assert.equal(r.status, 402);
    assert.equal((r.body as { code: string }).code, 'no_sign_in');
    assert.equal(calls.length, 0);
  });

  it('400 too_long for 1,001 characters, 1,000 is fine', async () => {
    const r = await ask(member, { question: 'x'.repeat(1001) });
    assert.equal(r.status, 400);
    assert.equal((r.body as { code: string }).code, 'too_long');
    assert.equal(calls.length, 0);
    assert.equal((await ask(member, { question: 'x'.repeat(1000) })).status, 200);
  });

  it('answers with the model text, known links only, via guide', async () => {
    const r = await ask(member, { question: 'how do I turn on auto-fix', projectId });
    assert.equal(r.status, 200);
    const b = r.body as { reply: string; links: Array<{ id: string }>; via: string };
    assert.equal(b.reply, 'Open the Inbox.');
    assert.deepEqual(b.links.map((l) => l.id), ['inbox']);
    assert.equal(b.via, 'guide');
    assert.match(calls[0]!.usr, /Turn on auto-fix/);
  });

  it('via guide+knowledge when knowledge passages come back', async () => {
    setAssistantRetrieveForTest(async () => ({ passages: [{ docId: 'd1', docName: 'Runbook', heading: 'Deploy', text: 'KNOWLEDGE-PASSAGE-TEXT' }], via: 'keyword' }));
    const r = await ask(member, { question: 'deploy?', projectId });
    assert.equal((r.body as { via: string }).via, 'guide+knowledge');
    assert.match(calls[0]!.usr, /KNOWLEDGE-PASSAGE-TEXT/);
  });

  it('retrieve throwing still answers from the guide', async () => {
    setAssistantRetrieveForTest(async () => { throw new Error('index down'); });
    const r = await ask(member, { question: 'auto-fix?', projectId });
    assert.equal(r.status, 200);
    assert.equal((r.body as { via: string }).via, 'guide');
  });

  it('prompt has the running count and no session title or transcript text; without projectId no project parts', async () => {
    await ask(member, { question: 'what is running', projectId });
    assert.match(calls[0]!.usr, /Workflows running: 1/);
    assert.doesNotMatch(calls[0]!.usr, /SECRETTITLE|SECRETGOAL/);
    await ask(member, { question: 'what is running' });
    assert.doesNotMatch(calls[1]!.usr, /Workflows running/);
  });

  it('history is cut to the last 4 exchanges, 600 chars each, malformed entries ignored', async () => {
    const history: unknown[] = [];
    for (let i = 0; i < 6; i++) { history.push({ role: 'me', text: `Q${i}` }, { role: 'cat', text: `A${i}` }); }
    history.push({ role: 'admin', text: 'BADROLE' }, { role: 'me', text: 42 }, null, 'str');
    history.push({ role: 'me', text: 'L'.repeat(900) });
    await ask(member, { question: 'next', history });
    const usr = calls[0]!.usr;
    assert.doesNotMatch(usr, /BADROLE/);
    assert.doesNotMatch(usr, /\b(Q0|A0|Q1|A1|Q2)\b/);
    assert.match(usr, /Q5/);
    assert.match(usr, /L{600}/);
    assert.doesNotMatch(usr, /L{601}/);
    const lines = usr.split('\n').filter((l) => /^(Person|Cat): /.test(l));
    assert.equal(lines.length, 8);
  });

  it('the 9th question in a minute is 429 and the model is not called', async () => {
    for (let i = 0; i < 8; i++) assert.equal((await ask(member, { question: 'q' })).status, 200);
    const r = await ask(member, { question: 'q' });
    assert.equal(r.status, 429);
    assert.equal((r.body as { code: string }).code, 'rate_limited');
    assert.equal(calls.length, 8);
  });

  it('502 failed when the model reply is empty and no link survives; links alone give a fallback line', async () => {
    reply = '   ';
    let r = await ask(member, { question: 'q' });
    assert.equal(r.status, 502);
    assert.equal((r.body as { code: string }).code, 'failed');
    reply = 'LINKS: admin-secrets';
    r = await ask(member, { question: 'q' });
    assert.equal(r.status, 502);
    reply = 'LINKS: inbox';
    r = await ask(member, { question: 'q' });
    assert.equal(r.status, 200);
    const b = r.body as { reply: string; links: Array<{ id: string }> };
    assert.equal(b.reply, 'These pages may help:');
    assert.deepEqual(b.links.map((l) => l.id), ['inbox']);
  });

  it('a person with no sign-in asking 20 times always gets 402, never 429', async () => {
    for (let i = 0; i < 20; i++) assert.equal((await ask(noCred, { question: 'q' })).status, 402, `ask ${i + 1}`);
    assert.equal(calls.length, 0);
  });

  it('a missing guide file still answers, via guide', async () => {
    setGuidePathForTest(path.join(os.tmpdir(), 'ar-no-such-dir', 'missing.md'));
    try {
      const r = await ask(member, { question: 'auto-fix?' });
      assert.equal(r.status, 200);
      assert.equal((r.body as { via: string }).via, 'guide');
    } finally { setGuidePathForTest(guideFile); }
  });

  it('the 101st question of a day is 429 and the model is not called', async () => {
    const users = ((await fetchJson(baseUrl, '/api/users', { cookie: admin })).body as { users: { id: string; email: string }[] }).users;
    const uid = users.find((u) => u.email === 'mem@ar.test')!.id;
    const key = `assistant.count.${uid}.${new Date().toISOString().slice(0, 10)}`;
    getDb().prepare("INSERT INTO settings (key, value) VALUES (?, '100') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key);
    try {
      const r = await ask(member, { question: 'q' });
      assert.equal(r.status, 429);
      assert.equal((r.body as { code: string }).code, 'rate_limited');
      assert.equal(calls.length, 0);
    } finally { getDb().prepare('DELETE FROM settings WHERE key = ?').run(key); }
  });

  it('502 failed when the model throws, error text not echoed', async () => {
    setCallTextModelOverride(async () => { throw new Error('TOP-SECRET-PROVIDER-ERROR'); });
    const r = await ask(member, { question: 'q' });
    assert.equal(r.status, 502);
    const b = r.body as { code: string; reply?: string };
    assert.equal(b.code, 'failed');
    assert.equal(b.reply, undefined);
    assert.doesNotMatch(JSON.stringify(r.body), /TOP-SECRET/);
  });

  it('502 failed when the model is slower than the timeout', async () => {
    setAssistantTimeoutForTest(50);
    setCallTextModelOverride(async () => new Promise<string>((res) => setTimeout(() => res('late'), 400)));
    const r = await ask(member, { question: 'q' });
    assert.equal(r.status, 502);
    assert.equal((r.body as { code: string }).code, 'failed');
  });
});
