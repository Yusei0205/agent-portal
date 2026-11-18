/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { resolve } from 'node:path';

test('navigation disclosures, workspace modes, and launcher options remain accessible', async () => {
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {Rail} from './web/src/components/Rail.jsx';
import {IdeWorkspace} from './web/src/pages/sessions/IdeWorkspace.jsx';
import {NewSessionDialog} from './web/src/pages/sessions/NewSessionDialog.jsx';
import './web/src/styles.css';
import '@fontsource-variable/inter/index.css'; import '@fontsource-variable/exo-2/index.css'; import '@fontsource/orbitron/400.css';
import {setActiveTemplate,setMode} from './web/src/lib/theme.js'; setActiveTemplate('kiro-ide'); setMode('dark');
const noop = () => {}; const project = {id:'p1', name:'Alpha'};
const view = new URLSearchParams(location.search).get('view');
createRoot(document.getElementById('root')).render(view === 'workspace'
  ? <div style={{height:'100vh'}}><IdeWorkspace id="w1" project={project}/></div>
  : view === 'launcher' ? <NewSessionDialog project={project} onClose={noop} onCreated={noop}/>
  : <Rail route={{tab: view === 'active' ? 'tickets' : 'dashboard', projectId: 'p1'}} user={{name:'Tan',is_admin:true}} projects={[project]} inboxCount={4} onSignOut={noop} onNavigate={noop} collapsed={false} onToggleCollapse={noop} railWidth={236} onRailWidthChange={noop}/>);`;
  const bundled = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, outfile: 'ui.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', loader: { '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' }, alias: {
    dcv: resolve('web/vendor/agentcore-live-view/nice-dcv-web-client-sdk/dcvjs-esm/dcv.js'),
    'dcv-ui': resolve('web/vendor/agentcore-live-view/nice-dcv-web-client-sdk/dcv-ui/dcv-ui.js'),
  } });
  const file = (ext: string) => bundled.outputFiles.find((f) => f.path.endsWith(ext))!.text;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    let workflowRunning = false;
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.endsWith('/ui.js')) return route.fulfill({ contentType: 'text/javascript', body: file('.js') });
      if (url.endsWith('/ui.css')) return route.fulfill({ contentType: 'text/css', body: file('.css') });
      if (url.includes('/api/')) {
        if (url.endsWith('/workflows/w1')) return route.fulfill({ json: { workflow: { id: 'w1', project_id: 'p1', title: 'Build the portal', engine: 'demo', status: workflowRunning ? 'running' : 'paused', goal: 'Improve the portal' }, latestRun: workflowRunning ? {id:'r-live',status:'running'} : null, runs: [] } });
        if (url.includes('/api/runs/r-live/events')) return route.fulfill({contentType:'text/event-stream',body:`data: ${JSON.stringify({type:'event',event:{id:'live1',type:'tool-start',run_id:'r-live',created_at:new Date().toISOString(),payload:{toolName:'Write',toolInput:{file_path:'src/app.ts',content:'new implementation'}}}})}\n\n`});
        if (url.endsWith('/output-files')) return route.fulfill({json:{files:[{id:'out1',name:'notes.txt',mime_type:'text/plain',path:'notes.txt',version:1,size_bytes:42,created_at:'2026-11-18T00:00:00Z',download_url:'/api/output-download',preview_url:'/api/output-preview'}]}});
        if (url.endsWith('/output-preview')) return route.fulfill({json:{type:'text',content:'Artifact preview verified.'}});
        if (url.includes('/ide/git/status')) return route.fulfill({json:{repos:[{name:'portal',branch:'feature/session-studio',files:[{path:'src/app.ts',status:'M'}]}]}});
        if (url.includes('/ide/git/diff')) return route.fulfill({json:{diff:'@@ -1 +1 @@\n-old\n+new implementation'}});
        if (url.includes('/transcript')) return route.fulfill({json:{events:[{id:'tool1',type:'tool-start',run_id:'r1',created_at:'2026-11-18T00:00:00Z',payload:{toolName:'Bash',toolUseId:'tool1',toolInput:{command:'npm test'}}},{id:'tool2',type:'tool-end',run_id:'r1',created_at:'2026-11-18T00:00:03Z',payload:{toolUseId:'tool1',toolName:'Bash',status:'done',output:'All example checks completed.'}},{id:'msg1',type:'assistant-text',created_at:'2026-11-18T00:00:04Z',payload:{text:'Implemented the change. Please review the diff.'}}].reverse(),nextCursor:null}});
        return route.fulfill({ json: { provider: { mode: 'demo' }, summary: [], agents: [], files: [], items: [], messages: [], commands: [], connected: false } });
      }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>' });
    });
    await page.goto('http://portal.test/');
    assert.equal(await page.getByRole('link', { name: 'Needs attention (4 unread)' }).getAttribute('href'), '#/inbox');
    const tools = page.getByRole('button', { name: 'Project tools' });
    assert.equal(await tools.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByRole('link', { name: 'Tickets', exact: true }).isVisible(), false);
    await tools.click();
    assert.equal(await page.getByRole('link', { name: 'Tickets', exact: true }).isVisible(), true);
    await page.goto('http://portal.test/?view=active');
    assert.equal(await page.getByRole('button', { name: 'Project tools' }).getAttribute('aria-expanded'), 'true');

    await page.goto('http://portal.test/?view=workspace');
    const modes = page.getByRole('group', { name: 'Workspace mode' });
    await modes.getByRole('button', { name: 'Code', exact: true }).waitFor();
    await page.getByText('feature/session-studio',{exact:true}).waitFor();
    await page.getByText('Implemented the change. Please review the diff.',{exact:true}).waitFor();
    const assertComposerAlignment = async () => {
      const boxes = await Promise.all([
        page.getByRole('button', {name:'Attach file', exact:true}),
        page.locator('.ws-composer-prompt'),
        page.getByRole('textbox', {name:'Message', exact:true}),
        page.getByRole('button', {name:'Send (Enter)', exact:true}),
      ].map((locator) => locator.boundingBox()));
      const centers = boxes.map((box) => { assert.ok(box); return box.y + box.height / 2; });
      assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, 'composer controls share a vertical centre');
    };
    await assertComposerAlignment();
    await page.getByRole('textbox', {name:'Message', exact:true}).fill('First line\nSecond line\nThird line');
    await assertComposerAlignment();
    await page.getByRole('textbox', {name:'Message', exact:true}).fill('');
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Focus', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.ide-activity-bar').isVisible(), false);
    await modes.getByRole('button', { name: 'Code', exact: true }).click();
    assert.equal(await modes.getByRole('button', { name: 'Code', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.ide-activity-bar').isVisible(), true);
    assert.equal(await page.locator('.ide-editor-area').isVisible(), true);
    if (process.env.PORTAL_SESSION_SCREENSHOT) { await page.evaluate(()=>document.fonts.ready); await page.screenshot({path:process.env.PORTAL_SESSION_SCREENSHOT+'-code.png',animations:'disabled'}); }
    await modes.getByRole('button', {name:'Run',exact:true}).click();
    await page.getByRole('region',{name:'Execution view',exact:true}).waitFor();
    await page.getByLabel('Inspect Bash tool call',{exact:true}).click();
    await page.getByRole('region',{name:'Execution view',exact:true}).getByText('All example checks completed.',{exact:true}).waitFor();
    assert.equal(await page.getByText('Implemented the change. Please review the diff.',{exact:true}).isVisible(),true,'conversation stays visible alongside execution');
    if (process.env.PORTAL_SESSION_SCREENSHOT) await page.screenshot({path:process.env.PORTAL_SESSION_SCREENSHOT+'-run.png',animations:'disabled'});
    await page.getByTitle('Preview notes.txt',{exact:true}).click();
    await page.getByText('Artifact preview verified.',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await modes.getByRole('button',{name:'Review',exact:true}).click();
    await page.getByRole('region',{name:'Review summary',exact:true}).waitFor();
    await page.getByText(/1 check commands completed/).waitFor();
    await page.getByRole('button',{name:'Modified: src/app.ts',exact:true}).click();
    await page.getByLabel('File diff',{exact:true}).getByText('+new implementation',{exact:true}).waitFor();
    assert.equal(await page.getByText('Implemented the change. Please review the diff.',{exact:true}).isVisible(),true);
    if (process.env.PORTAL_SESSION_SCREENSHOT) await page.screenshot({path:process.env.PORTAL_SESSION_SCREENSHOT+'-review.png',animations:'disabled'});
    await page.reload();
    assert.equal(await modes.getByRole('button',{name:'Review',exact:true}).getAttribute('aria-pressed'),'true','workspace layout is remembered');
    await page.setViewportSize({width:390,height:900});
    await modes.getByRole('button',{name:'Run',exact:true}).click();
    await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);
    assert.equal(await page.locator('.ide-agent-panel').isVisible(),true);
    await assertComposerAlignment();
    if (process.env.PORTAL_SESSION_SCREENSHOT) await page.screenshot({path:process.env.PORTAL_SESSION_SCREENSHOT+'-mobile.png',animations:'disabled'});
    workflowRunning = true;
    await page.setViewportSize({width:1440,height:900});
    await page.reload();
    await page.getByTitle('Write · src/app.ts',{exact:true}).waitFor();
    assert.equal(await page.locator('.session-activity-strip').evaluate((element)=>element.classList.contains('is-running')),true);

    await page.goto('http://portal.test/?view=launcher');
    await page.getByRole('dialog').waitFor();
    const iterations = page.getByLabel('Max iterations');
    assert.equal(await iterations.isVisible(), false);
    await page.locator('.launch-advanced > summary').click();
    assert.equal(await iterations.isVisible(), true);
    await iterations.fill('8');
    await page.locator('.launch-advanced > summary').click();
    await page.locator('.launch-advanced > summary').click();
    assert.equal(await iterations.inputValue(), '8');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
