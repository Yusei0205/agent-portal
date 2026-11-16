/// <reference lib="dom" />
/**
 * The Usage page in a real browser (Chromium), with the portal's answers stood in for: dollars (Claude) and credits (Kiro) side by side
 * and never added, the person table only when the portal sends one, the period and project asked for, and a plain explanation when runs
 * finished but none reported usage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';

const row = (id: string, name: string, runs: number, costUsd: number, credits: number, tokens: number) => ({ id, name, runs, costUsd, credits, tokens });
const day = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const full = {
  period: '30d', totals: { runs: 4, costUsd: 2, credits: 14.25, tokens: 1700 }, finishedRuns: 9,
  byUser: [row('u1', 'ann@x.com', 3, 2, 4, 1700), row('u2', 'bob@x.com', 1, 0, 10.25, 0)],
  byUserAllProjects: false,
  byProject: [row('p1', 'Alpha', 3, 2, 10.25, 1700), row('p2', 'Beta', 1, 0, 4, 0)],
  byDay: [row(day(2), day(2), 1, 0, 4, 0), row(day(1), day(1), 1, 0, 10.25, 0), row(day(0), day(0), 2, 2, 0, 1700)],
};

test('the usage page shows dollars and credits apart, by person, project and day, and says so when nothing was reported', async () => {
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {Usage} from './web/src/pages/Usage.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css'; import './web/src/styles/dashboard.css';
createRoot(document.getElementById('root')).render(<Usage projects={[{ id: 'p1', name: 'Alpha' }]} />);`;
  const bundled = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, outfile: 'a.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', loader: { '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' } });
  const file = (ext: string) => bundled.outputFiles.find((f) => f.path.endsWith(ext))!;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    let answer: Record<string, unknown> = full;
    const asked: string[] = [];
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (u.includes('/api/usage')) { asked.push(new URL(u).search); await route.fulfill({ json: answer }); }
      else if (u.includes('/api/')) await route.fulfill({ status: 404, json: { error: 'no' } });
      else if (u.endsWith('/a.js')) await route.fulfill({ contentType: 'text/javascript', body: file('.js').text });
      else if (u.endsWith('/a.css')) await route.fulfill({ contentType: 'text/css', body: file('.css').text });
      else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/a.css"></head><body><div id="root"></div><script type="module" src="/a.js"></script></body></html>' });
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://localhost:4173/');

    // Totals: dollars and credits are their own figures, never one number.
    const totals = page.getByRole('group', { name: 'Totals' });
    await totals.waitFor();
    const t = await totals.innerText();
    assert.match(t, /Runs\s*4/);
    assert.match(t, /Claude cost\s*\$2\.00/);
    assert.match(t, /Kiro credits\s*14\.25/);
    assert.match(t, /Tokens\s*1\.7K/);
    assert.deepEqual(asked, ['?period=30d'], 'the first load asks for 30 days and all projects');

    // By person (shown because the portal sent it), by project, by day newest first.
    const person = page.getByRole('region', { name: 'By person' });
    const personHeaders = (await person.getByRole('columnheader').allInnerTexts()).map((h) => h.toLowerCase());
    assert.deepEqual(personHeaders, ['person', 'runs', 'cost (claude)', 'credits (kiro)', 'tokens']);
    const ann = await person.getByRole('row', { name: /ann@x\.com/ }).innerText();
    assert.match(ann, /ann@x\.com\s+3\s+\$2\.00\s+4\.00\s+1\.7K/);
    assert.match(await person.getByRole('row', { name: /bob@x\.com/ }).innerText(), /bob@x\.com\s+1\s+\$0\.00\s+10\.25\s+0/);
    assert.match(await page.getByRole('region', { name: 'By project' }).getByRole('row', { name: /Beta/ }).innerText(), /Beta\s+1\s+\$0\.00\s+4\.00/);
    const days = await page.getByRole('region', { name: 'By day' }).getByRole('row').allInnerTexts();
    assert.match(days[1], new RegExp(day(0)), 'newest day first');
    assert.match(days[3], new RegExp(day(2)));
    assert.equal(await page.getByRole('status').count(), 0, 'usage was reported: no "none reported" line');

    // A project and a period are sent to the portal; per-person totals that are for all projects say so.
    answer = { ...full, byUserAllProjects: true };
    await page.getByRole('combobox', { name: 'Filter by project' }).selectOption('p1');
    await person.getByText(/all projects: per-person totals are not kept per project/).waitFor();
    assert.equal(asked.at(-1), '?period=30d&projectId=p1');
    await page.getByRole('combobox', { name: 'Period' }).selectOption('7d');
    await page.waitForFunction(() => document.querySelector('[aria-label="Period"]') !== null);
    await page.waitForTimeout(100);
    assert.equal(asked.at(-1), '?period=7d&projectId=p1');

    // Runs finished, none reported usage: said plainly, not left as a wall of zeros.
    answer = { period: '7d', totals: { runs: 0, costUsd: 0, credits: 0, tokens: 0 }, finishedRuns: 5, byUser: [], byUserAllProjects: false, byProject: [], byDay: [row(day(0), day(0), 0, 0, 0, 0)] };
    await page.getByRole('button', { name: 'Refresh usage' }).click();
    await page.getByRole('status').waitFor();
    assert.match(await page.getByRole('status').innerText(), /5 runs finished in this period, but none reported any usage/);

    // A member's answer has no per-person table at all.
    answer = { ...full, byUser: null };
    await page.getByRole('button', { name: 'Refresh usage' }).click();
    await page.getByRole('region', { name: 'By project' }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="By person"]'));
    assert.equal(await page.getByRole('region', { name: 'By person' }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
