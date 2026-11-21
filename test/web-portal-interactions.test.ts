/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { resolve } from 'node:path';

test('dashboard details, pointer glow, navigation context and artifact lifecycle work together', async () => {
  const entry = `import React, {useRef} from 'react'; import {createRoot} from 'react-dom/client';
import {Dashboard} from './web/src/pages/Dashboard.jsx'; import {CreateActivity} from './web/src/components/CreateActivity.jsx';
import {RunOutputsCard} from './web/src/pages/sessions/RunOutputsCard.jsx';
import {MotionRoot} from './web/src/components/MotionRoot.jsx';
import {useRoute} from './web/src/lib/router.js'; import {usePageScroll} from './web/src/lib/page-context.js'; import {usePointerGlow} from './web/src/lib/usePointerGlow.js';
import './web/src/styles.css';
import '@fontsource-variable/exo-2/index.css'; import '@fontsource/orbitron/400.css';
import {setActiveTemplate, setMode} from './web/src/lib/theme.js'; setActiveTemplate('cyber-hud'); setMode('dark');
window.addEventListener('test:kiro', () => setActiveTemplate('kiro-ide'));
function App() { const route = useRoute(); const ref = useRef(null); usePageScroll(route.tab, ref); usePointerGlow(ref, route.tab);
return <div className="shell-right"><nav><a href="#/dashboard">Dashboard</a> <a href="#/other">Other</a> <a href="#/create">Create activity</a> <a href="#/outputs">Outputs</a></nav>
<main className="main" id="main" key={route.tab} ref={ref} tabIndex={-1}>{route.tab === 'dashboard' ? <Dashboard user={{name:'Tan'}} projects={[{id:'p1',name:'Alpha'}]} /> : route.tab === 'create' ? <CreateActivity projectId="p1"/> : route.tab === 'outputs' ? <RunOutputsCard workflowId="w1" projectId="p1" onPreview={() => {}} files={[{id:'file1',name:'result.png',mime_type:'image/png',version:1,created_at:new Date().toISOString(),size_bytes:123,download_url:'/output.png'}]}/> : <div style={{height:1800}}><section className="card" style={{padding:40}}>Other page card</section><section className="stat-card" style={{padding:40}}>Other page statistic</section><div className="cm-editor"><section className="card" style={{padding:40}}>Editor content</section></div></div>}</main></div>; }
createRoot(document.getElementById('root')).render(<MotionRoot><App/></MotionRoot>);`;
  const bundled = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, outfile: 'ui.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', loader: { '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' }, alias: {
    dcv: resolve('web/vendor/agentcore-live-view/nice-dcv-web-client-sdk/dcvjs-esm/dcv.js'),
    'dcv-ui': resolve('web/vendor/agentcore-live-view/nice-dcv-web-client-sdk/dcv-ui/dcv-ui.js'),
  } });
  const file = (extension: string) => bundled.outputFiles.find((f) => f.path.endsWith(extension))!.text;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
    const errors: string[] = [];
    const queries: string[] = [];
    let phase = 'generating';
    const now = new Date().toISOString();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/ui.js')) return route.fulfill({ contentType: 'text/javascript', body: file('.js') });
      if (url.pathname.endsWith('/ui.css')) return route.fulfill({ contentType: 'text/css', body: file('.css') });
      if (url.pathname.includes('/api/dashboard')) {
        queries.push(url.pathname + url.search);
        if (url.pathname.includes('/agents/')) return route.fulfill({ json: { runs: [] } });
        return route.fulfill({ json: {
          generatedAt: now, summary: {totalAgents:1,runningSessions:1,queuedSessions:0,completedToday:2,completedYesterday:1,successRate:.75,finishedRuns:4,failedRuns:1,stoppedRuns:0},
          agents:[{agent:'coder',runs:4,completed:3,failed:1,successRate:.75,avgDurationMs:1000}],
          network:{nodes:[],edges:[]},daily:[],idleClosing:[],recentSessions:[{id:'w1',projectId:'p1',projectName:'Alpha',title:'Active task',status:'running',childAgents:[]}],activeSession:null,
        } });
      }
      if (url.pathname.includes('/generated-docs/d1/download')) return route.fulfill({ contentType: 'text/markdown', body: '# Ready guide\n\nVerified content. <script>window.bad=true</script>' });
      if (url.pathname.endsWith('/generated-docs')) return route.fulfill({ json: { docs:[{id:'d1',name:'New guide',status:phase,workflow_id:'doc-run',doc_type:'overview',updated_at:now,created_at:now,latest_version_id:phase === 'ready' ? 'v1' : null,error:phase === 'failed' ? 'Generation stopped: missing source' : null}] } });
      if (url.pathname.includes('/api/')) return route.fulfill({ json: { items:[],diagrams:[],presentations:[],total:0,totalRuns:0,dailyCosts:[],costByProject:[],costByUser:[] } });
      if (url.pathname === '/output.png') return route.fulfill({ status: 204 });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>' });
    });
    await page.goto('http://portal.test/#/dashboard');
    const running = page.getByRole('article', { name: 'Running Sessions', exact: true });
    await running.waitFor();
    await page.waitForFunction(() => !document.getAnimations().some((animation) => animation.playState === 'running' && (animation as CSSAnimation).animationName === 'db-card-in'));
    await running.hover();
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-metric="running"]')!;
      return new DOMMatrix(getComputedStyle(card).transform).m42 < -1;
    });
    await page.waitForFunction(() => document.querySelector('.kpi-card[data-pointer-glow="true"]'));
    assert.match(await running.evaluate((element) => getComputedStyle(element).backgroundImage), /radial-gradient/, 'the rendered card must show the gradient, not merely set a tracking attribute');
    await page.evaluate(() => window.dispatchEvent(new Event('test:kiro')));
    await running.hover({ position: { x:30, y:65 } });
    await page.waitForFunction(() => document.querySelector('.kpi-card[data-pointer-glow="true"]'));
    const firstLight = await running.evaluate((element) => getComputedStyle(element).backgroundImage);
    assert.match(firstLight, /radial-gradient/, 'Kiro IDE must not override the pointer gradient');
    await running.hover({ position: { x:180, y:90 } });
    await page.waitForFunction((before) => getComputedStyle(document.querySelector('.kpi-card[data-pointer-glow="true"]')!).backgroundImage !== before, firstLight);
    const attention = page.getByRole('region', { name:'Needs attention',exact:true });
    await attention.hover();
    await page.waitForFunction(() => document.querySelector('.db-attn[data-pointer-glow="true"]'));
    assert.match(await attention.evaluate((element) => getComputedStyle(element).backgroundImage), /radial-gradient/, 'dashboard panel backgrounds must also show the pointer gradient');
    await running.hover();
    if (process.env.PORTAL_INTERACTION_SCREENSHOT) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: process.env.PORTAL_INTERACTION_SCREENSHOT + '-glow.png' }); }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => !document.querySelector('[data-pointer-glow="true"]'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(`(() => {
      window.__metricFrames = [];
      let count = 0;
      const sample = () => {
        const element = document.querySelector('.dashboard-details-metric');
        if (element) window.__metricFrames.push(getComputedStyle(element).transform);
        if (count++ < 60) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    })()`);
    // One click target covers the card, including its value and label.
    await running.click({position:{x:35,y:65}});
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('link', { name:/Active task/ }).waitFor();
    assert.equal(await dialog.locator('.dashboard-details-metric .kpi-value').innerText(), '1');
    await page.waitForFunction(() => (window as any).__metricFrames.some((value: string) => value !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(value)), null, {timeout:3000});
    const sourceIdentity = running.locator('.db-kpi-identity:not(.db-kpi-motion-source)');
    assert.equal(await sourceIdentity.evaluate((element) => getComputedStyle(element).opacity), '1', 'opening details must not fade the original metric');
    assert.equal(await sourceIdentity.evaluate((element) => getComputedStyle(element).visibility), 'visible');
    assert.match(await sourceIdentity.innerText(), /Running Sessions/i);
    await page.waitForFunction(() => Math.abs(document.querySelector('.dashboard-details')!.getBoundingClientRect().right - innerWidth) < 1);
    if (process.env.PORTAL_INTERACTION_SCREENSHOT) await page.screenshot({ path: process.env.PORTAL_INTERACTION_SCREENSHOT + '-details.png', animations: 'disabled' });
    assert.equal(await dialog.getByRole('link', { name:/Active task/ }).getAttribute('href'), '#/p/p1/sessions/w1');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state:'detached' });
    assert.equal(await running.getByRole('button').evaluate((el) => el === document.activeElement), true);

    await page.getByRole('button', { name:'7 days',exact:true }).click();
    await page.getByLabel('Filter by project').selectOption('p1');
    await page.getByRole('button', { name:'Explore Runs Completed Today' }).click();
    await dialog.getByRole('button', { name:/coder/ }).waitFor();
    assert.ok(queries.some((q) => q.includes('period=today') && q.includes('projectId=p1')));
    await dialog.getByRole('button', { name:/coder/ }).click();
    await page.getByRole('dialog', {name:'Runs completed today',exact:true}).waitFor({state:'detached'});
    await page.getByRole('dialog').waitFor();
    assert.ok(queries.some((q) => q.includes('/agents/coder/runs') && q.includes('period=today')));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state:'detached' });

    await page.locator('#main').evaluate((el) => { el.scrollTop = 600; });
    const scroll = await page.locator('#main').evaluate((el) => el.scrollTop);
    assert.ok(scroll > 100);
    await page.getByRole('link', { name:'Other',exact:true }).click();
    const otherCard = page.getByText('Other page card', {exact:true});
    await otherCard.hover();
    await page.waitForFunction(() => document.querySelector('.card[data-pointer-glow="true"]'));
    assert.match(await otherCard.evaluate((element) => getComputedStyle(element).backgroundImage), /radial-gradient/);
    const statistic = page.getByText('Other page statistic', {exact:true});
    await statistic.hover();
    await page.waitForFunction(() => document.querySelector('.stat-card[data-pointer-glow="true"]'));
    await page.getByText('Editor content', {exact:true}).hover();
    assert.equal(await page.locator('[data-pointer-glow="true"]').count(), 0, 'editor surfaces should remain unaffected');
    await page.goBack();
    await page.getByRole('article', { name:'Running Sessions',exact:true }).waitFor();
    assert.equal(await page.getByRole('button', { name:'7 days',exact:true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('Filter by project').inputValue(), 'p1');
    await page.waitForFunction((saved) => Math.abs(document.getElementById('main')!.scrollTop - saved) < 3, scroll, {timeout:5000}).catch(async () => {
      throw new Error(JSON.stringify(await page.evaluate((saved) => ({ saved, actual:document.getElementById('main')!.scrollTop, max:document.getElementById('main')!.scrollHeight-document.getElementById('main')!.clientHeight, storage:sessionStorage.getItem('portal:page:scroll') }), scroll)));
    });
    await page.getByRole('article', { name:'Running Sessions',exact:true }).hover();
    await page.waitForFunction(() => document.querySelector('.kpi-card[data-pointer-glow="true"]'));

    await page.clock.install();
    await page.getByRole('link', { name:'Create activity',exact:true }).click();
    const artifact = page.getByRole('article', { name:'Document: New guide' });
    await artifact.getByText('Generating…', {exact:true}).waitFor();
    assert.equal(await artifact.getByRole('button', { name:/Preview/ }).count(), 0);
    phase = 'ready';
    await page.clock.runFor(3100);
    await artifact.getByText('Ready', {exact:true}).waitFor();
    if (process.env.PORTAL_INTERACTION_SCREENSHOT) await page.screenshot({ path: process.env.PORTAL_INTERACTION_SCREENSHOT + '-artifact.png', animations: 'disabled' });
    assert.ok(await artifact.evaluate((el) => el.classList.contains('artifact-card--new')));
    assert.equal(await artifact.getByRole('link', { name:'Download Word' }).getAttribute('href'), '/api/projects/p1/generated-docs/d1/download?format=docx');
    await artifact.getByRole('button', { name:'Preview New guide' }).click();
    await page.getByRole('heading', { name:'Ready guide',exact:true }).waitFor();
    assert.equal(await page.evaluate(() => Boolean((window as any).bad)), false);
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name:'Other',exact:true }).click();
    await page.getByRole('link', { name:'Create activity',exact:true }).click();
    await artifact.waitFor();
    assert.equal(await artifact.evaluate((el) => el.classList.contains('artifact-card--new')), false, 'existing artifacts should not replay their reveal');

    phase = 'failed';
    await page.clock.runFor(5100);
    await artifact.getByText('Failed', {exact:true}).waitFor();
    assert.match(await artifact.innerText(), /missing source/);
    assert.equal(await artifact.getByRole('link', { name:'Download Word' }).count(), 0);

    await page.getByRole('link', { name:'Outputs',exact:true }).click();
    await page.locator('.run-outputs-card-item.is-new').waitFor();
    await page.getByRole('link', { name:'Other',exact:true }).click();
    await page.getByRole('link', { name:'Outputs',exact:true }).click();
    await page.getByRole('region', { name:'1 output file created' }).waitFor();
    assert.equal(await page.locator('.run-outputs-card-item.is-new').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
