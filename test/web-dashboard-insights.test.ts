/// <reference lib="dom" />
/**
 * The Dashboard page in a real browser (Chromium), with the portal's answers stood in for:
 *   - the success rate leaves out runs the person stopped, and says how many that was;
 *   - "Needs attention" lists the inbox, failed sessions and idle sessions about to close (most urgent first, nothing twice);
 *   - the runs-per-day chart draws;
 *   - the performance table leaves out columns this deployment does not record (percentiles, tool calls);
 *   - the cost panel says "not reported" when runs ran but none reported usage, instead of $0.00.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';

const day = (offset: number): string => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const inMin = (m: number): string => new Date(Date.now() + m * 60_000).toISOString();

const dashboard = {
  period: '7d',
  generatedAt: new Date().toISOString(),
  summary: {
    totalAgents: 2, activeAgents: 0, runningSessions: 0, queuedSessions: 0, completedToday: 3, completedYesterday: 2,
    successRate: 10 / 15, successRatePrev: null, finishedRuns: 20, failedRuns: 5, stoppedRuns: 5,
    dayStartUtc: new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString(),
  },
  daily: [6, 5, 4, 3, 2, 1, 0].map((o, i) => ({ date: day(o), done: i + 1, failed: i % 2, cancelled: 1, avgDurationMs: (i + 1) * 120_000 })),
  idleClosing: [{ id: 'idle1', projectId: 'p1', projectName: 'Alpha', title: 'Idle one', stopAt: inMin(6) }],
  network: { nodes: [], edges: [] },
  agents: [
    { agent: 'default', runs: 10, completed: 7, failed: 3, successRate: 0.7, p50DurationMs: null, p95DurationMs: null, avgDurationMs: 60_000, costUsd: 0, credits: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, toolErrors: 0, lastRunAt: new Date().toISOString() },
    { agent: 'lead-orchestrator', runs: 10, completed: 8, failed: 2, successRate: 0.8, p50DurationMs: null, p95DurationMs: null, avgDurationMs: 90_000, costUsd: 0, credits: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, toolErrors: 0, lastRunAt: new Date().toISOString() },
  ],
  recentSessions: [
    { id: 'f1', projectId: 'p1', projectName: 'Alpha', title: 'The failed one', agent: 'default', status: 'failed', childAgents: [], updatedAt: new Date().toISOString() },
    // Blocked, and already in the inbox below: must not be listed a second time.
    { id: 'w1', projectId: 'p1', projectName: 'Alpha', title: 'Cut-off one', agent: 'default', status: 'blocked', childAgents: [], updatedAt: new Date().toISOString() },
    { id: 'ok1', projectId: 'p1', projectName: 'Alpha', title: 'Fine one', agent: 'default', status: 'done', childAgents: [], updatedAt: new Date().toISOString() },
  ],
  activeSession: null,
};
const inbox = {
  total: 2,
  items: [
    { id: 'i1', type: 'question', project_id: 'p1', project_name: 'Alpha', workflow_id: 'q1', workflow_goal: 'Asks a question', payload: { question: 'Which database?' } },
    { id: 'i2', type: 'blocked', project_id: 'p1', project_name: 'Alpha', workflow_id: 'w1', workflow_goal: 'Cut-off one', payload: { kind: 'turn-interrupted', message: 'The last turn was cut off.' } },
  ],
};
const insights = { totalCost: 0, totalCredits: 0, totalRuns: 20, totalTokens: 0, failureRate: 0, avgRunDuration: 0, dailyCosts: [], costByProject: [], costByUser: [], runsByStatus: [] };

test('the dashboard shows what needs the person, a runs trend, honest numbers and no empty columns', async () => {
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {Dashboard} from './web/src/pages/Dashboard.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css'; import './web/src/styles/dashboard.css';
createRoot(document.getElementById('root')).render(<Dashboard user={{ name: 'Tan', email: 't@x.com', is_admin: true }} projects={[]} />);`;
  const bundled = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, outfile: 'a.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', loader: { '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' } });
  const file = (ext: string) => bundled.outputFiles.find((f) => f.path.endsWith(ext))!;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (u.includes('/api/dashboard')) await route.fulfill({ json: dashboard });
      else if (u.includes('/api/inbox')) await route.fulfill({ json: inbox });
      else if (u.includes('/api/insights')) await route.fulfill({ json: insights });
      else if (u.includes('/api/')) await route.fulfill({ status: 404, json: { error: 'no' } });
      else if (u.endsWith('/a.js')) await route.fulfill({ contentType: 'text/javascript', body: file('.js').text });
      else if (u.endsWith('/a.css')) await route.fulfill({ contentType: 'text/css', body: file('.css').text });
      else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/a.css"></head><body><div id="root"></div><script type="module" src="/a.js"></script></body></html>' });
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://localhost:4173/');

    // Success rate: 10 done, 5 failed, 5 stopped by the person → 10 / 15, not 10 / 20.
    const rate = page.getByRole('article', { name: 'Success Rate' });
    await rate.waitFor();
    const rateText = await rate.innerText();
    assert.match(rateText, /66\.7%/, rateText);
    assert.match(rateText, /5 failed/);
    assert.match(rateText, /5 stopped by you \(not counted\)/);
    const completed = await page.getByRole('article', { name: 'Runs Completed Today' }).innerText();
    assert.match(completed, /Since .* your time \(UTC midnight\)/, completed);

    // Needs attention: 2 inbox + the failed session + the idle one = 4; the blocked session is the inbox item, not a fifth row.
    const attn = page.getByRole('region', { name: 'Needs attention' });
    await attn.getByRole('listitem').first().waitFor();
    const rows = await attn.getByRole('listitem').allInnerTexts();
    assert.equal(rows.length, 4, rows.join(' | '));
    assert.equal(await attn.getByLabel('4 items').count(), 1);
    // Most urgent first: the two "danger" rows (turn cut off, session failed) come before the two "warn" rows.
    assert.match(rows[0] + rows[1], /Turn cut off/i);
    assert.match(rows[0] + rows[1], /Session failed/i);
    assert.match(rows[2] + rows[3], /Question for you/i);
    assert.match(rows[2] + rows[3], /Idle, closing soon/i);
    assert.match(rows[2] + rows[3], /closes in [56] min/);
    assert.equal(await attn.locator('a[href="#/p/p1/sessions/f1"]').count(), 1, 'the failed session links to the session');
    assert.equal(await attn.locator('a[href="#/p/p1/sessions/w1"]').count(), 1, 'the blocked session is listed once (as its inbox item)');

    // The chart draws: 7 days of stacked bars.
    const trend = page.getByRole('region', { name: 'Runs per day' });
    await trend.locator('.recharts-bar-rectangle').first().waitFor();
    assert.ok((await trend.locator('.recharts-bar-rectangle').count()) >= 7);
    assert.match(await trend.innerText(), /UTC days/);

    // Columns this deployment does not record are left out, with a line saying so.
    const perf = page.getByRole('region', { name: 'Agent Performance' });
    // The header text is uppercased by the stylesheet: compare in lower case so a column that is still there cannot be missed.
    const headers = (await perf.getByRole('columnheader').allInnerTexts()).map((h) => h.toLowerCase());
    for (const gone of ['p50', 'p95', 'tool calls', 'errors', 'tokens']) assert.ok(!headers.includes(gone), `${gone} should be left out: ${headers.join(',')}`);
    for (const kept of ['agent', 'runs', 'success %', 'avg dur.']) assert.ok(headers.includes(kept), `${kept} stays: ${headers.join(',')}`);
    assert.match(await perf.innerText(), /Not recorded here, so not shown: p50, p95, Tokens, Tool calls, Errors/);

    // Cost: runs happened, none reported usage → "not reported", never "$0.00 total".
    const cost = page.getByRole('region', { name: 'Cost and usage' });
    await cost.getByRole('status').waitFor();
    const costText = await cost.innerText();
    assert.match(costText, /none reported any cost, credits or tokens/);
    assert.doesNotMatch(costText, /\$0\.00 total/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
