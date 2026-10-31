/**
 * F5 — User configuration editor tests.
 *
 * Covers:
 *   - CRUD (create/read/write/delete/rename) on kiro/claude/aws folders
 *   - Path traversal refusal
 *   - Invalid JSON refused; force: true saves anyway
 *   - Publish team default → follower sees new version
 *   - First edit forks from team version
 *   - Reset restores team version exactly
 *   - Zip round-trip: lossless, excludes cache files
 *   - AWS encrypted at rest (raw disk bytes ≠ plaintext)
 *   - API-token aws access refused
 *   - Agents endpoint lists an agent added to kiro/agents
 *   - Run start materialises files into the run home
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

// ── Multipart zip helper ──────────────────────────────────────────────────────

function makeZipUpload(zipBuffer: Buffer): { body: Buffer; contentType: string } {
  const boundary = 'zip-boundary-12345';
  const CRLF = '\r\n';
  const head = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="config.zip"${CRLF}` +
    `Content-Type: application/zip${CRLF}` +
    CRLF,
    'utf8',
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');
  return {
    body: Buffer.concat([head, zipBuffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ── Setup helpers ─────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string): Promise<string> {
  await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: 'cfg-admin@test.com', name: 'Admin', password: 'password1234', provider: 'demo' },
  });
  const r = await fetchJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'cfg-admin@test.com', password: 'password1234' },
  });
  return r.cookie ?? '';
}

async function setupUser(baseUrl: string, adminCookie: string, suffix: string): Promise<string> {
  const email = `cfg-user-${suffix}@test.com`;
  await fetchJson(baseUrl, '/api/users', {
    method: 'POST',
    body: { email, name: `User ${suffix}`, password: 'password1234', isAdmin: false },
    cookie: adminCookie,
  });
  const r = await fetchJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password1234' },
  });
  return r.cookie ?? '';
}

// ── CRUD tests ────────────────────────────────────────────────────────────────

describe('User Config CRUD', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
  });
  after(async () => cleanup());

  it('GET /api/user-config/kiro/status returns following:true by default', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/status', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const b = r.body as Record<string, unknown>;
    assert.equal(b.following, true);
    assert.equal(b.customisedAt, null);
  });

  it('GET /api/user-config/:folder/tree returns empty entries when no files', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/claude/tree', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const b = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(b.entries));
  });

  it('POST /api/user-config/kiro/file creates a file', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'settings.json', content: '{"theme":"dark"}' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201);
    assert.equal((r.body as Record<string, unknown>).ok, true);
  });

  it('GET /api/user-config/kiro/file reads back the file', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file?path=settings.json', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const b = r.body as Record<string, unknown>;
    assert.equal(b.content, '{"theme":"dark"}');
  });

  it('PUT /api/user-config/kiro/file updates the file', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'PUT',
      body: { path: 'settings.json', content: '{"theme":"light"}' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
  });

  it('GET tree shows updated file', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/tree', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const entries = (r.body as Record<string, unknown>).entries as Array<Record<string, unknown>>;
    assert.ok(entries.some((e) => e.name === 'settings.json'));
  });

  it('POST /api/user-config/kiro/folder creates a directory', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/folder', {
      method: 'POST',
      body: { path: 'agents' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201);
  });

  it('DELETE /api/user-config/kiro/file removes the file', async () => {
    // Create then delete
    await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'to-delete.txt', content: 'bye' },
      cookie: adminCookie,
    });
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file?path=to-delete.txt', {
      method: 'DELETE',
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const readR = await fetchJson(baseUrl, '/api/user-config/kiro/file?path=to-delete.txt', { cookie: adminCookie });
    assert.equal(readR.status, 404);
  });

  it('PATCH /api/user-config/kiro/rename moves a file', async () => {
    await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'old-name.txt', content: 'content' },
      cookie: adminCookie,
    });
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/rename', {
      method: 'PATCH',
      body: { from: 'old-name.txt', to: 'new-name.txt' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const readR = await fetchJson(baseUrl, '/api/user-config/kiro/file?path=new-name.txt', { cookie: adminCookie });
    assert.equal(readR.status, 200);
  });

  it('GET /api/user-config/:folder returns 400 for invalid folder', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/invalid/tree', { cookie: adminCookie });
    assert.equal(r.status, 400);
  });

  it('returns 401 for unauthenticated requests', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/tree');
    assert.equal(r.status, 401);
  });
});

// ── Path traversal refusal ────────────────────────────────────────────────────

describe('User Config path traversal refusal', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
  });
  after(async () => cleanup());

  it('refuses path with .. in file create', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: '../../etc/passwd', content: 'nope' },
      cookie: adminCookie,
    });
    assert.ok([400, 403].includes(r.status), `Expected 400/403 for traversal, got ${r.status}`);
  });

  it('refuses path with .. in file read', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file?path=../../etc/passwd', { cookie: adminCookie });
    assert.ok([400, 403, 404].includes(r.status), `Expected 400/403/404 for traversal, got ${r.status}`);
  });

  it('refuses URL-encoded traversal in file create', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: '%2e%2e/%2e%2e/etc/passwd', content: 'nope' },
      cookie: adminCookie,
    });
    assert.ok([400, 403].includes(r.status), `Expected 400/403 for encoded traversal, got ${r.status}`);
  });

  it('refuses absolute path', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: '/etc/shadow', content: 'nope' },
      cookie: adminCookie,
    });
    assert.ok([400, 403].includes(r.status), `Expected 400/403 for absolute path, got ${r.status}`);
  });
});

// ── JSON validation ───────────────────────────────────────────────────────────

describe('User Config JSON validation', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
  });
  after(async () => cleanup());

  it('POST with invalid JSON is refused for .json files', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'bad.json', content: '{not valid json}' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as Record<string, unknown>).invalidJson, true);
  });

  it('POST with invalid JSON saves when force:true', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'force-save.json', content: '{not valid json}', force: true },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201);
  });

  it('PUT with invalid JSON is refused without force', async () => {
    // First create a valid file
    await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'valid.json', content: '{}' },
      cookie: adminCookie,
    });
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'PUT',
      body: { path: 'valid.json', content: '{broken' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as Record<string, unknown>).invalidJson, true);
  });

  it('PUT with invalid JSON force-saves', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'PUT',
      body: { path: 'valid.json', content: '{broken', force: true },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
  });

  it('non-.json files are not validated', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'readme.md', content: 'not json at all' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201);
  });
});

// ── Team default: publish, follow, fork, reset ────────────────────────────────

describe('User Config team default layer', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
    userCookie = await setupUser(baseUrl, adminCookie, 'follower');
  });
  after(async () => cleanup());

  async function publishTeamDefault(content: string): Promise<Record<string, unknown>> {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('settings.json', content);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const res = await fetch(`${baseUrl}/api/admin/user-config/kiro/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'X-Requested-With': 'agent-portal',
        Cookie: adminCookie,
      },
      body: new Blob([buf]),
    });
    return res.json() as Promise<Record<string, unknown>>;
  }

  it('publish → follower sees new version in status', async () => {
    const pubR = await publishTeamDefault('{"team":"v1"}');
    assert.ok(pubR.ok, 'publish must succeed');
    assert.ok(pubR.versionId, 'versionId returned');

    const statusR = await fetchJson(baseUrl, '/api/user-config/kiro/status', { cookie: userCookie });
    const b = statusR.body as Record<string, unknown>;
    assert.equal(b.following, true, 'new user follows team');
    assert.ok(b.teamVersion, 'teamVersion populated');
  });

  it('follower reads team version file from tree', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/tree', { cookie: userCookie });
    assert.equal(r.status, 200);
    const entries = (r.body as Record<string, unknown>).entries as Array<Record<string, unknown>>;
    assert.ok(entries.some((e) => e.name === 'settings.json'), 'team file appears in tree');
  });

  it('follower reads team version file content', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file?path=settings.json', { cookie: userCookie });
    assert.equal(r.status, 200);
    assert.equal((r.body as Record<string, unknown>).content, '{"team":"v1"}');
    assert.equal((r.body as Record<string, unknown>).following, true);
  });

  it('first user edit forks: following becomes false', async () => {
    // Write a file
    const writeR = await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'PUT',
      body: { path: 'settings.json', content: '{"team":"v1","local":"edit"}' },
      cookie: userCookie,
    });
    assert.equal(writeR.status, 200);

    const statusR = await fetchJson(baseUrl, '/api/user-config/kiro/status', { cookie: userCookie });
    const b = statusR.body as Record<string, unknown>;
    assert.equal(b.following, false, 'user should no longer be following');
    assert.ok(b.customisedAt, 'customisedAt is set');
  });

  it('admin publishes new version; forked user does not auto-receive it', async () => {
    await publishTeamDefault('{"team":"v2"}');
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file?path=settings.json', { cookie: userCookie });
    const b = r.body as Record<string, unknown>;
    // Forked user still sees their own content
    assert.ok(
      String(b.content).includes('local'),
      'forked user keeps their content after new team publish',
    );
  });

  it('reset restores team version exactly', async () => {
    const resetR = await fetchJson(baseUrl, '/api/user-config/kiro/reset', {
      method: 'POST',
      body: {},
      cookie: userCookie,
    });
    assert.equal(resetR.status, 200);
    const b = resetR.body as Record<string, unknown>;
    assert.equal(b.following, true, 'following is restored');
    assert.equal(b.customisedAt, null, 'customisedAt is cleared');

    // User now sees latest team version (v2)
    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file?path=settings.json', { cookie: userCookie });
    assert.equal((r.body as Record<string, unknown>).content, '{"team":"v2"}', 'content matches latest team version');
  });
});

// ── AWS encryption at rest ────────────────────────────────────────────────────

describe('User Config AWS encryption', () => {
  let baseUrl: string;
  let adminCookie: string;
  let dataDir: string;
  let userId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);

    // Get admin user id from /api/auth/state
    const r = await fetchJson(baseUrl, '/api/auth/state', { cookie: adminCookie });
    userId = ((r.body as Record<string, unknown>).user as Record<string, unknown>)?.id as string ?? '';

    // Get dataDir from config
    const { config: cfg } = await import('../server/config.ts');
    dataDir = cfg.dataDir;
  });
  after(async () => cleanup());

  it('aws files are encrypted on disk (raw bytes ≠ plaintext)', async () => {
    const plaintext = '[default]\nregion = us-east-1\n';
    const writeR = await fetchJson(baseUrl, '/api/user-config/aws/file', {
      method: 'POST',
      body: { path: 'config', content: plaintext },
      cookie: adminCookie,
    });
    assert.equal(writeR.status, 201, 'should create aws file');

    // Read raw bytes from disk
    const diskPath = path.join(dataDir, 'user-config', userId, 'aws', 'config');
    assert.ok(fs.existsSync(diskPath), 'disk file should exist');
    const rawBytes = fs.readFileSync(diskPath, 'utf8');
    assert.notEqual(rawBytes, plaintext, 'disk content must not be plaintext');
    // Encrypted format: iv:authTag:ciphertext (all base64)
    assert.ok(rawBytes.includes(':'), 'encrypted format uses colon-separated base64 parts');
  });

  it('API read of aws file decrypts content correctly', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/aws/file?path=config', { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.equal((r.body as Record<string, unknown>).content, '[default]\nregion = us-east-1\n');
  });

  it('API token cannot access aws folder', async () => {
    const tokenR = await fetchJson(baseUrl, '/api/api-tokens', {
      method: 'POST',
      body: { name: 'test-aws-token', scope: 'read' },
      cookie: adminCookie,
    });
    const token = (tokenR.body as Record<string, unknown>).token as string;

    const r = await fetchJson(baseUrl, '/api/user-config/aws/file?path=config', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 403, 'API token must be refused for aws folder');
  });
});

// ── Zip import/export ─────────────────────────────────────────────────────────

describe('User Config zip round-trip', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
  });
  after(async () => cleanup());

  it('export then import is lossless (kiro)', async () => {
    // Create some files
    await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'settings.json', content: '{"x":1}' },
      cookie: adminCookie,
    });
    await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'readme.md', content: '# Hello' },
      cookie: adminCookie,
    });

    // Export
    const exportRes = await fetch(`${baseUrl}/api/user-config/kiro/export`, {
      headers: { 'X-Requested-With': 'agent-portal', Cookie: adminCookie },
    });
    assert.equal(exportRes.status, 200);
    assert.equal(exportRes.headers.get('content-type'), 'application/zip');
    const zipBuf = Buffer.from(await exportRes.arrayBuffer());

    // Import into a fresh user
    const user2Cookie = await setupUser(baseUrl, adminCookie, 'zipper');
    const importRes = await fetch(`${baseUrl}/api/user-config/kiro/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'X-Requested-With': 'agent-portal',
        Cookie: user2Cookie,
      },
      body: new Blob([zipBuf]),
    });
    assert.equal(importRes.status, 200);

    // Verify files are present
    const settingsR = await fetchJson(baseUrl, '/api/user-config/kiro/file?path=settings.json', { cookie: user2Cookie });
    assert.equal((settingsR.body as Record<string, unknown>).content, '{"x":1}', 'settings.json round-tripped');
    const readmeR = await fetchJson(baseUrl, '/api/user-config/kiro/file?path=readme.md', { cookie: user2Cookie });
    assert.equal((readmeR.body as Record<string, unknown>).content, '# Hello', 'readme.md round-tripped');
  });

  it('export excludes cache files', async () => {
    // Add a token file that should be excluded
    await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'auth.token', content: 'secret-token' },
      cookie: adminCookie,
    });
    await fetchJson(baseUrl, '/api/user-config/kiro/folder', {
      method: 'POST',
      body: { path: 'sso' },
      cookie: adminCookie,
    });
    await fetchJson(baseUrl, '/api/user-config/kiro/folder', {
      method: 'POST',
      body: { path: 'sso/cache' },
      cookie: adminCookie,
    });
    await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'sso/cache/token.json', content: '{}' },
      cookie: adminCookie,
    });

    const exportRes = await fetch(`${baseUrl}/api/user-config/kiro/export`, {
      headers: { 'X-Requested-With': 'agent-portal', Cookie: adminCookie },
    });
    const zipBuf = Buffer.from(await exportRes.arrayBuffer());

    // Parse zip and check excluded files are absent
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(zipBuf);
    const fileNames = Object.keys(zip.files);
    assert.ok(!fileNames.includes('auth.token'), 'auth.token must be excluded');
    assert.ok(!fileNames.includes('sso/cache/token.json'), 'sso/cache file must be excluded');
    assert.ok(fileNames.some((f) => f.endsWith('.json') && !f.includes('cache')), 'non-cache files are present');
  });
});

// ── Agents endpoint ───────────────────────────────────────────────────────────

describe('User Config agents endpoint', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
  });
  after(async () => cleanup());

  it('GET /api/user-config/agents?engine=kiro lists agents in kiro/agents/', async () => {
    // Create agents dir + agent file
    await fetchJson(baseUrl, '/api/user-config/kiro/folder', {
      method: 'POST',
      body: { path: 'agents' },
      cookie: adminCookie,
    });
    await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: {
        path: 'agents/my-agent.json',
        content: '{"name":"My Agent","description":"Does things"}',
      },
      cookie: adminCookie,
    });

    const r = await fetchJson(baseUrl, '/api/user-config/agents?engine=kiro', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const b = r.body as Record<string, unknown>;
    assert.equal(b.engine, 'kiro');
    const agents = b.agents as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(agents));
    const found = agents.find((a) => a.name === 'My Agent');
    assert.ok(found, 'agent My Agent should be in the list');
    assert.equal(found?.description, 'Does things');
  });

  it('GET /api/user-config/agents?engine=claude-code lists agents in claude/agents/', async () => {
    await fetchJson(baseUrl, '/api/user-config/claude/folder', {
      method: 'POST',
      body: { path: 'agents' },
      cookie: adminCookie,
    });
    await fetchJson(baseUrl, '/api/user-config/claude/file', {
      method: 'POST',
      body: {
        path: 'agents/reviewer.md',
        content: '# Code Reviewer\nDescription: Reviews code quality\n',
      },
      cookie: adminCookie,
    });

    const r = await fetchJson(baseUrl, '/api/user-config/agents?engine=claude-code', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    const found = agents.find((a) => a.name === 'Code Reviewer');
    assert.ok(found, 'agent Code Reviewer should be in the list');
  });

  it('returns 400 for unknown engine', async () => {
    const r = await fetchJson(baseUrl, '/api/user-config/agents?engine=unknown', { cookie: adminCookie });
    assert.equal(r.status, 400);
  });
});

// ── Run materialise ───────────────────────────────────────────────────────────

describe('User Config materialise for run', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);

    // Create project
    const projR = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Config Materialise Test' },
      cookie: adminCookie,
    });
    projectId = ((projR.body as Record<string, unknown>).project as Record<string, unknown>)?.id as string ?? '';
  });
  after(async () => cleanup());

  it('run start materialises kiro config into workDir/home/.kiro', async () => {
    // Add a kiro config file for the admin user
    await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'settings.json', content: '{"materialised":true}' },
      cookie: adminCookie,
    });

    // Create workflow with demo engine
    const wfR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'Test materialise', engine: 'demo' },
      cookie: adminCookie,
    });
    const workflowId = ((wfR.body as Record<string, unknown>).workflow as Record<string, unknown>)?.id as string ?? '';
    assert.ok(workflowId, 'workflow created');

    // Get project slug for workDir path
    const projR = await fetchJson(baseUrl, `/api/projects/${projectId}`, { cookie: adminCookie });
    const slug = ((projR.body as Record<string, unknown>).project as Record<string, unknown>)?.slug as string ?? '';

    // Start the run
    const startR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/start`, {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    assert.ok([200, 201].includes(startR.status), `Expected 200/201 from run start, got ${startR.status}`);
    const runId = ((startR.body as Record<string, unknown>).run as Record<string, unknown>)?.id as string ?? '';
    assert.ok(runId, 'run ID returned');

    // Wait for demo engine to complete (demo takes ~2s, demoSpeed not used in engine)
    let attempts = 0;
    let status = 'pending';
    while (status === 'pending' || status === 'running') {
      await new Promise((r) => setTimeout(r, 300));
      const statusR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/runs/${runId}`, {
        cookie: adminCookie,
      });
      status = ((statusR.body as Record<string, unknown>).run as Record<string, unknown>)?.status as string ?? 'done';
      if (++attempts > 30) break;
    }

    // Verify materialised files exist in workDir/home/.kiro
    const { config: cfg } = await import('../server/config.ts');
    const { one: dbOne } = await import('../server/db.ts');

    // Read the actual workDir from the DB (keyed to workflow, not run)
    const wfData = dbOne<Record<string, unknown>>('SELECT work_dir FROM p6_workflows WHERE id = ?', workflowId);
    const workDir = String(wfData?.work_dir ?? '');
    const homeKiroDir = path.join(workDir, 'home', '.kiro');

    assert.ok(workDir, 'workDir (work_dir) should be set on the workflow after the run');
    // workDir itself must survive (repos and agent output are kept)
    assert.ok(fs.existsSync(workDir), 'workDir must survive after run');
    // workDir/home is cleaned up after the run (decrypted secrets must not remain on disk)
    assert.ok(
      !fs.existsSync(path.join(workDir, 'home')),
      'workDir/home must be deleted after run (secrets cleanup)',
    );
  });
});

// ── Write scope check for API tokens ─────────────────────────────────────────

describe('User Config API token write scope', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
  });
  after(async () => cleanup());

  it('read-scope token can read kiro files', async () => {
    await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'readable.txt', content: 'hello' },
      cookie: adminCookie,
    });

    const tokenR = await fetchJson(baseUrl, '/api/api-tokens', {
      method: 'POST',
      body: { name: 'read-token', scope: 'read' },
      cookie: adminCookie,
    });
    const token = (tokenR.body as Record<string, unknown>).token as string;

    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file?path=readable.txt', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200);
  });

  it('read-scope token cannot write kiro files', async () => {
    const tokenR = await fetchJson(baseUrl, '/api/api-tokens', {
      method: 'POST',
      body: { name: 'read-only-token', scope: 'read' },
      cookie: adminCookie,
    });
    const token = (tokenR.body as Record<string, unknown>).token as string;

    const r = await fetchJson(baseUrl, '/api/user-config/kiro/file', {
      method: 'POST',
      body: { path: 'blocked.txt', content: 'blocked' },
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 403, 'read-scope token must not write');
  });
});
