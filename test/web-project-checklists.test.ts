/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

test('project checklist editor saves, regenerates, exports and fits mobile', async () => {
  const { baseUrl } = await createTestServer();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const cookie = (await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'check-ui@example.com', name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie!;
    const project = (await fetchJson(baseUrl, '/api/projects', { cookie, body: { name: 'Checklist UI' } })).body as any;
    const id = project.project.id;
    const endpoint = `/api/projects/${id}/checklists`;
    const bundled = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ProjectChecklists} from './web/src/pages/hub/ProjectChecklists.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css'; createRoot(document.getElementById('root')).render(<ProjectChecklists projectId=${JSON.stringify(id)} canEdit={!location.search.includes('viewer')} />);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, outfile: 'checklist-fixture.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const pair = cookie.split(';')[0]; const eq = pair.indexOf('=');
    await context.addCookies([{ name: pair.slice(0, eq), value: pair.slice(eq + 1), url: baseUrl }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/checklist-fixture*', async (route) => {
      const url = route.request().url();
      if (url.endsWith('.js') || url.endsWith('.css')) {
        const file = bundled.outputFiles.find((f) => f.path.endsWith(url.endsWith('.js') ? '.js' : '.css'))!;
        await route.fulfill({ contentType: url.endsWith('.js') ? 'text/javascript' : 'text/css', body: file.text });
      } else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/checklist-fixture.css"></head><body><div id="root"></div><script src="/checklist-fixture.js"></script></body></html>' });
    });
    await page.goto(`${baseUrl}/checklist-fixture`);
    await page.getByRole('button', { name: 'Add provider / service' }).click();
    assert.deepEqual(errors, []);
    await page.getByLabel('Provider', { exact: true }).selectOption('azure');
    await page.getByLabel('Service / account name').fill('Production Azure');
    await page.getByRole('button', { name: 'Add provider / service' }).click();
    await page.getByLabel('Service / account name').nth(1).fill('External email');
    await page.getByRole('button', { name: 'Add requirement', exact: true }).click();
    await page.getByLabel('Category', { exact: true }).fill('Mail delivery');
    await page.getByLabel('Resource name', { exact: true }).fill('Email service');
    await page.getByLabel('Configuration / review requirement').fill('Verify sender domain');
    await page.getByLabel('Evidence references', { exact: false }).fill('docs/mail.md:4\nhttps://example.com/audit');
    await page.getByLabel('Review status').selectOption('approved');
    await page.getByLabel('Review notes').fill('Verified');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('Checklist saved.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Export JSON' }).count(), 1);
    await page.getByRole('button', { name: 'Generate checklists', exact: true }).click();
    await page.getByText('Checklist regenerated. Saved edits and reviews were preserved.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Review status').inputValue(), 'approved');
    const saved = (await fetchJson(baseUrl, endpoint, { cookie })).body as any;
    assert.equal(saved.checklist.targets.length, 2);
    assert.equal(saved.checklist.items[0].requirement, 'Verify sender domain');
    assert.deepEqual(saved.checklist.items[0].evidence, ['docs/mail.md:4', 'https://example.com/audit']);
    await page.getByLabel('Review notes').fill('Updated review');
    assert.equal(await page.getByRole('link', { name: 'Export JSON' }).count(), 0, 'exports require saved edits');
    await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
    await page.getByText('Checklist regenerated. Saved edits and reviews were preserved.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Review notes').inputValue(), 'Updated review');
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > innerWidth + 2).map((el) => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width })).slice(0, 12) }));
    assert.ok(overflow.scroll <= overflow.width + 2, `mobile must not overflow: ${JSON.stringify(overflow)}`);
    await page.goto(`${baseUrl}/checklist-fixture?viewer`);
    await page.getByLabel('Review notes').waitFor();
    assert.equal(await page.getByLabel('Review notes').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Regenerate', exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Export Markdown' }).count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await cleanup();
  }
});
