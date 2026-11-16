/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';

// The real DCV client (web/vendor/agentcore-live-view/nice-dcv-web-client-sdk/dcv-ui/dcv-ui.js) does this when it connects:
//   document.title = props.customTitle || `${serverHostname} - Amazon DCV`
// The stub below does the same, so this test checks what the portal hands to it and what it leaves behind.
const DCV_STUB = `export default { LogLevel: { INFO: 1 }, setLogLevel() {}, authenticate(url, cb) { setTimeout(() => cb.success(null, [{ sessionId: 's1', authToken: 't1' }]), 0); } };`;
const DCV_UI_STUB = `
import { useEffect } from 'react';
export function DCVViewer(props) {
  useEffect(() => { document.title = props.dcv.customTitle || '127.0.0.1 - Amazon DCV'; window.__viewerMounted = true; }, []);
  return null;
}`;

test('the cloud browser live view keeps the portal tab title instead of "127.0.0.1 - Amazon DCV"', async () => {
  const bundled = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {BrowserLiveView} from './web/vendor/agentcore-live-view/BrowserLiveView.js';
        const root = createRoot(document.getElementById('root'));
        window.__show = () => root.render(<BrowserLiveView signedUrl="https://dcv.example.test/?authToken=x" />);
        window.__hide = () => root.render(null);`,
      resolveDir: process.cwd(), loader: 'jsx',
    },
    bundle: true, write: false, outfile: 'live-title.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'dcv-stubs',
      setup(b) {
        b.onResolve({ filter: /^(dcv|dcv-ui)$/ }, (a) => ({ path: a.path, namespace: 'dcv-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'dcv-stub' }, (a) => ({ contents: a.path === 'dcv' ? DCV_STUB : DCV_UI_STUB, loader: 'js', resolveDir: process.cwd() }));
      },
    }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://fixture.test/**', async (route) => {
      if (route.request().url().endsWith('.js')) await route.fulfill({ contentType: 'text/javascript', body: bundled.outputFiles[0].text });
      else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Agent Portal</title></head><body><div id="root"></div><script src="/live-title.js"></script></body></html>' });
    });
    await page.goto('http://fixture.test/');
    assert.equal(await page.title(), 'Agent Portal');

    await page.evaluate('window.__show()');
    // The viewer mounts once authentication succeeds; the stub then sets the title the way the real client does on connect.
    await page.waitForFunction('window.__viewerMounted === true', null, { timeout: 5000 });
    assert.equal(await page.title(), 'Agent Portal', 'the live view must not rename the portal tab');

    // Closing the live view puts the portal title back even if the client changed it.
    await page.evaluate('document.title = "127.0.0.1 - Amazon DCV"');
    await page.evaluate('window.__hide()');
    await page.waitForFunction('document.title === "Agent Portal"', null, { timeout: 3000 });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
  }
});
