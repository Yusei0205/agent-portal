/// <reference lib="dom" />
/**
 * The chat's output card shows the first lines of a small text file, and shows nothing extra when the file cannot be read.
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

describe('output card excerpt', () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require('jsdom');
  const { createElement, act } = require('react');
  let tempDir = '';
  let RunOutputsCard: unknown;
  let dom: InstanceType<typeof JSDOM>;
  let root: { render: (e: unknown) => void; unmount: () => void };
  const previousFetch = globalThis.fetch;
  let fileText: string | null = 'import os\nprint("hi")\n';

  before(async () => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    globalThis.fetch = async () => (fileText === null ? new Response('nope', { status: 500 }) : new Response(fileText));
    tempDir = await mkdtemp(path.resolve('.output-card-test-'));
    const outfile = path.join(tempDir, 'Card.mjs');
    await build({
      stdin: { contents: "export { RunOutputsCard } from './web/src/pages/sessions/RunOutputsCard.jsx';", resolveDir: process.cwd(), loader: 'jsx' },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'style' }));
        b.onLoad({ filter: /.*/, namespace: 'style' }, () => ({ contents: '', loader: 'js' }));
      } }],
    });
    RunOutputsCard = (await import(pathToFileURL(outfile).href)).RunOutputsCard;
    const { createRoot } = require('react-dom/client');
    root = createRoot(dom.window.document.getElementById('root'));
  });
  after(async () => {
    if (root) await act(async () => root.unmount());
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    dom?.window.close();
    globalThis.fetch = previousFetch;
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });

  const files = [
    { id: 'a', name: 'report.xlsx', path: 'report.xlsx', size_bytes: 18000, mime_type: 'x', version: 1, download_url: '/d/a' },
    { id: 'b', name: 'page.py', path: 'page.py', size_bytes: 40, mime_type: 'text/x-python', version: 1, download_url: '/d/b' },
  ];
  const mount = async () => {
    await act(async () => root.render(createElement(RunOutputsCard, { files, workflowId: 'w', projectId: 'p', vaultFolder: null, onPreview: () => {} })));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  };

  it('shows numbered lines of the first text file', async () => {
    await mount();
    const code = dom.window.document.querySelector('.run-outputs-excerpt-code');
    assert.ok(code, 'the excerpt is shown');
    assert.match(code!.textContent!, /1import os/);
    assert.match(code!.textContent!, /2print\("hi"\)/);
    assert.match(dom.window.document.querySelector('.run-outputs-excerpt-name')!.textContent!, /page\.py/);
  });

  it('shows nothing extra when the file cannot be read', async () => {
    fileText = null;
    await act(async () => root.render(null));
    await mount();
    assert.equal(dom.window.document.querySelector('.run-outputs-excerpt'), null);
    assert.ok(dom.window.document.querySelector('.run-outputs-card'), 'the card itself is still there');
  });
});
