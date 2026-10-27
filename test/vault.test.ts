/**
 * Vault API tests (P7).
 *
 * Tests:
 *   - POST /api/projects/:id/vault/upload stores file, returns vault_file
 *   - GET  /api/projects/:id/vault returns files for correct scopes
 *   - DELETE /api/projects/:id/vault/:fileId removes file
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeMultipart(
  filename: string,
  content: string,
  scope: string,
  mimeType = 'text/plain',
): { body: Buffer; contentType: string } {
  const boundary = 'vault-boundary-67890';
  const CRLF = '\r\n';
  const parts = [
    `--${boundary}${CRLF}`,
    `Content-Disposition: form-data; name="scope"${CRLF}`,
    CRLF,
    scope,
    CRLF,
    `--${boundary}${CRLF}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}`,
    `Content-Type: ${mimeType}${CRLF}`,
    CRLF,
    content,
    CRLF,
    `--${boundary}--${CRLF}`,
  ];
  return {
    body: Buffer.from(parts.join(''), 'utf8'),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function uploadVaultFile(
  baseUrl: string,
  cookie: string,
  projectId: string,
  scope: string,
  filename = 'test-file.txt',
  content = 'Test vault content',
): Promise<Record<string, unknown>> {
  const { body, contentType } = makeMultipart(filename, content, scope);
  const res = await fetch(`${baseUrl}/api/projects/${projectId}/vault/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-Requested-With': 'agent-portal',
      Cookie: cookie,
    },
    body,
  });
  const data = await res.json();
  assert.equal(res.status, 200, `Vault upload failed: ${JSON.stringify(data)}`);
  return data as Record<string, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Vault API', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    const setupR = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: {
        email: `vault-admin-${Date.now()}@example.com`,
        name: 'Admin',
        password: 'password1234',
        provider: 'demo',
      },
    });
    adminCookie = setupR.cookie ?? '';

    const projR = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Vault Test Project' },
      cookie: adminCookie,
    });
    projectId =
      ((projR.body as Record<string, unknown>).project as Record<string, unknown>)?.id as string ?? '';
  });

  after(async () => {
    await cleanup();
  });

  it('GET /vault returns empty list initially', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/vault?scope=project`,
      { cookie: adminCookie },
    );
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.files));
  });

  it('POST /vault/upload stores file and returns vault_file', async () => {
    const data = await uploadVaultFile(
      baseUrl,
      adminCookie,
      projectId,
      'project',
      'project-doc.txt',
      'Project-scoped content',
    );
    const vf = data.vault_file as Record<string, unknown>;
    assert.ok(vf.id, 'should have id');
    assert.equal(vf.name, 'project-doc.txt');
    assert.equal(vf.project_id, projectId);
    assert.equal(vf.user_id, null, 'project scope has no user_id');
  });

  it('POST /vault/upload personal scope sets user_id', async () => {
    const data = await uploadVaultFile(
      baseUrl,
      adminCookie,
      projectId,
      'personal',
      'my-file.txt',
      'Personal content',
    );
    const vf = data.vault_file as Record<string, unknown>;
    assert.ok(vf.user_id, 'personal scope should have user_id');
    assert.equal(vf.project_id, projectId);
  });

  it('GET /vault returns files for correct scopes', async () => {
    // Get project scope
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/vault?scope=project`,
      { cookie: adminCookie },
    );
    assert.equal(r.status, 200);
    const files = ((r.body as Record<string, unknown>).files as Record<string, unknown>[]) ?? [];
    assert.ok(files.length >= 1, `Expected at least 1 project file, got ${files.length}`);
    // All should have null user_id
    for (const f of files) {
      assert.equal(f.user_id, null, 'project scope files should have null user_id');
    }
  });

  it('GET /vault with scope=personal returns personal files only', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/vault?scope=personal`,
      { cookie: adminCookie },
    );
    assert.equal(r.status, 200);
    const files = ((r.body as Record<string, unknown>).files as Record<string, unknown>[]) ?? [];
    for (const f of files) {
      assert.ok(f.user_id, 'personal scope files should have user_id set');
    }
  });

  it('DELETE /vault/:fileId removes file', async () => {
    // Upload a file to delete
    const uploadData = await uploadVaultFile(
      baseUrl,
      adminCookie,
      projectId,
      'project',
      'to-delete.txt',
      'Delete me',
    );
    const fileId = ((uploadData.vault_file as Record<string, unknown>).id as string) ?? '';
    assert.ok(fileId, 'should have fileId');

    // Delete it
    const delR = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/vault/${fileId}`,
      { method: 'DELETE', cookie: adminCookie },
    );
    assert.equal(delR.status, 200, `Delete failed: ${JSON.stringify(delR.body)}`);

    // Verify it's gone from the list
    const listR = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/vault?scope=project`,
      { cookie: adminCookie },
    );
    const files = ((listR.body as Record<string, unknown>).files as Record<string, unknown>[]) ?? [];
    const stillThere = files.find((f) => f.id === fileId);
    assert.equal(stillThere, undefined, 'deleted file should not appear in list');
  });

  it('Download endpoint returns 200 for existing file', async () => {
    const uploadData = await uploadVaultFile(
      baseUrl,
      adminCookie,
      projectId,
      'project',
      'download-test.txt',
      'Download content',
    );
    const fileId = ((uploadData.vault_file as Record<string, unknown>).id as string) ?? '';

    const res = await fetch(
      `${baseUrl}/api/projects/${projectId}/vault/${fileId}/download`,
      {
        headers: {
          'X-Requested-With': 'agent-portal',
          Cookie: adminCookie,
        },
      },
    );
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const content = await res.text();
    assert.ok(content.includes('Download content'), 'should return file content');
  });
});
