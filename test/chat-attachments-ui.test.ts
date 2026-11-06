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
let dom: InstanceType<typeof JSDOM>;
let root: { render: (element: unknown) => void; unmount: () => void };
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const previousFetch = globalThis.fetch;
const calls: Array<{ url: string; body: unknown }> = [];
before(async () => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    const body = String(url).includes('/ai-attachments')
      ? { attachment: { id: 'image1', filename: 'photo.png', size: 3, kind: 'image' } }
      : String(url).endsWith('/message') ? { ok: true, resumed: true } : { commands: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  tempDir = await mkdtemp(path.resolve('.chat-attachments-test-'));
  const outfile = path.join(tempDir, 'Composer.mjs');
  await build({ stdin: { contents: "export { ComposerBar } from './web/src/pages/sessions/IdeWorkspace.jsx';", resolveDir: process.cwd(), loader: 'jsx' }, outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, plugins: [{ name: 'unused-browser-viewer', setup(builder) {
    builder.onResolve({ filter: /^dcv(?:-ui)?$/ }, args => ({ path: args.path, namespace: 'test-viewer' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-viewer' }, () => ({ contents: 'export default {}; export const DCVViewer = () => null;', loader: 'js' }));
  } }] });
  ({ ComposerBar } = await import(pathToFileURL(outfile).href));
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
