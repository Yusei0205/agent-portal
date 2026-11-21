/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('Chat with Kyu answers a question, identifies its provider and opens Feedback',async()=>{
  const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'jsx',contents:`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {CatChatPanel} from './web/src/components/CatChatPanel.jsx'; import './web/src/styles.css';
import {applyTheme,setMode,setActiveTemplate} from './web/src/lib/theme.js'; applyTheme(); setMode('dark');setActiveTemplate('graphite');
createRoot(document.getElementById('root')).render(<CatChatPanel route={{projectId:'p1',tab:'sessions'}} user={{is_admin:true}} roam={true} onRoamChange={()=>{}} onClose={()=>{}}/>);
`},bundle:true,write:false,outfile:'ui.js',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},loader:{'.svg':'dataurl','.woff':'dataurl','.woff2':'dataurl'},logLevel:'silent'});
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900}}); let question='';
    await page.route('**/*',async route=>{
      const url=route.request().url();
      if(url.endsWith('/ui.js'))return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text});
      if(url.endsWith('/ui.css'))return route.fulfill({contentType:'text/css',body:bundle.outputFiles.find(f=>f.path.endsWith('.css'))!.text});
      if(url.includes('/api/assistant/chat')) {question=route.request().postDataJSON().question;return route.fulfill({json:{reply:'Open Feedback in the Portal section of the left sidebar.',links:[{id:'feedback',label:'Open Feedback',href:'#/feedback'}],provider:'Portal guide'}});}
      return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"><div id="root"></div><script type="module" src="/ui.js"></script>'});
    });
    await page.goto('http://portal.test/');
    const dialog=page.getByRole('dialog',{name:'Chat with Kyu'});
    await dialog.getByText("Meow! I'm Kyu, your Kyuubit assistant. What would you like to do?",{exact:true}).waitFor();
    await dialog.getByRole('textbox',{name:'Ask Kyu'}).fill('how do i view feedback page');
    await page.keyboard.press('Enter');
    await dialog.getByText('Open Feedback in the Portal section of the left sidebar.',{exact:false}).waitFor();
    assert.equal(question,'how do i view feedback page');
    await dialog.getByText('Portal guide',{exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});
    assert.ok(await dialog.evaluate(el=>el.getBoundingClientRect().left>=0&&el.getBoundingClientRect().right<=innerWidth),'mobile panel fits');
    if(process.env.KYU_SCREENSHOT)await page.screenshot({path:process.env.KYU_SCREENSHOT,animations:'disabled'});
    await dialog.getByRole('button',{name:'Open Feedback',exact:true}).click();
    assert.match(page.url(),/#\/feedback$/);
  } finally {await browser.close();}
});
