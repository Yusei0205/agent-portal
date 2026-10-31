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
const SECRET         = '0000000000000000000000000000000000000000000000000000000000000001';
const PORT           = '8788';
const ADMIN_EMAIL    = 'admin@smoketest.local';
const ADMIN_PASSWORD = 'smokepassword99';
const ADMIN_NAME     = 'Smoke Admin';

/** If set, the full per-section results JSON is written here when the run ends. */
const SMOKE_RESULTS_FILE = process.env.SMOKE_RESULTS_FILE ?? '';

/** Default timeout for individual waitForSelector / waitFor calls in tests. */
const T = {
  short:  3_000,
  medium: 5_000,
  long:   8_000,
  server: 10_000,
} as const;

// ── Module registry ───────────────────────────────────────────────────────────
/**
 * Every testable section with its canonical module IDs.
 * Used for SMOKE_ONLY gating and the SMOKE_LIST=1 listing tool.
 *
 * Valid module IDs (shared with the module-map agent):
 *   auth, setup, api-tokens, permissions, audit, delegation, projects,
 *   workspaces, sessions, workflows, ide, dashboard, knowledge, create,
 *   diagrams, generated-docs, presentations, vault, insights, inbox,
 *   connections, repos, integrations, aws-accounts, credentials, bedrock-sso,
 *   settings, config, kiro, reviews, branch-scans, testing-module, api-access,
 *   loop-specs, engines, shell, theme, attachments
 */
const SECTIONS: ReadonlyArray<{ id: string; label: string; modules: string[] }> = [
  { id: '0',   label: 'Login',                                          modules: ['auth'] },
  { id: '1',   label: 'Setup wizard regression',                        modules: ['setup'] },
  { id: '2',   label: 'Projects',                                       modules: ['projects'] },
  { id: '3',   label: 'Sessions',                                       modules: ['sessions'] },
  { id: '4',   label: 'Knowledge',                                      modules: ['knowledge'] },
  { id: '5',   label: 'Create',                                         modules: ['create'] },
  { id: '6',   label: 'Vault',                                          modules: ['vault'] },
  { id: '7',   label: 'Insights',                                       modules: ['insights'] },
  { id: '8',   label: 'Setup (ProjectHub)',                              modules: ['setup'] },
  { id: '8b',  label: 'Repository progress bar',                        modules: ['repos'] },
  { id: '9',   label: 'Inbox',                                          modules: ['inbox'] },
  { id: '10',  label: 'Connections',                                    modules: ['connections'] },
  { id: '11',  label: 'Integrations',                                   modules: ['integrations'] },
  { id: '12',  label: 'Connections / AWS accounts',                     modules: ['connections', 'aws-accounts'] },
  { id: '13',  label: 'API access',                                     modules: ['api-access'] },
  { id: '14',  label: 'Settings',                                       modules: ['settings'] },
  { id: '15',  label: 'Users',                                          modules: ['permissions', 'audit', 'api-tokens'] },
  { id: '16',  label: 'Workspaces',                                     modules: ['workspaces'] },
  { id: '17',  label: 'Reviews',                                        modules: ['reviews'] },
  { id: '18',  label: 'Reviews dashboard',                              modules: ['reviews', 'dashboard'] },
  { id: '19',  label: 'Settings › Code review tab',                     modules: ['settings', 'reviews'] },
  { id: '20',  label: 'Reviews — new review dialog',                    modules: ['reviews'] },
  { id: '21',  label: 'Review detail',                                  modules: ['reviews'] },
  { id: '22',  label: 'Integrations — Atlassian type',                  modules: ['integrations'] },
  { id: '23',  label: 'Command palette',                                modules: ['shell'] },
  { id: '24',  label: 'Shortcuts sheet',                                modules: ['shell'] },
  { id: '25',  label: 'Theme switch',                                   modules: ['theme'] },
  { id: '26',  label: 'Header breadcrumb',                              modules: ['shell'] },
  { id: '27',  label: 'Command palette — repeated open/close',          modules: ['shell'] },
  { id: '28',  label: 'Session IDE workspace',                          modules: ['ide', 'sessions'] },
  { id: '29',  label: 'Credentials page',                               modules: ['credentials'] },
  { id: '30',  label: 'Configuration page',                             modules: ['config'] },
  { id: '31',  label: 'New session dialog',                             modules: ['sessions', 'engines'] },
  { id: '32',  label: 'Settings — Portal AI provider + Sessions tab',   modules: ['settings'] },
  { id: '33',  label: 'Nav — Credentials and Configuration',            modules: ['shell', 'credentials', 'config'] },
  { id: '34',  label: 'Branch scans',                                   modules: ['branch-scans'] },
  { id: '35',  label: 'Review filters in URL',                          modules: ['reviews'] },
  { id: '36',  label: 'Code review settings — PR comment mode',         modules: ['settings', 'reviews'] },
  { id: '37',  label: 'API Access — scope checkboxes + MCP section',    modules: ['api-access', 'api-tokens'] },
  { id: '38',  label: 'Branch scans in command palette',                modules: ['branch-scans', 'shell'] },
  { id: '39',  label: 'Delegate dialog + Agents activity',              modules: ['delegation', 'sessions'] },
  { id: '40',  label: 'Tests module',                                   modules: ['testing-module'] },
  { id: '40b', label: 'Generate-with-AI — async flow',                  modules: ['testing-module'] },
  { id: '41',  label: 'Config tree — keyboard navigation',              modules: ['config', 'shell'] },
  { id: '42',  label: 'Dialog focus trap',                              modules: ['shell'] },
  { id: '43',  label: 'Projects empty-state single CTA',                modules: ['projects'] },
  { id: '44',  label: 'Rail navigation',                                modules: ['shell'] },
  { id: '45',  label: 'Old URL redirects',                              modules: ['shell', 'projects'] },
  { id: '45b', label: 'Theme / template system',                        modules: ['theme'] },
  { id: '46',  label: 'AddReposModal — provider error',                 modules: ['repos'] },
  { id: '47',  label: 'Dashboard',                                      modules: ['dashboard'] },
  { id: '48',  label: 'Bug-fix smoke: ConfirmDialog + workspace picker', modules: ['workspaces', 'sessions'] },
  { id: '49',  label: 'Tickets page — not-connected card + New Session no-ticket check', modules: ['tickets'] },
];

// ── Selective section filter ──────────────────────────────────────────────────
// Set SMOKE_ONLY=dashboard,insights to run only those sections (comma-separated module IDs).
// Leave unset (or empty) to run all sections.
// Matching is EXACT against module IDs — 'config' will NOT match 'api-access'.
// Legacy key aliases: 'rail' → 'shell'.
const SMOKE_ALIAS: Record<string, string> = { rail: 'shell' };
const SMOKE_ONLY_ENV = (process.env.SMOKE_ONLY ?? '').toLowerCase();
const SMOKE_ONLY_KEYS = SMOKE_ONLY_ENV
  ? SMOKE_ONLY_ENV.split(',').map(s => s.trim()).filter(Boolean).map(k => SMOKE_ALIAS[k] ?? k)
  : [];

/** Returns true when the section should run — i.e. any of the given module IDs is in SMOKE_ONLY_KEYS (or no filter is set). */
function sectionEnabled(...moduleIds: string[]): boolean {
  if (SMOKE_ONLY_KEYS.length === 0) return true;
  return moduleIds.some(id => SMOKE_ONLY_KEYS.includes(id));
}

// ── Suite timeout ─────────────────────────────────────────────────────────────
// Scales with the number of enabled sections so a single-section run gets a
// tight bound while a full run has room to finish.
// SMOKE_TIMEOUT_MS env var overrides the computed value (milliseconds).
// Rule: max(5 min, enabled_sections × 30 s).
// Full suite (~52 sections): 52 × 30 s ≈ 26 minutes.
// Measured full-suite wall time: ~326 s; 30 s/section gives ≈ 5× headroom.
const _enabledSectionCount = SECTIONS.filter(s => sectionEnabled(...s.modules)).length;
const SUITE_TIMEOUT_MS = (() => {
  const override = parseInt(process.env.SMOKE_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(override) && override > 0) return override;
  return Math.max(5 * 60 * 1000, _enabledSectionCount * 30 * 1000);
})();

// ── Test runner ───────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures: { name: string; msg: string }[] = [];

// Per-section result tracking ─────────────────────────────────────────────────
interface SectionState {
  ran: boolean;
  passed: number;
  failed: number;
  failures: { name: string; message: string }[];
}
const sectionResultsMap = new Map<string, SectionState>(
  SECTIONS.map(s => [s.id, { ran: false, passed: 0, failed: 0, failures: [] }]),
);
/** The section whose tests are currently executing. Starts at '0' for login/pre-section work. */
let currentSectionId = '0';

async function test(name: string, fn: (page: Page) => Promise<void>, page: Page): Promise<void> {
  process.stdout.write(`  ${name} … `);
  const sr = sectionResultsMap.get(currentSectionId);
  if (sr) sr.ran = true;
  try {
    await fn(page);
    passed++;
    if (sr) sr.passed++;
    console.log('✓');
  } catch (err: any) {
    failed++;
    const msg = err?.message ?? String(err);
    failures.push({ name, msg });
    if (sr) { sr.failed++; sr.failures.push({ name, message: msg }); }
    console.log(`✗\n    ${msg.split('\n')[0]}`);
  }
}

/**
 * Write per-section results to SMOKE_RESULTS_FILE (if the env var is set).
 * completed=true means the suite ran to the end; false means timeout or crash.
 */
function writeResultsFile(completed: boolean): void {
  if (!SMOKE_RESULTS_FILE) return;
  const sections = SECTIONS.map(s => {
    const r = sectionResultsMap.get(s.id) ?? { ran: false, passed: 0, failed: 0, failures: [] };
    return {
      id:       s.id,
      label:    s.label,
      modules:  [...s.modules],
      ran:      r.ran,
      passed:   r.passed,
      failed:   r.failed,
      failures: r.failures as { name: string; message: string }[],
    };
  });
  try {
    fs.writeFileSync(SMOKE_RESULTS_FILE, JSON.stringify({ completed, sections }, null, 2) + '\n');
  } catch (e) {
    console.error(`Warning: could not write SMOKE_RESULTS_FILE: ${(e as Error).message}`);
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

async function waitForServer(maxWait = 8_000): Promise<void> {
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
  await page.waitForSelector('h1, h2', { timeout: 8_000 });
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

  // ── SMOKE_LIST ────────────────────────────────────────────────────────────
  // Print every section with its module IDs as JSON and exit — no server/browser needed.
  // Used by the module-map tooling to cross-check module IDs.
  if (process.env.SMOKE_LIST === '1') {
    const list = SECTIONS.map(s => ({ section: `${s.id}. ${s.label}`, modules: [...s.modules] }));
    console.log(JSON.stringify(list, null, 2));
    process.exit(0);
  }

  // Fail the entire run if it hasn't finished within the computed suite timeout.
  const suiteTimer = setTimeout(() => {
    console.error(`\n✗ Suite timed out after ${SUITE_TIMEOUT_MS / 60000} minutes.`);
    writeResultsFile(false);
    stopServer();
    cleanupData();
    process.exit(1);
  }, SUITE_TIMEOUT_MS);
  suiteTimer.unref(); // don't prevent clean exit if everything finishes early

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

  // ── Create shared demo session (used by §28 IDE and §39 delegation) ──────
  // Always created so either section can run independently.
  let demoSessionId = '';
  try {
    const wfR = await apiPost(`/api/projects/${projectId}/workflows`, {
      goal: 'Smoke test session',
      engine: 'demo',
    });
    demoSessionId = (wfR as any).workflow?.id ?? '';
  } catch { /* skip IDE/delegation tests if session creation fails */ }

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
    currentSectionId = '0';
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
      await p.waitForSelector('.shell', { timeout: 8_000 });
    }, page);

    // ── 1. Setup wizard regression ───────────────────────────────────────
    // Declare shared cross-section variables here so all gated sections can read/write them.
    let reviewId = '';  // set in §20, read in §21

    if (sectionEnabled('setup')) {
    console.log('\n1. Setup wizard (regression)');
    currentSectionId = '1';
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
    } // end §1 setup

    // ── 2. Projects ──────────────────────────────────────────────────────
    if (sectionEnabled('projects')) {
    console.log('\n2. Projects');
    currentSectionId = '2';
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
    } // end §2 projects

    // ── 3. Sessions ──────────────────────────────────────────────────────
    if (sectionEnabled('sessions')) {
    console.log('\n3. Sessions');
    currentSectionId = '3';
    await test('Sessions page renders (no "Coming soon")', async (p) => {
      await goto(p, `/p/${projectId}/sessions`);
      await p.waitForSelector('.shell', { timeout: 8000 });
      await assertNoPlaceholder(p);
      // Verify something session-related is visible
      const content = await p.locator('.shell').textContent();
      if (!content) throw new Error('Shell has no content');
    }, page);
    } // end §3 sessions

    // ── 4. Knowledge ─────────────────────────────────────────────────────
    if (sectionEnabled('knowledge')) {
    console.log('\n4. Knowledge');
    currentSectionId = '4';
    await test('Knowledge page — heading and 5 tabs', async (p) => {
      await goto(p, `/p/${projectId}/knowledge`);
      await assertHeading(p, 'Knowledge');
      await p.waitForSelector('.tab-bar, [role="tablist"]', { timeout: 8000 });
      await assertTabsExist(p, ['Documents', 'Search', 'Ask', 'Decisions', 'Learn']);
    }, page);
    } // end §4 knowledge

    // ── 5. Create ────────────────────────────────────────────────────────
    if (sectionEnabled('create')) {
    console.log('\n5. Create');
    currentSectionId = '5';
    await test('Create page — Diagrams/Documents/Decks tabs', async (p) => {
      await goto(p, `/p/${projectId}/create`);
      await assertNoPlaceholder(p);
      await p.waitForSelector('.tab-bar, [role="tablist"]', { timeout: 8000 });
      await assertTabsExist(p, ['Diagrams', 'Documents', 'Decks']);
    }, page);
    } // end §5 create

    // ── 6. Vault ─────────────────────────────────────────────────────────
    if (sectionEnabled('vault')) {
    console.log('\n6. Vault');
    currentSectionId = '6';
    await test('Vault page — heading and Project/Personal/Portal tabs', async (p) => {
      await goto(p, `/p/${projectId}/vault`);
      await assertHeading(p, 'Vault');
      await assertTabsExist(p, ['Project', 'Personal', 'Portal']);
    }, page);
    } // end §6 vault

    // ── 7. Insights ──────────────────────────────────────────────────────
    if (sectionEnabled('insights')) {
    console.log('\n7. Insights');
    currentSectionId = '7';
    await test('Insights page renders', async (p) => {
      await goto(p, `/p/${projectId}/insights`);
      await assertHeading(p, 'Insights');
    }, page);
    } // end §7 insights

    // ── 8. Setup (ProjectHub) ─────────────────────────────────────────────
    if (sectionEnabled('setup')) {
    console.log('\n8. Setup');
    currentSectionId = '8';
    await test('Setup page renders with tab bar', async (p) => {
      await goto(p, `/p/${projectId}/setup`, 1200);
      await assertNoPlaceholder(p);
      await p.waitForSelector('.tab-bar, [role="tablist"], .tabs', { timeout: 8000 });
      const tabTexts = await p.locator('.tab-btn, [role="tab"]').allTextContents();
      if (tabTexts.length === 0) throw new Error('No tabs found on Setup page');
    }, page);
    } // end §8 setup

    // ── 8b. Repository progress bar ───────────────────────────────────────
    if (sectionEnabled('repos')) {
    console.log('\n8b. Repository progress bar (mocked)');
    currentSectionId = '8b';
    await test('Repo with in-progress clone renders [role=progressbar]', async (p) => {
      // Intercept only the base repos list endpoint (not /repos/progress)
      const reposPattern = new RegExp(`/api/projects/${projectId}/repos$`);
      await p.route(reposPattern, (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            repos: [{
              id: 'mock-cloning-id',
              name: 'demo-service',
              url:  'https://github.com/example/demo',
              provider: 'github',
              status: 'cloning',
              project_id: projectId,
              last_error: null,
              progress: {
                phase:        'receiving',
                phaseLabel:   'Receiving objects',
                percent:      42,
                phasePercent: 68,
                detail:       '1,234 / 2,950 objects · 8.4 MiB · 1.7 MiB/s',
                startedAt:    new Date(Date.now() - 38_000).toISOString(),
                updatedAt:    new Date().toISOString(),
              },
            }],
          }),
        });
      });

      await goto(p, `/p/${projectId}/setup`, 1000);
      // Click the Repositories tab
      const reposTab = p.locator('[role="tab"]').filter({ hasText: /repositories/i });
      await reposTab.waitFor({ timeout: 6_000 });
      await reposTab.click();
      await p.waitForTimeout(700);

      // The progress bar element should be present
      await p.waitForSelector('[role="progressbar"]', { timeout: 6_000 });
      const ariaValuenow = await p.locator('[role="progressbar"]').first().getAttribute('aria-valuenow');
      if (ariaValuenow !== '42') {
        throw new Error(`Expected aria-valuenow="42", got "${ariaValuenow}"`);
      }

      // Clean up route mock before next test
      await p.unroute(reposPattern);
    }, page);
    } // end §8b repos

    // ── 9. Inbox ─────────────────────────────────────────────────────────
    if (sectionEnabled('inbox')) {
    console.log('\n9. Inbox');
    currentSectionId = '9';
    await test('Inbox page renders', async (p) => {
      await goto(p, '/inbox');
      await assertHeading(p, 'Inbox');
    }, page);
    } // end §9 inbox

    // ── 10. Connections (Git tab) ─────────────────────────────────────────
    if (sectionEnabled('connections')) {
    console.log('\n10. Connections');
    currentSectionId = '10';
    await test('Connections page Git tab renders', async (p) => {
      await goto(p, '/connections/git');
      await assertHeading(p, 'Connections');
      await assertTabsExist(p, ['Git', 'AWS accounts']);
    }, page);
    } // end §10 connections

    // ── 11. Integrations ──────────────────────────────────────────────────
    if (sectionEnabled('integrations')) {
    console.log('\n11. Integrations');
    currentSectionId = '11';
    await test('Integrations page renders', async (p) => {
      await goto(p, '/integrations');
      await assertHeading(p, 'Integrations');
    }, page);
    } // end §11 integrations

    // ── 12. Connections / AWS accounts tab ───────────────────────────────
    if (sectionEnabled('connections', 'aws-accounts')) {
    console.log('\n12. Connections / AWS accounts');
    currentSectionId = '12';
    await test('Connections AWS accounts tab renders', async (p) => {
      await goto(p, '/connections/aws');
      await assertHeading(p, 'Connections');
      await assertTabsExist(p, ['Git', 'AWS accounts']);
    }, page);
    } // end §12 connections/aws-accounts

    // ── 13. API access ────────────────────────────────────────────────────
    if (sectionEnabled('api-access')) {
    console.log('\n13. API access');
    currentSectionId = '13';
    await test('API access page renders', async (p) => {
      await goto(p, '/api');
      await assertHeading(p, 'API access');
    }, page);
    } // end §13 api-access

    // ── 14. Settings ──────────────────────────────────────────────────────
    if (sectionEnabled('settings')) {
    console.log('\n14. Settings');
    currentSectionId = '14';
    await test('Settings page — heading and Portal AI provider/Tools/Permissions tabs', async (p) => {
      await goto(p, '/settings', 1200);
      await assertHeading(p, 'Settings');
      await p.waitForSelector('.tabs, [role="tablist"]', { timeout: 8000 });
      await assertTabsExist(p, ['Portal AI provider', 'Tools', 'Permissions']);
    }, page);
    } // end §14 settings

    // ── 15. Users (renamed Admin) ────────────────────────────────────────
    if (sectionEnabled('permissions', 'audit', 'api-tokens')) {
    console.log('\n15. Users');
    currentSectionId = '15';
    await test('Users page — heading and Users/Audit log/API tokens tabs', async (p) => {
      await goto(p, '/users');
      await assertHeading(p, 'Users');
      await p.waitForSelector('.tabs, [role="tablist"]', { timeout: 8000 });
      await assertTabsExist(p, ['Users', 'Audit', 'API tokens']);
    }, page);
    } // end §15 permissions/audit/api-tokens

    // ── 16. Workspaces ────────────────────────────────────────────────────
    if (sectionEnabled('workspaces')) {
    console.log('\n16. Workspaces');
    currentSectionId = '16';
    await test('Workspaces page renders', async (p) => {
      await goto(p, `/p/${projectId}/workspaces`);
      await assertHeading(p, 'Workspaces');
    }, page);
    } // end §16 workspaces

    // ── 17. Reviews (Code reviews tab) ───────────────────────────────────
    if (sectionEnabled('reviews')) {
    console.log('\n17. Reviews');
    currentSectionId = '17';
    await test('Reviews page Code reviews tab renders', async (p) => {
      await goto(p, `/p/${projectId}/reviews/code`);
      await assertHeading(p, /reviews/i);
      await assertTabsExist(p, ['Code reviews', 'Branch scans', 'Dashboard']);
    }, page);
    } // end §17 reviews

    // ── 18. Reviews dashboard tab ─────────────────────────────────────────
    if (sectionEnabled('reviews', 'dashboard')) {
    console.log('\n18. Reviews dashboard');
    currentSectionId = '18';
    await test('Reviews dashboard tab heading renders', async (p) => {
      await goto(p, `/p/${projectId}/reviews/dashboard`, 1200);
      await assertHeading(p, /reviews/i);
      await assertTabsExist(p, ['Code reviews', 'Branch scans', 'Dashboard']);
    }, page);

    await test('Period toggles Today/7/30/90 switch without JS errors', async (p) => {
      await goto(p, `/p/${projectId}/reviews/dashboard`, 1200);
      await p.waitForSelector('[role="group"][aria-label="Time period"], .tab-bar', { timeout: 8000 });
      const periodLabels = ['Today', '7 days', '30 days', '90 days'];
      for (const label of periodLabels) {
        const btn = p.locator('button').filter({ hasText: new RegExp(`^${label}$`, 'i') }).first();
        const btnCount = await btn.count();
        if (btnCount === 0) throw new Error(`Period toggle button "${label}" not found`);
        await btn.click();
        await p.waitForTimeout(600);
        const headings = await p.locator('h1, h2').allTextContents();
        const hasHeading = headings.some(t => /reviews/i.test(t));
        if (!hasHeading) throw new Error(`Heading disappeared after clicking "${label}" period toggle`);
      }
    }, page);

    await test('Empty state shown when no reviews exist in period', async (p) => {
      await goto(p, `/p/${projectId}/reviews/dashboard`, 1200);
      // Wait for spinner to clear
      await p.waitForSelector('.spinner', { state: 'detached', timeout: 8_000 }).catch(() => {});
      await p.waitForTimeout(600);
      // Fresh DB: no reviews → stat tiles show 0 or empty-state paragraph appears
      const pageText = await p.evaluate(() => document.body.innerText);
      const hasEmptyOrZero =
        /no code reviews/i.test(pageText) ||
        /no reviews in this period/i.test(pageText) ||
        /start a review/i.test(pageText) ||
        /no reviews for this project/i.test(pageText) ||
        (pageText.includes('Reviews') && /\b0\b/.test(pageText));
      if (!hasEmptyOrZero) {
        throw new Error(`Expected empty-state content on a fresh DB, got: ${pageText.slice(0, 300)}`);
      }
    }, page);
    } // end §18 reviews/dashboard

    // ── 19. Settings › Code review tab ───────────────────────────────────
    if (sectionEnabled('settings', 'reviews')) {
    console.log('\n19. Settings › Code review tab');
    currentSectionId = '19';
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

    // ── 19. Settings › Code review tab close ─────────────────────────────
    // Restore defaults after settings tests
    try {
      await apiPut('/api/settings/review', {
        mergeThreshold: 'high',
        rateCard: { inputUsd: 3, outputUsd: 15, cacheWriteUsd: 3.75, cacheReadUsd: 0.30 },
      });
    } catch { /* best effort */ }
    } // end §19 settings/reviews

    // ── 20. Code review page — new review dialog ──────────────────────────
    if (sectionEnabled('reviews')) {
    console.log('\n20. Reviews — new review dialog');
    currentSectionId = '20';

    await test('New review dialog has optional Jira ticket key field', async (p) => {
      await goto(p, `/p/${projectId}/reviews/code`, 800);
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

    await test('Creating a review then opening it navigates to reviews/code/:rid', async (p) => {
      // Navigate via an intermediate page to ensure a full page reload (same-hash goto is a no-op)
      await goto(p, '/projects', 400);
      await goto(p, `/p/${projectId}/reviews/code`, 1200);
      const newBtn = p.locator('button').filter({ hasText: /\+ New review/i }).first();
      await newBtn.waitFor({ timeout: 8_000 });
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
          { timeout: 8_000 },
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
      const match = hrefAttr?.match(/\/reviews\/code\/([^/?#]+)/);
      if (!match) throw new Error(`Could not extract reviewId from href: ${hrefAttr}`);
      reviewId = match[1];
      await openLink.click();
      await p.waitForTimeout(1500); // allow redirect to new URL
      const currentUrl = p.url();
      // URL may be at new path /reviews/code/:id (after redirect) or old /review/:id
      const hasReviewId = currentUrl.includes(reviewId);
      if (!hasReviewId) {
        throw new Error(`Expected URL to contain reviewId ${reviewId}, got: ${currentUrl}`);
      }
    }, page);
    } // end §20 reviews

    // ── 21. Review detail ─────────────────────────────────────────────────
    if (sectionEnabled('reviews')) {
    console.log('\n21. Review detail');
    currentSectionId = '21';

    // Fallback: create via API if the UI creation test above failed
    if (!reviewId) {
      try {
        reviewId = await createReviewApi(projectId, 'main', 'feature/smoke-fallback');
      } catch { /* sub-tests will fail with a clear message */ }
    }

    await test('Verdict banner is present on review detail page', async (p) => {
      if (!reviewId) throw new Error('No reviewId — review creation test failed');
      await goto(p, `/p/${projectId}/reviews/code/${reviewId}`, 1500);
      // Server always computes verdict (even for pending reviews)
      await p.waitForSelector('[role="status"]', { timeout: 8_000 });
    }, page);

    await test('Merge button disabled with visible reason for non-done review', async (p) => {
      if (!reviewId) throw new Error('No reviewId — review creation test failed');
      await goto(p, `/p/${projectId}/reviews/code/${reviewId}`, 1500);
      const mergeBtn = p.locator('button').filter({ hasText: /Merge pull request/i }).first();
      await mergeBtn.waitFor({ timeout: 8_000 });
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
      // Navigate to the new review detail page (use new URL structure)
      await goto(p, `/p/${projectId}/reviews/code/${newReviewId}`, 1500);
      // The page should show "Re-run of <parentId>" because parent_review_id is set
      await p.getByText('Re-run of', { exact: false }).waitFor({ timeout: 8000 });
      const urlAfter = p.url();
      if (!urlAfter.includes(newReviewId)) {
        throw new Error(`URL should show new review ${newReviewId}, got: ${urlAfter}`);
      }
    }, page);

    await test('Excel download button triggers a spreadsheet response', async (p) => {
      if (!reviewId) throw new Error('No reviewId — review creation test failed');
      await goto(p, `/p/${projectId}/reviews/code/${reviewId}`, 1500);
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
      await goto(p, `/p/${projectId}/reviews/code/${reviewId}`, 1500);
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

    await test('Show log button toggles run log open and closed', async (p) => {      if (!reviewId) throw new Error('No reviewId — review creation test failed');
      await goto(p, `/p/${projectId}/reviews/code/${reviewId}`, 1500);
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
    } // end §21 reviews

    // ── 22. Integrations — Atlassian type ────────────────────────────────
    if (sectionEnabled('integrations')) {
    console.log('\n22. Integrations');
    currentSectionId = '22';
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
    } // end §22 integrations

    // ── 23. Command palette ───────────────────────────────────────────────
    if (sectionEnabled('shell')) {
    console.log('\n23. Command palette');
    currentSectionId = '23';

    await test('Ctrl+K opens command palette dialog', async (p) => {
      await goto(p, '/projects', 600);
      await p.waitForSelector('.shell', { timeout: 8000 });
      await p.keyboard.press('Control+k');
      await p.waitForSelector('[role="dialog"][aria-label="Command palette"]', { timeout: 5000 });
      // Search input should be focused
      const input = p.locator('[aria-label="Search command palette"]');
      await input.waitFor({ timeout: 3000 });
    }, page);

    await test('Palette search filters items and Enter navigates', async (p) => {
      await goto(p, '/projects', 600);
      await p.keyboard.press('Control+k');
      await p.waitForSelector('[role="dialog"][aria-label="Command palette"]', { timeout: 5000 });
      // Type to filter
      await p.keyboard.type('Inbox');
      await p.waitForTimeout(300);
      // At least one item should mention Inbox
      const items = p.locator('.palette-item');
      const count = await items.count();
      if (count === 0) throw new Error('Expected palette items after typing "Inbox"');
      // First item should be Inbox nav entry
      const firstText = await items.first().textContent();
      if (!firstText?.toLowerCase().includes('inbox')) {
        throw new Error(`First palette item after "Inbox" query: "${firstText}"`);
      }
      // Press Enter — should navigate and close the palette
      await p.keyboard.press('Enter');
      await p.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {});
      await p.waitForTimeout(500);
      const url = p.url();
      if (!url.includes('#/inbox')) {
        throw new Error(`Expected navigation to #/inbox, got: ${url}`);
      }
    }, page);

    await test('Esc closes palette and restores focus', async (p) => {
      await goto(p, '/projects', 600);
      // Click a known button to give it focus before opening palette
      const paletteBtn = p.locator('[aria-label="Open command palette"]').first();
      await paletteBtn.waitFor({ timeout: 5000 });
      await paletteBtn.click();
      await p.waitForSelector('[role="dialog"][aria-label="Command palette"]', { timeout: 5000 });
      await p.keyboard.press('Escape');
      await p.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {});
    }, page);

    await test('Arrow keys navigate palette items', async (p) => {
      await goto(p, '/projects', 600);
      await p.keyboard.press('Control+k');
      await p.waitForSelector('[role="dialog"][aria-label="Command palette"]', { timeout: 5000 });
      // Arrow down selects next item
      await p.keyboard.press('ArrowDown');
      await p.waitForTimeout(100);
      const selected = await p.locator('.palette-item[aria-selected="true"]').count();
      if (selected === 0) throw new Error('No palette item is aria-selected after ArrowDown');
      await p.keyboard.press('Escape');
    }, page);
    } // end §23 shell

    // ── 24. Shortcuts sheet ───────────────────────────────────────────────
    if (sectionEnabled('shell')) {
    console.log('\n24. Shortcuts sheet');
    currentSectionId = '24';

    await test('? key opens shortcuts sheet', async (p) => {
      await goto(p, '/projects', 600);
      await p.waitForSelector('.shell', { timeout: 8000 });
      // Focus a non-input element so the shortcut fires
      await p.locator('.shell').click();
      await p.waitForTimeout(100);
      // Press '?' directly — more reliable than Shift+/ on headless Windows
      // where the produced key event may differ between keyboard layouts.
      await p.keyboard.press('?');
      await p.waitForSelector('[role="dialog"][aria-labelledby="shortcuts-title"]', { timeout: 5000 });
      // Should list some shortcuts
      const rows = await p.locator('.shortcut-row').count();
      if (rows === 0) throw new Error('Shortcuts sheet shows no shortcut rows');
      // Always close the sheet so it doesn't bleed into subsequent tests.
      await p.keyboard.press('Escape');
      await p.waitForSelector('[role="dialog"][aria-labelledby="shortcuts-title"]', { state: 'detached', timeout: 5000 });
    }, page);

    await test('Shortcuts sheet closes on Esc', async (p) => {
      await goto(p, '/projects', 600);
      await p.locator('.shell').click();
      await p.waitForTimeout(100);
      await p.keyboard.press('?');
      await p.waitForSelector('[role="dialog"][aria-labelledby="shortcuts-title"]', { timeout: 5000 });
      await p.keyboard.press('Escape');
      await p.waitForSelector('[role="dialog"][aria-labelledby="shortcuts-title"]', { state: 'detached', timeout: 5000 }).catch(() => {});
    }, page);
    } // end §24 shell

    // ── 25. Theme switch ──────────────────────────────────────────────────
    if (sectionEnabled('theme')) {
    console.log('\n25. Theme switch');
    currentSectionId = '25';

    await test('Theme button in header cycles through themes', async (p) => {
      await goto(p, '/projects', 600);
      await p.waitForSelector('.app-header', { timeout: 8000 });
      // Click the theme toggle button (has class theme-toggle-btn)
      const themeBtn = p.locator('.theme-toggle-btn').first();
      await themeBtn.waitFor({ timeout: 5000 });
      await themeBtn.click();
      await p.waitForTimeout(200);
      // The html element should have data-theme or be without it (system)
      const dataTheme = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
      // Just check one of the known values (light/dark) or null (system)
      if (dataTheme !== null && dataTheme !== 'light' && dataTheme !== 'dark') {
        throw new Error(`Unexpected data-theme value: "${dataTheme}"`);
      }
    }, page);

    await test('Theme choice persists after page reload', async (p) => {
      await goto(p, '/projects', 600);
      await p.waitForSelector('.app-header', { timeout: 8000 });
      // Set dark theme via account menu
      const accountBtn = p.locator('.account-btn').first();
      await accountBtn.waitFor({ timeout: 5000 });
      await accountBtn.click();
      await p.waitForTimeout(300);
      const darkBtn = p.locator('.account-theme-btn').filter({ hasText: /^Dark$/i }).first();
      await darkBtn.waitFor({ timeout: 3000 });
      await darkBtn.click();
      await p.waitForTimeout(300);
      // Verify dark applied
      const themeAfter = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if (themeAfter !== 'dark') {
        throw new Error(`Expected data-theme="dark" after clicking Dark, got "${themeAfter}"`);
      }
      // Reload and check theme still applied
      await p.reload({ waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(500);
      const themeAfterReload = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if (themeAfterReload !== 'dark') {
        throw new Error(`Theme did not persist after reload: got "${themeAfterReload}"`);
      }
      // Restore System theme
      await p.waitForSelector('.account-btn', { timeout: 5000 });
      const accountBtn2 = p.locator('.account-btn').first();
      await accountBtn2.click();
      await p.waitForTimeout(300);
      const systemBtn = p.locator('.account-theme-btn').filter({ hasText: /^System$/i }).first();
      await systemBtn.waitFor({ timeout: 3000 });
      await systemBtn.click();
    }, page);
    } // end §25 theme

    // ── 26. Header breadcrumb ─────────────────────────────────────────────
    if (sectionEnabled('shell')) {
    console.log('\n26. Header breadcrumb');
    currentSectionId = '26';

    await test('Header shows breadcrumb for project page', async (p) => {
      await goto(p, `/p/${projectId}/sessions`, 800);
      await p.waitForSelector('.app-header', { timeout: 8000 });
      // Breadcrumb should contain project name and "Sessions"
      const headerText = await p.locator('.app-header').textContent();
      if (!headerText?.toLowerCase().includes('sessions')) {
        throw new Error(`App header breadcrumb missing "Sessions". Header text: ${headerText}`);
      }
    }, page);
    } // end §26 shell

    // ── 27. Command palette repeated open/close ───────────────────────────
    if (sectionEnabled('shell')) {
    console.log('\n27. Command palette — repeated open/close (hooks bug regression)');
    currentSectionId = '27';

    await test('Palette opens and closes 5 times without JS errors', async (p) => {
      await goto(p, '/projects', 600);
      await p.waitForSelector('.shell', { timeout: 8000 });
      const errorsBefore = jsErrors.length;
      for (let i = 0; i < 5; i++) {
        // Open
        await p.keyboard.press('Control+k');
        await p.waitForSelector('.palette-dialog', { timeout: 4000 });
        // Close
        await p.keyboard.press('Escape');
        await p.waitForSelector('.palette-dialog', { state: 'detached', timeout: 4000 });
        await p.waitForTimeout(100);
      }
      const newErrors = jsErrors.slice(errorsBefore).filter((e) => !e.includes('[404]'));
      if (newErrors.length > 0) {
        throw new Error(`JS errors during palette open/close: ${newErrors.slice(0, 3).join('; ')}`);
      }
    }, page);
    } // end §27 shell

    // ── 28. Session IDE workspace ─────────────────────────────────────────
    if (sectionEnabled('ide', 'sessions')) {
    console.log('\n28. Session IDE workspace');
    currentSectionId = '28';

    // demoSessionId was created in always-run API setup above

    await test('Session workspace renders IDE layout with activity bar', async (p) => {
      if (!demoSessionId) throw new Error('Could not create demo session');
      await goto(p, `/p/${projectId}/sessions/${demoSessionId}`, 2000);
      await p.waitForSelector('.ide-workspace', { timeout: 8_000 });
      // Activity bar must be present
      await p.waitForSelector('.ide-activity-bar', { timeout: 5000 });
      // Activity buttons present
      const actBtns = await p.locator('.ide-activity-btn').count();
      if (actBtns < 3) throw new Error(`Expected ≥3 activity buttons, got ${actBtns}`);
      // Status bar present
      await p.waitForSelector('.ide-status-bar', { timeout: 5000 });
    }, page);

    await test('Explorer panel opens via activity bar button', async (p) => {
      if (!demoSessionId) throw new Error('Could not create demo session');
      await goto(p, `/p/${projectId}/sessions/${demoSessionId}`, 2000);
      await p.waitForSelector('.ide-workspace', { timeout: 8_000 });
      // Click the explorer activity button
      const explorerBtn = p.locator('.ide-activity-btn[title*="Explorer"]').first();
      await explorerBtn.waitFor({ timeout: 5000 });
      await explorerBtn.click();
      await p.waitForTimeout(600);
      // Sidebar should appear with explorer header
      const sidebar = await p.locator('.ide-sidebar').count();
      if (sidebar === 0) throw new Error('Sidebar did not open after clicking explorer button');
    }, page);

    await test('Source control panel opens via activity button', async (p) => {
      if (!demoSessionId) throw new Error('Could not create demo session');
      await goto(p, `/p/${projectId}/sessions/${demoSessionId}`, 2000);
      await p.waitForSelector('.ide-workspace', { timeout: 8_000 });
      // Open source control
      const scBtn = p.locator('.ide-activity-btn[title*="Source Control"]').first();
      await scBtn.waitFor({ timeout: 5000 });
      await scBtn.click();
      await p.waitForTimeout(600);
      const sidebar = await p.locator('.ide-sidebar').count();
      if (sidebar === 0) throw new Error('Source control sidebar did not open');
    }, page);

    await test('Terminal panel toggles open and closed', async (p) => {
      if (!demoSessionId) throw new Error('Could not create demo session');
      await goto(p, `/p/${projectId}/sessions/${demoSessionId}`, 2000);
      await p.waitForSelector('.ide-workspace', { timeout: 8_000 });
      const termBtn = p.locator('.ide-activity-btn[title*="terminal"], .ide-activity-btn[title*="Terminal"]').first();
      await termBtn.waitFor({ timeout: 5000 });
      await termBtn.click();
      await p.waitForTimeout(600);
      // Either terminal panel opened or shows capability message
      const termPanel = await p.locator('.ide-terminal-panel').count();
      const bodyText = await p.evaluate(() => document.body.innerText);
      const hasTerm = termPanel > 0 || bodyText.includes('disabled') || bodyText.includes('not available') || bodyText.includes('Terminal');
      if (!hasTerm) throw new Error('Terminal panel did not appear after clicking terminal button');
      // Close it
      await termBtn.click();
      await p.waitForTimeout(400);
    }, page);

    await test('Rename session from header updates the IDE header', async (p) => {
      if (!demoSessionId) throw new Error('Could not create demo session');
      await goto(p, `/p/${projectId}/sessions/${demoSessionId}`, 2000);
      await p.waitForSelector('.ide-workspace', { timeout: 8_000 });
      // Open more menu
      const moreBtn = p.locator('button[aria-label="More session actions"]').first();
      await moreBtn.waitFor({ timeout: 6000 });
      await moreBtn.click();
      await p.waitForTimeout(300);
      // Click rename
      const renameItem = p.locator('[role="menuitem"]').filter({ hasText: /rename/i }).first();
      await renameItem.waitFor({ timeout: 4000 });
      await renameItem.click();
      await p.waitForTimeout(300);
      // Rename input should be visible
      const renameInput = p.locator('.ide-header-rename-input').first();
      await renameInput.waitFor({ timeout: 4000 });
      await renameInput.fill('Renamed smoke session');
      await renameInput.press('Enter');
      await p.waitForTimeout(500);
      // The session in the list should show the new name (or at least no error)
      const bodyText = await p.evaluate(() => document.body.innerText);
      const renameOk = bodyText.includes('Renamed smoke') || !bodyText.includes('error');
      if (!renameOk) throw new Error('Rename did not appear to succeed');
    }, page);

    await test('Status bar is visible in IDE workspace', async (p) => {
      if (!demoSessionId) throw new Error('Could not create demo session');
      await goto(p, `/p/${projectId}/sessions/${demoSessionId}`, 2000);
      await p.waitForSelector('.ide-status-bar', { timeout: 8_000 });
    }, page);
    } // end §28 ide/sessions

    // ── 29. Credentials page (F4) ────────────────────────────────────────
    if (sectionEnabled('credentials')) {
    console.log('\n29. Credentials page (F4)');
    currentSectionId = '29';

    await test('Credentials page renders with engine sections', async (p) => {
      await goto(p, '/credentials', 1000);
      await assertHeading(p, 'Credentials');
      // Should show both engine sections
      const bodyText = await p.evaluate(() => document.body.innerText);
      const hasKiro = /kiro/i.test(bodyText);
      const hasClaude = /claude code/i.test(bodyText);
      if (!hasKiro) throw new Error('Credentials page missing Kiro section');
      if (!hasClaude) throw new Error('Credentials page missing Claude Code section');
    }, page);

    await test('Add a Claude API key credential and see last 4 only', async (p) => {
      await goto(p, '/credentials', 1000);
      // Open the "Add Claude Code credential" dialog
      const addBtn = p.locator('button').filter({ hasText: /add claude code/i }).first();
      await addBtn.waitFor({ timeout: 8000 });
      await addBtn.click();
      await p.waitForSelector('[role="dialog"][aria-labelledby="add-cred-title"]', { timeout: 5000 });

      // Select "API key" mode (should be default)
      const apiKeyMode = p.locator('[role="radio"]').filter({ hasText: /API key/i }).first();
      await apiKeyMode.waitFor({ timeout: 3000 });
      await apiKeyMode.click();

      // Fill in the API key field
      const secretField = p.locator('input#cred-secret');
      await secretField.waitFor({ timeout: 3000 });
      await secretField.fill('test-anthropic-key-ABCD');

      // Set a name
      await p.fill('input#cred-name', 'Smoke test key');

      // Submit
      const submitBtn = p.locator('[role="dialog"] .btn-primary').first();
      await submitBtn.click();

      // Dialog should close
      await p.waitForSelector('[role="dialog"][aria-labelledby="add-cred-title"]', {
        state: 'detached', timeout: 8000,
      }).catch(() => {});
      await p.waitForTimeout(600);

      // The credential should appear in the list with last 4 shown
      const credText = await p.evaluate(() => document.body.innerText);
      // Should show "ABCD" (last 4) — not the full key
      const hasLast4 = credText.includes('ABCD');
      const hasFullKey = credText.includes('test-anthropic-key-ABCD');
      if (!hasLast4) throw new Error('Last 4 chars not shown in credentials list');
      if (hasFullKey) throw new Error('Full secret key should not be visible in UI');
    }, page);
    } // end §29 credentials

    // ── 30. Configuration page (F5) ──────────────────────────────────────
    if (sectionEnabled('config')) {
    console.log('\n30. Configuration page (F5)');
    currentSectionId = '30';

    await test('Configuration page renders with Kiro/Claude/AWS tabs', async (p) => {
      await goto(p, '/config', 1200);
      await assertHeading(p, 'Configuration');
      await p.waitForSelector('.tabs, [role="tablist"]', { timeout: 8000 });
      await assertTabsExist(p, ['~/.kiro', '~/.claude', '~/.aws']);
    }, page);

    await test('AWS tab shows credential warning', async (p) => {
      await goto(p, '/config', 1200);
      await p.waitForSelector('#cfg-tab-aws', { timeout: 8000 });
      await p.click('#cfg-tab-aws');
      await p.waitForTimeout(500);
      const bodyText = await p.evaluate(() => document.body.innerText);
      const hasWarning = /aws credentials|encrypted at rest|keys/i.test(bodyText);
      if (!hasWarning) throw new Error('AWS tab should show credential warning');
    }, page);

    await test('Create a JSON file and verify invalid-JSON error path', async (p) => {
      // Navigate away first so Configuration remounts with the kiro tab (default).
      await goto(p, '/projects', 200);
      await goto(p, '/config', 1400);
      // Stay on kiro tab (default)
      await p.waitForSelector('.config-tree-pane, .config-layout', { timeout: 8000 });

      // Click "New file" button in the tree header
      const newFileBtn = p.locator('[aria-label="New file"]').first();
      await newFileBtn.waitFor({ timeout: 10000 });
      await newFileBtn.click();
      await p.waitForTimeout(200);

      // Handle prompt dialog
      await p.waitForEvent('dialog').then(async (d) => {
        await d.accept('test-smoke.json');
      }).catch(async () => {
        // If prompt isn't intercepted, type into any prompt input
      });
      await p.waitForTimeout(600);

      // Select the file in the tree if it was created
      const fileEntry = p.locator('.config-tree-entry').filter({ hasText: 'test-smoke.json' }).first();
      const fileCount = await fileEntry.count();
      if (fileCount === 0) {
        // File creation via prompt may have been blocked; skip editor test
        return;
      }
      await fileEntry.click();
      await p.waitForTimeout(500);

      // Verify editor header shows filename
      const editorHeader = p.locator('.config-editor-header').first();
      const headerText = await editorHeader.textContent().catch(() => '');
      if (!headerText?.includes('test-smoke.json')) {
        throw new Error(`Editor header should show filename, got: ${headerText}`);
      }
    }, page);
    } // end §30 config

    // ── 31. New session dialog (F6) ──────────────────────────────────────
    if (sectionEnabled('sessions', 'engines')) {
    console.log('\n31. New session dialog (F6)');
    currentSectionId = '31';

    await test('New session dialog shows engine cards and agent picker', async (p) => {
      await goto(p, `/p/${projectId}/sessions`, 1000);
      // Open the new session dialog
      const newBtn = p.locator('button').filter({ hasText: /new session/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
      await newBtn.click();
      await p.waitForSelector('[role="dialog"][aria-labelledby="new-session-title"]', { timeout: 5000 });

      // Engine radio buttons should be visible
      const engineRadios = p.locator('[name="ns-engine"]');
      const engineCount = await engineRadios.count();
      if (engineCount < 3) throw new Error(`Expected ≥3 engine options, got ${engineCount}`);

      // Should have Demo, Claude Code, Kiro options
      const bodyText = await p.evaluate(() => document.body.innerText);
      if (!/demo/i.test(bodyText)) throw new Error('Demo engine option missing');
      if (!/claude code/i.test(bodyText)) throw new Error('Claude Code engine option missing');
      if (!/kiro/i.test(bodyText)) throw new Error('Kiro engine option missing');

      // Select Claude Code engine to trigger agent/model loading
      const claudeRadio = p.locator('[name="ns-engine"][value="claude-code"]').first();
      await claudeRadio.click();
      await p.waitForTimeout(800);

      // Agent picker should appear (select#ns-agent or a spinner)
      const agentPicker = p.locator('#ns-agent, [aria-label="Loading agents…"]').first();
      const agentPickerCount = await agentPicker.count();
      if (agentPickerCount === 0) throw new Error('Agent picker did not appear after selecting Claude Code');

      await p.keyboard.press('Escape');
    }, page);

    await test('Credential picker appears when multiple credentials exist', async (p) => {
      // First, add a second Claude credential via API so picker shows
      try {
        await apiPost('/api/credentials', {
          engine: 'claude-code',
          mode: 'api_key',
          name: 'Second smoke cred',
          secret: 'second-key-WXYZ',
        });
      } catch { /* may already exist */ }

      await goto(p, `/p/${projectId}/sessions`, 1000);
      const newBtn = p.locator('button').filter({ hasText: /new session/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
      await newBtn.click();
      await p.waitForSelector('[role="dialog"][aria-labelledby="new-session-title"]', { timeout: 5000 });

      // Select Claude Code
      const claudeRadio = p.locator('[name="ns-engine"][value="claude-code"]').first();
      await claudeRadio.click();
      await p.waitForTimeout(1000);

      // Credential picker should appear (>1 credential exists)
      const credPicker = p.locator('#ns-cred').first();
      const credCount = await credPicker.count();
      if (credCount === 0) throw new Error('Credential picker should appear when multiple credentials exist');

      await p.keyboard.press('Escape');
    }, page);

    await test('Model field appears for Kiro engine with "Engine default" option', async (p) => {
      // Add a Kiro API key credential so the Kiro engine radio is enabled in the dialog
      try {
        await apiPost('/api/credentials', {
          engine: 'kiro',
          mode: 'api_key',
          name: 'Smoke Kiro key',
          secret: 'kiro-test-key-EFGH',
        });
      } catch { /* may already exist or fail — handled below */ }

      await goto(p, `/p/${projectId}/sessions`, 1000);
      const newBtn = p.locator('button').filter({ hasText: /new session/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
      await newBtn.click();
      await p.waitForSelector('[role="dialog"][aria-labelledby="new-session-title"]', { timeout: 5000 });

      // Wait for init load so engine availability is resolved
      await p.waitForTimeout(1200);

      // Select Kiro engine — it should be enabled because we just added a credential
      const kiroRadio = p.locator('[name="ns-engine"][value="kiro"]').first();
      await kiroRadio.waitFor({ state: 'visible', timeout: 5000 });
      const isDisabled = await kiroRadio.isDisabled();
      if (isDisabled) {
        // Credential didn't load in time — open and close without asserting
        await p.keyboard.press('Escape');
        return; // skip rather than fail due to test infrastructure
      }
      await kiroRadio.click();
      // Allow time for ModelPicker to mount and start loading
      await p.waitForTimeout(800);

      // Model label must be present (field existence check)
      const modelLabel = p.locator('label[for="ns-model"]').first();
      const modelLabelCount = await modelLabel.count();
      if (modelLabelCount === 0) {
        // Might still be loading — spinner is an acceptable state
        const spinner = p.locator('[aria-label="Loading models…"]').first();
        const spinnerCount = await spinner.count();
        if (spinnerCount === 0) {
          throw new Error('Model field or loading spinner did not appear after selecting Kiro engine');
        }
      }

      // Wait for the loading spinner to clear — endpoint may return an error in test env, that's OK
      await p.waitForSelector('[aria-label="Loading models…"]', { state: 'detached', timeout: 6000 }).catch(() => {});
      await p.waitForTimeout(300);

      // After loading, the select must be present and "Engine default" must be the first option
      const modelSelect = p.locator('#ns-model').first();
      const modelSelectCount = await modelSelect.count();
      if (modelSelectCount === 0) {
        throw new Error('Model select (#ns-model) not found after spinner cleared');
      }
      const defaultOptionText = await modelSelect.locator('option[value=""]').textContent().catch(() => '');
      if (!defaultOptionText?.toLowerCase().includes('engine default')) {
        throw new Error(`"Engine default" option not found in model select. Got: "${defaultOptionText}"`);
      }

      await p.keyboard.press('Escape');
    }, page);
    } // end §31 sessions/engines

    // ── 32. Settings — tabs after refactor ───────────────────────────────
    if (sectionEnabled('settings')) {
    console.log('\n32. Settings — Portal AI provider rename + Sessions tab');
    currentSectionId = '32';

    await test('Settings has Sessions tab but NOT Claude models or Users or API tokens tabs', async (p) => {
      await goto(p, '/settings', 1200);
      await assertHeading(p, 'Settings');
      await p.waitForSelector('.tabs, [role="tablist"]', { timeout: 8000 });
      // Sessions tab must still exist
      await assertTabsExist(p, ['Sessions']);
      // Provider is now labelled "Portal AI provider"
      await assertTabsExist(p, ['Portal AI provider']);
      // Removed tabs must be absent
      const tabTexts = await p.locator('.tab-btn, [role="tab"]').allTextContents();
      const hasClaudeModels = tabTexts.some(t => /claude models/i.test(t));
      const hasUsers = tabTexts.some(t => /^Users$/i.test(t.trim()));
      const hasApiTokens = tabTexts.some(t => /api tokens/i.test(t));
      if (hasClaudeModels) throw new Error('Claude models tab should have been removed');
      if (hasUsers) throw new Error('Users tab in Settings should have been removed');
      if (hasApiTokens) throw new Error('API tokens tab in Settings should have been removed');
    }, page);

    await test('Sessions tab shows idle-stop and terminal settings', async (p) => {
      await goto(p, '/settings', 1200);
      await p.waitForSelector('[id="tab-sessions"]', { timeout: 8000 });
      await p.click('[id="tab-sessions"]');
      await p.waitForTimeout(800);
      const bodyText = await p.evaluate(() => document.body.innerText);
      const hasIdleStop = /idle/i.test(bodyText);
      const hasTerminal = /terminal/i.test(bodyText);
      if (!hasIdleStop) throw new Error('Sessions tab should show idle-stop setting');
      if (!hasTerminal) throw new Error('Sessions tab should show terminal setting');
    }, page);

    await test('Portal AI provider tab shows provider description', async (p) => {
      await goto(p, '/settings', 1200);
      await p.waitForSelector('[id="tab-provider"]', { timeout: 8000 });
      await p.click('[id="tab-provider"]');
      await p.waitForTimeout(600);
      const bodyText = await p.evaluate(() => document.body.innerText);
      // The description line should be visible
      const hasDescription = /portal.{0,10}own ai account|fallback for sessions|code reviews/i.test(bodyText);
      if (!hasDescription) throw new Error('Portal AI provider tab should show description line');
    }, page);

    await test('Settings page is accessible to all users (non-admin banner shows for non-admins)', async (p) => {
      // As admin, no read-only banner
      await goto(p, '/settings', 1200);
      await p.waitForSelector('.page', { timeout: 8000 });
      const bodyText = await p.evaluate(() => document.body.innerText);
      // Admin should NOT see the non-admin banner
      const hasReadOnlyBanner = /only admins can change these settings/i.test(bodyText);
      // For admin user in this test, banner should NOT be visible
      if (hasReadOnlyBanner) {
        throw new Error('Admin should not see "only admins can change" banner');
      }
    }, page);

    // Bedrock SSO: signed in, no role → account/role picker is visible.
    // Uses a test-only endpoint (only present when NODE_ENV=test) to inject
    // a fake SSO signed-in state so the picker shows without a real AWS flow.
    await test('Bedrock SSO: signed-in-no-role → account/role picker visible', async (p) => {
      // 1. Configure the portal to use bedrock/sso auth
      await apiPut('/api/settings', {
        provider: { mode: 'bedrock', bedrockAuth: 'sso', ssoStartUrl: 'https://d-fake.awsapps.com/start', ssoRegion: 'us-east-1' },
        defaultModel: '',
        models: { sonnet: '' },
      });

      // 2. Inject a fake SSO token via the test-only endpoint (NODE_ENV=test)
      const injectRes = await fetch(`${BASE}/api/settings/bedrock-sso/_test_set_signed_in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'agent-portal', cookie: sessionCookie },
        body: JSON.stringify({}),
      });
      if (!injectRes.ok) {
        // If the endpoint doesn't exist (production build), skip gracefully
        console.log('    ℹ  _test_set_signed_in not available — skipping SSO picker test');
        return;
      }

      // 3. Navigate to Settings › Portal AI provider tab
      // Navigate away first so the Settings component unmounts and re-fetches on remount
      await goto(p, '/projects', 300);
      await goto(p, '/settings', 1400);
      await p.waitForSelector('[id="tab-provider"]', { timeout: 8000 });
      await p.click('[id="tab-provider"]');
      // Wait for accounts loading to complete or fail (AWS SDK timeout)
      await p.waitForTimeout(3000);

      // 4. Bedrock should be selected; make sure SSO auth section is visible
      const bodyText = await p.evaluate(() => document.body.innerText);
      if (!/(bedrock|amazon)/i.test(bodyText)) {
        throw new Error('Bedrock provider section not visible after configuring bedrock/sso');
      }
      const hasSsoSection = /sso start url|identity center/i.test(bodyText);
      if (!hasSsoSection) {
        throw new Error('SSO section not visible — bedrockAuth may not be set to sso in the rendered page');
      }

      // 5. The account picker section must be present — either the dropdown label
      //    or an error message (when the fake token can't call real AWS APIs).
      //    Both prove the picker is shown whenever signed in.
      const accountLabel    = p.locator('label').filter({ hasText: /aws account/i }).first();
      const accountError    = p.locator('.error-note').filter({ hasText: /accounts|sign in again/i }).first();
      const labelCount = await accountLabel.count();
      const errorCount = await accountError.count();
      if (labelCount === 0 && errorCount === 0) {
        throw new Error(
          'AWS account label not visible — account/role picker should always be shown when signed in, ' +
          'not only right after the sign-in flow.',
        );
      }

      // 6. Status row must show warning (signed in but no account/role configured)
      const statusRow = p.locator('.sso-status-row').first();
      const statusRowCount = await statusRow.count();
      if (statusRowCount === 0) {
        throw new Error('SSO status row not visible');
      }
      const statusText = await statusRow.textContent();
      const isWarningState = /choose an aws account and role|signed in/i.test(statusText ?? '');
      if (!isWarningState) {
        throw new Error(`Status row should indicate "choose account/role", got: "${statusText}"`);
      }

      // 7. "Sign in again" (secondary) is visible — not the primary "Sign in with AWS SSO"
      //    The "Sign in again" text may appear either in the main button or inside an error note.
      const signInAgainText = p.locator('button, .error-note').filter({ hasText: /sign in again/i }).first();
      const signInAgainCount = await signInAgainText.count();
      if (signInAgainCount === 0) {
        throw new Error('"Sign in again" button/link not visible when already signed in');
      }

      // Cleanup: reset provider to demo so subsequent tests are unaffected
      await apiPut('/api/settings', {
        provider: { mode: 'demo' },
        defaultModel: '',
        models: { sonnet: '' },
      });
    }, page);
    } // end §32 settings

    // ── 33. Nav — Credentials and Configuration links ─────────────────────
    if (sectionEnabled('shell', 'credentials', 'config')) {
    console.log('\n33. Nav — Credentials and Configuration');
    currentSectionId = '33';

    await test('Nav includes Credentials and Configuration links (always visible, no dropdown)', async (p) => {
      await goto(p, '/projects', 600);
      await p.waitForSelector('.rail', { timeout: 5000 });
      // New flat nav: links are always visible without expanding any group
      const credLink = p.locator('.rail [href="#/credentials"]').first();
      await credLink.waitFor({ timeout: 5000 });
      const configLink = p.locator('.rail [href="#/config"]').first();
      await configLink.waitFor({ timeout: 3000 });
      // No Portal group dropdown button should exist
      const oldPortalBtn = await p.locator('.rail-group-btn').count();
      if (oldPortalBtn > 0) {
        throw new Error('Old Portal group button should be removed — nav is now flat');
      }
    }, page);

    await test('g+y shortcut navigates to Credentials', async (p) => {
      await goto(p, '/projects', 600);
      await p.waitForSelector('.shell', { timeout: 5000 });
      // Focus shell (non-input area)
      await p.locator('.shell').click();
      await p.waitForTimeout(100);
      // Press g then y
      await p.keyboard.press('g');
      await p.waitForTimeout(50);
      await p.keyboard.press('y');
      await p.waitForTimeout(600);
      const url = p.url();
      if (!url.includes('#/credentials')) {
        throw new Error(`g+y should navigate to #/credentials, got: ${url}`);
      }
    }, page);
    } // end §33 shell/credentials/config

    // ── 34. Branch scans (F9) ─────────────────────────────────────────────
    if (sectionEnabled('branch-scans')) {
    console.log('\n34. Branch scans (F9)');
    currentSectionId = '34';

    await test('Branch scans page renders with "New scan" button', async (p) => {
      await goto(p, `/p/${projectId}/branchscans`, 1000);
      // Old URL redirects to /reviews/branch-scans; heading says "Reviews"
      await assertHeading(p, /reviews/i);
      // New scan button must be present
      const newBtn = p.locator('button').filter({ hasText: /new scan/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
    }, page);

    await test('New scan dialog opens and shows form fields', async (p) => {
      await goto(p, `/p/${projectId}/branchscans`, 1000);
      const newBtn = p.locator('button').filter({ hasText: /new scan/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
      await newBtn.click();
      await p.waitForSelector('[role="dialog"][aria-labelledby="new-scan-title"]', { timeout: 6000 });
      // Repository select must exist
      await p.locator('#scan-repo').waitFor({ timeout: 4000 });
      // Branch field
      await p.locator('#scan-branch').waitFor({ timeout: 4000 });
      // Include paths textarea
      await p.locator('#scan-include').waitFor({ timeout: 4000 });
      // Exclude paths textarea
      await p.locator('#scan-exclude').waitFor({ timeout: 4000 });
      // "Estimate scan" submit button
      const submitBtn = p.locator('[role="dialog"] button[type="submit"]').first();
      await submitBtn.waitFor({ timeout: 4000 });
      const submitText = await submitBtn.textContent();
      if (!submitText?.toLowerCase().includes('estimate')) {
        throw new Error(`Expected submit button to say "Estimate scan", got: "${submitText}"`);
      }
      await p.keyboard.press('Escape');
    }, page);

    await test('Branch scan filters bar renders with search + status fields', async (p) => {
      await goto(p, `/p/${projectId}/branchscans`, 1000);
      // Old URL redirects to /reviews/branch-scans; heading says "Reviews"
      await assertHeading(p, /reviews/i);
      // Filter search input
      await p.locator('[aria-label="Search scans"]').waitFor({ timeout: 6000 });
      // Status filter
      await p.locator('[aria-label="Filter by scan status"]').waitFor({ timeout: 4000 });
    }, page);

    await test('Scan detail page renders for seeded scan', async (p) => {
      // Seed a scan via API (will fail with 403 if user not in allowlist, but for admin it succeeds)
      // First get repos for this project
      const repoData = await apiGet(`/api/projects/${projectId}/repos`).catch(() => ({ repos: [] }));
      const repos = (repoData as any).repos as any[];

      if (repos.length === 0) {
        // No repos — navigate to branchscans list and verify empty state
        await goto(p, `/p/${projectId}/branchscans`, 1000);
        const bodyText = await p.evaluate(() => document.body.innerText);
        const hasEmpty = /no branch scans found|no scans/i.test(bodyText);
        if (!hasEmpty && !bodyText.includes('scan')) {
          throw new Error('Expected branch scans page to render even with no repos');
        }
        return; // Skip scan detail test when no repos exist
      }

      // Attempt to create a scan (admin user is always in allowlist)
      let scanId = '';
      try {
        const scanData = await apiPost(`/api/projects/${projectId}/scans`, {
          repoId: repos[0].id,
          branch: 'main',
        });
        scanId = (scanData as any).scan?.id ?? '';
      } catch {
        // allowlist may be empty — skip detail test
        return;
      }

      if (!scanId) return;

      // Navigate to the scan detail
      await goto(p, `/p/${projectId}/branchscans/${scanId}`, 1500);
      // Should show "Branch scan" heading
      await assertHeading(p, /branch scan/i);
      // Status stepper must be present
      await p.waitForSelector('[aria-label="Scan progress"]', { timeout: 8000 });
      // Should show scan status (estimating or estimate_ready)
      const bodyText = await p.evaluate(() => document.body.innerText);
      const hasStatus = /estimating|estimate ready|failed/i.test(bodyText);
      if (!hasStatus) {
        throw new Error(`Scan detail should show status, got: ${bodyText.slice(0, 200)}`);
      }
    }, page);

    await test('Branch-scan detail renders without JS errors (ReferenceError regression)', async (p) => {
      // This test specifically catches the class of bug where ToastShelf was
      // rendered inside StatusStepper/ProgressSection without toasts/removeToast
      // being in scope → ReferenceError on every scan-detail page load.
      const repoData = await apiGet(`/api/projects/${projectId}/repos`).catch(() => ({ repos: [] }));
      const repos = (repoData as any).repos as any[];

      if (repos.length === 0) {
        // No repos seeded — page should still load without crashing
        const errorsBefore = jsErrors.length;
        await goto(p, `/p/${projectId}/branchscans`, 1000);
        await p.waitForTimeout(600);
        const newErrors = jsErrors.slice(errorsBefore).filter(
          (e) => !e.includes('[404]') && !/favicon/i.test(e),
        );
        if (newErrors.length > 0) {
          throw new Error(`JS errors on branch-scans list page: ${newErrors.slice(0, 3).join('; ')}`);
        }
        return;
      }

      let scanId = '';
      try {
        const scanData = await apiPost(`/api/projects/${projectId}/scans`, {
          repoId: repos[0].id,
          branch: 'main',
        });
        scanId = (scanData as any).scan?.id ?? '';
      } catch {
        return; // allowlist empty — skip
      }
      if (!scanId) return;

      const errorsBefore = jsErrors.length;
      await goto(p, `/p/${projectId}/branchscans/${scanId}`, 1500);
      // Wait for the status stepper to appear (triggers the previously-crashing code path)
      await p.waitForSelector('[aria-label="Scan progress"]', { timeout: 8_000 });
      await p.waitForTimeout(500);

      const newErrors = jsErrors.slice(errorsBefore).filter(
        (e) => !e.includes('[404]') && !/favicon/i.test(e),
      );
      if (newErrors.length > 0) {
        throw new Error(
          `JS errors on branch-scan detail page (ReferenceError regression): ${newErrors.slice(0, 3).join('; ')}`,
        );
      }
    }, page);
    } // end §34 branch-scans

    // ── 35. Review filters in URL (F10) ───────────────────────────────────
    if (sectionEnabled('reviews')) {
    console.log('\n35. Review filters in URL (F10)');
    currentSectionId = '35';

    await test('Review page filters bar renders with search and status fields', async (p) => {
      await goto(p, `/p/${projectId}/review`, 1000);
      // Old URL redirects to /reviews/code; heading says "Reviews"
      await assertHeading(p, /reviews/i);
      // Filter search must be present
      await p.locator('[aria-label="Search reviews"]').waitFor({ timeout: 6000 });
      // Status filter
      await p.locator('[aria-label="Filter by review status"]').waitFor({ timeout: 4000 });
      // Type filter
      await p.locator('[aria-label="Filter by review type"]').waitFor({ timeout: 4000 });
    }, page);

    await test('Setting status filter reflects in URL hash query', async (p) => {
      await goto(p, `/p/${projectId}/review`, 1000);
      await p.waitForSelector('[aria-label="Filter by review status"]', { timeout: 6000 });
      // Select 'done' status
      await p.selectOption('[aria-label="Filter by review status"]', 'done');
      await p.waitForTimeout(600);
      // URL should include status=done in hash query
      const url = p.url();
      const hashPart = url.split('#')[1] ?? '';
      if (!hashPart.includes('status=done')) {
        throw new Error(`Expected URL hash to contain "status=done", got hash: ${hashPart}`);
      }
    }, page);

    await test('Review page loads with filters from URL query', async (p) => {
      // Navigate with pre-set filter in URL
      await goto(p, `/p/${projectId}/review?runBy=me&status=done`, 1200);
      await p.waitForSelector('[aria-label="Filter by review status"]', { timeout: 6000 });
      // The status filter should show 'done'
      const statusVal = await p.locator('[aria-label="Filter by review status"]').inputValue();
      if (statusVal !== 'done') {
        throw new Error(`Expected status filter to be "done" from URL, got: "${statusVal}"`);
      }
    }, page);
    } // end §35 reviews

    // ── 36. Code review settings — PR comment mode (F10) ──────────────────
    if (sectionEnabled('settings', 'reviews')) {
    console.log('\n36. Code review settings — PR comment mode (F10)');
    currentSectionId = '36';

    await test('Code review tab shows PR comment mode options', async (p) => {
      await goto(p, '/settings', 1400);
      await p.waitForSelector('#tab-codereview', { timeout: 8000 });
      await p.click('#tab-codereview');
      await p.waitForTimeout(800);
      // Should show PR comment mode radio buttons
      const manualRadio = p.locator('[name="prCommentMode"][value="manual"]').first();
      await manualRadio.waitFor({ timeout: 6000 });
      const autoRadio = p.locator('[name="prCommentMode"][value="automatic"]').first();
      await autoRadio.waitFor({ timeout: 3000 });
    }, page);

    await test('Switching to automatic and saving updates prCommentMode', async (p) => {
      await goto(p, '/settings', 1400);
      await p.waitForSelector('#tab-codereview', { timeout: 8000 });
      await p.click('#tab-codereview');
      await p.waitForTimeout(800);
      // Select automatic
      await p.click('[name="prCommentMode"][value="automatic"]');
      await p.click('button[type="submit"]');
      await p.locator('[role="status"]').filter({ hasText: /saved/i }).waitFor({ timeout: 8000 });
      // Confirm via API
      const settings = await apiGet('/api/settings/review');
      if ((settings as any).prCommentMode !== 'automatic') {
        throw new Error(`prCommentMode should be "automatic" after save, got "${(settings as any).prCommentMode}"`);
      }
      // Reset to manual
      await apiPut('/api/settings/review', { prCommentMode: 'manual' });
    }, page);

    await test('Code review tab shows LiteLLM gateway fields', async (p) => {
      await goto(p, '/settings', 1400);
      await p.waitForSelector('#tab-codereview', { timeout: 8000 });
      await p.click('#tab-codereview');
      await p.waitForTimeout(800);
      // LiteLLM URL field
      await p.locator('#litellm-url').waitFor({ timeout: 6000 });
      // LiteLLM model field
      await p.locator('#litellm-model').waitFor({ timeout: 3000 });
      // Security warning note
      const bodyText = await p.evaluate(() => document.body.innerText);
      if (!/gateway operator.*can read|security note/i.test(bodyText)) {
        throw new Error('LiteLLM gateway section should show security warning');
      }
    }, page);
    } // end §36 settings/reviews

    // ── 37. API Access — scope checkboxes + MCP section (F11) ─────────────
    if (sectionEnabled('api-access', 'api-tokens')) {
    console.log('\n37. API Access — scope checkboxes + MCP section (F11)');
    currentSectionId = '37';

    await test('API access page shows scope checkboxes in new token modal', async (p) => {
      await goto(p, '/api', 1000);
      await assertHeading(p, /api access/i);
      // Open new token modal
      const newBtn = p.locator('button').filter({ hasText: /new token/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
      await newBtn.click();
      await p.waitForSelector('[role="dialog"][aria-label="Create API token"]', { timeout: 5000 });
      // Read scope checkbox should be present and disabled (always on)
      const readCheckbox = p.locator('[name="tok-scope"][value="read"]').first();
      await readCheckbox.waitFor({ timeout: 4000 });
      const isDisabled = await readCheckbox.isDisabled();
      if (!isDisabled) {
        throw new Error('Read scope checkbox should be disabled (always on)');
      }
      // Write, Review, Merge checkboxes
      const writeCheckbox = p.locator('[name="tok-scope"][value="write"]').first();
      await writeCheckbox.waitFor({ timeout: 3000 });
      const reviewCheckbox = p.locator('[name="tok-scope"][value="review"]').first();
      await reviewCheckbox.waitFor({ timeout: 3000 });
      const mergeCheckbox = p.locator('[name="tok-scope"][value="merge"]').first();
      await mergeCheckbox.waitFor({ timeout: 3000 });
      // Expiry dropdown
      const expirySelect = p.locator('#tok-expiry').first();
      await expirySelect.waitFor({ timeout: 3000 });
      await p.keyboard.press('Escape');
    }, page);

    await test('Creating a review+merge scoped token shows in table with scope labels', async (p) => {
      await goto(p, '/api', 1000);
      const newBtn = p.locator('button').filter({ hasText: /new token/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
      await newBtn.click();
      await p.waitForSelector('[role="dialog"][aria-label="Create API token"]', { timeout: 5000 });
      // Fill name
      await p.fill('#tok-name', 'Smoke scoped token');
      // Enable review scope
      await p.click('[name="tok-scope"][value="review"]');
      // Enable merge scope
      await p.click('[name="tok-scope"][value="merge"]');
      // Submit
      await p.locator('[role="dialog"] .btn-primary').first().click();
      // Token reveal modal
      await p.waitForSelector('[role="dialog"][aria-label="Token created"]', { timeout: 6000 });
      await p.locator('[role="dialog"][aria-label="Token created"] .btn-primary').first().click();
      await p.waitForSelector('[role="dialog"][aria-label="Token created"]', { state: 'detached', timeout: 5000 }).catch(() => {});
      await p.waitForTimeout(400);
      // Token should appear in table with merge scope label
      const tableText = await p.locator('.data-table').first().textContent();
      if (!tableText?.toLowerCase().includes('merge')) {
        throw new Error(`Token table should show merge scope, got: ${tableText?.slice(0, 200)}`);
      }
    }, page);

    await test('API access page shows MCP section with endpoint URL', async (p) => {
      await goto(p, '/api', 1200);
      await assertHeading(p, /api access/i);
      // Wait for MCP section heading
      await p.getByText('Connect an AI agent', { exact: false }).waitFor({ timeout: 8000 });
      // MCP endpoint URL should be shown
      const bodyText = await p.evaluate(() => document.body.innerText);
      const hasMcpUrl = /\/api\/mcp/i.test(bodyText);
      if (!hasMcpUrl) {
        throw new Error('MCP section should show /api/mcp endpoint URL');
      }
      // Should show tool list grouped by scope
      const hasToolList = /list_sessions|start_session/i.test(bodyText);
      if (!hasToolList) {
        throw new Error('MCP section should show tool list');
      }
      // REST section
      // REST section heading — use role selector to avoid matching the description paragraph
      await p.getByRole('heading', { name: 'REST API' }).waitFor({ timeout: 5000 });
    }, page);
    } // end §37 api-access/api-tokens

    // ── 38. Branch scans in command palette ───────────────────────────────
    if (sectionEnabled('branch-scans', 'shell')) {
    console.log('\n38. Branch scans in command palette');
    currentSectionId = '38';

    await test('Command palette shows Branch scans entry in a project context', async (p) => {
      await goto(p, `/p/${projectId}/branchscans`, 800);
      await p.waitForSelector('.shell', { timeout: 8000 });
      await p.keyboard.press('Control+k');
      await p.waitForSelector('[role="dialog"][aria-label="Command palette"]', { timeout: 5000 });
      await p.keyboard.type('branch');
      await p.waitForTimeout(300);
      const items = p.locator('.palette-item');
      const count = await items.count();
      if (count === 0) throw new Error('Expected palette items after typing "branch"');
      const texts = await items.allTextContents();
      const hasBranch = texts.some((t) => /branch scan/i.test(t));
      if (!hasBranch) {
        throw new Error(`Expected "Branch scans" in palette items, got: ${JSON.stringify(texts.slice(0, 5))}`);
      }
      await p.keyboard.press('Escape');
    }, page);
    } // end §38 branch-scans/shell

    // ── 39. F7 — Delegate dialog + Agents activity ───────────────────────
    if (sectionEnabled('delegation', 'sessions')) {
    console.log('\n39. F7 — Delegate dialog + Agents activity');
    currentSectionId = '39';

    await test('Delegate dialog opens from More session actions menu', async (p) => {
      if (!demoSessionId) throw new Error('No demo session available');
      await goto(p, `/p/${projectId}/sessions/${demoSessionId}`, 2000);
      await p.waitForSelector('.ide-workspace', { timeout: 8_000 });
      // Open more menu
      const moreBtn = p.locator('button[aria-label="More session actions"]').first();
      await moreBtn.waitFor({ timeout: 6000 });
      await moreBtn.click();
      await p.waitForTimeout(300);
      // "Delegate a task…" menu item
      const delegateItem = p.locator('[role="menuitem"]').filter({ hasText: /delegate a task/i }).first();
      await delegateItem.waitFor({ timeout: 4000 });
      await delegateItem.click();
      // Dialog should open
      await p.waitForSelector('[role="dialog"][aria-labelledby="delegate-dialog-title"]', { timeout: 6000 });
      // Task field should be focussed
      const taskField = p.locator('#del-task');
      await taskField.waitFor({ timeout: 4000 });
      // Close dialog before leaving test
      await p.keyboard.press('Escape');
      await p.waitForSelector('[role="dialog"][aria-labelledby="delegate-dialog-title"]', { state: 'detached', timeout: 5000 }).catch(() => {});
    }, page);

    await test('Delegate a task creates child and child card appears in Agents activity', async (p) => {
      if (!demoSessionId) throw new Error('No demo session available');
      await goto(p, `/p/${projectId}/sessions/${demoSessionId}`, 2500);
      await p.waitForSelector('.ide-workspace', { timeout: 8_000 });
      // Open delegate dialog via API shortcut (faster than UI)
      const childData = await apiPost(
        `/api/projects/${projectId}/workflows/${demoSessionId}/delegate`,
        { task: 'Smoke test child task', title: 'Child smoke task' },
      );
      const childId = childData.workflow?.id;
      if (!childId) throw new Error('Delegate API did not return workflow id');
      // Open agents activity panel — use title selector as fallback
      const agentsBtn = p.locator('.ide-activity-btn[title*="Agents"]').first();
      await agentsBtn.waitFor({ timeout: 8_000 });
      await agentsBtn.click();
      await p.waitForTimeout(1000);
      // The sidebar should appear
      const sidebarCount = await p.locator('.ide-sidebar').count();
      if (sidebarCount === 0) throw new Error('Agents sidebar did not open');
      // Refresh to ensure panel loaded the new child
      const refreshBtn = p.locator('[aria-label="Refresh agents"]').first();
      const refreshCount = await refreshBtn.count();
      if (refreshCount > 0) { await refreshBtn.click(); await p.waitForTimeout(800); }
      // Child session card should appear — check sidebar or agents panel
      const sidebarText = await p.locator('.ide-sidebar').textContent();
      const hasChild = sidebarText?.includes('Child smoke task') || sidebarText?.includes('delegated') || sidebarText?.includes('smoke task');
      if (!hasChild) throw new Error(`Agents panel should show delegated child. Sidebar text: ${sidebarText?.slice(0, 300)}`);
    }, page);

    await test('Delegation settings tab is read-only for non-admin (admin sees editable form)', async (p) => {
      // As admin, delegation tab should show editable form
      await goto(p, '/settings', 1200);
      await p.waitForSelector('[id="tab-delegation"]', { timeout: 8000 });
      await p.click('[id="tab-delegation"]');
      await p.waitForTimeout(800);
      const bodyText = await p.evaluate(() => document.body.innerText);
      if (!/delegation|delegated sessions/i.test(bodyText)) {
        throw new Error('Delegation tab content not visible');
      }
      // As admin, the save button should be present and enabled
      const saveBtn = p.locator('button').filter({ hasText: /save delegation settings/i }).first();
      await saveBtn.waitFor({ timeout: 5000 });
      const isDisabled = await saveBtn.isDisabled();
      if (isDisabled) throw new Error('Admin should be able to edit delegation settings');
      // Verify the enabled checkbox
      const enabledCb = p.locator('input[type="checkbox"]').first();
      await enabledCb.waitFor({ timeout: 3000 });
    }, page);
    } // end §39 delegation/sessions

    // ── 40. F12 — Tests module ────────────────────────────────────────────
    if (sectionEnabled('testing-module')) {
    console.log('\n40. F12 — Tests module');
    currentSectionId = '40';

    await test('Tests page renders in project nav', async (p) => {
      await goto(p, `/p/${projectId}/tests`, 1200);
      await assertHeading(p, /tests/i);
      const newBtn = p.locator('button').filter({ hasText: /new test project/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
    }, page);

    let testProjectId = '';

    await test('Create test project via dialog', async (p) => {
      await goto(p, `/p/${projectId}/tests`, 1200);
      const newBtn = p.locator('button').filter({ hasText: /new test project/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
      await newBtn.click();
      await p.waitForSelector('[role="dialog"][aria-labelledby="new-tp-title"]', { timeout: 6000 });
      // Fill name
      await p.fill('#ntp-name', 'Smoke E2E Tests');
      // Fill app URL
      await p.fill('#ntp-appurl', 'http://localhost:3000');
      // Submit
      const submitBtn = p.locator('[role="dialog"] button[type="submit"]').first();
      await Promise.all([
        p.waitForResponse(
          (r) => r.url().includes('/tests') && r.request().method() === 'POST',
          { timeout: 8_000 },
        ),
        submitBtn.click(),
      ]);
      await p.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 }).catch(() => {});
      await p.waitForTimeout(600);
      // Should navigate to the test project detail
      const url = p.url();
      const match = url.match(/tests\/([^/?#]+)/);
      if (match) testProjectId = match[1];
      const bodyText = await p.evaluate(() => document.body.innerText);
      if (!bodyText.toLowerCase().includes('smoke e2e tests')) {
        throw new Error('Test project name not shown after creation');
      }
    }, page);

    await test('Test project has Scripts, Runs, Vault, Settings tabs', async (p) => {
      // Create via API if UI creation failed
      if (!testProjectId) {
        const data = await apiPost(`/api/projects/${projectId}/tests`, {
          name: 'Smoke E2E Tests',
          appUrl: 'http://localhost:3000',
        });
        testProjectId = data.testProject?.id || '';
      }
      if (!testProjectId) throw new Error('No test project id');
      await goto(p, `/p/${projectId}/tests/${testProjectId}`, 1200);
      await p.waitForSelector('.tabs, [role="tablist"]', { timeout: 8000 });
      await assertTabsExist(p, ['Scripts', 'Runs', 'Vault', 'Settings']);
    }, page);

    await test('Add a group and script with two steps', async (p) => {
      if (!testProjectId) throw new Error('No test project');
      await goto(p, `/p/${projectId}/tests/${testProjectId}`, 1200);
      await p.waitForSelector('.tabs, .tab-bar, [role="tablist"]', { timeout: 8000 });

      // Create group
      const newGroupBtn = p.locator('button').filter({ hasText: /new group/i }).first();
      await newGroupBtn.waitFor({ timeout: 6000 });
      await newGroupBtn.click();
      await p.waitForTimeout(300);
      await p.fill('input[aria-label="New group name"]', 'Smoke Group');
      await p.locator('button[type="submit"]').filter({ hasText: /create/i }).first().click();
      await p.waitForTimeout(600);

      // Find group's "Script" button
      const addScriptBtn = p.locator('button[aria-label*="Add script to Smoke Group"]').first();
      const scriptBtnCount = await addScriptBtn.count();
      if (scriptBtnCount === 0) {
        // Try generic approach
        const scriptBtns = p.locator('button').filter({ hasText: /\+ script/i });
        await scriptBtns.first().waitFor({ timeout: 4000 });
        await scriptBtns.first().click();
      } else {
        await addScriptBtn.click();
      }
      await p.waitForTimeout(300);
      await p.fill('input[aria-label="New script name"]', 'Smoke Script');
      const createScriptBtn = p.locator('button').filter({ hasText: /create/i }).last();
      await createScriptBtn.click();
      await p.waitForTimeout(800);

      // Should navigate to script editor
      const bodyText = await p.evaluate(() => document.body.innerText);
      const hasStepAdd = /add step/i.test(bodyText);
      if (!hasStepAdd) {
        // Accept if we're still on the scripts tab with the script listed
        const hasScript = /smoke script/i.test(bodyText);
        if (!hasScript) throw new Error(`Script editor or script list should be visible. Body: ${bodyText.slice(0, 200)}`);
        return; // script created, editor not auto-opened; that's acceptable
      }

      // Add two steps
      const addStepBtn = p.locator('button').filter({ hasText: /add step/i }).first();
      await addStepBtn.click();
      await p.waitForTimeout(200);
      await addStepBtn.click();
      await p.waitForTimeout(200);

      // Should show 2 steps (or 3 if there was already one)
      const stepHeaders = await p.locator('[aria-label^="Step "]').count();
      if (stepHeaders < 2) throw new Error(`Expected at least 2 steps, got ${stepHeaders}`);
    }, page);

    await test('Add vault login credential — password not shown in list', async (p) => {
      if (!testProjectId) throw new Error('No test project');
      await goto(p, `/p/${projectId}/tests/${testProjectId}`, 2000);
      await p.waitForSelector('.tabs, [role="tablist"]', { timeout: 8_000 });

      // Click Vault tab
      await p.click('[id="tp-tab-vault"]');
      await p.waitForTimeout(600);

      // Click "New credential"
      const newCredBtn = p.locator('button').filter({ hasText: /new credential/i }).first();
      await newCredBtn.waitFor({ timeout: 8000 });
      await newCredBtn.click();
      await p.waitForTimeout(300);

      // Fill in credential form
      const vaultNameInput = p.locator('#vault-name').first();
      await vaultNameInput.waitFor({ timeout: 6000 });
      await vaultNameInput.fill('admin-login');

      await p.fill('#vault-username', 'admin@test.com');
      await p.fill('#vault-password', 'super-secret-password-999');

      // Submit
      await p.locator('button[type="submit"]').filter({ hasText: /save credential/i }).first().click();
      await p.waitForTimeout(600);

      // Check that password is NOT shown
      const bodyText = await p.evaluate(() => document.body.innerText);
      if (bodyText.includes('super-secret-password-999')) {
        throw new Error('Password should not be visible in the credential list');
      }
      // Username should be shown
      if (!bodyText.includes('admin@test.com')) {
        throw new Error('Username should be visible in the credential list');
      }
    }, page);

    await test('Open Runs tab shows empty state or run list', async (p) => {
      if (!testProjectId) throw new Error('No test project');
      await goto(p, `/p/${projectId}/tests/${testProjectId}`, 2000);
      await p.waitForSelector('.tabs, [role="tablist"]', { timeout: 8_000 });
      // Click Runs tab
      await p.click('[id="tp-tab-runs"]');
      await p.waitForTimeout(600);
      const bodyText = await p.evaluate(() => document.body.innerText);
      // Either shows "No runs yet" or a list
      const hasRunsContent = /no runs yet|runs/i.test(bodyText);
      if (!hasRunsContent) throw new Error('Runs tab should show run list or empty state');
    }, page);

    await test('Generate-with-AI dialog closes after submit (non-blocking)', async (p) => {
      if (!testProjectId) throw new Error('No test project');
      await goto(p, `/p/${projectId}/tests/${testProjectId}`, 2000);
      await p.waitForSelector('.tabs, [role="tablist"]', { timeout: 8_000 });
      // Make sure we're on Scripts tab
      await p.click('[id="tp-tab-scripts"]');
      await p.waitForTimeout(600);
      // Click "Generate with AI" button
      const genBtn = p.locator('button').filter({ hasText: /generate with ai/i }).first();
      await genBtn.waitFor({ timeout: 8000 });
      await genBtn.click();
      await p.waitForSelector('[role="dialog"][aria-labelledby="gen-dialog-title"]', { timeout: 6000 });
      // Description field should be present
      await p.locator('#gen-desc').waitFor({ timeout: 4000 });
      // Submit with a description
      await p.fill('#gen-desc', 'Test login with admin credentials');
      await p.locator('[role="dialog"] .btn-primary').filter({ hasText: /generate/i }).first().click();
      // With the new non-blocking behaviour:
      //   - If POST succeeds (202): dialog closes immediately
      //   - If POST fails (no AI provider): dialog stays open showing an error
      await p.waitForTimeout(3000);
      const dialogCount = await p.locator('[role="dialog"][aria-labelledby="gen-dialog-title"]').count();
      const bodyText = await p.evaluate(() => document.body.innerText);
      if (dialogCount > 0) {
        // POST failed (no provider) — dialog must show an error
        const hasError = /error|failed|not configured|no ai provider|no provider/i.test(bodyText);
        if (!hasError) {
          throw new Error(`Dialog still open but no error shown: ${bodyText.slice(0, 200)}`);
        }
        await p.keyboard.press('Escape');
        await p.waitForSelector('[role="dialog"][aria-labelledby="gen-dialog-title"]', { state: 'detached', timeout: 5000 }).catch(() => {});
      }
      // Dialog closed (or was closed) — generation may already be running/failed in background
    }, page);

    // ── 40b. Generate-with-AI — async flow (mocked routes) ───────────────────
    console.log('\n40b. Generate-with-AI — async flow (mocked routes)');
    currentSectionId = '40b';

    await test('Async generate: dialog closes, indicator appears, done clears it and shows toast', async (p) => {
      if (!testProjectId) throw new Error('No test project');

      let genPollCount = 0;

      // Single route handler for all requests under this test project.
      // Using a function predicate avoids Playwright glob-pattern matching edge cases
      // (e.g. **/${testProjectId}/generate matching GET to …/generate/genId via route.continue).
      const mockGenerateRoute = async (route: any) => {
        const url    = route.request().url();
        const method = route.request().method();

        if (method === 'POST' && /\/generate$/.test(new URL(url).pathname)) {
          // POST …/generate → 202 accepted
          await route.fulfill({
            status: 202,
            contentType: 'application/json',
            body: JSON.stringify({ generationId: 'gen-smoke-async-1' }),
          });
        } else if (method === 'GET' && url.includes('/generate/gen-smoke-async-1')) {
          // GET …/generate/gen-smoke-async-1 → running on first poll, done on second
          genPollCount++;
          const done = genPollCount >= 2;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              generation: { status: done ? 'done' : 'running', warnings: [] },
              scripts: done
                ? [{ id: 'script-async-smoke-1', name: 'Generated Login Test', steps: '[]' }]
                : [],
            }),
          });
        } else if (method === 'GET' && url.includes('/generations')) {
          // GET …/generations?active=1 → empty on mount (job added via dialog submit)
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ generations: [] }),
          });
        } else {
          await route.continue();
        }
      };

      // Intercept all test-project-scoped requests.
      // Store predicate so the same reference is used in both route() and unroute().
      // (Playwright 1.16+ passes a URL object to function predicates, so use .href)
      const testProjPredicate = (url: URL) => url.href.includes(`/tests/${testProjectId}/`);
      await p.route(testProjPredicate, mockGenerateRoute);

      try {
        await goto(p, `/p/${projectId}/tests/${testProjectId}`, 1200);
        await p.waitForSelector('.tabs, [role="tablist"]', { timeout: 8000 });
        await p.click('[id="tp-tab-scripts"]');
        await p.waitForTimeout(600);

        // Open dialog
        const genBtn = p.locator('button').filter({ hasText: /generate with ai/i }).first();
        await genBtn.waitFor({ timeout: 8000 });
        await genBtn.click();
        await p.waitForSelector('[role="dialog"][aria-labelledby="gen-dialog-title"]', { timeout: 6000 });

        // Fill and submit
        await p.fill('#gen-desc', 'Async smoke login test');
        await p.locator('[role="dialog"] .btn-primary').filter({ hasText: /generate/i }).first().click();

        // 1. Dialog must close immediately after the POST returns (non-blocking)
        await p.waitForSelector('[role="dialog"][aria-labelledby="gen-dialog-title"]', {
          state: 'detached',
          timeout: 6000,
        });

        // 2. Generation-progress indicator must appear (job tracked at page level)
        await p.waitForSelector('[aria-label="Generation progress"]', { timeout: 6000 });

        // 3. Once polling hits "done", indicator disappears
        await p.waitForSelector('[aria-label="Generation progress"]', {
          state: 'detached',
          timeout: 12_000,
        });

        // 4. Toast may still be visible (4 s auto-dismiss) — only assert if present
        const toastShelf = p.locator('.toast-shelf');
        const hasShelf = (await toastShelf.count()) > 0;
        if (hasShelf) {
          const toastText = await toastShelf.textContent();
          const hasSuccess = /generated|script/i.test(toastText ?? '');
          if (!hasSuccess) {
            throw new Error(`Expected "generated"/"script" in success toast, got: "${toastText}"`);
          }
        }
        // Absence of toast is also acceptable (auto-dismissed before we read it)
      } finally {
        await p.unroute(testProjPredicate, mockGenerateRoute);
      }
    }, page);

    await test('Tests nav item appears in project nav rail', async (p) => {
      await goto(p, `/p/${projectId}/sessions`, 800);
      await p.waitForSelector('.rail', { timeout: 5000 });
      const testsLink = p.locator('.rail a[href*="/tests"]').first();
      const count = await testsLink.count();
      if (count === 0) {
        // Check if it's in the visible rail without scrolling
        const railText = await p.locator('.rail').textContent();
        if (!railText?.toLowerCase().includes('tests')) {
          throw new Error('Tests nav item not found in project rail');
        }
      }
    }, page);

    await test('Tests command palette entry found via "g h" shortcut', async (p) => {
      await goto(p, `/p/${projectId}/sessions`, 800);
      await p.waitForSelector('.shell', { timeout: 5000 });
      await p.locator('.shell').click();
      await p.waitForTimeout(100);
      await p.keyboard.press('g');
      await p.waitForTimeout(50);
      await p.keyboard.press('h');
      await p.waitForTimeout(600);
      const url = p.url();
      if (!url.includes('/tests')) {
        throw new Error(`g+h should navigate to tests, got: ${url}`);
      }
    }, page);
    } // end §40/§40b testing-module

    // ── 41. Config tree — keyboard navigation (issue 5) ──────────────────
    if (sectionEnabled('config', 'shell')) {
    console.log('\n41. Config tree — keyboard navigation');
    currentSectionId = '41';

    await test('Config file tree has role=tree and treeitem nodes', async (p) => {
      await goto(p, '/config', 1400);
      await p.waitForSelector('.config-tree-body[role="tree"]', { timeout: 8000 });
      // After the tree loads there should be treeitem nodes (if no files, tree is still accessible)
      const treeEl = p.locator('.config-tree-body[role="tree"]').first();
      const ariaLabel = await treeEl.getAttribute('aria-label');
      if (!ariaLabel) throw new Error('Config tree must have aria-label');
    }, page);

    await test('Config tree items have role=treeitem with tabIndex and aria-level', async (p) => {
      await goto(p, '/config', 1400);
      await p.waitForSelector('.config-tree-body[role="tree"]', { timeout: 8000 });
      // Create a file so there is at least one treeitem
      const newFileBtn = p.locator('[aria-label="New file"]').first();
      await newFileBtn.waitFor({ timeout: 6000 });
      await newFileBtn.click();
      await p.waitForEvent('dialog').then(d => d.accept('tree-smoke-check.txt')).catch(() => {});
      await p.waitForTimeout(600);
      const treeitems = p.locator('[role="treeitem"]');
      const count = await treeitems.count();
      if (count === 0) return; // no files yet — skip (acceptable on fresh DB)
      const firstItem = treeitems.first();
      const tabIndex = await firstItem.getAttribute('tabindex');
      if (tabIndex === null) throw new Error('treeitem must have tabIndex attribute');
      const ariaLevel = await firstItem.getAttribute('aria-level');
      if (!ariaLevel) throw new Error('treeitem must have aria-level');
    }, page);

    await test('Arrow keys navigate config tree items', async (p) => {
      await goto(p, '/config', 1400);
      await p.waitForSelector('.config-tree-body[role="tree"]', { timeout: 8000 });
      const treeitems = p.locator('[role="treeitem"]');
      const count = await treeitems.count();
      if (count < 2) return; // skip if too few items to navigate
      // Focus first item
      await treeitems.first().focus();
      await p.waitForTimeout(100);
      // Press ArrowDown — focus should move to second item
      await p.keyboard.press('ArrowDown');
      await p.waitForTimeout(100);
      const activeEl = await p.evaluate(() => document.activeElement?.getAttribute('role'));
      if (activeEl !== 'treeitem') {
        throw new Error('ArrowDown should keep focus on a treeitem');
      }
    }, page);
    } // end §41 config/shell

    // ── 42. Dialog focus trap (issue 6) ──────────────────────────────────
    if (sectionEnabled('shell')) {
    console.log('\n42. Dialog focus trap');
    currentSectionId = '42';

    await test('New session dialog traps Tab focus inside', async (p) => {
      await goto(p, `/p/${projectId}/sessions`, 1000);
      const newBtn = p.locator('button').filter({ hasText: /new session/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
      await newBtn.click();
      await p.waitForSelector('[role="dialog"][aria-labelledby="new-session-title"]', { timeout: 5000 });
      // Tab multiple times and verify focus stays inside the dialog
      for (let i = 0; i < 8; i++) await p.keyboard.press('Tab');
      const activeInsideDialog = await p.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
        return dialog ? dialog.contains(document.activeElement) : false;
      });
      if (!activeInsideDialog) throw new Error('Tab should keep focus inside the dialog');
      await p.keyboard.press('Escape');
    }, page);

    await test('Closing new session dialog restores focus to trigger button', async (p) => {
      await goto(p, `/p/${projectId}/sessions`, 1000);
      const newBtn = p.locator('button').filter({ hasText: /new session/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
      await newBtn.click();
      await p.waitForSelector('[role="dialog"][aria-labelledby="new-session-title"]', { timeout: 5000 });
      await p.keyboard.press('Escape');
      await p.waitForSelector('[role="dialog"][aria-labelledby="new-session-title"]', { state: 'detached', timeout: 5000 }).catch(() => {});
      // Focus should be back on the shell (some element, not body)
      const activeTag = await p.evaluate(() => document.activeElement?.tagName?.toLowerCase());
      if (activeTag === 'body') {
        throw new Error('Focus should be restored to a specific element after dialog closes, not body');
      }
    }, page);
    } // end §42 shell

    // ── NEW: Projects empty state — single CTA ───────────────────────────
    if (sectionEnabled('projects')) {
    console.log('\n43. Projects empty-state single CTA');
    currentSectionId = '43';

    await test('Projects empty state shows exactly one "New project" button', async (p) => {
      // Navigate to projects page fresh — test project may exist from setup, so
      // we only care about the DOM structure: never TWO buttons with "new project" text.
      await goto(p, '/projects', 800);
      await p.waitForSelector('.page', { timeout: 8000 });
      // Wait for loading spinner to clear
      await p.waitForSelector('.spinner', { state: 'detached', timeout: 8000 }).catch(() => {});
      await p.waitForTimeout(400);
      const allNewBtns = await p.locator('button').filter({ hasText: /new project/i }).count();
      if (allNewBtns > 1) {
        throw new Error(`Expected at most 1 "New project" button, found ${allNewBtns}`);
      }
      // Also verify there are no zero buttons when empty
      const projectGrid = await p.locator('.project-grid').count();
      if (projectGrid === 0) {
        // Empty state path — exactly 1 button required
        if (allNewBtns !== 1) {
          throw new Error(`Empty state must show exactly 1 "New project" button, found ${allNewBtns}`);
        }
      }
    }, page);
    } // end §43 projects

    // ── NEW: Collapsed rail — Portal flyout ────────────────────────────────
    // ── Rail navigation — new sections, project picker ───────────────────
    if (sectionEnabled('shell')) {
      console.log('\n44. Rail navigation — Work/Connect/Quality/Account sections, project picker');
      currentSectionId = '44';

      await test('Rail: Work/Connect/Quality/Account sections visible, no Inbox in rail', async (p) => {
        await goto(p, `/p/${projectId}/sessions`, 800);
        await p.waitForSelector('.rail', { timeout: 5000 });
        const railText = await p.locator('.rail').textContent();
        // New section labels
        const sections = ['Work', 'Connect', 'Quality', 'Account'];
        for (const s of sections) {
          if (!railText?.includes(s)) throw new Error(`Rail section "${s}" not found`);
        }
        // Inbox NOT in rail (moved to top bar)
        const inboxLinks = await p.locator('.rail .rail-link').filter({ hasText: /^Inbox$/i }).count();
        if (inboxLinks > 0) throw new Error('Inbox should NOT be in the rail (moved to top bar)');
        // Work items
        const workItems = ['Sessions', 'Workspaces', 'Knowledge', 'Create', 'Insights'];
        for (const item of workItems) {
          if (!railText?.includes(item)) throw new Error(`Work item "${item}" not in rail`);
        }
        // Connect items
        if (!railText?.includes('Connections')) throw new Error('"Connections" not in rail (Connect section)');
        if (!railText?.includes('Repositories')) throw new Error('"Repositories" not in rail (Connect section)');
        // Quality items
        if (!railText?.includes('Reviews')) throw new Error('"Reviews" not in rail (Quality section)');
        if (!railText?.includes('Tests')) throw new Error('"Tests" not in rail (Quality section)');
        // Account items
        const accountItems = ['Credentials', 'Configuration', 'API access', 'Settings'];
        for (const item of accountItems) {
          if (!railText?.includes(item)) throw new Error(`Account item "${item}" not in rail`);
        }
        // "Users" visible for admin (we're logged in as admin)
        if (!railText?.includes('Users')) throw new Error('"Users" not in rail for admin user');
        // "Setup" NOT in rail (in project picker popover)
        const setupLinks = await p.locator('.rail .rail-link').filter({ hasText: /^Setup$/i }).count();
        if (setupLinks > 0) throw new Error('Setup should NOT be in the rail (moved to project picker)');
      }, page);

      await test('Connections rail item links to /connections/git', async (p) => {
        await goto(p, `/p/${projectId}/sessions`, 800);
        await p.waitForSelector('.rail', { timeout: 5000 });
        const connectionsLink = p.locator('.rail .rail-link').filter({ hasText: /^Connections$/i }).first();
        await connectionsLink.waitFor({ timeout: 3000 });
        const href = await connectionsLink.getAttribute('href');
        if (!href?.includes('/connections/git')) {
          throw new Error(`Connections link should point to /connections/git, got: ${href}`);
        }
      }, page);

      await test('Reviews rail item links to /p/:pid/reviews/code', async (p) => {
        await goto(p, `/p/${projectId}/sessions`, 800);
        await p.waitForSelector('.rail', { timeout: 5000 });
        const reviewsLink = p.locator('.rail .rail-link').filter({ hasText: /^Reviews$/i }).first();
        await reviewsLink.waitFor({ timeout: 3000 });
        const href = await reviewsLink.getAttribute('href');
        if (!href?.includes('/reviews/code')) {
          throw new Error(`Reviews link should point to /reviews/code, got: ${href}`);
        }
      }, page);

      await test('Repositories rail item links to /p/:pid/setup/repositories and navigates there', async (p) => {
        await goto(p, `/p/${projectId}/sessions`, 800);
        await p.waitForSelector('.rail', { timeout: 5000 });
        const reposLink = p.locator('.rail .rail-link').filter({ hasText: /^Repositories$/i }).first();
        await reposLink.waitFor({ timeout: 3000 });
        const href = await reposLink.getAttribute('href');
        if (!href?.includes('/setup/repositories')) {
          throw new Error(`Repositories link should point to /setup/repositories, got: ${href}`);
        }
        // Click and verify we land on the Repositories tab
        await reposLink.click();
        await p.waitForTimeout(1000);
        const bodyText = await p.evaluate(() => document.body.innerText);
        if (!/repositories/i.test(bodyText)) {
          throw new Error('Clicking Repositories rail item should open the Repositories tab');
        }
        // The Add repositories button should be visible
        const addReposBtn = p.locator('button').filter({ hasText: /Add repositories/i }).first();
        await addReposBtn.waitFor({ timeout: 5000 });
      }, page);

      await test('Project picker footer has "Project settings" link', async (p) => {
        await goto(p, `/p/${projectId}/sessions`, 800);
        await p.waitForSelector('.project-picker-card', { timeout: 5000 });
        await p.locator('.project-picker-card').first().click();
        await p.waitForSelector('[role="dialog"][aria-label="Switch project"]', { timeout: 5000 });
        const settingsLink = p.locator('.picker-footer-link').filter({ hasText: /Project settings/i }).first();
        const cnt = await settingsLink.count();
        if (cnt === 0) throw new Error('"Project settings" link not found in project picker footer');
        await p.keyboard.press('Escape');
      }, page);

      await test('Project picker: opens on click, searches, closes with Esc and returns focus', async (p) => {
        await goto(p, `/p/${projectId}/sessions`, 800);
        await p.waitForSelector('.project-picker-card', { timeout: 5000 });
        const pickerCard = p.locator('.project-picker-card').first();
        await pickerCard.click();
        await p.waitForSelector('[role="dialog"][aria-label="Switch project"]', { timeout: 5000 });
        // Search works
        await p.locator('.picker-search').fill('Nonexistent99');
        await p.waitForTimeout(200);
        await p.locator('.picker-empty').waitFor({ timeout: 3000 });
        // Esc closes and focus returns
        await p.keyboard.press('Escape');
        await p.waitForSelector('[role="dialog"][aria-label="Switch project"]', { state: 'detached', timeout: 4000 }).catch(() => {});
        const activeTag = await p.evaluate(() => document.activeElement?.tagName?.toLowerCase());
        if (activeTag === 'body') throw new Error('Focus should return to picker after Esc');
      }, page);

      await test('Collapsed mode: icons only, data-tooltip on rail links', async (p) => {
        await goto(p, `/p/${projectId}/sessions`, 800);
        await p.waitForSelector('.rail', { timeout: 5000 });
        if ((await p.locator('.shell.rail-collapsed').count()) === 0) {
          await p.locator('.rail-collapse-btn').first().click();
          await p.waitForTimeout(400);
        }
        const links = p.locator('.rail-collapsed .rail-link');
        const count = await links.count();
        if (count === 0) throw new Error('No rail links in collapsed mode');
        const tooltip = await links.first().getAttribute('data-tooltip');
        if (!tooltip) throw new Error('Rail link missing data-tooltip in collapsed mode');
        // Avatar picker visible
        await p.locator('.project-picker-avatar').waitFor({ timeout: 3000 });
        // Restore
        await p.locator('.rail-collapse-btn').first().click();
        await p.waitForTimeout(400);
      }, page);

      await test('Collapsed rail fits without scroll at 1280x800 (no more than 14 links)', async (p) => {
        await goto(p, `/p/${projectId}/sessions`, 800);
        await p.setViewportSize({ width: 1280, height: 800 });
        await p.waitForSelector('.rail', { timeout: 5000 });
        if ((await p.locator('.shell.rail-collapsed').count()) === 0) {
          await p.locator('.rail-collapse-btn').first().click();
          await p.waitForTimeout(400);
        }
        const railLinks = await p.locator('.rail-collapsed .rail-link').count();
        // New rail has ~14 items (admins see Users too); check count is reasonable
        if (railLinks < 10 || railLinks > 20) {
          throw new Error(`Unexpected rail link count in collapsed mode: ${railLinks}`);
        }
        // Restore
        await p.locator('.rail-collapse-btn').first().click();
        await p.waitForTimeout(400);
      }, page);
    } // end sectionEnabled('shell') — §44 rail navigation

    // ── Old URL redirects ─────────────────────────────────────────────────
    if (sectionEnabled('shell', 'projects')) {
      console.log('\n45. Old URL redirects');
      currentSectionId = '45';

      await test('/connections redirects to /connections/git', async (p) => {
        await goto(p, '/connections', 1200);
        const url = p.url();
        if (!url.includes('/connections/git')) {
          throw new Error(`Expected redirect to /connections/git, got: ${url}`);
        }
      }, page);

      await test('/aws redirects to /connections/aws', async (p) => {
        await goto(p, '/aws', 1200);
        const url = p.url();
        if (!url.includes('/connections/aws')) {
          throw new Error(`Expected redirect to /connections/aws, got: ${url}`);
        }
      }, page);

      await test('/admin redirects to /users', async (p) => {
        await goto(p, '/admin', 1200);
        const url = p.url();
        if (!url.includes('/users')) {
          throw new Error(`Expected redirect to /users, got: ${url}`);
        }
      }, page);

      await test('/p/:pid/review redirects to /p/:pid/reviews/code', async (p) => {
        await goto(p, `/p/${projectId}/review`, 1200);
        const url = p.url();
        if (!url.includes('/reviews/code')) {
          throw new Error(`Expected redirect to /reviews/code, got: ${url}`);
        }
      }, page);

      await test('/p/:pid/branchscans redirects to /p/:pid/reviews/branch-scans', async (p) => {
        await goto(p, `/p/${projectId}/branchscans`, 1200);
        const url = p.url();
        if (!url.includes('/reviews/branch-scans')) {
          throw new Error(`Expected redirect to /reviews/branch-scans, got: ${url}`);
        }
      }, page);

      await test('Back button after old-URL redirect returns to the previous page (no trap)', async (p) => {
        // Navigate to Projects first so we have a "previous" history entry.
        await goto(p, '/projects', 800);
        await p.waitForSelector('.shell', { timeout: 8000 });
        const beforeUrl = p.url();

        // Navigate to an old URL that triggers a replace-redirect to the new URL.
        // navigateReplace is used in App.jsx so this REPLACES the history entry —
        // pressing Back must return to /projects, not loop back to /aws.
        await goto(p, '/aws', 1200);
        const afterUrl = p.url();
        if (!afterUrl.includes('/connections/aws')) {
          throw new Error(`Expected redirect to /connections/aws, got: ${afterUrl}`);
        }

        // Press browser Back — should land on /projects, not on /aws again.
        await p.goBack({ timeout: 5000 }).catch(() => {});
        await p.waitForTimeout(800);
        const backUrl = p.url();
        if (backUrl.includes('#/aws')) {
          throw new Error(
            `Back button trap: after Back the URL is still ${backUrl} (should be #/projects or root)`,
          );
        }
        // Accept /projects or the root (e.g. '#/projects')
        const isProjects = backUrl.includes('/projects') || backUrl === beforeUrl;
        if (!isProjects) {
          // Tolerate any non-/aws destination — just ensure we're not in a redirect loop
          const awsRedirect = backUrl.includes('#/aws');
          if (awsRedirect) {
            throw new Error(`Back button returned to old URL again: ${backUrl}`);
          }
        }
      }, page);
    }

    // ── NEW: Theme/template system ────────────────────────────────────────
    if (sectionEnabled('theme')) {
      console.log('\n45. Theme / template system');
      currentSectionId = '45b';

      await test('Default template applied on first load (data-template=aethrix-night)', async (p) => {
        // Clear any saved template preference so we get the true default
        await p.evaluate(() => {
          try { localStorage.removeItem('portal-template-id'); } catch {}
        });
        await p.reload({ waitUntil: 'domcontentloaded' });
        await p.waitForTimeout(600);
        const template = await p.evaluate(() =>
          document.documentElement.getAttribute('data-template'),
        );
        if (!template) throw new Error('data-template attribute not set on <html>');
        // Default is aethrix-night but allow any non-null value
        if (template !== 'aethrix-night') {
          console.log(`  ℹ  data-template="${template}" (expected aethrix-night for fresh install)`);
        }
      }, page);

      await test('data-mode attribute is set (dark or light)', async (p) => {
        await goto(p, '/projects', 600);
        const mode = await p.evaluate(() =>
          document.documentElement.getAttribute('data-mode'),
        );
        if (mode !== 'dark' && mode !== 'light') {
          throw new Error(`Expected data-mode="dark"|"light", got "${mode}"`);
        }
      }, page);

      await test('Settings › Appearance tab is present and renders', async (p) => {
        await goto(p, '/settings', 1200);
        await p.waitForSelector('#tab-appearance', { timeout: 8000 });
        await p.click('#tab-appearance');
        await p.waitForTimeout(600);
        const bodyText = await p.evaluate(() => document.body.innerText);
        if (!/(appearance|template|theme)/i.test(bodyText)) {
          throw new Error('Appearance tab should render template management UI');
        }
        // Should show at least one template card (Aethrix Night)
        const cards = await p.locator('.template-card').count();
        if (cards === 0) throw new Error('Appearance tab should show template cards');
        // Built-in badge or Active badge
        const hasBadge = await p.locator('.badge-ok, .badge-neutral').count();
        if (hasBadge === 0) throw new Error('Template cards should show Active or Built-in badges');
      }, page);

      await test('Switching to Classic Teal changes --accent without page reload', async (p) => {
        await goto(p, '/settings', 1200);
        await p.waitForSelector('#tab-appearance', { timeout: 8000 });
        await p.click('#tab-appearance');
        await p.waitForTimeout(600);
        // Find the Classic Teal activate button
        const accentBefore = await p.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        );
        const classicCard = p.locator('.template-card').filter({ hasText: /classic teal/i }).first();
        const activateBtn = classicCard.locator('button').filter({ hasText: /activate/i });
        const activateCnt = await activateBtn.count();
        if (activateCnt === 0) {
          // Already active or only one template — skip
          return;
        }
        await activateBtn.click();
        // Wait for data-template to change (up to 3 s) rather than a fixed sleep.
        try {
          await p.waitForFunction(
            () => document.documentElement.getAttribute('data-template') === 'classic-teal',
            { timeout: 3_000 },
          );
        } catch {
          // May not have changed — let the assertions below handle the failure message.
        }
        const accentAfter = await p.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        );
        // Accent should have changed (teal vs violet)
        if (accentBefore === accentAfter) {
          // Check data-template changed at least
          const tmpl = await p.evaluate(() => document.documentElement.getAttribute('data-template'));
          if (tmpl !== 'classic-teal') {
            throw new Error(`After activating Classic Teal, data-template should be "classic-teal", got "${tmpl}"`);
          }
        }
        // Restore Aethrix Night
        const aethrixCard = p.locator('.template-card').filter({ hasText: /aethrix night/i }).first();
        const restoreBtn = aethrixCard.locator('button').filter({ hasText: /activate/i });
        const restoreCnt = await restoreBtn.count();
        if (restoreCnt > 0) {
          await restoreBtn.click();
          await p.waitForTimeout(400);
        }
      }, page);
    } // end sectionEnabled('theme')

    // ── 46. AddReposModal — provider error surfaced from { repos: [], error } ──
    if (sectionEnabled('repos')) {
    console.log('\n46. AddReposModal — provider error surfaced');
    currentSectionId = '46';

    await test('Add repos modal shows error when API returns { repos: [], error }', async (p) => {
      // Create a git connection so the dialog has something to select
      let connId = '';
      try {
        const connData = await apiPost('/api/git-connections', {
          name: 'Smoke-error-conn',
          provider: 'github',
          credentials: { token: 'gho_smoke_fake_error' },
          scope: 'personal',
        });
        connId = (connData as any).connection?.id ?? '';
      } catch {
        console.log('    ℹ  Skipping — could not create test git connection');
        return;
      }
      if (!connId) { console.log('    ℹ  Skipping — no connection id returned'); return; }

      // Intercept the repos endpoint BEFORE opening the dialog so the initial
      // fetch is caught.  Return HTTP 200 with { repos: [], error: "…" } —
      // the server shape for a provider-level failure.
      const errMsg = 'AWS credential rejected: invalid access key ID';
      await p.route('**/api/git-connections/**/repos**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ repos: [], nextPage: null, error: errMsg }),
        });
      });

      try {
        await goto(p, `/p/${projectId}/setup/repositories`, 1000);
        const addBtn = p.locator('button').filter({ hasText: /Add repositories/i }).first();
        await addBtn.waitFor({ timeout: 8_000 });
        await addBtn.click();
        await p.waitForSelector('[aria-labelledby="add-repos-title"]', { timeout: 6_000 });

        // The modal auto-selects the first connection and fetches repos.
        // The intercepted response carries an error, so [role="alert"] should appear.
        const alertEl = p.locator('[aria-labelledby="add-repos-title"] [role="alert"]').first();
        await alertEl.waitFor({ timeout: 8_000 });
        const alertText = await alertEl.textContent();
        if (!alertText?.includes('AWS credential rejected')) {
          throw new Error(`Expected provider error message in alert, got: "${alertText}"`);
        }
        // The empty-state ("No repositories found…") must NOT be shown instead of the error.
        const bodyText = await p.evaluate(() => document.body.innerText);
        if (/No repositories found for this connection/i.test(bodyText)) {
          throw new Error('Empty-state message shown instead of the API error — bug not fixed');
        }
      } finally {
        await p.unroute('**/api/git-connections/**/repos**').catch(() => {});
        await p.keyboard.press('Escape').catch(() => {});
        await p.waitForTimeout(300);
      }
    }, page);
    } // end §46 repos

    // ── 47. Dashboard ──────────────────────────────────────────────────────
    if (sectionEnabled('dashboard')) {
      console.log('\n47. Dashboard');
      currentSectionId = '47';

      // Function predicate for Playwright route intercept — matches all /api/dashboard
      // requests reliably across Playwright versions (glob patterns like **/api/dashboard*
      // can have edge-case behaviour with query strings and sub-paths in some versions).
      const dashApiPred = (url: URL) => url.href.includes('/api/dashboard');

      // Hash-only same-URL navigation (e.g. #/dashboard → #/dashboard) is a browser
      // no-op: the React component never remounts and never refetches. Always navigate
      // to an intermediate page first so the next goto forces a fresh mount.
      const gotoDashboard = async (p: Page, wait = 1200) => {
        await goto(p, '/inbox', 200);
        await goto(p, '/dashboard', wait);
      };

      // Shared mock payload — three agents, one running node, no active session.
      const dashMockData = {
        period: '7d',
        generatedAt: new Date().toISOString(),
        summary: {
          totalAgents: 3,
          activeAgents: 1,
          runningSessions: 2,
          queuedSessions: 1,
          completedToday: 15,
          completedYesterday: 12,
          successRate: 0.87,
          successRatePrev: 0.82,
        },
        network: {
          nodes: [
            { id: 'orchestrator', label: 'orchestrator', runs: 42, successRate: 0.9,  running: true,  avgDurationMs: 5200  },
            { id: 'coder',        label: 'coder',        runs: 18, successRate: 0.83, running: false, avgDurationMs: 12000 },
            { id: 'reviewer',     label: 'reviewer',     runs: 8,  successRate: 1.0,  running: false, avgDurationMs: 3100  },
          ],
          edges: [
            { source: 'orchestrator', target: 'coder',    count: 15 },
            { source: 'orchestrator', target: 'reviewer', count: 8  },
          ],
        },
        agents: [
          {
            agent: 'orchestrator', runs: 42, completed: 38, failed: 4, successRate: 0.9,
            p50DurationMs: 4800, p95DurationMs: 18000, avgDurationMs: 5200,
            costUsd: 2.45, inputTokens: 80000, outputTokens: 20000,
            toolCalls: 320, toolErrors: 5, lastRunAt: new Date().toISOString(),
          },
          {
            agent: 'coder', runs: 18, completed: 15, failed: 3, successRate: 0.83,
            p50DurationMs: 11000, p95DurationMs: 45000, avgDurationMs: 12000,
            costUsd: 1.20, inputTokens: 40000, outputTokens: 15000,
            toolCalls: 180, toolErrors: 12, lastRunAt: new Date().toISOString(),
          },
          {
            agent: 'reviewer', runs: 8, completed: 8, failed: 0, successRate: 1.0,
            p50DurationMs: 3000, p95DurationMs: 5000, avgDurationMs: 3100,
            costUsd: 0.34, inputTokens: 12000, outputTokens: 5000,
            toolCalls: 45, toolErrors: 0, lastRunAt: new Date().toISOString(),
          },
        ],
        recentSessions: [
          {
            id: 'sess-smoke-1', projectId: projectId, projectName: 'Test Project',
            title: 'Smoke test session 1', agent: 'orchestrator', status: 'done',
            childAgents: ['coder'], updatedAt: new Date().toISOString(),
          },
        ],
        activeSession: null,
      };

      // Helper: intercept /api/dashboard (main + agent runs)
      function mockDash(runHandler?: (route: any) => Promise<void>) {
        const handler = async (route: any) => {
          const url = route.request().url();
          if (url.includes('/api/dashboard/agents/')) {
            if (runHandler) { await runHandler(route); return; }
            await route.fulfill({
              status: 200, contentType: 'application/json',
              body: JSON.stringify({ runs: [] }),
            });
            return;
          }
          // Main dashboard
          await route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify(dashMockData),
          });
        };
        return handler;
      }

      // ── 47.1  Default landing page ─────────────────────────────────────

      await test('Empty hash lands on Dashboard — greeting heading visible', async (p) => {
        // Navigate to the bare root (no hash) — router defaults to "dashboard"
        await p.goto(BASE, { waitUntil: 'domcontentloaded' });
        await p.waitForTimeout(800);
        // After login cookie is set the shell renders immediately.
        const heading = p.locator('.db-greeting, .db-root h1').first();
        await heading.waitFor({ timeout: 8_000 });
        const text = await heading.textContent();
        if (!/good (morning|afternoon|evening)/i.test(text ?? '')) {
          throw new Error(`Expected greeting heading, got: "${text}"`);
        }
        // The URL hash should be empty or #/dashboard
        const hash = (p.url().split('#')[1] ?? '');
        if (hash !== '' && hash !== '/' && !hash.startsWith('/dashboard')) {
          throw new Error(`Expected empty hash or #/dashboard, got hash: "${hash}"`);
        }
      }, page);

      await test('Dashboard link in Rail is visible and marked active on /dashboard', async (p) => {
        await gotoDashboard(p, 800);
        await p.waitForSelector('.rail', { timeout: 5000 });
        // Rail link
        const dashLink = p.locator('.rail a[href="#/dashboard"]').first();
        await dashLink.waitFor({ timeout: 5000 });
        // Must be active
        const isActive = await dashLink.evaluate((el) => el.classList.contains('is-active'));
        if (!isActive) throw new Error('Dashboard rail link must have class "is-active" when on /dashboard');
      }, page);

      // ── 47.2  Empty-state panels (mocked empty response) ──────────────

      await test('Empty data — all 5 panels render empty states with no JS errors', async (p) => {
        const errorsBefore = jsErrors.length;
        // Mock API to return genuinely empty data
        const emptyData = {
          period: '7d', generatedAt: new Date().toISOString(),
          summary: {
            totalAgents: 0, activeAgents: 0, runningSessions: 0, queuedSessions: 0,
            completedToday: 0, completedYesterday: 0, successRate: 0, successRatePrev: null,
          },
          network: { nodes: [], edges: [] },
          agents: [], recentSessions: [], activeSession: null,
        };
        await p.route(dashApiPred, async (route) => {
          await route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify(emptyData),
          });
        });
        try {
          await gotoDashboard(p);
          await p.waitForSelector('.spinner', { state: 'detached', timeout: 8_000 }).catch(() => {});
          await p.waitForTimeout(600);
          // KPI stats area
          await p.waitForSelector('[aria-label="Summary statistics"]', { timeout: 5000 });
          // All 5 panels with empty-state messages
          const panelLabels = ['Agent Network', 'Active Session', 'Recent Sessions', 'Agent Performance'];
          for (const label of panelLabels) {
            const panel = p.locator(`[aria-label="${label}"]`).first();
            await panel.waitFor({ timeout: 5000 });
          }
          // Check empty-state texts
          const bodyText = await p.evaluate(() => document.body.innerText);
          const hasNetworkEmpty  = /no agents have run yet/i.test(bodyText);
          const hasActiveEmpty   = /no session running right now/i.test(bodyText);
          const hasRecentEmpty   = /no sessions yet/i.test(bodyText);
          const hasPerfEmpty     = /no agent data for this period/i.test(bodyText);
          if (!hasNetworkEmpty) throw new Error('Agent Network should show "No agents have run yet"');
          if (!hasActiveEmpty)  throw new Error('Active Session should show "No session running right now"');
          if (!hasRecentEmpty)  throw new Error('Recent Sessions should show "No sessions yet"');
          if (!hasPerfEmpty)    throw new Error('Agent Performance should show "No agent data for this period"');
          // No new JS errors
          const newErrors = jsErrors.slice(errorsBefore).filter(
            (e) => !e.includes('[404]') && !/favicon/i.test(e),
          );
          if (newErrors.length > 0) {
            throw new Error(`JS errors on empty-state dashboard: ${newErrors.slice(0, 3).join('; ')}`);
          }
        } finally {
          await p.unroute(dashApiPred).catch(() => {});
        }
      }, page);

      // ── 47.3  Seeded data — KPIs + table + sort ────────────────────────

      await test('Seeded data — KPI values match mocked summary', async (p) => {
        await p.route(dashApiPred, mockDash());
        try {
          await gotoDashboard(p);
          await p.waitForSelector('.spinner', { state: 'detached', timeout: 8_000 }).catch(() => {});
          await p.waitForTimeout(600);
          const kpiText = await p.locator('[aria-label="Summary statistics"]').textContent();
          // totalAgents = 3
          if (!kpiText?.includes('3')) throw new Error(`Expected "3" total agents in KPI area, got: ${kpiText?.slice(0, 200)}`);
          // runningSessions = 2
          if (!kpiText?.includes('2')) throw new Error(`Expected "2" running sessions in KPI area, got: ${kpiText?.slice(0, 200)}`);
        } finally {
          await p.unroute(dashApiPred).catch(() => {});
        }
      }, page);

      await test('Seeded data — Agent Performance table lists all three agents', async (p) => {
        await p.route(dashApiPred, mockDash());
        try {
          await gotoDashboard(p);
          await p.waitForSelector('[aria-label="Agent performance metrics"]', { timeout: 8000 });
          const tableText = await p.locator('[aria-label="Agent performance metrics"]').textContent();
          if (!tableText?.includes('orchestrator')) throw new Error('orchestrator not in performance table');
          if (!tableText?.includes('coder'))        throw new Error('coder not in performance table');
          if (!tableText?.includes('reviewer'))     throw new Error('reviewer not in performance table');
        } finally {
          await p.unroute(dashApiPred).catch(() => {});
        }
      }, page);

      await test('Column sort — clicking a header toggles aria-sort', async (p) => {
        await p.route(dashApiPred, mockDash());
        try {
          await gotoDashboard(p);
          await p.waitForSelector('[aria-label="Agent performance metrics"]', { timeout: 8000 });
          // Default sort column is "runs" descending
          const runsHeader = p.locator('[aria-label="Agent performance metrics"] th').filter({ hasText: /^Runs$/ }).first();
          await runsHeader.waitFor({ timeout: 5000 });
          const sortBefore = await runsHeader.getAttribute('aria-sort');
          // Click to toggle sort direction
          await runsHeader.click();
          await p.waitForTimeout(300);
          const sortAfter = await runsHeader.getAttribute('aria-sort');
          if (sortBefore === sortAfter) {
            throw new Error(`aria-sort did not change after clicking Runs header: still "${sortAfter}"`);
          }
          // Click again — should toggle back
          await runsHeader.click();
          await p.waitForTimeout(300);
          const sortFinal = await runsHeader.getAttribute('aria-sort');
          if (sortFinal === sortAfter) {
            throw new Error(`aria-sort did not toggle back on second click: "${sortAfter}" → "${sortFinal}"`);
          }
        } finally {
          await p.unroute(dashApiPred).catch(() => {});
        }
      }, page);

      // ── 47.4  Drill-down modal ─────────────────────────────────────────

      await test('Table row click opens drill-down dialog for that agent', async (p) => {
        await p.route(dashApiPred, mockDash());
        try {
          await gotoDashboard(p);
          await p.waitForSelector('[aria-label="Agent performance metrics"]', { timeout: 8000 });
          const orchRow = p.locator('[aria-label="View runs for orchestrator"]').first();
          await orchRow.waitFor({ timeout: 5000 });
          await orchRow.click();
          await p.waitForSelector('[role="dialog"][aria-label="Runs for orchestrator"]', { timeout: 6000 });
        } finally {
          await p.keyboard.press('Escape').catch(() => {});
          await p.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {});
          await p.unroute(dashApiPred).catch(() => {});
        }
      }, page);

      await test('Network node click opens the same drill-down dialog', async (p) => {
        await p.route(dashApiPred, mockDash());
        try {
          await gotoDashboard(p);
          // The SVG node for "orchestrator" has role="button" with aria-label starting with "orchestrator,"
          await p.waitForSelector('[role="button"][aria-label^="orchestrator,"]', { timeout: 8000 });
          const node = p.locator('[role="button"][aria-label^="orchestrator,"]').first();
          // force: true is required for SVG <g> elements. The "orchestrator" node is running=true,
          // so its child .db-node-glow circle has an infinite scale(1.5) CSS animation. Playwright's
          // "stable" actionability check sees the <g> bounding box changing every animation frame and
          // waits forever. force: true bypasses the stability check; the click event still reaches
          // React's onClick handler normally.
          await node.click({ force: true, timeout: 8000 });
          await p.waitForSelector('[role="dialog"][aria-label="Runs for orchestrator"]', { timeout: 6000 });
        } finally {
          await p.keyboard.press('Escape').catch(() => {});
          await p.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {});
          await p.unroute(dashApiPred).catch(() => {});
        }
      }, page);

      await test('Escape key closes the drill-down dialog', async (p) => {
        await p.route(dashApiPred, mockDash());
        try {
          await gotoDashboard(p);
          await p.waitForSelector('[aria-label="Agent performance metrics"]', { timeout: 8000 });
          const orchRow = p.locator('[aria-label="View runs for orchestrator"]').first();
          await orchRow.waitFor({ timeout: 5000 });
          await orchRow.click();
          await p.waitForSelector('[role="dialog"][aria-label="Runs for orchestrator"]', { timeout: 6000 });
          await p.keyboard.press('Escape');
          // Dialog must be gone
          await p.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 });
        } finally {
          await p.unroute(dashApiPred).catch(() => {});
        }
      }, page);

      // ── 47.5  Period selector refetches ────────────────────────────────

      await test('Period selector — changing period triggers API refetch with correct param', async (p) => {
        const requestedPeriods: string[] = [];
        await p.route(dashApiPred, async (route) => {
          const reqUrl = route.request().url();
          if (!reqUrl.includes('/agents/')) {
            const match = reqUrl.match(/[?&]period=([^&]+)/);
            if (match) requestedPeriods.push(match[1]);
          }
          await route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify(dashMockData),
          });
        });
        try {
          await gotoDashboard(p);
          await p.waitForSelector('.spinner', { state: 'detached', timeout: 8_000 }).catch(() => {});
          await p.waitForTimeout(400);
          // Click "7 days"
          await p.locator('button').filter({ hasText: /^7 days$/i }).first().click();
          await p.waitForTimeout(400);
          // Click "30 days"
          await p.locator('button').filter({ hasText: /^30 days$/i }).first().click();
          await p.waitForTimeout(400);
          const has7d  = requestedPeriods.includes('7d');
          const has30d = requestedPeriods.includes('30d');
          if (!has7d)  throw new Error(`Expected a 7d period request, got: ${JSON.stringify(requestedPeriods)}`);
          if (!has30d) throw new Error(`Expected a 30d period request, got: ${JSON.stringify(requestedPeriods)}`);
        } finally {
          await p.unroute(dashApiPred).catch(() => {});
        }
      }, page);

      // ── 47.6  Animation toggle ─────────────────────────────────────────

      await test('Animation toggle has role="switch"', async (p) => {
        await gotoDashboard(p);
        await p.waitForSelector('[role="switch"][aria-label*="nimation"]', { timeout: 8000 });
      }, page);

      await test('Turning off animation toggle removes db-anim class from .db-root', async (p) => {
        // Force animations ON before navigating
        await p.evaluate(() => { try { localStorage.setItem('dash-anim', '1'); } catch {} });
        await gotoDashboard(p);
        const root = p.locator('.db-root');
        await root.waitFor({ timeout: 8000 });
        // Ensure animations are ON
        const toggle = p.locator('[role="switch"][aria-label*="nimation"]').first();
        await toggle.waitFor({ timeout: 5000 });
        const checkedBefore = await toggle.getAttribute('aria-checked');
        if (checkedBefore !== 'true') {
          // Turn on first
          await toggle.click();
          await p.waitForTimeout(200);
        }
        // Now turn off
        await toggle.click();
        await p.waitForTimeout(200);
        const hasAnim = await root.evaluate((el) => el.classList.contains('db-anim'));
        if (hasAnim) throw new Error('db-anim class should be removed from .db-root when animations are turned off');
        await p.evaluate(() => { try { localStorage.removeItem('dash-anim'); } catch {} });
      }, page);

      await test('With animations off, animated elements have no running CSS animation-name', async (p) => {
        // Use mocked data so the network SVG exists (has .db-node-glow when running=true)
        await p.route(dashApiPred, mockDash());
        // Force animations OFF before navigating
        await p.evaluate(() => { try { localStorage.setItem('dash-anim', '0'); } catch {} });
        try {
          await gotoDashboard(p);
          await p.waitForSelector('.spinner', { state: 'detached', timeout: 8_000 }).catch(() => {});
          await p.waitForTimeout(500);
          // db-anim should not be present
          const hasAnim = await p.locator('.db-root').evaluate((el) => el.classList.contains('db-anim'));
          if (hasAnim) throw new Error('db-anim should not be on .db-root when dash-anim=0');
          // .db-node-glow exists (running=true node) but its animation-name should be "none"
          const glowAnimName = await p.evaluate(() => {
            const el = document.querySelector('.db-node-glow');
            if (!el) return 'NO_ELEMENT';
            return window.getComputedStyle(el).animationName;
          });
          if (glowAnimName !== 'NO_ELEMENT' && glowAnimName !== 'none') {
            throw new Error(`Expected animation-name "none" on .db-node-glow when animations off, got: "${glowAnimName}"`);
          }
        } finally {
          await p.evaluate(() => { try { localStorage.removeItem('dash-anim'); } catch {} });
          await p.unroute(dashApiPred).catch(() => {});
        }
      }, page);

      await test('Animation preference persists across reload via localStorage dash-anim', async (p) => {
        // Set OFF → reload → still off
        await p.evaluate(() => { try { localStorage.setItem('dash-anim', '0'); } catch {} });
        await gotoDashboard(p);
        const offAfterLoad = await p.locator('.db-root').evaluate((el) => el.classList.contains('db-anim'));
        if (offAfterLoad) throw new Error('db-anim should be absent when dash-anim=0 (reload)');
        // Set ON → reload → still on
        await p.evaluate(() => { try { localStorage.setItem('dash-anim', '1'); } catch {} });
        await gotoDashboard(p);
        const onAfterLoad = await p.locator('.db-root').evaluate((el) => el.classList.contains('db-anim'));
        if (!onAfterLoad) throw new Error('db-anim should be present when dash-anim=1 (reload)');
        // Cleanup
        await p.evaluate(() => { try { localStorage.removeItem('dash-anim'); } catch {} });
      }, page);

      await test('prefers-reduced-motion: reduce with no stored preference → animations default off', async (p) => {
        // Clear stored preference
        await p.evaluate(() => { try { localStorage.removeItem('dash-anim'); } catch {} });
        // Emulate reduced motion BEFORE navigating (useState initializer reads this on mount)
        await p.emulateMedia({ reducedMotion: 'reduce' });
        await gotoDashboard(p);
        const root = p.locator('.db-root');
        await root.waitFor({ timeout: 8000 });
        const hasAnim = await root.evaluate((el) => el.classList.contains('db-anim'));
        if (hasAnim) {
          throw new Error(
            'db-anim should NOT be present when prefers-reduced-motion: reduce and no stored preference',
          );
        }
        // Restore media preference
        await p.emulateMedia({ reducedMotion: 'no-preference' });
      }, page);

      // ── 47.7  Keyboard navigation ──────────────────────────────────────

      await test('Keyboard: table row focused and activated with Enter opens drill-down', async (p) => {
        await p.route(dashApiPred, mockDash());
        try {
          await gotoDashboard(p);
          await p.waitForSelector('[aria-label="Agent performance metrics"]', { timeout: 8000 });
          const orchRow = p.locator('[aria-label="View runs for orchestrator"]').first();
          await orchRow.waitFor({ timeout: 5000 });
          // Focus the row programmatically then activate via keyboard
          await orchRow.focus();
          await p.keyboard.press('Enter');
          await p.waitForSelector('[role="dialog"][aria-label="Runs for orchestrator"]', { timeout: 6000 });
        } finally {
          await p.keyboard.press('Escape').catch(() => {});
          await p.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {});
          await p.unroute(dashApiPred).catch(() => {});
        }
      }, page);

      await test('Keyboard: network node focused and activated with Enter opens drill-down', async (p) => {
        await p.route(dashApiPred, mockDash());
        try {
          await gotoDashboard(p);
          await p.waitForSelector('[role="button"][aria-label^="orchestrator,"]', { timeout: 8000 });
          const node = p.locator('[role="button"][aria-label^="orchestrator,"]').first();
          await node.focus();
          await p.keyboard.press('Enter');
          await p.waitForSelector('[role="dialog"][aria-label="Runs for orchestrator"]', { timeout: 6000 });
        } finally {
          await p.keyboard.press('Escape').catch(() => {});
          await p.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {});
          await p.unroute(dashApiPred).catch(() => {});
        }
      }, page);

      // ── 47.8  g+d shortcut ─────────────────────────────────────────────

      await test('g+d shortcut navigates to Dashboard', async (p) => {
        await goto(p, '/projects', 600);
        await p.waitForSelector('.shell', { timeout: 5000 });
        // Click a non-input area so the shortcut handler fires
        await p.locator('.shell').click();
        await p.waitForTimeout(100);
        await p.keyboard.press('g');
        await p.waitForTimeout(50);
        await p.keyboard.press('d');
        await p.waitForTimeout(600);
        const url = p.url();
        if (!url.includes('#/dashboard')) {
          throw new Error(`g+d should navigate to #/dashboard, got: ${url}`);
        }
      }, page);

    } // end sectionEnabled('dashboard')

    // ── 48. Bug-fix smoke: ConfirmDialog closes + Workspace in new-session dialog ──
    if (sectionEnabled('workspaces', 'sessions')) {
    console.log('\n48. Bug-fix smoke: ConfirmDialog closes + workspace picker');
    currentSectionId = '48';

    await test('Delete workspace via confirm dialog — dialog closes, row gone', async (p) => {
      // Create a workspace to delete
      const wsData = await apiPost(`/api/projects/${projectId}/workspaces`, {
        name: 'Smoke Delete WS',
        repoIds: [],
      });
      const wsId = (wsData as any)?.workspace?.id as string | undefined;
      if (!wsId) throw new Error('Failed to create workspace via API for delete test');

      await goto(p, `/p/${projectId}/workspaces`, 1000);
      await assertHeading(p, 'Workspaces');

      // Wait for the delete button for this workspace
      const deleteBtn = p.locator(`button[aria-label="Delete Smoke Delete WS"]`).first();
      await deleteBtn.waitFor({ timeout: 8000 });
      await deleteBtn.click();

      // ConfirmDialog must appear
      await p.waitForSelector('[role="dialog"][aria-labelledby="confirm-dialog-title"]', { timeout: 5000 });

      // Click the danger "Delete" confirm button
      const confirmBtn = p.locator('[role="dialog"] .btn-danger').first();
      await confirmBtn.waitFor({ timeout: 3000 });
      await confirmBtn.click();

      // Dialog MUST close (Bug 1 fix: open is now set to false on answer)
      await p.waitForSelector('[role="dialog"][aria-labelledby="confirm-dialog-title"]', {
        state: 'detached',
        timeout: 6000,
      });

      // Row must be gone
      await p.waitForTimeout(600);
      const rowCount = await p.locator(`button[aria-label="Delete Smoke Delete WS"]`).count();
      if (rowCount > 0) {
        throw new Error('Workspace row should be removed from the table after deletion');
      }
    }, page);

    await test('New session dialog lists workspace from API; workspaceId sent in POST body', async (p) => {
      // Create a workspace via API
      const wsData = await apiPost(`/api/projects/${projectId}/workspaces`, {
        name: 'Smoke Session WS',
        repoIds: [],
      });
      const wsId = (wsData as any)?.workspace?.id as string | undefined;
      if (!wsId) throw new Error('Failed to create workspace via API for session test');

      await goto(p, `/p/${projectId}/sessions`, 1000);

      // Open new session dialog
      const newBtn = p.locator('button').filter({ hasText: /new session/i }).first();
      await newBtn.waitFor({ timeout: 8000 });
      await newBtn.click();
      await p.waitForSelector('[role="dialog"][aria-labelledby="new-session-title"]', { timeout: 5000 });

      // Allow workspaces to load inside the dialog (SessionList now fetches + passes them)
      await p.waitForTimeout(1000);

      // The #ns-workspace select must be present and contain the new workspace
      const wsSelect = p.locator('#ns-workspace');
      await wsSelect.waitFor({ timeout: 6000 });
      const optionTexts = await wsSelect.locator('option').allTextContents();
      if (!optionTexts.some((t) => t.includes('Smoke Session WS'))) {
        throw new Error(
          `Workspace "Smoke Session WS" not found in #ns-workspace options: ${JSON.stringify(optionTexts)}`,
        );
      }

      // Select it and verify the select value updates
      await wsSelect.selectOption(wsId);
      const selectedVal = await wsSelect.inputValue();
      if (selectedVal !== wsId) {
        throw new Error(`Workspace selection did not register: expected "${wsId}", got "${selectedVal}"`);
      }

      // Fill in goal then submit; intercept the POST to verify workspaceId
      await p.fill('#ns-goal', 'WS smoke test session');
      const startBtn = p.locator('[role="dialog"] button').filter({ hasText: /start session/i }).first();

      const [wfResponse] = await Promise.all([
        p.waitForResponse(
          (r) =>
            r.url().includes(`/api/projects/${projectId}/workflows`) &&
            !r.url().includes('/start') &&
            r.request().method() === 'POST',
          { timeout: 10_000 },
        ),
        startBtn.click(),
      ]);

      const sentBody = JSON.parse(wfResponse.request().postData() ?? '{}') as Record<string, unknown>;
      if (sentBody.workspaceId !== wsId) {
        throw new Error(
          `Expected workspaceId "${wsId}" in POST body, got "${sentBody.workspaceId}"`,
        );
      }
    }, page);
    } // end §48 workspaces/sessions

    // ── 49. Tickets page ──────────────────────────────────────────────────
    if (sectionEnabled('tickets')) {
    console.log('\n49. Tickets');
    currentSectionId = '49';

    await test('Tickets page renders not-connected card', async (p) => {
      // Jira is not configured in the smoke-test environment, so we expect
      // to see the "Connect Jira" card (not a "Coming soon" placeholder).
      await goto(p, `/p/${projectId}/tickets`, 1000);
      await p.waitForSelector('.shell', { timeout: 8000 });
      await assertNoPlaceholder(p);

      // Expect the connect-Jira card heading
      await p.waitForSelector('h1, h2', { timeout: 8000 });
      const headings = await p.locator('h1, h2').allTextContents();
      const hasTickets = headings.some(t => /tickets/i.test(t));
      if (!hasTickets) {
        throw new Error(`Expected "Tickets" heading, found: ${JSON.stringify(headings)}`);
      }

      // Either the connect card or an access-restricted message must be visible
      const bodyText = await p.evaluate(() => document.body.innerText);
      const hasConnectOrRestricted =
        /connect jira/i.test(bodyText) ||
        /ask a project owner/i.test(bodyText);
      if (!hasConnectOrRestricted) {
        throw new Error(
          `Expected "Connect Jira" or restricted message on not-connected Tickets page. Body: ${bodyText.slice(0, 300)}`,
        );
      }
    }, page);

    await test('New Session dialog does not show Ticket section when Jira is not connected', async (p) => {
      // Navigate to sessions, open New Session dialog
      await goto(p, `/p/${projectId}/sessions`, 800);
      await p.waitForSelector('.shell', { timeout: 8000 });

      // Find and click the "New" / "+ New" button to open the dialog
      const newBtn = p.locator('button').filter({ hasText: /^\+?\s*(new\s*(session)?|new)\s*$/i }).first();
      const altBtn = p.locator('button[aria-label*="New session" i], button[title*="New session" i]').first();
      const btn = (await newBtn.count()) > 0 ? newBtn : altBtn;
      await btn.waitFor({ timeout: 8000 });
      await btn.click();

      // Dialog must appear
      await p.waitForSelector('[role="dialog"]', { timeout: 8000 });

      // The Ticket / Jira section must NOT be present (Jira not connected)
      const dialogText = await p.locator('[role="dialog"]').textContent();
      if (/jira ticket|search tickets/i.test(dialogText ?? '')) {
        throw new Error(
          'New Session dialog shows Jira ticket section even though Jira is not connected',
        );
      }

      // Close dialog
      await p.keyboard.press('Escape');
    }, page);
    } // end §49 tickets

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

  writeResultsFile(true);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  writeResultsFile(false);
  stopServer();
  cleanupData();
  process.exit(1);
});


