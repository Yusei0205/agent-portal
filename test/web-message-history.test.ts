/// <reference lib="dom" />
/**
 * Up and Down in the chat box bring back the messages sent before, like a terminal (Kiro, Claude Code, Codex).
 * The rules are tested on their own, then the real composer is driven with key presses.
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
// @ts-expect-error — plain JS module without type declarations
import { addToHistory, idleHistory, stepHistory } from '../web/src/lib/messageHistory.js';

describe('message history rules', () => {
  const list = ['one', 'two', 'three'];
  const at = (value: string, pos = value.length) => ({ value, selStart: pos, selEnd: pos });

  it('keeps what was sent, once in a row, and no more than the limit', () => {
    assert.deepEqual(addToHistory([], '  hello  '), ['hello']);
    assert.deepEqual(addToHistory(['a'], 'a'), ['a']);
    assert.deepEqual(addToHistory(['a'], '   '), ['a']);
    assert.equal(addToHistory(Array.from({ length: 100 }, (_, i) => `m${i}`), 'new').length, 100);
  });

  it('Up goes back one message at a time and stops at the oldest', () => {
    let state = idleHistory(list);
    const seen: string[] = [];
    let value = '';
    for (let i = 0; i < 5; i++) {
      const r = stepHistory(list, state, 'ArrowUp', at(value));
      assert.ok(r);
      state = r.state; value = r.value; seen.push(value);
    }
    assert.deepEqual(seen, ['three', 'two', 'one', 'one', 'one']);
  });

  it('Down comes forward and ends on what was being typed', () => {
    let r = stepHistory(list, idleHistory(list), 'ArrowUp', at('my draft'))!;
    r = stepHistory(list, r.state, 'ArrowUp', at(r.value))!;
    assert.equal(r.value, 'two');
    r = stepHistory(list, r.state, 'ArrowDown', at(r.value))!;
    assert.equal(r.value, 'three');
    r = stepHistory(list, r.state, 'ArrowDown', at(r.value))!;
    assert.equal(r.value, 'my draft');
    assert.equal(stepHistory(list, r.state, 'ArrowDown', at(r.value)), null, 'nothing further to come forward to');
  });

  it('leaves the arrows to the box when they move inside a message or a selection', () => {
    assert.equal(stepHistory(list, idleHistory(list), 'ArrowUp', at('a\nb')), null, 'caret on the second line');
    assert.equal(stepHistory(list, idleHistory(list), 'ArrowUp', { value: 'abc', selStart: 0, selEnd: 3 }), null, 'a selection');
    assert.equal(stepHistory([], idleHistory([]), 'ArrowUp', at('')), null, 'no history');
    const browsing = stepHistory(list, idleHistory(list), 'ArrowUp', at(''))!;
    assert.equal(stepHistory(list, { ...browsing.state, index: 0 }, 'ArrowDown', at('x\ny', 0)), null, 'caret not on the last line');
  });
});

describe('the composer arrow keys', () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require('jsdom');
  const { createElement, act } = require('react');
  let tempDir = '';
  let ComposerBar: unknown;
  let dom: InstanceType<typeof JSDOM>;
  let root: { render: (e: unknown) => void; unmount: () => void };
  const previousFetch = globalThis.fetch;
  const sent: string[] = [];

  before(async () => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      let body: unknown = { commands: [] };
      if (u.endsWith('/message-history')) body = { messages: ['first question', 'second question'] };
      else if (u.endsWith('/message')) { sent.push(JSON.parse(String(init?.body)).message); body = { ok: true, resumed: true }; }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    };
    tempDir = await mkdtemp(path.resolve('.message-history-test-'));
    const outfile = path.join(tempDir, 'Composer.mjs');
    await build({
      stdin: { contents: "export { ComposerBar } from './web/src/pages/sessions/IdeWorkspace.jsx';", resolveDir: process.cwd(), loader: 'jsx' },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'style' }));
        b.onLoad({ filter: /.*/, namespace: 'style' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /^dcv(?:-ui)?$/ }, (a) => ({ path: a.path, namespace: 'viewer' }));
        b.onLoad({ filter: /.*/, namespace: 'viewer' }, () => ({ contents: 'export default {}; export const DCVViewer = () => null;', loader: 'js' }));
      } }],
    });
    ComposerBar = (await import(pathToFileURL(outfile).href)).ComposerBar;
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

  const box = () => dom.window.document.querySelector('textarea') as HTMLTextAreaElement;
  const press = async (key: string) => {
    const e = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    await act(async () => { box().dispatchEvent(e); });
    return e.defaultPrevented;
  };
  const type = async (text: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(box(), text); box().dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    box().setSelectionRange(text.length, text.length);
  };

  it('Up recalls earlier messages, Down returns to the draft, and a sent message joins the list', async () => {
    await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: { id: 'w1', status: 'paused', engine: 'demo', repo_ids: [] } })));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    await type('half typed');
    assert.equal(await press('ArrowUp'), true);
    assert.equal(box().value, 'second question');
    await press('ArrowUp');
    assert.equal(box().value, 'first question');
    await press('ArrowDown');
    assert.equal(box().value, 'second question');
    await press('ArrowDown');
    assert.equal(box().value, 'half typed', 'back to what was being typed');

    await type('a third one');
    await press('Enter');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    assert.deepEqual(sent, ['a third one']);
    assert.equal(box().value, '');
    await press('ArrowUp');
    assert.equal(box().value, 'a third one', 'the message just sent is the first one recalled');
  });

  it('leaves Up alone inside a message of several lines', async () => {
    await type('line one\nline two');
    assert.equal(await press('ArrowUp'), false);
    assert.equal(box().value, 'line one\nline two');
  });
});
