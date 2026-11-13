/**
 * The portal side of the Build code graph button: the job that asks the runner, the state it keeps, what the page reads, and
 * the refusals where it cannot run (a local portal has no cloud runner).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { setSetting } from '../server/settings.ts';
import { getGitReposRepository } from '../server/repositories/git-repos.ts';
import { runBackgroundJobNow } from '../server/background-jobs.ts';
import { _setAgentCoreInvokerOverride, type AgentCoreSSEEvent } from '../server/agent/kiro-agentcore.ts';
import { getCodeGraphStatus, savedGraphFor, graphBuildUnavailable } from '../server/code-graph.ts';

const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/kiro-x';

describe('Build code graph (portal)', () => {
  let baseUrl = '';
  let cookie = '';
  let projectId = '';
  const saved = process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN;

  async function addRepo(id: string, url: string): Promise<void> {
    await getGitReposRepository().create({ id, project_id: projectId, name: id, url, provider: 'git', status: 'ready', default_branch: 'main', identity: null, last_synced_at: null, last_error: null, created_at: new Date().toISOString(), connection_id: null });
  }

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `cg-${Date.now()}@test.com`, name: 'A', password: 'password1234', provider: 'demo' } });
    cookie = setup.cookie ?? '';
    const pr = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `CG ${Date.now()}` }, cookie });
    projectId = ((pr.body as { project: { id: string } }).project).id;
  });
  after(async () => {
    _setAgentCoreInvokerOverride(null);
    if (saved === undefined) delete process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN; else process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = saved;
    await cleanup();
  });

  it('a local portal says it cannot build, and the button route refuses', async () => {
    delete process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN;
    assert.match(String(graphBuildUnavailable()), /cloud portal/);
    await addRepo('gr_local', 'https://example.com/local.git');
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/code-map/gr_local/build`, { method: 'POST', body: {}, cookie });
    assert.equal(r.status, 400);
    assert.match(String((r.body as { error?: string }).error), /cloud portal/);
  });

  it('a finished build is ready, with its size and commit, and the list shows it', async () => {
    process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = ARN;
    await addRepo('gr_ok', 'https://example.com/ok.git');
    let payload: Record<string, unknown> | null = null;
    _setAgentCoreInvokerOverride(async function* (_arn, _sid, p) {
      payload = p;
      yield { type: 'status', text: 'Building the code graph of gr_ok…' } as AgentCoreSSEEvent;
      yield { type: 'result', runId: 'r', success: true, commit: 'abcdef1234567890', nodes: 120, links: 340, bytes: 5000, stored: false } as unknown as AgentCoreSSEEvent;
    });
    await runBackgroundJobNow('build-code-graph', { projectId, repoId: 'gr_ok' });

    const st = getCodeGraphStatus('gr_ok');
    assert.equal(st?.state, 'ready');
    assert.equal(st?.nodes, 120);
    assert.equal(st?.commit, 'abcdef1234567890');
    assert.equal(st?.stored, false, 'no S3 here, so nothing is saved for sessions');
    assert.equal((payload as unknown as { mode: string }).mode, 'build-graph');
    assert.equal(((payload as unknown as { repos: unknown[] }).repos).length, 1);
    assert.equal(await savedGraphFor(projectId, 'gr_ok'), null, 'sessions get no link for a graph that was not saved');

    const list = (await fetchJson(baseUrl, `/api/projects/${projectId}/code-map`, { cookie })).body as { repos: { id: string; graph: { state: string } | null }[] };
    assert.equal(list.repos.find((x) => x.id === 'gr_ok')?.graph?.state, 'ready');
    const one = (await fetchJson(baseUrl, `/api/projects/${projectId}/code-map/gr_ok/graph-status`, { cookie })).body as { status: { state: string } };
    assert.equal(one.status.state, 'ready');
  });

  it('a refused CodeCommit clone fails with what to update', async () => {
    process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = ARN;
    await addRepo('gr_403', 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/x');
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'status', text: "Could not clone gr_403 (git exited with code 128): fatal: unable to access 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/x/': The requested URL returned error: 403" } as AgentCoreSSEEvent;
      yield { type: 'result', runId: 'r', success: false, error: 'The repository could not be cloned' } as unknown as AgentCoreSSEEvent;
    });
    await runBackgroundJobNow('build-code-graph', { projectId, repoId: 'gr_403' });
    const st = getCodeGraphStatus('gr_403');
    assert.equal(st?.state, 'failed');
    assert.match(String(st?.message), /Workspaces → AWS/);
  });

  it('a graphify that did not finish fails with its reason, and keeps what an earlier build saved', async () => {
    process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = ARN;
    await addRepo('gr_slow', 'https://example.com/slow.git');
    await setSetting(getDb(), 'codegraph.gr_slow', JSON.stringify({ state: 'ready', at: new Date().toISOString(), message: '', stored: true, version: '2026-11-01T00:00:00.000Z', nodes: 9 }));
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'result', runId: 'r', success: false, error: 'graphify did not finish within 25 minutes' } as unknown as AgentCoreSSEEvent;
    });
    await runBackgroundJobNow('build-code-graph', { projectId, repoId: 'gr_slow' });
    const st = getCodeGraphStatus('gr_slow');
    assert.equal(st?.state, 'failed');
    assert.match(String(st?.message), /did not finish within 25 minutes/);
    assert.equal(st?.stored, true, 'the earlier graph stays available to sessions');
    assert.equal(st?.version, '2026-11-01T00:00:00.000Z');
  });

  it('a build that never reports progress is shown as lost after the longest a build may take', async () => {
    await setSetting(getDb(), 'codegraph.gr_lost', JSON.stringify({ state: 'running', at: new Date(Date.now() - 76 * 60_000).toISOString(), message: 'Building…' }));
    const st = getCodeGraphStatus('gr_lost');
    assert.equal(st?.state, 'failed');
    assert.match(String(st?.message), /did not finish/);
    await setSetting(getDb(), 'codegraph.gr_slow', JSON.stringify({ state: 'running', at: new Date(Date.now() - 50 * 60_000).toISOString(), message: 'Building…' }));
    assert.equal(getCodeGraphStatus('gr_slow')?.state, 'running');
  });

  it('a build that reports progress stays running for an hour, and is lost 20 minutes after its last report', async () => {
    const at = new Date(Date.now() - 60 * 60_000).toISOString();
    await setSetting(getDb(), 'codegraph.gr_prog', JSON.stringify({ state: 'running', at, updated: new Date(Date.now() - 30_000).toISOString(), percent: 42, message: 'x' }));
    assert.equal(getCodeGraphStatus('gr_prog')?.state, 'running');
    await setSetting(getDb(), 'codegraph.gr_prog2', JSON.stringify({ state: 'running', at, updated: new Date(Date.now() - 21 * 60_000).toISOString(), percent: 42, message: 'x' }));
    assert.equal(getCodeGraphStatus('gr_prog2')?.state, 'failed');
  });

});
