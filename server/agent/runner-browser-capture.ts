/**
 * Screenshots with numbered boxes, and sign-in with a test account, for the AgentCore browser tools (user guides).
 *
 * Pure Node code (no portal imports, no Playwright import): the agent-runner and kiro-runner images COPY this file into their
 * build (as shared/runner-browser-capture.ts) and browser-tools.ts calls it with the real Playwright page. The page is described
 * by the small structural types below, so the tests drive it with a fake.
 *
 * capture: highlights elements the agent names (CSS selector or visible text) with a red box and a number (1, 2, 3 in the order
 *   given, the order of the steps in the guide), takes a PNG and saves it in the run folder under screenshots/. The boxes are drawn
 *   into the page just for the picture and removed afterwards.
 * signIn: types a test account's username and password into the page's sign-in form. The model never sees the password: it names
 *   a role, the runner holds the accounts. It only works on the hosts the person allowed, so a page that was opened by following
 *   an untrusted link cannot ask for the credentials.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── The part of a Playwright page this module uses ──────────────────────────────────────────────────────────

export interface CaptureLocator {
  first(): CaptureLocator;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  scrollIntoViewIfNeeded(): Promise<void>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  innerText(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  fill(value: string): Promise<void>;
  click(): Promise<void>;
  press(key: string): Promise<void>;
}

export interface CapturePage {
  url(): string;
  locator(selector: string): CaptureLocator;
  getByText(text: string, options?: { exact?: boolean }): CaptureLocator;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: { type: 'png'; fullPage?: boolean }): Promise<Buffer>;
  waitForLoadState(state: 'load' | 'networkidle' | 'domcontentloaded', options?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
}

export const CAPTURE_LIMITS = { highlights: 12, labelChars: 80, selectorChars: 300, fileChars: 120, accounts: 20, fieldChars: 200, hosts: 10, pngBytes: 9 * 1024 * 1024 };

// ── Screenshots ─────────────────────────────────────────────────────────────────────────────────────────

/** Where a screenshot goes: screenshots/<name>.png inside the run folder. Anything else is refused. */
export function capturePath(workDir: string, file: unknown): { rel: string; abs: string } | { error: string } {
  if (typeof file !== 'string' || !file.trim()) return { error: 'Give a file name such as screenshots/01-login.png.' };
  const rel = path.posix.normalize(file.trim().replace(/\\/g, '/'));
  if (rel.length > CAPTURE_LIMITS.fileChars || !/^screenshots\/[A-Za-z0-9][A-Za-z0-9 _.\-/]*\.png$/.test(rel) || rel.split('/').some((s) => s === '..' || s === '')) {
    return { error: 'The file must be a .png inside screenshots/, for example screenshots/01-login.png (letters, digits, space, - _ . and / only).' };
  }
  const root = path.resolve(workDir);
  const abs = path.resolve(root, ...rel.split('/'));
  return abs.startsWith(root + path.sep) ? { rel, abs } : { error: 'The file must stay inside the run folder.' };
}

export interface Highlight { selector?: string; text?: string; label?: string }

export function parseHighlights(raw: unknown): { items: Highlight[] } | { error: string } {
  if (raw === undefined || raw === null) return { items: [] };
  if (!Array.isArray(raw)) return { error: 'highlights must be a list of { selector or text, label? }.' };
  if (raw.length > CAPTURE_LIMITS.highlights) return { error: `At most ${CAPTURE_LIMITS.highlights} highlights in one screenshot.` };
  const items: Highlight[] = [];
  for (const [i, h] of raw.entries()) {
    const o = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
    const selector = typeof o.selector === 'string' ? o.selector.trim() : '';
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!selector && !text) return { error: `Highlight ${i + 1} needs a selector or the visible text of the element.` };
    if (selector.length > CAPTURE_LIMITS.selectorChars || text.length > CAPTURE_LIMITS.selectorChars) return { error: `Highlight ${i + 1} is too long.` };
    const label = typeof o.label === 'string' ? o.label.trim().slice(0, CAPTURE_LIMITS.labelChars) : '';
    items.push({ ...(selector ? { selector } : { text }), ...(label ? { label } : {}) });
  }
  return { items };
}

/** Draws the boxes into the page. Source text, not a function: Playwright serialises a function, and a bundler can rewrite it. */
export const OVERLAY_SOURCE = `(function (items) {
  var root = document.createElement('div');
  root.setAttribute('data-portal-capture', '1');
  root.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  var sx = window.scrollX, sy = window.scrollY;
  items.forEach(function (it, i) {
    var box = document.createElement('div');
    box.style.cssText = 'position:absolute;box-sizing:border-box;left:' + (it.x + sx) + 'px;top:' + (it.y + sy) + 'px;width:' + it.w + 'px;height:' + it.h + 'px;border:3px solid #e11d48;border-radius:6px;box-shadow:0 0 0 2px rgba(255,255,255,.9),0 0 10px rgba(225,29,72,.5)';
    var badge = document.createElement('div');
    badge.textContent = String(i + 1);
    var bl = it.x < 16 ? 2 : -14, bt = it.y < 16 ? 2 : -14;
    badge.style.cssText = 'position:absolute;left:' + bl + 'px;top:' + bt + 'px;min-width:26px;height:26px;padding:0 4px;box-sizing:border-box;border-radius:13px;background:#e11d48;color:#fff;font:700 15px/26px Arial,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff';
    box.appendChild(badge);
    root.appendChild(box);
  });
  document.body.appendChild(root);
  return true;
})`;

export const REMOVE_OVERLAY_SOURCE = `(function () { document.querySelectorAll('[data-portal-capture]').forEach(function (e) { e.remove(); }); return true; })()`;

export interface CaptureBox { n: number; label: string; inView: boolean }
export type CaptureResult = { ok: true; rel: string; bytes: number; png: Buffer; boxes: CaptureBox[] } | { ok: false; error: string };

function locate(page: CapturePage, h: Highlight): CaptureLocator {
  return (h.selector ? page.locator(h.selector) : page.getByText(h.text ?? '', { exact: false })).first();
}

async function describe(loc: CaptureLocator, h: Highlight): Promise<string> {
  if (h.label) return h.label;
  const text = (await loc.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, CAPTURE_LIMITS.labelChars);
  return ((await loc.getAttribute('aria-label').catch(() => null)) ?? (await loc.getAttribute('placeholder').catch(() => null)) ?? (await loc.getAttribute('title').catch(() => null)) ?? '').slice(0, CAPTURE_LIMITS.labelChars);
}

/**
 * Takes the screenshot and saves it. Every highlight must be found: a missing one makes no file at all, so the numbers in a guide
 * never point at a box that is not there. A highlight outside the picture is reported (`inView: false`) so the agent can scroll.
 */
export async function capture(
  page: CapturePage,
  workDir: string,
  args: { file?: unknown; highlights?: unknown; full_page?: unknown },
): Promise<CaptureResult> {
  const target = capturePath(workDir, args.file);
  if ('error' in target) return { ok: false, error: target.error };
  const parsed = parseHighlights(args.highlights);
  if ('error' in parsed) return { ok: false, error: parsed.error };

  const located: Array<{ h: Highlight; loc: CaptureLocator }> = [];
  const missing: string[] = [];
  for (const [i, h] of parsed.items.entries()) {
    const loc = locate(page, h);
    if ((await loc.count().catch(() => 0)) === 0) missing.push(`${i + 1} (${h.selector ? `selector ${h.selector}` : `text "${h.text}"`})`);
    else located.push({ h, loc });
  }
  if (missing.length) return { ok: false, error: `Nothing was saved. Not found on this page: highlight ${missing.join(', ')}. Use snapshot or get_text to find the right selector or text.` };

  if (located.length) await located[0].loc.scrollIntoViewIfNeeded().catch(() => undefined);
  const viewport = (await page.evaluate('({ w: window.innerWidth, h: window.innerHeight })').catch(() => null)) as { w: number; h: number } | null;
  const fullPage = args.full_page === true;
  const items: Array<{ x: number; y: number; w: number; h: number }> = [];
  const boxes: CaptureBox[] = [];
  for (const [i, { h, loc }] of located.entries()) {
    const b = await loc.boundingBox().catch(() => null);
    if (!b || b.width <= 0 || b.height <= 0) return { ok: false, error: `Nothing was saved. Highlight ${i + 1} is on the page but not visible (no size). Open the menu or scroll to it first.` };
    items.push({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) });
    const inView = fullPage || !viewport || (b.x >= 0 && b.y >= 0 && b.x + b.width <= viewport.w && b.y + b.height <= viewport.h);
    boxes.push({ n: i + 1, label: await describe(loc, h), inView });
  }

  let png: Buffer;
  try {
    if (items.length) await page.evaluate(`${OVERLAY_SOURCE}(${JSON.stringify(items)})`);
    png = await page.screenshot({ type: 'png', fullPage });
  } finally {
    if (items.length) await page.evaluate(REMOVE_OVERLAY_SOURCE).catch(() => undefined);
  }
  if (png.length > CAPTURE_LIMITS.pngBytes) return { ok: false, error: 'The screenshot is too large to send back. Capture the visible part (not the full page).' };
  fs.mkdirSync(path.dirname(target.abs), { recursive: true });
  fs.writeFileSync(target.abs, png);
  return { ok: true, rel: target.rel, bytes: png.length, png, boxes };
}

/** The text the agent gets back: where the file is, and what each number marks. */
export function captureSummary(r: Extract<CaptureResult, { ok: true }>): string {
  const lines = [`Saved ${r.rel} (${Math.round(r.bytes / 1024)} KB).`];
  for (const b of r.boxes) lines.push(`  ${b.n}: ${b.label || '(no text)'}${b.inView ? '' : '  [outside the visible area: scroll and capture again]'}`);
  lines.push(`Insert it in the guide with ![what it shows](${r.rel}) and refer to the numbers in the steps.`);
  return lines.join('\n');
}

// ── Sign-in with a test account ─────────────────────────────────────────────────────────────────────────

export interface GuideAccount { role: string; username: string; password: string }

/** Reads the accounts and allowed hosts of a run's payload; anything malformed is dropped. */
export function parseAccounts(rawAccounts: unknown, rawHosts: unknown): { accounts: GuideAccount[]; hosts: string[] } {
  const accounts: GuideAccount[] = [];
  if (Array.isArray(rawAccounts)) {
    for (const a of rawAccounts.slice(0, CAPTURE_LIMITS.accounts)) {
      const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
      if (typeof o.role !== 'string' || typeof o.username !== 'string' || typeof o.password !== 'string') continue;
      const role = o.role.trim();
      if (!role || role.length > CAPTURE_LIMITS.fieldChars || !o.username || o.username.length > CAPTURE_LIMITS.fieldChars || !o.password || o.password.length > CAPTURE_LIMITS.fieldChars) continue;
      if (accounts.some((x) => x.role.toLowerCase() === role.toLowerCase())) continue;
      accounts.push({ role, username: o.username, password: o.password });
    }
  }
  const hosts = Array.isArray(rawHosts)
    ? [...new Set(rawHosts.filter((h): h is string => typeof h === 'string').map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) && h.length <= 253))].slice(0, CAPTURE_LIMITS.hosts)
    : [];
  return { accounts, hosts };
}

/** True when the page's host is an allowed host or a subdomain of one. */
export function hostAllowed(pageUrl: string, hosts: string[]): boolean {
  let host: string;
  try { host = new URL(pageUrl).hostname.toLowerCase(); } catch { return false; }
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

const USERNAME_SELECTORS = [
  'input[autocomplete="username"]', 'input[type="email"]', 'input[name*="user" i]', 'input[name*="email" i]', 'input[name*="login" i]', 'input[id*="user" i]', 'input[id*="email" i]', 'input[id*="login" i]',
  'input[type="text"]', 'input:not([type])', 'input[type="tel"]',
];
const SUBMIT_SELECTORS = ['button[type="submit"]', 'input[type="submit"]'];

async function firstVisible(page: CapturePage, selectors: string[]): Promise<CaptureLocator | null> {
  for (const s of selectors) {
    const all = page.locator(s);
    const n = Math.min(await all.count().catch(() => 0), 1);
    if (n === 0) continue;
    const first = all.first();
    if (await first.isVisible().catch(() => false)) return first;
  }
  return null;
}

async function settle(page: CapturePage): Promise<void> {
  await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
  await page.waitForTimeout(500).catch(() => undefined);
}

/**
 * Types the account of `role` into the page's sign-in form and submits it. Handles a form with both fields and the two-step form
 * (username, continue, then password). The result never contains the username or the password.
 */
export async function signIn(
  page: CapturePage,
  state: { accounts: GuideAccount[]; hosts: string[] },
  args: { role?: unknown; username_selector?: unknown; password_selector?: unknown; submit_selector?: unknown },
): Promise<{ ok: boolean; message: string }> {
  try {
    return await signInInner(page, state, args);
  } catch (err) {
    // Playwright's errors carry a call log that repeats what was typed (fill("secret")): none of it may reach the model.
    let msg = err instanceof Error ? err.message : String(err);
    for (const a of state.accounts) for (const v of [a.password, a.username]) if (v) msg = msg.split(v).join('***');
    return { ok: false, message: `Signing in failed: ${msg.split(String.fromCharCode(10))[0].slice(0, 200)}` };
  }
}

async function signInInner(
  page: CapturePage,
  state: { accounts: GuideAccount[]; hosts: string[] },
  args: { role?: unknown; username_selector?: unknown; password_selector?: unknown; submit_selector?: unknown },
): Promise<{ ok: boolean; message: string }> {
  if (!state.accounts.length) return { ok: false, message: 'No test accounts were given for this run, so the agent cannot sign in. Continue with the pages that need no sign-in, and say so in the guide.' };
  if (!state.hosts.length || !hostAllowed(page.url(), state.hosts)) {
    let host = '';
    try { host = new URL(page.url()).hostname; } catch { /* no page yet */ }
    return { ok: false, message: `Signing in is only allowed on ${state.hosts.join(', ') || 'the system address'}; this page is ${host || 'not a web page'}. Open the system's own sign-in page first.` };
  }
  const wanted = typeof args.role === 'string' ? args.role.trim().toLowerCase() : '';
  const account = wanted ? state.accounts.find((a) => a.role.toLowerCase() === wanted) : state.accounts.length === 1 ? state.accounts[0] : undefined;
  if (!account) return { ok: false, message: `Say which account to use. Roles: ${state.accounts.map((a) => a.role).join(', ')}.` };

  const sel = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.length <= CAPTURE_LIMITS.selectorChars ? v.trim() : null);
  const userSel = sel(args.username_selector), passSel = sel(args.password_selector), submitSel = sel(args.submit_selector);

  let typedUser = false;
  for (let step = 0; step < 2; step++) {
    const pass = passSel ? page.locator(passSel).first() : await firstVisible(page, ['input[type="password"]']);
    const passVisible = pass ? await pass.isVisible().catch(() => false) : false;
    const user = userSel ? page.locator(userSel).first() : await firstVisible(page, USERNAME_SELECTORS);

    if (!passVisible && !user) return { ok: false, message: 'No sign-in form was found on this page. Open the sign-in page, or pass username_selector and password_selector.' };
    if (user && !typedUser) { await user.fill(account.username).catch(() => undefined); typedUser = true; }
    if (passVisible && pass) {
      await pass.fill(account.password);
      const submit = submitSel ? page.locator(submitSel).first() : await firstVisible(page, SUBMIT_SELECTORS);
      if (submit) await submit.click(); else await pass.press('Enter');
      await settle(page);
      return { ok: true, message: `Submitted the sign-in form for the "${account.role}" account. The page is now ${page.url()}. Check that you are signed in (a user menu or the home screen, not the sign-in form again).` };
    }
    // Two-step form: the username first, then the password on the next screen.
    const next = submitSel ? page.locator(submitSel).first() : await firstVisible(page, SUBMIT_SELECTORS);
    if (next) await next.click(); else if (user) await user.press('Enter');
    await settle(page);
  }
  return { ok: false, message: 'The password field did not appear after the username. Sign in on the page with the type tool, or pass the selectors.' };
}
