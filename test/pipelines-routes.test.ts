import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { getGitReposRepository } from '../server/repositories/git-repos.ts';
import { getPipelineRunsRepository, setPipelineRunsRepository } from '../server/repositories/pipeline-runs.ts';
import { getInboxRepository } from '../server/repositories/inbox.ts';
import { saveAutofixPolicy } from '../server/autofix/policy.ts';
import { _drainIntakeForTest } from '../server/autofix/webhook.ts';
import { _setChatFetch, _setChatBackoff } from '../server/pipelines/chat.ts';
import { getAuditRepository } from '../server/repositories/audit.ts';

const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdWXYZ';
let baseUrl = '';
let admin = '', member = '', owner = '', outsider = '';
let projectId = '', secret = '';
let sent: string[] = [];

const sign = (b: string): string => 'sha256=' + crypto.createHmac('sha256', secret).update(b).digest('hex');
function payload(over: { repo?: string; branch?: string; runId?: number; runNumber?: number; conclusion?: string; name?: string } = {}): string {
  const repo = over.repo ?? 'acme/widgets';
  return JSON.stringify({
    action: 'completed', repository: { full_name: repo, default_branch: 'main' },
    workflow_run: {
      id: over.runId ?? 500, run_attempt: 1, run_number: over.runNumber ?? 5, workflow_id: 77, name: over.name ?? 'Deploy portal',
      head_branch: over.branch ?? 'main', head_repository: { full_name: repo }, head_sha: 'abcdef1234567890', actor: { login: 'dev' }, event: 'push', status: 'completed',
      conclusion: over.conclusion ?? 'failure', html_url: 'https://github.com/acme/widgets/actions/runs/500',
      run_started_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:05:00Z',
    },
  });
}
async function deliver(body: string, sig = sign(body), pid = projectId): Promise<number> {
  const r = await fetch(`${baseUrl}/api/hooks/autofix/${pid}`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'workflow_run', 'x-hub-signature-256': sig },
  });
  await _drainIntakeForTest();
  return r.status;
}
const api = (path: string, cookie: string, method = 'GET', body?: unknown) =>
  fetchJson(baseUrl, `/api/projects/${projectId}/pipelines${path}`, { method, cookie, ...(body !== undefined ? { body } : {}) });
const storedCount = async () => (await getPipelineRunsRepository().latestPerBranch(projectId)).length;

before(async () => {
  baseUrl = (await createTestServer()).baseUrl;
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@pr.test', password: 'adminpassword1', name: 'Admin' } });
  admin = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@pr.test', password: 'adminpassword1' } })).cookie ?? '';
  for (const e of ['mem@pr.test', 'own@pr.test', 'out@pr.test']) {
    await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: e, name: e, password: 'memberpass1234', isAdmin: false }, cookie: admin });
  }
  const login = async (e: string) => (await fetchJson(baseUrl, '/api/auth/login', { body: { email: e, password: 'memberpass1234' } })).cookie ?? '';
  member = await login('mem@pr.test'); owner = await login('own@pr.test'); outsider = await login('out@pr.test');
  const p = await fetchJson(baseUrl, '/api/projects', { body: { name: 'PR project' }, cookie: admin });
  projectId = (p.body as { project: { id: string } }).project.id;
  const users = ((await fetchJson(baseUrl, '/api/users', { cookie: admin })).body as { users: { id: string; email: string }[] }).users;
  for (const [email, role] of [['mem@pr.test', 'viewer'], ['own@pr.test', 'owner']] as const) {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/members`, { method: 'POST', body: { userId: users.find((u) => u.email === email)!.id, role }, cookie: admin });
    assert.ok(r.status < 300);
  }
  const mk = (id: string, name: string, url: string, provider = 'github') => getGitReposRepository().create({
    id, project_id: projectId, name, url, provider, status: 'ready', default_branch: 'main', identity: null, last_synced_at: null,
    last_error: null, created_at: new Date().toISOString(), connection_id: null,
  });
  await mk('repo-pr-1', 'widgets', 'https://github.com/acme/widgets.git');
  await mk('repo-pr-2', 'empty', 'https://github.com/acme/empty.git');
  await mk('repo-pr-cc', 'cc', 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/acme-cc', 'codecommit');
  secret = ((await fetchJson(baseUrl, `/api/projects/${projectId}/autofix/webhook-secret`, { method: 'POST', body: {}, cookie: admin })).body as { secret: string }).secret;
});
after(() => { _setChatFetch(null); _setChatBackoff(null); return cleanup(); });
beforeEach(() => {
  sent = []; _setChatBackoff([0, 0]);
  _setChatFetch((async (_u: string, init: RequestInit) => {
    sent.push(String(JSON.parse(String(init.body)).text));
    return { status: 200, ok: true } as Response;
  }) as typeof fetch);
  getDb().prepare('DELETE FROM pipeline_runs').run();
  getDb().prepare('DELETE FROM pipeline_alerts').run();
});

describe('workflow_run webhook wiring', () => {
  it('stores and alerts with Auto-fix mode off', async () => {
    await saveAutofixPolicy(projectId, { mode: 'off' });
    await fetchJson(baseUrl, `/api/projects/${projectId}/pipelines/chat`, { method: 'PUT', body: { url: SLACK }, cookie: owner });
    assert.equal(await deliver(payload()), 202);
    assert.equal(await storedCount(), 1);
    const items = (await getInboxRepository().listUnresolvedByProjects([projectId], { limit: 50 })).items;
    assert.equal(items.length, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^Deploy failed: Deploy portal on acme\/widgets@main/);
  });
  it('a bad signature is 401 and stores nothing', async () => {
    assert.equal(await deliver(payload(), 'sha256=' + '0'.repeat(64)), 401);
    assert.equal(await storedCount(), 0);
  });
  it('a repository outside the project is 404 and stores nothing', async () => {
    assert.equal(await deliver(payload({ repo: 'acme/other', name: 'CI / eslint' })), 404);
    assert.equal(await storedCount(), 0);
  });
  it('the pipeline lookup cannot change the Auto-fix answer: a failing repo lookup still answers 202 ignored', async () => {
    const p = JSON.parse(payload({ conclusion: 'success' }));
    p.action = 'in_progress'; p.workflow_run.status = 'in_progress'; p.workflow_run.conclusion = null;
    const body = JSON.stringify(p);
    const repos = getGitReposRepository();
    const orig = repos.listByProject;
    repos.listByProject = async () => { throw new Error('database unavailable'); };
    try {
      const r = await fetch(`${baseUrl}/api/hooks/autofix/${projectId}`, {
        method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'workflow_run', 'x-hub-signature-256': sign(body) },
      });
      assert.equal(r.status, 202);
      assert.deepEqual(await r.json(), { ok: true, ignored: true });
      await _drainIntakeForTest();
    } finally {
      repos.listByProject = orig;
    }
    assert.equal(await storedCount(), 0);
  });
  it('the pipeline work is registered with the request, so it finishes before the response (Lambda)', async () => {
    const real = getPipelineRunsRepository();
    const slow = Object.create(real) as typeof real;
    slow.upsertRun = async (input) => { await new Promise((r) => setTimeout(r, 150)); return real.upsertRun(input); };
    setPipelineRunsRepository(slow);
    try {
      const body = payload({ conclusion: 'success' });
      const r = await fetch(`${baseUrl}/api/hooks/autofix/${projectId}`, {
        method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'workflow_run', 'x-hub-signature-256': sign(body) },
      });
      assert.equal(r.status, 202);
      // No drain here: the run must already be stored when the response arrives.
      assert.equal((await real.latestPerBranch(projectId)).length, 1);
    } finally {
      await _drainIntakeForTest();
      setPipelineRunsRepository(real);
    }
  });
});

describe('pipelines routes', () => {
  it('permission matrix', async () => {
    assert.equal((await api('', member)).status, 200);
    assert.equal((await api('/settings', member)).status, 200);
    assert.equal((await api('', outsider)).status, 404);
    assert.equal((await fetchJson(baseUrl, `/api/projects/${projectId}/pipelines`, {})).status, 401);
    for (const [path, method, body] of [['/settings', 'PUT', {}], ['/chat', 'PUT', { url: null }], ['/chat/test', 'POST', {}]] as const) {
      assert.equal((await api(path, member, method, body)).status, 403, path);
      assert.equal((await api(path, outsider, method, body)).status, 404, path);
    }
    assert.equal((await api('/settings', owner, 'PUT', { alert_branches: ['release'] })).status, 200);
    assert.equal((await api('/settings', admin, 'PUT', { alert_branches: [] })).status, 200);
    assert.equal((await api('/chat', owner, 'PUT', { url: null })).status, 200);
  });

  it('lists every GitHub repo (no CodeCommit), default/alerting branches unless all=1', async () => {
    assert.equal(((await api('', member)).body as { webhookSeen: boolean }).webhookSeen, false);
    await deliver(payload({ runId: 1, runNumber: 1, conclusion: 'success' }));
    await deliver(payload({ runId: 2, runNumber: 2, branch: 'feature/x', conclusion: 'success' }));
    type Body = { webhookSeen: boolean; repos: { repoId: string; fullName: string; defaultBranch: string; runs: { branch: string }[] }[] };
    const b = (await api('', member)).body as Body;
    assert.equal(b.webhookSeen, true);
    assert.deepEqual(b.repos.map((r) => r.fullName).sort(), ['acme/empty', 'acme/widgets']);
    assert.deepEqual(b.repos.find((r) => r.repoId === 'repo-pr-1')!.runs.map((r) => r.branch), ['main']);
    assert.equal(b.repos.find((r) => r.repoId === 'repo-pr-2')!.runs.length, 0);
    const all = (await api('?all=1', member)).body as Body;
    assert.equal(all.repos.find((r) => r.repoId === 'repo-pr-1')!.runs.length, 2);
  });

  it('history validates its inputs and is limited to the project', async () => {
    await deliver(payload());
    const q = (s: string) => api(`/history?${s}`, member);
    assert.equal((await q('repoId=repo-pr-1&workflowId=77&branch=main')).status, 200);
    assert.equal(((await q('repoId=repo-pr-1&workflowId=77&branch=main')).body as { runs: unknown[] }).runs.length, 1);
    assert.equal((await q('repoId=nope&workflowId=77&branch=main')).status, 404);
    assert.equal((await q('repoId=repo-pr-cc&workflowId=77&branch=main')).status, 404);
    assert.equal((await q('repoId=repo-pr-1&workflowId=0&branch=main')).status, 400);
    assert.equal((await q('repoId=repo-pr-1&workflowId=x&branch=main')).status, 400);
    assert.equal((await q('repoId=repo-pr-1&workflowId=77&branch=')).status, 400);
    assert.equal((await q(`repoId=repo-pr-1&workflowId=77&branch=${'a'.repeat(201)}`)).status, 400);
  });

  it('never returns the chat URL; a bad URL is 400 without echoing it; the test message uses the chat seam', async () => {
    assert.equal((await api('/chat/test', owner, 'POST', {})).status, 400);
    const bad = await api('/chat', owner, 'PUT', { url: 'http://evil.example/secret-token-123' });
    assert.equal(bad.status, 400);
    assert.equal(JSON.stringify(bad.body).includes('secret-token-123'), false);
    assert.equal((await api('/chat', owner, 'PUT', { url: SLACK })).status, 200);
    const s = await api('/settings', member);
    const text = JSON.stringify(s.body);
    assert.equal(text.includes('T000'), false);
    assert.deepEqual((s.body as { chat: { hint: unknown } }).chat.hint, { host: 'hooks.slack.com', last4: 'WXYZ' });
    const t = await api('/chat/test', owner, 'POST', {});
    assert.deepEqual(t.body, { ok: true });
    assert.deepEqual(sent, ['Test message from Agent Portal']);
    const audit = JSON.stringify(await getAuditRepository().query({ limit: 50 } as never));
    assert.equal(audit.includes('T000'), false);
    assert.equal((await api('/chat', owner, 'PUT', { url: null })).status, 200);
    assert.equal(((await api('/settings', member)).body as { chat: { hint: unknown } }).chat.hint, null);
  });

  it('one GitHub rule: a git-provider repo with a github.com URL is listed; CodeCommit never is', async () => {
    const mk = (id: string, name: string, url: string, provider: string) => getGitReposRepository().create({
      id, project_id: projectId, name, url, provider, status: 'ready', default_branch: 'main', identity: null, last_synced_at: null,
      last_error: null, created_at: new Date().toISOString(), connection_id: null,
    });
    await mk('repo-pr-git', 'gitprov', 'https://github.com/acme/gitprov.git', 'git');
    await mk('repo-pr-ccgh', 'ccgh', 'https://github.com/acme/ccgh.git', 'codecommit');
    try {
      assert.equal(await deliver(payload({ repo: 'acme/gitprov', runId: 900, runNumber: 9, conclusion: 'success' })), 202);
      const b = (await api('', member)).body as { repos: { repoId: string; fullName: string; runs: unknown[] }[] };
      const git = b.repos.find((r) => r.repoId === 'repo-pr-git');
      assert.ok(git, 'git-provider GitHub repo is listed');
      assert.equal(git.fullName, 'acme/gitprov');
      assert.equal(git.runs.length, 1);
      assert.equal(b.repos.some((r) => r.repoId === 'repo-pr-cc' || r.repoId === 'repo-pr-ccgh'), false);
      const h = await api('/history?repoId=repo-pr-git&workflowId=77&branch=main', member);
      assert.equal(h.status, 200);
      assert.equal((h.body as { runs: unknown[] }).runs.length, 1);
      assert.equal((await api('/history?repoId=repo-pr-ccgh&workflowId=77&branch=main', member)).status, 404);
    } finally {
      await getGitReposRepository().delete('repo-pr-git', projectId);
      await getGitReposRepository().delete('repo-pr-ccgh', projectId);
    }
  });
});
