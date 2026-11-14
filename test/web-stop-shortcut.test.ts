/// <reference lib="dom" />
/**
 * Esc or Ctrl+C stops the running turn (like the terminal agents), but Ctrl+C still copies when something is selected,
 * and nothing happens when no turn is running or a dialog is open. The decision is unit-tested; the hook is exercised in real Chromium.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
// @ts-expect-error — plain JS module without type declarations
import { shouldStopOnKey } from '../web/src/lib/useStopShortcut.js';

const key = (k: string, mods: Record<string, boolean> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, isComposing: false, repeat: false, ...mods });
const run = { running: true };

describe('shouldStopOnKey', () => {
  it('Esc and Ctrl+C stop a running turn', () => {
    assert.equal(shouldStopOnKey(key('Escape'), run), true);
    assert.equal(shouldStopOnKey(key('c', { ctrlKey: true }), run), true);
    assert.equal(shouldStopOnKey(key('C', { ctrlKey: true }), run), true, 'caps lock');
  });
  it('nothing happens when no turn is running', () => {
    assert.equal(shouldStopOnKey(key('Escape'), { running: false }), false);
    assert.equal(shouldStopOnKey(key('c', { ctrlKey: true }), { running: false }), false);
  });
  it('Ctrl+C is left alone when there is something to copy', () => {
    assert.equal(shouldStopOnKey(key('c', { ctrlKey: true }), { ...run, selectionText: 'copy me' }), false);
    assert.equal(shouldStopOnKey(key('c', { ctrlKey: true }), { ...run, inputSelected: true }), false);
    assert.equal(shouldStopOnKey(key('Escape'), { ...run, selectionText: 'copy me' }), true, 'Esc does not copy');
    assert.equal(shouldStopOnKey(key('Escape'), { ...run, plainFocus: false }), false, 'Esc from a control (a menu, a button) is not ours');
    assert.equal(shouldStopOnKey(key('c', { ctrlKey: true }), { ...run, plainFocus: false }), true, 'Ctrl+C is not tied to the focus');
  });
  it('other keys, other modifiers, menus, dialogs and key repeat do not stop it', () => {
    for (const e of [key('c'), key('c', { metaKey: true }), key('c', { ctrlKey: true, shiftKey: true }), key('x', { ctrlKey: true }), key('Escape', { ctrlKey: true }), key('Enter')]) assert.equal(shouldStopOnKey(e, run), false, JSON.stringify(e));
    assert.equal(shouldStopOnKey(key('Escape', { defaultPrevented: true }), run), false, 'a menu already used it');
    assert.equal(shouldStopOnKey(key('Escape'), { ...run, dialogOpen: true }), false);
    assert.equal(shouldStopOnKey(key('Escape', { isComposing: true }), run), false);
    assert.equal(shouldStopOnKey(key('Escape', { repeat: true }), run), false);
  });
});

test('in a real page: Esc and Ctrl+C stop the turn, Ctrl+C copies a selection instead, a dialog blocks it', async () => {
  const entry = `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client'; import {useStopShortcut} from './web/src/lib/useStopShortcut.js';
function App() { const [running, setRunning] = useState(true); const [stops, setStops] = useState(0); const [dlg, setDlg] = useState(false);
  useStopShortcut(running, () => setStops((n) => n + 1));
  return <div><textarea id="composer" defaultValue="hello world" /><p id="para">some text to copy</p><button id="toggle" onClick={() => setRunning((r) => !r)}>toggle</button><button id="dlg" onClick={() => setDlg(true)}>dialog</button>
    {dlg && <div role="dialog" aria-modal="true">open</div>}<output id="out">{stops}</output></div>; }
createRoot(document.getElementById('root')).render(<App />);`;
  const bundled = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, outfile: 's.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const js = bundled.outputFiles[0].text;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.route('**/*', (r) => (r.request().url().endsWith('/s.js')
      ? r.fulfill({ contentType: 'text/javascript', body: js })
      : r.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div><script type="module" src="/s.js"></script>' })));
    await page.goto('http://portal.test/');
    const stops = async () => Number(await page.locator('#out').innerText());

    await page.locator('#composer').click();                       // typing in the composer
    await page.keyboard.press('Escape');
    assert.equal(await stops(), 1, 'Esc stops, even from the composer');
    await page.keyboard.press('Control+c');
    assert.equal(await stops(), 2, 'Ctrl+C with nothing selected stops');

    await page.locator('#composer').selectText();                  // text selected in the composer: Ctrl+C is copy
    await page.keyboard.press('Control+c');
    assert.equal(await stops(), 2, 'Ctrl+C copies the selection in the composer');
    await page.locator('#para').selectText();                      // text selected on the page
    await page.keyboard.press('Control+c');
    assert.equal(await stops(), 2, 'Ctrl+C copies the selected page text');

    await page.locator('#dlg').click();                            // focus is on a button, and a dialog is open
    await page.keyboard.press('Escape');
    assert.equal(await stops(), 2, 'a dialog keeps Esc for itself');

    await page.locator('#toggle').click();                         // the turn ended
    await page.locator('#composer').click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+c');
    assert.equal(await stops(), 2, 'no running turn: nothing to stop');
  } finally { await browser.close(); }
});
