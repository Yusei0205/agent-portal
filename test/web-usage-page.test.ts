/// <reference lib="dom" />
/**
 * The Usage page in a real browser (Chromium), with the portal's answers stood in for:
 *   - one card per engine, each in its own unit (Claude dollars, Kiro credits, Codex tokens), never added into one figure;
 *   - a breakdown with People / Projects / Days tabs, ranked by the engine you pick, a dash where an engine has nothing;
 *   - the period and project asked for, a plain note when runs finished but none reported usage, no People tab for a member;
 *   - every amount under its own header, and one font in every cell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';

type T = { runs: number; costUsd: number; credits: number; tokens: number };
const z = (): T => ({ runs: 0, costUsd: 0, credits: 0, tokens: 0 });
/** A row from what each engine used: claude [runs, dollars, tokens], kiro [runs, credits], codex [runs, tokens], other [runs, tokens]. */
const row = (id: string, name: string, u: { claude?: [number, number, number]; kiro?: [number, number]; codex?: [number, number]; other?: [number, number] }) => {
  const engines = { claude: z(), kiro: z(), codex: z(), other: z() };
  if (u.claude) engines.claude = { runs: u.claude[0], costUsd: u.claude[1], credits: 0, tokens: u.claude[2] };
  if (u.kiro) engines.kiro = { runs: u.kiro[0], costUsd: 0, credits: u.kiro[1], tokens: 0 };
  if (u.codex) engines.codex = { runs: u.codex[0], costUsd: 0, credits: 0, tokens: u.codex[1] };
  if (u.other) engines.other = { runs: u.other[0], costUsd: 0, credits: 0, tokens: u.other[1] };
  const total = z();
  for (const e of Object.values(engines)) { total.runs += e.runs; total.costUsd += e.costUsd; total.credits += e.credits; total.tokens += e.tokens; }
  return { id, name, ...total, engines };
};
const day = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const ann = row('u1', 'ann@x.com', { claude: [3, 2, 1700] });
const bob = row('u2', 'bob@x.com', { kiro: [2, 14.25], codex: [1, 40_150_000] });
const full = {
  period: '30d', finishedRuns: 9,
  totals: row('total', 'Total', { claude: [3, 2, 1700], kiro: [2, 14.25], codex: [1, 40_150_000] }),
  byUser: [ann, bob],
  byProject: [row('p1', 'Alpha', { claude: [3, 2, 1700], kiro: [1, 10.25] }), row('p2', 'Beta', { kiro: [1, 4], codex: [1, 40_150_000] })],
  byDay: [
    row(day(3), day(3), {}),
    row(day(2), day(2), { kiro: [1, 4] }),
    row(day(1), day(1), { kiro: [1, 10.25], codex: [1, 40_150_000] }),
    row(day(0), day(0), { claude: [3, 2, 1700] }),
  ],
};
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

test('the usage page: one card per engine in its own unit, a ranked breakdown by person, project and day, aligned amounts', async () => {
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

    // ── One card per engine, each in its own unit.
    const claude = page.getByRole('article', { name: 'Claude usage' });
    await claude.waitFor();
    assert.match(norm(await claude.innerText()), /Claude dollars \$2\.00 3 runs · 1\.7K tokens/i);
    assert.match(norm(await page.getByRole('article', { name: 'Kiro usage' }).innerText()), /Kiro credits 14\.25 2 runs/i);
    const codex = norm(await page.getByRole('article', { name: 'Codex usage' }).innerText());
    assert.match(codex, /Codex tokens 40\.15M 1 run/i);
    assert.doesNotMatch(codex, /\$/, 'Codex reports tokens only: no dollars on its card');
    assert.equal(await page.getByRole('article', { name: 'Other usage' }).count(), 0, 'no card for an engine nothing used');
    assert.deepEqual(asked, ['?period=30d'], 'the first load asks for 30 days and all projects');
    // The daily bars: one per day, the busiest day full height, the others by comparison.
    const bars = page.getByRole('img', { name: /Kiro credits per day, last 4 days/ });
    assert.equal(await bars.locator('rect').count(), 4);
    const heights = await bars.locator('rect').evaluateAll((els) => els.map((e) => Number(e.getAttribute('height'))));
    assert.deepEqual(heights.map((h) => Math.round(h)), [0, 12, 30, 0], "bars scale to the engine's own busiest day: 4 and 10.25 credits");

    // ── The breakdown: People first (the portal sent a person table), ranked by the engine with the most runs (Claude).
    const tabs = page.getByRole('tablist', { name: 'Break usage down by' });
    assert.deepEqual((await tabs.getByRole('tab').allInnerTexts()).map(norm), ['People', 'Projects', 'Days']);
    assert.equal(await tabs.getByRole('tab', { name: 'People' }).getAttribute('aria-selected'), 'true');
    const table = page.getByRole('table', { name: 'Usage by person' });
    assert.deepEqual((await table.getByRole('columnheader').allInnerTexts()).map((h) => norm(h).toLowerCase()),
      ['person', 'runs', 'claude dollars', 'kiro credits', 'codex tokens']);
    const people = async () => (await table.locator('tbody tr').allInnerTexts()).map(norm);
    assert.deepEqual(await people(), ['ann@x.com 3 $2.00 – –', 'bob@x.com 3 – 14.25 40.15M'], 'a dash, not 0.00, where an engine has nothing');
    // Rank by Kiro: bob first; back to Claude: ann first.
    await page.getByRole('button', { name: /^Kiro credits$/ }).click();
    assert.equal(await page.getByRole('button', { name: /^Kiro credits$/ }).getAttribute('aria-pressed'), 'true');
    assert.deepEqual((await people()).map((r) => r.split(' ')[0]), ['bob@x.com', 'ann@x.com']);
    assert.equal(await table.locator('.us-share').count(), 1, 'a share bar only where the ranked engine has something');
    await page.getByRole('button', { name: /^Claude dollars$/ }).click();
    assert.deepEqual((await people()).map((r) => r.split(' ')[0]), ['ann@x.com', 'bob@x.com']);

    // ── Projects, and Days (newest first, a quiet day included, no ranking).
    await tabs.getByRole('tab', { name: 'Projects' }).click();
    const projectRows = (await page.getByRole('table', { name: 'Usage by project' }).locator('tbody tr').allInnerTexts()).map(norm);
    assert.deepEqual(projectRows, ['Alpha 4 $2.00 10.25 –', 'Beta 2 – 4.00 40.15M']);
    await tabs.getByRole('tab', { name: 'Days' }).click();
    assert.equal(await page.getByRole('group', { name: 'Rank by' }).count(), 0, 'days are in date order: nothing to rank');
    const dayRows = (await page.getByRole('table', { name: /Usage by day/ }).locator('tbody tr').allInnerTexts()).map(norm);
    assert.deepEqual(dayRows.map((r) => r.split(' ')[0]), [day(0), day(1), day(2), day(3)]);
    assert.equal(dayRows[3], `${day(3)} 0 – – –`, 'a quiet day is listed, with dashes');

    // ── Every amount sits under its own header, in every tab; one font in every cell (quiet days too).
    for (const name of ['People', 'Projects', 'Days']) {
      await tabs.getByRole('tab', { name }).click();
      // (Plain JavaScript as a string: the page has no helpers the transpiler would add.)
      const misaligned = await page.evaluate(`(() => {
        const bad = [];
        const edge = (r, s) => r.right - parseFloat(s.paddingRight);
        const table = document.querySelector('table.us-table');
        const heads = Array.from(table.querySelectorAll('thead th'));
        const cells = Array.from(table.querySelectorAll('tbody tr:first-child td'));
        heads.forEach((th, i) => {
          if (i === 0) return;
          const h = th.getBoundingClientRect(), c = cells[i].getBoundingClientRect();
          const hs = getComputedStyle(th), cs = getComputedStyle(cells[i]);
          if (hs.textAlign !== 'right' || cs.textAlign !== 'right' || Math.abs(edge(h, hs) - edge(c, cs)) > 1) {
            bad.push(th.textContent + ': header ' + hs.textAlign + ' ' + edge(h, hs).toFixed(1) + ', amount ' + cs.textAlign + ' ' + edge(c, cs).toFixed(1));
          }
        });
        return bad;
      })()`) as string[];
      assert.deepEqual(misaligned, [], `${name}: headers and amounts line up`);
      const fonts = await page.evaluate(`Array.from(document.querySelectorAll('table.us-table tbody td')).map((td) => getComputedStyle(td).fontFamily)`) as string[];
      assert.equal(new Set(fonts).size, 1, `${name}: one font in every table cell: ${[...new Set(fonts)].join(' | ')}`);
    }

    // ── The period and the project are sent to the portal.
    await page.getByRole('button', { name: '7 days' }).click();
    await page.waitForFunction(() => document.querySelector('[aria-pressed="true"]')?.textContent === '7 days');
    assert.equal(asked.at(-1), '?period=7d');
    await page.getByRole('combobox', { name: 'Filter by project' }).selectOption('p1');
    await page.waitForTimeout(150);
    assert.equal(asked.at(-1), '?period=7d&projectId=p1');

    // ── Another provider's usage gets a card of its own; Claude, Kiro and Codex stay.
    answer = { ...full, totals: row('total', 'Total', { claude: [3, 2, 1700], other: [2, 900] }) };
    await page.getByRole('button', { name: 'Refresh usage' }).click();
    await page.getByRole('article', { name: 'Other usage' }).waitFor();
    assert.match(norm(await page.getByRole('article', { name: 'Other usage' }).innerText()), /Other tokens 900 2 runs/i);

    // ── Runs finished, none reported usage: said plainly.
    answer = { period: '7d', finishedRuns: 5, totals: row('total', 'Total', {}), byUser: [], byProject: [], byDay: [row(day(0), day(0), {})] };
    await page.getByRole('button', { name: 'Refresh usage' }).click();
    await page.getByRole('status').waitFor();
    assert.match(await page.getByRole('status').innerText(), /5 runs finished in this period, but none reported any usage/);
    assert.match(norm(await page.getByRole('article', { name: 'Kiro usage' }).innerText()), /No usage in this period/);

    // ── A member's answer has no person table, so no People tab; Projects is the first.
    answer = { ...full, byUser: null };
    await page.getByRole('button', { name: 'Refresh usage' }).click();
    await page.getByRole('tab', { name: 'People' }).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('tab', { name: 'People' }).count(), 0);
    assert.deepEqual((await page.getByRole('tablist', { name: 'Break usage down by' }).getByRole('tab').allInnerTexts()).map(norm), ['Projects', 'Days'], 'Projects comes first for a member');
    assert.equal(await page.getByRole('tab', { name: 'Days' }).getAttribute('aria-selected'), 'true', 'the tab you were on stays');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
