/**
 * Output files API tests (P7).
 *
 * Tests:
 *   - collectOutputFiles creates output_file rows from workDir/output/
 *   - Refuses .sh files
 *   - Refuses files over 25 MB
 *   - GET /api/workflows/:id/output-files returns collected files
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { collectOutputFiles } from '../server/output-files.ts';
import { all } from '../server/db.ts';
import type { Row } from '../server/db.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setupAdminAndProject(
  baseUrl: string,
): Promise<{ cookie: string; projectId: string }> {
  const setupR = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: {
      email: `outfiles-admin-${Date.now()}@example.com`,
      name: 'Admin',
      password: 'password1234',
      provider: 'demo',
    },
  });
  const cookie = setupR.cookie ?? '';

  const projR = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: 'Output Files Project' },
    cookie,
  });
  const projectId =
    ((projR.body as Record<string, unknown>).project as Record<string, unknown>)?.id as string ?? '';

  return { cookie, projectId };
}

async function createWorkflow(
  baseUrl: string,
  cookie: string,
  projectId: string,
): Promise<string> {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
    method: 'POST',
    body: { goal: 'Test output files', engine: 'demo' },
    cookie,
  });
  const wf = ((r.body as Record<string, unknown>).workflow as Record<string, unknown>);
  return (wf?.id as string) ?? '';
}

async function startRun(
  baseUrl: string,
  cookie: string,
  projectId: string,
  workflowId: string,
): Promise<string> {
  const r = await fetchJson(
    baseUrl,
    `/api/projects/${projectId}/workflows/${workflowId}/start`,
    { method: 'POST', body: {}, cookie },
  );
  const run = ((r.body as Record<string, unknown>).run as Record<string, unknown>);
  return (run?.id as string) ?? '';
}

// ── collectOutputFiles unit tests ─────────────────────────────────────────────

describe('collectOutputFiles', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-files-test-'));
    fs.mkdirSync(path.join(workDir, 'output'), { recursive: true });
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  it('collects .md and .json files from output/', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId);
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);

    // Create test files
    const outDir = path.join(workDir, 'output');
    fs.writeFileSync(path.join(outDir, 'result.md'), '# Result\n\nHello world!', 'utf8');
    fs.writeFileSync(path.join(outDir, 'data.json'), '{"key": "value"}', 'utf8');

    await collectOutputFiles(runId, workflowId, workDir);

    const files = all<Row>(
      'SELECT * FROM output_files WHERE run_id = ? AND refused_reason IS NULL',
      runId,
    );
    assert.ok(files.length >= 2, `Expected at least 2 files, got ${files.length}`);
    const names = files.map((f) => f.name as string);
    assert.ok(names.includes('result.md'), 'should include result.md');
    assert.ok(names.includes('data.json'), 'should include data.json');
  });

  it('refuses .sh files', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId);
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);

    const outDir = path.join(workDir, 'output');
    fs.writeFileSync(path.join(outDir, 'dangerous.sh'), '#!/bin/bash\nrm -rf /', 'utf8');

    await collectOutputFiles(runId, workflowId, workDir);

    const refused = all<Row>(
      "SELECT * FROM output_files WHERE run_id = ? AND refused_reason IS NOT NULL AND name = 'dangerous.sh'",
      runId,
    );
    assert.ok(refused.length >= 1, '.sh file should be refused');
    assert.ok(
      String(refused[0].refused_reason).includes('not allowed'),
      `Expected 'not allowed' in reason, got: ${refused[0].refused_reason}`,
    );

    // Clean up
    try { fs.rmSync(path.join(outDir, 'dangerous.sh'), { force: true }); } catch { /* */ }
  });

  it('refuses files over 25 MB', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId);
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);

    const outDir = path.join(workDir, 'output');
    const bigPath = path.join(outDir, 'big.txt');
    const MB_26 = 26 * 1024 * 1024;
    const fd = fs.openSync(bigPath, 'w');
    fs.ftruncateSync(fd, MB_26);
    fs.closeSync(fd);

    await collectOutputFiles(runId, workflowId, workDir);

    const refused = all<Row>(
      "SELECT * FROM output_files WHERE run_id = ? AND refused_reason IS NOT NULL AND name = 'big.txt'",
      runId,
    );
    assert.ok(refused.length >= 1, 'oversized file should be refused');
    assert.ok(
      String(refused[0].refused_reason).includes('MB'),
      `Expected 'MB' in reason, got: ${refused[0].refused_reason}`,
    );

    // Clean up large file
    try { fs.rmSync(bigPath, { force: true }); } catch { /* */ }
  });
});

// ── API tests ─────────────────────────────────────────────────────────────────

describe('Output files API', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workflowId: string;
  let runId: string;
  let tempWorkDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl));
    workflowId = await createWorkflow(baseUrl, adminCookie, projectId);
    runId = await startRun(baseUrl, adminCookie, projectId, workflowId);

    // Pre-collect some output files
    tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-api-test-'));
    const outDir = path.join(tempWorkDir, 'output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'report.md'), '# Report\n\nContent here.', 'utf8');
    fs.writeFileSync(path.join(outDir, 'summary.txt'), 'Summary text.', 'utf8');

    await collectOutputFiles(runId, workflowId, tempWorkDir);
  });

  after(async () => {
    try { fs.rmSync(tempWorkDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  it('GET /api/workflows/:id/output-files returns 200', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/workflows/${workflowId}/output-files`,
      { cookie: adminCookie },
    );
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.files), 'should have files array');
  });

  it('GET /api/workflows/:id/output-files returns collected files', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/workflows/${workflowId}/output-files`,
      { cookie: adminCookie },
    );
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const files = (body.files as Record<string, unknown>[]) ?? [];
    assert.ok(files.length >= 2, `Expected at least 2 files, got ${files.length}`);
    const names = files.map((f) => f.name as string);
    assert.ok(names.includes('report.md'), 'should include report.md');
    assert.ok(names.includes('summary.txt'), 'should include summary.txt');
  });
});
