/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('agent graph shows concurrent and nested nodes, expands and refreshes without realtime', async () => {
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {IdeAgents} from './web/src/pages/sessions/IdeAgents.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css'; createRoot(document.getElementById('root')).render(<IdeAgents workflowId="session" projectId="project" />);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, outfile: 'agents-fixture.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let requests = 0;
    await page.route('http://portal.test/**', async route => {
      const url = route.request().url();
      if (url.includes('/agents')) {
        requests++;
        await route.fulfill({ json: { agents: [
          { id: 'api', name: 'API reviewer', status: requests > 1 ? 'done' : 'running', source: 'event' },
          { id: 'web', name: 'Frontend reviewer', status: 'running', source: 'event' },
          { id: 'tests', parentId: 'api', name: 'Test reviewer', status: 'pending', source: 'event' },
        ] } });
      } else if (url.endsWith('.js') || url.endsWith('.css')) {
        const css = url.endsWith('.css');
        await route.fulfill({ contentType: css ? 'text/css' : 'text/javascript', body: bundle.outputFiles.find(f => f.path.endsWith(css ? '.css' : '.js'))!.text });
      } else if (url.includes('/api/')) await route.fulfill({ json: {} });
      else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body style="--surface:#111c20;--ink:#d0ead9;--accent:#37d88a;--line:#456;--ok:#37d88a"><div id="root" style="width:300px;height:850px"></div><script src="/fixture.js"></script></body></html>' });
    });
    await page.goto('http://portal.test/');
    await page.locator('.react-flow__node').nth(3).waitFor();
    assert.equal(await page.locator('.react-flow__node').count(), 4);
    await page.locator('.react-flow__edge').nth(2).waitFor({ state: 'attached' }); // attached, not visible: a link between agents on one row is a flat line with no height
    await page.getByRole('button', { name: 'Expand agent graph' }).click();
    const dialog = page.getByRole('dialog', { name: 'Agent collaboration' });
    await dialog.waitFor();
    assert.equal(await dialog.locator('.react-flow__node').count(), 4);
    await page.waitForFunction(() => {
      const node = document.querySelector('dialog .react-flow__node');
      return node && node.getBoundingClientRect().width > 140;
    });
    await page.waitForFunction(() => document.querySelector('.ide-agent-item-meta')?.textContent?.includes('Done'), undefined, { timeout: 8000 });
    assert.ok(requests > 1, 'polling recovers when realtime notifications are unavailable');
    if (process.env.AGENT_GRAPH_SCREENSHOT) await page.screenshot({ path: path.resolve(process.env.AGENT_GRAPH_SCREENSHOT) });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Expand agent graph' }).click();
    await dialog.waitFor();
    assert.ok((await dialog.boundingBox())!.width <= 390);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('conversation source and sandbox artifact links open in the portal instead of navigating to S3', async () => {
  const source = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {SessionLive} from './web/src/pages/sessions/SessionLive.jsx'; createRoot(document.getElementById('root')).render(<SessionLive workflowId="session" projectId="project" runId="run" workflow={{status:'paused',engine:'codex'}} outputFiles={[{id:'report',name:'report.pdf',path:'report.pdf',download_url:'/api/report',preview_url:'/api/report/preview',run_id:'run'}]} onOpenWorkspaceFile={(path,line)=>{window.openedFile={path,line}}} />);`;
  const bundle = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, outfile: 'conversation-fixture.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://portal.test/**', async route => {
      const url = route.request().url();
      if (url.endsWith('/fixture.js')) await route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles.find(f => f.path.endsWith('.js'))!.text });
      else if (url.includes('/api/runs/run/events')) await route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ type: 'event', event: { id: 1, type: 'assistant-text', run_id: 'run', payload: { text: '[API finding](/server/feedback.ts:376) and [Download report](sandbox:/mnt/data/report.pdf)' }, created_at: '2026-11-08T01:00:00Z' } }) + '\n\n' });
      else if (url.includes('/api/')) await route.fulfill({ json: { events: [], nextCursor: null } });
      else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    });
    await page.goto('http://portal.test/');
    await page.getByRole('button', { name: 'API finding', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).openedFile), { path: 'server/feedback.ts', line: 376 });
    assert.equal(page.url(), 'http://portal.test/');
    await page.locator('button[data-output-file-id="report"]').waitFor();
    assert.equal(await page.locator('a[href*="feedback.ts"], a[href^="sandbox:"]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
