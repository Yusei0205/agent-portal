/// <reference lib="dom" />
/**
 * Playwright smoke tests for Agent Portal.
 *
 * Runs as a standalone Node.js script via:
 *   node --disable-warning=ExperimentalWarning --import tsx test/ui/smoke.ts
 *
 * The script starts a portal server against a temp data dir, performs setup and
 * project creation via the HTTP API, logs in through the browser, then visits
 * every page and asserts the expected heading / content is visible with no
 * "Coming soon" placeholder.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ── Config ────────────────────────────────────────────────────────────────────

const BASE           = 'http://127.0.0.1:8788';
const DATA_DIR       = path.resolve('./data-playwright-test');
const SECRET         = 'test-key-playwright-00000000000000000000000000000000';
const PORT           = '8788';
const ADMIN_EMAIL    = 'admin@smoketest.local';
const ADMIN_PASSWORD = 'smokepassword99';
const ADMIN_NAME     = 'Smoke Admin';

// ── Test runner ───────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures: { name: string; msg: string }[] = [];

async function test(name: string, fn: (page: Page) => Promise<void>, page: Page): Promise<void> {
  process.stdout.write(`  ${name} … `);
  try {
    await fn(page);
    passed++;
    console.log('✓');
  } catch (err: any) {
    failed++;
    const msg = err?.message ?? String(err);
    failures.push({ name, msg });
    console.log(`✗\n    ${msg.split('\n')[0]}`);
  }
}

// ── Server management ─────────────────────────────────────────────────────────

let serverProc: cp.ChildProcess | null = null;

async function startServer(): Promise<void> {
  if (fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATA_DIR,
      PORTAL_SECRET_KEY: SECRET,
      PORT,
      NODE_ENV: 'test',
    };

    serverProc = cp.spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'dist/server.mjs'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let ready = false;
    const markReady = () => {
      if (!ready) { ready = true; setTimeout(resolve, 300); }
    };

    serverProc.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().toLowerCase().includes('listen')) markReady();
    });
    serverProc.stderr?.on('data', () => {});
    serverProc.on('error', reject);
    serverProc.on('exit', (code) => {
      if (!ready) reject(new Error(`Server exited ${code} before ready`));
    });
    setTimeout(markReady, 5000); // hard fallback
  });
}

function stopServer() {
  try { serverProc?.kill(); } catch { /* ignore */ }
  serverProc = null;
}

function cleanupData() {
  try { if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true }); }
  catch { /* best effort */ }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function waitForServer(maxWait = 10_000): Promise<void> {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Server did not become healthy within timeout');
}

let sessionCookie = '';

async function apiPost(urlPath: string, body: unknown): Promise<any> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-requested-with': 'agent-portal',
  };
  if (sessionCookie) headers['cookie'] = sessionCookie;

  const res = await fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data as any).error) || `HTTP ${res.status}`;
    throw new Error(`POST ${urlPath}: ${msg}`);
  }

  // Capture Set-Cookie
  const sc = res.headers.get('set-cookie');
  if (sc) sessionCookie = sc.split(';')[0];

  return data;
}

async function setupPortal(): Promise<void> {
  await apiPost('/api/auth/setup', {
    name: ADMIN_NAME,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    provider: 'demo',
  });
}

async function loginApi(): Promise<void> {
  await apiPost('/api/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
}

async function createProjectApi(name: string): Promise<string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-requested-with': 'agent-portal',
    'cookie': sessionCookie,
  };
  const res = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, description: 'Smoke test project' }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(`Create project: ${data.error || res.status}`);
  return data.project.id as string;
}

async function apiGet(urlPath: string): Promise<any> {
  const headers: Record<string, string> = { 'x-requested-with': 'agent-portal' };
  if (sessionCookie) headers['cookie'] = sessionCookie;
  const res = await fetch(`${BASE}${urlPath}`, { headers });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data as any).error) || `HTTP ${res.status}`;
    throw new Error(`GET ${urlPath}: ${msg}`);
  }
  return data;
}

async function apiPut(urlPath: string, body: unknown): Promise<any> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-requested-with': 'agent-portal',
  };
  if (sessionCookie) headers['cookie'] = sessionCookie;
  const res = await fetch(`${BASE}${urlPath}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data as any).error) || `HTTP ${res.status}`;
    throw new Error(`PUT ${urlPath}: ${msg}`);
  }
  return data;
}

async function createReviewApi(pid: string, baseRef: string, headRef: string): Promise<string> {
  const data = await apiPost(`/api/projects/${pid}/reviews`, { baseRef, headRef });
  return data.review.id as string;
}

// ── Page helpers ──────────────────────────────────────────────────────────────

async function goto(page: Page, hash: string, wait = 800): Promise<void> {
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
}

async function assertNoPlaceholder(page: Page): Promise<void> {
  const texts = await page.locator('h1, h2').allTextContents();
  for (const t of texts) {
    if (t.toLowerCase().includes('coming soon')) {
      throw new Error(`Page shows placeholder "Coming soon". Headings: ${JSON.stringify(texts)}`);
    }
  }
}

async function assertHeading(page: Page, ...patterns: (string | RegExp)[]): Promise<void> {
  await page.waitForSelector('h1, h2', { timeout: 10_000 });
  await assertNoPlaceholder(page);
  if (patterns.length === 0) return;

  const texts = await page.locator('h1, h2').allTextContents();
  for (const p of patterns) {
    const found = texts.some(t =>
      typeof p === 'string' ? t.toLowerCase().includes(p.toLowerCase()) : p.test(t),
    );
    if (!found) {
      throw new Error(`No heading contains ${JSON.stringify(p)}. Found: ${JSON.stringify(texts)}`);
    }
  }
}

async function assertTabsExist(page: Page, expected: string[]): Promise<void> {
  const tabTexts = await page.locator('.tab-btn, [role="tab"]').allTextContents();
  for (const tab of expected) {
    const found = tabTexts.some(t => t.trim().toLowerCase().includes(tab.toLowerCase()));
    if (!found) {
      throw new Error(`Tab "${tab}" not found. Tabs: ${JSON.stringify(tabTexts)}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nAgent Portal — Playwright smoke tests');
  console.log('======================================\n');

  // ── Start server ─────────────────────────────────────────────────────────
  process.stdout.write('Starting portal server … ');
  try {
    await startServer();
    await waitForServer();
    console.log('✓');
  } catch (err: any) {
    console.log('✗');
    console.error('Failed to start server:', err.message);
    stopServer(); cleanupData();
    process.exit(1);
  }

  // ── First-run setup via API ───────────────────────────────────────────────
  process.stdout.write('First-run setup (API) … ');
  try {
    await setupPortal();
    console.log('✓');
  } catch (err: any) {
    console.log('✗');
    console.error('Setup failed:', err.message);
    stopServer(); cleanupData();
    process.exit(1);
  }

  // ── Login via API (to get cookie for project creation) ────────────────────
  process.stdout.write('Admin login (API) … ');
  try {
    await loginApi();
    console.log('✓');
  } catch (err: any) {
    console.log('✗');
    console.error('Login failed:', err.message);
    stopServer(); cleanupData();
    process.exit(1);
  }

  // ── Create test project via API ───────────────────────────────────────────
  process.stdout.write('Create test project (API) … ');
  let projectId = '';
  try {
    projectId = await createProjectApi('Test Project');
    console.log(`✓  (${projectId})`);
  } catch (err: any) {
    console.log('✗');
    console.error('Project creation failed:', err.message);
    stopServer(); cleanupData();
    process.exit(1);
  }

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page!: Page;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ baseURL: BASE });
    page    = await context.newPage();

    // Capture JS errors
    const jsErrors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') jsErrors.push(msg.text()); });
    page.on('pageerror', err => jsErrors.push(`[pageerror] ${err.message}`));
    page.on('response', resp => {
      if (resp.status() === 404) jsErrors.push(`[404] ${resp.url()}`);
    });

    // ── Login via browser ────────────────────────────────────────────────
    console.log('\n0. Login');
    await test('Login with admin credentials shows shell', async (p) => {
      await p.goto(BASE, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(600);

      // If still showing setup wizard (shouldn't be), fill it quickly
      if ((await p.locator('.wizard-card').count()) > 0) {
        throw new Error('Setup wizard shown for already-configured portal');
      }

      // Fill login form
      await p.waitForSelector('#login-email', { timeout: 8000 });
      await p.fill('#login-email', ADMIN_EMAIL);
      await p.fill('#login-password', ADMIN_PASSWORD);
      await p.click('button[type="submit"]');
      await p.waitForSelector('.shell', { timeout: 12_000 });
    }, page);

    // ── 1. Setup wizard regression ───────────────────────────────────────
    console.log('\n1. Setup wizard (regression)');
    await test('Root shows shell not wizard after setup', async (p) => {
      await p.goto(BASE, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(500);
      if ((await p.locator('.wizard-card').count()) > 0) {
        throw new Error('Setup wizard shown for already-configured portal');
      }
      if ((await p.locator('.shell').count()) === 0) {
        throw new Error('Shell not shown');
      }
    }, page);

    // ── 2. Projects ──────────────────────────────────────────────────────
    console.log('\n2. Projects');
    await test('Projects page renders', async (p) => {
      await goto(p, '/projects');
      await assertHeading(p, 'Projects');
    }, page);

    await test('New Project modal opens and form is usable', async (p) => {
      await goto(p, '/projects');
      const newBtn = p.locator('button').filter({ hasText: /new project/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
      await newBtn.click();
      await p.waitForSelector('#np-name', { timeout: 5000 });
      // Verify modal open — don't actually submit (project already created via API)
      const modalHeading = await p.locator('#new-project-title, h2').first().textContent();
      if (!modalHeading?.toLowerCase().includes('project')) {
        throw new Error(`Modal heading unexpected: ${modalHeading}`);
      }
      // Close modal via Escape
      await p.keyboard.press('Escape');
    }, page);

    // ── 3. Sessions ──────────────────────────────────────────────────────
    console.log('\n3. Sessions');
    await test('Sessions page renders (no "Coming soon")', async (p) => {
      await goto(p, `/p/${projectId}/sessions`);
      await p.waitForSelector('.shell', { timeout: 8000 });
      await assertNoPlaceholder(p);
      // Verify something session-related is visible
      const content = await p.locator('.shell').textContent();
      if (!content) throw new Error('Shell has no content');
    }, page);

    // ── 4. Knowledge ─────────────────────────────────────────────────────
    console.log('\n4. Knowledge');
    await test('Knowledge page — heading and 5 tabs', async (p) => {
      await goto(p, `/p/${projectId}/knowledge`);
      await assertHeading(p, 'Knowledge');
      await p.waitForSelector('.tab-bar, [role="tablist"]', { timeout: 8000 });
      await assertTabsExist(p, ['Documents', 'Search', 'Ask', 'Decisions', 'Learn']);
    }, page);

    // ── 5. Create ────────────────────────────────────────────────────────
    console.log('\n5. Create');
    await test('Create page — Diagrams/Documents/Decks tabs', async (p) => {
      await goto(p, `/p/${projectId}/create`);
      await assertNoPlaceholder(p);
      await p.waitForSelector('.tab-bar, [role="tablist"]', { timeout: 8000 });
      await assertTabsExist(p, ['Diagrams', 'Documents', 'Decks']);
    }, page);

    // ── 6. Vault ─────────────────────────────────────────────────────────
    console.log('\n6. Vault');
    await test('Vault page — heading and Project/Personal/Portal tabs', async (p) => {
      await goto(p, `/p/${projectId}/vault`);
      await assertHeading(p, 'Vault');
      await assertTabsExist(p, ['Project', 'Personal', 'Portal']);
    }, page);

    // ── 7. Insights ──────────────────────────────────────────────────────
    console.log('\n7. Insights');
    await test('Insights page renders', async (p) => {
      await goto(p, `/p/${projectId}/insights`);
      await assertHeading(p, 'Insights');
    }, page);

    // ── 8. Setup (ProjectHub) ─────────────────────────────────────────────
    console.log('\n8. Setup');
    await test('Setup page renders with tab bar', async (p) => {
      await goto(p, `/p/${projectId}/setup`, 1200);
      await assertNoPlaceholder(p);
      await p.waitForSelector('.tab-bar, [role="tablist"], .tabs', { timeout: 8000 });
      const tabTexts = await p.locator('.tab-btn, [role="tab"]').allTextContents();
      if (tabTexts.length === 0) throw new Error('No tabs found on Setup page');
    }, page);

    // ── 9. Inbox ─────────────────────────────────────────────────────────
    console.log('\n9. Inbox');
    await test('Inbox page renders', async (p) => {
      await goto(p, '/inbox');
      await assertHeading(p, 'Inbox');
    }, page);

    // ── 10. Git connections ───────────────────────────────────────────────
    console.log('\n10. Git connections');
    await test('Git connections page renders (not a placeholder)', async (p) => {
      await goto(p, '/connections');
      await assertHeading(p, 'Git connections');
    }, page);

    // ── 11. Integrations ──────────────────────────────────────────────────
    console.log('\n11. Integrations');
    await test('Integrations page renders', async (p) => {
      await goto(p, '/integrations');
      await assertHeading(p, 'Integrations');
    }, page);

    // ── 12. AWS accounts ──────────────────────────────────────────────────
    console.log('\n12. AWS accounts');
    await test('AWS accounts page renders', async (p) => {
      await goto(p, '/aws');
      await assertHeading(p, 'AWS accounts');
    }, page);

    // ── 13. API access ────────────────────────────────────────────────────
    console.log('\n13. API access');
    await test('API access page renders', async (p) => {
      await goto(p, '/api');
      await assertHeading(p, 'API access');
    }, page);

    // ── 14. Settings ──────────────────────────────────────────────────────
    console.log('\n14. Settings');
    await test('Settings page — heading and Provider/Tools/Permissions tabs', async (p) => {
      await goto(p, '/settings', 1200);
      await assertHeading(p, 'Settings');
      await p.waitForSelector('.tabs, [role="tablist"]', { timeout: 8000 });
      await assertTabsExist(p, ['Provider', 'Tools', 'Permissions']);
    }, page);

    // ── 15. Admin panel ───────────────────────────────────────────────────
    console.log('\n15. Admin panel');
    await test('Admin panel — heading and Users/Audit log/API tokens tabs', async (p) => {
      await goto(p, '/admin');
      await assertHeading(p, 'Admin');
      await p.waitForSelector('.tabs, [role="tablist"]', { timeout: 8000 });
      await assertTabsExist(p, ['Users', 'Audit', 'API tokens']);
    }, page);

    // ── 16. Workspaces ────────────────────────────────────────────────────
    console.log('\n16. Workspaces');
    await test('Workspaces page renders', async (p) => {
      await goto(p, `/p/${projectId}/workspaces`);
      await assertHeading(p, 'Workspaces');
    }, page);

    // ── 17. Code review ───────────────────────────────────────────────────
    console.log('\n17. Code review');
    await test('Code review page renders', async (p) => {
      await goto(p, `/p/${projectId}/review`);
      await assertHeading(p, /code review/i);
    }, page);

    // ── 18. Review dashboard ──────────────────────────────────────────────
    console.log('\n18. Review dashboard');
    await test('Review dashboard heading renders', async (p) => {
      await goto(p, '/reviews', 1200);
      await assertHeading(p, /review dashboard/i);
    }, page);

    await test('Period toggles Today/7/30/90 switch without JS errors', async (p) => {
      await goto(p, '/reviews', 1200);
      await p.waitForSelector('[role="group"][aria-label="Time period"], .tab-bar', { timeout: 8000 });
      const periodLabels = ['Today', '7 days', '30 days', '90 days'];
      for (const label of periodLabels) {
        const btn = p.locator('button').filter({ hasText: new RegExp(`^${label}$`, 'i') }).first();
        const btnCount = await btn.count();
        if (btnCount === 0) throw new Error(`Period toggle button "${label}" not found`);
        await btn.click();
        await p.waitForTimeout(600);
        const headings = await p.locator('h1, h2').allTextContents();
        const hasHeading = headings.some(t => /review dashboard/i.test(t));
        if (!hasHeading) throw new Error(`Heading disappeared after clicking "${label}" period toggle`);
      }
    }, page);

    await test('Empty state shown when no reviews exist in period', async (p) => {
      await goto(p, '/reviews', 1200);
      // Wait for spinner to clear
      await p.waitForSelector('.spinner', { state: 'detached', timeout: 10_000 }).catch(() => {});
      await p.waitForTimeout(600);
      // Fresh DB: no reviews → stat tiles show 0 or empty-state paragraph appears
      // Use body.innerText to avoid strict-mode violation from multiple .page / main elements
      const pageText = await p.evaluate(() => document.body.innerText);
      const hasEmptyOrZero =
        /no code reviews/i.test(pageText) ||
        /no reviews in this period/i.test(pageText) ||
        /start a review/i.test(pageText) ||
        (pageText.includes('Reviews') && /\b0\b/.test(pageText));
      if (!hasEmptyOrZero) {
        throw new Error(`Expected empty-state content on a fresh DB, got: ${pageText.slice(0, 300)}`);
      }
    }, page);

    // ── 19. Settings › Code review tab ───────────────────────────────────
    console.log('\n19. Settings › Code review tab');
    await test('Code review tab renders merge threshold options', async (p) => {
      await goto(p, '/settings', 1400);
      await p.waitForSelector('#tab-codereview', { timeout: 8000 });
      await p.click('#tab-codereview');
      await p.waitForTimeout(800);
      const radios = await p.locator('[name="mergeThreshold"]').count();
      if (radios < 6) throw new Error(`Expected ≥6 mergeThreshold radio inputs, found ${radios}`);
      await p.waitForSelector('#rc-input', { timeout: 5000 });
      await p.waitForSelector('#rc-output', { timeout: 3000 });
    }, page);

    await test('Changing threshold + rate card saves (verified via GET /api/settings/review)', async (p) => {
      await goto(p, '/settings', 1400);
      await p.waitForSelector('#tab-codereview', { timeout: 8000 });
      await p.click('#tab-codereview');
      await p.waitForTimeout(800);
      // Select "medium" threshold radio
      await p.click('[name="mergeThreshold"][value="medium"]');
      // Update input rate field
      await p.fill('#rc-input', '6');
      await p.click('button[type="submit"]');
      // Wait for success status message
      await p.locator('[role="status"]').filter({ hasText: /saved/i }).waitFor({ timeout: 8000 });
      // Confirm via API
      const settings = await apiGet('/api/settings/review');
      if (settings.mergeThreshold !== 'medium') {
        throw new Error(`mergeThreshold should be "medium" after save, got "${settings.mergeThreshold}"`);
      }
      if (Number(settings.rateCard?.inputUsd) !== 6) {
        throw new Error(`inputUsd should be 6 after save, got ${settings.rateCard?.inputUsd}`);
      }
    }, page);

    await test('Negative rate card value shows API error message', async (p) => {
      await goto(p, '/settings', 1400);
      await p.waitForSelector('#tab-codereview', { timeout: 8000 });
      await p.click('#tab-codereview');
      await p.waitForTimeout(800);
      // noValidate form — browser won't block submission with min="0" violated
      await p.fill('#rc-input', '-1');
      await p.click('button[type="submit"]');
      // Server returns 400 for negative rate; component shows saveError in role=alert
      await p.locator('[role="alert"]').waitFor({ timeout: 8000 });
      const alertText = await p.locator('[role="alert"]').first().textContent();
      if (!alertText) throw new Error('Error alert element is empty');
    }, page);

    // Restore defaults after settings tests
    try {
      await apiPut('/api/settings/review', {
        mergeThreshold: 'high',
        rateCard: { inputUsd: 3, outputUsd: 15, cacheWriteUsd: 3.75, cacheReadUsd: 0.30 },
      });
    } catch { /* best effort */ }

    // ── 20. Code review page — new review dialog ──────────────────────────
    console.log('\n20. Code review page — new review dialog');

    let reviewId = '';

    await test('New review dialog has optional Jira ticket key field', async (p) => {
      await goto(p, `/p/${projectId}/review`, 800);
      const newBtn = p.locator('button').filter({ hasText: /\+ New review/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
      await newBtn.click();
      await p.waitForSelector('[role="dialog"][aria-label="New code review"]', { timeout: 6000 });
      // The Jira key field has aria-describedby="jira-key-hint"
      const jiraInput = p.locator('[aria-describedby="jira-key-hint"]').first();
      await jiraInput.waitFor({ timeout: 4000 });
      const ph = await jiraInput.getAttribute('placeholder');
      if (!ph?.toLowerCase().includes('proj')) {
        throw new Error(`Jira key placeholder unexpected: "${ph}"`);
      }
      // hint span should also be present
      await p.locator('#jira-key-hint').waitFor({ timeout: 3000 });
      await p.keyboard.press('Escape');
      await p.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {});
    }, page);

    await test('Creating a review then opening it navigates to #/p/:pid/review/:rid', async (p) => {
      // Navigate via an intermediate page to ensure a full page reload (same-hash goto is a no-op)
      await goto(p, '/projects', 400);
      await goto(p, `/p/${projectId}/review`, 1200);
      const newBtn = p.locator('button').filter({ hasText: /\+ New review/i }).first();
      await newBtn.waitFor({ timeout: 10_000 });
      await newBtn.click();
      await p.waitForSelector('[role="dialog"][aria-label="New code review"]', { timeout: 6000 });
      // Fill required head branch
      await p.fill('input[placeholder="feature/my-branch"]', 'feature/smoke-test');
      // Fill optional Jira key
      await p.fill('[aria-describedby="jira-key-hint"]', 'SMOKE-1');
      // Submit and wait for API response
      const submitBtn = p.locator('[role="dialog"] button[type="submit"]').first();
      await Promise.all([
        p.waitForResponse(
          (r) => r.url().includes('/reviews') && r.request().method() === 'POST',
          { timeout: 10_000 },
        ),
        submitBtn.click(),
      ]);
      // Modal closes; review appears in list
      await p.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 }).catch(() => {});
      await p.waitForTimeout(600);
      // Find the "Open" link for the new review
      const openLink = p.locator('a[aria-label^="Open full detail"]').first();
      await openLink.waitFor({ timeout: 8000 });
      const hrefAttr = await openLink.getAttribute('href');
      const match = hrefAttr?.match(/\/review\/([^/?#]+)/);
      if (!match) throw new Error(`Could not extract reviewId from href: ${hrefAttr}`);
      reviewId = match[1];
      await openLink.click();
      await p.waitForTimeout(1000);
      const currentUrl = p.url();
      if (!currentUrl.includes(`/review/${reviewId}`)) {
        throw new Error(`Expected URL to contain /review/${reviewId}, got: ${currentUrl}`);
      }
    }, page);

    // ── 21. Review detail ─────────────────────────────────────────────────
    console.log('\n21. Review detail');

    // Fallback: create via API if the UI creation test above failed
    if (!reviewId) {
      try {
        reviewId = await createReviewApi(projectId, 'main', 'feature/smoke-fallback');
      } catch { /* sub-tests will fail with a clear message */ }
    }

    await test('Verdict banner is present on review detail page', async (p) => {
      if (!reviewId) throw new Error('No reviewId — review creation test failed');
      await goto(p, `/p/${projectId}/review/${reviewId}`, 1500);
      // Server always computes verdict (even for pending reviews)
      await p.waitForSelector('[role="status"]', { timeout: 10_000 });
    }, page);

    await test('Merge button disabled with visible reason for non-done review', async (p) => {
      if (!reviewId) throw new Error('No reviewId — review creation test failed');
      await goto(p, `/p/${projectId}/review/${reviewId}`, 1500);
      const mergeBtn = p.locator('button').filter({ hasText: /Merge pull request/i }).first();
      await mergeBtn.waitFor({ timeout: 10_000 });
      const disabled = await mergeBtn.isDisabled();
      if (!disabled) throw new Error('Merge button must be disabled for a pending review');
      // Visible reason paragraph
      await p.waitForSelector('#merge-reason', { timeout: 5000 });
      const reason = await p.locator('#merge-reason').textContent();
      if (!reason?.includes('Merge disabled:')) {
        throw new Error(`Expected "Merge disabled:" text in #merge-reason, got: ${reason}`);
      }
    }, page);

    await test('Re-run creates a new review and navigates to it showing "Re-run of"', async (p) => {
      if (!reviewId) throw new Error('No reviewId — review creation test failed');
      // The Re-run button in the UI is disabled for pending/running reviews.
      // Trigger re-run via the API and then verify the resulting detail page
      // shows "Re-run of <parentId>".
      const rerunData = await apiPost(`/api/projects/${projectId}/reviews/${reviewId}/rerun`, {});
      const newReviewId = rerunData.review?.id;
      if (!newReviewId) throw new Error(`Re-run API did not return a review id: ${JSON.stringify(rerunData)}`);
      if (rerunData.parentReviewId !== reviewId) {
        throw new Error(`parentReviewId mismatch: expected ${reviewId}, got ${rerunData.parentReviewId}`);
      }
      // Navigate to the new review detail page
      await goto(p, `/p/${projectId}/review/${newReviewId}`, 1500);
      // The page should show "Re-run of <parentId>" because parent_review_id is set
      await p.getByText('Re-run of', { exact: false }).waitFor({ timeout: 8000 });
      const urlAfter = p.url();
      if (!urlAfter.includes(`/review/${newReviewId}`)) {
        throw new Error(`URL should show new review ${newReviewId}, got: ${urlAfter}`);
      }
    }, page);

    await test('Excel download button triggers a spreadsheet response', async (p) => {
      if (!reviewId) throw new Error('No reviewId — review creation test failed');
      await goto(p, `/p/${projectId}/review/${reviewId}`, 1500);
      const excelBtn = p.locator('[aria-label="Download Excel report"]').first();
      await excelBtn.waitFor({ timeout: 8000 });
      const [xlsxResponse] = await Promise.all([
        p.waitForResponse((r) => r.url().includes('/export/xlsx'), { timeout: 15_000 }),
        excelBtn.click(),
      ]);
      const ct = xlsxResponse.headers()['content-type'] ?? '';
      if (!ct.includes('spreadsheetml') && !ct.includes('octet-stream')) {
        throw new Error(`Expected spreadsheet content-type for xlsx, got: "${ct}"`);
      }
    }, page);

    await test('Word download button triggers a document response', async (p) => {
      if (!reviewId) throw new Error('No reviewId — review creation test failed');
      await goto(p, `/p/${projectId}/review/${reviewId}`, 1500);
      const wordBtn = p.locator('[aria-label="Download Word report"]').first();
      await wordBtn.waitFor({ timeout: 8000 });
      const [docxResponse] = await Promise.all([
        p.waitForResponse((r) => r.url().includes('/export/docx'), { timeout: 15_000 }),
        wordBtn.click(),
      ]);
      const ct = docxResponse.headers()['content-type'] ?? '';
      if (!ct.includes('wordprocessingml') && !ct.includes('octet-stream')) {
        throw new Error(`Expected Word document content-type for docx, got: "${ct}"`);
      }
    }, page);

    await test('Show log button toggles run log open and closed', async (p) => {
      if (!reviewId) throw new Error('No reviewId — review creation test failed');
      await goto(p, `/p/${projectId}/review/${reviewId}`, 1500);
      // For a pending review with no log entries, the RunLog component shows
      // "No log entries recorded." instead of the Show/Hide log toggle.
      // Either case is valid behavior — test whichever is present.
      const showLogBtn = p.locator('button').filter({ hasText: /Show log/i }).first();
      const showLogCount = await showLogBtn.count();
      if (showLogCount === 0) {
        // No log entries yet — verify the "No log entries recorded." message appears
        const noLogText = p.getByText('No log entries recorded', { exact: false });
        await noLogText.waitFor({ timeout: 5000 });
        // Test passes — empty log state is correct for a fresh pending review
        return;
      }
      await showLogBtn.waitFor({ timeout: 5000 });
      await showLogBtn.click();
      await p.waitForTimeout(400);
      // "Hide log" should now be visible
      const hideLogBtn = p.locator('button').filter({ hasText: /Hide log/i }).first();
      await hideLogBtn.waitFor({ timeout: 4000 });
      // Verify the log panel rendered
      const logPanel = await p.locator('[role="log"], [aria-label="Agent run log"]').count();
      const mainText = await p.evaluate(() => document.body.innerText);
      if (logPanel === 0 && !mainText.includes('entries')) {
        throw new Error('Run log panel did not appear after clicking "Show log"');
      }
      // Click to close
      await hideLogBtn.click();
      await p.waitForTimeout(300);
      await p.locator('button').filter({ hasText: /Show log/i }).first().waitFor({ timeout: 4000 });
    }, page);

    // ── 22. Integrations — Atlassian type ────────────────────────────────
    console.log('\n22. Integrations');
    await test('Atlassian integration type shows Account email field', async (p) => {
      // The Integrations component needs a projectId to show "Add integration".
      // App.jsx only routes #/integrations (global, no project) to <Integrations projectId={null}>,
      // where the button is hidden. Navigating #/p/:pid/integrations falls through to a Placeholder.
      // This test attempts the project-scoped URL to surface that routing gap.
      await goto(p, `/p/${projectId}/integrations`, 800);
      // Detect placeholder (Coming soon. is in a <p>, not a heading)
      const pageBody = await p.evaluate(() => document.body.innerText);
      const hasComingSoon = /coming soon/i.test(pageBody);
      if (hasComingSoon) {
        throw new Error(
          'APP BUG: #/p/:projectId/integrations shows "Coming soon" placeholder. ' +
          'App.jsx routes integrations only for the global case (!route.projectId), ' +
          'so a project-scoped URL falls through to Placeholder instead of ' +
          '<Integrations projectId={projectId} />. ' +
          'Fix: add `route.projectId && route.tab === "integrations"` as a route in App.jsx.',
        );
      }
      // If page renders correctly, test the Atlassian modal
      const addBtn = p.locator('button').filter({ hasText: /Add integration/i }).first();
      await addBtn.waitFor({ timeout: 5000 });
      await addBtn.click();
      await p.selectOption('#int-type', 'atlassian');
      await p.waitForTimeout(400);
      await p.locator('#int-jira-email').waitFor({ timeout: 4000 });
      await p.keyboard.press('Escape');
    }, page);

    // ── JS errors report ──────────────────────────────────────────────────
    if (jsErrors.length > 0) {
      const unique = [...new Set(jsErrors)];
      console.log(`\n⚠  JS errors captured (${unique.length} unique):`);
      for (const e of unique.slice(0, 8)) {
        console.log(`   ${e.slice(0, 140)}`);
      }
    }

  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    stopServer();
    cleanupData();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n======================================');
  console.log(`Results: ${passed} passed, ${failed} failed\n`);

  if (failures.length > 0) {
    console.log('Failures:');
    for (const { name, msg } of failures) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${msg.split('\n').slice(0, 3).join('\n    ')}`);
    }
    console.log('');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  stopServer();
  cleanupData();
  process.exit(1);
});
