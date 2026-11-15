/// <reference lib="dom" />
/**
 * The chat's message box takes files without the paperclip: drag files onto it, or paste an image or a file copied in the file
 * manager. Real page in Chromium (the same picker and message-box attributes the session page uses); the upload answers are stood in for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';

test('the message box takes dropped files and pasted files, and leaves ordinary text pastes alone', async () => {
  const entry = `import React, {useRef, useState} from 'react'; import {createRoot} from 'react-dom/client'; import {AttachmentPicker} from './web/src/components/AttachmentPicker.jsx'; import './web/src/styles/tokens.css'; import './web/src/styles/base.css'; import './web/src/styles/components.css'; import './web/src/styles/sessions.css';
function App() { const box = useRef(null); const input = useRef(null); const [ids, setIds] = useState([]);
  return <div><div ref={box} className="ws-composer" id="box" style={{ width: 600, height: 160 }}>
    <AttachmentPicker projectId="p1" fileInputRef={input} dropTargetRef={box} hideTrigger purpose="chat" onAttachmentsChange={(i) => setIds(i)} />
    <textarea id="msg" data-paste-files="true" style={{ width: 500, height: 60 }} /></div><output id="ids">{ids.join(',')}</output></div>; }
createRoot(document.getElementById('root')).render(<App />);`;
  const bundled = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, outfile: 'a.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', loader: { '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' } });
  const file = (ext: string) => bundled.outputFiles.find((f) => f.path.endsWith(ext))!;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const page = await (await browser.newContext()).newPage();
    const uploaded: string[] = [];
    let n = 0;
    await page.route('**/*', async (route) => {
      const req = route.request(); const u = req.url();
      if (u.endsWith('/ai-attachments/presign')) await route.fulfill({ status: 404, json: { error: 'no' } }); // this deployment uploads through the portal
      else if (u.endsWith('/ai-attachments') && req.method() === 'POST') {
        const m = /filename="([^"]+)"/.exec(req.postData() ?? '');
        uploaded.push(m?.[1] ?? '?');
        n++;
        await route.fulfill({ json: { attachment: { id: `att-${n}`, filename: m?.[1] ?? 'f', size: 3, mimeType: 'x', kind: 'document' } } });
      } else if (u.endsWith('/a.js')) await route.fulfill({ contentType: 'text/javascript', body: file('.js').text });
      else if (u.endsWith('/a.css')) await route.fulfill({ contentType: 'text/css', body: file('.css').text });
      else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/a.css"></head><body><div id="root"></div><script type="module" src="/a.js"></script></body></html>' });
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://localhost:4173/');
    await page.locator('#box').waitFor();
    const ids = async () => (await page.locator('#ids').innerText()).split(',').filter(Boolean);

    // Dragging files over the box says it will take them; dragging text does not.
    const dragFiles = (type: string, names: string[]) => page.evaluate(({ type, names }) => {
      const dt = new DataTransfer();
      for (const name of names) dt.items.add(new File(['abc'], name, { type: 'application/octet-stream' }));
      document.querySelector('#box')!.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, { type, names });
    await dragFiles('dragenter', ['sonarscan.zip']);
    assert.equal(await page.locator('#box.is-drop-target').count(), 1, 'the box shows it takes files');
    await page.evaluate(() => {
      const dt = new DataTransfer(); dt.setData('text/plain', 'just text');
      document.querySelector('#box')!.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await dragFiles('dragleave', ['sonarscan.zip']);
    assert.equal(await page.locator('#box.is-drop-target').count(), 0, 'and stops when the drag leaves');
    await page.evaluate(() => {
      const dt = new DataTransfer(); dt.setData('text/plain', 'just text');
      document.querySelector('#box')!.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    assert.equal(await page.locator('#box.is-drop-target').count(), 0, 'dragged text is not a file drop');

    // Drop a zip and a PDF: both are attached.
    await dragFiles('dragenter', ['sonarscan.zip', 'report.pdf']);
    await dragFiles('drop', ['sonarscan.zip', 'report.pdf']);
    await page.waitForFunction(() => document.querySelector('#ids')!.textContent!.split(',').filter(Boolean).length === 2);
    assert.deepEqual(uploaded.slice(0, 2), ['sonarscan.zip', 'report.pdf']);
    assert.equal(await page.locator('#box.is-drop-target').count(), 0, 'the highlight is gone after the drop');

    // Paste a file copied in the file manager (no text on the clipboard): taken. With text on the clipboard: an ordinary paste.
    const paste = (files: string[], text?: string) => page.evaluate(({ files, text }) => {
      const dt = new DataTransfer();
      for (const name of files) dt.items.add(new File(['abc'], name, { type: name.endsWith('.png') ? 'image/png' : 'application/zip' }));
      if (text) dt.setData('text/plain', text);
      const ta = document.querySelector('#msg') as HTMLTextAreaElement;
      ta.focus();
      return !ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    }, { files, text });
    const before = uploaded.length;
    assert.equal(await paste(['scan.zip']), true, 'a pasted file is handled (default prevented)');
    await page.waitForFunction((b) => document.querySelector('#ids')!.textContent!.split(',').filter(Boolean).length === b, 3);
    assert.equal(uploaded.length, before + 1);
    assert.equal(uploaded.at(-1), 'scan.zip');
    assert.equal(await paste(['page.png'], 'copied from a web page'), false, 'text with an image on the clipboard stays an ordinary paste');
    assert.equal(uploaded.length, before + 1, 'nothing was uploaded for it');
    assert.equal((await ids()).length, 3);

    // A type the portal does not take is refused, not uploaded.
    await dragFiles('drop', ['setup.exe']);
    // The message is in the visible alert and again in a screen-reader live region: wait for the visible one only.
    await page.getByRole('alert').filter({ hasText: /setup\.exe: file type not allowed/ }).waitFor();
    assert.equal(uploaded.length, before + 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
