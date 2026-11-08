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


test('the session shows its agents above the conversation: an orbit with each agent\'s current action, tabs, and a transcript per agent', async () => {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {SessionAgentsStrip} from './web/src/pages/sessions/SessionAgentsStrip.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css'; import './web/src/styles/ide.css'; import './web/src/styles/agents-panel.css';
const events = [
  { type: 'tool-start', payload: { toolName: 'Bash', toolInput: JSON.stringify({ command: 'cd rhb && ls' }) } },
  { type: 'tool-start', payload: { toolName: 'Read', toolInput: JSON.stringify({ file_path: 'api.ts' }), agent: 'reviewer' } },
  { type: 'assistant-text', payload: { text: 'Two bugs in api.ts.', agent: 'reviewer' } },
  { type: 'tool-start', payload: { toolName: 'Bash', toolInput: JSON.stringify({ command: 'npm test' }), agent: 'tester' } },
];
createRoot(document.getElementById('root')).render(<SessionAgentsStrip workflowId="session" projectId="project" workflow={{ goal: 'Add a retry to the upload step', status: 'running' }} events={events} />);`,
      resolveDir: process.cwd(),
      loader: 'jsx',
    },
    bundle: true, write: false, outfile: 'strip-fixture.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: 'reduce' }); // still, so the pulsing rings do not keep nodes from being clicked
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let calls = 0;
    await page.route('http://portal.test/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/agents')) {
        calls++;
        // The first answer has no agents yet; then two start; then the tester finishes.
        const agents = calls === 1 ? [] : [
          { id: 'run:a', name: 'reviewer', status: 'running', source: 'event', description: 'Review api.ts for bugs', startedAt: '2026-11-08T01:00:00Z' },
          { id: 'run:b', parentId: 'run:a', name: 'tester', status: calls > 2 ? 'done' : 'running', source: 'event', description: 'Run the tests', summary: 'All pass.', startedAt: '2026-11-08T01:00:05Z', finishedAt: calls > 2 ? '2026-11-08T01:00:20Z' : null },
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

    // Once agents start (the page asks again every few seconds) the orbit appears.
    const strip = page.getByRole('region', { name: 'Agents working in this session' });
    await strip.waitFor({ timeout: 9000 });
    await page.locator('.orbit-node').nth(2).waitFor();
    assert.equal(await page.locator('.orbit-node').count(), 3, 'the main agent and two sub-agents');
    assert.match(await strip.innerText(), /2 subagents · \d running/);

    // Each node says what its agent is doing: the main agent's last tool call, and the running sub-agent's.
    const main = page.getByRole('button', { name: /^Main agent, running/ });
    assert.match((await main.textContent()) ?? '', /Running cd rhb && ls/);
    assert.match((await page.getByRole('button', { name: /^reviewer, running/ }).textContent()) ?? '', /Two bugs in api\.ts/);

    // The tester finishes without a reload.
    await page.getByRole('button', { name: /^tester, done/ }).waitFor({ timeout: 9000 });

    // Selecting an agent shows its own transcript (its messages and tool calls), not the main agent's.
    await page.getByRole('button', { name: /^reviewer,/ }).click();
    const transcript = page.getByRole('list', { name: 'Transcript of reviewer' });
    await transcript.waitFor();
    const lines = await transcript.innerText();
    assert.match(lines, /Read api\.ts/);
    assert.match(lines, /Two bugs in api\.ts\./);
    assert.doesNotMatch(lines, /cd rhb/);
    assert.match(await page.locator('.agent-detail').innerText(), /Review api\.ts for bugs/);

    // In a narrow pane the detail wraps below the orbit and stays inside the panel (it used to spill over the conversation).
    await page.evaluate(() => { (document.getElementById('root') as HTMLElement).style.width = '520px'; });
    await page.waitForTimeout(300);
    const fit = await page.evaluate(() => ({
      panelBottom: document.querySelector('.agents-panel')!.getBoundingClientRect().bottom,
      sideTop: document.querySelector('.agents-panel-side')!.getBoundingClientRect().top,
      sideBottom: document.querySelector('.agents-panel-side')!.getBoundingClientRect().bottom,
      orbitBottom: document.querySelector('.orbit')!.getBoundingClientRect().bottom,
    }));
    assert.ok(fit.sideBottom <= fit.panelBottom + 1, `the detail ends at ${fit.sideBottom}, below the panel's ${fit.panelBottom}`);
    assert.ok(fit.sideTop >= fit.orbitBottom - 1, 'the detail sits below the orbit, not over it');
    const stripHeight = await page.evaluate(() => document.querySelector('.agents-strip')!.getBoundingClientRect().height);
    assert.ok(stripHeight <= 800 * 0.6 + 2, `the panel takes ${stripHeight}px of an 800px screen; it must leave room for the conversation`);
    await page.evaluate(() => { (document.getElementById('root') as HTMLElement).style.width = '1100px'; });

    // The keyboard moves between agents: from the reviewer, going back toward the centre selects the main agent.
    await page.locator('.orbit').focus();
    await page.keyboard.press('ArrowDown');
    await page.getByRole('region', { name: 'Details for Main agent' }).waitFor();
    assert.match(await page.locator('.agent-detail').innerText(), /Add a retry to the upload step/);

    // Zoom controls and the keyboard change the zoom.
    const zoom = page.locator('.orbit-zoom span');
    const before = await zoom.innerText();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    assert.notEqual(await zoom.innerText(), before);
    await page.locator('.orbit').focus();
    await page.keyboard.press('0');
    assert.equal(await zoom.innerText(), before, '0 fits the view again');

    // Tree and Timeline show the same agents.
    await page.getByRole('tab', { name: 'Tree' }).first().click();
    assert.equal(await page.locator('.agent-tree-row').count(), 3);
    assert.match(await page.locator('.agent-tree').innerText(), /Running npm test|tester/);
    await page.getByRole('tab', { name: 'Timeline' }).click();
    assert.equal(await page.locator('.agent-timeline-row').count(), 2);
    await page.getByRole('tab', { name: 'Graph' }).click();
    await page.getByRole('tab', { name: 'Tree' }).nth(1).click();
    await page.locator('.react-flow__node').nth(2).waitFor();

    // It can be folded away and brought back.
    await page.getByRole('button', { name: 'Hide agents' }).click();
    assert.equal(await page.locator('.orbit, .react-flow__node').count(), 0);
    await page.getByRole('button', { name: 'Show agents' }).click();
    await page.getByRole('tab', { name: 'Orbit' }).waitFor();

    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
