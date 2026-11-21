import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { getInboxRepository } from '../server/repositories/inbox.ts';
import { getPipelineRunsRepository } from '../server/repositories/pipeline-runs.ts';
import { buildSummary } from '../server/assistant/summary.ts';

let projectId = '';

before(async () => {
  const { baseUrl } = await createTestServer();
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@as.test', password: 'adminpassword1', name: 'Admin' } });
  const admin = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@as.test', password: 'adminpassword1' } })).cookie ?? '';
  const p = await fetchJson(baseUrl, '/api/projects', { body: { name: 'Summary project' }, cookie: admin });
  projectId = (p.body as { project: { id: string } }).project.id;
  const ts = new Date().toISOString();
  for (const [id, status] of [['wf-s-run', 'running'], ['wf-s-fail', 'failed'], ['wf-s-block', 'blocked'], ['wf-s-done', 'done']]) {
    getDb().prepare(`INSERT INTO p6_workflows (id, project_id, goal, title, status, engine, trust_tools, lead_agent, created_at, updated_at)
      VALUES (?, ?, 'secret goal', 'Secret title', ?, 'codex', 0, 'default', ?, ?)`).run(id, projectId, status, ts, ts);
  }
  await getInboxRepository().create({ id: 'inb-s-1', project_id: projectId, workflow_id: null, run_id: null, type: 'blocked', payload: '{}', created_at: ts });
  await getInboxRepository().create({ id: 'inb-s-2', project_id: projectId, workflow_id: null, run_id: null, type: 'blocked', payload: '{}', created_at: ts });
  await getInboxRepository().resolveConditional('inb-s-2', null, ts);
  await getPipelineRunsRepository().upsertRun({
    project_id: projectId, repo_id: 'repo-s', repo_full_name: 'acme/widgets', run_id: 9001, run_attempt: 1, run_number: 3, workflow_id: 7,
    workflow_name: 'Deploy portal', branch: 'main', head_sha: 'abcdef1234567', actor: 'octo', event: 'push', status: 'failure',
    html_url: 'https://github.com/acme/widgets/actions/runs/9001', started_at: ts, completed_at: ts,
  });
});
after(() => cleanup());

describe('buildSummary', () => {
  it('counts workflows by status and unresolved inbox items', async () => {
    const s = await buildSummary(projectId);
    assert.ok(s);
    assert.equal(s.name, 'Summary project');
    assert.equal(s.running, 1);
    assert.equal(s.failed, 1);
    assert.equal(s.blocked, 1);
    assert.equal(s.inbox, 1);
  });
  it('lists the stored pipeline run with repo, workflow, branch and status', async () => {
    const s = await buildSummary(projectId);
    assert.deepEqual(s?.pipelines, [{ repo: 'acme/widgets', workflow: 'Deploy portal', branch: 'main', status: 'failure' }]);
  });
  it('returns null for a missing project', async () => {
    assert.equal(await buildSummary('no-such-project'), null);
  });
  it('has exactly the ProjectSummary keys and no session text', async () => {
    const s = await buildSummary(projectId);
    assert.deepEqual(Object.keys(s!).sort(), ['blocked', 'failed', 'inbox', 'name', 'pipelines', 'running']);
    assert.ok(!JSON.stringify(s).includes('Secret'));
  });
  it('one failing source leaves its field empty', async () => {
    const repo = getPipelineRunsRepository();
    const orig = repo.latestPerBranch;
    repo.latestPerBranch = async () => { throw new Error('down'); };
    try {
      const s = await buildSummary(projectId);
      assert.deepEqual(s?.pipelines, []);
      assert.equal(s?.running, 1);
    } finally { repo.latestPerBranch = orig; }
  });
});
