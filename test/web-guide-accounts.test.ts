/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

test('a user guide can capture screenshots: the form takes the address and test accounts, and accounts are managed and imported without showing a password', async () => {
  const { baseUrl } = await createTestServer();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const cookie = (await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'guide-ui@example.com', name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie!;
    const project = (await fetchJson(baseUrl, '/api/projects', { cookie, body: { name: 'Guide UI' } })).body as any;
    const id = project.project.id as string;
    await fetchJson(baseUrl, `/api/projects/${id}/guide-accounts`, { method: 'PUT', cookie, body: { accounts: [{ role: 'Admin', username: 'admin@t.example', password: 'S3cret-Admin!' }] } });

    const bundled = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {GeneratedDocs} from './web/src/pages/GeneratedDocs.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css'; createRoot(document.getElementById('root')).render(<GeneratedDocs projectId=${JSON.stringify(id)} />);`,
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
    page.on('pageerror', (error) => { errors.push(error.message); console.log('PAGEERROR', error.message); });
    page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
    await page.route('**/guide-fixture*', async (route) => {
      const url = route.request().url();
      if (url.endsWith('.js') || url.endsWith('.css')) {
        const file = bundled.outputFiles.find((f) => f.path.endsWith(url.endsWith('.js') ? '.js' : '.css'))!;
        await route.fulfill({ contentType: url.endsWith('.js') ? 'text/javascript' : 'text/css', body: file.text });
      } else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/guide-fixture.css"></head><body><div id="root"></div><script src="/guide-fixture.js"></script></body></html>' });
    });
    await page.goto(`${baseUrl}/guide-fixture`);
    const shots = process.env.SHOT_DIR;

    // The screenshot options appear only for the user guide type.
    await page.getByRole('button', { name: 'New document' }).first().click();
    await page.getByLabel('Name', { exact: false }).first().fill('Clerk guide');
    assert.equal(await page.getByText('Screenshots from the running system').count(), 0);
    await page.getByLabel('Document type').selectOption('user-guide');
    await page.getByText('Open the system in the cloud browser').click();
    assert.ok(await page.getByLabel('Address of the system').isVisible());
    await page.getByLabel('Address of the system').fill('https://93.184.216.34/app');
    await page.getByLabel(/Admin/).check();
    if (shots) await page.screenshot({ path: path.join(shots, 'new-document.png') });

    // Manage the accounts: add one, never see the stored password, import a CSV.
    await page.getByRole('button', { name: 'Manage test accounts…' }).click();
    assert.equal(await page.getByLabel('Password').first().getAttribute('placeholder'), 'unchanged');
    assert.equal(await page.getByLabel('Password').first().inputValue(), '', 'a stored password is never sent to the page');
    await page.getByRole('button', { name: 'Add account' }).click();
    await page.getByLabel('Role').nth(1).fill('Clerk');
    await page.getByLabel('Username').nth(1).fill('clerk@t.example');
    await page.getByLabel('Password').nth(1).fill('Clerk-Pw-1');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved.').waitFor();
    await page.locator('#ga-csv').setInputFiles({ name: 'accounts.csv', mimeType: 'text/csv', buffer: Buffer.from('role,username,password\nCustomer,cust@t.example,Cust-Pw\n,missing@t.example,x\n') });
    await page.getByText(/Imported: 1 added, 0 updated, 1 row skipped/).waitFor();
    await page.getByText('Line 3: Needs a role, a username and a password.').waitFor();
    assert.equal(await page.getByLabel('Role').count(), 3);
    if (shots) await page.screenshot({ path: path.join(shots, 'test-accounts.png') });
    const stored = ((await fetchJson(baseUrl, `/api/projects/${id}/guide-accounts`, { cookie })).body as any).accounts.map((a: any) => a.role);
    assert.deepEqual(stored, ['Admin', 'Clerk', 'Customer']);
    await page.getByRole('button', { name: 'Done' }).click();

    // The new accounts are offered; submit sends the options, with roles and no password.
    await page.getByLabel(/Clerk/).check();
    await page.getByLabel('I will sign in myself in the live browser').check();
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/projects/${id}/generated-docs`)),
      page.getByRole('button', { name: 'Create', exact: true }).click(),
    ]);
    const body = JSON.parse(request.postData() || '{}');
    assert.deepEqual(body.guide, { screenshots: true, url: 'https://93.184.216.34/app', roles: ['Admin', 'Clerk'], hosts: [], manualSignIn: true });
    assert.doesNotMatch(request.postData() || '', /S3cret|Clerk-Pw-1/);
    await page.getByText('Clerk guide').first().waitFor();
    await page.getByRole('link', { name: 'Download ZIP' }).count();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await cleanup();
    if (process.env.SHOT_DIR) fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
  }
});
