/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('Agent Setup provides a real definition directory, engine filters and native-file creation', async () => {
  const bundle = await build({stdin:{resolveDir:process.cwd(),loader:'jsx',contents:`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Configuration} from './web/src/pages/Configuration.jsx'; import {useRoute} from './web/src/lib/router.js';
import './web/src/styles.css'; import {applyTheme,setMode,setActiveTemplate} from './web/src/lib/theme.js';
applyTheme(); setMode('dark'); setActiveTemplate('kiro-ide');
window.addEventListener('test:theme',e=>{setMode(e.detail.mode);setActiveTemplate(e.detail.template);});
function App(){ const route=useRoute(); return <Configuration user={{}} tab={route.rest[0]}/>; }
createRoot(document.getElementById('root')).render(<App/>);
`},bundle:true,write:false,outfile:'ui.js',jsx:'automatic',logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'},loader:{'.woff':'dataurl','.woff2':'dataurl','.svg':'dataurl'}});
  const file = (suffix: string) => bundle.outputFiles.find((entry)=>entry.path.endsWith(suffix))!.text;
  const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1050}});
    page.setDefaultTimeout(10000);
    const errors: string[]=[]; page.on('pageerror',err=>errors.push(err.message));
    const definitions: Record<string, Array<Record<string,unknown>>> = {
      codex:[{name:'solution-architect',description:'Architecture and technical design',model:'configured-codex-model',definitionPath:'agents/solution-architect.toml'}],
      'claude-code':[{name:'security-reviewer',description:'Review security and access boundaries',model:'inherit',skills:['security-review','api-design'],definitionPath:'agents/security-reviewer.md'}],
      kiro:[{name:'quality-engineer',description:'Testing and validation',skills:['testing'],definitionPath:'agents/quality-engineer.json'}],
    };
    const writes: Array<{url:string; body:Record<string,unknown>}>=[];
    let failKiro=false;
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/ui.js') return route.fulfill({contentType:'text/javascript',body:file('.js')});
      if(url.pathname==='/ui.css') return route.fulfill({contentType:'text/css',body:file('.css')});
      if(url.pathname==='/api/user-config/agents') {
        const engine=url.searchParams.get('engine')!;
        if(engine==='kiro'&&failKiro)return route.fulfill({status:503,json:{error:'Temporarily unavailable'}});
        return route.fulfill({json:{engine,agents:definitions[engine]||[]}});
      }
      if(url.pathname.endsWith('/status')) return route.fulfill({json:{following:false}});
      if(url.pathname.endsWith('/file')&&route.request().method()==='POST') {
        const body=route.request().postDataJSON(); writes.push({url:url.pathname,body});
        const engine=url.pathname.includes('/claude/')?'claude-code':url.pathname.includes('/kiro/')?'kiro':'codex';
        definitions[engine].push({name:'new-specialist',description:'Build reliable services',definitionPath:body.path});
        return route.fulfill({json:{ok:true}});
      }
      if(url.pathname.endsWith('/file')) return route.fulfill({json:{content:'---\nname: security-reviewer\n---\nReview security.'}});
      if(url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
      return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"><div id="root"></div><script type="module" src="/ui.js"></script>'});
    });
    await page.goto('http://portal.test/#/config');
    await page.getByRole('button',{name:'Inspect solution-architect (Codex)',exact:true}).waitFor();
    assert.equal(await page.getByRole('tab',{name:'Agents',exact:true}).getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('.workforce-card').count(),3);
    await page.getByText('3 configured agents',{exact:true}).waitFor();
    const geometry=await page.locator('.workforce-card').evaluateAll(cards=>cards.map(card=>({bottom:card.getBoundingClientRect().bottom,footer:card.querySelector('.workforce-card-footer')!.getBoundingClientRect().top})));
    for(const key of ['bottom','footer'] as const)assert.ok(Math.max(...geometry.map(box=>box[key]))-Math.min(...geometry.map(box=>box[key]))<2,`card ${key} aligns`);
    if(process.env.PORTAL_WORKFORCE_SCREENSHOT)await page.screenshot({path:process.env.PORTAL_WORKFORCE_SCREENSHOT+'-desktop.png',animations:'disabled'});
    await page.getByRole('searchbox',{name:'Search agents'}).fill('api-design');
    assert.equal(await page.locator('.workforce-card').count(),1);
    await page.getByRole('button',{name:'Inspect security-reviewer (Claude Code)',exact:true}).click();
    const inspector=page.getByRole('dialog',{name:'security-reviewer',exact:true});
    await inspector.getByLabel('Editing agents/security-reviewer.md').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button',{name:'Inspect security-reviewer (Claude Code)',exact:true}).evaluate(el=>el===document.activeElement),true);
    await page.getByRole('searchbox',{name:'Search agents'}).fill('');
    await page.getByLabel('Filter agent engine').selectOption('kiro');
    assert.equal(await page.locator('.workforce-card').count(),1);
    failKiro=true;
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(),/Kiro could not be refreshed/);
    assert.equal(await page.locator('.workforce-card').count(),1,'failed refresh retains previous definitions');
    failKiro=false;
    await page.getByRole('button',{name:'Retry',exact:true}).click();
    await page.getByRole('alert').waitFor({state:'hidden'});
    await page.getByLabel('Filter agent engine').selectOption('all');
    for(const engine of ['codex','claude-code','kiro']) {
      await page.getByRole('button',{name:'Create agent',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'Create agent',exact:true});
      await dialog.getByLabel('Engine',{exact:true}).selectOption(engine);
      await dialog.getByLabel('Agent name',{exact:true}).fill('new-specialist');
      await dialog.getByLabel('Description',{exact:true}).fill('Build reliable services');
      await dialog.getByLabel('Instructions',{exact:true}).fill('Read requirements and verify the result.');
      await dialog.getByRole('button',{name:'Create agent',exact:true}).click();
      await dialog.waitFor({state:'hidden'});
    }
    assert.equal(writes.length,3);
    assert.equal(writes[0].body.path,'agents/new-specialist.toml');
    assert.match(String(writes[0].body.content),/developer_instructions = "Read requirements/);
    assert.match(String(writes[1].body.content),/^---\nname: "new-specialist"/);
    assert.equal(JSON.parse(String(writes[2].body.content)).prompt,'Read requirements and verify the result.');
    await page.getByRole('button',{name:'Inspect new-specialist (Kiro)',exact:true}).waitFor();
    await page.getByRole('searchbox',{name:'Search agents'}).fill('no-such-agent');
    await page.getByRole('heading',{name:'No matching agents',exact:true}).waitFor();
    await page.getByRole('searchbox',{name:'Search agents'}).fill('');
    for(const theme of [{mode:'light',template:'kiro-ide'},{mode:'dark',template:'cyber-hud'}]) {
      await page.evaluate(detail=>window.dispatchEvent(new CustomEvent('test:theme',{detail})),theme);
      await page.setViewportSize({width:390,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile fits');
      assert.equal(await page.locator('.config-tabs-row .tab-bar').evaluate(el=>el.scrollHeight>el.clientHeight),false,'no vertical tab scrollbar');
    }
    if(process.env.PORTAL_WORKFORCE_SCREENSHOT)await page.screenshot({path:process.env.PORTAL_WORKFORCE_SCREENSHOT+'-mobile.png',animations:'disabled'});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
