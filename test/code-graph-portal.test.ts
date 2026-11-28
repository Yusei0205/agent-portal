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
import { getCodeGraphStatus, savedGraphFor, graphBuildUnavailable, resolveGraphId, listCodeGraphs, MAX_BRANCH_GRAPHS, graphObjectKey } from '../server/code-graph.ts';
import { graphIdFor, parseGraphId, validBranch } from '../server/graph-id.ts';

const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/kiro-x';

/** The state of a repository's graph of its default branch (the tests' repositories use 'main'). */
const mainStatus = (repoId: string) => getCodeGraphStatus(resolveGraphId(repoId, 'main', 'main') ?? '');

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

    const st = mainStatus('gr_ok');
    assert.equal(st?.state, 'ready');
    assert.equal(st?.nodes, 120);
    assert.equal(st?.commit, 'abcdef1234567890');
    assert.equal(st?.stored, false, 'no S3 here, so nothing is saved for sessions');
    assert.equal((payload as unknown as { mode: string }).mode, 'build-graph');
    assert.equal(((payload as unknown as { repos: unknown[] }).repos).length, 1);
    assert.equal(await savedGraphFor(projectId, 'gr_ok', 'main'), null, 'sessions get no link for a graph that was not saved');

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
    const st = mainStatus('gr_403');
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
    const st = mainStatus('gr_slow');
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
    assert.equal(mainStatus('gr_slow')?.state, 'running');
  });

  it('a build that reports progress stays running for an hour, and is lost 20 minutes after its last report', async () => {
    const at = new Date(Date.now() - 60 * 60_000).toISOString();
    await setSetting(getDb(), 'codegraph.gr_prog', JSON.stringify({ state: 'running', at, updated: new Date(Date.now() - 30_000).toISOString(), percent: 42, message: 'x' }));
    assert.equal(getCodeGraphStatus('gr_prog')?.state, 'running');
    await setSetting(getDb(), 'codegraph.gr_prog2', JSON.stringify({ state: 'running', at, updated: new Date(Date.now() - 21 * 60_000).toISOString(), percent: 42, message: 'x' }));
    assert.equal(getCodeGraphStatus('gr_prog2')?.state, 'failed');
  });

  it('builds a branch of its own, next to the default branch, and a session gets the graph of the branch it clones', async () => {
    process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = ARN;
    await addRepo('gr_br', 'https://example.com/br.git');
    const payloads: Record<string, unknown>[] = [];
    _setAgentCoreInvokerOverride(async function* (_arn, _sid, p) {
      payloads.push(p);
      yield { type: 'result', runId: 'r', success: true, commit: 'c1', nodes: 10, links: 20, bytes: 100, stored: true } as unknown as AgentCoreSSEEvent;
    });
    await runBackgroundJobNow('build-code-graph', { projectId, repoId: 'gr_br', branch: '' });
    await runBackgroundJobNow('build-code-graph', { projectId, repoId: 'gr_br', branch: 'feature/login' });

    const branchesBuilt = payloads.map((p) => ((p as { repos: { branch?: string }[] }).repos[0]).branch);
    assert.deepEqual(branchesBuilt, ['main', 'feature/login'], 'each build clones its own branch');

    const list = listCodeGraphs('gr_br', 'main');
    assert.deepEqual(list.map((g) => g.branch), ['main', 'feature/login'], 'default branch first');
    assert.equal(getCodeGraphStatus(graphIdFor('gr_br', 'feature/login'))?.branch, 'feature/login');
    assert.deepEqual(parseGraphId(graphIdFor('gr_br', 'feature/login')), { repoId: 'gr_br', branch: 'feature/login' });
    assert.notEqual(graphObjectKey(projectId, graphIdFor('gr_br', 'a/b')), graphObjectKey(projectId, graphIdFor('gr_br', 'a_b')), 'branches that look alike do not share a file');

    // Sessions clone the default branch: they never get another branch's graph.
    assert.equal(resolveGraphId('gr_br', 'main', 'main'), graphIdFor('gr_br', 'main'));
    assert.equal(resolveGraphId('gr_br', 'other', 'main'), null);
  });

  it('a graph built before branches were told apart is the default branch graph, and a rebuild keeps using it', async () => {
    process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = ARN;
    await addRepo('gr_old', 'https://example.com/old.git');
    await setSetting(getDb(), 'codegraph.gr_old', JSON.stringify({ state: 'ready', at: new Date().toISOString(), message: '', stored: true, version: '2026-11-01T00:00:00.000Z', nodes: 5 }));
    assert.equal(resolveGraphId('gr_old', 'main', 'main'), 'gr_old');
    assert.equal(resolveGraphId('gr_old', 'dev', 'main'), null);
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'result', runId: 'r', success: true, commit: 'c2', nodes: 6, links: 1, bytes: 10, stored: true } as unknown as AgentCoreSSEEvent;
    });
    await runBackgroundJobNow('build-code-graph', { projectId, repoId: 'gr_old', branch: '' });
    assert.equal(resolveGraphId('gr_old', 'main', 'main'), 'gr_old', 'the same graph is updated, not a second one made');
    assert.equal(getCodeGraphStatus('gr_old')?.nodes, 6);
    assert.equal(getCodeGraphStatus('gr_old')?.branch, 'main');
    assert.equal(listCodeGraphs('gr_old', 'main').length, 1);
  });

  it('keeps at most five branch graphs per repository: the oldest goes, never the default branch', async () => {
    process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = ARN;
    await addRepo('gr_cap', 'https://example.com/cap.git');
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'result', runId: 'r', success: true, commit: 'c3', nodes: 3, links: 1, bytes: 10, stored: true } as unknown as AgentCoreSSEEvent;
    });
    await runBackgroundJobNow('build-code-graph', { projectId, repoId: 'gr_cap', branch: '' });
    for (let i = 1; i <= MAX_BRANCH_GRAPHS + 1; i++) await runBackgroundJobNow('build-code-graph', { projectId, repoId: 'gr_cap', branch: `b${i}` });
    const branches = listCodeGraphs('gr_cap', 'main').map((g) => g.branch);
    assert.equal(branches.length, MAX_BRANCH_GRAPHS);
    assert.equal(branches[0], 'main', 'the default branch stays');
    assert.ok(!branches.includes('b1') && !branches.includes('b2'), 'the oldest were dropped');
    assert.ok(branches.includes(`b${MAX_BRANCH_GRAPHS + 1}`), 'the newest is kept');
    assert.equal(getCodeGraphStatus(graphIdFor('gr_cap', 'b1')), null);
  });

  it('the build route takes a branch and refuses a name that is not one; graph-status lists the branches', async () => {
    process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = ARN;
    await addRepo('gr_route', 'https://example.com/route.git');
    assert.equal(validBranch('release/1.0'), true);
    for (const bad of ['../etc', '-x', 'a..b', 'a b', '', 'x'.repeat(201)]) assert.equal(validBranch(bad), false, `"${bad}" is not a branch name`);
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'result', runId: 'r', success: true, commit: 'c4', nodes: 4, links: 1, bytes: 10, stored: true } as unknown as AgentCoreSSEEvent;
    });
    await runBackgroundJobNow('build-code-graph', { projectId, repoId: 'gr_route', branch: 'release/1.0' });
    const r = (await fetchJson(baseUrl, `/api/projects/${projectId}/code-map/gr_route/graph-status?branch=release/1.0`, { cookie })).body as { status: { state: string; branch: string }; branches: { branch: string }[]; defaultBranch: string };
    assert.equal(r.status.state, 'ready');
    assert.equal(r.status.branch, 'release/1.0');
    assert.equal(r.defaultBranch, 'main');
    assert.deepEqual(r.branches.map((b) => b.branch), ['release/1.0']);
    const none = (await fetchJson(baseUrl, `/api/projects/${projectId}/code-map/gr_route/graph-status`, { cookie })).body as { status: unknown };
    assert.equal(none.status, null, 'the default branch has no graph yet');
  });

  it('the exclude list is saved per repository, sent with every build, and the runner\'s folder hints are kept', async () => {
    process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = ARN;
    await addRepo('gr_ex', 'https://example.com/ex.git');
    const url = (r = '') => `/api/projects/${projectId}/code-map/gr_ex/${r}`;

    const none = (await fetchJson(baseUrl, url('graph-status'), { cookie })).body as { excludes: string[] };
    assert.deepEqual(none.excludes, []);

    const saved = await fetchJson(baseUrl, url('excludes'), { method: 'PUT', body: { patterns: ['  node_modules/ ', 'dist\\', '', 'node_modules/', '*.min.js'] }, cookie });
    assert.equal(saved.status, 200);
    assert.deepEqual((saved.body as { patterns: string[] }).patterns, ['node_modules/', 'dist/', '*.min.js']);

    for (const bad of [['../etc'], ['*'], 'node_modules', [1]]) {
      const r = await fetchJson(baseUrl, url('excludes'), { method: 'PUT', body: { patterns: bad }, cookie });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} is refused`);
    }
    assert.deepEqual(((await fetchJson(baseUrl, url('graph-status'), { cookie })).body as { excludes: string[] }).excludes, ['node_modules/', 'dist/', '*.min.js'], 'a refused save changes nothing');
    assert.equal((await fetchJson(baseUrl, `/api/projects/${projectId}/code-map/nope/excludes`, { method: 'PUT', body: { patterns: [] }, cookie })).status, 404);

    let payload: Record<string, unknown> | null = null;
    _setAgentCoreInvokerOverride(async function* (_arn, _sid, p) {
      payload = p;
      yield { type: 'result', runId: 'r', success: true, commit: 'c5', nodes: 7, links: 2, bytes: 10, stored: true, excluded: { dirs: 3, files: 1 }, folders: [{ path: 'vendor/lib', nodes: 5 }, { path: 'src/app', nodes: 2 }, { nope: true }] } as unknown as AgentCoreSSEEvent;
    });
    await runBackgroundJobNow('build-code-graph', { projectId, repoId: 'gr_ex', branch: '' });
    assert.deepEqual((payload as unknown as { exclude: string[] }).exclude, ['node_modules/', 'dist/', '*.min.js']);
    const st = mainStatus('gr_ex');
    assert.deepEqual(st?.exclude, ['node_modules/', 'dist/', '*.min.js'], 'the graph remembers what it was built without');
    assert.deepEqual(st?.excluded, { dirs: 3, files: 1 });
    assert.deepEqual(st?.folders, [{ path: 'vendor/lib', nodes: 5 }, { path: 'src/app', nodes: 2 }]);

    // Emptying the list: the next build sends none.
    await fetchJson(baseUrl, url('excludes'), { method: 'PUT', body: { patterns: [] }, cookie });
    await runBackgroundJobNow('build-code-graph', { projectId, repoId: 'gr_ex', branch: '' });
    assert.equal('exclude' in (payload as unknown as Record<string, unknown>), false);
    assert.deepEqual(mainStatus('gr_ex')?.exclude, []);
  });
});
