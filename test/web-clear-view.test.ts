/// <reference lib="dom" />
/**
 * After /clear the chat starts again: the messages from before it are hidden, with a button to show them, and the opening goal is
 * not repeated above the new start. Real session page in Chromium; the server's answers are stood in for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
// @ts-expect-error — plain JS module without type declarations
import { afterClear, lastClearAt } from '../web/src/lib/clearBoundary.js';

test('the boundary rules', () => {
  const ev = (type: string, at: string, payload: unknown, src = 'w') => ({ src, type, created_at: at, payload });
  const cleared = ev('command-result', '2026-11-15T10:00:00Z', { body: '/clear\n---\nConversation cleared.' });
  const events = [ev('human', '2026-11-15T09:00:00Z', { text: 'old' }), cleared, ev('human', '2026-11-15T10:05:00Z', { text: 'new' })];
  assert.equal(lastClearAt(events), '2026-11-15T10:00:00Z');
  assert.deepEqual(afterClear(events, lastClearAt(events)).map((e: { payload: unknown }) => (e.payload as { text?: string }).text ?? 'cleared'), ['cleared', 'new']);
  assert.equal(lastClearAt([events[0], ev('command-result', '2026-11-15T09:30:00Z', { body: '/help\n---\nlist' })]), '', 'another command is not a clear');
  assert.equal(afterClear(events, '').length, 3, 'never cleared: everything stays');
});

test('the chat hides what came before /clear and can show it again', async () => {
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {SessionLive} from './web/src/pages/sessions/SessionLive.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css'; import './web/src/styles/ide.css';
createRoot(document.getElementById('root')).render(<div style={{height: 700, display: 'flex'}}><SessionLive runId="r1" workflowId="w1" projectId="p1" workflow={{ id: 'w1', engine: 'kiro', goal: 'the opening goal', status: 'paused' }} /></div>);`;
  const bundled = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, outfile: 'live.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    loader: { '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
    plugins: [{ name: 'viewer', setup(b) {
      b.onResolve({ filter: /^dcv(?:-ui)?$/ }, (a) => ({ path: a.path, namespace: 'viewer' }));
      b.onLoad({ filter: /.*/, namespace: 'viewer' }, () => ({ contents: 'export default {}; export const DCVViewer = () => null;', loader: 'js' }));
    } }],
  });
  const file = (ext: string) => bundled.outputFiles.find((f) => f.path.endsWith(ext))!;
  // Newest first, as the server sends it.
  const transcript = [
    { src: 'r', id: 5, kind: 'assistant-text', payload: { text: 'the new answer' }, run_id: 'r0', created_at: '2026-11-15T10:06:00Z' },
    { src: 'w', id: 4, kind: 'human', payload: 'the new question', run_id: null, created_at: '2026-11-15T10:05:00Z' },
    { src: 'w', id: 3, kind: 'command-result', payload: '/clear\n---\nConversation cleared. The next message starts fresh.', run_id: null, created_at: '2026-11-15T10:00:00Z' },
    { src: 'r', id: 2, kind: 'assistant-text', payload: { text: 'the old answer' }, run_id: 'r0', created_at: '2026-11-15T09:01:00Z' },
    { src: 'w', id: 1, kind: 'human', payload: 'the old question', run_id: null, created_at: '2026-11-15T09:00:00Z' },
  ];
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      const p = new URL(u).pathname;
      if (p === '/live.js') await route.fulfill({ contentType: 'text/javascript', body: file('.js').text });
      else if (p === '/live.css') await route.fulfill({ contentType: 'text/css', body: file('.css').text });
      else if (p.endsWith('/events')) await route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
      else if (p.endsWith('/transcript')) await route.fulfill({ json: { events: transcript, nextCursor: null } });
      else if (p.startsWith('/api/')) await route.fulfill({ json: {} });
      else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/live.css"></head><body><div id="root"></div><script type="module" src="/live.js"></script></body></html>' });
    });
    await page.goto('http://portal.test/');

    await page.getByText('the new question').waitFor();
    await page.getByText('the new answer').waitFor();
    assert.equal(await page.getByText('the old question').count(), 0, 'what came before /clear is hidden');
    assert.equal(await page.getByText('the old answer').count(), 0);
    assert.equal(await page.getByText('the opening goal').count(), 0, 'the goal is not repeated above the new start');
    await page.getByText('Conversation cleared.').waitFor();

    await page.getByRole('button', { name: /Show 2 earlier messages \(before \/clear\)/ }).click();
    await page.getByText('the old question').waitFor();
    await page.getByText('the old answer').waitFor();
    assert.equal(await page.getByRole('button', { name: /earlier messages? \(before \/clear\)/ }).count(), 0, 'the button is gone once they are shown');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
