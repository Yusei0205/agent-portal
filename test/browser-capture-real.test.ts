/// <reference lib="dom" />
/**
 * The screenshot and sign-in tools against a real Chromium page: a small web app with a sign-in form and a page of buttons.
 * Checks that the numbered boxes are really in the PNG (red pixels where the elements are, none without highlights), that the
 * boxes are gone from the page afterwards, and that sign_in types a test account into a real form without ever returning it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { capture, signIn, type CapturePage } from '../server/agent/runner-browser-capture.ts';

const LOGIN = `<!doctype html><html><body style="font-family:sans-serif;margin:40px"><h1>Acme sign in</h1>
<form method="post" action="/login"><label>Email <input name="email" type="email"></label><br><br>
<label>Password <input name="password" type="password"></label><br><br><button type="submit">Sign in</button></form></body></html>`;
const HOME = (who: string) => `<!doctype html><html><body style="font-family:sans-serif;margin:40px"><h1>Welcome ${who}</h1>
<button id="add" style="margin:20px;padding:12px 24px">Add user</button>
<button id="export" style="margin:20px;padding:12px 24px">Export</button>
<div style="height:2000px"></div><button id="far" style="padding:12px 24px">Far below</button></body></html>`;

/** Width, height and RGB(A) rows of an 8-bit non-interlaced PNG (what Chromium writes). */
function decodePng(buf: Buffer): { width: number; height: number; channels: number; pixels: Buffer } {
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20), colorType = buf[25];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(channels, `colour type ${colorType}`);
  const idat: Buffer[] = [];
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i), type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + x] = (v + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth)) & 255;
    }
  }
  return { width, height, channels, pixels: out };
}

const isRed = (p: Buffer, i: number): boolean => Math.abs(p[i] - 225) < 12 && Math.abs(p[i + 1] - 29) < 12 && Math.abs(p[i + 2] - 72) < 12;
function redPixels(png: ReturnType<typeof decodePng>, box?: { x: number; y: number; w: number; h: number }): number {
  let n = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (box && (x < box.x - 20 || x > box.x + box.w + 20 || y < box.y - 20 || y > box.y + box.h + 20)) continue;
      if (isRed(png.pixels, (y * png.width + x) * png.channels)) n++;
    }
  }
  return n;
}

test('capture draws numbered boxes into the picture and removes them; sign_in types a test account into a real form', async () => {
  const typed: Array<{ email: string; password: string }> = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/login') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        typed.push({ email: form.get('email') ?? '', password: form.get('password') ?? '' });
        res.writeHead(303, { location: '/home', 'set-cookie': 'sid=1; Path=/' }).end();
      });
    } else if (req.url === '/home') res.writeHead(200, { 'content-type': 'text/html' }).end(HOME('back'));
    else res.writeHead(200, { 'content-type': 'text/html' }).end(LOGIN);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-real-'));
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
    const cap = page as unknown as CapturePage;

    // Sign in: the form is found and filled, the account never comes back in the answer.
    await page.goto(`${base}/`);
    const account = { role: 'Admin', username: 'admin@test.example', password: 'S3cret-Admin!' };
    const refused = await signIn(cap, { accounts: [account], hosts: ['example.com'] }, { role: 'Admin' });
    assert.equal(refused.ok, false, '127.0.0.1 is not an allowed host');
    assert.equal(typed.length, 0, 'nothing was typed on a host that is not allowed');
    const done = await signIn(cap, { accounts: [account], hosts: ['127.0.0.1'] }, { role: 'admin' });
    assert.equal(done.ok, true, done.message);
    assert.doesNotMatch(done.message, /S3cret|admin@test/);
    assert.deepEqual(typed, [{ email: 'admin@test.example', password: 'S3cret-Admin!' }]);
    assert.match(page.url(), /\/home$/);
    await page.getByText('Welcome back').waitFor();

    // A plain screenshot has no red; one with highlights has red boxes right where the elements are.
    const plain = await capture(cap, work, { file: 'screenshots/01-home.png' });
    assert.ok(plain.ok);
    const plainPng = decodePng(fs.readFileSync(path.join(work, 'screenshots', '01-home.png')));
    assert.equal(redPixels(plainPng), 0, 'no boxes without highlights');

    const add = await page.locator('#add').boundingBox();
    const exp = await page.locator('#export').boundingBox();
    const shot = await capture(cap, work, { file: 'screenshots/02-actions.png', highlights: [{ selector: '#add', label: 'Add user' }, { text: 'Export' }] });
    assert.ok(shot.ok, shot.ok ? '' : shot.error);
    if (!shot.ok) return;
    assert.deepEqual(shot.boxes, [{ n: 1, label: 'Add user', inView: true }, { n: 2, label: 'Export', inView: true }]);
    const png = decodePng(fs.readFileSync(path.join(work, 'screenshots', '02-actions.png')));
    assert.deepEqual([png.width, png.height], [900, 600]);
    const around = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
    assert.ok(redPixels(png, around(add!)) > 150, 'a red box around Add user');
    assert.ok(redPixels(png, around(exp!)) > 150, 'a red box around Export');
    assert.equal(await page.locator('[data-portal-capture]').count(), 0, 'the boxes are removed from the page afterwards');

    // An element below the fold is scrolled to, so it can be boxed; a missing one saves nothing.
    const far = await capture(cap, work, { file: 'screenshots/03-far.png', highlights: [{ selector: '#far' }] });
    assert.ok(far.ok, far.ok ? '' : far.error);
    if (far.ok) assert.equal(far.boxes[0].inView, true);
    const missing = await capture(cap, work, { file: 'screenshots/04-missing.png', highlights: [{ selector: '#add' }, { selector: '#nope' }] });
    assert.equal(missing.ok, false);
    assert.equal(fs.existsSync(path.join(work, 'screenshots', '04-missing.png')), false);
    if (process.env.SHOT_DIR) fs.copyFileSync(path.join(work, 'screenshots', '02-actions.png'), path.join(process.env.SHOT_DIR, 'capture-real.png'));
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});
