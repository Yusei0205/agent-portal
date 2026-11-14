/// <reference lib="dom" />
/**
 * While a user guide is being written the row offers "Watch browser"; it opens the agent's cloud browser, and when the agent is waiting for
 * the person to sign in the page says so and how to hand the browser back. The server's answers are stood in for; the page is the real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

test('Watch browser opens the live browser and tells the person when the agent is waiting for them to sign in', async () => {
  const { baseUrl } = await createTestServer();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const cookie = (await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'guide-watch@example.com', name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie!;
    const project = (await fetchJson(baseUrl, '/api/projects', { cookie, body: { name: 'Guide watch' } })).body as any;
    const id = project.project.id as string;

    const bundled = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {GeneratedDocs} from './web/src/pages/GeneratedDocs.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css'; import './web/src/styles/ide.css'; createRoot(document.getElementById('root')).render(<GeneratedDocs projectId=${JSON.stringify(id)} />);`,
        resolveDir: process.cwd(), loader: 'jsx',
      },
      bundle: true, write: false, outfile: 'guide-fixture.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
      // The AgentCore Live View component (reached through the Watch browser panel) imports the NICE DCV client by bare name, as scripts/build.mjs resolves it.
      alias: { dcv: path.join(process.cwd(), 'web/vendor/agentcore-live-view/nice-dcv-web-client-sdk/dcvjs-esm/dcv.js'), 'dcv-ui': path.join(process.cwd(), 'web/vendor/agentcore-live-view/nice-dcv-web-client-sdk/dcv-ui/dcv-ui.js') },
      loader: { '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
    const pair = cookie.split(';')[0]; const eq = pair.indexOf('=');
    await context.addCookies([{ name: pair.slice(0, eq), value: pair.slice(eq + 1), url: baseUrl }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/guide-fixture*', async (route) => {
      const url = route.request().url();
      if (url.endsWith('.js') || url.endsWith('.css')) {
        const file = bundled.outputFiles.find((f) => f.path.endsWith(url.endsWith('.js') ? '.js' : '.css'))!;
        await route.fulfill({ contentType: url.endsWith('.js') ? 'text/javascript' : 'text/css', body: file.text });
      } else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/guide-fixture.css"></head><body><div id="root"></div><script src="/guide-fixture.js"></script></body></html>' });
    });
    let waiting: { message: string } | null = null;
    const controlCalls: unknown[] = [];
    await page.route('**/api/realtime/config', (route) => route.fulfill({ json: { enabled: true, httpDomain: 'appsync.invalid', realtimeDomain: 'appsync.invalid', token: 't', expiresIn: 3600 } }));
    await page.route(`**/api/projects/${id}/generated-docs`, (route) => route.fulfill({ json: { docs: [{
      id: 'd1', name: 'Clerk guide', doc_type: 'user-guide', status: 'generating', workflow_id: 'w_fake', created_at: '2026-11-14T10:00:00Z',
      sources: { guide: { screenshots: true, url: 'https://app.example.com/', roles: [], hosts: ['app.example.com'], manualSignIn: true } }, latest_version: null, attachments: [],
    }] } }));
    await page.route('**/api/workflows/w_fake/browser/live-view', (route) => route.fulfill({ json: { available: true, url: 'https://live.invalid/stream', sessionId: 's1', width: 1280, height: 800, waiting } }));
    await page.route('**/api/workflows/w_fake/browser/live-view/control', async (route) => { controlCalls.push(JSON.parse(route.request().postData() || '{}')); await route.fulfill({ json: { ok: true } }); });
    const closeCalls: string[] = [];
    await page.route('**/api/workflows/w_fake/browser/close', async (route) => { closeCalls.push(route.request().method()); await route.fulfill({ json: { ok: true, closed: true } }); });
    await page.route('**/api/workflows/w_fake/browser', (route) => route.fulfill({ json: {} }));
    await page.goto(`${baseUrl}/guide-fixture`);

    // A guide that is not being written has no button; this one is generating and has one.
    await page.getByRole('button', { name: 'Watch browser' }).click();
    await page.getByRole('heading', { name: /Browser for Clerk guide/ }).waitFor();
    assert.equal(await page.getByTestId('browser-waiting').count(), 0, 'no banner while the agent is not waiting');

    // The agent starts waiting: the banner tells the person what to do.
    waiting = { message: 'Sign in as an administrator' };
    await page.getByTestId('browser-waiting').waitFor({ timeout: 15_000 });
    const text = (await page.getByTestId('browser-waiting').innerText()).replace(/\s+/g, ' ');
    assert.match(text, /The agent is waiting for you\. Sign in as an administrator/);
    assert.match(text, /Switch on Remote control/);

    // The person switches Remote control on: the page asks the portal to pause the agent, and the banner changes to how to hand back.
    await page.getByLabel(/enable remote control/i).first().click();
    await page.getByText(/switch Remote control off to hand the browser back/).waitFor();
    assert.deepEqual(controlCalls, [{ enabled: true }]);
    assert.deepEqual(errors.filter((e) => !/live\.invalid|appsync|WebSocket|dcv/i.test(e)), []);
    // The browser stays open between turns; the person can close it.
    await page.getByRole('button', { name: 'Close browser' }).click();
    await page.getByRole('button', { name: 'Close browser' }).waitFor({ state: 'detached', timeout: 10_000 });
    assert.deepEqual(closeCalls, ['POST']);
    if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/watch-browser-waiting.png' });
  } finally {
    await browser?.close();
    await cleanup();
  }
});
