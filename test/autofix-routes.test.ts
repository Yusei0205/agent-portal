import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { run as dbRun } from '../server/db.ts';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getAuditRepository } from '../server/repositories/audit.ts';
import { getAutofixPolicy, saveAutofixPolicy } from '../server/autofix/policy.ts';
import { _drainPipelineForTest } from '../server/autofix/pipeline.ts';
import { getAutofixFindingsRepository } from '../server/repositories/autofix-findings.ts';
import type { AutofixFinding } from '../server/repositories/autofix-findings.ts';

let baseUrl = '';
let adminCookie = '';
let memberCookie = '';
let outsiderCookie = '';
let ownerCookie = '';
let editorCookie = '';
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
  for (const e of ['mem@ar.test', 'out@ar.test', 'own@ar.test', 'ed@ar.test']) {
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
  for (const [email, role] of [['own@ar.test', 'owner'], ['ed@ar.test', 'editor']] as const) {
    const u = ((users.body as { users: { id: string; email: string }[] }).users).find((x) => x.email === email);
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/members`, { method: 'POST', body: { userId: u!.id, role }, cookie: adminCookie });
    assert.ok(r.status < 300, `add ${role}: ${r.status}`);
  }
  ownerCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'own@ar.test', password: 'memberpass1234' } })).cookie ?? '';
  editorCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'ed@ar.test', password: 'memberpass1234' } })).cookie ?? '';
});

after(cleanup);
beforeEach(async () => {
  dbRun('DELETE FROM autofix_findings');
  await saveAutofixPolicy(projectId, { classes: ['lint', 'tests', 'types', 'build'] });
});

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

describe('autofix finding actions', () => {
  const act = (fid: string, action: string, cookie: string, pid = projectId) =>
    fetchJson(baseUrl, `/api/projects/${pid}/autofix/findings/${fid}/${action}`, { method: 'POST', body: {}, cookie });
  const status = async (id: string) => (await getAutofixFindingsRepository().getById(id))!.status;
  const audits = async (action: string) => (await getAuditRepository().query({ limit: 100, action })).entries;

  it('owner and admin may act; editor and viewer get 403; non-member gets 404; unknown finding 404', async () => {
    for (const action of ['dismiss', 'never-fix', 'retry']) {
      const f = await seed(projectId, `perm-${action}`);
      assert.equal((await act(f.id, action, memberCookie)).status, 403, action);
      assert.equal((await act(f.id, action, editorCookie)).status, 403, action);
      assert.equal((await act(f.id, action, outsiderCookie)).status, 404, action);
      assert.equal((await act('nope', action, adminCookie)).status, 404, action);
      assert.equal((await act(f.id, action, ownerCookie)).status, 200, action);
      await _drainPipelineForTest();
    }
    const g = await seed(projectId, 'perm-admin');
    assert.equal((await act(g.id, 'dismiss', adminCookie)).status, 200);
    const other = await seed(otherProjectId, 'cross');
    assert.equal((await act(other.id, 'dismiss', adminCookie)).status, 404);
  });

  it('dismiss moves a non-terminal finding to dismissed, audits, and 409s on dismissed or resolved', async () => {
    const f = await seed(projectId, 'd1');
    const r = await act(f.id, 'dismiss', adminCookie);
    assert.equal(r.status, 200);
    assert.equal(await status(f.id), 'dismissed');
    assert.ok((await audits('autofix.finding.dismiss')).some((e) => e.target === f.id));
    assert.equal((await act(f.id, 'dismiss', adminCookie)).status, 409);
    const g = await seed(projectId, 'd2');
    await getAutofixFindingsRepository().transition(g.id, ['new'], { status: 'resolved' });
    assert.equal((await act(g.id, 'dismiss', adminCookie)).status, 409);
    assert.equal((await act(g.id, 'never-fix', adminCookie)).status, 409);
    const h = await seed(projectId, 'd3');
    await getAutofixFindingsRepository().transition(h.id, ['new'], { status: 'needs_human' });
    assert.equal((await act(h.id, 'dismiss', adminCookie)).status, 200);
  });

  it('never-fix dismisses and removes the kind from the policy classes, with audit entries', async () => {
    assert.ok((await getAutofixPolicy(projectId)).classes.includes('lint'));
    const f = await seed(projectId, 'n1');
    const r = await act(f.id, 'never-fix', ownerCookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await status(f.id), 'dismissed');
    const pol = await getAutofixPolicy(projectId);
    assert.equal(pol.classes.includes('lint'), false);
    assert.ok(pol.classes.includes('tests'));
    assert.ok((await audits('autofix.finding.never_fix')).some((e) => e.target === f.id));
  });

  it('retry sends needs_human, new and suppressed back to new with attempts and cooldown cleared; other states 409', async () => {
    const repo = getAutofixFindingsRepository();
    for (const from of ['needs_human', 'new', 'suppressed'] as const) {
      const f = await seed(projectId, `r-${from}`);
      await repo.transition(f.id, ['new'], { status: from, attempts: 2, cooldown_until: new Date(Date.now() + 3600_000).toISOString() });
      const r = await act(f.id, 'retry', adminCookie);
      assert.equal(r.status, 200, `${from}: ${JSON.stringify(r.body)}`);
      await _drainPipelineForTest();
      const after = (await repo.getById(f.id))!;
      assert.equal(after.status, 'new', from);
      assert.equal(after.attempts, 0);
      assert.equal(after.cooldown_until, null);
    }
    assert.ok((await audits('autofix.finding.retry')).length >= 3);
    for (const from of ['dismissed', 'resolved', 'pr_open', 'fixing', 'triaged'] as const) {
      const f = await seed(projectId, `r409-${from}`);
      await repo.transition(f.id, ['new'], { status: from });
      assert.equal((await act(f.id, 'retry', adminCookie)).status, 409, from);
    }
  });

  it('retrying a needs_human finding whose PR is not open (closed, or unreadable) clears pr_branch and pr_head_sha; an open PR keeps them', async () => {
    const { _setPullRequestClients } = await import('../server/pull-requests.ts');
    const { getGitReposRepository } = await import('../server/repositories/git-repos.ts');
    const repoId = `repo-ar-${Date.now()}`;
    await getGitReposRepository().create({
      id: repoId, project_id: projectId, name: 'shop', url: 'https://github.com/acme/shop.git', provider: 'github', status: 'ready',
      default_branch: 'main', identity: null, last_synced_at: null, last_error: null, created_at: new Date().toISOString(), connection_id: null,
    });
    const repo = getAutofixFindingsRepository();
    let state: string | null = 'closed';
    _setPullRequestClients({
      credentials: async () => ({ kind: 'github' as const, token: 't' }),
      fetch: (async () => (state === null ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ state }), { status: 200 }))) as typeof fetch,
    });
    try {
      for (const [s, keep] of [['closed', false], [null, false], ['open', true]] as const) {
        state = s;
        const { finding: f } = await repo.upsertByFingerprint({
          project_id: projectId, source: 'ci_failed', kind: 'lint', fingerprint: `rpr-${s}`, severity: 'low', evidence: 'e', repo_id: repoId, branch: 'main', commit_sha: null,
        });
        await repo.transition(f.id, ['new'], { status: 'needs_human', pr_branch: 'autofix/lint-1', pr_number: 9, pr_url: 'https://github.com/acme/shop/pull/9', pr_head_sha: 'a'.repeat(40) });
        assert.equal((await act(f.id, 'retry', adminCookie)).status, 200);
        await _drainPipelineForTest();
        const got = (await repo.getById(f.id))!;
        assert.equal(got.pr_branch, keep ? 'autofix/lint-1' : null, String(s));
        assert.equal(got.pr_head_sha, keep ? 'a'.repeat(40) : null, String(s));
        assert.equal(got.pr_number, 9, 'the PR number stays for history');
      }
    } finally { _setPullRequestClients(); }
  });
});
