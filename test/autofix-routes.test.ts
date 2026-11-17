import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { run as dbRun } from '../server/db.ts';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getAutofixFindingsRepository } from '../server/repositories/autofix-findings.ts';
import type { AutofixFinding } from '../server/repositories/autofix-findings.ts';

let baseUrl = '';
let adminCookie = '';
let memberCookie = '';
let outsiderCookie = '';
let projectId = '';
let otherProjectId = '';

async function seed(pid: string, fp: string, evidence = 'secret-free evidence'): Promise<AutofixFinding> {
  const { finding } = await getAutofixFindingsRepository().upsertByFingerprint({
    project_id: pid, source: 'ci_failed', kind: 'lint', fingerprint: fp, severity: 'low', evidence, repo_id: null, branch: 'main', commit_sha: null,
  });
  return finding;
}

before(async () => {
  baseUrl = (await createTestServer()).baseUrl;
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@ar.test', password: 'adminpassword1', name: 'Admin' } });
  adminCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@ar.test', password: 'adminpassword1' } })).cookie ?? '';
  for (const e of ['mem@ar.test', 'out@ar.test']) {
    await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: e, name: e, password: 'memberpass1234', isAdmin: false }, cookie: adminCookie });
  }
  memberCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'mem@ar.test', password: 'memberpass1234' } })).cookie ?? '';
  outsiderCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'out@ar.test', password: 'memberpass1234' } })).cookie ?? '';
  const p = await fetchJson(baseUrl, '/api/projects', { body: { name: 'AR project' }, cookie: adminCookie });
  projectId = (p.body as { project: { id: string } }).project.id;
  const p2 = await fetchJson(baseUrl, '/api/projects', { body: { name: 'AR other' }, cookie: adminCookie });
  otherProjectId = (p2.body as { project: { id: string } }).project.id;
  const users = await fetchJson(baseUrl, '/api/users', { cookie: adminCookie });
  const mem = ((users.body as { users: { id: string; email: string }[] }).users).find((u) => u.email === 'mem@ar.test');
  const add = await fetchJson(baseUrl, `/api/projects/${projectId}/members`, { method: 'POST', body: { userId: mem!.id, role: 'viewer' }, cookie: adminCookie });
  assert.ok(add.status < 300, `add member: ${add.status}`);
});

after(cleanup);
beforeEach(() => { dbRun('DELETE FROM autofix_findings'); });

type ListBody = { findings: (AutofixFinding)[]; counts: Record<string, number> };
const list = (q: string, cookie = memberCookie, pid = projectId) => fetchJson(baseUrl, `/api/projects/${pid}/autofix/findings${q}`, { cookie });

describe('autofix findings routes', () => {
  it('a member lists findings with counts for every status; evidence is not in the list', async () => {
    await seed(projectId, 'a');
    await seed(projectId, 'b');
    const r = await list('');
    assert.equal(r.status, 200);
    const b = r.body as ListBody;
    assert.equal(b.findings.length, 2);
    assert.equal(b.counts.new, 2);
    assert.equal(b.counts.resolved, 0);
    assert.equal(Object.keys(b.counts).length, 8);
    for (const f of b.findings) assert.equal('evidence' in f, false);
  });

  it('a non-member gets 404', async () => {
    assert.equal((await list('', outsiderCookie)).status, 404);
    assert.equal((await fetchJson(baseUrl, `/api/projects/${projectId}/autofix/findings/x`, { cookie: outsiderCookie })).status, 404);
  });

  it('filters by status', async () => {
    const f = await seed(projectId, 'a');
    await seed(projectId, 'b');
    await getAutofixFindingsRepository().transition(f.id, ['new'], { status: 'dismissed' });
    const b = (await list('?status=dismissed')).body as ListBody;
    assert.equal(b.findings.length, 1);
    assert.equal(b.findings[0].id, f.id);
  });

  it('unknown status gives 400', async () => {
    assert.equal((await list('?status=bogus')).status, 400);
  });

  it('caps limit at 100, defaults to 50, and rejects a bad limit', async () => {
    for (let i = 0; i < 105; i++) await seed(projectId, `fp${i}`);
    assert.equal(((await list('')).body as ListBody).findings.length, 50);
    assert.equal(((await list('?limit=1000')).body as ListBody).findings.length, 100);
    assert.equal(((await list('?limit=3')).body as ListBody).findings.length, 3);
    assert.equal((await list('?limit=abc')).status, 400);
  });

  it('detail returns the evidence; another project gets 404', async () => {
    const f = await seed(projectId, 'a', 'the evidence');
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/autofix/findings/${f.id}`, { cookie: memberCookie });
    assert.equal(r.status, 200);
    assert.equal((r.body as { finding: AutofixFinding }).finding.evidence, 'the evidence');
    const cross = await fetchJson(baseUrl, `/api/projects/${otherProjectId}/autofix/findings/${f.id}`, { cookie: adminCookie });
    assert.equal(cross.status, 404);
    const missing = await fetchJson(baseUrl, `/api/projects/${projectId}/autofix/findings/nope`, { cookie: memberCookie });
    assert.equal(missing.status, 404);
  });
});
