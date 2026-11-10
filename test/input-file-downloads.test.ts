/**
 * Large attachments reach the runner as download links, not inline base64 (runner side: writeInputFilesAsync).
 * The runner fetches them from a local test server here; in production they are presigned S3 links.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { isInputFileUrl, writeInputFiles, writeInputFilesAsync, URL_FILE_LIMITS } from '../server/agent/runner-files.ts';

const MB = 1024 * 1024;

describe('which download addresses the runner will fetch', () => {
  it('accepts an S3 presigned link', () => {
    assert.equal(isInputFileUrl('https://cy-ai-bucket.s3.ap-southeast-1.amazonaws.com/data/x.pdf?X-Amz-Signature=abc'), true);
    assert.equal(isInputFileUrl('https://s3.amazonaws.com/b/k'), true);
  });
  it('refuses anything else: plain http, other hosts, look-alikes, addresses, credentials, long or non-strings', () => {
    for (const bad of [
      'http://b.s3.amazonaws.com/k', 'https://evil.example.com/k', 'https://amazonaws.com.evil.example/k', 'https://notamazonaws.com/k',
      'https://127.0.0.1/k', 'https://localhost/k', 'https://[::1]/k', 'https://169.254.169.254/latest/meta-data',
      'https://user:pw@b.s3.amazonaws.com/k', 'file:///etc/passwd', 'not a url', '', `https://b.s3.amazonaws.com/${'a'.repeat(4000)}`,
    ]) assert.equal(isInputFileUrl(bad), false, bad.slice(0, 60));
    assert.equal(isInputFileUrl(undefined), false);
    assert.equal(isInputFileUrl(42), false);
  });
});

describe('writeInputFilesAsync', () => {
  let server: http.Server;
  let base = '';
  let hits: string[] = [];
  const bytes = (n: number) => Buffer.alloc(n, 7);
  let work = '';
  let said: string[] = [];
  const emit = (e: { type: 'status'; text: string }) => { said.push(e.text); };
  const allow = (u: string) => u.startsWith('http://127.0.0.1:');
  const run = (files: unknown) => writeInputFilesAsync(work, files, emit, { allowUrl: allow, timeoutMs: 5000 });

  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      const url = new URL(req.url ?? '/', 'http://x');
      const n = Number(url.searchParams.get('n') ?? 0);
      if (url.pathname === '/ok') { res.writeHead(200, { 'Content-Length': n }); res.end(bytes(n)); return; }
      if (url.pathname === '/redirect') { res.writeHead(302, { Location: '/ok?n=10' }); res.end(); return; }
      if (url.pathname === '/missing') { res.writeHead(404); res.end('no'); return; }
      // sends more than it announces it will
      if (url.pathname === '/liar') { res.writeHead(200); res.end(bytes(n + 500)); return; }
      // announces a size, then sends less
      if (url.pathname === '/short') { res.writeHead(200); res.end(bytes(Math.max(0, n - 10))); return; }
      if (url.pathname === '/big-header') { res.writeHead(200, { 'Content-Length': n + 100 }); res.end(bytes(n + 100)); return; }
      res.writeHead(500); res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  beforeEach(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'inp-')); said = []; hits = []; });
  afterEach(() => { fs.rmSync(work, { recursive: true, force: true }); });

  const file = (rel: string) => path.join(work, ...rel.split('/'));
  const entry = (rel: string, q: string, size: number) => ({ path: rel, url: `${base}${q}`, size });

  it('downloads a large file byte for byte, next to an inline one', async () => {
    const n = await run([
      { path: 'attachments/small.txt', data: Buffer.from('hello').toString('base64') },
      entry('attachments/big.pdf', `/ok?n=${3 * MB}`, 3 * MB),
    ]);
    assert.equal(n, 2);
    assert.equal(fs.readFileSync(file('attachments/small.txt'), 'utf8'), 'hello');
    assert.equal(fs.statSync(file('attachments/big.pdf')).size, 3 * MB);
    assert.deepEqual(said, []);
    assert.deepEqual(fs.readdirSync(file('attachments')).sort(), ['big.pdf', 'small.txt'], 'no .part file is left');
  });

  it('refuses a redirect, an error answer, and a file that is not the announced size, and leaves nothing behind', async () => {
    const n = await run([
      entry('attachments/redirect.pdf', '/redirect', 10),
      entry('attachments/missing.pdf', '/missing', 10),
      entry('attachments/liar.pdf', '/liar?n=1000', 1000),
      entry('attachments/short.pdf', '/short?n=1000', 1000),
      entry('attachments/header.pdf', '/big-header?n=1000', 1000),
    ]);
    assert.equal(n, 0);
    assert.equal(said.length, 5, said.join(' | '));
    for (const name of ['redirect', 'missing', 'liar', 'short', 'header']) {
      assert.ok(said.some((s) => s.includes(`${name}.pdf could not be downloaded`)), `${name}: ${said.join(' | ')}`);
    }
    assert.deepEqual(fs.existsSync(file('attachments')) ? fs.readdirSync(file('attachments')) : [], []);
    assert.ok(!hits.includes('/ok?n=10'), 'the redirect was not followed');
  });

  it('checks the path, the type, the address and the size before fetching anything', async () => {
    const n = await run([
      entry('../escape.pdf', '/ok?n=10', 10),
      entry('attachments/run.sh', '/ok?n=10', 10),
      entry('notes/a.pdf', '/ok?n=10', 10),
      { path: 'attachments/a.pdf', url: 'https://evil.example.com/x', size: 10 },
      entry('attachments/zero.pdf', '/ok?n=0', 0),
      entry('attachments/fraction.pdf', '/ok?n=10', 10.5),
      entry('attachments/toobig.pdf', '/ok', URL_FILE_LIMITS.fileBytes + 1),
      { path: 'attachments/nothing.pdf' },
      'not an object',
    ]);
    assert.equal(n, 0);
    assert.equal(hits.length, 0, 'nothing was fetched');
    assert.equal(said.length, 9, said.join(' | '));
    assert.ok(said.some((s) => /nothing\.pdf was skipped: it came with no content/.test(s)));
    assert.ok(said.some((s) => /a\.pdf was skipped: its download address is not allowed/.test(s)));
  });

  it('keeps the total of the downloads within the limit', async () => {
    const each = 40 * MB;
    // the check happens before any fetch, so no 40 MB bodies are needed for the one that does not fit
    const first = entry('attachments/a.pdf', `/ok?n=${each}`, each);
    const second = entry('attachments/b.pdf', `/ok?n=${each}`, each);
    const third = entry('attachments/c.pdf', `/ok?n=${each}`, each);
    const n = await run([first, second, third]);
    assert.equal(n, 2, 'two fit in 100 MB, the third does not');
    assert.ok(said.some((s) => /c\.pdf was skipped: it is over the size limit/.test(s)), said.join(' | '));
  });

  it('never repeats a link in what it says', async () => {
    await run([{ path: 'attachments/x.pdf', url: `${base}/missing?X-Amz-Signature=SECRET`, size: 10 }]);
    assert.equal(said.length, 1);
    assert.doesNotMatch(said[0], /SECRET|http/);
  });

  it('refuses every address in a real run unless it is an S3 link (the default guard)', async () => {
    const n = await writeInputFilesAsync(work, [{ path: 'attachments/a.pdf', url: `${base}/ok?n=10`, size: 10 }], emit);
    assert.equal(n, 0);
    assert.match(said[0], /download address is not allowed/);
    assert.equal(hits.length, 0);
  });

  it('is the same as the old writer for inline files, and the old writer still ignores links', () => {
    const files = [{ path: 'attachments/a.txt', data: Buffer.from('a').toString('base64') }, { path: 'attachments/b.pdf', url: `${base}/ok?n=1`, size: 1 }];
    assert.equal(writeInputFiles(work, files), 1);
    assert.equal(fs.existsSync(file('attachments/b.pdf')), false);
  });

  it('copes with no files and with something that is not a list', async () => {
    assert.equal(await run([]), 0);
    assert.equal(await run(undefined), 0);
    assert.equal(await run({ path: 'attachments/a.txt' }), 0);
    assert.deepEqual(said, []);
  });
});
