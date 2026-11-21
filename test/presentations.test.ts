/**
 * P9 Presentations tests.
 *
 * Tests:
 *   - POST /api/projects/:id/presentations creates presentation + workflow
 *   - GET  /api/projects/:id/presentations returns presentations
 *   - processPresentationOutput creates pptx_path and preview_json when given a .pptx file
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one } from '../server/db.ts';
import type { Row } from '../server/db.ts';
import { processPresentationOutput } from '../server/presentations.ts';

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
    body: { name: `Pres Test ${Date.now()}` },
    cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

// ── POST /api/projects/:id/presentations ─────────────────────────────────────

describe('POST /api/projects/:id/presentations', () => {
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

  it('creates a presentation and workflow from a topic', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/presentations`, {
      method: 'POST',
      body: {
        name: 'Q4 Architecture Review',
        sourceKind: 'topic',
        topic: 'Describe the system architecture and key design decisions made in Q4.',
        slideCount: 10,
      },
      cookie,
    });

    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const pres = body.presentation as Record<string, unknown>;
    assert.ok(pres.id, 'presentation.id should exist');
    assert.equal(pres.source_kind, 'topic');
    assert.equal(pres.name, 'Q4 Architecture Review');
    assert.equal(pres.slide_count, 10);
    assert.ok(body.workflowId, 'workflowId should be returned');

    // Verify row in DB
    const row = one<Row>('SELECT * FROM presentations WHERE id = ?', pres.id as string);
    assert.ok(row, 'Row should exist in presentations');
    assert.equal(String(row!.source_kind), 'topic');
  });

  it('rejects invalid sourceKind', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/presentations`, {
      method: 'POST',
      body: {
        name: 'Bad kind',
        sourceKind: 'unknown-kind',
        topic: 'test',
      },
      cookie,
    });
    assert.equal(r.status, 400);
  });

  it('requires topic when sourceKind is topic', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/presentations`, {
      method: 'POST',
      body: {
        name: 'Missing topic',
        sourceKind: 'topic',
        // no topic field
      },
      cookie,
    });
    assert.equal(r.status, 400);
  });

  it('requires authentication', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/presentations`, {
      method: 'POST',
      body: { name: 'Test', sourceKind: 'topic', topic: 'test' },
    });
    assert.equal(r.status, 401);
  });
});

// ── GET /api/projects/:id/presentations ──────────────────────────────────────

describe('GET /api/projects/:id/presentations', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie);

    // Create a presentation
    await fetchJson(baseUrl, `/api/projects/${projectId}/presentations`, {
      method: 'POST',
      body: { name: 'Test Deck', sourceKind: 'topic', topic: 'System overview' },
      cookie,
    });
  });

  after(cleanup);

  it('returns presentations for project', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/presentations`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const presentations = body.presentations as unknown[];
    assert.ok(Array.isArray(presentations), 'presentations should be an array');
    assert.ok(presentations.length >= 1, 'at least one presentation');
    const first = presentations[0] as Record<string, unknown>;
    assert.ok(first.id, 'presentation should have id');
    assert.ok(first.source_kind, 'presentation should have source_kind');
  });

  it('returns empty for new project', async () => {
    const otherProject = await createProject(baseUrl, cookie);
    const r = await fetchJson(baseUrl, `/api/projects/${otherProject}/presentations`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const presentations = body.presentations as unknown[];
    assert.equal(presentations.length, 0);
  });
});

// ── processPresentationOutput ─────────────────────────────────────────────────

describe('processPresentationOutput', () => {
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

  it('stores pptx_path when given a .pptx file', async () => {
    // Create a presentation
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/presentations`, {
      method: 'POST',
      body: { name: 'Output Test Pres', sourceKind: 'topic', topic: 'Architecture' },
      cookie,
    });
    const body = r.body as Record<string, unknown>;
    const pres = body.presentation as Record<string, unknown>;
    const workflowId = body.workflowId as string;
    const presId = pres.id as string;

    // Create a temp workDir with a minimal (fake) .pptx file
    // A real PPTX is a zip file, but for this test we just check the path is stored
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-pres-'));
    try {
      const pptxPath = path.join(workDir, 'presentation.pptx');
      // Write a minimal fake PPTX (enough for path testing, not a valid zip)
      fs.writeFileSync(pptxPath, Buffer.from([0x50, 0x4B, 0x03, 0x04])); // PK header

      // Update the presentation's workflow_id to match
      const { run: dbRun } = await import('../server/db.ts');
      dbRun('UPDATE presentations SET workflow_id = ? WHERE id = ?', workflowId, presId);

      await processPresentationOutput(workflowId, 'test-run-id', workDir);

      // Check pptx_path was stored
      const updatedPres = one<Row>('SELECT * FROM presentations WHERE id = ?', presId);
      assert.ok(updatedPres?.pptx_path, 'pptx_path should be set');
      assert.ok(String(updatedPres!.pptx_path).includes('presentation.pptx'), 'pptx_path should point to the file');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
