/**
 * Opening a Vault file from the session explorer: GET /api/workflows/:id/ide/file?scope=vault:team&path=<vault file id>.
 * The tree lists Vault files by id; the editor passes that id back as the path (it used to be looked up as a file in the work folder).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { collectOutputFiles } from '../server/output-files.ts';
import { one, run as dbRun } from '../server/db.ts';
import type { Row } from '../server/db.ts';

describe('ide/file for Vault files', () => {
  let baseUrl = '';
  let cookie = '';
  let workflowId = '';
  let vaultId = '';
  let workDir = '';

  before(async () => {
    ({ baseUrl } = await createTestServer());
    const setup = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: `vault-read-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = setup.cookie ?? '';
    const proj = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Vault read project' }, cookie });
    const projectId = ((proj.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    const wf = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body: { goal: 'Vault read', engine: 'demo' }, cookie });
    workflowId = ((wf.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
    const start = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/start`, { method: 'POST', body: {}, cookie });
    const runId = ((start.body as Record<string, unknown>).run as Record<string, unknown>).id as string;

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-read-'));
    dbRun('UPDATE p6_workflows SET work_dir = ? WHERE id = ?', workDir, workflowId);
    fs.writeFileSync(path.join(workDir, 'notes.md'), '# Vault notes\nhello', 'utf8');
    await collectOutputFiles(runId, workflowId, workDir, new Date(0).toISOString());
    vaultId = (one<Row>('SELECT id FROM vault_files WHERE source_workflow_id = ? AND name = ?', workflowId, 'notes.md')?.id as string) ?? '';
  });

  after(async () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    await cleanup();
  });

  it('the output reached the project Vault', () => {
    assert.ok(vaultId, 'vault file exists');
  });

  it('opens a project Vault file by its id and returns its text', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/ide/file?scope=vault:team&path=${encodeURIComponent(vaultId)}`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.type, 'text');
    assert.equal(body.content, '# Vault notes\nhello');
  });

  it('answers 404 for an id that is not in the list, and 401 without a session', async () => {
    assert.equal((await fetchJson(baseUrl, `/api/workflows/${workflowId}/ide/file?scope=vault:team&path=nope`, { cookie })).status, 404);
    assert.equal((await fetchJson(baseUrl, `/api/workflows/${workflowId}/ide/file?scope=vault:team&path=${encodeURIComponent(vaultId)}`, {})).status, 401);
  });

  it('a project Vault file is not available under the personal (My vault) scope', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/ide/file?scope=vault&path=${encodeURIComponent(vaultId)}`, { cookie });
    assert.equal(r.status, 404);
  });
});
