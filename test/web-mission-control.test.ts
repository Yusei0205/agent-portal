/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('mission control connects recorded agents, activity and deliverables without leaking between sessions', async () => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {MissionControl} from './web/src/components/MissionControl.jsx'; import './web/src/styles.css';
import {setActiveTemplate,setMode} from './web/src/lib/theme.js'; setActiveTemplate('kiro-ide'); setMode('dark');
window.addEventListener('test:picker-theme', (event) => { setActiveTemplate(event.detail.template); setMode(event.detail.mode); });
const sessions=[{id:'w1',projectId:'p1',projectName:'Alpha',title:'Build authentication API',status:'running'},{id:'w2',projectId:'p1',title:'Review data migration',status:'done'}];
createRoot(document.getElementById('root')).render(<main style={{padding:24,maxWidth:900,margin:'0 auto'}}><MissionControl activeSession={sessions[0]} recentSessions={sessions} animated /></main>);
` }, bundle: true, write: false, outfile: 'ui.js', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.svg': 'dataurl' } });
  const file = (suffix: string) => bundle.outputFiles.find((entry) => entry.path.endsWith(suffix))!.text;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let agentsFail = false;
    const oldRequest: { release?: () => void } = {};
    let holdNext = false;
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.endsWith('/ui.js')) return route.fulfill({body:file('.js'),contentType:'text/javascript'});
      if (url.endsWith('/ui.css')) return route.fulfill({body:file('.css'),contentType:'text/css'});
      if (url.includes('/api/')) {
        const second = url.includes('/w2');
        if (url.endsWith('/agents')) {
          if (holdNext && !second) { holdNext = false; await new Promise<void>((resolve) => { oldRequest.release = resolve; }); }
          if (agentsFail) return route.fulfill({status:503,json:{error:'Agent service unavailable'}});
          return route.fulfill({json:{agents:second ? [] : [{id:'a1',name:'API engineer',status:'running',description:'Implement authentication middleware',startedAt:'2026-11-19T00:00:00Z',toolUses:2}]}});
        }
        if (url.includes('/transcript?')) return route.fulfill({json:{events: second ? [] : [{id:'e2',type:'assistant-text',created_at:'2026-11-19T00:00:02Z',payload:{agentId:'a1',text:'Middleware implementation ready for review.'}},{id:'e1',type:'tool-start',created_at:'2026-11-19T00:00:01Z',payload:{agentId:'a1',toolName:'Write',toolInput:{file_path:'src/auth.ts'}}}],nextCursor:null}});
        if (url.endsWith('/output-files')) return route.fulfill({json:{files:second ? [] : [{id:'f1',name:'authentication-notes.txt',mime_type:'text/plain',version:2,created_at:'2026-11-19T00:00:04Z',preview_url:'/api/preview',download_url:'/api/download'}]}});
        if (url.endsWith('/preview')) return route.fulfill({json:{type:'text',content:'Authentication deliverable preview.'}});
        if (/\/workflows\/w[12]$/.test(url)) { assert.ok(url.includes('/api/projects/p1/workflows/'),'session details use the project-scoped route'); return route.fulfill({json:{workflow:{id:second?'w2':'w1',title:second?'Review data migration':'Build authentication API',goal:second?'Review the migration':'Implement secure authentication',status:second?'done':'running'}}}); }
        return route.fulfill({json:{}});
      }
      return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>'});
    });
    await page.goto('http://portal.test/');
    await page.getByRole('button',{name:'Inspect API engineer',exact:true}).waitFor();
    // Theme chevrons must remain a single right-aligned icon, with room for the label.
    for (const theme of [{template:'kiro-ide',mode:'dark'},{template:'kiro-ide',mode:'light'},{template:'cyber-hud',mode:'dark'}]) {
      await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('test:picker-theme',{detail})), theme);
      const picker = await page.getByLabel('Inspect recent work').evaluate((element) => {
        const style = getComputedStyle(element);
        return { repeat:style.backgroundRepeat, image:style.backgroundImage, right:parseFloat(style.paddingRight), size:style.backgroundSize };
      });
      assert.equal(picker.repeat,'no-repeat');
      assert.notEqual(picker.image,'none');
      assert.equal(picker.size,'16px 16px');
      assert.ok(picker.right>=32,'selected text leaves space for the chevron');
    }
    if (process.env.PORTAL_MISSION_SCREENSHOT) await page.screenshot({path:process.env.PORTAL_MISSION_SCREENSHOT+'-picker.png',animations:'disabled'});
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('test:picker-theme',{detail:{template:'kiro-ide',mode:'dark'}})));
    assert.equal(await page.getByLabel('Inspect recent work').locator('option').count(),2,'active session is deduplicated');
    await page.getByRole('button',{name:'Inspect API engineer',exact:true}).click();
    const inspector = page.getByRole('dialog',{name:'Build authentication API',exact:true});
    await inspector.getByRole('region',{name:'Details for API engineer',exact:true}).waitFor();
    await inspector.locator('.react-flow__node').first().waitFor();
    await inspector.getByText('Middleware implementation ready for review.',{exact:true}).waitFor();
    assert.match(await inspector.getByRole('list',{name:'Transcript of API engineer'}).innerText(),/src\/auth.ts/);
    assert.equal(await inspector.getByRole('link',{name:'Open workspace',exact:true}).getAttribute('href'),'#/p/p1/sessions/w1');
    if (process.env.PORTAL_MISSION_SCREENSHOT) await page.screenshot({path:process.env.PORTAL_MISSION_SCREENSHOT+'-desktop.png',animations:'disabled'});
    await inspector.getByRole('button',{name:'Activity',exact:true}).click();
    await inspector.getByRole('region',{name:'Recent mission activity'}).getByText('Middleware implementation ready for review.',{exact:true}).waitFor();
    await inspector.getByRole('button',{name:'Deliverables',exact:true}).click();
    await inspector.getByRole('button',{name:/authentication-notes.txt/}).click();
    await page.getByText('Authentication deliverable preview.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('dialog').count(),1,'only one focus trap is mounted while previewing');
    await page.keyboard.press('Escape');
    await inspector.getByRole('region',{name:'Mission deliverables'}).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button',{name:'Inspect API engineer',exact:true}).evaluate((element)=>element===document.activeElement),true,'closing restores the initiating agent button');

    // A failed refresh keeps the previous selection and makes staleness explicit.
    agentsFail = true;
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByText('Agents unavailable · showing last available data',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Inspect API engineer',exact:true}).isVisible(),true);
    agentsFail = false;
    await page.getByRole('button',{name:'Retry',exact:true}).click();
    await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();

    // Late results for the old session cannot populate the newly selected one.
    holdNext = true;
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    const deadline = Date.now() + 5000;
    while (!oldRequest.release && Date.now() < deadline) await page.waitForTimeout(10);
    assert.ok(oldRequest.release, 'refresh request started');
    await page.getByLabel('Inspect recent work').selectOption('w2');
    await page.getByRole('heading',{name:'Review data migration',exact:true}).waitFor();
    oldRequest.release();
    await page.getByText('No delegated agents reported. This session may use only its lead agent.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Inspect API engineer',exact:true}).count(),0);
    await page.getByRole('button',{name:'Deliverables (0)',exact:true}).click();
    await page.getByText('No output files reported yet.',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await page.getByLabel('Inspect recent work').selectOption('w1');
    await page.getByRole('button',{name:'Inspect API engineer',exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Inspect API engineer',exact:true}).click();
    await inspector.waitFor();
    await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);
    assert.ok(await inspector.evaluate((element)=>element.scrollWidth<=element.clientWidth),'mobile inspector fits the viewport');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('.mc-agent-icon').first().evaluate((element)=>getComputedStyle(element).animationName),'none');
    if (process.env.PORTAL_MISSION_SCREENSHOT) await page.screenshot({path:process.env.PORTAL_MISSION_SCREENSHOT+'-mobile.png',animations:'disabled'});
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
