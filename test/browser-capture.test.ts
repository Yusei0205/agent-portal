/**
 * Screenshots with numbered boxes and sign-in with a test account (server/agent/runner-browser-capture.ts), driven by a fake page.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  capturePath, parseHighlights, capture, captureSummary, parseAccounts, hostAllowed, signIn, OVERLAY_SOURCE, REMOVE_OVERLAY_SOURCE,
  type CapturePage, type CaptureLocator,
} from '../server/agent/runner-browser-capture.ts';

interface El { box?: { x: number; y: number; width: number; height: number }; text?: string; visible?: boolean; attrs?: Record<string, string>; throwOnFill?: boolean; onClick?: () => void }

/** A page with elements named by selector or text. Records what was typed, clicked and drawn. */
function fakePage(elements: Record<string, El>, url = 'https://app.example.com/login') {
  const log = { fills: [] as Array<[string, string]>, clicks: [] as string[], presses: [] as string[], evaluated: [] as string[], url };
  const loc = (key: string): CaptureLocator => {
    const el = elements[key];
    const self: CaptureLocator = {
      first: () => self,
      count: async () => (el ? 1 : 0),
      isVisible: async () => Boolean(el && el.visible !== false),
      scrollIntoViewIfNeeded: async () => undefined,
      boundingBox: async () => el?.box ?? null,
      innerText: async () => el?.text ?? '',
      getAttribute: async (n) => el?.attrs?.[n] ?? null,
      fill: async (v) => { if (el?.throwOnFill) throw new Error(`locator.fill("${v}"): Timeout 30000ms exceeded.\n  - waiting for element`); log.fills.push([key, v]); },
      click: async () => { log.clicks.push(key); el?.onClick?.(); },
      press: async (k) => { log.presses.push(`${key}:${k}`); },
    };
    return self;
  };
  const page: CapturePage = {
    url: () => log.url,
    locator: (s) => loc(`sel:${s}`),
    getByText: (t) => loc(`text:${t}`),
    evaluate: async (expr) => { log.evaluated.push(expr); return expr.includes('innerWidth') ? { w: 1280, h: 720 } : true; },
    screenshot: async () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 7)]),
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  };
  return { page, log };
}

describe('capture', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('accepts only .png files inside screenshots/', () => {
    assert.deepEqual(Object.keys(capturePath(dir, 'screenshots/01-login.png')), ['rel', 'abs']);
    assert.ok('rel' in capturePath(dir, 'screenshots/tasks/02 add user.png'));
    for (const bad of ['01.png', 'screenshots/../x.png', '/etc/x.png', 'screenshots/x.jpg', 'screenshots/.hidden.png', 'other/x.png', '', 5, 'screenshots/' + 'a'.repeat(200) + '.png', 'C:\\x.png']) {
      assert.ok('error' in capturePath(dir, bad), String(bad));
    }
  });

  it('reads highlights: a selector or text each, a label, at most twelve', () => {
    assert.deepEqual(parseHighlights(undefined), { items: [] });
    assert.deepEqual(parseHighlights([{ selector: '#save', label: 'Save' }, { text: 'Add user' }]), { items: [{ selector: '#save', label: 'Save' }, { text: 'Add user' }] });
    assert.ok('error' in parseHighlights([{ label: 'x' }]));
    assert.ok('error' in parseHighlights('nope'));
    assert.ok('error' in parseHighlights(Array.from({ length: 13 }, () => ({ selector: 'a' }))));
  });

  it('saves the picture with numbered boxes in the order given, and removes the boxes after', async () => {
    const { page, log } = fakePage({
      'sel:#save': { box: { x: 400, y: 300, width: 80, height: 32 }, text: 'Save' },
      'text:Add user': { box: { x: 10, y: 10, width: 100, height: 30 }, text: 'Add user' },
    });
    const r = await capture(page, dir, { file: 'screenshots/03-add-user.png', highlights: [{ text: 'Add user' }, { selector: '#save', label: 'Save the user' }] });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(fs.existsSync(path.join(dir, 'screenshots', '03-add-user.png')));
    assert.deepEqual(r.boxes, [{ n: 1, label: 'Add user', inView: true }, { n: 2, label: 'Save the user', inView: true }]);
    const draw = log.evaluated.find((e) => e.startsWith(OVERLAY_SOURCE));
    assert.ok(draw, 'the boxes are drawn');
    assert.deepEqual(JSON.parse(draw!.slice(OVERLAY_SOURCE.length + 1, -1)), [{ x: 10, y: 10, w: 100, h: 30 }, { x: 400, y: 300, w: 80, h: 32 }]);
    assert.equal(log.evaluated.at(-1), REMOVE_OVERLAY_SOURCE, 'and taken out again');
    const text = captureSummary(r);
    assert.match(text, /Saved screenshots\/03-add-user\.png/);
    assert.match(text, /1: Add user/);
    assert.match(text, /2: Save the user/);
  });

  it('saves nothing when a highlight is not on the page, and says which', async () => {
    const { page } = fakePage({ 'sel:#save': { box: { x: 1, y: 1, width: 5, height: 5 } } });
    const r = await capture(page, dir, { file: 'screenshots/x.png', highlights: [{ selector: '#save' }, { selector: '#nope' }] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /highlight 2 \(selector #nope\)/);
    assert.equal(fs.existsSync(path.join(dir, 'screenshots')), false);
  });

  it('says so when an element is not visible or lies outside the picture', async () => {
    const { page } = fakePage({ 'sel:#hidden': { box: undefined }, 'sel:#below': { box: { x: 10, y: 900, width: 50, height: 20 }, text: 'Below' } });
    const hidden = await capture(page, dir, { file: 'screenshots/h.png', highlights: [{ selector: '#hidden' }] });
    assert.equal(hidden.ok, false);
    const below = await capture(page, dir, { file: 'screenshots/b.png', highlights: [{ selector: '#below' }] });
    assert.ok(below.ok);
    if (below.ok) { assert.equal(below.boxes[0].inView, false); assert.match(captureSummary(below), /outside the visible area/); }
  });

  it('takes a plain screenshot when there is nothing to highlight, and refuses a bad path', async () => {
    const { page, log } = fakePage({});
    const r = await capture(page, dir, { file: 'screenshots/plain.png' });
    assert.ok(r.ok);
    assert.equal(log.evaluated.some((e) => e.startsWith(OVERLAY_SOURCE)), false);
    const bad = await capture(page, dir, { file: '../x.png' });
    assert.equal(bad.ok, false);
  });
});

describe('sign in', () => {
  const accounts = [{ role: 'Admin', username: 'admin@test.example', password: 'S3cret-Admin!' }, { role: 'Staff', username: 'staff@test.example', password: 'Staff-Pass-1' }];
  const state = { accounts, hosts: ['example.com'] };

  it('parses accounts and hosts, dropping what is malformed or repeated', () => {
    const r = parseAccounts([{ role: 'A', username: 'u', password: 'p' }, { role: 'a', username: 'u2', password: 'p2' }, { role: '', username: 'u', password: 'p' }, { role: 'B', username: 'u' }, 'x'], ['Example.com', 'bad host!', 'example.com']);
    assert.deepEqual(r.accounts, [{ role: 'A', username: 'u', password: 'p' }]);
    assert.deepEqual(r.hosts, ['example.com']);
    assert.deepEqual(parseAccounts(undefined, undefined), { accounts: [], hosts: [] });
  });

  it('allows a host and its subdomains only', () => {
    assert.equal(hostAllowed('https://example.com/x', ['example.com']), true);
    assert.equal(hostAllowed('https://app.example.com/x', ['example.com']), true);
    assert.equal(hostAllowed('https://evilexample.com/x', ['example.com']), false);
    assert.equal(hostAllowed('https://example.com.evil.test/x', ['example.com']), false);
    assert.equal(hostAllowed('not a url', ['example.com']), false);
  });

  it('types the username and password and submits, never repeating them in the answer', async () => {
    const { page, log } = fakePage({
      'sel:input[type="password"]': {},
      'sel:input[type="email"]': {},
      'sel:button[type="submit"]': {},
    });
    const r = await signIn(page, state, { role: 'admin' });
    assert.equal(r.ok, true);
    assert.deepEqual(log.fills, [['sel:input[type="email"]', 'admin@test.example'], ['sel:input[type="password"]', 'S3cret-Admin!']]);
    assert.deepEqual(log.clicks, ['sel:button[type="submit"]']);
    assert.match(r.message, /"Admin" account/);
    assert.doesNotMatch(r.message, /S3cret|admin@test/);
  });

  it('presses Enter when the form has no submit button, and handles a two-step form', async () => {
    const one = fakePage({ 'sel:input[type="password"]': {}, 'sel:input[type="text"]': {} });
    assert.equal((await signIn(one.page, state, { role: 'Staff' })).ok, true);
    assert.deepEqual(one.log.presses, ['sel:input[type="password"]:Enter']);

    // Two steps: the username screen has no password field; the password appears after "continue".
    const els: Record<string, El> = {
      'sel:input[type="email"]': {},
      'sel:button[type="submit"]': { onClick: () => { els['sel:input[type="password"]'] = {}; } },
    };
    const two = fakePage(els);
    const r = await signIn(two.page, state, { role: 'Admin' });
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(two.log.fills.map(([, v]) => v), ['admin@test.example', 'S3cret-Admin!']);
    assert.equal(two.log.clicks.length, 2, 'continue, then sign in');
  });

  it('refuses a page outside the allowed hosts, and a missing or unknown role', async () => {
    const off = fakePage({ 'sel:input[type="password"]': {} }, 'https://evil.test/login');
    const r = await signIn(off.page, state, { role: 'Admin' });
    assert.equal(r.ok, false);
    assert.match(r.message, /only allowed on example\.com/);
    assert.equal(off.log.fills.length, 0);

    const on = fakePage({ 'sel:input[type="password"]': {} });
    const none = await signIn(on.page, state, {});
    assert.equal(none.ok, false);
    assert.match(none.message, /Roles: Admin, Staff/);
    assert.doesNotMatch(none.message, /S3cret|Staff-Pass/);
    assert.equal((await signIn(on.page, { accounts: [], hosts: ['example.com'] }, { role: 'Admin' })).ok, false);
    assert.equal((await signIn(fakePage({}).page, state, { role: 'Admin' })).ok, false);
  });

  it('does not let a Playwright error carry the typed password to the model', async () => {
    const { page } = fakePage({ 'sel:input[type="password"]': { throwOnFill: true }, 'sel:input[type="email"]': {} });
    const r = await signIn(page, state, { role: 'Admin' });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.message, /S3cret-Admin!/);
    assert.match(r.message, /\*\*\*/);
  });
});
