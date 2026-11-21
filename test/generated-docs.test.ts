/**
 * P9 Generated Documents tests.
 *
 * Tests:
 *   - POST /api/projects/:id/generated-docs creates doc + workflow
 *   - GET  /api/projects/:id/generated-docs returns docs for project
 *   - processDocOutput creates a generated_doc_version row when given a markdown file
 *   - Download endpoint returns 404 when no version exists
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one, all } from '../server/db.ts';
import type { Row } from '../server/db.ts';
import { processDocOutput } from '../server/generated-docs.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: {
      email: `admin-${Date.now()}@test.com`,
      name: 'Admin',
      password: 'password1234',
      provider: 'demo',
    },
  });
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: `GenDoc Test ${Date.now()}` },
    cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

// ── POST /api/projects/:id/generated-docs ────────────────────────────────────

describe('POST /api/projects/:id/generated-docs', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie);
  });

  after(cleanup);

  it('creates a document and workflow', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, {
      method: 'POST',
      body: {
        name: 'Test API docs',
        docType: 'api',
        sources: { repoIds: [] },
      },
      cookie,
    });

    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const doc = body.doc as Record<string, unknown>;
    assert.ok(doc.id, 'doc.id should exist');
    assert.equal(doc.doc_type, 'api');
    assert.equal(doc.name, 'Test API docs');
    assert.ok(body.workflowId, 'workflowId should be returned');

    // Verify row in DB
    const row = one<Row>('SELECT * FROM generated_docs WHERE id = ?', doc.id as string);
    assert.ok(row, 'Row should exist in generated_docs');
    assert.equal(String(row!.doc_type), 'api');
  });

  it('rejects invalid doc_type', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, {
      method: 'POST',
      body: {
        name: 'Bad type doc',
        docType: 'invalid-type',
        sources: {},
      },
      cookie,
    });
    assert.equal(r.status, 400);
  });

  it('requires authentication', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, {
      method: 'POST',
      body: { name: 'Doc', docType: 'api', sources: {} },
    });
    assert.equal(r.status, 401);
  });
});

// ── GET /api/projects/:id/generated-docs ─────────────────────────────────────

describe('GET /api/projects/:id/generated-docs', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie);

    // Create a doc
    await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, {
      method: 'POST',
      body: { name: 'Overview', docType: 'overview', sources: {} },
      cookie,
    });
  });

  after(cleanup);

  it('returns docs for project', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const docs = body.docs as unknown[];
    assert.ok(Array.isArray(docs), 'docs should be an array');
    assert.ok(docs.length >= 1, 'at least one doc');
    const first = docs[0] as Record<string, unknown>;
    assert.ok(first.id, 'doc should have id');
    assert.ok(first.doc_type, 'doc should have doc_type');
  });

  it('returns empty for new project', async () => {
    const otherProject = await createProject(baseUrl, cookie);
    const r = await fetchJson(baseUrl, `/api/projects/${otherProject}/generated-docs`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const docs = body.docs as unknown[];
    assert.equal(docs.length, 0);
  });
});

// ── processDocOutput ──────────────────────────────────────────────────────────

describe('processDocOutput', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie);
  });

  after(cleanup);

  it('creates a generated_doc_version row when given a markdown file', async () => {
    // Create a document first
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, {
      method: 'POST',
      body: { name: 'Output Test', docType: 'runbook', sources: {} },
      cookie,
    });
    const body = r.body as Record<string, unknown>;
    const doc = body.doc as Record<string, unknown>;
    const workflowId = body.workflowId as string;
    const docId = doc.id as string;

    // Create a temp work dir with a markdown file
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-doc-'));
    try {
      const mdPath = path.join(workDir, 'document.md');
      fs.writeFileSync(mdPath, '# Test Document\n\nThis is a test.\n');

      await processDocOutput(workflowId, 'test-run-id', workDir);

      // Check a version row was created
      const versions = all<Row>('SELECT * FROM generated_doc_versions WHERE doc_id = ?', docId);
      assert.ok(versions.length >= 1, 'At least one version should exist');
      const v = versions[0];
      assert.ok(String(v.md_path).includes('document.md'), 'md_path should point to the file');

      // Check the doc's latest_version_id was updated
      const updatedDoc = one<Row>('SELECT * FROM generated_docs WHERE id = ?', docId);
      assert.ok(updatedDoc?.latest_version_id, 'latest_version_id should be set');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

// ── Download endpoint ─────────────────────────────────────────────────────────

describe('GET /api/projects/:id/generated-docs/:docId/download', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie);
  });

  after(cleanup);

  it('returns 404 when no version exists', async () => {
    // Create a doc but don't process any output
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, {
      method: 'POST',
      body: { name: 'No version doc', docType: 'overview', sources: {} },
      cookie,
    });
    const body = r.body as Record<string, unknown>;
    const doc = body.doc as Record<string, unknown>;
    const docId = doc.id as string;

    const dr = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs/${docId}/download?format=md`, {
      cookie,
    });
    assert.equal(dr.status, 404);
  });
});
