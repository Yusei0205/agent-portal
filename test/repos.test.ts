/**
 * Repositories API tests (P4).
 *
 * Tests:
 *   - POST /api/projects/:id/repos creates repo with status 'new'
 *   - GET /api/projects/:id/repos returns repos for project only
 *   - POST .../sync changes status to 'cloning'
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

describe('Repositories API', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let otherProjectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    // Setup admin
    await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: 'repo-admin@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'repo-admin@example.com', password: 'password1234' },
    });
    adminCookie = loginR.cookie ?? '';

    // Create two projects
    const p1R = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Repo Test Project' },
      cookie: adminCookie,
    });
    projectId = ((p1R.body as Record<string, unknown>).project as Record<string, unknown>)?.id as string ?? '';

    const p2R = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Other Project' },
      cookie: adminCookie,
    });
    otherProjectId = ((p2R.body as Record<string, unknown>).project as Record<string, unknown>)?.id as string ?? '';
  });

  after(async () => {
    await cleanup();
  });

  it('POST creates repo with status "new"', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: {
        name: 'my-service',
        url: 'https://github.com/example/my-service',
        provider: 'github',
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    const repo = body.repo as Record<string, unknown>;
    assert.ok(repo.id, 'should have id');
    assert.equal(repo.name, 'my-service');
    assert.equal(repo.url, 'https://github.com/example/my-service');
    assert.equal(repo.provider, 'github');
    assert.equal(repo.status, 'cloning', 'initial status should be "cloning" (clone starts immediately)');
    assert.equal(repo.project_id, projectId);
  });

  it('GET returns repos for the project only', async () => {
    // Add repo to other project
    await fetchJson(baseUrl, `/api/projects/${otherProjectId}/repos`, {
      method: 'POST',
      body: { name: 'other-service', url: 'https://github.com/example/other', provider: 'github' },
      cookie: adminCookie,
    });

    // Add another repo to primary project
    await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'another-service', url: 'https://github.com/example/another', provider: 'github' },
      cookie: adminCookie,
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const repos = (r.body as Record<string, unknown>).repos as Array<Record<string, unknown>>;
    // All returned repos should belong to the target project
    for (const repo of repos) {
      assert.equal(repo.project_id, projectId, `repo ${repo.id} should belong to project ${projectId}`);
    }
    // 'other-service' should not be in the list
    assert.ok(
      !repos.some((repo) => repo.name === 'other-service'),
      'should not include repos from other project',
    );
  });

  it('POST .../sync changes status to "cloning"', async () => {
    // First create a repo
    const createR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'sync-test', url: 'https://github.com/example/sync-test', provider: 'github' },
      cookie: adminCookie,
    });
    const repoId = ((createR.body as Record<string, unknown>).repo as Record<string, unknown>)?.id as string ?? '';

    // Trigger sync
    const syncR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/${repoId}/sync`, {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(syncR.status, 202, `expected 202, got ${syncR.status}: ${JSON.stringify(syncR.body)}`);
    const syncBody = syncR.body as Record<string, unknown>;
    assert.equal(syncBody.status, 'cloning', 'response should indicate cloning status');

    // Verify status in DB
    const getR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/${repoId}`, {
      cookie: adminCookie,
    });
    const repo = (getR.body as Record<string, unknown>).repo as Record<string, unknown>;
    assert.equal(repo.status, 'cloning', 'repo status should be "cloning" after sync trigger');
  });

  it('returns 404 for repo not in this project', async () => {
    // Add repo to other project
    const otherR = await fetchJson(baseUrl, `/api/projects/${otherProjectId}/repos`, {
      method: 'POST',
      body: { name: 'cross-check', url: 'https://github.com/example/cross', provider: 'github' },
      cookie: adminCookie,
    });
    const otherId = ((otherR.body as Record<string, unknown>).repo as Record<string, unknown>)?.id as string ?? '';

    // Try to access it via primary project
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/${otherId}`, {
      cookie: adminCookie,
    });
    assert.equal(r.status, 404, 'should not be accessible via wrong project');
  });

  it('PUT .../default-branch changes the branch new sessions start from', async () => {
    const createR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'branchy', url: 'https://github.com/example/branchy', provider: 'github', defaultBranch: 'main' },
      cookie: adminCookie,
    });
    const repoId = ((createR.body as Record<string, unknown>).repo as Record<string, unknown>)?.id as string ?? '';

    const put = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/${repoId}/default-branch`, {
      method: 'PUT',
      body: { branch: 'develop' },
      cookie: adminCookie,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal((put.body as Record<string, unknown>).defaultBranch, 'develop');

    const get = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/${repoId}`, { cookie: adminCookie });
    assert.equal(((get.body as Record<string, unknown>).repo as Record<string, unknown>).default_branch, 'develop');

    const blank = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/${repoId}/default-branch`, {
      method: 'PUT', body: { branch: '  ' }, cookie: adminCookie,
    });
    assert.equal(blank.status, 400, 'an empty branch name is refused');

    const other = await fetchJson(baseUrl, `/api/projects/${otherProjectId}/repos/${repoId}/default-branch`, {
      method: 'PUT', body: { branch: 'x' }, cookie: adminCookie,
    });
    assert.equal(other.status, 404, 'a repository of another project cannot be changed through this one');
  });

  it('requires authentication', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`);
    assert.equal(r.status, 401);
  });

  it('validates provider', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'bad-provider', url: 'https://example.com/repo', provider: 'svn' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });
});
