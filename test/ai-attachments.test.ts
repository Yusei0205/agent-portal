/**
 * AI Attachments feature tests.
 *
 * Coverage:
 *   Upload endpoint: valid files, invalid files, size limits, path traversal
 *   Delete endpoint: success, 404, linked attachment rejection
 *   attachmentIds validation: >5, unknown ID, cross-project ID
 *   Generate + DOCX attachment: generation succeeds; attachment cleaned up after
 *   PNG image blocks: Bedrock, Anthropic, LiteLLM providers each include correct image block
 *   Create-module view: attachments array in response; linked parent; delete cascades
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import {
  setBedrockClientFactory,
  callTextModel,
  type BedrockClientLike,
  type BedrockConverseInput,
} from '../server/testing/model-provider.ts';
import { setModelCallFn } from '../server/testing/generate.ts';
import type { ModelCallContext } from '../server/testing/generate.ts';
import { setSetting } from '../server/settings.ts';
import { getDb, insert, run as dbRun, one } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { encrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';
import type { Row } from '../server/db.ts';

// ── Shared helpers ─────────────────────────────────────────────────────────────

function makeMultipart(
  filename: string,
  data: Buffer,
  mimeType = 'application/octet-stream',
): { body: Buffer; contentType: string } {
  const boundary = 'test-boundary-12345';
  const CRLF = '\r\n';
  const headStr = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${mimeType}`,
    '',
    '',
  ].join(CRLF);
  const tailStr = `${CRLF}--${boundary}--${CRLF}`;
  return {
    body: Buffer.concat([Buffer.from(headStr, 'binary'), data, Buffer.from(tailStr, 'binary')]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function uploadFile(
  baseUrl: string,
  cookie: string,
  projectId: string,
  filename: string,
  data: Buffer,
  mimeType = 'application/octet-stream',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { body: mpBody, contentType } = makeMultipart(filename, data, mimeType);
  const resp = await fetch(`${baseUrl}/api/projects/${projectId}/ai-attachments`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'X-Requested-With': 'agent-portal', Cookie: cookie },
    body: mpBody as unknown as BodyInit,
  });
  return { status: resp.status, body: await resp.json() as Record<string, unknown> };
}

/** Minimal valid PNG (1×1 pixel, ~67 bytes). */
function minimalPng(): Buffer {
  return Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000' +
    '9001' + '2e00000000c4944415478016360f8cfc00000000200015b0e81e' +
    '0000000049454e44ae426082',
    'hex',
  );
}

/** Minimal JPEG header (FF D8 FF). */
function minimalJpeg(): Buffer {
  const b = Buffer.alloc(32, 0);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}

/** Minimal PDF header. */
function minimalPdf(): Buffer { return Buffer.from('%PDF-1.4 minimal', 'utf8'); }

/** Minimal ZIP (DOCX/XLSX/PPTX magic bytes). */
function minimalZip(): Buffer {
  const b = Buffer.alloc(32, 0);
  b[0] = 0x50; b[1] = 0x4b; b[2] = 0x03; b[3] = 0x04;
  return b;
}

function minimalDrawio(): Buffer {
  return Buffer.from('<mxGraphModel><root></root></mxGraphModel>', 'utf8');
}

async function setupProject(baseUrl: string): Promise<{ cookie: string; projectId: string }> {
  const email = `att-admin-${Date.now()}@example.com`;
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email, name: 'Admin', password: 'password1234', provider: 'demo' },
  });
  const cookie = r.cookie ?? '';
  const projR = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: `Att Project ${Date.now()}` },
    cookie,
  });
  const projectId = ((projR.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
  return { cookie, projectId };
}

// ── Upload validation ──────────────────────────────────────────────────────────

describe('AI Attachments — upload validation', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId } = await setupProject(baseUrl));
  });

  after(async () => { await cleanup(); });

  it('rejects empty file', async () => {
    const r = await uploadFile(baseUrl, cookie, projectId, 'empty.png', Buffer.alloc(0), 'image/png');
    assert.equal(r.status, 400);
    assert.ok(typeof (r.body as { error: string }).error === 'string');
  });

  it('rejects unsupported extension', async () => {
    const r = await uploadFile(baseUrl, cookie, projectId, 'file.xyz', Buffer.from('data'), 'application/octet-stream');
    assert.equal(r.status, 400);
    assert.ok((r.body as { error: string }).error.toLowerCase().includes('unsupported'));
  });

  it('rejects bad PNG magic bytes', async () => {
    const r = await uploadFile(baseUrl, cookie, projectId, 'fake.png', Buffer.from('not a png'), 'image/png');
    assert.equal(r.status, 400);
    assert.ok((r.body as { error: string }).error.toLowerCase().includes('png'));
  });

  it('accepts valid PNG and returns kind=image', async () => {
    const r = await uploadFile(baseUrl, cookie, projectId, 'photo.png', minimalPng(), 'image/png');
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    const att = (r.body as { attachment: { id: string; kind: string } }).attachment;
    assert.equal(att.kind, 'image');
    assert.ok(att.id);
  });

  it('accepts valid JPEG and returns kind=image', async () => {
    const r = await uploadFile(baseUrl, cookie, projectId, 'photo.jpg', minimalJpeg(), 'image/jpeg');
    assert.equal(r.status, 201);
    assert.equal((r.body as { attachment: { kind: string } }).attachment.kind, 'image');
  });

  it('accepts valid PDF and returns kind=document', async () => {
    const r = await uploadFile(baseUrl, cookie, projectId, 'doc.pdf', minimalPdf(), 'application/pdf');
    assert.equal(r.status, 201);
    assert.equal((r.body as { attachment: { kind: string } }).attachment.kind, 'document');
  });

  it('accepts DOCX (ZIP magic bytes) and returns kind=document', async () => {
    const r = await uploadFile(baseUrl, cookie, projectId, 'doc.docx', minimalZip(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(r.status, 201);
    assert.equal((r.body as { attachment: { kind: string } }).attachment.kind, 'document');
  });

  it('accepts draw.io file and returns kind=diagram', async () => {
    const r = await uploadFile(baseUrl, cookie, projectId, 'arch.drawio', minimalDrawio(), 'application/xml');
    assert.equal(r.status, 201);
    assert.equal((r.body as { attachment: { kind: string } }).attachment.kind, 'diagram');
  });

  it('accepts .txt file and returns kind=document', async () => {
    const r = await uploadFile(baseUrl, cookie, projectId, 'notes.txt', Buffer.from('notes'), 'text/plain');
    assert.equal(r.status, 201);
    assert.equal((r.body as { attachment: { kind: string } }).attachment.kind, 'document');
  });

  it('accepts document up to 20 MB (15 MB .txt)', async () => {
    const r = await uploadFile(baseUrl, cookie, projectId, 'large-doc.txt', Buffer.alloc(15 * 1024 * 1024, 0x41), 'text/plain');
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal((r.body as { attachment: { kind: string } }).attachment.kind, 'document');
  });

  it('rejects document over 20 MB with correct limit in error message', async () => {
    const r = await uploadFile(baseUrl, cookie, projectId, 'too-big.txt', Buffer.alloc(21 * 1024 * 1024, 0x41), 'text/plain');
    assert.equal(r.status, 400);
    assert.ok(
      (r.body as { error: string }).error.includes('20 MB'),
      `expected "20 MB" in error: ${(r.body as { error: string }).error}`,
    );
  });

  it('rejects image over 10 MB with correct limit in error message', async () => {
    const largePngBuf = Buffer.alloc(11 * 1024 * 1024, 0x41);
    largePngBuf[0] = 0x89; largePngBuf[1] = 0x50; largePngBuf[2] = 0x4e; largePngBuf[3] = 0x47;
    const r = await uploadFile(baseUrl, cookie, projectId, 'big-image.png', largePngBuf, 'image/png');
    assert.equal(r.status, 400);
    assert.ok(
      (r.body as { error: string }).error.includes('10 MB'),
      `expected "10 MB" in error: ${(r.body as { error: string }).error}`,
    );
  });

  it('sanitizes path-traversal filenames', async () => {
    const r = await uploadFile(baseUrl, cookie, projectId, '../../../etc/passwd.txt', Buffer.from('x'), 'text/plain');
    assert.equal(r.status, 201);
    assert.ok(!(r.body as { attachment: { filename: string } }).attachment.filename.includes('..'));
  });
});

// ── Delete endpoint ────────────────────────────────────────────────────────────

describe('AI Attachments — delete endpoint', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId } = await setupProject(baseUrl));
  });

  after(async () => { await cleanup(); });

  it('deletes an uploaded attachment', async () => {
    const up = await uploadFile(baseUrl, cookie, projectId, 'del.txt', Buffer.from('x'), 'text/plain');
    assert.equal(up.status, 201);
    const attId = (up.body as { attachment: { id: string } }).attachment.id;

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/ai-attachments/${attId}`, { method: 'DELETE', cookie });
    assert.equal(r.status, 200);
    assert.equal((r.body as { ok: boolean }).ok, true);
  });

  it('returns 404 for unknown attachment', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/ai-attachments/does-not-exist`, { method: 'DELETE', cookie });
    assert.equal(r.status, 404);
  });

  it('returns 400 for a linked attachment', async () => {
    const up = await uploadFile(baseUrl, cookie, projectId, 'linked.txt', Buffer.from('x'), 'text/plain');
    const attId = (up.body as { attachment: { id: string } }).attachment.id;
    dbRun('UPDATE ai_attachments SET parent_kind = ?, parent_id = ? WHERE id = ?', 'doc', 'fake-doc', attId);

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/ai-attachments/${attId}`, { method: 'DELETE', cookie });
    assert.equal(r.status, 400);
    assert.ok((r.body as { error: string }).error.includes('linked'));

    dbRun('DELETE FROM ai_attachments WHERE id = ?', attId);
  });
});

// ── attachmentIds validation ───────────────────────────────────────────────────

describe('AI Attachments — attachmentIds validation in test generate', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let testProjectId: string;
  let testGroupId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId } = await setupProject(baseUrl));

    const tpR = await fetchJson(baseUrl, `/api/projects/${projectId}/tests`, {
      method: 'POST', body: { name: 'TP', appUrl: 'https://example.com' }, cookie,
    });
    testProjectId = ((tpR.body as Record<string, unknown>).testProject as Record<string, unknown>).id as string;

    const tgR = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/groups`, {
      method: 'POST', body: { name: 'G' }, cookie,
    });
    testGroupId = ((tgR.body as Record<string, unknown>).group as Record<string, unknown>).id as string;

    setModelCallFn(async () => [{ kind: 'goto', path: '/' }]);
  });

  after(async () => { setModelCallFn(null); await cleanup(); });

  it('rejects >5 attachmentIds', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/generate`, {
      method: 'POST', body: { description: 'x', groupId: testGroupId, attachmentIds: ['a','b','c','d','e','f'] }, cookie,
    });
    assert.equal(r.status, 400);
    assert.ok((r.body as { error: string }).error.includes('5'));
  });

  it('rejects unknown attachment ID', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/generate`, {
      method: 'POST', body: { description: 'x', groupId: testGroupId, attachmentIds: ['nonexistent-xyz'] }, cookie,
    });
    assert.equal(r.status, 400);
    assert.ok((r.body as { error: string }).error.toLowerCase().includes('not found'));
  });

  it('rejects cross-project attachment ID', async () => {
    const proj2R = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Other' }, cookie });
    const proj2Id = ((proj2R.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    const up = await uploadFile(baseUrl, cookie, proj2Id, 'cross.txt', Buffer.from('x'), 'text/plain');
    const attId = (up.body as { attachment: { id: string } }).attachment.id;

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/generate`, {
      method: 'POST', body: { description: 'x', groupId: testGroupId, attachmentIds: [attId] }, cookie,
    });
    assert.equal(r.status, 400);
    assert.ok((r.body as { error: string }).error.includes('does not belong'));
  });

  it('generate without attachmentIds still works (backward compat)', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/generate`, {
      method: 'POST', body: { description: 'Login flow', groupId: testGroupId }, cookie,
    });
    assert.equal(r.status, 202);
    assert.ok((r.body as { generationId: string }).generationId);
  });
});

// ── DOCX/text attachment cleanup after generation ─────────────────────────────

describe('AI Attachments — text attachment included in prompt; cleaned up after', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let testProjectId: string;
  let testGroupId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId } = await setupProject(baseUrl));

    const tpR = await fetchJson(baseUrl, `/api/projects/${projectId}/tests`, {
      method: 'POST', body: { name: 'Cleanup TP', appUrl: 'https://example.com' }, cookie,
    });
    testProjectId = ((tpR.body as Record<string, unknown>).testProject as Record<string, unknown>).id as string;

    const tgR = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/groups`, {
      method: 'POST', body: { name: 'G' }, cookie,
    });
    testGroupId = ((tgR.body as Record<string, unknown>).group as Record<string, unknown>).id as string;
  });

  after(async () => { setModelCallFn(null); await cleanup(); });

  it('attachment DB row and file are deleted after successful generation', async () => {
    const up = await uploadFile(baseUrl, cookie, projectId, 'once.txt', Buffer.from('one-shot spec'), 'text/plain');
    assert.equal(up.status, 201);
    const attId = (up.body as { attachment: { id: string } }).attachment.id;

    const attRow = one<Row>('SELECT file_path FROM ai_attachments WHERE id = ?', attId);
    assert.ok(attRow, 'DB row should exist before generation');
    const filePath = String(attRow!.file_path);
    assert.ok(fs.existsSync(filePath), 'file should exist before generation');

    setModelCallFn(async () => [{ kind: 'goto', path: '/' }]);

    const genR = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/generate`, {
      method: 'POST', body: { description: 'Single-use test', groupId: testGroupId, attachmentIds: [attId] }, cookie,
    });
    assert.equal(genR.status, 202);
    const genId = (genR.body as { generationId: string }).generationId;

    let status = 'pending';
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((r) => setTimeout(r, 100));
      const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/generate/${genId}`, { cookie });
      status = ((r.body as Record<string, unknown>).generation as Record<string, unknown>).status as string;
      if (status !== 'pending' && status !== 'running') break;
    }
    assert.equal(status, 'done');

    const rowAfter = one<Row>('SELECT * FROM ai_attachments WHERE id = ?', attId);
    assert.equal(rowAfter, undefined, 'DB row should be deleted after generation');
    assert.ok(!fs.existsSync(filePath), 'file should be deleted after generation');
  });
});

// ── Image blocks for all 3 providers ──────────────────────────────────────────

describe('AI Attachments — PNG image blocks in all 3 providers', () => {
  before(async () => { await createTestServer(); });
  after(async () => {
    setBedrockClientFactory(null);
    try { setSetting(getDb(), 'provider.mode', 'demo'); } catch { /* db closed */ }
    await cleanup();
  });
  afterEach(() => {
    setBedrockClientFactory(null);
    try { setSetting(getDb(), 'provider.mode', 'demo'); } catch { /* db closed */ }
  });

  it('Bedrock: content includes image block with format=png', async () => {
    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.region', 'us-east-1');
    setSetting(db, 'bedrock.auth', 'ambient');
    setSetting(db, 'model.sonnet', 'anthropic.claude-3-5-sonnet-20241022-v1:0');

    const captured: Array<BedrockConverseInput> = [];
    setBedrockClientFactory(() => ({
      async converse(input: BedrockConverseInput) {
        captured.push(input);
        return { output: { message: { content: [{ text: '[]' }] } } };
      },
    }));

    await callTextModel('sys', 'msg', {
      images: [{ data: minimalPng(), mimeType: 'image/png', filename: 'shot.png' }],
    });

    assert.ok(captured.length > 0, 'Bedrock should have been called');
    const content = captured[0].messages[0].content;
    assert.ok(content.length >= 2, 'should have text + image blocks');
    const imgBlock = content.find((b) => 'image' in b) as { image?: { format: string } } | undefined;
    assert.ok(imgBlock?.image, 'image block must exist');
    assert.equal(imgBlock!.image!.format, 'png');
  });

  it('Anthropic: user content array includes type=image block', async () => {
    const db = getDb();
    // Set portal to bedrock mode; user api_key credential overrides it (same pattern as testing-bedrock.test.ts)
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.region', 'us-east-1');
    setSetting(db, 'bedrock.auth', 'ambient');
    // Create a user with an Anthropic credential so resolveCredentialEnv picks it up
    const uid = generateId();
    const ts = now();
    insert('users', {
      id: uid, email: `anth-img-${Date.now()}@test.com`, name: 'Anth Img',
      password_hash: 'x', is_admin: 0, disabled: 0, created_at: ts,
    });
    const cid = generateId();
    insert('engine_credentials', {
      id: cid, user_id: uid, engine: 'claude-code', name: 'Anth Key',
      mode: 'api_key', secret_enc: encrypt('sk-ant-fake', config.secretKey),
      extra_config: '{}', is_default: 1, last4: 'fake',
      created_at: ts, updated_at: ts, updated_by: uid,
    });
    setSetting(db, 'model.sonnet', 'claude-3-5-sonnet-20241022');

    let capturedBody: Record<string, unknown> | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('anthropic.com')) {
        capturedBody = JSON.parse(init?.body as string ?? '{}') as Record<string, unknown>;
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: '[]' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return origFetch(url, init);
    };

    try {
      await callTextModel('sys', 'msg', {
        createdBy: uid,
        images: [{ data: minimalPng(), mimeType: 'image/png', filename: 'shot.png' }],
      });
    } finally {
      globalThis.fetch = origFetch;
      dbRun('DELETE FROM engine_credentials WHERE id = ?', cid);
      dbRun('DELETE FROM users WHERE id = ?', uid);
    }

    assert.ok(capturedBody, 'Anthropic API should have been called');
    const userContent = ((capturedBody as { messages?: Array<{ content: Array<{ type: string }> }> }).messages ?? [])[0]?.content;
    assert.ok(Array.isArray(userContent), 'content should be array for multimodal');
    assert.ok(userContent.some((c) => c.type === 'image'), 'should have image block');
  });

  it('LiteLLM: user content array includes type=image_url block', async () => {
    const db = getDb();
    setSetting(db, 'provider.mode', 'litellm');
    setSetting(db, 'litellm.baseUrl', 'http://fake-litellm-x.local');
    setSetting(db, 'litellm.model', 'gpt-4o');

    let capturedBody: Record<string, unknown> | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('fake-litellm-x.local')) {
        capturedBody = JSON.parse(init?.body as string ?? '{}') as Record<string, unknown>;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '[]' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return origFetch(url, init);
    };

    try {
      await callTextModel('sys', 'msg', {
        images: [{ data: minimalPng(), mimeType: 'image/png', filename: 'shot.png' }],
      });
    } finally {
      globalThis.fetch = origFetch;
    }

    assert.ok(capturedBody, 'LiteLLM should have been called');
    const msgs = (capturedBody as { messages?: Array<{ role?: string; content: unknown }> }).messages ?? [];
    const userMsg = msgs.find((m) => m.role === 'user') as { content: Array<{ type: string; image_url?: { url: string } }> } | undefined;
    assert.ok(userMsg && Array.isArray(userMsg.content), 'user message should have array content');
    const imgEntry = userMsg!.content.find((c) => c.type === 'image_url');
    assert.ok(imgEntry?.image_url?.url.startsWith('data:image/png;base64,'), 'should be png data URL');
  });
});

// ── Create-module views include attachments ────────────────────────────────────

describe('AI Attachments — create-module resource view and cascade delete', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId } = await setupProject(baseUrl));
  });

  after(async () => { await cleanup(); });

  it('generated-doc response includes attachments array with correct shape', async () => {
    const up = await uploadFile(baseUrl, cookie, projectId, 'spec.txt', Buffer.from('spec text'), 'text/plain');
    assert.equal(up.status, 201);
    const attId = (up.body as { attachment: { id: string; filename: string } }).attachment.id;
    const attFilename = (up.body as { attachment: { id: string; filename: string } }).attachment.filename;

    const docR = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, {
      method: 'POST',
      body: { name: 'Doc with Att', docType: 'overview', attachmentIds: [attId] },
      cookie,
    });
    assert.equal(docR.status, 200, `Expected 200, got ${docR.status}: ${JSON.stringify(docR.body)}`);

    const doc = (docR.body as { doc: Record<string, unknown> }).doc;
    const atts = doc.attachments as Array<{ id: string; filename: string; kind: string }>;
    assert.ok(Array.isArray(atts) && atts.length === 1, 'should have 1 attachment');
    assert.equal(atts[0].id, attId);
    assert.equal(atts[0].filename, attFilename);
    assert.equal(atts[0].kind, 'document');

    // Attachment should be linked to the doc
    const row = one<Row>('SELECT parent_kind, parent_id FROM ai_attachments WHERE id = ?', attId);
    assert.equal(row?.parent_kind, 'doc');
    assert.equal(String(row?.parent_id), String(doc.id));
  });

  it('deleting a generated-doc removes its attachments', async () => {
    const up = await uploadFile(baseUrl, cookie, projectId, 'todel.txt', Buffer.from('x'), 'text/plain');
    const attId = (up.body as { attachment: { id: string } }).attachment.id;
    const fp = String(one<Row>('SELECT file_path FROM ai_attachments WHERE id = ?', attId)!.file_path);

    const docR = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, {
      method: 'POST', body: { name: 'Delete Me', docType: 'overview', attachmentIds: [attId] }, cookie,
    });
    const docId = ((docR.body as { doc: { id: string } }).doc).id;

    await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs/${docId}`, { method: 'DELETE', cookie });

    assert.equal(one<Row>('SELECT * FROM ai_attachments WHERE id = ?', attId), undefined, 'DB row deleted');
    assert.ok(!fs.existsSync(fp), 'file deleted');
  });

  it('presentation response includes attachments array', async () => {
    const up = await uploadFile(baseUrl, cookie, projectId, 'slide-spec.txt', Buffer.from('slides spec'), 'text/plain');
    assert.equal(up.status, 201);
    const attId = (up.body as { attachment: { id: string } }).attachment.id;

    const presR = await fetchJson(baseUrl, `/api/projects/${projectId}/presentations`, {
      method: 'POST',
      body: { name: 'Pres with Att', sourceKind: 'topic', topic: 'AI', attachmentIds: [attId] },
      cookie,
    });
    assert.equal(presR.status, 200, `Expected 200, got ${presR.status}: ${JSON.stringify(presR.body)}`);

    const pres = (presR.body as { presentation: Record<string, unknown> }).presentation;
    const atts = pres.attachments as Array<{ id: string; kind: string }>;
    assert.ok(Array.isArray(atts) && atts.length === 1, 'should have 1 attachment');
    assert.equal(atts[0].id, attId);
  });
});

// ── Orphan cleanup ─────────────────────────────────────────────────────────────

describe('AI Attachments — cleanupOrphanedAttachments', () => {
  let realProjectId: string;

  before(async () => {
    await createTestServer();
    // Need a real project to satisfy the FK constraint
    const email = `cleanup-admin-${Date.now()}@example.com`;
    // Create user and project directly via DB helpers
    const uid = generateId();
    insert('users', {
      id: uid, email, name: 'Cleanup', password_hash: 'x',
      is_admin: 1, disabled: 0, created_at: now(),
    });
    const pid = generateId();
    const slug = `cleanup-proj-${Date.now()}`;
    insert('projects', {
      id: pid, slug, name: 'Cleanup Project', description: '',
      notes: '', created_by: uid, created_at: now(), archived: 0,
      default_lead_agent: '', default_model: '', vault_generated: 1,
    });
    realProjectId = pid;
  });

  after(async () => { await cleanup(); });

  it('removes orphan attachments older than 24h', async () => {
    const { cleanupOrphanedAttachments } = await import('../server/ai-attachments.ts');
    const id = generateId();
    const tmpPath = path.join(config.dataDir, `orphan-${id}.txt`);
    fs.writeFileSync(tmpPath, 'orphan');

    insert('ai_attachments', {
      id, project_id: realProjectId, filename: 'orphan.txt', original_name: 'orphan.txt',
      mime_type: 'text/plain', size: 6, kind: 'document', file_path: tmpPath,
      parent_kind: null, parent_id: null, uploaded_by: null,
      created_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
    });

    cleanupOrphanedAttachments();

    assert.equal(one<Row>('SELECT * FROM ai_attachments WHERE id = ?', id), undefined, 'should be deleted');
    assert.ok(!fs.existsSync(tmpPath), 'file should be deleted');
  });

  it('does NOT remove recent (<24h) orphan attachments', async () => {
    const { cleanupOrphanedAttachments } = await import('../server/ai-attachments.ts');
    const id = generateId();
    const tmpPath = path.join(config.dataDir, `recent-${id}.txt`);
    fs.writeFileSync(tmpPath, 'recent');

    insert('ai_attachments', {
      id, project_id: realProjectId, filename: 'recent.txt', original_name: 'recent.txt',
      mime_type: 'text/plain', size: 6, kind: 'document', file_path: tmpPath,
      parent_kind: null, parent_id: null, uploaded_by: null,
      created_at: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
    });

    cleanupOrphanedAttachments();

    assert.ok(one<Row>('SELECT * FROM ai_attachments WHERE id = ?', id), 'should NOT be deleted');

    // cleanup
    dbRun('DELETE FROM ai_attachments WHERE id = ?', id);
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ok */ }
  });
});

// ── Helpers shared by the new test sections ────────────────────────────────────

/** Build a minimal but parseable DOCX buffer containing the given text. */
async function buildMinimalDocx(text: string): Promise<Buffer> {
  // dynamic import so jszip is only required when the test runs
  const { default: JSZip } = (await import('jszip')) as { default: typeof import('jszip') };
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>',
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body>' +
    '</w:document>',
  );
  return (zip as unknown as { generateAsync(opts: { type: string }): Promise<Buffer> })
    .generateAsync({ type: 'nodebuffer' });
}

/** Poll a generation until it leaves pending/running, up to 3 s. */
async function waitForGen(baseUrl: string, cookie: string, pid: string, tpid: string, genId: string): Promise<string> {
  let status = 'pending';
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((r) => setTimeout(r, 100));
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generate/${genId}`, { cookie });
    status = ((r.body as Record<string, unknown>).generation as Record<string, unknown>).status as string;
    if (status !== 'pending' && status !== 'running') break;
  }
  return status;
}

// ── Fix 1: injected model context includes systemPrompt and images ─────────────

describe('AI Attachments — injected model context: systemPrompt and images', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let testProjectId: string;
  let testGroupId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId } = await setupProject(baseUrl));

    const tpR = await fetchJson(baseUrl, `/api/projects/${projectId}/tests`, {
      method: 'POST', body: { name: 'Context TP', appUrl: 'https://example.com' }, cookie,
    });
    testProjectId = ((tpR.body as Record<string, unknown>).testProject as Record<string, unknown>).id as string;

    const tgR = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/groups`, {
      method: 'POST', body: { name: 'G' }, cookie,
    });
    testGroupId = ((tgR.body as Record<string, unknown>).group as Record<string, unknown>).id as string;
  });

  after(async () => { setModelCallFn(null); await cleanup(); });

  it('(a) TXT attachment content and filename delimiters appear in systemPrompt', async () => {
    const uniqueContent = 'UNIQUE_TXT_CONTENT_' + Date.now();
    const up = await uploadFile(baseUrl, cookie, projectId, 'spec.txt', Buffer.from(uniqueContent), 'text/plain');
    assert.equal(up.status, 201);
    const attId = (up.body as { attachment: { id: string } }).attachment.id;

    let capturedContext: ModelCallContext | null = null;
    setModelCallFn(async (_prompt, ctx) => {
      capturedContext = ctx;
      return [{ kind: 'goto', path: '/' }];
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/generate`, {
      method: 'POST', body: { description: 'test', groupId: testGroupId, attachmentIds: [attId] }, cookie,
    });
    assert.equal(r.status, 202);
    const genId = (r.body as { generationId: string }).generationId;
    await waitForGen(baseUrl, cookie, projectId, testProjectId, genId);

    assert.ok(capturedContext, 'model fn should have been called');
    const ctx1 = capturedContext as unknown as ModelCallContext;
    assert.ok(typeof ctx1.systemPrompt === 'string', 'systemPrompt should be set');
    assert.ok(ctx1.systemPrompt!.includes('--- FILE: spec.txt ---'), 'should include FILE delimiter');
    assert.ok(ctx1.systemPrompt!.includes(uniqueContent), 'should include file content');
    assert.ok(ctx1.systemPrompt!.includes('--- END FILE: spec.txt ---'), 'should include END delimiter');
  });

  it('(b) DOCX text is extracted into systemPrompt', async () => {
    const docxBuf = await buildMinimalDocx('HelloDocxWorldUnique');
    const up = await uploadFile(
      baseUrl, cookie, projectId, 'requirements.docx', docxBuf,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    assert.equal(up.status, 201, `docx upload failed: ${JSON.stringify(up.body)}`);
    const attId = (up.body as { attachment: { id: string } }).attachment.id;

    let capturedSystemPrompt: string | undefined;
    setModelCallFn(async (_p, ctx) => {
      capturedSystemPrompt = ctx.systemPrompt;
      return [{ kind: 'goto', path: '/' }];
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/generate`, {
      method: 'POST', body: { description: 'test docx', groupId: testGroupId, attachmentIds: [attId] }, cookie,
    });
    assert.equal(r.status, 202);
    await waitForGen(baseUrl, cookie, projectId, testProjectId, (r.body as { generationId: string }).generationId);

    assert.ok(capturedSystemPrompt, 'systemPrompt should be set');
    assert.ok(capturedSystemPrompt!.includes('HelloDocxWorldUnique'), 'DOCX text extracted into systemPrompt');
    assert.ok(capturedSystemPrompt!.includes('--- FILE: requirements.docx ---'), 'filename block present');
  });

  it('(c) PNG attachment appears in images list with correct metadata', async () => {
    const pngBuf = minimalPng();
    const up = await uploadFile(baseUrl, cookie, projectId, 'screenshot.png', pngBuf, 'image/png');
    assert.equal(up.status, 201);
    const attId = (up.body as { attachment: { id: string } }).attachment.id;

    let capturedImages: ModelCallContext['images'] = [];
    setModelCallFn(async (_p, ctx) => {
      capturedImages = ctx.images;
      return [{ kind: 'goto', path: '/' }];
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/generate`, {
      method: 'POST', body: { description: 'test png', groupId: testGroupId, attachmentIds: [attId] }, cookie,
    });
    assert.equal(r.status, 202);
    await waitForGen(baseUrl, cookie, projectId, testProjectId, (r.body as { generationId: string }).generationId);

    assert.ok(Array.isArray(capturedImages) && capturedImages!.length === 1, 'should have one image entry');
    const img = capturedImages![0];
    assert.equal(img.filename, 'screenshot.png', 'correct filename');
    assert.equal(img.mimeType, 'image/png', 'correct mimeType');
    assert.equal(img.size, pngBuf.length, 'correct size');
  });

  it('(d) text over the budget is truncated with the truncation note', async () => {
    // 50001 chars triggers truncation (budget = 50000)
    const longContent = 'X'.repeat(51_000);
    const up = await uploadFile(baseUrl, cookie, projectId, 'long.txt', Buffer.from(longContent), 'text/plain');
    assert.equal(up.status, 201);
    const attId = (up.body as { attachment: { id: string } }).attachment.id;

    let capturedPrompt: string | undefined;
    setModelCallFn(async (_p, ctx) => {
      capturedPrompt = ctx.systemPrompt;
      return [{ kind: 'goto', path: '/' }];
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/generate`, {
      method: 'POST', body: { description: 'test truncate', groupId: testGroupId, attachmentIds: [attId] }, cookie,
    });
    assert.equal(r.status, 202);
    await waitForGen(baseUrl, cookie, projectId, testProjectId, (r.body as { generationId: string }).generationId);

    assert.ok(capturedPrompt, 'systemPrompt should be set');
    assert.ok(
      capturedPrompt!.includes('[... content truncated due to size limit ...]'),
      'truncation note must appear',
    );
    // The full content must NOT appear (it was truncated)
    assert.ok(!capturedPrompt!.includes(longContent), 'original oversized content must not appear verbatim');
  });

  it('(e) refine with attachments passes systemPrompt and existingSteps', async () => {
    // Create a script to refine
    const genR = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/generate`, {
      method: 'POST', body: { description: 'initial', groupId: testGroupId }, cookie,
    });
    const genId0 = (genR.body as { generationId: string }).generationId;

    // Wait for first gen to complete
    let prevFn: Parameters<typeof setModelCallFn>[0];
    setModelCallFn(async () => [{ kind: 'goto', path: '/' }]);
    await waitForGen(baseUrl, cookie, projectId, testProjectId, genId0);

    // Get the created script id
    const genStatus = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/generate/${genId0}`, { cookie });
    const scripts = (genStatus.body as { scripts: Array<{ id: string }> }).scripts;
    assert.ok(scripts.length > 0, 'script must have been created');
    const scriptId = scripts[0].id;

    // Upload a TXT for refine
    const refineContent = 'REFINE_SPEC_' + Date.now();
    const up = await uploadFile(baseUrl, cookie, projectId, 'refine.txt', Buffer.from(refineContent), 'text/plain');
    const attId = (up.body as { attachment: { id: string } }).attachment.id;

    let capturedRefineCtx: ModelCallContext | null = null;
    setModelCallFn(async (_p, ctx) => {
      capturedRefineCtx = ctx;
      return [{ kind: 'goto', path: '/' }];
    });

    const refR = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/scripts/${scriptId}/refine`, {
      method: 'POST', body: { instruction: 'make it better', attachmentIds: [attId] }, cookie,
    });
    assert.equal(refR.status, 202);
    await waitForGen(baseUrl, cookie, projectId, testProjectId, (refR.body as { generationId: string }).generationId);

    assert.ok(capturedRefineCtx, 'model fn called for refine');
    const ctxE = capturedRefineCtx as unknown as ModelCallContext;
    assert.ok(typeof ctxE.systemPrompt === 'string', 'systemPrompt set on refine');
    assert.ok(ctxE.systemPrompt!.includes(refineContent), 'attachment content in refine systemPrompt');
    assert.ok(Array.isArray(ctxE.existingSteps), 'existingSteps present on refine');
  });
});

// ── Fix 2: filename collision in stageAttachmentsToWorkDir ────────────────────

describe('AI Attachments — filename collision in stageAttachmentsToWorkDir', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId } = await setupProject(baseUrl));
  });

  after(async () => { await cleanup(); });

  it('two attachments with the same filename both get unique staged names in goal and work dir', async () => {
    // Upload two separate TXT files with the same display name
    const up1 = await uploadFile(baseUrl, cookie, projectId, 'spec.txt', Buffer.from('content-one'), 'text/plain');
    assert.equal(up1.status, 201);
    const att1Id = (up1.body as { attachment: { id: string } }).attachment.id;

    const up2 = await uploadFile(baseUrl, cookie, projectId, 'spec.txt', Buffer.from('content-two'), 'text/plain');
    assert.equal(up2.status, 201);
    const att2Id = (up2.body as { attachment: { id: string } }).attachment.id;

    // Both should have filename 'spec.txt' in the DB
    const row1 = one<Row>('SELECT filename FROM ai_attachments WHERE id = ?', att1Id);
    const row2 = one<Row>('SELECT filename FROM ai_attachments WHERE id = ?', att2Id);
    assert.equal(String(row1?.filename), 'spec.txt');
    assert.equal(String(row2?.filename), 'spec.txt');

    // Create a generated-doc with both attachments — this exercises stageAttachmentsToWorkDir
    const docR = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, {
      method: 'POST',
      body: { name: 'Collision Doc', docType: 'overview', attachmentIds: [att1Id, att2Id] },
      cookie,
    });
    assert.equal(docR.status, 200, JSON.stringify(docR.body));
    const wfId = (docR.body as { workflowId: string }).workflowId;

    const wf = one<Row>('SELECT goal, work_dir FROM p6_workflows WHERE id = ?', wfId);
    assert.ok(wf, 'workflow should exist');
    const goal = String(wf!.goal);
    const workDir = String(wf!.work_dir);

    // Both names must appear in the goal (one original, one deduplicated)
    assert.ok(goal.includes('spec.txt'), 'original name in goal');
    assert.ok(goal.includes('spec-2.txt'), 'deduplicated name must appear in goal');

    // Both files must exist on disk with their staged names
    assert.ok(fs.existsSync(path.join(workDir, 'attachments', 'spec.txt')), 'first file staged');
    assert.ok(fs.existsSync(path.join(workDir, 'attachments', 'spec-2.txt')), 'second file staged with unique name');
  });
});

// ── Fix 3: LiteLLM image size limit ──────────────────────────────────────────

describe('AI Attachments — LiteLLM image size limit', () => {
  before(async () => { await createTestServer(); });

  after(async () => {
    try { setSetting(getDb(), 'provider.mode', 'demo'); } catch { /* db closed */ }
    await cleanup();
  });

  it('throws a clear error for an image exceeding the 20 MB limit', async () => {
    const db = getDb();
    setSetting(db, 'provider.mode', 'litellm');
    setSetting(db, 'litellm.baseUrl', 'http://fake-litellm-size-test.local');
    setSetting(db, 'litellm.model', 'gpt-4o');

    try {
      await assert.rejects(
        callTextModel('sys', 'user', {
          images: [{ data: Buffer.alloc(21 * 1024 * 1024, 0x42), mimeType: 'image/png', filename: 'toobig.png' }],
        }),
        (err: Error) => {
          assert.ok(err.message.includes('toobig.png'), 'filename in error message');
          assert.ok(err.message.includes('LiteLLM'), 'provider name in error message');
          assert.ok(err.message.includes('20 MB'), 'limit in error message');
          return true;
        },
      );
    } finally {
      try { setSetting(getDb(), 'provider.mode', 'demo'); } catch { /* ignore */ }
    }
  });
});

// ── Fix 4: Create-module refresh — generated-docs ─────────────────────────────

describe('AI Attachments — generated-doc refresh: no attachmentIds reuses existing', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId } = await setupProject(baseUrl));
  });

  after(async () => { await cleanup(); });

  it('existing attachment is staged in new work dir and listed in the new workflow goal', async () => {
    const up = await uploadFile(baseUrl, cookie, projectId, 'reuse-doc.txt', Buffer.from('reuse-content'), 'text/plain');
    assert.equal(up.status, 201);
    const attId = (up.body as { attachment: { id: string; filename: string } }).attachment.id;
    const attFilename = (up.body as { attachment: { id: string; filename: string } }).attachment.filename;

    // Create doc with attachment
    const docR = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, {
      method: 'POST',
      body: { name: 'Reuse Doc', docType: 'overview', attachmentIds: [attId] },
      cookie,
    });
    assert.equal(docR.status, 200, JSON.stringify(docR.body));
    const docId = ((docR.body as { doc: { id: string } }).doc).id;

    // Refresh with NO attachmentIds (omit the key entirely)
    const refreshR = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs/${docId}/refresh`, {
      method: 'POST',
      body: {},
      cookie,
    });
    assert.equal(refreshR.status, 200, JSON.stringify(refreshR.body));
    const refreshWorkflowId = (refreshR.body as { workflowId: string }).workflowId;

    // The new workflow should have the attachment listed in its goal and file staged in work_dir
    const wf = one<Row>('SELECT goal, work_dir FROM p6_workflows WHERE id = ?', refreshWorkflowId);
    assert.ok(wf, 'workflow row should exist');
    assert.ok(String(wf!.goal).includes(attFilename), 'goal lists attachment filename');
    assert.ok(String(wf!.goal).includes('Attached Reference Files'), 'goal has attachment block header');

    const workDir = String(wf!.work_dir);
    const stagedPath = path.join(workDir, 'attachments', attFilename);
    assert.ok(fs.existsSync(stagedPath), `attachment must be staged at ${stagedPath}`);

    // Attachment DB row should still exist (not deleted)
    assert.ok(one<Row>('SELECT id FROM ai_attachments WHERE id = ?', attId), 'attachment row must survive refresh');
  });
});

describe('AI Attachments — generated-doc refresh: new attachmentIds replaces old', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId } = await setupProject(baseUrl));
  });

  after(async () => { await cleanup(); });

  it('old attachment row and file are deleted; new attachment is linked', async () => {
    // Create with att1
    const up1 = await uploadFile(baseUrl, cookie, projectId, 'old-att.txt', Buffer.from('old-content'), 'text/plain');
    assert.equal(up1.status, 201);
    const att1Id = (up1.body as { attachment: { id: string } }).attachment.id;
    const att1FilePath = String(one<Row>('SELECT file_path FROM ai_attachments WHERE id = ?', att1Id)!.file_path);

    const docR = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, {
      method: 'POST', body: { name: 'Replace Doc', docType: 'overview', attachmentIds: [att1Id] }, cookie,
    });
    assert.equal(docR.status, 200);
    const docId = ((docR.body as { doc: { id: string } }).doc).id;

    // Upload att2 (the replacement)
    const up2 = await uploadFile(baseUrl, cookie, projectId, 'new-att.txt', Buffer.from('new-content'), 'text/plain');
    assert.equal(up2.status, 201);
    const att2Id = (up2.body as { attachment: { id: string } }).attachment.id;
    const att2Filename = (up2.body as { attachment: { id: string; filename: string } }).attachment.filename;

    // Refresh with new attachmentIds
    const refreshR = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs/${docId}/refresh`, {
      method: 'POST', body: { attachmentIds: [att2Id] }, cookie,
    });
    assert.equal(refreshR.status, 200, JSON.stringify(refreshR.body));

    // Old attachment should be gone
    assert.equal(one<Row>('SELECT id FROM ai_attachments WHERE id = ?', att1Id), undefined, 'old att row deleted');
    assert.ok(!fs.existsSync(att1FilePath), 'old att file deleted');

    // New attachment should be linked to doc
    const att2Row = one<Row>('SELECT parent_kind, parent_id FROM ai_attachments WHERE id = ?', att2Id);
    assert.ok(att2Row, 'new att row exists');
    assert.equal(String(att2Row!.parent_kind), 'doc', 'new att linked as doc');
    assert.equal(String(att2Row!.parent_id), docId, 'new att linked to correct doc');

    // New workflow goal should list new attachment
    const refreshWorkflowId = (refreshR.body as { workflowId: string }).workflowId;
    const wf = one<Row>('SELECT goal FROM p6_workflows WHERE id = ?', refreshWorkflowId);
    assert.ok(String(wf!.goal).includes(att2Filename), 'new attachment filename in goal');
  });
});

// ── Fix 4: Create-module refresh — presentations ──────────────────────────────

describe('AI Attachments — presentation refresh: no attachmentIds reuses existing', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId } = await setupProject(baseUrl));
  });

  after(async () => { await cleanup(); });

  it('existing attachment is staged in new work dir and listed in new workflow goal', async () => {
    const up = await uploadFile(baseUrl, cookie, projectId, 'pres-reuse.txt', Buffer.from('pres-reuse-data'), 'text/plain');
    assert.equal(up.status, 201);
    const attId = (up.body as { attachment: { id: string; filename: string } }).attachment.id;
    const attFilename = (up.body as { attachment: { id: string; filename: string } }).attachment.filename;

    const presR = await fetchJson(baseUrl, `/api/projects/${projectId}/presentations`, {
      method: 'POST',
      body: { name: 'Reuse Pres', sourceKind: 'topic', topic: 'AI Testing', attachmentIds: [attId] },
      cookie,
    });
    assert.equal(presR.status, 200, JSON.stringify(presR.body));
    const presId = ((presR.body as { presentation: { id: string } }).presentation).id;

    const refreshR = await fetchJson(baseUrl, `/api/projects/${projectId}/presentations/${presId}/refresh`, {
      method: 'POST', body: {}, cookie,
    });
    assert.equal(refreshR.status, 200, JSON.stringify(refreshR.body));
    const wfId = (refreshR.body as { workflowId: string }).workflowId;

    const wf = one<Row>('SELECT goal, work_dir FROM p6_workflows WHERE id = ?', wfId);
    assert.ok(wf, 'workflow should exist');
    assert.ok(String(wf!.goal).includes(attFilename), 'goal lists attachment filename');
    assert.ok(fs.existsSync(path.join(String(wf!.work_dir), 'attachments', attFilename)), 'file staged');
    assert.ok(one<Row>('SELECT id FROM ai_attachments WHERE id = ?', attId), 'row must survive refresh');
  });
});

describe('AI Attachments — presentation refresh: new attachmentIds replaces old', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId } = await setupProject(baseUrl));
  });

  after(async () => { await cleanup(); });

  it('old attachment row and file are deleted; new attachment is linked', async () => {
    const up1 = await uploadFile(baseUrl, cookie, projectId, 'pres-old.txt', Buffer.from('old'), 'text/plain');
    const att1Id = (up1.body as { attachment: { id: string } }).attachment.id;
    const att1File = String(one<Row>('SELECT file_path FROM ai_attachments WHERE id = ?', att1Id)!.file_path);

    const presR = await fetchJson(baseUrl, `/api/projects/${projectId}/presentations`, {
      method: 'POST',
      body: { name: 'Replace Pres', sourceKind: 'topic', topic: 'AI', attachmentIds: [att1Id] },
      cookie,
    });
    assert.equal(presR.status, 200);
    const presId = ((presR.body as { presentation: { id: string } }).presentation).id;

    const up2 = await uploadFile(baseUrl, cookie, projectId, 'pres-new.txt', Buffer.from('new'), 'text/plain');
    const att2Id = (up2.body as { attachment: { id: string; filename: string } }).attachment.id;
    const att2Filename = (up2.body as { attachment: { id: string; filename: string } }).attachment.filename;

    const refreshR = await fetchJson(baseUrl, `/api/projects/${projectId}/presentations/${presId}/refresh`, {
      method: 'POST', body: { attachmentIds: [att2Id] }, cookie,
    });
    assert.equal(refreshR.status, 200, JSON.stringify(refreshR.body));

    assert.equal(one<Row>('SELECT id FROM ai_attachments WHERE id = ?', att1Id), undefined, 'old att deleted');
    assert.ok(!fs.existsSync(att1File), 'old file deleted');

    const att2Row = one<Row>('SELECT parent_kind, parent_id FROM ai_attachments WHERE id = ?', att2Id);
    assert.equal(String(att2Row!.parent_kind), 'presentation');
    assert.equal(String(att2Row!.parent_id), presId);

    const wf = one<Row>('SELECT goal FROM p6_workflows WHERE id = ?', (refreshR.body as { workflowId: string }).workflowId);
    assert.ok(String(wf!.goal).includes(att2Filename), 'new att in goal');
  });
});

// ── Fix 4: Create-module refresh — diagrams ───────────────────────────────────

async function setupProjectWithRepo(baseUrl: string): Promise<{ cookie: string; projectId: string; repoId: string }> {
  const { cookie, projectId } = await setupProject(baseUrl);
  const repoR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
    method: 'POST',
    body: { name: 'test-repo', url: 'https://github.com/example/repo', provider: 'github' },
    cookie,
  });
  const repoId = ((repoR.body as Record<string, unknown>).repo as Record<string, unknown>).id as string;
  return { cookie, projectId, repoId };
}

describe('AI Attachments — diagram refresh: no attachmentIds reuses existing', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let repoId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId, repoId } = await setupProjectWithRepo(baseUrl));
  });

  after(async () => { await cleanup(); });

  it('existing attachment is staged in new work dir and listed in new workflow goal', async () => {
    const up = await uploadFile(baseUrl, cookie, projectId, 'diag-reuse.txt', Buffer.from('diag-reuse-data'), 'text/plain');
    assert.equal(up.status, 201);
    const attId = (up.body as { attachment: { id: string; filename: string } }).attachment.id;
    const attFilename = (up.body as { attachment: { id: string; filename: string } }).attachment.filename;

    const diagR = await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams`, {
      method: 'POST',
      body: { kind: 'system_context', repoIds: [repoId], style: 'mermaid', attachmentIds: [attId] },
      cookie,
    });
    assert.equal(diagR.status, 200, JSON.stringify(diagR.body));
    const diagId = ((diagR.body as { diagram: { id: string } }).diagram).id;

    // Refresh with no attachmentIds
    const refreshR = await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams/${diagId}/refresh`, {
      method: 'POST', body: {}, cookie,
    });
    assert.equal(refreshR.status, 200, JSON.stringify(refreshR.body));
    const wfId = (refreshR.body as { workflowId: string }).workflowId;

    const wf = one<Row>('SELECT goal, work_dir FROM p6_workflows WHERE id = ?', wfId);
    assert.ok(wf, 'workflow should exist');
    assert.ok(String(wf!.goal).includes(attFilename), 'goal lists attachment filename');
    assert.ok(fs.existsSync(path.join(String(wf!.work_dir), 'attachments', attFilename)), 'file staged');
    assert.ok(one<Row>('SELECT id FROM ai_attachments WHERE id = ?', attId), 'row survives refresh');
  });
});

describe('AI Attachments — diagram refresh: new attachmentIds replaces old', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let repoId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie, projectId, repoId } = await setupProjectWithRepo(baseUrl));
  });

  after(async () => { await cleanup(); });

  it('old attachment row and file are deleted; new attachment is linked', async () => {
    const up1 = await uploadFile(baseUrl, cookie, projectId, 'diag-old.txt', Buffer.from('old'), 'text/plain');
    const att1Id = (up1.body as { attachment: { id: string } }).attachment.id;
    const att1File = String(one<Row>('SELECT file_path FROM ai_attachments WHERE id = ?', att1Id)!.file_path);

    const diagR = await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams`, {
      method: 'POST',
      body: { kind: 'system_context', repoIds: [repoId], style: 'mermaid', attachmentIds: [att1Id] },
      cookie,
    });
    assert.equal(diagR.status, 200);
    const diagId = ((diagR.body as { diagram: { id: string } }).diagram).id;

    const up2 = await uploadFile(baseUrl, cookie, projectId, 'diag-new.txt', Buffer.from('new'), 'text/plain');
    const att2Id = (up2.body as { attachment: { id: string; filename: string } }).attachment.id;
    const att2Filename = (up2.body as { attachment: { id: string; filename: string } }).attachment.filename;

    const refreshR = await fetchJson(baseUrl, `/api/projects/${projectId}/diagrams/${diagId}/refresh`, {
      method: 'POST', body: { attachmentIds: [att2Id] }, cookie,
    });
    assert.equal(refreshR.status, 200, JSON.stringify(refreshR.body));

    assert.equal(one<Row>('SELECT id FROM ai_attachments WHERE id = ?', att1Id), undefined, 'old att deleted');
    assert.ok(!fs.existsSync(att1File), 'old file deleted');

    const att2Row = one<Row>('SELECT parent_kind, parent_id FROM ai_attachments WHERE id = ?', att2Id);
    assert.equal(String(att2Row!.parent_kind), 'diagram');
    assert.equal(String(att2Row!.parent_id), diagId);

    const wf = one<Row>('SELECT goal FROM p6_workflows WHERE id = ?', (refreshR.body as { workflowId: string }).workflowId);
    assert.ok(String(wf!.goal).includes(att2Filename), 'new att in goal');
  });
});
