/**
 * Tests for GET /api/workflows/:id/context.
 *
 * Coverage:
 *   - 401 when unauthenticated
 *   - 404 when workflow not found
 *   - 403 for a non-member user on a project-scoped workflow
 *   - 200 with empty context array when project has no enrichment data
 *   - 200 with CLAUDE.md item when file exists in the project dir
 *   - Admin access always succeeds regardless of membership
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { run as dbRun } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { config } from '../server/config.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: 'ctx-admin@example.com', name: 'Admin', password: 'password1234' },
  });
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string): Promise<{ id: string; slug: string }> {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: 'Context Test Project' },
    cookie,
  });
  assert.equal(r.status, 201, `createProject: ${JSON.stringify(r.body)}`);
  const project = (r.body as Record<string, unknown>).project as Record<string, unknown>;
  return { id: project.id as string, slug: project.slug as string };
}

function createWorkflowDirect(projectId: string): string {
  const wid = generateId();
  dbRun(
    `INSERT INTO p6_workflows (id, project_id, goal, engine, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    wid, projectId, 'Test goal', 'demo', 'pending', now(), now(),
  );
  return wid;
}

// ── Auth / access guard tests ─────────────────────────────────────────────────

describe('GET /api/workflows/:id/context — auth guards', () => {
  let baseUrl: string;
  let adminCookie: string;
  let workflowId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
    const project = await createProject(baseUrl, adminCookie);
    workflowId = createWorkflowDirect(project.id);
  });

  after(async () => { await cleanup(); });

  it('returns 401 when not authenticated', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/context`);
    assert.equal(r.status, 401);
  });

  it('returns 404 for non-existent workflow', async () => {
    const r = await fetchJson(baseUrl, '/api/workflows/does-not-exist/context', {
      cookie: adminCookie,
    });
    assert.equal(r.status, 404);
  });

  it('admin can always access any workflow context', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/context`, {
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { context: unknown[] };
    assert.ok(Array.isArray(body.context), 'context must be an array');
  });

  it('returns 403 for non-member user on a project-scoped workflow', async () => {
    // Create a second (non-admin) user
    await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: 'ctx-member@example.com', name: 'NonMember', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'ctx-member@example.com', password: 'password1234' },
    });
    const memberCookie = loginR.cookie ?? '';

    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/context`, {
      cookie: memberCookie,
    });
    assert.equal(r.status, 403);
  });
});

// ── Response shape tests ──────────────────────────────────────────────────────

describe('GET /api/workflows/:id/context — response shape', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let projectSlug: string;
  let workflowId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
    const project = await createProject(baseUrl, adminCookie);
    projectId = project.id;
    projectSlug = project.slug;
    workflowId = createWorkflowDirect(projectId);
  });

  after(async () => { await cleanup(); });

  it('returns empty context array when project dir has no enrichment data', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/context`, {
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { context: unknown[] };
    assert.ok(Array.isArray(body.context));
    // Without CLAUDE.md or skills the context may be empty
  });

  it('includes a CLAUDE.md item when the file exists', async () => {
    // Write a CLAUDE.md into the test project dir
    const projectDir = path.join(config.dataDir, 'projects', projectSlug);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Test Project\nHello context.\n', 'utf8');

    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/context`, {
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { context: Array<{ id: string; title: string; kind: string; body: string }> };
    assert.ok(Array.isArray(body.context));
    const claudeItem = body.context.find((c) => c.id === 'claude-md');
    assert.ok(claudeItem, 'must include a claude-md item');
    assert.equal(claudeItem!.kind, 'document');
    assert.equal(claudeItem!.title, 'CLAUDE.md');
    assert.ok(claudeItem!.body.includes('Hello context.'), 'body must contain file content');
  });

  it('context items all have id, title, kind, body fields', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/context`, {
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { context: Array<Record<string, unknown>> };
    for (const item of body.context) {
      assert.ok(typeof item.id === 'string', `item.id must be string: ${JSON.stringify(item)}`);
      assert.ok(typeof item.title === 'string', `item.title must be string`);
      assert.ok(typeof item.kind === 'string', `item.kind must be string`);
      assert.ok(typeof item.body === 'string', `item.body must be string`);
    }
  });
});
