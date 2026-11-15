/// <reference lib="dom" />
/**
 * The inbox item for a turn that was cut off: it says what happened, and offers Continue (when the portal is not already continuing),
 * Open session and Dismiss. Real component in jsdom; the portal's answers are stood in for.
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

describe('inbox item for an interrupted turn', () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require('jsdom');
  const { createElement, act } = require('react');
  let tempDir = '';
  let InboxItem: unknown;
  let dom: InstanceType<typeof JSDOM>;
  let root: { render: (e: unknown) => void; unmount: () => void };
  const previousFetch = globalThis.fetch;
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let answers: (url: string, method: string) => { status?: number; body: unknown } | null = () => null;

  before(async () => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    globalThis.fetch = async (url, init) => {
      const method = String(init?.method ?? 'GET');
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const a = answers(String(url), method) ?? { body: { ok: true } };
      return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
    };
    tempDir = await mkdtemp(path.resolve('.inbox-test-'));
    const outfile = path.join(tempDir, 'Inbox.mjs');
    await build({
      stdin: { contents: "export { InboxItem } from './web/src/pages/Inbox.jsx';", resolveDir: process.cwd(), loader: 'jsx' },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'style' }));
        b.onLoad({ filter: /.*/, namespace: 'style' }, () => ({ contents: '', loader: 'js' }));
      } }],
    });
    InboxItem = (await import(pathToFileURL(outfile).href)).InboxItem;
    const { createRoot } = require('react-dom/client');
    root = createRoot(dom.window.document.getElementById('root'));
  });
  after(async () => {
    if (root) await act(async () => root.unmount());
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    // The error toast of a failed Continue has a timer that fires after the tests: the window it needs stays (this file runs in its own process).
    globalThis.fetch = previousFetch;
  });

  const item = (payload: Record<string, unknown>) => ({
    id: 'in1', type: 'blocked', project_id: 'p1', workflow_id: 'w1', project_name: 'Core', workflow_goal: 'Check the scan', created_at: new Date().toISOString(), payload,
  });
  const show = async (payload: Record<string, unknown>, onResolved = () => {}) => {
    calls.length = 0;
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(InboxItem as never, { key: Math.random(), item: item(payload), onResolved })));
  };
  const buttons = () => Array.from(dom.window.document.querySelectorAll('button, a.btn')).map((b) => (b as HTMLElement).textContent?.trim());
  const click = async (label: string) => {
    const el = Array.from(dom.window.document.querySelectorAll('button')).find((b) => (b as HTMLElement).textContent?.trim() === label) as HTMLButtonElement;
    assert.ok(el, `a "${label}" button among: ${buttons().join(', ')}`);
    await act(async () => { el.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  };

  it('says what happened and offers Continue, Open session and Dismiss when the portal is not continuing', async () => {
    await show({ kind: 'turn-interrupted', canContinue: true, continued: false, message: 'The last turn was cut off (the connection to the runner was lost). Open the session and press Continue.' });
    const text = dom.window.document.body.textContent ?? '';
    assert.match(text, /cut off \(the connection to the runner was lost\)/);
    assert.deepEqual(buttons(), ['Continue', 'Open session', 'Dismiss']);
    const open = dom.window.document.querySelector('a.btn') as HTMLAnchorElement;
    assert.equal(open.getAttribute('href'), '#/p/p1/sessions/w1', 'goes to the session');
  });

  it('Continue sends /continue, starts the session when the message did not, and clears the item', async () => {
    let resolved = 0;
    answers = (url) => (url.endsWith('/message') ? { body: { ok: true, kind: 'human', resumed: false } } : null);
    await show({ kind: 'turn-interrupted', canContinue: true, message: 'cut off' }, () => { resolved++; });
    await click('Continue');
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
      'POST /api/projects/p1/workflows/w1/message',
      'POST /api/projects/p1/workflows/w1/start',
      'POST /api/inbox/in1/resolve',
    ]);
    assert.deepEqual(calls[0].body, { message: '/continue' });
    assert.deepEqual(calls[2].body, { response: 'dismissed' });
    assert.equal(resolved, 1);
    assert.match(dom.window.document.body.textContent ?? '', /Dismissed/);
  });

  it('a paused session starts by itself on the message, so Continue does not start it twice', async () => {
    answers = (url) => (url.endsWith('/message') ? { body: { ok: true, resumed: true } } : null);
    await show({ kind: 'turn-interrupted', canContinue: true, message: 'cut off' });
    await click('Continue');
    assert.deepEqual(calls.map((c) => c.url.replace('/api/projects/p1/workflows/w1', '').replace('/api', '')), ['/message', '/inbox/in1/resolve']);
  });

  it('a failed Continue says why and leaves the item there to try again', async () => {
    answers = (url) => (url.endsWith('/message') ? { status: 400, body: { error: 'Workflow has reached its maximum iteration limit' } } : null);
    await show({ kind: 'turn-interrupted', canContinue: true, message: 'cut off' });
    await click('Continue');
    assert.ok(!calls.some((c) => c.url.includes('/resolve')), 'not dismissed');
    assert.match(dom.window.document.body.textContent ?? '', /maximum iteration limit/);
    assert.ok(buttons().includes('Continue'), 'can try again');
  });

  it('when the portal is already continuing there is no Continue button, only Open session and Dismiss', async () => {
    answers = () => null;
    await show({ kind: 'turn-interrupted', canContinue: false, continued: true, message: 'The last turn was cut off (x). The portal is continuing it from where it stopped.' });
    assert.deepEqual(buttons(), ['Open session', 'Dismiss']);
    assert.match(dom.window.document.body.textContent ?? '', /The portal is continuing it/);
  });

  it('any other blocked item keeps only Dismiss', async () => {
    await show({ message: 'Waiting for a person' });
    assert.deepEqual(buttons(), ['Dismiss']);
  });
});
