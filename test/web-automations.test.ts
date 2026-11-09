/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { stopLocalAutomationTimers } from '../server/automations/engine.ts';
import { setCallTextModelOverride } from '../server/testing/model-provider.ts';

/** Chooses a template in the Template dropdown by its visible name. */
async function pickTemplate(page: import('playwright').Page, name: RegExp): Promise<void> {
  const select = page.getByRole('combobox', { name: 'Template' });
  const label = await select.evaluate((el, src) => {
    const re = new RegExp(src);
    return Array.from((el as HTMLSelectElement).options).find((o) => re.test(o.text))?.text ?? '';
  }, name.source);
  await select.selectOption({ label });
}

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
    const canvas = '.automation-canvas[aria-label="Workflow canvas"] .react-flow__node';
    const preview = '.automation-canvas[aria-label="Template canvas"] .react-flow__node';
    const definitionsCount = async () => ((await fetchJson(baseUrl, `/api/projects/${projectId}/automations`, { cookie })).body as any).definitions.length;

    // An empty project starts on the list with a clear way to begin.
    await page.getByText('No workflows yet').waitFor();
    await page.getByRole('button', { name: 'New workflow' }).first().click();

    // New workflow: pick a template card, see it on a canvas, name it, create it. Nothing exists before Create.
    await page.getByRole('combobox', { name: 'Template' }).waitFor();
    await page.locator(preview).first().waitFor();
    assert.equal(await page.locator(preview).count(), 10, 'the SDLC template is drawn');
    assert.equal(await definitionsCount(), 0, 'looking creates nothing');
    await page.getByRole('button', { name: 'Create workflow' }).click();
    await page.locator(canvas).first().waitFor();
    assert.equal(await page.locator(canvas).count(), 10);

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
    await page.getByRole('tab', { name: /^Runs/ }).click();
    assert.equal(await page.getByRole('button', { name: 'Run published workflow' }).isDisabled(), true, 'runs use the published version, so unsaved edits block it');
    // The person can choose the agent, model, tool trust and integrations for this run; the summary says what is set.
    await page.locator('summary', { hasText: 'Run options' }).click();
    await page.getByRole('combobox', { name: /^Agent/ }).waitFor();
    assert.equal(await page.getByRole('radio', { name: /Ask me before tools run/ }).isChecked(), true, 'asking first is the default');
    await page.getByRole('radio', { name: /Trust all tools/ }).check();
    await page.locator('summary', { hasText: 'Run options' }).getByText(/tools trusted/).waitFor();
    await page.getByRole('tab', { name: 'Design' }).click();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByText('Draft saved.', { exact: true }).waitFor();
    const unchanged = await fetchJson(baseUrl, `/api/projects/${projectId}/automations/${definition.id}/versions`, { cookie });
    assert.equal((unchanged.body as any).versions[0].graph.nodes.find((n: any) => n.id === 'code').label, 'Implement feature');
    if (process.env.WORKFLOW_SCREENSHOT) await page.screenshot({ path: process.env.WORKFLOW_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.automation-inspector').getByLabel('Name', { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'mobile page should not overflow horizontally');
    await page.setViewportSize({ width: 1440, height: 1000 });

    // A step can be removed with the button in its settings, together with its connections.
    const nodesBefore = await page.locator(canvas).count();
    const edgesBefore = await page.locator('.automation-canvas .react-flow__edge').count();
    await page.getByText('Run tests', { exact: true }).click();
    await page.getByRole('button', { name: 'Delete step' }).click();
    assert.equal(await page.locator(canvas).count(), nodesBefore - 1);
    assert.ok((await page.locator('.automation-canvas .react-flow__edge').count()) < edgesBefore, 'its connections go too');
    assert.equal(await page.getByRole('button', { name: 'Delete step' }).count(), 0, 'nothing is selected afterwards');

    // Leaving with unsaved changes asks first; saving lets you go to the list, which shows the workflow.
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: 'Workflows' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByText('Draft saved.', { exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: 'Workflows' }).click();
    const row = page.getByRole('table', { name: 'Workflows' }).getByRole('row', { name: /Published v2/ });
    await row.waitFor();
    assert.match(await row.innerText(), /SDLC/);

    // A template can be read before creating, and Cancel leaves nothing behind.
    await page.getByRole('button', { name: 'New workflow' }).click();
    await pickTemplate(page, /Development/);
    await page.locator(preview).nth(11).waitFor();
    assert.equal(await page.locator(preview).count(), 12);
    await page.locator('.automation-canvas[aria-label="Template canvas"]').getByText('Read Jira ticket', { exact: true }).click();
    await page.locator('.automation-inspector').getByText(/Jira ticket is/).waitFor();
    assert.equal(await definitionsCount(), 1, 'previewing creates nothing');
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Create from the Testing template; the default name is the template's own.
    await page.getByRole('button', { name: 'New workflow' }).click();
    await pickTemplate(page, /Testing/);
    assert.equal(await page.getByLabel('New workflow name').inputValue(), 'Testing');
    await page.getByRole('button', { name: 'Create workflow' }).click();
    await page.locator(canvas).first().waitFor();
    assert.equal(await page.locator(canvas).count(), 7, 'the testing template opened as an editable workflow');
    assert.equal(await definitionsCount(), 2);

    // The same template again gets a numbered name, and typing an existing name is refused instead of duplicating it.
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: 'Workflows' }).click();
    await page.getByRole('button', { name: 'New workflow' }).click();
    await pickTemplate(page, /Testing/);
    assert.equal(await page.getByLabel('New workflow name').inputValue(), 'Testing 2');
    await page.getByLabel('New workflow name').fill('testing');
    await page.getByRole('button', { name: 'Create workflow' }).click();
    await page.getByRole('alert').getByText(/already exists/).waitFor();
    assert.equal(await definitionsCount(), 2, 'no duplicate was created');
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Delete asks first, then the workflow leaves the list.
    await page.getByRole('button', { name: 'Delete Testing' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete Testing' }).waitFor({ state: 'detached' });
    assert.equal(await definitionsCount(), 1);

    // Describe it: the AI drafts a workflow with its assumptions and questions, it can be refined, and Create saves it.
    const drafts = [
      { name: 'Bug triage', summary: 'Triage a bug.', assumptions: ['Tests run with npm test'], questions: ['Which branch should the fix target?'],
        steps: [{ id: 'analyze', kind: 'agent', label: 'Analyze the bug', instructions: 'Find the cause of {{input}}.' }, { id: 'fix', kind: 'agent', label: 'Fix it', instructions: 'Fix it and add a test.', checks: [{ step: 'Tests', cmd: 'npm test', timeout: 300 }] }] },
      { name: 'Bug triage', summary: 'Triage a bug, with approval.', assumptions: [], questions: [],
        steps: [{ id: 'analyze', kind: 'agent', label: 'Analyze the bug', instructions: 'Find the cause of {{input}}.' }, { id: 'approve', kind: 'approval', label: 'Approve the plan', instructions: 'Check the analysis.' }, { id: 'fix', kind: 'agent', label: 'Fix it', instructions: 'Fix it and add a test.' }] },
    ];
    const prompts: string[] = [];
    setCallTextModelOverride(async (_system, user) => { prompts.push(user); return JSON.stringify(drafts[prompts.length - 1]); });
    const countBefore = await definitionsCount();
    await page.getByRole('button', { name: 'New workflow' }).click();
    await pickTemplate(page, /Describe it/);
    assert.equal(await page.getByRole('button', { name: 'Create workflow' }).isDisabled(), true, 'nothing to create before a draft exists');
    await page.getByLabel('Describe the workflow').fill('When I give a bug, find the cause and fix it.');
    await page.getByRole('button', { name: 'Generate workflow' }).click();
    await page.getByRole('heading', { name: 'What the AI assumed' }).waitFor();
    await page.getByText('Which branch should the fix target?').waitFor();
    assert.equal(await page.locator(preview).count(), 4, 'Start, two steps, End');
    assert.equal(await page.getByLabel('New workflow name').inputValue(), 'Bug triage');
    assert.equal(await definitionsCount(), countBefore, 'a draft is not saved');
    await page.getByLabel('Change it').fill('Ask me before the fix.');
    await page.getByRole('button', { name: 'Update the draft' }).click();
    await page.locator(preview).nth(4).waitFor();
    assert.equal(await page.locator(preview).count(), 5, 'the refined draft has the approval step');
    assert.match(prompts[1], /Ask me before the fix\./);
    await page.getByRole('button', { name: 'Create workflow' }).click();
    await page.locator(canvas).first().waitFor();
    assert.equal(await page.locator(canvas).count(), 5, 'the generated workflow opens in the editor');
    assert.equal(await definitionsCount(), countBefore + 1);
    setCallTextModelOverride(null);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); stopLocalAutomationTimers(); await cleanup(); }
});
