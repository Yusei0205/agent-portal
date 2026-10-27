/**
 * P8 Diagrams tests.
 *
 * Tests:
 *   - POST /api/projects/:id/diagrams creates diagram + workflow
 *   - GET  /api/projects/:id/diagrams returns diagrams for project
 *   - processDiagramOutput creates a diagram_version row when given a valid .mmd file
 *   - markDiagramStale sets stale=1 on diagram
 *   - validateDrawio: valid draw.io XML produces DrawioInfo with icon count
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one, all } from '../server/db.ts';
import type { Row } from '../server/db.ts';
import { markDiagramStale, processDiagramOutput } from '../server/diagrams.ts';
import { validateDrawio } from '../server/drawio.ts';

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
    body: { name: `Diagram Test ${Date.now()}` },
    cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createRepo(baseUrl: string, cookie: string, projectId: string): Promise<string> {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
    method: 'POST',
    body: { name: 'test-repo', url: 'https://github.com/example/test', provider: 'github' },
    cookie,
  });
  return ((r.body as Record<string, unknown>).repo as Record<string, unknown>).id as string;
}

// ── Minimal valid Mermaid source ──────────────────────────────────────────────

const VALID_MMD = `flowchart LR
  A[Client] --> B[API Gateway]
  B --> C[Lambda]
  C --> D[(DynamoDB)]
`;

// ── Minimal valid draw.io XML ─────────────────────────────────────────────────

const VALID_DRAWIO = `<mxfile host="agent-portal">
  <diagram id="page-1" name="Architecture">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="2" value="Client" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.user;" vertex="1" parent="1">
          <mxGeometry x="10" y="10" width="78" height="78" as="geometry"/>
        </mxCell>
        <mxCell id="3" value="Lambda" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;" vertex="1" parent="1">
          <mxGeometry x="200" y="10" width="78" height="78" as="geometry"/>
        </mxCell>
        <mxCell id="4" value="Invoke" edge="1" source="2" target="3" parent="1">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

// ── POST /api/projects/:id/diagrams ──────────────────────────────────────────

describe('POST /api/projects/:id/diagrams', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let repoId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie);
    repoId = await createRepo(baseUrl, cookie, projectId);
  });

  after(cleanup);

  it('creates a diagram and workflow', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams`, {
      method: 'POST',
      body: {
        name: 'Test diagram',
        kind: 'system_context',
        style: 'mermaid',
        repoIds: [repoId],
      },
      cookie,
    });

    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const diagram = body.diagram as Record<string, unknown>;
    assert.ok(diagram.id, 'diagram has id');
    assert.equal(diagram.kind, 'system_context');
    assert.equal(diagram.style, 'mermaid');
    assert.equal(diagram.status, 'generating');
    assert.ok(body.workflowId, 'workflowId is returned');

    // Verify DB record
    const row = one<Row>('SELECT * FROM diagrams WHERE id = ?', String(diagram.id));
    assert.ok(row, 'diagram row in DB');
    assert.equal(row?.project_id, projectId);
  });

  it('returns 400 when no repoIds provided', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams`, {
      method: 'POST',
      body: { kind: 'system_context', style: 'mermaid' },
      cookie,
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 for invalid kind', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams`, {
      method: 'POST',
      body: { kind: 'invalid_kind', style: 'mermaid', repoIds: [repoId] },
      cookie,
    });
    assert.equal(r.status, 400);
  });

  it('returns 401 when not authenticated', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams`, {
      method: 'POST',
      body: { kind: 'system_context', style: 'mermaid', repoIds: [repoId] },
    });
    assert.equal(r.status, 401);
  });
});

// ── GET /api/projects/:id/diagrams ────────────────────────────────────────────

describe('GET /api/projects/:id/diagrams', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let repoId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie);
    repoId = await createRepo(baseUrl, cookie, projectId);

    // Create a diagram
    await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams`, {
      method: 'POST',
      body: { kind: 'components', style: 'mermaid', repoIds: [repoId] },
      cookie,
    });
  });

  after(cleanup);

  it('returns diagrams for project', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.diagrams), 'diagrams is array');
    assert.ok((body.diagrams as unknown[]).length >= 1, 'has at least 1 diagram');
  });

  it('returns kinds, styles, clouds in response', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams`, { cookie });
    const body = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.kinds), 'has kinds');
    assert.ok(Array.isArray(body.styles), 'has styles');
    assert.ok(Array.isArray(body.clouds), 'has clouds');
  });

  it('returns empty array for project with no diagrams', async () => {
    const pid = await createProject(baseUrl, cookie);
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/diagrams`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.deepEqual(body.diagrams, []);
  });
});

// ── processDiagramOutput ──────────────────────────────────────────────────────

describe('processDiagramOutput', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let repoId: string;
  let tmpDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie);
    repoId = await createRepo(baseUrl, cookie, projectId);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-test-'));
  });

  after(async () => {
    await cleanup();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('creates a diagram_version row from a valid .mmd file', async () => {
    // Create a diagram
    const cr = await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams`, {
      method: 'POST',
      body: { kind: 'system_context', style: 'mermaid', repoIds: [repoId] },
      cookie,
    });
    const diagram = (cr.body as Record<string, unknown>).diagram as Record<string, unknown>;
    const workflowId = (cr.body as Record<string, unknown>).workflowId as string;
    const diagramId = diagram.id as string;

    // Create a fake .mmd file in a temp work directory
    const mmdPath = path.join(tmpDir, 'diagram.mmd');
    fs.writeFileSync(mmdPath, VALID_MMD);

    // Create a fake p6_run for this workflow
    const { insert } = await import('../server/db.ts');
    const { generateId, now } = await import('../server/util.ts');
    const runId = generateId();
    insert('p6_runs', {
      id: runId,
      workflow_id: workflowId,
      status: 'done',
      started_at: now(),
      finished_at: now(),
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      created_at: now(),
    });

    // Process the output
    await processDiagramOutput(workflowId, runId, tmpDir);

    // Verify a version was created
    const versions = all<Row>('SELECT * FROM diagram_versions WHERE diagram_id = ?', diagramId);
    assert.ok(versions.length >= 1, 'at least one version created');
    assert.equal(versions[0].format, 'mermaid');
    assert.ok(String(versions[0].mermaid).includes('flowchart'), 'mermaid source stored');

    // Verify diagram was updated to ready
    const d = one<Row>('SELECT * FROM diagrams WHERE id = ?', diagramId);
    assert.equal(d?.status, 'ready');
    assert.ok(Number(d?.version) >= 1, 'version incremented');
  });
});

// ── markDiagramStale ─────────────────────────────────────────────────────────

describe('markDiagramStale', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let repoId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie);
    repoId = await createRepo(baseUrl, cookie, projectId);
  });

  after(cleanup);

  it('sets stale=1 on diagram', async () => {
    const cr = await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams`, {
      method: 'POST',
      body: { kind: 'data_flow', style: 'mermaid', repoIds: [repoId] },
      cookie,
    });
    const diagram = (cr.body as Record<string, unknown>).diagram as Record<string, unknown>;
    const diagramId = diagram.id as string;

    // Initially not stale
    const before = one<Row>('SELECT * FROM diagrams WHERE id = ?', diagramId);
    assert.equal(before?.stale, 0);

    // Mark stale
    markDiagramStale(diagramId);

    // Verify stale=1
    const after = one<Row>('SELECT * FROM diagrams WHERE id = ?', diagramId);
    assert.equal(after?.stale, 1);
  });
});

// ── validateDrawio ────────────────────────────────────────────────────────────

describe('validateDrawio', () => {
  it('validates valid draw.io XML and returns icon count', () => {
    const info = validateDrawio(VALID_DRAWIO);
    assert.ok(info.xml, 'returns xml');
    assert.ok(info.cells > 0, 'cells > 0');
    assert.ok(info.icons >= 1, 'icons >= 1');
    assert.ok(info.edges >= 1, 'edges >= 1');
    assert.ok(info.vertices >= 2, 'vertices >= 2');
  });

  it('rejects empty input', () => {
    assert.throws(() => validateDrawio(''), { message: /empty/i });
  });

  it('rejects invalid XML', () => {
    assert.throws(() => validateDrawio('<invalid>'), Error);
  });

  it('rejects DOCTYPE', () => {
    assert.throws(
      () => validateDrawio('<!DOCTYPE foo><mxfile><diagram><mxGraphModel><root></root></mxGraphModel></diagram></mxfile>'),
      { message: /DOCTYPE/i },
    );
  });

  it('rejects oversized diagram', () => {
    // Build an XML larger than DRAWIO_LIMITS.bytes
    const bigValue = 'x'.repeat(600);
    const cells = Array.from({ length: 310 }, (_, i) =>
      `<mxCell id="c${i}" value="${bigValue}" vertex="1" parent="1"><mxGeometry x="${i * 10}" y="0" width="60" height="60" as="geometry"/></mxCell>`,
    ).join('\n');
    const xml = `<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`;
    assert.throws(() => validateDrawio(xml), Error);
  });
});
