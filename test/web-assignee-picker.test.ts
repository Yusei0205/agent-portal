/// <reference lib="dom" />
/**
 * The person filter on the Tickets page: a button that opens a list of people. With no project the list starts from the people on the
 * tickets shown, typing a name asks the portal, picking one reports the person, and the clear button reports none. Real component in
 * jsdom; the portal's answers are stood in for.
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

describe('the person filter', () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require('jsdom');
  const { createElement, act } = require('react');
  let tempDir = '';
  let AssigneePicker: unknown;
  let dom: InstanceType<typeof JSDOM>;
  let root: { render: (e: unknown) => void; unmount: () => void };
  const previousFetch = globalThis.fetch;
  const asked: string[] = [];
  const picked: Array<{ accountId: string; name: string } | null> = [];

  before(async () => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      const q = new URL(String(url), 'http://x').searchParams.get('q');
      const people = q ? [{ accountId: 'u-bo', name: 'Bo Search' }] : [];
      return new Response(JSON.stringify({ assignees: people }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    tempDir = await mkdtemp(path.resolve('.picker-test-'));
    const outfile = path.join(tempDir, 'Picker.mjs');
    await build({
      stdin: { contents: "export { AssigneePicker } from './web/src/components/AssigneePicker.jsx';", resolveDir: process.cwd(), loader: 'jsx' },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'style' }));
        b.onLoad({ filter: /.*/, namespace: 'style' }, () => ({ contents: '', loader: 'js' }));
      } }],
    });
    AssigneePicker = (await import(pathToFileURL(outfile).href)).AssigneePicker;
    const { createRoot } = require('react-dom/client');
    root = createRoot(dom.window.document.getElementById('root'));
  });
  after(async () => {
    if (root) await act(async () => root.unmount());
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    globalThis.fetch = previousFetch;
  });

  const doc = (): Document => dom.window.document;
  const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 400)); }); };
  const suggestions = [{ accountId: 'u-zed', name: 'Zed Z' }, { accountId: 'u-amy', name: 'Amy A' }];
  const render = async (value: { accountId: string; name: string } | null): Promise<void> => {
    await act(async () => root.render(createElement(AssigneePicker as never, { projectId: 'p1', jiraProject: '', suggestions, value, onPick: (p: never) => picked.push(p) })));
  };
  const options = (): string[] => [...doc().querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '');

  it('opens on the button and lists the people on the tickets shown, sorted', async () => {
    await render(null);
    await act(async () => { (doc().querySelector('button[aria-haspopup="listbox"]') as HTMLElement).click(); });
    await settle();
    assert.deepEqual(options(), ['Amy A', 'Zed Z']);
    assert.ok(asked.some((u) => u.includes('/api/projects/p1/jira/assignees')));
  });

  it('typing a name asks the portal, and picking one reports the person and closes the list', async () => {
    const input = doc().querySelector('input[aria-label="Search people"]') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'bo');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await settle();
    assert.ok(asked.some((u) => u.includes('q=bo')), 'the name was sent');
    assert.deepEqual(options(), ['Bo Search'], 'the suggestions that do not match are gone, the found person is in');
    await act(async () => { (doc().querySelector('[role="option"]') as HTMLElement).click(); });
    assert.deepEqual(picked, [{ accountId: 'u-bo', name: 'Bo Search' }]);
    assert.equal(doc().querySelector('[role="listbox"]'), null, 'closed after a pick');
  });

  it('with a person chosen the button shows the name, and the clear button reports none', async () => {
    await render({ accountId: 'u-bo', name: 'Bo Search' });
    assert.match(doc().querySelector('button[aria-haspopup="listbox"]')!.textContent ?? '', /Bo Search/);
    await act(async () => { (doc().querySelector('button[aria-label^="Clear the person filter"]') as HTMLElement).click(); });
    assert.deepEqual(picked.at(-1), null);
  });
});
