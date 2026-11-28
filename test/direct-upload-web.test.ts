/**
 * The browser side of attachments up to 50 MB: the direct upload (web/src/lib/direct-upload.js) and the limits the chat box shows
 * (web/src/lib/attachment-limits.js).
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS modules shared with the browser
import { uploadDirect, putErrorText } from '../web/src/lib/direct-upload.js';
// @ts-expect-error — plain JS module shared with the browser
import { formatMb, parseLimits, limitsHint, SMALL_LIMITS } from '../web/src/lib/attachment-limits.js';

const MB = 1024 * 1024;
const previousFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = previousFetch; });

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const file = (name: string, size: number) => ({ name, size }) as unknown as File;

/** Answers the portal's two calls; `calls` records the order and what was sent. */
function portal(answers: { presign?: () => Response; complete?: () => Response }) {
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith('/presign')) return (answers.presign ?? (() => reply({ url: 'https://b.s3.ap-southeast-1.amazonaws.com/k', token: 'T', expiresIn: 900 })))();
    return (answers.complete ?? (() => reply({ attachment: { id: 'a1', filename: 'big.pdf', size: 30 * MB, kind: 'document', mimeType: 'application/pdf' } }, 201)))();
  }) as typeof fetch;
  return calls;
}

describe('uploadDirect', () => {
  it('asks for a link, puts the file there with progress, and completes with the token', async () => {
    const calls = portal({});
    const puts: Array<{ url: string; name: string }> = [];
    const seen: number[] = [];
    const attachment = await uploadDirect({
      projectId: 'p1', file: file('big.pdf', 30 * MB), purpose: 'chat', onProgress: (f: number) => seen.push(f),
      put: async (url: string, f: { name: string }, onProgress: (n: number) => void) => { puts.push({ url, name: f.name }); onProgress(0.5); onProgress(1); },
    });
    assert.equal(attachment.id, 'a1');
    assert.deepEqual(calls.map((c) => c.url), ['/api/projects/p1/ai-attachments/presign', '/api/projects/p1/ai-attachments/complete']);
    assert.deepEqual(calls[0].body, { filename: 'big.pdf', size: 30 * MB, purpose: 'chat' });
    assert.deepEqual(calls[1].body, { token: 'T' });
    assert.deepEqual(puts, [{ url: 'https://b.s3.ap-southeast-1.amazonaws.com/k', name: 'big.pdf' }]);
    assert.deepEqual(seen, [0.5, 1]);
  });

  it('is the default purpose when none is given', async () => {
    const calls = portal({});
    await uploadDirect({ projectId: 'p1', file: file('a.pdf', 10), put: async () => {} });
    assert.equal((calls[0].body as { purpose: string }).purpose, 'default');
  });

  it('gives null where the portal cannot take direct uploads, so the file is sent through the portal', async () => {
    for (const status of [409, 404, 405]) {
      const calls = portal({ presign: () => reply({ error: 'no' }, status) });
      let put = 0;
      assert.equal(await uploadDirect({ projectId: 'p1', file: file('a.pdf', 10), put: async () => { put++; } }), null, String(status));
      assert.equal(put, 0);
      assert.equal(calls.length, 1);
    }
  });

  it('gives null for an answer that has no link, such as an older portal that took the file itself', async () => {
    portal({ presign: () => reply({ attachment: { id: 'x' } }) });
    assert.equal(await uploadDirect({ projectId: 'p1', file: file('a.pdf', 10), put: async () => {} }), null);
  });

  it('passes on the portal\'s own reason for refusing a file', async () => {
    portal({ presign: () => reply({ error: 'File exceeds the 50 MB limit (got 60.0 MB)' }, 400) });
    await assert.rejects(uploadDirect({ projectId: 'p1', file: file('a.pdf', 60 * MB), put: async () => {} }), /exceeds the 50 MB limit/);
  });

  it('does not tell the portal a file arrived when it did not', async () => {
    const calls = portal({});
    await assert.rejects(uploadDirect({ projectId: 'p1', file: file('a.pdf', 10), put: async () => { throw new Error('The upload could not reach storage.'); } }), /could not reach storage/);
    assert.equal(calls.some((c) => c.url.endsWith('/complete')), false);
  });

  it('passes on what the portal says when it will not accept what arrived', async () => {
    portal({ complete: () => reply({ error: 'The file that arrived is not the size that was chosen. Choose it again.' }, 400) });
    await assert.rejects(uploadDirect({ projectId: 'p1', file: file('a.pdf', 10), put: async () => {} }), /not the size that was chosen/);
  });
});

describe('what a refused put means', () => {
  it('says the link was refused or has expired for a 403, and otherwise how storage answered', () => {
    assert.match(putErrorText(403), /refused or has expired/);
    assert.match(putErrorText(400, '<Code>EntityTooLarge</Code>'), /did not accept the file as it was sent/);
    assert.match(putErrorText(500), /HTTP 500/);
  });
});

describe('the limits the chat box shows', () => {
  it('writes sizes the way a person reads them', () => {
    assert.equal(formatMb(2 * MB), '2 MB');
    assert.equal(formatMb(50 * MB), '50 MB');
    assert.equal(formatMb(1.5 * MB), '1.5 MB');
  });

  it('takes the portal\'s answer, and the small limits for anything it cannot read', () => {
    assert.deepEqual(parseLimits({ direct: true, chat: { files: 5, fileBytes: 50 * MB, totalBytes: 100 * MB, large: true } }), { files: 5, fileBytes: 50 * MB, totalBytes: 100 * MB, large: true });
    for (const bad of [undefined, null, 'x', {}, { chat: null }, { chat: { files: 5 } }, { chat: { files: 5, fileBytes: 'big', totalBytes: 1 } }, { commands: [] }]) {
      assert.equal(parseLimits(bad), SMALL_LIMITS);
    }
    assert.deepEqual(SMALL_LIMITS, { files: 5, fileBytes: 2 * MB, totalBytes: 8 * MB, large: false });
  });

  it('says them in one line', () => {
    assert.equal(limitsHint({ files: 5, fileBytes: 50 * MB, totalBytes: 100 * MB }), 'Up to 5 files · 50 MB each · 100 MB total');
    assert.equal(limitsHint(SMALL_LIMITS), 'Up to 5 files · 2 MB each · 8 MB total');
  });
});
