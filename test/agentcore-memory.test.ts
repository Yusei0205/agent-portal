/**
 * Project memory: secrets are masked before anything is sent, only projects that opted in are written, notes start pending and only
 * approved ones reach a prompt, and only a project owner can review or delete notes (and only their own project's).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { hashPassword } from '../server/auth.ts';
import { now } from '../server/util.ts';
import { setSetting } from '../server/settings.ts';
import { redactSecrets, sweepMemoryWrites, buildProjectMemoryBlock, _setMemoryClient, recordStatus } from '../server/agentcore-memory.ts';
import { buildConversationRecap } from '../server/agent/recap.ts';

describe('redactSecrets', () => {
  test('masks keys, tokens, bearer headers and assignments, and leaves normal text', () => {
    const out = redactSecrets('use AKIAABCDEFGHIJKLMNOP and ghp_abcdefghijklmnopqrstuvwxyz1234 with password=hunter2 and Bearer abcdefghijklmnopqrstuvwx; run npm test');
    assert.ok(!/AKIA|ghp_|hunter2|abcdefghijklmnopqrstuvwx/.test(out), out);
    assert.match(out, /run npm test/);
  });
  test('masks a private key block', () => {
    assert.ok(!/MIIE/.test(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----')));
  });
});

describe('project memory', () => {
  let baseUrl: string;
  let adminCookie = '';
  let ownerCookie = '';
  let memberCookie = '';
  const calls: Array<{ cmd: string; input: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const records = new Map<string, { id: string; text: string; ns: string }>();

  const mk = (name: string) => class { constructor(public input: any) { (this as any).name = name; } }; // eslint-disable-line @typescript-eslint/no-explicit-any

  before(async () => {
    process.env.PORTAL_MEMORY_ID = 'mem-test';
    ({ baseUrl } = await createTestServer());
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@mem.test', password: 'adminpass1', name: 'Admin' } });
    adminCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@mem.test', password: 'adminpass1' } })).cookie ?? '';
    const mkUser = async (id: string): Promise<string> => {
      getDb().prepare('INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)').run(id, `${id}@mem.test`, id, hashPassword('memberpass1'), now());
      return (await fetchJson(baseUrl, '/api/auth/login', { body: { email: `${id}@mem.test`, password: 'memberpass1' } })).cookie ?? '';
    };
    ownerCookie = await mkUser('user-mem-owner');
    memberCookie = await mkUser('user-mem-member');
    for (const id of ['proj-mem-a', 'proj-mem-b']) getDb().prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(id, id, `slug-${id}`, now());
    const mem = getDb().prepare('INSERT INTO project_members (project_id, user_id, access, role) VALUES (?, ?, ?, ?)');
    mem.run('proj-mem-a', 'user-mem-owner', 'write', 'owner');
    mem.run('proj-mem-a', 'user-mem-member', 'write', 'member');
    mem.run('proj-mem-b', 'user-mem-owner', 'write', 'member');

    const send = async (cmd: { name: string; input: any }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      calls.push({ cmd: cmd.name, input: cmd.input });
      if (cmd.name === 'ListMemoryRecords') {
        const prefix: string = cmd.input.namespacePath;
        return { memoryRecordSummaries: [...records.values()].filter((r) => r.ns.startsWith(prefix)).map((r) => ({ memoryRecordId: r.id, content: { text: r.text }, namespaces: [r.ns], createdAt: new Date() })) };
      }
      if (cmd.name === 'RetrieveMemoryRecords') {
        return { memoryRecordSummaries: [...records.values()].filter((r) => r.ns === cmd.input.namespace).map((r) => ({ memoryRecordId: r.id, content: { text: r.text }, namespaces: [r.ns] })) };
      }
      if (cmd.name === 'GetMemoryRecord') { const r = records.get(cmd.input.memoryRecordId); if (!r) throw new Error('not found'); return { memoryRecord: { namespaces: [r.ns] } }; }
      if (cmd.name === 'DeleteMemoryRecord') { records.delete(cmd.input.memoryRecordId); return {}; }
      return {};
    };
    _setMemoryClient({ client: { send }, cmds: { CreateEvent: mk('CreateEvent'), ListMemoryRecords: mk('ListMemoryRecords'), RetrieveMemoryRecords: mk('RetrieveMemoryRecords'), GetMemoryRecord: mk('GetMemoryRecord'), DeleteMemoryRecord: mk('DeleteMemoryRecord') } });
  });
  after(async () => { _setMemoryClient(null); delete process.env.PORTAL_MEMORY_ID; await cleanup(); });
  beforeEach(async () => {
    calls.length = 0;
    records.clear();
    getDb().prepare('DELETE FROM p6_events').run();
    getDb().prepare('DELETE FROM p6_workflows').run();
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'agentcore.memory.%'").run();
  });

  const seed = (wid: string, projectId: string, minutesAgo = 10): void => {
    const ts = now();
    getDb().prepare(`INSERT INTO p6_workflows (id, project_id, goal, title, status, engine, trust_tools, lead_agent, created_at, updated_at, last_turn_at, stop_reason)
      VALUES (?, ?, 'add a test', 't', 'done', 'codex', 0, 'default', ?, ?, ?, '')`).run(wid, projectId, ts, ts, new Date(Date.now() - minutesAgo * 60_000).toISOString());
    getDb().prepare('INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, ?, ?)').run(`run-${wid}`, wid, 'done', ts);
    getDb().prepare('INSERT INTO p6_workflow_events (workflow_id, kind, body, created_at) VALUES (?, ?, ?, ?)').run(wid, 'human', 'Run the tests with password=hunter2', new Date(Date.now() - 20 * 60_000).toISOString());
    getDb().prepare('INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)').run(`run-${wid}`, 'run-complete', JSON.stringify({ result: 'Tests run with npm test.' }), ts);
  };
  const on = (projectId: string) => setSetting(getDb(), `agentcore.memory.enabled.${projectId}`, '1');

  test('writes the last exchange of a quiet session once, masked, only for a project that opted in', async () => {
    seed('wf-mem-1', 'proj-mem-a');
    seed('wf-mem-2', 'proj-mem-b');
    await on('proj-mem-a');
    assert.equal(await sweepMemoryWrites(), 1);
    const w = calls.filter((c) => c.cmd === 'CreateEvent');
    assert.equal(w.length, 1);
    assert.equal(w[0].input.actorId, 'proj-mem-a');
    assert.equal(w[0].input.sessionId, 'wf-mem-1');
    assert.ok(!JSON.stringify(w[0].input.payload).includes('hunter2'));
    assert.equal(await sweepMemoryWrites(), 0);
  });

  test('a session that is still active is not written', async () => {
    seed('wf-mem-3', 'proj-mem-a', 0);
    await on('proj-mem-a');
    assert.equal(await sweepMemoryWrites(), 0);
  });

  test('only approved notes reach the recap, and only when the project has memory on', async () => {
    seed('wf-mem-4', 'proj-mem-a');
    records.set('r-ok', { id: 'r-ok', text: 'Tests run with npm test', ns: '/project/proj-mem-a/facts' });
    records.set('r-pending', { id: 'r-pending', text: 'Deploy on Fridays', ns: '/project/proj-mem-a/facts' });
    await setSetting(getDb(), 'agentcore.memory.status.r-ok', 'approved');
    assert.equal(await buildProjectMemoryBlock('wf-mem-4'), '');
    await on('proj-mem-a');
    const block = await buildProjectMemoryBlock('wf-mem-4');
    assert.match(block, /Tests run with npm test/);
    assert.ok(!block.includes('Deploy on Fridays'));
    const recap = await buildConversationRecap('wf-mem-4', 'run-other');
    assert.ok(recap.startsWith('[Project notes'), recap.slice(0, 60));
  });

  test('a failing memory service gives no block instead of failing the session', async () => {
    seed('wf-mem-5', 'proj-mem-a');
    await on('proj-mem-a');
    _setMemoryClient({ client: { send: async () => { throw new Error('boom'); } }, cmds: { RetrieveMemoryRecords: mk('RetrieveMemoryRecords') } });
    assert.equal(await buildProjectMemoryBlock('wf-mem-5'), '');
  });

  describe('routes', () => {
    beforeEach(() => {
      // restore the working client after the failing one above
      _setMemoryClient({
        client: {
          async send(cmd: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
            if (cmd.name === 'ListMemoryRecords') return { memoryRecordSummaries: [...records.values()].filter((r) => r.ns.startsWith(cmd.input.namespacePath)).map((r) => ({ memoryRecordId: r.id, content: { text: r.text }, namespaces: [r.ns], createdAt: new Date() })) };
            if (cmd.name === 'GetMemoryRecord') { const r = records.get(cmd.input.memoryRecordId); if (!r) throw new Error('nf'); return { memoryRecord: { namespaces: [r.ns] } }; }
            if (cmd.name === 'DeleteMemoryRecord') { records.delete(cmd.input.memoryRecordId); return {}; }
            return {};
          },
        },
        cmds: { ListMemoryRecords: mk('ListMemoryRecords'), GetMemoryRecord: mk('GetMemoryRecord'), DeleteMemoryRecord: mk('DeleteMemoryRecord'), CreateEvent: mk('CreateEvent'), RetrieveMemoryRecords: mk('RetrieveMemoryRecords') },
      });
      records.set('r-a', { id: 'r-a', text: 'Note for A', ns: '/project/proj-mem-a/facts' });
      records.set('r-b', { id: 'r-b', text: 'Note for B', ns: '/project/proj-mem-b/facts' });
    });
    const url = (p: string, rest = '') => `/api/projects/${p}/memory${rest}`;

    test('a member sees only their project\'s notes as pending, and cannot manage', async () => {
      const r = await fetchJson(baseUrl, url('proj-mem-a'), { cookie: memberCookie });
      const b = r.body as { records: Array<{ id: string; status: string }>; canManage: boolean; available: boolean };
      assert.equal(r.status, 200);
      assert.equal(b.canManage, false);
      assert.deepEqual(b.records.map((x) => [x.id, x.status]), [['r-a', 'pending']]);
      assert.equal((await fetchJson(baseUrl, url('proj-mem-a', '/records/r-a'), { method: 'PUT', cookie: memberCookie, body: { status: 'approved' } })).status, 403);
      assert.equal((await fetchJson(baseUrl, url('proj-mem-a'), { method: 'PUT', cookie: memberCookie, body: { enabled: true } })).status, 403);
    });

    test('a non-member is refused', async () => {
      assert.equal((await fetchJson(baseUrl, url('proj-mem-b'), { cookie: memberCookie })).status, 403);
    });

    test('an owner turns memory on, approves a note, and deletes it', async () => {
      assert.equal((await fetchJson(baseUrl, url('proj-mem-a'), { method: 'PUT', cookie: ownerCookie, body: { enabled: true } })).status, 200);
      assert.equal((await fetchJson(baseUrl, url('proj-mem-a', '/records/r-a'), { method: 'PUT', cookie: ownerCookie, body: { status: 'approved' } })).status, 200);
      assert.equal(recordStatus('r-a'), 'approved');
      assert.equal((await fetchJson(baseUrl, url('proj-mem-a', '/records/r-a'), { method: 'DELETE', cookie: ownerCookie })).status, 200);
      assert.equal(records.has('r-a'), false);
    });

    test('an owner of one project cannot touch another project\'s note, and bad input is refused', async () => {
      // ownerCookie is only a member of proj-mem-b, so managing B is refused; A's owner must not reach B's record through A.
      assert.equal((await fetchJson(baseUrl, url('proj-mem-a', '/records/r-b'), { method: 'PUT', cookie: ownerCookie, body: { status: 'approved' } })).status, 404);
      assert.equal((await fetchJson(baseUrl, url('proj-mem-a', '/records/r-b'), { method: 'DELETE', cookie: ownerCookie })).status, 404);
      assert.equal(records.has('r-b'), true);
      assert.equal((await fetchJson(baseUrl, url('proj-mem-a', '/records/r-a'), { method: 'PUT', cookie: ownerCookie, body: { status: 'maybe' } })).status, 400);
      assert.equal((await fetchJson(baseUrl, url('proj-mem-a'), { method: 'PUT', cookie: adminCookie, body: { enabled: 'yes' } })).status, 400);
    });
  });
});
