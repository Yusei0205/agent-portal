/// <reference lib="dom" />
/** Agents panel: selecting a node in the graph shows that agent's task, result and usage. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('selecting an agent node shows its task and result; the session node shows the session goal', async () => {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {IdeAgents} from './web/src/pages/sessions/IdeAgents.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css'; import './web/src/styles/ide.css'; createRoot(document.getElementById('root')).render(<IdeAgents workflowId="session" projectId="project" workflow={{ title: '', goal: 'Add a retry to the upload step', status: 'running' }} />);`,
      resolveDir: process.cwd(),
      loader: 'jsx',
    },
    bundle: true, write: false, outfile: 'agents-fixture.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://portal.test/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/agents')) {
        await route.fulfill({ json: { agents: [
          { id: 'run:a', name: 'planner', status: 'running', source: 'event', description: 'Break the goal into tasks', startedAt: '2026-11-08T01:00:00Z' },
          { id: 'run:b', parentId: 'run:a', name: 'coder', status: 'done', source: 'event', description: 'Make the change in the files the researcher found', summary: 'Changed 2 files and added a test.', tokens: 9100, toolUses: 14, durationMs: 12000, startedAt: '2026-11-08T01:00:01Z', finishedAt: '2026-11-08T01:00:13Z' },
          { id: 'child-1', parentId: 'session', name: 'Release notes', status: 'done', source: 'session', sessionId: 'child-1', description: 'Write the release notes for version 2' },
        ] } });
      } else if (url.endsWith('.js') || url.endsWith('.css')) {
        const css = url.endsWith('.css');
        await route.fulfill({ contentType: css ? 'text/css' : 'text/javascript', body: bundle.outputFiles.find((f) => f.path.endsWith(css ? '.css' : '.js'))!.text });
      } else if (url.includes('/api/')) await route.fulfill({ json: {} });
      else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body style="--panel:#fff;--ink:#111;--accent:#37d88a;--line:#456;--ok:#2a7;--danger:#c33"><div id="root" style="width:420px;height:850px"></div><script src="/fixture.js"></script></body></html>' });
    });
    await page.goto('http://portal.test/');
    await page.locator('.react-flow__node').nth(3).waitFor();

    // Nothing is selected yet: a hint, not a stale detail.
    assert.equal(await page.locator('.agent-detail').count(), 0);
    await page.getByText('Select an agent in the graph to see its task.').waitFor();

    // Clicking a node (here the one that has finished) shows its task, result and usage.
    await page.locator('.react-flow__node', { hasText: 'coder' }).click();
    const detail = page.getByRole('region', { name: 'Details for coder' });
    await detail.waitFor();
    const text = await detail.innerText();
    assert.match(text, /Done/);
    assert.match(text, /Make the change in the files the researcher found/);
    assert.match(text, /Changed 2 files and added a test\./);
    assert.match(text, /14/);
    assert.match(text, /9,100/);
    assert.match(text, /12s/);

    // The keyboard works too: focus the node's button and press Enter.
    await page.getByRole('button', { name: 'planner, running' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('region', { name: 'Details for planner' }).waitFor();
    assert.match(await page.locator('.agent-detail').innerText(), /Break the goal into tasks/);
    assert.equal(await page.getByText('Changed 2 files and added a test.').count(), 0, 'the previous agent\'s result is gone');

    // The list under the graph selects too, which matters when the graph is drawn small in a narrow panel.
    await page.locator('.agent-item-pick', { hasText: 'coder' }).click();
    await page.getByRole('region', { name: 'Details for coder' }).waitFor();

    // A delegated session links to that session.
    await page.locator('.react-flow__node', { hasText: 'Release notes' }).click();
    await page.getByRole('link', { name: 'Open this session' }).waitFor();

    // The session itself shows its goal.
    await page.locator('.react-flow__node', { hasText: 'Session lead' }).click();
    await page.getByRole('region', { name: 'Details for Session lead' }).waitFor();
    assert.match(await page.locator('.agent-detail').innerText(), /Add a retry to the upload step/);

    // The expanded view has the same selection and detail.
    await page.getByRole('button', { name: 'Expand agent graph' }).click();
    const dialog = page.getByRole('dialog', { name: 'Agent collaboration' });
    await dialog.waitFor();
    await dialog.locator('.react-flow__node', { hasText: 'coder' }).click();
    await dialog.getByRole('region', { name: 'Details for coder' }).waitFor();

    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the session shows a live agents graph above the conversation, with each agent\'s task on its node', async () => {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {SessionAgentsStrip} from './web/src/pages/sessions/SessionAgentsStrip.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css'; import './web/src/styles/ide.css'; createRoot(document.getElementById('root')).render(<SessionAgentsStrip workflowId="session" projectId="project" workflow={{ goal: 'Add a retry to the upload step', status: 'running' }} />);`,
      resolveDir: process.cwd(),
      loader: 'jsx',
    },
    bundle: true, write: false, outfile: 'strip-fixture.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let calls = 0;
    await page.route('http://portal.test/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/agents')) {
        calls++;
        // The first answer has no agents yet; then two start; then one finishes.
        const agents = calls === 1 ? [] : [
          { id: 'run:a', name: 'planner', status: 'running', source: 'event', description: 'Break the goal into tasks' },
          { id: 'run:b', parentId: 'run:a', name: 'coder', status: calls > 2 ? 'done' : 'running', source: 'event', description: 'Make the change in the upload step', summary: 'Changed 2 files.' },
        ];
        await route.fulfill({ json: { agents } });
      } else if (url.endsWith('.js') || url.endsWith('.css')) {
        const css = url.endsWith('.css');
        await route.fulfill({ contentType: css ? 'text/css' : 'text/javascript', body: bundle.outputFiles.find((f) => f.path.endsWith(css ? '.css' : '.js'))!.text });
      } else if (url.includes('/api/')) await route.fulfill({ json: {} });
      else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body style="--panel:#fff;--ink:#111;--accent:#37d88a;--line:#456;--ok:#2a7;--danger:#c33"><div id="root" style="width:1100px"></div><script src="/fixture.js"></script></body></html>' });
    });
    await page.goto('http://portal.test/');

    // No agents yet: nothing is shown.
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.agents-strip').count(), 0);

    // Once agents start (the page asks again every few seconds) the graph appears with each task on its node.
    const strip = page.getByRole('region', { name: 'Agents working in this session' });
    await strip.waitFor({ timeout: 9000 });
    await page.locator('.react-flow__node').nth(2).waitFor();
    assert.equal(await page.locator('.react-flow__node').count(), 3);
    assert.match(await page.locator('.react-flow__node', { hasText: 'planner' }).innerText(), /Break the goal into tasks/);
    assert.match(await page.locator('.react-flow__node', { hasText: 'coder' }).innerText(), /Make the change in the upload step/);

    // It keeps up with the agents: the coder finishes without a reload.
    await page.waitForFunction(() => /done/i.test(document.querySelector('.react-flow__node[data-id="run:b"]')?.textContent ?? ''), undefined, { timeout: 9000 });

    // Selecting a node opens its task and result beside the graph.
    await page.locator('.react-flow__node', { hasText: 'coder' }).click();
    const detail = page.getByRole('region', { name: 'Details for coder' });
    await detail.waitFor();
    assert.match(await detail.innerText(), /Changed 2 files\./);

    // It can be folded away.
    await page.getByRole('button', { name: 'Hide graph' }).click();
    assert.equal(await page.locator('.react-flow__node').count(), 0);
    await page.getByRole('button', { name: 'Show graph' }).click();
    await page.locator('.react-flow__node').nth(2).waitFor();

    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
