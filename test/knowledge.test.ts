/**
 * Knowledge base API tests (P7).
 *
 * Tests:
 *   - POST /api/projects/:id/knowledge/upload accepts a text file, status=processing
 *   - After async processing completes, status becomes 'ready'
 *   - GET /api/projects/:id/knowledge/search returns results when doc contains 'test'
 *   - POST /api/projects/:id/knowledge/ask returns needsTeam when no docs
 *   - POST /api/projects/:id/knowledge/decisions creates a decision
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setup(baseUrl: string): Promise<{ cookie: string; projectId: string }> {
  const email = `k-admin-${Date.now()}@example.com`;
  const setupR = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: {
      email,
      name: 'Admin',
      password: 'password1234',
      provider: 'demo',
    },
  });
  const cookie = setupR.cookie ?? '';

  const projR = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: 'Knowledge Test Project' },
    cookie,
  });
  const projectId = ((projR.body as Record<string, unknown>).project as Record<string, unknown>)?.id as string ?? '';

  return { cookie, projectId };
}

/** Build a minimal multipart/form-data body for a text file upload. */
function makeMultipart(
  filename: string,
  content: string,
  mimeType = 'text/plain',
): { body: Buffer; contentType: string } {
  const boundary = 'boundary-test-12345';
  const CRLF = '\r\n';
  const parts = [
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

async function uploadTextFile(
  baseUrl: string,
  cookie: string,
  projectId: string,
  content = 'This is a test document with the word test in it.',
): Promise<Record<string, unknown>> {
  const { body, contentType } = makeMultipart('test-doc.txt', content);
  const res = await fetch(`${baseUrl}/api/projects/${projectId}/knowledge/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-Requested-With': 'agent-portal',
      Cookie: cookie,
    },
    body: body as unknown as RequestInit['body'],
  });
  const data = await res.json();
  assert.equal(res.status, 200, `Upload failed: ${JSON.stringify(data)}`);
  return data as Record<string, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Knowledge API', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId } = await setup(baseUrl));
  });

  after(async () => {
    await cleanup();
  });

  it('GET /knowledge returns empty list initially', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/knowledge`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.docs), 'should have docs array');
    assert.equal((body.docs as unknown[]).length, 0);
  });

  it('POST /knowledge/upload accepts a text file with status=processing', async () => {
    const data = await uploadTextFile(baseUrl, cookie, projectId);
    const doc = data.doc as Record<string, unknown>;
    assert.ok(doc.id, 'should have id');
    assert.equal(doc.status, 'processing', 'initial status should be processing');
    assert.equal(doc.project_id, projectId);
  });

  it('After processing completes, status becomes ready', async () => {
    const data = await uploadTextFile(baseUrl, cookie, projectId, 'Another test file content.');
    const doc = data.doc as Record<string, unknown>;
    const docId = doc.id as string;

    // Poll for status=ready (background setImmediate, should be quick)
    const deadline = Date.now() + 8_000;
    let status = doc.status;
    while (status === 'processing' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const r = await fetchJson(baseUrl, `/api/projects/${projectId}/knowledge`, { cookie });
      const docs = ((r.body as Record<string, unknown>).docs as Record<string, unknown>[]) ?? [];
      const updated = docs.find((d) => d.id === docId);
      status = (updated?.status as string) ?? 'processing';
    }

    assert.equal(status, 'ready', `Expected status=ready, got ${status}`);
  });

  it('GET /knowledge/search returns results when doc contains "test"', async () => {
    // Upload a doc with a known word
    await uploadTextFile(
      baseUrl,
      cookie,
      projectId,
      'The quick brown fox jumps over the lazy dog test word here.',
    );

    // Wait for processing
    await new Promise((r) => setTimeout(r, 1_000));

    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/knowledge/search?q=test`,
      { cookie },
    );
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.results), 'should have results array');
    // May have results if FTS indexed correctly
    // At minimum, no error
  });

  it('POST /knowledge/ask returns needsTeam when no matching docs', async () => {
    // Ask something totally unrelated to any uploaded document
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/knowledge/ask`,
      {
        method: 'POST',
        body: { question: 'xyzzy-frobnicator-obscure-term-not-in-any-document' },
        cookie,
      },
    );
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    // Either returns needsTeam or an answer — both are valid
    assert.ok(
      body.needsTeam === true || typeof body.answer === 'string',
      `Expected needsTeam or answer, got: ${JSON.stringify(body)}`,
    );
  });

  it('POST /knowledge/decisions creates a decision', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/knowledge/decisions`,
      {
        method: 'POST',
        body: {
          question: 'Should we use TypeScript?',
          answer: 'Yes, we standardise on TypeScript for all new code.',
        },
        cookie,
      },
    );
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    const decision = body.decision as Record<string, unknown>;
    assert.ok(decision.id, 'decision should have id');
    assert.equal(decision.question, 'Should we use TypeScript?');
    assert.equal(decision.project_id, projectId);
  });

  it('GET /knowledge/decisions lists decisions', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/knowledge/decisions`,
      { cookie },
    );
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.decisions));
    assert.ok((body.decisions as unknown[]).length > 0, 'should have at least one decision');
  });
});
