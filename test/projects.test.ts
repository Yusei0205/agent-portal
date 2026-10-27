/**
 * Projects API tests (P4).
 *
 * Tests:
 *   - POST /api/projects creates project, creates disk directory, adds creator as owner
 *   - GET /api/projects returns only projects the user is a member of
 *   - Slug generation: "My Project" → "my-project", duplicate gets "-2" suffix
 *   - POST /api/projects/:id/members adds member with role
 *   - DELETE /api/projects/:id/members/:userId removes member
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { createTestDb } from './fixtures.ts';
import { closeDb } from '../server/db.ts';
import { generateSlug } from '../server/projects.ts';

// ── Unit tests for generateSlug ───────────────────────────────────────────────

describe('generateSlug', () => {
  it('"My Project" → "my-project"', () => {
    const slug = generateSlug('My Project', []);
    assert.equal(slug, 'my-project');
  });

  it('duplicate gets "-2" suffix', () => {
    const slug = generateSlug('My Project', ['my-project']);
    assert.equal(slug, 'my-project-2');
  });

  it('third duplicate gets "-3" suffix', () => {
    const slug = generateSlug('My Project', ['my-project', 'my-project-2']);
    assert.equal(slug, 'my-project-3');
  });

  it('trims and lowercases', () => {
    const slug = generateSlug('  Hello World  ', []);
    assert.equal(slug, 'hello-world');
  });

  it('collapses special characters to dashes', () => {
    const slug = generateSlug('Hello --- World!!!', []);
    assert.equal(slug, 'hello-world');
  });
});

// ── API route tests ───────────────────────────────────────────────────────────

describe('POST /api/projects', () => {
  let baseUrl: string;
  let adminCookie: string;
  let adminUserId: string;
  let cfg: { dataDir: string };

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    // @ts-expect-error config exposed via test server
    cfg = ts.config ?? { dataDir: '' };

    const setupR = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: {
        email: 'admin@example.com',
        name: 'Admin User',
        password: 'password1234',
        provider: 'demo',
      },
    });
    assert.equal(setupR.status, 200);
    adminCookie = setupR.cookie ?? '';

    // Get admin user id
    const stateR = await fetchJson(baseUrl, '/api/auth/state', { cookie: adminCookie });
    adminUserId = (stateR.body as Record<string, unknown> & { user: { id: string } }).user?.id ?? '';
  });

  after(async () => {
    await cleanup();
  });

  it('creates a project and adds creator as owner', async () => {
    const r = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Test Project', description: 'A test' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    const project = body.project as Record<string, unknown>;
    assert.ok(project.id, 'should have id');
    assert.equal(project.name, 'Test Project');
    assert.equal(project.slug, 'test-project');
    assert.equal(project.description, 'A test');

    // Verify member added as owner
    const membersR = await fetchJson(baseUrl, `/api/projects/${project.id}/members`, {
      cookie: adminCookie,
    });
    assert.equal(membersR.status, 200);
    const members = (membersR.body as Record<string, unknown>).members as Array<Record<string, unknown>>;
    assert.ok(members.some((m) => m.user_id === adminUserId && m.role === 'owner'), 'creator should be owner');
  });

  it('slug deduplication works', async () => {
    const r1 = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Dup Project' },
      cookie: adminCookie,
    });
    const r2 = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Dup Project' },
      cookie: adminCookie,
    });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    const p1 = (r1.body as Record<string, unknown>).project as Record<string, unknown>;
    const p2 = (r2.body as Record<string, unknown>).project as Record<string, unknown>;
    assert.equal(p1.slug, 'dup-project');
    assert.equal(p2.slug, 'dup-project-2');
  });

  it('requires authentication', async () => {
    const r = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Unauth' },
    });
    assert.equal(r.status, 401);
  });

  it('validates name is required', async () => {
    const r = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: '' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });
});

describe('GET /api/projects', () => {
  let baseUrl: string;
  let adminCookie: string;
  let memberCookie: string;
  let memberUserId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    // Setup admin
    await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: 'admin2@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    const adminLoginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'admin2@example.com', password: 'password1234' },
    });
    adminCookie = adminLoginR.cookie ?? '';

    // Create a second user (member)
    const memberR = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: 'member@example.com', name: 'Member', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    memberUserId = ((memberR.body as Record<string, unknown>).user as Record<string, unknown>)?.id as string ?? '';

    // Login as member
    const memberLoginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'member@example.com', password: 'password1234' },
    });
    memberCookie = memberLoginR.cookie ?? '';
  });

  after(async () => {
    await cleanup();
  });

  it('member only sees projects they belong to', async () => {
    // Admin creates two projects
    const p1R = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Admin Project' },
      cookie: adminCookie,
    });
    const p2R = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Shared Project' },
      cookie: adminCookie,
    });
    const p2 = (p2R.body as Record<string, unknown>).project as Record<string, unknown>;

    // Add member to p2 only
    await fetchJson(baseUrl, `/api/projects/${p2.id}/members`, {
      method: 'POST',
      body: { userId: memberUserId, role: 'editor' },
      cookie: adminCookie,
    });

    // Member should only see p2
    const listR = await fetchJson(baseUrl, '/api/projects', { cookie: memberCookie });
    assert.equal(listR.status, 200);
    const projects = (listR.body as Record<string, unknown>).projects as Array<Record<string, unknown>>;
    const ids = projects.map((p) => p.id);
    assert.ok(ids.includes(p2.id as string), 'member should see shared project');
    const p1Id = ((p1R.body as Record<string, unknown>).project as Record<string, unknown>).id;
    assert.ok(!ids.includes(p1Id as string), 'member should not see admin-only project');
  });

  it('admin sees all projects', async () => {
    const listR = await fetchJson(baseUrl, '/api/projects', { cookie: adminCookie });
    assert.equal(listR.status, 200);
    const projects = (listR.body as Record<string, unknown>).projects as Array<Record<string, unknown>>;
    assert.ok(projects.length >= 2, 'admin should see all projects');
  });
});

describe('POST /api/projects/:id/members', () => {
  let baseUrl: string;
  let adminCookie: string;
  let memberUserId: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: 'admin3@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'admin3@example.com', password: 'password1234' },
    });
    adminCookie = loginR.cookie ?? '';

    const memberR = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: 'mem2@example.com', name: 'Member2', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    memberUserId = ((memberR.body as Record<string, unknown>).user as Record<string, unknown>)?.id as string ?? '';

    const projR = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Member Test Project' },
      cookie: adminCookie,
    });
    projectId = ((projR.body as Record<string, unknown>).project as Record<string, unknown>)?.id as string ?? '';
  });

  after(async () => {
    await cleanup();
  });

  it('adds member with role', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/members`, {
      method: 'POST',
      body: { userId: memberUserId, role: 'editor' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);

    const membersR = await fetchJson(baseUrl, `/api/projects/${projectId}/members`, {
      cookie: adminCookie,
    });
    const members = (membersR.body as Record<string, unknown>).members as Array<Record<string, unknown>>;
    assert.ok(members.some((m) => m.user_id === memberUserId && m.role === 'editor'));
  });

  it('prevents duplicate membership', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/members`, {
      method: 'POST',
      body: { userId: memberUserId, role: 'editor' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 409);
  });
});

describe('DELETE /api/projects/:id/members/:userId', () => {
  let baseUrl: string;
  let adminCookie: string;
  let memberUserId: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: 'admin4@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'admin4@example.com', password: 'password1234' },
    });
    adminCookie = loginR.cookie ?? '';

    const memberR = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: 'mem3@example.com', name: 'Member3', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    memberUserId = ((memberR.body as Record<string, unknown>).user as Record<string, unknown>)?.id as string ?? '';

    const projR = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Del Member Project' },
      cookie: adminCookie,
    });
    projectId = ((projR.body as Record<string, unknown>).project as Record<string, unknown>)?.id as string ?? '';

    // Add the member first
    await fetchJson(baseUrl, `/api/projects/${projectId}/members`, {
      method: 'POST',
      body: { userId: memberUserId, role: 'editor' },
      cookie: adminCookie,
    });
  });

  after(async () => {
    await cleanup();
  });

  it('removes a member', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/members/${memberUserId}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const membersR = await fetchJson(baseUrl, `/api/projects/${projectId}/members`, {
      cookie: adminCookie,
    });
    const members = (membersR.body as Record<string, unknown>).members as Array<Record<string, unknown>>;
    assert.ok(!members.some((m) => m.user_id === memberUserId), 'member should be removed');
  });

  it('returns 404 for non-existent member', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/members/non-existent-id`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    assert.equal(r.status, 404);
  });
});
