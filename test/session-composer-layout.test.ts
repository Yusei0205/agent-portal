/// <reference lib="dom" />
/**
 * The session message box: the notice above it never sits on the input row, however small the dragged height is; the
 * attach button, prompt, send button and the text line up; and a pasted screenshot becomes an attachment while pasted
 * text stays plain text.
 */
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';

test('composer layout and paste', async () => {
  // This test opens the real page, so it needs the built web app. CI runs the tests before its Build step.
  if (!fs.existsSync(path.join(process.cwd(), 'dist', 'web', 'index.html'))) {
    execFileSync(process.execPath, ['scripts/build.mjs', '--web-only'], { stdio: 'inherit', timeout: 180_000 });
  }
  const { baseUrl } = await createTestServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const cookie = (await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'composer@example.com', name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie!;
    const pid = ((await fetchJson(baseUrl, '/api/projects', { cookie, body: { name: 'Composer' } })).body as any).project.id;
    const wid = ((await fetchJson(baseUrl, `/api/projects/${pid}/workflows`, { cookie, body: { goal: '', engine: 'demo' } })).body as any).workflow.id;
    // The state of the report: the agent finished and waits for the person ("Ready. Send a message to continue…").
    getDb().prepare("UPDATE p6_workflows SET stop_reason = 'awaiting_message', status = 'done' WHERE id = ?").run(wid);

    const context = await browser.newContext({ viewport: { width: 1600, height: 600 } });
    const pair = cookie.split(';')[0]; const eq = pair.indexOf('=');
    await context.addCookies([{ name: pair.slice(0, eq), value: pair.slice(eq + 1), url: baseUrl }]);
    // A message box the person once dragged down to its smallest size.
    await context.addInitScript(() => localStorage.setItem('ide_composer_height', '48'));
    const page = await context.newPage();
    await page.goto(`${baseUrl}/#/p/${pid}/sessions/${wid}`);
    const input = page.locator('textarea.ws-composer-input');
    await input.waitFor({ timeout: 20000 });
    const banner = page.getByText('Ready. Send a message to continue this conversation.');
    await banner.waitFor();

    const rect = (sel: string) => page.evaluate((s) => { const r = document.querySelector(s)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, mid: (r.top + r.bottom) / 2 }; }, sel);
    const bannerBox = await banner.evaluate((el) => { const r = (el.closest('.ide-idle-banner') as HTMLElement).getBoundingClientRect(); return { bottom: r.bottom }; });
    const row = await rect('.ws-composer-row');
    assert.ok(bannerBox.bottom <= row.top + 1, `the notice (bottom ${bannerBox.bottom}) must end above the input row (top ${row.top})`);

    const attach = await rect('.ws-composer-row > .btn-icon');
    const prompt = await rect('.ws-composer-prompt');
    const text = await rect('textarea.ws-composer-input');
    const send = await rect('.ws-composer-actions .btn');
    assert.ok(attach.right <= prompt.left && prompt.right <= text.left, 'attach, prompt and textarea sit side by side, none over another');
    assert.ok(Math.abs(send.mid - text.mid) <= 2, `the send button is vertically centred on the text line (${send.mid} vs ${text.mid})`);
    assert.ok(Math.abs(attach.mid - text.mid) <= 2, 'the attach button is too');
    assert.ok(Math.abs(prompt.mid - text.mid) <= 2, 'and the prompt');

    // Paste: text stays text; an image on its own becomes an attachment.
    await input.focus();
    const pasted = await page.evaluate(() => {
      const el = document.querySelector('textarea.ws-composer-input') as HTMLTextAreaElement;
      const text = new DataTransfer(); text.setData('text/plain', 'hello from the clipboard');
      const textEvent = new ClipboardEvent('paste', { clipboardData: text, bubbles: true, cancelable: true });
      el.dispatchEvent(textEvent);
      const png = new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))], '', { type: 'image/png' });
      const image = new DataTransfer(); image.items.add(png);
      const imageEvent = new ClipboardEvent('paste', { clipboardData: image, bubbles: true, cancelable: true });
      el.dispatchEvent(imageEvent);
      const mixed = new DataTransfer(); mixed.setData('text/plain', 'a table copied from Word'); mixed.items.add(png);
      const mixedEvent = new ClipboardEvent('paste', { clipboardData: mixed, bubbles: true, cancelable: true });
      el.dispatchEvent(mixedEvent);
      return { textPrevented: textEvent.defaultPrevented, imagePrevented: imageEvent.defaultPrevented, mixedPrevented: mixedEvent.defaultPrevented };
    });
    assert.equal(pasted.textPrevented, false, 'pasting text is left to the browser');
    assert.equal(pasted.imagePrevented, true, 'a pasted screenshot is taken as an attachment');
    assert.equal(pasted.mixedPrevented, false, 'text plus an image (copied from Word or a page) is still a text paste');
    await page.getByText('pasted-image.png').waitFor({ timeout: 10000 });
  } finally { await browser.close(); await cleanup(); }
});
