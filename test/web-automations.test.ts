/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { stopLocalAutomationTimers } from '../server/automations/engine.ts';
import { setCallTextModelOverride } from '../server/testing/model-provider.ts';
import { sdlcTemplate } from '../server/automations/schema.ts';
import JSZip from 'jszip';

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
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
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

    // System defaults and user-created templates are managed separately per project.
    await page.getByRole('button', {name:'Workflows',exact:true}).click();
    await page.getByRole('button', {name:'Template library',exact:true}).click();
    const system = page.getByRole('region',{name:'System templates',exact:true});
    const users = page.getByRole('region',{name:'User templates',exact:true});
    await system.getByRole('article',{name:'Bug fix with regression test',exact:true}).waitFor();
    assert.equal(await system.getByRole('article').count(),13);
    assert.equal(await users.getByRole('article').count(),0);
    let bug = system.getByRole('article',{name:'Bug fix with regression test',exact:true});
    await bug.getByRole('button',{name:'Customize for project',exact:true}).click();
    await page.locator(`${canvas}[data-id="task_1"]`).click();
    if (process.env.PORTAL_TEMPLATE_SCREENSHOT) await page.screenshot({path:process.env.PORTAL_TEMPLATE_SCREENSHOT+'-editing.png',animations:'disabled'});
    await page.getByLabel('Instructions',{exact:true}).fill('Use our project-specific reproduction steps for {{input}}.');
    await page.getByRole('button',{name:'Save project override',exact:true}).click();
    await page.getByText('Template saved for this project. Existing workflows were not changed.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Publish version',exact:true}).count(),0,'template changes cannot publish/run a workflow');
    await page.getByRole('button',{name:'Template library',exact:true}).click();
    await bug.getByText('Project override',{exact:true}).waitFor();
    await page.reload();
    await page.getByRole('button',{name:'Template library',exact:true}).click();
    await bug.getByRole('button',{name:'Use template',exact:true}).click();
    await page.getByRole('button',{name:'Create workflow',exact:true}).click();
    await page.getByRole('button',{name:'Save as template',exact:true}).waitFor();
    const createdBug = (((await fetchJson(baseUrl,`/api/projects/${projectId}/automations`,{cookie})).body as any).definitions as any[]).find((d)=>d.template_id==='bug-fix');
    assert.equal(createdBug.graph.nodes.find((n:any)=>n.id==='task_1').prompt,'Use our project-specific reproduction steps for {{input}}.');
    await page.getByRole('button',{name:'Save as template',exact:true}).click();
    await page.getByLabel('Template name',{exact:true}).fill('Team bug fix standard');
    await page.getByRole('button',{name:'Create user template',exact:true}).click();
    await page.getByText('User template created for this project.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Workflows',exact:true}).click();
    await page.getByRole('button',{name:'Template library',exact:true}).click();
    await users.getByRole('article',{name:'Team bug fix standard',exact:true}).waitFor();
    await bug.getByRole('button',{name:'Reset to default',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Reset to default',exact:true}).click();
    await page.getByText('System default restored for this project. Existing workflows were not changed.',{exact:true}).waitFor();
    await bug.getByText('System default',{exact:true}).waitFor();
    const preserved = ((await fetchJson(baseUrl,`/api/projects/${projectId}/automations/${createdBug.id}`,{cookie})).body as any).definition;
    assert.equal(preserved.graph.nodes.find((n:any)=>n.id==='task_1').prompt,'Use our project-specific reproduction steps for {{input}}.');
    await page.getByRole('button',{name:'New user template',exact:true}).click();
    await page.locator('.automation-settings').getByLabel('Name',{exact:true}).fill('Project onboarding');
    await page.getByLabel('Description',{exact:true}).fill('Reusable onboarding process');
    await page.getByRole('button',{name:'Save user template',exact:true}).click();
    await page.getByText('Template saved for this project. Existing workflows were not changed.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Template library',exact:true}).click();
    const onboarding = users.getByRole('article',{name:'Project onboarding',exact:true});
    await onboarding.getByRole('button',{name:'Edit template',exact:true}).click();
    assert.equal(await page.getByLabel('Description',{exact:true}).inputValue(),'Reusable onboarding process');
    await page.getByRole('button',{name:'Template library',exact:true}).click();
    await onboarding.getByRole('button',{name:'Delete template',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Delete template',exact:true}).click();
    await page.getByText('User template deleted. Existing workflows were not changed.',{exact:true}).waitFor();
    assert.equal(await onboarding.count(),0);

    // The run form accepts a requirements document and an image pasted into the request.
    const contextGraph=sdlcTemplate(); contextGraph.engine='demo';
    contextGraph.nodes=contextGraph.nodes.filter((node)=>['start','approve','end'].includes(node.id));
    contextGraph.edges=[{id:'context-a',source:'start',target:'approve',branch:'next'},{id:'context-b',source:'approve',target:'end',branch:'next'}];
    const contextDefinition=((await fetchJson(baseUrl,`/api/projects/${projectId}/automations`,{cookie,body:{name:'Requirements context run',graph:contextGraph}})).body as any).definition;
    await fetchJson(baseUrl,`/api/projects/${projectId}/automations/${contextDefinition.id}/publish`,{cookie,body:{revision:1}});
    await page.getByRole('button',{name:'Back to workflows',exact:true}).click();
    await page.getByRole('button',{name:'Requirements context run',exact:true}).click();
    await page.route(`**/api/projects/${projectId}/jira`, (route)=>route.fulfill({json:{connected:true,mapping:{projectKeys:['ABC']}}}));
    await page.route(`**/api/projects/${projectId}/jira/projects`, (route)=>route.fulfill({json:{projects:[{key:'ABC',name:'Product development'}]}}));
    await page.route(`**/api/projects/${projectId}/jira/issues?*`, (route)=>route.fulfill({json:{issues:[{key:'ABC-123',summary:'Authentication requirements',status:{name:'To Do',category:'new'},priority:'Medium'}],nextPage:null}}));
    await page.getByRole('tab',{name:/^Runs/}).click();
    const doc=new JSZip(); doc.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Requirements for authentication</w:t></w:r></w:p></w:body></w:document>');
    await page.locator('.automation-run-context input[type="file"]').setInputFiles({name:'requirements.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:await doc.generateAsync({type:'nodebuffer'})});
    await page.locator('.attachment-picker').getByText('requirements.docx',{exact:true}).waitFor();
    await page.getByRole('textbox',{name:'Run request',exact:true}).fill('Read requirements.docx and the pasted technical design.');
    await page.getByRole('textbox',{name:'Run request',exact:true}).evaluate((element)=>{
      const data=new DataTransfer(); const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCFEAAAAASUVORK5CYII='),(char)=>char.charCodeAt(0));
      data.items.add(new File([bytes],'technical-design.png',{type:'image/png'}));
      element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    });
    await page.locator('.attachment-picker').getByText('technical-design.png',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Run published workflow',exact:true}).waitFor();
    await page.getByRole('tab',{name:'Design',exact:true}).click();
    await page.getByRole('tab',{name:/^Runs/}).click();
    assert.equal(await page.locator('.attachment-picker').getByText('requirements.docx',{exact:true}).isVisible(),true,'tab switches preserve selected files');
    const jiraSearch=page.getByRole('searchbox',{name:'Search Jira tickets',exact:true});
    const queried=page.waitForRequest((request)=>request.url().includes('/jira/issues?') && new URL(request.url()).searchParams.get('q')==='Authentication');
    await jiraSearch.fill('Authentication');
    await queried;
    const ticketOption=page.getByRole('option',{name:/ABC-123 Authentication requirements/});
    await ticketOption.waitFor(); await ticketOption.focus(); await page.keyboard.press('Enter');
    await page.getByRole('status',{name:'Selected Jira ticket: ABC-123',exact:true}).waitFor();
    await page.getByRole('tab',{name:'Design',exact:true}).click();
    await page.getByRole('tab',{name:/^Runs/}).click();
    assert.equal(await page.getByRole('status',{name:'Selected Jira ticket: ABC-123',exact:true}).isVisible(),true,'selected issue survives a tab switch');
    await page.getByRole('button',{name:'Run published workflow',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Jira context could not be loaded'}).waitFor();
    await page.getByRole('button',{name:'Remove ticket ABC-123',exact:true}).click();
    await page.getByRole('button',{name:'Run published workflow',exact:true}).click();
    const savedContext=page.getByRole('region',{name:'Saved run context',exact:true});
    await savedContext.getByText('requirements.docx',{exact:false}).waitFor();
    assert.match(await savedContext.innerText(),/technical-design.png/);
    if(process.env.PORTAL_TEMPLATE_SCREENSHOT) await page.screenshot({path:process.env.PORTAL_TEMPLATE_SCREENSHOT+'-run-context.png',fullPage:true,animations:'disabled'});
    await page.getByRole('button',{name:'Cancel run',exact:true}).click();
    await page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('button',{name:'Workflows',exact:true}).click();
    await page.getByRole('button',{name:'Template library',exact:true}).click();
    if (process.env.PORTAL_TEMPLATE_SCREENSHOT) await page.screenshot({path:process.env.PORTAL_TEMPLATE_SCREENSHOT+'-desktop.png',fullPage:true,animations:'disabled'});
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);
    if (process.env.PORTAL_TEMPLATE_SCREENSHOT) await page.screenshot({path:process.env.PORTAL_TEMPLATE_SCREENSHOT+'-mobile.png',fullPage:true,animations:'disabled'});
    setCallTextModelOverride(null);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); stopLocalAutomationTimers(); await cleanup(); }
});
