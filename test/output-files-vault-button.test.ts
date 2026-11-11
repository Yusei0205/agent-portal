/**
 * Adding one session output file to the project Vault by hand: POST /api/workflows/:id/output-files/:fileId/vault
 * (the "Add to Vault" button), including for a project whose automatic copying is off.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { collectOutputFiles } from '../server/output-files.ts';
import { all, one, run as dbRun } from '../server/db.ts';
import type { Row } from '../server/db.ts';

describe('POST output-files/:fileId/vault', () => {
  let baseUrl = '';
  let cookie = '';
  let projectId = '';
  let workflowId = '';
  let fileId = '';
  let workDir = '';
  let runId = '';
  // The demo run started above may move the work folder on its own; point the session back at ours before each request.
  const pin = (): void => { dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId); };

  before(async () => {
    ({ baseUrl } = await createTestServer());
    const setup = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: `vault-btn-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = setup.cookie ?? '';
    const proj = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Vault button project' }, cookie });
    projectId = ((proj.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    // Automatic copying off: nothing reaches the Vault unless a person asks.
    dbRun('UPDATE projects SET vault_generated = 0 WHERE id = ?', projectId);

    const wf = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body: { goal: 'Vault button', engine: 'demo' }, cookie });
    workflowId = ((wf.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
    const start = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/start`, { method: 'POST', body: {}, cookie });
    runId = ((start.body as Record<string, unknown>).run as Record<string, unknown>).id as string;

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-btn-'));
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(path.join(workDir, 'notes.md'), '# hello', 'utf8');
    await collectOutputFiles(runId, workflowId, workDir, cutoff);
    fileId = (one<Row>('SELECT id FROM output_files WHERE workflow_id = ? AND name = ?', workflowId, 'notes.md')?.id as string) ?? '';
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  it('the file is listed but not in the Vault yet', () => {
    assert.ok(fileId, 'output file collected');
    assert.equal(one<Row>('SELECT vault_file_id FROM output_files WHERE id = ?', fileId)?.vault_file_id ?? null, null);
    assert.equal(all<Row>('SELECT id FROM vault_files WHERE source_workflow_id = ?', workflowId).length, 0);
  });

  it('adds it to the Vault and records the link, even with automatic copying off', async () => {
    pin();
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files/${fileId}/vault`, { method: 'POST', body: {}, cookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(body.vault_file_id, 'returns the vault file id');
    const vault = all<Row>('SELECT name, folder FROM vault_files WHERE source_workflow_id = ?', workflowId);
    assert.equal(vault.length, 1);
    assert.equal(vault[0].name, 'notes.md');
    assert.equal(one<Row>('SELECT vault_file_id FROM output_files WHERE id = ?', fileId)?.vault_file_id, body.vault_file_id);
  });

  it('is repeatable: a second request adds nothing new', async () => {
    pin();
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files/${fileId}/vault`, { method: 'POST', body: {}, cookie });
    assert.equal(r.status, 200);
    assert.equal((r.body as Record<string, unknown>).already, true);
    assert.equal(all<Row>('SELECT id FROM vault_files WHERE source_workflow_id = ?', workflowId).length, 1);
  });

  it('the list now reports the vault folder and the link', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files`, { cookie });
    const body = r.body as { files: Array<{ id: string; vault_file_id: string | null }>; vaultFolder: string | null };
    assert.ok(body.vaultFolder, 'vault folder is reported once a file was added');
    assert.ok(body.files.find((f) => f.id === fileId)?.vault_file_id);
  });

  it('answers 404 for an unknown file, 410 when the file is gone, and 401 without a session', async () => {
    assert.equal((await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files/nope/vault`, { method: 'POST', body: {}, cookie })).status, 404);
    assert.equal((await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files/${fileId}/vault`, { method: 'POST', body: {} })).status, 401);

    const second = path.join(workDir, 'gone.md');
    fs.writeFileSync(second, 'x', 'utf8');
    await collectOutputFiles(runId, workflowId, workDir, new Date(Date.now() - 60_000).toISOString());
    const goneId = one<Row>('SELECT id FROM output_files WHERE workflow_id = ? AND name = ?', workflowId, 'gone.md')?.id as string;
    fs.rmSync(second);
    pin();
    assert.equal((await fetchJson(baseUrl, `/api/workflows/${workflowId}/output-files/${goneId}/vault`, { method: 'POST', body: {}, cookie })).status, 410);
  });
});
