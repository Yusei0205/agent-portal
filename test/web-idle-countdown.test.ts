/// <reference lib="dom" />
/**
 * The status bar's countdown to the idle stop: nothing until the last ten minutes, then the time left counting down each second against
 * the server's clock, "closing" at zero, and nothing at all while a turn is going (the server sends no stop time then). Real component in
 * jsdom; the portal's answers are stood in for.
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

describe('idle countdown in the status bar', () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require('jsdom');
  const { createElement, act } = require('react');
  let tempDir = '';
  let IdeStatusBar: unknown;
  let dom: InstanceType<typeof JSDOM>;
  let root: { render: (e: unknown) => void; unmount: () => void };
  const previousFetch = globalThis.fetch;
  let statusBar: Record<string, unknown> = {};

  before(async () => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    globalThis.fetch = async (url) => {
      const body = String(url).endsWith('/status-bar') ? statusBar : String(url).endsWith('/limits') ? { limits: null } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    tempDir = await mkdtemp(path.resolve('.idle-test-'));
    const outfile = path.join(tempDir, 'Bar.mjs');
    await build({
      stdin: { contents: "export { IdeStatusBar } from './web/src/pages/sessions/IdeStatusBar.jsx';", resolveDir: process.cwd(), loader: 'jsx' },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'style' }));
        b.onLoad({ filter: /.*/, namespace: 'style' }, () => ({ contents: '', loader: 'js' }));
      } }],
    });
    IdeStatusBar = (await import(pathToFileURL(outfile).href)).IdeStatusBar;
    const { createRoot } = require('react-dom/client');
    root = createRoot(dom.window.document.getElementById('root'));
  });
  after(async () => {
    if (root) await act(async () => root.unmount());
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    globalThis.fetch = previousFetch;
  });

  const MIN = 60_000;
  /** The bar as the server sends it: the stop time is `leftMs` after the server's own clock, which may be far from this one. */
  const show = async (leftMs: number | null, clockOffsetMs = 0) => {
    const serverNow = Date.now() + clockOffsetMs;
    statusBar = {
      engine: 'kiro', model: 'auto', thisTurn: null, thisSession: { costUsd: 0, credits: 0, inputTokens: null, outputTokens: null },
      idle: leftMs === null ? null : { stopAt: new Date(serverNow + leftMs).toISOString(), timeoutMinutes: 30 },
      serverNow: new Date(serverNow).toISOString(),
    };
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(IdeStatusBar as never, { key: Math.random(), projectId: 'p1', workflowId: 'w1', engine: 'kiro' })));
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  };
  const chip = () => dom.window.document.querySelector('.ide-status-idle') as HTMLElement | null;

  it('shows nothing while there is plenty of time, and nothing while a turn is going', async () => {
    await show(25 * MIN);
    assert.equal(chip(), null, 'more than ten minutes left');
    await show(null);
    assert.equal(chip(), null, 'no stop time: the agent is working');
  });

  it('shows the time left in the last ten minutes, counted against the server clock (this machine is five minutes out)', async () => {
    await show(9 * MIN + 30_000, 5 * MIN);
    assert.match(chip()?.textContent ?? '', /closes in\s*9:[23]\d/);
    assert.ok(!chip()!.className.includes('is-soon'));
    assert.match(chip()!.getAttribute('title') ?? '', /Send a message to keep it open/);
  });

  it('turns to a warning under two minutes', async () => {
    await show(90_000);
    assert.match(chip()?.textContent ?? '', /closes in\s*1:[23]\d/);
    assert.ok(chip()!.className.includes('is-soon'));
  });

  it('counts down every second, and says "closing" when the time is up', async () => {
    await show(2_500);
    assert.match(chip()?.textContent ?? '', /closes in\s*0:0[123]/);
    await act(async () => { await new Promise((r) => setTimeout(r, 1_200)); });
    const later = chip()?.textContent ?? '';
    assert.match(later, /closes in\s*0:0[012]/);
    await act(async () => { await new Promise((r) => setTimeout(r, 2_000)); });
    assert.match(chip()?.textContent ?? '', /closing/);
    assert.doesNotMatch(chip()?.textContent ?? '', /\d:\d\d/);
  });
});
