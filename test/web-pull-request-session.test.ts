/// <reference lib="dom" />
/**
 * The session shows the pending "open a pull request?" question with answer buttons (the same answer as in the Inbox), and an old
 * declined card does not stay behind once a newer question exists. Real page in Chromium; the server's answers are stood in for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';

test('the session answers the pull request question itself', async () => {
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {PullRequestCards} from './web/src/pages/sessions/PullRequestCard.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css';
const base = { type: 'pull-request', repo: 'rhb.backend.shared', repoId: 'r1', base: 'main', files: 1, commits: 0 };
const events = [{ ...base, state: 'asked', inboxId: 'old' }, { ...base, state: 'declined' }, { ...base, state: 'asked', inboxId: 'inbox1' }];
createRoot(document.getElementById('root')).render(<PullRequestCards events={events} workflowId="w1" projectId="p1" />);`;
  const bundled = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, outfile: 'pr.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    loader: { '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
  });
  const file = (ext: string) => bundled.outputFiles.find((f) => f.path.endsWith(ext))!;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const posts: Array<{ url: string; body: unknown }> = [];
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = req.url();
      if (req.method() === 'POST') { posts.push({ url: new URL(u).pathname, body: JSON.parse(req.postData() || '{}') }); await route.fulfill({ json: { ok: true } }); }
      else if (u.endsWith('/pr.js')) await route.fulfill({ contentType: 'text/javascript', body: file('.js').text });
      else if (u.endsWith('/pr.css')) await route.fulfill({ contentType: 'text/css', body: file('.css').text });
      else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/pr.css"></head><body><div id="root"></div><script type="module" src="/pr.js"></script></body></html>' });
    });
    await page.goto('http://portal.test/');

    // One card for the repository, and it is the pending question, not the older declined one.
    await page.getByRole('region', { name: /Pull request: rhb.backend.shared/ }).waitFor();
    assert.equal(await page.getByRole('region').count(), 1);
    await page.getByText('Open a pull request for rhb.backend.shared?').waitFor();
    assert.equal(await page.getByText(/declined or dismissed/).count(), 0);

    await page.getByRole('button', { name: 'Not now' }).click();
    await page.waitForFunction(() => true);
    await page.getByRole('button', { name: 'Open pull request' }).click();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(posts, [
      { url: '/api/inbox/inbox1/resolve', body: { response: 'decline' } },
      { url: '/api/inbox/inbox1/resolve', body: { response: 'approve' } },
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
