/**
 * Output files — backend tests.
 *
 * Covers:
 *   - collectOutputFiles: non-repo file detection by mtime
 *   - collectOutputFiles: extension allow-list filter
 *   - collectOutputFiles: excluded directories (home/, .browser/, .claude/, .agent-notes/)
 *   - collectOutputFiles: repo-copy changes via git status --porcelain
 *   - collectOutputFiles: hash-based dedup (skip when content unchanged)
 *   - collectOutputFiles: version bump when content changes
 *   - collectOutputFiles: oversized file refused
 *   - Vault folder copy: new vault_files row created for each output file
 *   - Vault folder copy: replace-in-place when file is re-collected
 *   - GET /api/workflows/:id/output-files returns required fields + vaultFolder
 *   - GET .../download falls back to Vault when work-dir file is gone
 *   - GET /api/projects/:id/vault/zip?folder=… returns only matching files
 *   - Access denied for non-project-members
 *   - Backfill idempotency: second run of collectOutputFiles skips identical files
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { collectOutputFiles } from '../server/output-files.ts';
import { all, one, run as dbRun } from '../server/db.ts';
import type { Row } from '../server/db.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setupAdminAndProject(
  baseUrl: string,
  suffix = '',
): Promise<{ cookie: string; projectId: string }> {
  const setupR = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: {
      email: `output-test-${Date.now()}${suffix}@example.com`,
      name: 'Admin',
      password: 'password1234',
      provider: 'demo',
    },
  });
  const cookie = setupR.cookie ?? '';

  const projR = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: `Output Project ${suffix}` },
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
  goal = 'Test output files',
): Promise<string> {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
    method: 'POST',
    body: { goal, engine: 'demo' },
    cookie,
  });
  return ((r.body as Record<string, unknown>).workflow as Record<string, unknown>)?.id as string ?? '';
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
  return ((r.body as Record<string, unknown>).run as Record<string, unknown>)?.id as string ?? '';
}

/** Create a temp work dir with repos/ present. Returns the path. */
function makeTempWorkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outfiles-test-'));
  fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
  return dir;
}

/** Write a file at relPath inside dir with content; return abs path. */
function writeFile(dir: string, relPath: string, content: string): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

/** Check if git is available. */
function gitAvailable(): boolean {
  try { execSync('git --version', { stdio: 'ignore' }); return true; } catch { return false; }
}

// ── Detection — non-repo files by mtime ──────────────────────────────────────

describe('collectOutputFiles — non-repo file detection', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'mtime'));
    workDir = makeTempWorkDir();
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  it('collects .md and .png files modified after run start', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId);
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 30)); // file clock can lag Date.now() on Linux
    writeFile(workDir, 'output.md', '# Result\nHello world!');
    writeFile(workDir, 'diagram.png', 'PNG_DATA');

    await collectOutputFiles(runId, workflowId, workDir, cutoff);

    const files = all<Row>(
      "SELECT * FROM output_files WHERE workflow_id = ? AND refused_reason IS NULL",
      workflowId,
    );
    const names = files.map((f) => f.name as string);
    assert.ok(names.includes('output.md'), 'should collect output.md');
    assert.ok(names.includes('diagram.png'), 'should collect diagram.png');
  });

  it('does not collect files modified before run start', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'mtime old files');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

    writeFile(workDir, 'pre-existing.md', '# Old file');
    const cutoff = new Date(Date.now() + 5000).toISOString(); // 5 s in future

    await collectOutputFiles(runId, workflowId, workDir, cutoff);

    const files = all<Row>(
      "SELECT * FROM output_files WHERE workflow_id = ? AND name = 'pre-existing.md' AND refused_reason IS NULL",
      workflowId,
    );
    assert.equal(files.length, 0, 'file created before cutoff should not be collected');
  });
});

// ── Extension filter ──────────────────────────────────────────────────────────

describe('collectOutputFiles — extension filter', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'ext'));
    workDir = makeTempWorkDir();
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  it('accepts png, jpg, gif, svg, pdf, md, docx, xlsx, pptx, csv, html, drawio', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'ext allowed');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 30)); // file clock can lag Date.now() on Linux

    const allowed = ['a.png', 'b.jpg', 'c.gif', 'd.svg', 'e.md', 'f.csv', 'g.html', 'h.drawio', 'i.pptx', 'j.xlsx', 'k.docx'];
    for (const name of allowed) writeFile(workDir, `ext-allowed/${name}`, 'x');

    await collectOutputFiles(runId, workflowId, workDir, cutoff);

    const collected = all<Row>(
      'SELECT name FROM output_files WHERE workflow_id = ? AND refused_reason IS NULL',
      workflowId,
    ).map((f) => f.name as string);

    for (const name of allowed) {
      assert.ok(collected.includes(name), `${name} should be collected`);
    }
  });

  it('lists source files from the work folder, copies them to the Vault (the explorer lists it), and skips lock files and build output', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'ext code');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 30)); // file clock can lag Date.now() on Linux

    const shown = ['Component.tsx', 'helper.js', 'run.py', 'setup.sh', 'config.json', 'values.yaml', 'notes.txt'];
    const hidden = ['package-lock.json', 'dist/bundle.js', 'build/out.css', '__pycache__/m.py', '.eslintrc.json', 'binary.exe'];
    for (const name of shown) writeFile(workDir, `ext-code/${name}`, 'x');
    for (const name of hidden) writeFile(workDir, `ext-code/${name}`, 'x');

    await collectOutputFiles(runId, workflowId, workDir, cutoff);

    const collected = all<Row>('SELECT name, mime_type FROM output_files WHERE workflow_id = ?', workflowId);
    const names = collected.map((f) => f.name as string);
    for (const name of shown) assert.ok(names.includes(name), `${name} should be listed`);
    for (const name of hidden) assert.ok(!names.includes(path.basename(name)), `${name} should NOT be listed`);
    assert.equal(collected.find((f) => f.name === 'Component.tsx')?.mime_type, 'text/plain');

    // The explorer lists the Vault folder, so listed source files must be there too (and the skipped ones not).
    const vaultNames = all<Row>('SELECT name FROM vault_files WHERE source_workflow_id = ?', workflowId).map((f) => f.name as string);
    for (const name of shown) assert.ok(vaultNames.includes(name), `${name} should be in the Vault`);
    for (const name of hidden) assert.ok(!vaultNames.includes(path.basename(name)), `${name} should NOT be in the Vault`);
  });
});

// ── Excluded directories ──────────────────────────────────────────────────────

describe('collectOutputFiles — excluded directories', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'excl'));
    workDir = makeTempWorkDir();
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  it('skips home/, .browser/, .claude/, node_modules/ and the agent notes folder (.agent-notes/)', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'excluded dirs');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 30)); // file clock can lag Date.now() on Linux

    const excluded = [
      'home/.aws/credentials.md',
      '.browser/session.png',
      '.claude/skills/guide.md',
      'node_modules/lib/readme.md',
      '.agent-notes/lead-orchestrator.md',
    ];
    for (const rel of excluded) writeFile(workDir, rel, 'secret');
    writeFile(workDir, 'excl-results.md', '# Results');

    await collectOutputFiles(runId, workflowId, workDir, cutoff);

    const collected = all<Row>(
      'SELECT path FROM output_files WHERE workflow_id = ? AND refused_reason IS NULL',
      workflowId,
    ).map((f) => String(f.path).replace(/\\/g, '/'));

    assert.ok(collected.some((p) => p.includes('excl-results.md')), 'results.md should be collected');

    for (const rel of excluded) {
      const basename = rel.split('/').at(-1)!;
      assert.ok(
        !collected.some((p) => p.includes(basename)),
        `${rel} should be excluded`,
      );
    }
  });
});

// ── Hash dedup and versioning ─────────────────────────────────────────────────

describe('collectOutputFiles — hash dedup and versioning', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'dedup'));
    workDir = makeTempWorkDir();
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  it('skips file when content is identical to latest version', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'dedup identical');
    const run1 = await startRun(baseUrl, adminCookie, projectId, workflowId);
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

    writeFile(workDir, 'stable.md', '# Stable');
    await collectOutputFiles(run1, workflowId, workDir, new Date(0).toISOString());

    const run2 = await startRun(baseUrl, adminCookie, projectId, workflowId);
    await collectOutputFiles(run2, workflowId, workDir, new Date(0).toISOString());

    const rows = all<Row>(
      "SELECT version FROM output_files WHERE workflow_id = ? AND name = 'stable.md' AND refused_reason IS NULL",
      workflowId,
    );
    assert.ok(rows.length >= 1, 'should have at least one row');
    const maxVersion = Math.max(...rows.map((r) => r.version as number));
    assert.equal(maxVersion, 1, 'version should not be bumped when content is identical');
  });

  it('bumps version when content changes', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'version bump');
    const run1 = await startRun(baseUrl, adminCookie, projectId, workflowId);
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

    const filePath = writeFile(workDir, 'version-bump.md', '# Version 1');
    await collectOutputFiles(run1, workflowId, workDir, new Date(0).toISOString());

    fs.writeFileSync(filePath, '# Version 2 (updated)', 'utf8');
    const run2 = await startRun(baseUrl, adminCookie, projectId, workflowId);
    await collectOutputFiles(run2, workflowId, workDir, new Date(0).toISOString());

    const rows = all<Row>(
      "SELECT version FROM output_files WHERE workflow_id = ? AND name = 'version-bump.md' AND refused_reason IS NULL ORDER BY version DESC",
      workflowId,
    );
    assert.ok(rows.length >= 2, 'should have 2 version rows');
    assert.equal(rows[0].version as number, 2, 'latest version should be 2');
  });
});

// ── Vault copy ────────────────────────────────────────────────────────────────

describe('collectOutputFiles — Vault copy', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'vault'));
  });

  after(async () => {
    await cleanup();
  });

  it('creates vault_files row with folder set to Sessions/...', async () => {
    const workDir = makeTempWorkDir();
    try {
      const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Vault copy test');
      const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
      dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

      writeFile(workDir, 'vc-arch.png', 'PNG_DATA_1');
      await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());

      const vaultFile = one<Row>(
        "SELECT * FROM vault_files WHERE source_workflow_id = ? AND name LIKE '%arch%'",
        workflowId,
      );
      assert.ok(vaultFile, 'vault_files row should be created');
      assert.ok(String(vaultFile.folder).startsWith('Sessions/'), `folder should start with Sessions/: ${vaultFile.folder}`);
      assert.ok(String(vaultFile.folder).includes(workflowId.slice(0, 8)), 'folder should include workflowId[:8]');
      assert.equal(vaultFile.project_id, projectId, 'vault file should be project-scoped');
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('output_files row has vault_file_id set after copy', async () => {
    const workDir = makeTempWorkDir();
    try {
      const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Vault link test');
      const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
      dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

      writeFile(workDir, 'vc-report.pdf', 'PDF_DATA');
      await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());

      const outFile = one<Row>(
        "SELECT * FROM output_files WHERE workflow_id = ? AND name = 'vc-report.pdf' AND refused_reason IS NULL",
        workflowId,
      );
      assert.ok(outFile, 'output_files row should exist');
      assert.ok(outFile.vault_file_id, 'vault_file_id should be set');
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('replaces vault file in place on second collection (same vault_files id)', async () => {
    const workDir = makeTempWorkDir();
    try {
      const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Replace in place');
      const run1 = await startRun(baseUrl, adminCookie, projectId, workflowId);
      dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

      const filePath = writeFile(workDir, 'vc-live.md', '# Version 1');
      await collectOutputFiles(run1, workflowId, workDir, new Date(0).toISOString());

      const vaultId1 = (one<Row>(
        "SELECT id FROM vault_files WHERE source_workflow_id = ? AND name = 'vc-live.md'",
        workflowId,
      ))?.id as string;
      assert.ok(vaultId1, 'vault_files row should exist after first collect');

      fs.writeFileSync(filePath, '# Version 2', 'utf8');
      const run2 = await startRun(baseUrl, adminCookie, projectId, workflowId);
      await collectOutputFiles(run2, workflowId, workDir, new Date(0).toISOString());

      const vaultId2 = (one<Row>(
        "SELECT id FROM vault_files WHERE source_workflow_id = ? AND name = 'vc-live.md'",
        workflowId,
      ))?.id as string;
      assert.equal(vaultId2, vaultId1, 'vault_files id must not change on replace-in-place');
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('disambiguates files with the same basename from different paths', async () => {
    const workDir = makeTempWorkDir();
    try {
      const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Disambiguation');
      const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
      dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

      writeFile(workDir, 'docs/schema.png', 'PNG_A');
      writeFile(workDir, 'output/schema.png', 'PNG_B');
      await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());

      const vaultFiles = all<Row>(
        'SELECT name FROM vault_files WHERE source_workflow_id = ?',
        workflowId,
      );
      assert.equal(vaultFiles.length, 2, `should create two vault_files rows; got: ${vaultFiles.map((f) => f.name).join(', ')}`);
      const names = vaultFiles.map((f) => f.name as string);
      assert.notEqual(names[0], names[1], 'vault names should be distinct');
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});

// ── API shape: GET /api/workflows/:id/output-files ────────────────────────────

describe('GET /api/workflows/:id/output-files — response shape', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workflowId: string;
  let workDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'shape'));
    workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Shape test session');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);

    workDir = makeTempWorkDir();
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);
    writeFile(workDir, 'results.md', '# Results');
    await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  it('returns 200 with files array and vaultFolder', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.files), 'should have files array');
    assert.ok('vaultFolder' in body, 'should have vaultFolder');
  });

  it('each file has required fields', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files`, { cookie: adminCookie });
    const files = (r.body as Record<string, unknown>).files as Record<string, unknown>[];
    assert.ok(files.length >= 1, `expected at least 1 file, got ${files.length}`);
    const f = files[0];
    for (const field of ['id', 'name', 'path', 'size_bytes', 'mime_type', 'version', 'created_at', 'run_id', 'download_url', 'preview_url']) {
      assert.ok(field in f, `field '${field}' missing`);
    }
    assert.ok('vault_file_id' in f, 'vault_file_id should be present (may be null)');
  });

  it('vaultFolder starts with "Sessions/"', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files`, { cookie: adminCookie });
    const { vaultFolder } = r.body as { vaultFolder: string };
    assert.ok(typeof vaultFolder === 'string', 'vaultFolder should be a string');
    assert.ok(vaultFolder.startsWith('Sessions/'), `vaultFolder should start with Sessions/: ${vaultFolder}`);
  });

  it('path uses forward slashes', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files`, { cookie: adminCookie });
    const files = (r.body as Record<string, unknown>).files as Record<string, unknown>[];
    for (const f of files) {
      assert.ok(!String(f.path).includes('\\'), `path should use forward slashes: ${f.path}`);
    }
  });
});

// ── Download fallback to Vault ────────────────────────────────────────────────

describe('GET .../output-files/:fileId/download — Vault fallback', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workflowId: string;
  let workDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'fallback'));
    workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Fallback test');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);

    workDir = makeTempWorkDir();
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);
    writeFile(workDir, 'fallback-test.md', '# Fallback content');
    await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  it('download returns 200 while work-dir file exists', async () => {
    const listR = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files`, { cookie: adminCookie });
    const files = (listR.body as Record<string, unknown>).files as Record<string, unknown>[];
    assert.ok(files.length >= 1, 'need at least one file');

    const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/output-files/${files[0].id}/download`, {
      headers: { 'X-Requested-With': 'agent-portal', Cookie: adminCookie },
    });
    assert.equal(res.status, 200, `download should return 200`);
    await res.body?.cancel();
  });

  it('download falls back to Vault when work-dir file is removed', async () => {
    const listR = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files`, { cookie: adminCookie });
    const files = (listR.body as Record<string, unknown>).files as Record<string, unknown>[];
    const file = files.find((f) => String(f.name).includes('fallback-test'));
    assert.ok(file, 'fallback-test.md should be in the list');
    assert.ok(file.vault_file_id, 'vault_file_id should be set for fallback to work');

    // Delete work-dir file
    try { fs.rmSync(path.join(workDir, String(file.path)), { force: true }); } catch { /* */ }

    const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/output-files/${file.id}/download`, {
      headers: { 'X-Requested-With': 'agent-portal', Cookie: adminCookie },
    });
    assert.equal(res.status, 200, 'download should return 200 when served from Vault');
    await res.body?.cancel();
  });
});

// ── Access control ────────────────────────────────────────────────────────────

describe('Output files — access control', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workflowId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'acl'));
    workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Access test');
  });

  after(async () => {
    await cleanup();
  });

  it('returns 401 when not authenticated', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files`);
    assert.equal(r.status, 401);
  });
});

// ── Vault zip by folder ───────────────────────────────────────────────────────

describe('GET /api/projects/:id/vault/zip?folder=...', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let vaultFolder: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'zipfolder'));

    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Zip folder test');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    const workDir = makeTempWorkDir();
    try {
      dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);
      writeFile(workDir, 'zip-report.md', '# Report');
      await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());

      const listR = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files`, { cookie: adminCookie });
      vaultFolder = (listR.body as Record<string, unknown>).vaultFolder as string;
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  after(async () => {
    await cleanup();
  });

  it('returns zip for specific folder', async () => {
    assert.ok(vaultFolder, 'vaultFolder should be set');
    const res = await fetch(
      `${baseUrl}/api/projects/${projectId}/vault/zip?scope=project&folder=${encodeURIComponent(vaultFolder)}`,
      { headers: { 'X-Requested-With': 'agent-portal', Cookie: adminCookie } },
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.ok((res.headers.get('content-type') ?? '').includes('zip'), 'should return a zip');
    await res.body?.cancel();
  });
});

// ── Backfill idempotency ──────────────────────────────────────────────────────

describe('collectOutputFiles — backfill idempotency', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'backfill'));
    workDir = makeTempWorkDir();
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  it('calling collectOutputFiles twice does not create duplicate rows', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Backfill idempotency');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

    writeFile(workDir, 'stable-backfill.md', '# Stable content');

    await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());
    await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());

    const rows = all<Row>(
      "SELECT * FROM output_files WHERE workflow_id = ? AND name = 'stable-backfill.md' AND refused_reason IS NULL",
      workflowId,
    );
    assert.equal(rows.length, 1, `should have exactly 1 row after two identical collects, got ${rows.length}`);
    assert.equal(rows[0].version as number, 1, 'version should be 1 after idempotent backfill');
  });

  it('backfill vault rows are idempotent (same vault_files id after two collects)', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Vault backfill idempotency');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

    writeFile(workDir, 'stable-vault-bf.png', 'PNG_STABLE');

    await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());
    const vaultId1 = (one<Row>("SELECT vault_file_id FROM output_files WHERE workflow_id = ? AND name = 'stable-vault-bf.png'", workflowId))?.vault_file_id as string;
    assert.ok(vaultId1, 'vault_file_id should be set after first collect');

    await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());
    const vaultId2 = (one<Row>("SELECT vault_file_id FROM output_files WHERE workflow_id = ? AND name = 'stable-vault-bf.png' ORDER BY version DESC LIMIT 1", workflowId))?.vault_file_id as string;
    assert.equal(vaultId2, vaultId1, 'vault_file_id should remain the same after second collect');
  });
});

// ── Repo copy detection (git status) — skip if git not available ──────────────

describe('collectOutputFiles — repo copy detection (git status)', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workDir: string;

  before(async () => {
    if (!gitAvailable()) return;
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'repocopy'));
    workDir = makeTempWorkDir();
  });

  after(async () => {
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    }
    if (baseUrl) await cleanup();
  });

  it('detects new files added to a git repo via git status --porcelain', async () => {
    if (!gitAvailable() || !baseUrl) return;

    const repoDir = path.join(workDir, 'repos', 'test-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email test@test.com', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name Test', { cwd: repoDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Repo');
    execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m init', { cwd: repoDir, stdio: 'ignore' });

    writeFile(repoDir, 'architecture.png', 'PNG_DATA');

    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Repo copy detection');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

    // Use a far-future cutoff so mtime-based non-repo scan won't pick it up
    await collectOutputFiles(runId, workflowId, workDir, new Date(Date.now() + 60_000).toISOString());

    const files = all<Row>(
      'SELECT path FROM output_files WHERE workflow_id = ? AND refused_reason IS NULL',
      workflowId,
    );
    const paths = files.map((f) => String(f.path).replace(/\\/g, '/'));
    assert.ok(
      paths.some((p) => p.includes('architecture.png')),
      `architecture.png should be detected via git status; got: ${paths.join(', ')}`,
    );
  });

  it('detects files inside a new folder, including names with spaces', async () => {
    if (!gitAvailable() || !baseUrl) return;

    const repoDir = path.join(workDir, 'repos', 'nested-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email test@test.com', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name Test', { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Repo');
    execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m init', { cwd: repoDir, stdio: 'ignore' });

    // A brand-new folder: plain `git status` shows only "?? docs/" here.
    writeFile(repoDir, 'docs/architecture/rhb backend.png', 'PNG_DATA');
    writeFile(repoDir, 'docs/architecture/generate.py', 'print(1)');

    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Nested repo detection');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);
    await collectOutputFiles(runId, workflowId, workDir, new Date(Date.now() + 60_000).toISOString());

    const paths = all<Row>(
      'SELECT path FROM output_files WHERE workflow_id = ? AND refused_reason IS NULL',
      workflowId,
    ).map((f) => String(f.path));
    assert.ok(
      paths.includes('repos/nested-repo/docs/architecture/rhb backend.png'),
      `nested png should be detected; got: ${paths.join(', ')}`,
    );
    assert.ok(!paths.some((p) => p.endsWith('.py')), 'scripts are not outputs');
  });
});

// ── Project skeleton files are inputs, not outputs ────────────────────────────

describe('collectOutputFiles — skeleton files', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'skeleton'));
    workDir = makeTempWorkDir();
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  it('skips CLAUDE.md and docs/decisions.md copied in by the portal', async () => {
    const workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'skeleton files');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

    writeFile(workDir, 'CLAUDE.md', '# Project');
    writeFile(workDir, 'docs/decisions.md', '# Decisions');
    writeFile(workDir, 'docs/report.md', '# Report');
    await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());

    const paths = all<Row>(
      'SELECT path FROM output_files WHERE workflow_id = ? AND refused_reason IS NULL',
      workflowId,
    ).map((f) => String(f.path));
    assert.ok(paths.includes('docs/report.md'), 'a real output is still collected');
    assert.ok(!paths.includes('CLAUDE.md'), 'CLAUDE.md is not an output');
    assert.ok(!paths.includes('docs/decisions.md'), 'docs/decisions.md is not an output');
  });
});

// ── Manual upload into a Vault folder ─────────────────────────────────────────

describe('POST /api/projects/:id/vault/upload — folder field', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'upload-folder'));
  });

  after(async () => cleanup());

  async function upload(folder: string | null): Promise<Record<string, unknown>> {
    const fd = new FormData();
    fd.append('file', new Blob(['hello']), 'note.md');
    fd.append('scope', 'project');
    if (folder !== null) fd.append('folder', folder);
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/vault/upload`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'agent-portal', Cookie: adminCookie },
      body: fd,
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as { vault_file: Record<string, unknown> }).vault_file;
  }

  it('stores the folder the user is viewing', async () => {
    const vf = await upload('Sessions/My run (abc12345)');
    assert.equal(vf.folder, 'Sessions/My run (abc12345)');
  });

  it('drops "." and ".." segments and keeps the root when nothing is left', async () => {
    assert.equal((await upload('../Sessions/./x')).folder, 'Sessions/x');
    assert.equal((await upload('../..')).folder, null);
    assert.equal((await upload(null)).folder, null);
  });
});

// ── Inline download ───────────────────────────────────────────────────────────

describe('GET .../download?inline=1 — inline serving', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workflowId: string;
  let workDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'inline'));
    workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Inline download test');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    workDir = makeTempWorkDir();
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);
    writeFile(workDir, 'photo.png', 'PNG_BYTES');
    writeFile(workDir, 'report.pdf', 'PDF_BYTES');
    writeFile(workDir, 'drawing.svg', 'SVG_BYTES');
    writeFile(workDir, 'document.md', '# Doc');
    await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  async function getFile(name: string): Promise<Record<string, unknown> | undefined> {
    const listR = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files`, { cookie: adminCookie });
    return ((listR.body as Record<string, unknown>).files as Record<string, unknown>[])
      .find((f) => String(f.name) === name);
  }

  it('inline image (png) sends Content-Disposition: inline, correct Content-Type, nosniff, CSP with sandbox', async () => {
    const file = await getFile('photo.png');
    assert.ok(file, 'photo.png should be in the list');

    const res = await fetch(
      `${baseUrl}/api/workflows/${workflowId}/output-files/${file!.id}/download?inline=1`,
      { headers: { 'X-Requested-With': 'agent-portal', Cookie: adminCookie } },
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);

    const cd = res.headers.get('content-disposition') ?? '';
    assert.ok(cd.startsWith('inline;'), `Content-Disposition should start with "inline;", got: ${cd}`);

    const ct = res.headers.get('content-type') ?? '';
    assert.ok(ct.includes('image/png'), `Content-Type should include image/png, got: ${ct}`);

    const xct = res.headers.get('x-content-type-options') ?? '';
    assert.equal(xct, 'nosniff', 'X-Content-Type-Options should be nosniff');

    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes('sandbox'), `CSP should contain sandbox, got: ${csp}`);
    assert.ok(csp.includes("default-src 'none'"), `CSP should contain default-src 'none', got: ${csp}`);

    await res.body?.cancel();
  });

  it('inline SVG sends CSP with sandbox', async () => {
    const file = await getFile('drawing.svg');
    assert.ok(file, 'drawing.svg should be in the list');

    const res = await fetch(
      `${baseUrl}/api/workflows/${workflowId}/output-files/${file!.id}/download?inline=1`,
      { headers: { 'X-Requested-With': 'agent-portal', Cookie: adminCookie } },
    );
    assert.equal(res.status, 200);

    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes('sandbox'), `SVG CSP should contain sandbox, got: ${csp}`);
    await res.body?.cancel();
  });

  it('inline PDF sends inline disposition without sandbox in CSP', async () => {
    const file = await getFile('report.pdf');
    assert.ok(file, 'report.pdf should be in the list');

    const res = await fetch(
      `${baseUrl}/api/workflows/${workflowId}/output-files/${file!.id}/download?inline=1`,
      { headers: { 'X-Requested-With': 'agent-portal', Cookie: adminCookie } },
    );
    assert.equal(res.status, 200);

    const cd = res.headers.get('content-disposition') ?? '';
    assert.ok(cd.startsWith('inline;'), `PDF Content-Disposition should be inline, got: ${cd}`);

    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(!csp.includes('sandbox'), `PDF CSP should NOT contain sandbox, got: ${csp}`);
    await res.body?.cancel();
  });

  it('inline=1 on a non-image/pdf file still sends attachment disposition', async () => {
    const file = await getFile('document.md');
    assert.ok(file, 'document.md should be in the list');

    const res = await fetch(
      `${baseUrl}/api/workflows/${workflowId}/output-files/${file!.id}/download?inline=1`,
      { headers: { 'X-Requested-With': 'agent-portal', Cookie: adminCookie } },
    );
    assert.equal(res.status, 200);

    const cd = res.headers.get('content-disposition') ?? '';
    assert.ok(cd.startsWith('attachment;'), `Non-inline file should still be attachment, got: ${cd}`);
    assert.ok(!res.headers.has('content-security-policy'), 'No CSP for attachment responses');
    await res.body?.cancel();
  });

  it('without inline=1 an image download sends attachment disposition', async () => {
    const file = await getFile('photo.png');
    assert.ok(file);

    const res = await fetch(
      `${baseUrl}/api/workflows/${workflowId}/output-files/${file!.id}/download`,
      { headers: { 'X-Requested-With': 'agent-portal', Cookie: adminCookie } },
    );
    assert.equal(res.status, 200);
    const cd = res.headers.get('content-disposition') ?? '';
    assert.ok(cd.startsWith('attachment;'), `Default download should be attachment, got: ${cd}`);
    await res.body?.cancel();
  });
});

// ── Preview URL includes ?inline=1 ────────────────────────────────────────────

describe('GET .../preview — inline URL', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workflowId: string;
  let workDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'preview-url'));
    workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Preview inline URL test');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    workDir = makeTempWorkDir();
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);
    writeFile(workDir, 'chart.png', 'PNG_BYTES');
    writeFile(workDir, 'slide.pdf', 'PDF_BYTES');
    await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  async function getFileId(name: string): Promise<string> {
    const listR = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files`, { cookie: adminCookie });
    const file = ((listR.body as Record<string, unknown>).files as Record<string, unknown>[])
      .find((f) => String(f.name) === name);
    assert.ok(file, `${name} not found in output files`);
    return file!.id as string;
  }

  it('image preview returns type=inline with a url containing ?inline=1', async () => {
    const id = await getFileId('chart.png');
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files/${id}/preview`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.type, 'inline', `expected type=inline, got ${body.type}`);
    assert.ok(String(body.url).includes('?inline=1'), `url should contain ?inline=1, got: ${body.url}`);
  });

  it('PDF preview returns type=inline with a url containing ?inline=1', async () => {
    const id = await getFileId('slide.pdf');
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files/${id}/preview`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.type, 'inline');
    assert.ok(String(body.url).includes('?inline=1'), `PDF preview url should contain ?inline=1, got: ${body.url}`);
  });
});

// ── Text preview (md/csv) and truncation ──────────────────────────────────────

describe('GET .../preview — text types and truncation', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workflowId: string;
  let workDir: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie: adminCookie, projectId } = await setupAdminAndProject(baseUrl, 'preview-text'));
    workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'Text preview test');
    const runId = await startRun(baseUrl, adminCookie, projectId, workflowId);
    workDir = makeTempWorkDir();
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);

    writeFile(workDir, 'notes.md', 'Hello plain text');
    writeFile(workDir, 'table.csv', 'a,b\n1,2');

    // A file that exceeds the 512 KB preview cap
    const big = Buffer.alloc(600 * 1024, 'x');
    fs.writeFileSync(path.join(workDir, 'big.md'), big);

    await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  async function getFileId(name: string): Promise<string> {
    const listR = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files`, { cookie: adminCookie });
    const file = ((listR.body as Record<string, unknown>).files as Record<string, unknown>[])
      .find((f) => String(f.name) === name);
    assert.ok(file, `${name} not found in output files`);
    return file!.id as string;
  }

  it('.md file returns type=text with content', async () => {
    const id = await getFileId('notes.md');
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files/${id}/preview`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.type, 'text');
    assert.ok(String(body.content).includes('Hello plain text'));
    assert.equal(body.truncated, false);
  });

  it('.csv file returns type=text with content', async () => {
    const id = await getFileId('table.csv');
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files/${id}/preview`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.type, 'text');
    assert.ok(String(body.content).includes('a,b'));
  });

  it('text file larger than 512 KB is truncated', async () => {
    const id = await getFileId('big.md');
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files/${id}/preview`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.type, 'text');
    assert.equal(body.truncated, true, 'truncated should be true for files > 512 KB');
    assert.ok(
      String(body.content).length <= 512 * 1024,
      `content should not exceed 512 KB; got ${String(body.content).length} bytes`,
    );
  });
});
