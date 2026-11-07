/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { stopLocalAutomationTimers } from '../server/automations/engine.ts';

test('visual workflow editor saves, publishes, keeps published content, and fits mobile', async () => {
  const { baseUrl } = await createTestServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const setup = await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'workflow-ui@example.com', name: 'Admin', password: 'password1234', provider: 'demo' } });
    const cookie = setup.cookie!;
    const created = await fetchJson(baseUrl, '/api/projects', { cookie, body: { name: 'Workflow UI' } });
    const projectId = (created.body as any).project.id;
    // Build this component in memory so backend CI needs no prebuilt dist/web,
    // and parallel test files never replace the application's assets.
    const bundled = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Automations from './web/src/pages/Automations.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css'; createRoot(document.getElementById('root')).render(<Automations projectId=${JSON.stringify(projectId)} />);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, outfile: 'workflow-fixture.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const pair = cookie.split(';')[0]; const eq = pair.indexOf('=');
    await context.addCookies([{ name: pair.slice(0, eq), value: pair.slice(eq + 1), url: baseUrl }]);
    const page = await context.newPage(); const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/workflow-fixture*', async (route) => {
      const url = route.request().url();
      if (url.endsWith('.js') || url.endsWith('.css')) {
        const file = bundled.outputFiles.find((f) => f.path.endsWith(url.endsWith('.js') ? '.js' : '.css'))!;
        await route.fulfill({ contentType: url.endsWith('.js') ? 'text/javascript' : 'text/css', body: file.text });
      } else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/workflow-fixture.css"></head><body><div id="root"></div><script src="/workflow-fixture.js"></script></body></html>' });
    });
    await page.goto(`${baseUrl}/workflow-fixture`);
    await page.getByRole('button', { name: 'New workflow' }).click();
    await page.locator('.automation-canvas .react-flow__node').first().waitFor();
    assert.equal(await page.locator('.automation-canvas .react-flow__node').count(), 10);
    await page.getByText('Generate code', { exact: true }).click();
    await page.locator('.automation-inspector').getByLabel('Name', { exact: true }).fill('Implement feature');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByText('Draft saved.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Publish version', exact: true }).click();
    await page.getByText(/Published version 2/).waitFor();
    const list = await fetchJson(baseUrl, `/api/projects/${projectId}/automations`, { cookie });
    const definition = (list.body as any).definitions[0];
    const old = await fetchJson(baseUrl, `/api/projects/${projectId}/automations/${definition.id}/versions`, { cookie });
    assert.equal((old.body as any).versions[0].graph.nodes.find((n: any) => n.id === 'code').label, 'Implement feature');
    await page.locator('.automation-inspector').getByLabel('Name', { exact: true }).fill('Next draft');
    assert.equal(await page.getByRole('button', { name: 'Run published workflow' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByText('Draft saved.', { exact: true }).waitFor();
    const unchanged = await fetchJson(baseUrl, `/api/projects/${projectId}/automations/${definition.id}/versions`, { cookie });
    assert.equal((unchanged.body as any).versions[0].graph.nodes.find((n: any) => n.id === 'code').label, 'Implement feature');
    if (process.env.WORKFLOW_SCREENSHOT) await page.screenshot({ path: process.env.WORKFLOW_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.automation-inspector').getByLabel('Name', { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'mobile page should not overflow horizontally');
    // A step can be removed with the button in its settings, together with its connections.
    const nodesBefore = await page.locator('.automation-canvas .react-flow__node').count();
    const edgesBefore = await page.locator('.automation-canvas .react-flow__edge').count();
    await page.getByText('Run tests', { exact: true }).click();
    await page.getByRole('button', { name: 'Delete step' }).click();
    assert.equal(await page.locator('.automation-canvas .react-flow__node').count(), nodesBefore - 1);
    assert.ok((await page.locator('.automation-canvas .react-flow__edge').count()) < edgesBefore, 'its connections go too');
    assert.equal(await page.getByRole('button', { name: 'Delete step' }).count(), 0, 'nothing is selected afterwards');
    // Choosing a template shows it on the canvas first; nothing is created until Create.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByText('Draft saved.', { exact: true }).waitFor();
    const before = ((await fetchJson(baseUrl, `/api/projects/${projectId}/automations`, { cookie })).body as any).definitions.length;
    await page.getByLabel('Template', { exact: true }).selectOption('development');
    await page.getByLabel('Template preview: Development (Jira ticket to reviewed PR)').waitFor();
    await page.locator('.automation-canvas[aria-label="Template canvas"] .react-flow__node').first().waitFor();
    assert.equal(await page.locator('.automation-canvas[aria-label="Template canvas"] .react-flow__node').count(), 12);
    await page.locator('.automation-canvas[aria-label="Template canvas"]').getByText('Read Jira ticket', { exact: true }).click();
    await page.locator('.automation-inspector').getByText(/Jira ticket is/).waitFor();
    assert.equal(((await fetchJson(baseUrl, `/api/projects/${projectId}/automations`, { cookie })).body as any).definitions.length, before, 'previewing creates nothing');
    await page.getByRole('button', { name: 'Close preview' }).click();
    await page.getByLabel('Template preview: Development (Jira ticket to reviewed PR)').waitFor({ state: 'detached' });
    await page.getByLabel('Template', { exact: true }).selectOption('testing');
    await page.getByLabel('Template preview: Testing (verify a ticket)').waitFor();
    await page.getByRole('button', { name: /^Create workflow/ }).click();
    await page.locator('.automation-canvas[aria-label="Workflow canvas"] .react-flow__node').first().waitFor();
    assert.equal(await page.locator('.automation-canvas[aria-label="Workflow canvas"] .react-flow__node').count(), 7, 'the testing template opened as an editable workflow');
    assert.equal(((await fetchJson(baseUrl, `/api/projects/${projectId}/automations`, { cookie })).body as any).definitions.length, before + 1);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); stopLocalAutomationTimers(); await cleanup(); }
});
