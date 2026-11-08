/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('review findings retain full details, filter by text/severity/dismissal, and identify incomplete reviews', async () => {
  const bundle = await build({ stdin: { contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {FindingsPanel} from './web/src/pages/Review.jsx'; function App(){const [status,setStatus]=useState('running');return <><button onClick={()=>setStatus('failed')}>Mark incomplete</button><FindingsPanel projectId="p" review={{id:'r',status,post_mode:'draft'}} isAdmin={false}/></>} createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const body = 'Long detail '.repeat(300) + '\nSuggested fix: resolution';
    await page.route('http://portal.test/**', async route => {
      const url = route.request().url();
      if (url.endsWith('/fixture.js')) await route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
      else if (url.includes('/api/')) await route.fulfill({ json: { findings: [
        { id: 'f1', file_path: 'src/api.ts', line_number: 12, severity: 'high', title: 'API issue', body, accepted: 0 },
        { id: 'f2', file_path: 'src/web.ts', severity: 'info', title: 'Web issue', body: 'Other detail', accepted: -1 },
      ] } });
      else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    });
    await page.goto('http://portal.test/');
    await page.getByText('Showing 2 of 2 findings').waitFor();
    assert.ok((await page.locator('.finding-item-high').textContent())!.includes(body));
    await page.getByLabel('Search findings').fill('resolution');
    await page.getByText('Showing 1 of 2 findings').waitFor();
    await page.getByLabel('Severity', { exact: true }).selectOption('low');
    await page.getByText('No findings match these filters.').waitFor();
    await page.getByLabel('Search findings').fill('');
    await page.getByLabel('Severity', { exact: true }).selectOption('all');
    await page.getByLabel('Show dismissed').uncheck();
    assert.equal(await page.locator('.finding-item').count(), 1);
    await page.getByRole('button', { name: 'Mark incomplete' }).click();
    await page.getByText('The assessment did not finish.', { exact: false }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
