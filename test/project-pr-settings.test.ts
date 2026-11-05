/**
 * Project pull request settings: defaults, update, validation, access, and isolation between projects.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

type Json = Record<string, unknown>;

describe('/api/projects/:id/pull-request-settings', () => {
  let baseUrl: string;
  let adminCookie: string;
  let viewerCookie: string;
  let outsiderCookie: string;
  let projectA: string;
  let projectB: string;

  const url = (pid: string) => `/api/projects/${pid}/pull-request-settings`;
  const put = (pid: string, body: unknown, cookie = adminCookie) => fetchJson(baseUrl, url(pid), { method: 'PUT', body, cookie });

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: 'prs-admin@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    adminCookie = (await fetchJson(baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'prs-admin@example.com', password: 'password1234' } })).cookie ?? '';

    const mkUser = async (email: string) => {
      const r = await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email, name: email, password: 'password1234', isAdmin: false }, cookie: adminCookie });
      const id = ((r.body as Json).user as Json).id as string;
      const cookie = (await fetchJson(baseUrl, '/api/auth/login', { method: 'POST', body: { email, password: 'password1234' } })).cookie ?? '';
      return { id, cookie };
    };
    const viewer = await mkUser('prs-viewer@example.com');
    const outsider = await mkUser('prs-outsider@example.com');
    viewerCookie = viewer.cookie;
    outsiderCookie = outsider.cookie;

    const mkProject = async (name: string) => {
      const r = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name }, cookie: adminCookie });
      return ((r.body as Json).project as Json).id as string;
    };
    projectA = await mkProject('PR Settings A');
    projectB = await mkProject('PR Settings B');
    const add = await fetchJson(baseUrl, `/api/projects/${projectA}/members`, { method: 'POST', body: { userId: viewer.id, role: 'viewer' }, cookie: adminCookie });
    assert.equal(add.status, 201, JSON.stringify(add.body));
  });

  after(async () => {
    await cleanup();
  });

  it('returns the defaults for a project that never saved any', async () => {
    const r = await fetchJson(baseUrl, url(projectA), { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { openPullRequests: true, protectedBranches: ['main', 'master', 'develop', 'release/*'] });
  });

  it('requires sign-in', async () => {
    const r = await fetchJson(baseUrl, url(projectA));
    assert.equal(r.status, 401);
  });

  it('updates one field and keeps the other', async () => {
    const r = await put(projectA, { openPullRequests: false });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { openPullRequests: false, protectedBranches: ['main', 'master', 'develop', 'release/*'] });
    const r2 = await put(projectA, { protectedBranches: ['  prod ', 'staging/*', 'prod'] });
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.body, { openPullRequests: false, protectedBranches: ['prod', 'staging/*'] });
    const got = await fetchJson(baseUrl, url(projectA), { cookie: adminCookie });
    assert.deepEqual(got.body, { openPullRequests: false, protectedBranches: ['prod', 'staging/*'] });
  });

  it('allows an empty protected list', async () => {
    const r = await put(projectA, { protectedBranches: [] });
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as Json).protectedBranches, []);
  });

  it('rejects invalid values and changes nothing', async () => {
    const before = (await fetchJson(baseUrl, url(projectA), { cookie: adminCookie })).body;
    for (const body of [
      { openPullRequests: 'yes' },
      { openPullRequests: 1 },
      { protectedBranches: 'main' },
      { protectedBranches: [5] },
      { protectedBranches: ['has space'] },
      { protectedBranches: ['-leading-dash'] },
      { protectedBranches: ['a'.repeat(201)] },
      { protectedBranches: Array.from({ length: 51 }, (_, i) => `b${i}`) },
      { openPullRequests: true, protectedBranches: ['bad name'] },
    ]) {
      const r = await put(projectA, body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.ok(typeof (r.body as Json).error === 'string');
    }
    assert.deepEqual((await fetchJson(baseUrl, url(projectA), { cookie: adminCookie })).body, before);
  });

  it('accepts 50 branches and a 200 character name', async () => {
    const list = [...Array.from({ length: 49 }, (_, i) => `b${i}`), 'x'.repeat(200)];
    const r = await put(projectA, { protectedBranches: list });
    assert.equal(r.status, 200);
    assert.equal(((r.body as Json).protectedBranches as string[]).length, 50);
  });

  it('lets a viewer read but not update', async () => {
    const g = await fetchJson(baseUrl, url(projectA), { cookie: viewerCookie });
    assert.equal(g.status, 200);
    const r = await put(projectA, { openPullRequests: true }, viewerCookie);
    assert.equal(r.status, 403);
    assert.equal(((await fetchJson(baseUrl, url(projectA), { cookie: adminCookie })).body as Json).openPullRequests, false);
  });

  it('hides the project from a non-member', async () => {
    assert.equal((await fetchJson(baseUrl, url(projectA), { cookie: outsiderCookie })).status, 404);
    assert.equal((await put(projectA, { openPullRequests: true }, outsiderCookie)).status, 404);
  });

  it('keeps another project unaffected', async () => {
    const r = await fetchJson(baseUrl, url(projectB), { cookie: adminCookie });
    assert.deepEqual(r.body, { openPullRequests: true, protectedBranches: ['main', 'master', 'develop', 'release/*'] });
    await put(projectB, { openPullRequests: false, protectedBranches: ['only-b'] });
    const a = (await fetchJson(baseUrl, url(projectA), { cookie: adminCookie })).body as Json;
    assert.equal(a.openPullRequests, false);
    assert.notDeepEqual(a.protectedBranches, ['only-b']);
  });

  it('returns 404 for an unknown project', async () => {
    assert.equal((await fetchJson(baseUrl, url('no-such-project'), { cookie: adminCookie })).status, 404);
  });
});
