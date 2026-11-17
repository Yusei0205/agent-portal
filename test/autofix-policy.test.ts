import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one } from '../server/db.ts';
import { getAuditRepository } from '../server/repositories/audit.ts';
import {
  DEFAULT_POLICY, getAutofixPolicy, saveAutofixPolicy, isPaused, setPaused,
} from '../server/autofix/policy.ts';

let baseUrl = '';
let adminCookie = '';
let memberCookie = '';
let outsiderCookie = '';
let projectId = '';
let adminId = '';
let memId = '';
let ownerCookie = '';
let ownerId = '';
let viewerId = '';

async function audit(action: string) {
  return (await getAuditRepository().query({ limit: 100, action })).entries;
}

before(async () => {
  baseUrl = (await createTestServer()).baseUrl;
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@af.test', password: 'adminpassword1', name: 'Admin' } });
  adminCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@af.test', password: 'adminpassword1' } })).cookie ?? '';
  for (const e of ['mem@af.test', 'out@af.test', 'own@af.test', 'view@af.test']) {
    await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: e, name: e, password: 'memberpass1234', isAdmin: false }, cookie: adminCookie });
  }
  memberCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'mem@af.test', password: 'memberpass1234' } })).cookie ?? '';
  outsiderCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'out@af.test', password: 'memberpass1234' } })).cookie ?? '';
  const p = await fetchJson(baseUrl, '/api/projects', { body: { name: 'AF project' }, cookie: adminCookie });
  projectId = (p.body as { project: { id: string } }).project.id;
  memId = String(one('SELECT id FROM users WHERE email = ?', 'mem@af.test')!.id);
  adminId = String(one('SELECT id FROM users WHERE email = ?', 'admin@af.test')!.id);
  await fetchJson(baseUrl, `/api/projects/${projectId}/members`, { method: 'POST', body: { userId: memId, role: 'editor' }, cookie: adminCookie });
  ownerId = String(one('SELECT id FROM users WHERE email = ?', 'own@af.test')!.id);
  viewerId = String(one('SELECT id FROM users WHERE email = ?', 'view@af.test')!.id);
  await fetchJson(baseUrl, `/api/projects/${projectId}/members`, { method: 'POST', body: { userId: ownerId, role: 'owner' }, cookie: adminCookie });
  await fetchJson(baseUrl, `/api/projects/${projectId}/members`, { method: 'POST', body: { userId: viewerId, role: 'viewer' }, cookie: adminCookie });
  ownerCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'own@af.test', password: 'memberpass1234' } })).cookie ?? '';
});

after(cleanup);

describe('policy store', () => {
  it("getAutofixPolicy returns DEFAULT_POLICY with mode 'off' for an unconfigured project", async () => {
    const p = await getAutofixPolicy('unconfigured');
    assert.deepEqual(p, DEFAULT_POLICY);
    assert.equal(p.mode, 'off');
    assert.equal(p.engine, 'claude-code');
    assert.equal(p.run_as, '');
    assert.equal(p.limits.max_open_prs, 3);
    assert.equal(p.limits.max_cost_per_day_usd, 10);
  });

  it('saveAutofixPolicy merges a partial patch and persists', async () => {
    const saved = await saveAutofixPolicy('p-merge', { mode: 'propose', limits: { max_files: 5 } as never });
    assert.equal(saved.mode, 'propose');
    assert.equal(saved.limits.max_files, 5);
    assert.equal(saved.limits.max_lines, 300);
    assert.deepEqual(await getAutofixPolicy('p-merge'), saved);
  });

  it("saveAutofixPolicy rejects mode 'auto_merge', a negative limit and an unknown engine", async () => {
    await assert.rejects(saveAutofixPolicy('p-bad', { mode: 'auto_merge' as never }));
    await assert.rejects(saveAutofixPolicy('p-bad', { limits: { max_files: -1 } as never }));
    await assert.rejects(saveAutofixPolicy('p-bad', { limits: { max_files: 1.5 } as never }));
    await assert.rejects(saveAutofixPolicy('p-bad', { engine: 'gpt' }));
    assert.equal((await getAutofixPolicy('p-bad')).mode, 'off');
    for (const engine of ['demo', 'claude-code', 'kiro', 'codex']) {
      assert.equal((await saveAutofixPolicy('p-eng', { engine })).engine, engine);
    }
  });

  it('protected_paths: brace and bracket globs, more than 6 wildcard runs or 200 characters are a 400; the defaults are accepted', async () => {
    for (const bad of ['**/*.{key,pem}', 'secrets/[ab]/**', 'a{b,c}/x', 'x]', '*a*a*a*a*a*a*b', 'a/'.repeat(101)]) {
      await assert.rejects(saveAutofixPolicy('p-glob', { protected_paths: [bad] }), (e: any) => e.status === 400 && /protected_paths/.test(e.message), bad);
    }
    await assert.rejects(saveAutofixPolicy('p-glob', { protected_paths: ['**/*.{key,pem}'] }), /only \*, \*\* and \? are supported/);
    await assert.rejects(saveAutofixPolicy('p-glob', { protected_paths: ['**/*.{key,pem}'] }), (e: any) => (e.message.match(/are supported/g) ?? []).length === 1,
      'the supported syntax is named once');
    const ok = await saveAutofixPolicy('p-glob', { protected_paths: [...DEFAULT_POLICY.protected_paths, 'secrets/**', '*a*a*a*a*a*b'] });
    assert.ok(ok.protected_paths.includes('*a*a*a*a*a*b'));
  });
  it('a stored policy with an unsupported protected pattern keeps its other settings; the pattern stays and checkDiff flags it', async () => {
    const { getDb } = await import('../server/db.ts');
    const { setSetting } = await import('../server/settings.ts');
    const { checkDiff } = await import('../server/autofix/guardrails.ts');
    await setSetting(getDb(), 'autofix.policy.p-stored', JSON.stringify({
      mode: 'draft_pr', protected_paths: ['.github/workflows/**', 'secrets/[ab]/**'], limits: { max_files: 7 }, run_as: 'u-1',
    }));
    const p = await getAutofixPolicy('p-stored');
    assert.equal(p.mode, 'draft_pr');
    assert.equal(p.limits.max_files, 7);
    assert.equal(p.run_as, 'u-1');
    assert.ok(p.protected_paths.includes('secrets/[ab]/**'));
    for (const d of DEFAULT_POLICY.protected_paths) assert.ok(p.protected_paths.includes(d), d);
    const r = checkDiff([{ path: 'src/a.ts', added: 1, removed: 0 }], p, 'tests');
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => /unsupported protected pattern: secrets\/\[ab\]\/\*\*/.test(v)), JSON.stringify(r.violations));
    // Saving stays strict, and a corrupt document still reads as the defaults.
    await assert.rejects(saveAutofixPolicy('p-stored2', { protected_paths: ['secrets/[ab]/**'] }), (e: any) => e.status === 400);
    await setSetting(getDb(), 'autofix.policy.p-corrupt', '{not json');
    assert.equal((await getAutofixPolicy('p-corrupt')).mode, 'off');
    await setSetting(getDb(), 'autofix.policy.p-badmode', JSON.stringify({ mode: 'yolo', limits: { max_files: 7 } }));
    assert.equal((await getAutofixPolicy('p-badmode')).mode, 'off');
  });

  it('protected_paths cannot lose the default entries', async () => {
    const saved = await saveAutofixPolicy('p-paths', { protected_paths: ['secrets/**'] });
    for (const d of DEFAULT_POLICY.protected_paths) assert.ok(saved.protected_paths.includes(d), d);
    assert.ok(saved.protected_paths.includes('secrets/**'));
  });

  it('run_as is set to the acting admin when mode first leaves off, and kept afterwards', async () => {
    const a = await saveAutofixPolicy('p-runas', { mode: 'propose' }, { actorId: 'admin-1' });
    assert.equal(a.run_as, 'admin-1');
    const b = await saveAutofixPolicy('p-runas', { mode: 'draft_pr' }, { actorId: 'admin-2' });
    assert.equal(b.run_as, 'admin-1');
    const c = await saveAutofixPolicy('p-runas2', { limits: { max_files: 4 } as never }, { actorId: 'admin-1' });
    assert.equal(c.run_as, '');
  });
});

describe('validation extras', () => {
  it('rejects prototype-ish limit keys and bad classes', async () => {
    await assert.rejects(saveAutofixPolicy('p-v', { limits: JSON.parse('{"constructor":1}') }));
    await assert.rejects(saveAutofixPolicy('p-v', { limits: JSON.parse('{"__proto__":1}') }));
    await assert.rejects(saveAutofixPolicy('p-v', { classes: [''] }));
    await assert.rejects(saveAutofixPolicy('p-v', { classes: ['x'.repeat(41)] }));
    await assert.rejects(saveAutofixPolicy('p-v', { classes: [5 as never] }));
    assert.deepEqual((await saveAutofixPolicy('p-v', { classes: ['lint', 'security'] })).classes, ['lint', 'security']);
  });
});

describe('kill switch', () => {
  it('isPaused is true after the global pause and after the project pause, false after both are cleared', async () => {
    assert.equal(await isPaused('pk'), false);
    await setPaused('global', true);
    assert.equal(await isPaused('pk'), true);
    await setPaused('global', false);
    assert.equal(await isPaused('pk'), false);
    await setPaused('pk', true);
    assert.equal(await isPaused('pk'), true);
    assert.equal(await isPaused('other'), false);
    await setPaused('pk', false);
    assert.equal(await isPaused('pk'), false);
  });
});

describe('routes', () => {
  const url = () => `/api/projects/${projectId}/autofix/policy`;

  it('member may GET, non-member gets 404, anonymous gets 401', async () => {
    const m = await fetchJson(baseUrl, url(), { cookie: memberCookie });
    assert.equal(m.status, 200);
    assert.equal((m.body as { policy: { mode: string } }).policy.mode, 'off');
    assert.equal((await fetchJson(baseUrl, url(), { cookie: outsiderCookie })).status, 404);
    assert.equal((await fetchJson(baseUrl, url())).status, 401);
  });

  it('an editor member gets 403 on PUT and on project pause; non-member gets 404', async () => {
    assert.equal((await fetchJson(baseUrl, url(), { method: 'PUT', body: { mode: 'propose' }, cookie: memberCookie })).status, 403);
    assert.equal((await fetchJson(baseUrl, `/api/projects/${projectId}/autofix/pause`, { body: { paused: true }, cookie: memberCookie })).status, 403);
    assert.equal((await fetchJson(baseUrl, url(), { method: 'PUT', body: { mode: 'propose' }, cookie: outsiderCookie })).status, 404);
    assert.equal((await getAutofixPolicy(projectId)).mode, 'off');
  });

  it('admin PUT saves, sets run_as to the admin and audits; bad input is 400', async () => {
    const r = await fetchJson(baseUrl, url(), { method: 'PUT', body: { mode: 'propose', engine: 'demo' }, cookie: adminCookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pol = (r.body as { policy: { mode: string; run_as: string; engine: string } }).policy;
    assert.equal(pol.mode, 'propose');
    assert.equal(pol.engine, 'demo');
    assert.equal(pol.run_as, adminId);
    const entries = (await audit('autofix.policy.update')).filter((e) => e.target === projectId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].actor_id, adminId);
    assert.equal((entries[0].detail as { mode?: string }).mode, 'propose');
    assert.equal((await fetchJson(baseUrl, url(), { method: 'PUT', body: { mode: 'auto_merge' }, cookie: adminCookie })).status, 400);
    assert.equal((await audit('autofix.policy.update')).filter((e) => e.target === projectId).length, 1);
  });

  it('a non-admin project owner may PUT, and set run_as to themselves only', async () => {
    const pj = (await fetchJson(baseUrl, '/api/projects', { body: { name: 'Owner project' }, cookie: adminCookie })).body as { project: { id: string } };
    const u = `/api/projects/${pj.project.id}/autofix/policy`;
    await fetchJson(baseUrl, `/api/projects/${pj.project.id}/members`, { method: 'POST', body: { userId: ownerId, role: 'owner' }, cookie: adminCookie });
    await fetchJson(baseUrl, `/api/projects/${pj.project.id}/members`, { method: 'POST', body: { userId: viewerId, role: 'viewer' }, cookie: adminCookie });
    await fetchJson(baseUrl, `/api/projects/${pj.project.id}/members`, { method: 'POST', body: { userId: memId, role: 'editor' }, cookie: adminCookie });
    const ok = await fetchJson(baseUrl, u, { method: 'PUT', body: { mode: 'propose' }, cookie: ownerCookie });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((ok.body as { policy: { run_as: string } }).policy.run_as, ownerId);
    const own = await fetchJson(baseUrl, u, { method: 'PUT', body: { run_as: ownerId }, cookie: ownerCookie });
    assert.equal(own.status, 200);
    const other = await fetchJson(baseUrl, u, { method: 'PUT', body: { run_as: adminId }, cookie: ownerCookie });
    assert.equal(other.status, 403);
    assert.equal((await fetchJson(baseUrl, u, { method: 'PUT', body: { run_as: memId }, cookie: ownerCookie })).status, 403);
    assert.equal((await fetchJson(baseUrl, u, { method: 'PUT', body: { run_as: 'nonexistent' }, cookie: ownerCookie })).status, 403);
    // admin: existing editor ok; viewer, non-member and nonexistent rejected
    assert.equal((await fetchJson(baseUrl, u, { method: 'PUT', body: { run_as: memId }, cookie: adminCookie })).status, 200);
    assert.equal((await fetchJson(baseUrl, u, { method: 'PUT', body: { run_as: viewerId }, cookie: adminCookie })).status, 400);
    assert.equal((await fetchJson(baseUrl, u, { method: 'PUT', body: { run_as: 'nonexistent' }, cookie: adminCookie })).status, 400);
    assert.equal((await getAutofixPolicy(pj.project.id)).run_as, memId);
  });

  it('project pause and global pause toggle the flag and audit each change', async () => {
    const pr = await fetchJson(baseUrl, `/api/projects/${projectId}/autofix/pause`, { body: { paused: true }, cookie: adminCookie });
    assert.equal(pr.status, 200, JSON.stringify(pr.body));
    assert.equal(await isPaused(projectId), true);
    await fetchJson(baseUrl, `/api/projects/${projectId}/autofix/pause`, { body: { paused: false }, cookie: adminCookie });
    assert.equal(await isPaused(projectId), false);
    assert.equal((await fetchJson(baseUrl, `/api/projects/${projectId}/autofix/pause`, { body: { paused: 'yes' }, cookie: adminCookie })).status, 400);

    assert.equal((await fetchJson(baseUrl, '/api/autofix/pause', { body: { paused: true }, cookie: memberCookie })).status, 403);
    assert.equal((await fetchJson(baseUrl, '/api/autofix/pause', { body: { paused: true }, cookie: adminCookie })).status, 200);
    assert.equal(await isPaused('anything'), true);
    await fetchJson(baseUrl, '/api/autofix/pause', { body: { paused: false }, cookie: adminCookie });
    assert.equal(await isPaused('anything'), false);

    const entries = await audit('autofix.pause');
    const scoped = entries.filter((e) => e.target === projectId);
    assert.equal(scoped.length, 2);
    assert.equal((scoped[0].detail as { paused?: boolean }).paused, false); // newest first
    assert.equal(entries.filter((e) => e.target === 'global' && e.actor_id === adminId).length, 2);
    assert.equal(scoped[0].actor_id, adminId);
  });
});
