/**
 * Attachments up to 50 MB: the browser uploads straight to S3 (presign, then complete), and a large file reaches the runner as a
 * download link. The portal's storage is an in-memory stand-in for S3 here.
 */
import { before, after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one } from '../server/db.ts';
import { config } from '../server/config.ts';
import { getStorage, setStorage } from '../server/storage-instance.ts';
import type { StorageBackend } from '../server/storage/index.ts';
import { sealUpload, stagingKey, MAX_CHAT_UPLOAD_BYTES } from '../server/direct-upload.ts';
import { getAiAttachmentRepository } from '../server/repositories/ai-attachments.ts';
import { collectInputFilesWithUrls, attachmentLimits, RUNNER_LINK_SECONDS } from '../server/agent/input-file-urls.ts';
import { stageChatAttachments } from '../server/session-attachments.ts';
import { generateId, now } from '../server/util.ts';
import { S3StorageBackend } from '../server/storage/s3.ts';

const MB = 1024 * 1024;
const pdf = (size: number): Buffer => { const b = Buffer.alloc(size, 0x20); b.write('%PDF-1.7\n'); return b; };

/** An in-memory S3: objects, and the four abilities the portal needs for direct uploads and links. */
class MemoryS3 implements StorageBackend {
  objects = new Map<string, Buffer>();
  presigned: Array<{ path: string; method: string; seconds: number; contentLength?: number }> = [];
  async write(p: string, data: Buffer): Promise<string> { this.objects.set(p, Buffer.from(data)); return p; }
  async read(p: string): Promise<Buffer> { const b = this.objects.get(p); if (!b) throw new Error('no such object ' + p); return b; }
  async delete(p: string): Promise<void> { this.objects.delete(p); }
  async exists(p: string): Promise<boolean> { return this.objects.has(p); }
  async list(prefix: string): Promise<string[]> { return [...this.objects.keys()].filter((k) => k.startsWith(prefix)); }
  async publicUrl(p: string): Promise<string> { return 'https://example.s3.amazonaws.com/' + p; }
  async ping(): Promise<void> { /* ok */ }
  async presign(p: string, method: 'get' | 'put', seconds: number, opts: { contentLength?: number } = {}): Promise<string> {
    this.presigned.push({ path: p, method, seconds, contentLength: opts.contentLength });
    return `https://cy-ai-bucket.s3.ap-southeast-1.amazonaws.com/data/${p}?X-Amz-Expires=${seconds}&method=${method}`;
  }
  async head(p: string): Promise<{ size: number } | null> { const b = this.objects.get(p); return b ? { size: b.length } : null; }
  async readRange(p: string, start: number, end: number): Promise<Buffer> { return (await this.read(p)).subarray(start, end + 1); }
  copied: Array<{ from: string; to: string; contentType?: string }> = [];
  async copy(from: string, to: string, opts: { contentType?: string } = {}): Promise<void> { this.copied.push({ from, to, contentType: opts.contentType }); this.objects.set(to, Buffer.from(await this.read(from))); }
}

let baseUrl = '', cookie = '', projectId = '', workflowId = '', slug = '', userId = '';
let original: StorageBackend;
let mem: MemoryS3;
const savedEnv = process.env.STORAGE_BACKEND;

before(async () => {
  ({ baseUrl } = await createTestServer());
  const setup = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: 'direct@test.com', password: 'password1234', name: 'Admin', provider: 'demo' } });
  cookie = setup.cookie!;
  const project = await fetchJson(baseUrl, '/api/projects', { method: 'POST', cookie, body: { name: 'Direct uploads' } });
  const p = (project.body as { project: { id: string; slug: string } }).project;
  projectId = p.id;
  slug = p.slug;
  const wf = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', cookie, body: { goal: 'Read attachments', engine: 'demo' } });
  workflowId = (wf.body as { workflow: { id: string } }).workflow.id;
  userId = one<{ id: string }>("SELECT id FROM users WHERE email = 'direct@test.com'")!.id;
  original = getStorage();
});
after(() => { setStorage(original); if (savedEnv === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = savedEnv; cleanup(); });
afterEach(() => { setStorage(original); if (savedEnv === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = savedEnv; });

/** Switch the portal to S3-like storage, as on the cloud portal. */
function cloud(): MemoryS3 {
  mem = new MemoryS3();
  setStorage(mem);
  process.env.STORAGE_BACKEND = 's3';
  return mem;
}
// `c` is the cookie to send; null sends none (signed out).
const presign = (body: object, c: string | null = cookie) => fetchJson(baseUrl, `/api/projects/${projectId}/ai-attachments/presign`, { method: 'POST', cookie: c ?? undefined, body });
const complete = (token: unknown, c: string | null = cookie) => fetchJson(baseUrl, `/api/projects/${projectId}/ai-attachments/complete`, { method: 'POST', cookie: c ?? undefined, body: { token } });
type Presigned = { url: string; token: string; expiresIn: number };

/** The upload the browser does: presign, put the bytes where the link points, return the token. */
async function uploadTo(s3: MemoryS3, name: string, bytes: Buffer, purpose = 'chat'): Promise<string> {
  const r = await presign({ filename: name, size: bytes.length, purpose });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { token } = r.body as Presigned;
  const staged = s3.presigned[s3.presigned.length - 1].path;
  s3.objects.set(staged, bytes);
  return token;
}

describe('presign', () => {
  it('answers with a link that is signed for exactly the size chosen, and a token', async () => {
    const s3 = cloud();
    const r = await presign({ filename: 'Spec v2.pdf', size: 30 * MB, purpose: 'chat' });
    assert.equal(r.status, 200);
    const b = r.body as Presigned;
    assert.match(b.url, /^https:\/\/cy-ai-bucket\.s3\.ap-southeast-1\.amazonaws\.com\//);
    assert.equal(b.expiresIn, 15 * 60);
    assert.ok(b.token.length > 20);
    const signed = s3.presigned[0];
    assert.equal(signed.method, 'put');
    assert.equal(signed.contentLength, 30 * MB, 'the length is signed into the link');
    assert.equal(signed.seconds, 15 * 60);
    assert.match(signed.path, new RegExp(`^upload-staging/${projectId}/[^/]+/Spec_v2\\.pdf$`), 'a server-made place and a cleaned name');
  });

  it('cleans a name that tries to leave its folder', async () => {
    const s3 = cloud();
    assert.equal((await presign({ filename: '../../etc/passwd.pdf', size: 100 })).status, 200);
    assert.match(s3.presigned[0].path, new RegExp(`^upload-staging/${projectId}/[^/]+/passwd\\.pdf$`));
  });

  it('keeps the usual limits for anything that is not a chat message, and 50 MB for a chat message', async () => {
    cloud();
    assert.equal((await presign({ filename: 'a.pdf', size: 21 * MB, purpose: 'default' })).status, 400);
    assert.equal((await presign({ filename: 'a.pdf', size: 20 * MB, purpose: 'default' })).status, 200);
    assert.equal((await presign({ filename: 'a.png', size: 11 * MB })).status, 400, 'default purpose when none is given');
    assert.equal((await presign({ filename: 'a.pdf', size: MAX_CHAT_UPLOAD_BYTES, purpose: 'chat' })).status, 200);
    const over = await presign({ filename: 'a.pdf', size: MAX_CHAT_UPLOAD_BYTES + 1, purpose: 'chat' });
    assert.equal(over.status, 400);
    assert.match(String((over.body as { error: string }).error), /50 MB limit/);
  });

  it('refuses a bad name, type or size before signing anything', async () => {
    const s3 = cloud();
    for (const body of [
      { size: 10 }, { filename: '  ', size: 10 }, { filename: 'a.pdf' }, { filename: 'a.pdf', size: 0 }, { filename: 'a.pdf', size: -1 },
      { filename: 'a.pdf', size: 1.5 }, { filename: 'a.pdf', size: '10' }, { filename: 'run.exe', size: 10 }, { filename: 'noext', size: 10 },
    ]) assert.equal((await presign(body)).status, 400, JSON.stringify(body));
    assert.equal(s3.presigned.length, 0);
  });

  it('says 409 where files cannot go straight to storage, so the browser sends the file through the portal', async () => {
    // local storage: no S3 abilities
    const r = await presign({ filename: 'a.pdf', size: 10 });
    assert.equal(r.status, 409);
    assert.equal((r.body as { direct: boolean }).direct, false);
    // S3 environment but a backend that cannot sign
    process.env.STORAGE_BACKEND = 's3';
    setStorage({ ...new MemoryS3(), presign: undefined } as unknown as StorageBackend);
    assert.equal((await presign({ filename: 'a.pdf', size: 10 })).status, 409);
  });

  it('needs a signed-in editor', async () => {
    cloud();
    assert.equal((await presign({ filename: 'a.pdf', size: 10 }, null)).status, 401);
    assert.equal((await complete('x', null)).status, 401);
  });
});

describe('complete', () => {
  it('checks what arrived, moves it to its permanent place inside storage, and records the attachment', async () => {
    const s3 = cloud();
    const token = await uploadTo(s3, 'plan.pdf', pdf(5 * MB));
    const staged = s3.presigned[0].path;
    assert.ok(s3.objects.has(staged));

    const r = await complete(token);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const a = (r.body as { attachment: { id: string; filename: string; mimeType: string; size: number; kind: string } }).attachment;
    assert.deepEqual([a.filename, a.mimeType, a.size, a.kind], ['plan.pdf', 'application/pdf', 5 * MB, 'document']);

    const row = (await getAiAttachmentRepository().getById(a.id))!;
    assert.equal(row.project_id, projectId);
    assert.equal(row.uploaded_by, userId);
    assert.equal(row.original_name, 'plan.pdf');
    const durable = `projects/${slug}/ai-attachments/${a.id}-plan.pdf`;
    assert.equal(path.relative(config.dataDir, row.file_path).split(path.sep).join('/'), durable, 'the file path maps to the durable key');
    assert.equal(s3.objects.get(durable)?.length, 5 * MB, 'the file is in its permanent place');
    assert.equal(s3.copied[0].contentType, 'application/pdf', 'stored with the type its name stands for');
    assert.equal(s3.objects.has(staged), false, 'the staging object is gone');
  });

  it('is safe to call again: the same attachment comes back', async () => {
    const s3 = cloud();
    const token = await uploadTo(s3, 'again.pdf', pdf(1000));
    const first = await complete(token);
    const second = await complete(token);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.deepEqual((second.body as { attachment: unknown }).attachment, (first.body as { attachment: unknown }).attachment);
  });

  it('refuses a file that never arrived', async () => {
    cloud();
    const r = await presign({ filename: 'lost.pdf', size: 1000 });
    const out = await complete((r.body as Presigned).token);
    assert.equal(out.status, 400);
    assert.match(String((out.body as { error: string }).error), /did not arrive/);
  });

  it('refuses a file of another size than was chosen, and removes it', async () => {
    const s3 = cloud();
    const r = await presign({ filename: 'size.pdf', size: 1000 });
    s3.objects.set(s3.presigned[0].path, pdf(1001));
    const out = await complete((r.body as Presigned).token);
    assert.equal(out.status, 400);
    assert.match(String((out.body as { error: string }).error), /not the size that was chosen/);
    assert.equal(s3.objects.has(s3.presigned[0].path), false);
  });

  it('refuses a file that is not what its name says, and removes it', async () => {
    const s3 = cloud();
    const r = await presign({ filename: 'fake.pdf', size: 600 });
    s3.objects.set(s3.presigned[0].path, Buffer.alloc(600, 0x41)); // not %PDF
    const out = await complete((r.body as Presigned).token);
    assert.equal(out.status, 400);
    assert.match(String((out.body as { error: string }).error), /valid PDF/);
    assert.equal(s3.objects.has(s3.presigned[0].path), false);
    assert.equal(await getAiAttachmentRepository().getById('none'), null);
  });

  it('refuses a token that has expired, is for someone else or another project, or is not ours', async () => {
    const s3 = cloud();
    const base = { v: 1 as const, user: userId, project: projectId, id: generateId(), name: 'x.pdf', safe: 'x.pdf', size: 100, purpose: 'chat' as const, exp: Date.now() + 60_000 };
    s3.objects.set(stagingKey(projectId, base.id, 'x.pdf'), pdf(100));
    const bad: Record<string, unknown> = {
      expired: sealUpload({ ...base, exp: Date.now() - 1 }),
      'another person': sealUpload({ ...base, user: 'someone-else' }),
      'another project': sealUpload({ ...base, project: 'some-other-project' }),
      'not ours': 'AAAA' + sealUpload(base),
      missing: undefined,
      'not a string': { token: 1 },
    };
    for (const [why, token] of Object.entries(bad)) {
      const out = await complete(token);
      assert.equal(out.status, 400, why);
      assert.match(String((out.body as { error: string }).error), /expired/, why);
    }
    assert.equal((await complete(sealUpload(base))).status, 201, 'the same token is fine when it is right');
  });

  it('says 409 where direct uploads are not available', async () => {
    const out = await complete('whatever');
    assert.equal(out.status, 409);
  });
});

describe('a large attachment on a message', () => {
  it('is accepted up to 50 MB where large files can be sent as links, and 2 MB where they cannot', async () => {
    const s3 = cloud();
    const token = await uploadTo(s3, 'big.pdf', pdf(30 * MB));
    const att = ((await complete(token)).body as { attachment: { id: string } }).attachment;
    const sent = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/message`, { method: 'POST', cookie, body: { message: 'Read it', attachmentIds: [att.id] } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const event = one<{ data: string }>("SELECT data FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'human' ORDER BY id DESC LIMIT 1", workflowId)!;
    assert.equal(JSON.parse(event.data).attachments[0].size, 30 * MB);

    // the same file on a deployment without S3: refused with the old message
    setStorage(original);
    delete process.env.STORAGE_BACKEND;
    const local = path.join(config.dataDir, 'direct-local-test');
    fs.mkdirSync(local, { recursive: true });
    const file = path.join(local, 'local-big.pdf');
    fs.writeFileSync(file, pdf(3 * MB));
    const id = generateId();
    await getAiAttachmentRepository().create({ id, project_id: projectId, filename: 'local-big.pdf', original_name: 'local-big.pdf', mime_type: 'application/pdf', size: 3 * MB, kind: 'document', file_path: file, parent_kind: null, parent_id: null, uploaded_by: userId, created_at: now() });
    const refused = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/message`, { method: 'POST', cookie, body: { message: 'Read it', attachmentIds: [id] } });
    assert.equal(refused.status, 400);
    assert.match(String((refused.body as { error: string }).error), /between 1 byte and 2 MB each/);
  });

  it('is refused over 50 MB, and over 100 MB in all, with the limits spelled out', async () => {
    cloud();
    const make = async (name: string, size: number): Promise<string> => {
      const dir = path.join(config.dataDir, 'direct-limit-test');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      fs.writeFileSync(file, pdf(size));
      const id = generateId();
      await getAiAttachmentRepository().create({ id, project_id: projectId, filename: name, original_name: name, mime_type: 'application/pdf', size, kind: 'document', file_path: file, parent_kind: null, parent_id: null, uploaded_by: userId, created_at: now() });
      return id;
    };
    const send = (ids: string[]) => fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/message`, { method: 'POST', cookie, body: { message: 'Read', attachmentIds: ids } });
    const tooBig = await send([await make('over.pdf', 51 * MB)]);
    assert.equal(tooBig.status, 400);
    assert.match(String((tooBig.body as { error: string }).error), /between 1 byte and 50 MB each/);
    const ids = [await make('a.pdf', 40 * MB), await make('b.pdf', 40 * MB), await make('c.pdf', 40 * MB)];
    const tooMany = await send(ids);
    assert.equal(tooMany.status, 400);
    assert.match(String((tooMany.body as { error: string }).error), /exceed the 100 MB total limit/);
  });

  it('knows which limits apply', () => {
    delete process.env.STORAGE_BACKEND;
    assert.deepEqual(attachmentLimits(), { files: 5, fileBytes: 2 * MB, totalBytes: 8 * MB, large: false });
    cloud();
    assert.deepEqual(attachmentLimits(), { files: 5, fileBytes: 50 * MB, totalBytes: 100 * MB, large: true });
  });
});

describe('what the runner is given', () => {
  const stageDir = (): string => {
    const dir = path.join(config.dataDir, 'projects', slug, 'runs', 'direct-' + generateId(), 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    return path.dirname(dir);
  };

  it('has small files inline and large files as download links', async () => {
    const s3 = cloud();
    const work = stageDir();
    fs.writeFileSync(path.join(work, 'attachments', 'small.txt'), 'hello');
    fs.writeFileSync(path.join(work, 'attachments', 'big.pdf'), pdf(3 * MB));
    fs.writeFileSync(path.join(work, 'attachments', 'huge.pdf'), pdf(51 * MB));
    const files = await collectInputFilesWithUrls(work);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ['attachments/big.pdf', 'attachments/small.txt'], 'a file over 50 MB is left out');
    assert.equal((byPath['attachments/small.txt'] as { data: string }).data, Buffer.from('hello').toString('base64'));
    const big = byPath['attachments/big.pdf'] as { url: string; size: number };
    assert.equal(big.size, 3 * MB);
    assert.match(big.url, /^https:\/\/cy-ai-bucket\.s3\.ap-southeast-1\.amazonaws\.com\//);
    const signed = s3.presigned.find((p) => p.path.endsWith('big.pdf'))!;
    assert.equal(signed.method, 'get');
    assert.equal(signed.seconds, RUNNER_LINK_SECONDS);
    assert.equal(s3.objects.get(signed.path)?.length, 3 * MB, 'the file was mirrored to storage before it was linked');
  });

  it('is exactly the inline collector where there is no S3', async () => {
    delete process.env.STORAGE_BACKEND;
    const work = stageDir();
    fs.writeFileSync(path.join(work, 'attachments', 'small.txt'), 'hello');
    fs.writeFileSync(path.join(work, 'attachments', 'big.pdf'), pdf(3 * MB));
    const files = await collectInputFilesWithUrls(work);
    assert.deepEqual(files.map((f) => f.path), ['attachments/small.txt']);
  });

  it('refuses a large file of the current message that is over the limit, as before', async () => {
    cloud();
    const work = stageDir();
    fs.writeFileSync(path.join(work, 'attachments', 'abc.pdf'), pdf(51 * MB));
    await assert.rejects(collectInputFilesWithUrls(work, ['attachments/abc.pdf']), /exceed runner file limits/);
  });

  it('counts large files together: three of 40 MB do not fit in 100 MB', async () => {
    cloud();
    const work = stageDir();
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(work, 'attachments', `${n}.pdf`), pdf(40 * MB));
    const files = await collectInputFilesWithUrls(work);
    assert.equal(files.length, 2);
  });

  it('works end to end from a saved chat attachment to a link', async () => {
    const s3 = cloud();
    const token = await uploadTo(s3, 'e2e.pdf', pdf(12 * MB));
    const att = ((await complete(token)).body as { attachment: { id: string } }).attachment;
    const sent = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/message`, { method: 'POST', cookie, body: { message: 'Read it', attachmentIds: [att.id] } });
    assert.equal(sent.status, 200);
    const event = one<{ data: string }>("SELECT data FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'human' ORDER BY id DESC LIMIT 1", workflowId)!;
    const work = stageDir();
    const staged = await stageChatAttachments(projectId, workflowId, [event], work);
    const files = await collectInputFilesWithUrls(work, staged.map((a) => 'attachments/' + a.path));
    assert.equal(files.length, 1);
    assert.equal((files[0] as { size: number }).size, 12 * MB);
    assert.match((files[0] as { url: string }).url, /X-Amz-Expires=7200/);
  });
});

describe('the S3 backend', () => {
  // The client is replaced by one that records what it is asked, so nothing reaches AWS.
  function backend(answer: (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => unknown) {
    const b = new S3StorageBackend({ bucket: 'cy-ai-bucket', prefix: 'data', region: 'ap-southeast-1' });
    const seen: Array<{ name: string; input: Record<string, unknown> }> = [];
    (b as unknown as { _client: unknown })._client = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => { seen.push({ name: cmd.constructor.name, input: cmd.input }); return answer(cmd); },
    };
    return { b, seen };
  }

  it('signs the length of a put link into it, and nothing else about the body', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAFAKEFAKEFAKEFAKE';
    process.env.AWS_SECRET_ACCESS_KEY = 'fake';
    try {
      const b = new S3StorageBackend({ bucket: 'cy-ai-bucket', prefix: 'data', region: 'ap-southeast-1' });
      const withLength = new URL(await b.presign('upload-staging/p/u/a.pdf', 'put', 900, { contentLength: 31457280 }));
      assert.equal(withLength.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host');
      assert.equal(withLength.searchParams.get('X-Amz-Expires'), '900');
      assert.match(withLength.pathname, /^\/data\/upload-staging\/p\/u\/a\.pdf$/);
      assert.deepEqual([...withLength.searchParams.keys()].filter((k) => /checksum|sdk-/i.test(k)), [], 'no checksum the browser could not reproduce');
      const without = new URL(await b.presign('upload-staging/p/u/a.pdf', 'put', 900));
      assert.equal(without.searchParams.get('X-Amz-SignedHeaders'), 'host');
      const get = new URL(await b.presign('workspace-snapshots/w.tar.gz', 'get', 7200));
      assert.equal(get.searchParams.get('X-Amz-Expires'), '7200');
    } finally { delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY; }
  });

  it('heads, reads a range of, and copies an object under its prefix', async () => {
    const { b, seen } = backend((cmd) => {
      if (cmd.constructor.name === 'HeadObjectCommand') return { ContentLength: 1234 };
      if (cmd.constructor.name === 'GetObjectCommand') return { Body: (async function* () { yield new Uint8Array([1, 2, 3]); })() };
      return {};
    });
    assert.deepEqual(await b.head('x/a.pdf'), { size: 1234 });
    assert.deepEqual([...(await b.readRange('x/a.pdf', 0, 4095))], [1, 2, 3]);
    await b.copy('upload-staging/p/u/a b.pdf', 'projects/s/ai-attachments/id-a_b.pdf', { contentType: 'application/pdf' });
    await b.copy('a', 'b');
    assert.deepEqual(seen.map((s) => s.name), ['HeadObjectCommand', 'GetObjectCommand', 'CopyObjectCommand', 'CopyObjectCommand']);
    assert.equal(seen[0].input.Key, 'data/x/a.pdf');
    assert.equal(seen[1].input.Range, 'bytes=0-4095');
    assert.equal(seen[2].input.Key, 'data/projects/s/ai-attachments/id-a_b.pdf');
    assert.equal(seen[2].input.CopySource, 'cy-ai-bucket/data/upload-staging/p/u/a%20b.pdf', 'the source is URL-encoded');
    assert.deepEqual([seen[2].input.MetadataDirective, seen[2].input.ContentType], ['REPLACE', 'application/pdf'], 'the type is set when one is given');
    assert.equal('MetadataDirective' in seen[3].input, false, 'and the original kept when none is');
  });

  it('says null for an object that does not exist', async () => {
    const { b } = backend(() => { const e = new Error('nf') as Error & { name: string; $metadata: object }; e.name = 'NotFound'; e.$metadata = { httpStatusCode: 404 }; throw e; });
    assert.equal(await b.head('missing'), null);
  });
});
