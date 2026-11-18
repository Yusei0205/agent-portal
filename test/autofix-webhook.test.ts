import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { run as dbRun } from '../server/db.ts';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getGitReposRepository } from '../server/repositories/git-repos.ts';
import { getAutofixFindingsRepository } from '../server/repositories/autofix-findings.ts';
import { saveAutofixPolicy, setPaused } from '../server/autofix/policy.ts';
import { _setEvidenceFetcher, _drainIntakeForTest } from '../server/autofix/webhook.ts';
import { fetchCiEvidence, _setGithubFetch } from '../server/autofix/intake.ts';

let baseUrl = '';
let adminCookie = '';
let projectId = '';
let secret = '';

const fx = (n: string): string => fs.readFileSync(new URL(`./fixtures/github/${n}.json`, import.meta.url), 'utf8');
const sign = (body: string, s = secret): string => 'sha256=' + crypto.createHmac('sha256', s).update(body).digest('hex');

async function deliver(body: string, event = 'workflow_run', sig = sign(body), pid = projectId): Promise<number> {
  const r = await fetch(`${baseUrl}/api/hooks/autofix/${pid}`, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sig },
  });
  await _drainIntakeForTest();
  return r.status;
}
const findings = () => getAutofixFindingsRepository().list(projectId, { limit: 50 });

before(async () => {
  baseUrl = (await createTestServer()).baseUrl;
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@wh.test', password: 'adminpassword1', name: 'Admin' } });
  adminCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@wh.test', password: 'adminpassword1' } })).cookie ?? '';
  await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: 'mem@wh.test', name: 'm', password: 'memberpass1234', isAdmin: false }, cookie: adminCookie });
  const p = await fetchJson(baseUrl, '/api/projects', { body: { name: 'WH project' }, cookie: adminCookie });
  projectId = (p.body as { project: { id: string } }).project.id;
  await getGitReposRepository().create({
    id: 'repo-wh-1', project_id: projectId, name: 'widgets', url: 'https://github.com/acme/widgets.git', provider: 'github', status: 'ready',
    default_branch: 'main', identity: null, last_synced_at: null, last_error: null, created_at: new Date().toISOString(), connection_id: null,
  });
  const rot = await fetchJson(baseUrl, `/api/projects/${projectId}/autofix/webhook-secret`, { method: 'POST', body: {}, cookie: adminCookie });
  assert.equal(rot.status, 200);
  secret = (rot.body as { secret: string }).secret;
  assert.ok(secret.length >= 32);
});

after(cleanup);

beforeEach(async () => {
  _setEvidenceFetcher(async () => 'src/a.ts(1,1): error TS2322: bad');
  dbRun('DELETE FROM autofix_findings');
  await saveAutofixPolicy(projectId, { mode: 'propose', verify: { command: 'npm test', quick_commands: [] } });
  await setPaused(projectId, false);
});

describe('autofix webhook', () => {
  it('a valid signature creates one finding', async () => {
    assert.equal(await deliver(fx('workflow_run_failed_main')), 202);
    const f = await findings();
    assert.equal(f.length, 1);
    assert.equal(f[0].status, 'new');
    assert.equal(f[0].kind, 'lint');
    assert.equal(f[0].repo_id, 'repo-wh-1');
    assert.equal(f[0].branch, 'main');
  });

  it('the same delivery twice creates one finding with occurrences 2', async () => {
    await deliver(fx('workflow_run_failed_main'));
    await deliver(fx('workflow_run_failed_main'));
    const f = await findings();
    assert.equal(f.length, 1);
    assert.equal(f[0].occurrences, 2);
  });

  it('a wrong signature returns 401 and stores nothing; an unknown project gives the same 401', async () => {
    const body = fx('workflow_run_failed_main');
    assert.equal(await deliver(body, 'workflow_run', sign(body, 'other')), 401);
    assert.equal(await deliver(body, 'workflow_run', undefined, 'nope'), 401);
    assert.equal((await findings()).length, 0);
  });

  it('a repository that is not in the project returns 404 and stores nothing', async () => {
    const body = fx('workflow_run_failed_main').replace('acme/widgets', 'acme/other');
    assert.equal(await deliver(body), 404);
    assert.equal((await findings()).length, 0);
  });

  it("a project with mode 'off' stores the finding as 'suppressed'", async () => {
    await saveAutofixPolicy(projectId, { mode: 'off' });
    await deliver(fx('workflow_run_failed_main'));
    assert.equal((await findings())[0].status, 'suppressed');
  });

  it("a paused project stores it as 'new'", async () => {
    await setPaused(projectId, true);
    await deliver(fx('workflow_run_failed_main'));
    assert.equal((await findings())[0].status, 'new');
  });

  it('a resolved finding that recurs goes back to new; a dismissed one in cooldown stays', async () => {
    await deliver(fx('workflow_run_failed_main'));
    const repo = getAutofixFindingsRepository();
    const id = (await findings())[0].id;
    await repo.transition(id, ['new'], { status: 'resolved' });
    await deliver(fx('workflow_run_failed_main'));
    assert.equal((await repo.getById(id))!.status, 'new');
    await repo.transition(id, ['new'], { status: 'dismissed', cooldown_until: new Date(Date.now() + 3600_000).toISOString() });
    await deliver(fx('workflow_run_failed_main'));
    const f = (await repo.getById(id))!;
    assert.equal(f.status, 'dismissed');
    assert.equal(f.occurrences, 3);
  });

  it('a fetch that fails once and then succeeds still dedupes to one finding', async () => {
    let n = 0;
    _setEvidenceFetcher(async () => (n++ === 0 ? 'CI / eslint failure' : 'long log tail 12 errors in 3.4s\nsrc/x.ts'));
    await deliver(fx('workflow_run_failed_main'));
    await deliver(fx('workflow_run_failed_main'));
    const f = await findings();
    assert.equal(f.length, 1);
    assert.equal(f[0].occurrences, 2);
  });

  it('two concurrent deliveries of the same payload create one finding with occurrences 2', async () => {
    const body = fx('workflow_run_failed_main');
    const rs = await Promise.all([0, 1].map(() => fetch(`${baseUrl}/api/hooks/autofix/${projectId}`, {
      method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'workflow_run', 'x-hub-signature-256': sign(body) },
    })));
    assert.deepEqual(rs.map((r) => r.status), [202, 202]);
    await _drainIntakeForTest();
    const f = await findings();
    assert.equal(f.length, 1);
    assert.equal(f[0].occurrences, 2);
  });

  it('a finding being fixed keeps its evidence and commit; only the counter moves', async () => {
    await deliver(fx('workflow_run_failed_main'));
    const repo = getAutofixFindingsRepository();
    const first = (await findings())[0];
    await repo.transition(first.id, ['new'], { status: 'fixing' });
    _setEvidenceFetcher(async () => 'different evidence');
    await deliver(fx('workflow_run_failed_main').replace('a1b2c3d4e5f6', 'ffffffffffff'));
    const f = (await repo.getById(first.id))!;
    assert.equal(f.status, 'fixing');
    assert.equal(f.occurrences, 2);
    assert.equal(f.evidence, first.evidence);
    assert.equal(f.commit_sha, first.commit_sha);
  });

  it('autofix branch failures, ping and success store nothing', async () => {
    await deliver(fx('workflow_run_failed_autofix'));
    await deliver(fx('ping'), 'ping');
    await deliver(fx('workflow_run_success_main'));
    assert.equal((await findings()).length, 0);
  });

  it('CodeCommit repos never produce findings', async () => {
    await getGitReposRepository().create({
      id: 'repo-cc', project_id: projectId, name: 'cc', url: 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/acme-cc', provider: 'codecommit', status: 'ready',
      default_branch: 'main', identity: null, last_synced_at: null, last_error: null, created_at: new Date().toISOString(), connection_id: null,
    });
    assert.equal(await deliver(fx('workflow_run_failed_main').replace('acme/widgets', 'acme-cc')), 404);
    assert.equal((await findings()).length, 0);
  });

  it('only owners or admins can rotate the secret', async () => {
    const mem = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'mem@wh.test', password: 'memberpass1234' } })).cookie ?? '';
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/autofix/webhook-secret`, { method: 'POST', body: {}, cookie: mem });
    assert.ok([403, 404].includes(r.status));
  });
});

describe('fetchCiEvidence', () => {
  const cand = { repoFullName: 'acme/widgets', branch: 'main', headSha: 'abc', source: 'ci_failed' as const, kind: 'tests', severity: 'medium' as const, errorText: 'CI failed', runId: 5 };
  it('reads the failed job log tail, scrubbed and bounded', async () => {
    _setGithubFetch(async (url: string) => {
      if (url.endsWith('/actions/runs/5/jobs?per_page=100')) {
        return new Response(JSON.stringify({ jobs: [{ id: 11, name: 'ok', conclusion: 'success' }, { id: 12, name: 'unit', conclusion: 'failure' }] }), { status: 200 });
      }
      if (url.endsWith('/actions/jobs/12/logs')) return new Response('x'.repeat(20000) + '\nFAIL token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 done', { status: 200 });
      return new Response('', { status: 404 });
    });
    const e = await fetchCiEvidence(cand, projectId);
    assert.ok(e.length <= 8000);
    assert.ok(e.includes('FAIL'));
    assert.ok(!e.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  });
  it('falls back to a short string when the fetch fails', async () => {
    _setGithubFetch(async () => { throw new Error('network down'); });
    const e = await fetchCiEvidence(cand, projectId);
    assert.match(e, /tests/);
    assert.match(e, /failure/);
  });
  after(() => _setGithubFetch(null));
});
