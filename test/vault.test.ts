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
    body: body as unknown as RequestInit['body'],
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

// ── Bulk-move and bulk-delete tests ──────────────────────────────────────────

describe('Vault Bulk Move and Delete API', () => {
  let baseUrl: string;
  let adminCookie: string;
  let memberCookie: string;
  let nonMemberCookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    const adminEmail = `bulk-admin-${Date.now()}@example.com`;

    // Admin user (setup + login)
    await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: adminEmail, name: 'BulkAdmin', password: 'password1234', provider: 'demo' },
    });
    const adminLoginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: adminEmail, password: 'password1234' },
    });
    adminCookie = adminLoginR.cookie ?? '';

    // Project
    const projR = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Bulk Vault Test Project' },
      cookie: adminCookie,
    });
    projectId =
      ((projR.body as Record<string, unknown>).project as Record<string, unknown>)?.id as string ?? '';

    // Regular member user (created via admin, then login)
    const memberEmail = `bulk-member-${Date.now()}@example.com`;
    const memberCreateR = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: memberEmail, name: 'BulkMember', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    const memberId =
      ((memberCreateR.body as Record<string, unknown>).user as Record<string, unknown>)?.id as string ?? '';
    const memberLoginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: memberEmail, password: 'password1234' },
    });
    memberCookie = memberLoginR.cookie ?? '';

    // Add member to project
    await fetchJson(baseUrl, `/api/projects/${projectId}/members`, {
      method: 'POST',
      body: { userId: memberId, role: 'editor' },
      cookie: adminCookie,
    });

    // Non-member user (authenticated but not in project)
    const nonMemberEmail = `bulk-nonmember-${Date.now()}@example.com`;
    await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: nonMemberEmail, name: 'NonMember', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    const nonMemberLoginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: nonMemberEmail, password: 'password1234' },
    });
    nonMemberCookie = nonMemberLoginR.cookie ?? '';
  });

  after(async () => {
    await cleanup();
  });

  it('POST /vault/move moves project files to a named folder', async () => {
    const up = await uploadVaultFile(baseUrl, adminCookie, projectId, 'project', 'move-me.txt', 'data');
    const fileId = ((up.vault_file as Record<string, unknown>).id as string) ?? '';

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/vault/move`, {
      method: 'POST',
      body: { fileIds: [fileId], folder: 'Session/Run 1' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `move failed: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.moved, 1);
    const files = body.files as Record<string, unknown>[];
    assert.equal(files.length, 1);
    assert.equal(files[0].id, fileId);
    assert.equal(files[0].folder, 'Session/Run 1', 'folder should be set');
  });

  it('POST /vault/move with folder=null moves files to root', async () => {
    const up = await uploadVaultFile(baseUrl, adminCookie, projectId, 'project', 'move-to-root.txt', 'data');
    const fileId = ((up.vault_file as Record<string, unknown>).id as string) ?? '';

    // First move to a folder
    await fetchJson(baseUrl, `/api/projects/${projectId}/vault/move`, {
      method: 'POST',
      body: { fileIds: [fileId], folder: 'SomeFolder' },
      cookie: adminCookie,
    });

    // Then move to root
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/vault/move`, {
      method: 'POST',
      body: { fileIds: [fileId], folder: null },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const files = ((r.body as Record<string, unknown>).files as Record<string, unknown>[]) ?? [];
    assert.equal(files[0].folder, null, 'folder should be null after moving to root');
  });

  it('POST /vault/move with unknown id returns 404 and leaves valid file unchanged', async () => {
    const up = await uploadVaultFile(baseUrl, adminCookie, projectId, 'project', 'stays-put.txt', 'data');
    const fileId = ((up.vault_file as Record<string, unknown>).id as string) ?? '';

    // First put the file in a known folder
    await fetchJson(baseUrl, `/api/projects/${projectId}/vault/move`, {
      method: 'POST',
      body: { fileIds: [fileId], folder: 'OriginalFolder' },
      cookie: adminCookie,
    });

    // Try to move alongside a non-existent id
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/vault/move`, {
      method: 'POST',
      body: { fileIds: [fileId, 'non-existent-id-xyz'], folder: 'NewFolder' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 404, `expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);

    // Valid file should be unchanged
    const listR = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/vault?scope=project`,
      { cookie: adminCookie },
    );
    const files = ((listR.body as Record<string, unknown>).files as Record<string, unknown>[]) ?? [];
    const staysPut = files.find((f) => f.id === fileId);
    assert.ok(staysPut, 'file should still exist');
    assert.equal(staysPut!.folder, 'OriginalFolder', 'folder should not have changed');
  });

  it('POST /vault/move with personal file id returns 404 (not project-scope)', async () => {
    const up = await uploadVaultFile(baseUrl, adminCookie, projectId, 'personal', 'personal-file.txt', 'data');
    const fileId = ((up.vault_file as Record<string, unknown>).id as string) ?? '';

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/vault/move`, {
      method: 'POST',
      body: { fileIds: [fileId], folder: 'SomeFolder' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 404, 'personal-scope file should not be found by bulk-move');
  });

  it('POST /vault/move sanitises folder name', async () => {
    const up = await uploadVaultFile(baseUrl, adminCookie, projectId, 'project', 'sanitise-test.txt', 'data');
    const fileId = ((up.vault_file as Record<string, unknown>).id as string) ?? '';

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/vault/move`, {
      method: 'POST',
      body: { fileIds: [fileId], folder: 'Hello/../<evil>\\World!' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const files = ((r.body as Record<string, unknown>).files as Record<string, unknown>[]) ?? [];
    const sanitised = files[0].folder as string;
    assert.ok(sanitised, 'folder should be non-null after sanitising non-empty input');
    assert.ok(!sanitised.includes('..'), 'sanitised folder should not contain ..');
    assert.ok(!sanitised.includes('<'), 'sanitised folder should not contain <');
    assert.ok(!sanitised.includes('>'), 'sanitised folder should not contain >');
  });

  it('POST /vault/move returns 404 for non-member', async () => {
    const up = await uploadVaultFile(baseUrl, adminCookie, projectId, 'project', 'member-only.txt', 'data');
    const fileId = ((up.vault_file as Record<string, unknown>).id as string) ?? '';

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/vault/move`, {
      method: 'POST',
      body: { fileIds: [fileId], folder: 'Folder' },
      cookie: nonMemberCookie,
    });
    assert.equal(r.status, 404, 'non-member should be denied (requireMember → 404)');
  });

  it('POST /vault/move with empty fileIds returns 400', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/vault/move`, {
      method: 'POST',
      body: { fileIds: [], folder: 'Folder' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });

  it('POST /vault/delete removes rows and files, returns deleted count', async () => {
    const up1 = await uploadVaultFile(baseUrl, adminCookie, projectId, 'project', 'bulk-del-1.txt', 'data1');
    const up2 = await uploadVaultFile(baseUrl, adminCookie, projectId, 'project', 'bulk-del-2.txt', 'data2');
    const id1 = ((up1.vault_file as Record<string, unknown>).id as string) ?? '';
    const id2 = ((up2.vault_file as Record<string, unknown>).id as string) ?? '';

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/vault/delete`, {
      method: 'POST',
      body: { fileIds: [id1, id2] },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `bulk delete failed: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.deleted, 2);

    // Files should no longer appear in the list
    const listR = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/vault?scope=project`,
      { cookie: adminCookie },
    );
    const files = ((listR.body as Record<string, unknown>).files as Record<string, unknown>[]) ?? [];
    assert.equal(files.find((f) => f.id === id1), undefined, 'file 1 should be deleted');
    assert.equal(files.find((f) => f.id === id2), undefined, 'file 2 should be deleted');
  });

  it('POST /vault/delete with unknown id returns 404 and no rows deleted', async () => {
    const up = await uploadVaultFile(baseUrl, adminCookie, projectId, 'project', 'not-deleted.txt', 'data');
    const fileId = ((up.vault_file as Record<string, unknown>).id as string) ?? '';

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/vault/delete`, {
      method: 'POST',
      body: { fileIds: [fileId, 'no-such-file-abc'] },
      cookie: adminCookie,
    });
    assert.equal(r.status, 404);

    // Valid file should still exist
    const listR = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/vault?scope=project`,
      { cookie: adminCookie },
    );
    const files = ((listR.body as Record<string, unknown>).files as Record<string, unknown>[]) ?? [];
    assert.ok(files.find((f) => f.id === fileId), 'file should still exist after failed bulk delete');
  });

  it('POST /vault/delete rejects deleting another user personal file (403)', async () => {
    // Admin uploads a personal file (user_id = admin's id)
    const up = await uploadVaultFile(baseUrl, adminCookie, projectId, 'personal', 'admin-personal.txt', 'private');
    const fileId = ((up.vault_file as Record<string, unknown>).id as string) ?? '';

    // Member (non-admin, in the project) tries to bulk-delete the admin's personal file
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/vault/delete`, {
      method: 'POST',
      body: { fileIds: [fileId] },
      cookie: memberCookie,
    });
    assert.equal(r.status, 403, 'should not be able to delete another member\'s personal file');
  });

  it('POST /vault/delete with empty fileIds returns 400', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/vault/delete`, {
      method: 'POST',
      body: { fileIds: [] },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });
});
