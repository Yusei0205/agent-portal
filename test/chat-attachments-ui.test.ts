/// <reference lib="dom" />
import { before, after, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { createElement, act } = require('react');
let tempDir: string;
let ComposerBar: unknown;
let resetLimits: () => void;
let dom: InstanceType<typeof JSDOM>;
let root: { render: (element: unknown) => void; unmount: () => void };
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const previousFetch = globalThis.fetch;
const calls: Array<{ url: string; body: unknown }> = [];
// A test can answer some requests itself; anything it leaves alone gets the default answers below.
let handler: ((url: string, init?: { method?: string; body?: unknown }) => unknown) | null = null;
before(async () => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    const custom = handler?.(String(url), init);
    if (custom) return custom as Response;
    const body = String(url).includes('/ai-attachments')
      ? { attachment: { id: 'image1', filename: 'photo.png', size: 3, kind: 'image' } }
      : String(url).endsWith('/message') ? { ok: true, resumed: true } : { commands: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  tempDir = await mkdtemp(path.resolve('.chat-attachments-test-'));
  const outfile = path.join(tempDir, 'Composer.mjs');
  await build({ stdin: { contents: "export { ComposerBar } from './web/src/pages/sessions/IdeWorkspace.jsx'; export { _resetAttachmentLimits } from './web/src/lib/attachment-limits.js';", resolveDir: process.cwd(), loader: 'jsx' }, outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, plugins: [{ name: 'unused-browser-viewer', setup(builder) {
    // Package CSS is external too; the Node/jsdom harness needs no stylesheet.
    builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'test-style' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-style' }, () => ({ contents: '', loader: 'js' }));
    builder.onResolve({ filter: /^dcv(?:-ui)?$/ }, args => ({ path: args.path, namespace: 'test-viewer' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-viewer' }, () => ({ contents: 'export default {}; export const DCVViewer = () => null;', loader: 'js' }));
  } }] });
  const bundle = await import(pathToFileURL(outfile).href);
  ComposerBar = bundle.ComposerBar;
  resetLimits = bundle._resetAttachmentLimits;
  const { createRoot } = require('react-dom/client');
  root = createRoot(dom.window.document.getElementById('root'));
});
after(async () => {
  if (root) await act(async () => root.unmount());
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  dom?.window.close();
  globalThis.fetch = previousFetch;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});
it('opens the native file input directly from the chat attachment button', async () => {
  await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: { id: 'w1', status: 'paused', engine: 'demo', repo_ids: [] } })));
  const button = dom.window.document.querySelector('[aria-label="Attach file"]') as HTMLButtonElement;
  const input = dom.window.document.querySelector('input[type="file"]') as HTMLInputElement;
  assert.ok(button && input);
  assert.equal(button.disabled, false);
  assert.equal(input.multiple, true);
  assert.ok(input.accept.includes('.png') && input.accept.includes('.pdf') && input.accept.includes('.docx'));
  let opened = 0;
  input.click = () => { opened++; };
  await act(async () => button.click());
  assert.equal(opened, 1, 'the input opens synchronously in the user click, including mobile browsers');
});

it('uploads selected images without an AI turn and includes them only when Send is pressed', async () => {
  const input = dom.window.document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['png'], 'photo.png', { type: 'image/png' })] });
  await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
  assert.ok(calls.some(c => c.url.includes('/ai-attachments')));
  assert.equal(calls.filter(c => c.url.endsWith('/message') || c.url.endsWith('/start')).length, 0);
  const button = dom.window.document.querySelector('[aria-label="Send (Enter)"]') as HTMLButtonElement;
  assert.equal(button.disabled, false, 'an attachment-only message can be sent after upload');
  await act(async () => button.click());
  const sent = calls.find(c => c.url.endsWith('/message'));
  assert.ok(sent);
  assert.deepEqual(JSON.parse(sent.body as string).attachmentIds, ['image1']);
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const MB = 1024 * 1024;

/** A browser upload that does not touch the network: records where the file was PUT and reports progress. */
class FakeXhr {
  static puts: Array<{ url: string; size: number }> = [];
  static progress: number[] = [];
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  status = 0;
  responseText = '';
  private url = '';
  open(_method: string, url: string) { this.url = url; }
  send(body: { size: number }) {
    FakeXhr.puts.push({ url: this.url, size: body.size });
    this.upload.onprogress?.({ lengthComputable: true, loaded: body.size / 2, total: body.size });
    FakeXhr.progress.push(50);
    queueMicrotask(() => { this.status = 200; this.onload?.(); });
  }
}

async function freshComposer(): Promise<void> {
  resetLimits(); // a real page asks once; each of these tests plays another portal
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: { id: 'w1', status: 'paused', engine: 'demo', repo_ids: [] } })));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

async function pick(file: File): Promise<void> {
  const input = dom.window.document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

it('cloud portal: a 30 MB file goes straight to storage, with the limits the portal gave, and is sent on the message', async () => {
  const previousXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  FakeXhr.puts = [];
  calls.length = 0;
  handler = (url) => {
    if (url.endsWith('/api/attachment-limits')) return json({ direct: true, chat: { files: 5, fileBytes: 50 * MB, totalBytes: 100 * MB, large: true } });
    if (url.endsWith('/ai-attachments/presign')) return json({ url: 'https://cy-ai-bucket.s3.ap-southeast-1.amazonaws.com/data/upload-staging/p1/u1/big.pdf?X-Amz-Signature=abc', token: 'tok-1', expiresIn: 900 });
    if (url.endsWith('/ai-attachments/complete')) return json({ attachment: { id: 'big1', filename: 'big.pdf', mimeType: 'application/pdf', size: 30 * MB, kind: 'document' } }, 201);
    return undefined;
  };
  try {
    await freshComposer();
    const attach = dom.window.document.querySelector('[aria-label="Attach file"]') as HTMLButtonElement;
    assert.match(attach.title, /up to 50 MB each/, 'the button says what the portal allows');

    const file = new dom.window.File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 30 * MB });
    await pick(file as unknown as File);

    const presign = calls.find((c) => c.url.endsWith('/ai-attachments/presign'));
    assert.ok(presign, 'the portal was asked for an upload link');
    assert.deepEqual(JSON.parse(presign.body as string), { filename: 'big.pdf', size: 30 * MB, purpose: 'chat' });
    assert.equal(FakeXhr.puts.length, 1);
    assert.match(FakeXhr.puts[0].url, /^https:\/\/cy-ai-bucket\.s3\./, 'the file went to storage');
    assert.equal(FakeXhr.puts[0].size, 30 * MB);
    assert.deepEqual(JSON.parse(calls.find((c) => c.url.endsWith('/ai-attachments/complete'))!.body as string), { token: 'tok-1' });
    assert.equal(calls.filter((c) => c.url.endsWith('/ai-attachments')).length, 0, 'nothing was posted through the portal');

    assert.match(dom.window.document.body.textContent ?? '', /Up to 5 files · 50 MB each · 100 MB total/);
    const send = dom.window.document.querySelector('[aria-label="Send (Enter)"]') as HTMLButtonElement;
    assert.equal(send.disabled, false);
    await act(async () => send.click());
    assert.deepEqual(JSON.parse(calls.find((c) => c.url.endsWith('/message'))!.body as string).attachmentIds, ['big1']);
  } finally {
    handler = null;
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = previousXhr;
  }
});

it('local install: the portal cannot take direct uploads, so the file is posted through it and the small limits show', async () => {
  calls.length = 0;
  handler = (url) => {
    if (url.endsWith('/api/attachment-limits')) return json({ direct: false, chat: { files: 5, fileBytes: 2 * MB, totalBytes: 8 * MB, large: false } });
    if (url.endsWith('/ai-attachments/presign')) return json({ error: 'Direct upload is not available here.', direct: false }, 409);
    if (url.endsWith('/ai-attachments')) return json({ attachment: { id: 'small1', filename: 'notes.txt', mimeType: 'text/plain', size: 5, kind: 'document' } }, 201);
    return undefined;
  };
  try {
    await freshComposer();
    assert.match((dom.window.document.querySelector('[aria-label="Attach file"]') as HTMLButtonElement).title, /up to 2 MB each/);
    await pick(new dom.window.File(['hello'], 'notes.txt', { type: 'text/plain' }) as unknown as File);
    assert.ok(calls.some((c) => c.url.endsWith('/ai-attachments/presign')), 'it tried the direct way first');
    const posted = calls.find((c) => c.url.endsWith('/ai-attachments') && c.body instanceof FormData);
    assert.ok(posted, 'then sent the file through the portal');
    assert.match(dom.window.document.body.textContent ?? '', /Up to 5 files · 2 MB each · 8 MB total/);
  } finally {
    handler = null;
  }
});

it('a refused upload says why and does not attach the file', async () => {
  const previousXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  class RefusingXhr extends FakeXhr {
    send(body: { size: number }) { void body; queueMicrotask(() => { this.status = 403; this.responseText = '<Error><Code>AccessDenied</Code></Error>'; this.onload?.(); }); }
  }
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = RefusingXhr;
  calls.length = 0;
  handler = (url) => {
    if (url.endsWith('/api/attachment-limits')) return json({ direct: true, chat: { files: 5, fileBytes: 50 * MB, totalBytes: 100 * MB, large: true } });
    if (url.endsWith('/ai-attachments/presign')) return json({ url: 'https://b.s3.ap-southeast-1.amazonaws.com/x', token: 'tok-2', expiresIn: 900 });
    return undefined;
  };
  try {
    await freshComposer();
    await pick(new dom.window.File(['hello'], 'refused.pdf', { type: 'application/pdf' }) as unknown as File);
    assert.match(dom.window.document.body.textContent ?? '', /upload link was refused or has expired/);
    assert.equal(calls.some((c) => c.url.endsWith('/ai-attachments/complete')), false, 'the portal was not told it arrived');
    const send = dom.window.document.querySelector('[aria-label="Send (Enter)"]') as HTMLButtonElement;
    assert.equal(send.disabled, true, 'a failed file is not sent');
  } finally {
    handler = null;
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = previousXhr;
  }
});
