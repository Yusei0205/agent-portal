/**
 * Playwright screenshot script.
 *
 * Takes screenshots of key pages in Aethrix Night dark/light and Classic Teal dark.
 * Usage:
 *   node scripts/build.mjs && node --disable-warning=ExperimentalWarning --import tsx test/ui/take-screenshots.ts
 *
 * Outputs to test/ui/screenshots/ (gitignored)
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const BASE           = 'http://127.0.0.1:8897';
const DATA_DIR       = path.resolve('./data-screenshot-test');
const SECRET         = '0000000000000000000000000000000000000000000000000000000000000001';
const PORT           = '8897';
const ADMIN_EMAIL    = 'admin@screenshot.local';
const ADMIN_PASSWORD = 'screenshotpass99';
const ADMIN_NAME     = 'Screenshot Admin';
const OUT_DIR        = path.resolve('./test/ui/screenshots');

fs.mkdirSync(OUT_DIR, { recursive: true });

let serverProc: cp.ChildProcess | null = null;

async function startServer(): Promise<void> {
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    serverProc = cp.spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'dist/server.mjs'],
      {
        env: { ...process.env, DATA_DIR, PORTAL_SECRET_KEY: SECRET, PORT, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let ready = false;
    const markReady = () => { if (!ready) { ready = true; setTimeout(resolve, 300); } };
    serverProc.stdout?.on('data', (c: Buffer) => { if (c.toString().toLowerCase().includes('listen')) markReady(); });
    serverProc.stderr?.on('data', () => {});
    serverProc.on('error', reject);
    serverProc.on('exit', (code) => { if (!ready) reject(new Error(`Server exited ${code}`)); });
    setTimeout(markReady, 5000);
  });
}

function stopServer() { try { serverProc?.kill(); } catch { /* */ } }
function cleanup() {
  try { if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
}

let sessionCookie = '';
async function apiPost(urlPath: string, body: unknown): Promise<any> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-requested-with': 'agent-portal',
  };
  if (sessionCookie) headers['cookie'] = sessionCookie;
  const res = await fetch(`${BASE}${urlPath}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const sc = res.headers.get('set-cookie');
  if (sc) sessionCookie = sc.split(';')[0];
  return res.json().catch(() => ({}));
}

async function goto(page: Page, hash: string, wait = 800): Promise<void> {
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
}

async function setMode(page: Page, mode: 'dark' | 'light'): Promise<void> {
  // Set localStorage so theme-init.js reads the correct mode on (re)load
  await page.evaluate((m) => {
    try { localStorage.setItem('portal-mode', m); } catch { /* */ }
  }, mode);
  // Reload so theme-init.js and applyTheme() pick up the new mode
  await page.reload({ waitUntil: 'domcontentloaded' });
  // Wait for shell (may need to re-login if session expired — cookies persist in context)
  await page.waitForSelector('.shell, #login-email', { timeout: 8_000 });
  const needsLogin = await page.locator('#login-email').count();
  if (needsLogin) {
    await page.fill('#login-email', ADMIN_EMAIL);
    await page.fill('#login-password', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.shell', { timeout: 8_000 });
  }
  await page.waitForTimeout(300);
}

async function setTemplate(page: Page, id: string): Promise<void> {
  // Activate via API
  try {
    await apiPost(`/api/admin/themes/${id}/activate`, {});
  } catch { /* best effort */ }
  // Also force via localStorage so theme-init picks it up on reload
  await page.evaluate((tmplId) => {
    try { localStorage.setItem('portal-template-id', tmplId); } catch { /* */ }
  }, id);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function shot(page: Page, name: string): Promise<void> {
  const outPath = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: outPath, fullPage: false });
  console.log(`  📸 ${name}.png`);
}

async function login(page: Page): Promise<void> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.waitForSelector('#login-email', { timeout: 8000 }).catch(() => {});
  const hasLogin = await page.locator('#login-email').count();
  if (hasLogin) {
    await page.fill('#login-email', ADMIN_EMAIL);
    await page.fill('#login-password', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.shell', { timeout: 8_000 });
  }
}

async function main() {
  console.log('\nAgent Portal — Screenshot capture\n');

  process.stdout.write('Starting server… ');
  await startServer();
  await new Promise(r => setTimeout(r, 1000));
  console.log('✓');

  process.stdout.write('Setup + login… ');
  await apiPost('/api/auth/setup', { name: ADMIN_NAME, email: ADMIN_EMAIL, password: ADMIN_PASSWORD, provider: 'demo' });
  await apiPost('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

  const projRes = await apiPost('/api/projects', { name: 'Screenshot Project', description: 'For screenshot tests' });
  const projectId: string = (projRes as any).project?.id ?? '';
  console.log('✓');

  const browser: Browser = await chromium.launch({ headless: true });

  // ── Aethrix Night dark + light ─────────────────────────────────────────────
  for (const mode of ['dark', 'light'] as const) {
    console.log(`\n— Aethrix Night ${mode}`);
    const context: BrowserContext = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
    const page: Page = await context.newPage();

    await login(page);
    await setMode(page, mode);
    await page.waitForTimeout(300);

    // Login screen (reload to screenshot before shell)
    // We take a quick shot of the login form by clearing auth cookie
    // For simplicity, just take it as the first screen on a fresh context
    {
      const ctx2 = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
      const p2 = await ctx2.newPage();
      await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
      await p2.waitForTimeout(600);
      await p2.evaluate((m) => {
        document.documentElement.setAttribute('data-theme', m);
        document.documentElement.setAttribute('data-mode', m);
      }, mode);
      await p2.waitForTimeout(300);
      await shot(p2, `login-${mode}`);
      await ctx2.close();
    }

    // Projects — with project
    await goto(page, '/projects', 1000);
    await page.waitForSelector('.spinner', { state: 'detached', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    await shot(page, `projects-with-project-${mode}`);

    // Projects — empty state (not achievable with existing project, skip unless empty)
    const hasGrid = await page.locator('.project-grid').count();
    if (hasGrid === 0) {
      await shot(page, `projects-empty-${mode}`);
    }

    // Rail expanded
    await goto(page, `/p/${projectId}/sessions`, 800);
    await page.waitForSelector('.rail', { timeout: 5000 });
    // Ensure expanded
    if ((await page.locator('.shell.rail-collapsed').count()) > 0) {
      await page.locator('.rail-collapse-btn').first().click();
      await page.waitForTimeout(400);
    }
    await shot(page, `rail-expanded-${mode}`);

    // Project picker open (expanded mode)
    await goto(page, `/p/${projectId}/sessions`, 800);
    const pickerCard = page.locator('.project-picker-card').first();
    if (await pickerCard.count() > 0) {
      await pickerCard.click();
      await page.waitForSelector('[role="dialog"][aria-label="Switch project"]', { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(300);
      await shot(page, `rail-expanded-project-picker-${mode}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    // Collapsed rail
    await goto(page, `/p/${projectId}/sessions`, 800);
    if ((await page.locator('.shell.rail-collapsed').count()) === 0) {
      await page.locator('.rail-collapse-btn').first().click();
      await page.waitForTimeout(400);
    }
    await shot(page, `rail-collapsed-${mode}`);

    // Project picker open (collapsed mode)
    const avatar = page.locator('.project-picker-avatar').first();
    if (await avatar.count() > 0) {
      await avatar.click();
      await page.waitForSelector('[role="dialog"][aria-label="Switch project"]', { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(300);
      await shot(page, `rail-collapsed-project-picker-${mode}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    // Expand back
    await page.locator('.rail-collapse-btn').first().click();
    await page.waitForTimeout(400);

    // Mobile drawer (resize viewport to 750px width)
    await page.setViewportSize({ width: 750, height: 800 });
    await goto(page, '/projects', 600);
    await page.waitForSelector('.topbar', { timeout: 5000 });
    const menuBtn = page.locator('.topbar .btn-icon[aria-label="Menu"]').first();
    if (await menuBtn.count() > 0) {
      await menuBtn.click();
      await page.waitForTimeout(400);
      await shot(page, `rail-mobile-drawer-${mode}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);

    // Session workspace
    if (projectId) {
      try {
        const wfR = await apiPost(`/api/projects/${projectId}/workflows`, {
          goal: 'Screenshot test session',
          engine: 'demo',
        });
        const sessionId: string = (wfR as any).workflow?.id ?? '';
        if (sessionId) {
          await goto(page, `/p/${projectId}/sessions/${sessionId}`, 2000);
          await page.waitForSelector('.ide-workspace', { timeout: 8_000 }).catch(() => {});
          await page.waitForTimeout(800);
          await shot(page, `session-workspace-${mode}`);
        }
      } catch { console.log(`  (session screenshot skipped for ${mode})`); }
    }

    // Settings (general)
    await goto(page, '/settings', 1200);
    await page.waitForSelector('.shell', { timeout: 8000 });
    await page.waitForTimeout(600);
    await shot(page, `settings-${mode}`);

    // Settings › Appearance tab
    await goto(page, '/settings', 1200);
    const appTab = page.locator('#tab-appearance').first();
    if (await appTab.count() > 0) {
      await appTab.click();
      await page.waitForTimeout(800);
      await shot(page, `settings-appearance-${mode}`);

      // Settings › Appearance with editor open (duplicate Aethrix Night then click Edit)
      try {
        const aethrixCard = page.locator('.template-card').filter({ hasText: /aethrix night/i }).first();
        const dupBtn = aethrixCard.locator('button').filter({ hasText: /duplicate/i }).first();
        if (await dupBtn.count() > 0) {
          await dupBtn.click();
          await page.waitForTimeout(600);
          const copyCard = page.locator('.template-card').filter({ hasText: /copy/i }).first();
          if (await copyCard.count() > 0) {
            const editBtn = copyCard.locator('button').filter({ hasText: /edit/i }).first();
            if (await editBtn.count() > 0) {
              await editBtn.click();
              await page.waitForSelector('.editor-shell', { timeout: 6000 });
              await page.waitForTimeout(500);
              await shot(page, `settings-appearance-editor-${mode}`);
              // Cancel to go back
              const cancelBtn = page.locator('button').filter({ hasText: /^cancel$/i }).first();
              if (await cancelBtn.count() > 0) await cancelBtn.click();
              await page.waitForTimeout(400);
            }
          }
        }
      } catch { console.log(`  (editor screenshot skipped for ${mode})`); }
    }

    // Tests page
    if (projectId) {
      await goto(page, `/p/${projectId}/tests`, 1000);
      await page.waitForSelector('.shell', { timeout: 8000 });
      await page.waitForTimeout(600);
      await shot(page, `tests-${mode}`);
    }

    // Branch scans (now inside Reviews page)
    if (projectId) {
      await goto(page, `/p/${projectId}/reviews/branch-scans`, 1000);
      await page.waitForSelector('.shell', { timeout: 8000 });
      await page.waitForTimeout(600);
      await shot(page, `reviews-branchscans-${mode}`);

      // Reviews code tab
      await goto(page, `/p/${projectId}/reviews/code`, 1000);
      await page.waitForSelector('.shell', { timeout: 8000 });
      await page.waitForTimeout(600);
      await shot(page, `reviews-code-${mode}`);

      // Reviews dashboard tab
      await goto(page, `/p/${projectId}/reviews/dashboard`, 1000);
      await page.waitForSelector('.shell', { timeout: 8000 });
      await page.waitForTimeout(800);
      await shot(page, `reviews-dashboard-${mode}`);
    }

    // Connections page
    await goto(page, '/connections/git', 1000);
    await page.waitForSelector('.shell', { timeout: 8000 });
    await page.waitForTimeout(600);
    await shot(page, `connections-git-${mode}`);

    await goto(page, '/connections/aws', 1000);
    await page.waitForSelector('.shell', { timeout: 8000 });
    await page.waitForTimeout(600);
    await shot(page, `connections-aws-${mode}`);

    await context.close();
  }

  // ── Classic Teal light ─────────────────────────────────────────────────────
  console.log('\n— Classic Teal light');
  {
    const context: BrowserContext = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
    const page: Page = await context.newPage();
    await login(page);
    await setTemplate(page, 'classic-teal');
    await setMode(page, 'light');
    await page.waitForTimeout(300);

    await goto(page, '/projects', 1000);
    await page.waitForSelector('.spinner', { state: 'detached', timeout: 5000 }).catch(() => {});
    await shot(page, 'projects-classic-teal-dark');

    // Rail shots for Classic Teal dark
    await goto(page, `/p/${projectId}/sessions`, 800);
    await shot(page, 'rail-expanded-classic-teal-dark');

    // Collapsed + picker
    if ((await page.locator('.shell.rail-collapsed').count()) === 0) {
      await page.locator('.rail-collapse-btn').first().click();
      await page.waitForTimeout(400);
    }
    await shot(page, 'rail-collapsed-classic-teal-dark');
    const avatarCT = page.locator('.project-picker-avatar').first();
    if (await avatarCT.count() > 0) {
      await avatarCT.click();
      await page.waitForSelector('[role="dialog"][aria-label="Switch project"]', { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(300);
      await shot(page, 'rail-collapsed-project-picker-classic-teal-dark');
      await page.keyboard.press('Escape');
    }
    await page.locator('.rail-collapse-btn').first().click();
    await page.waitForTimeout(400);

    await goto(page, '/settings', 1200);
    await page.waitForTimeout(600);
    await shot(page, 'settings-classic-teal-dark');

    // Restore to Aethrix Night for clean state
    await setTemplate(page, 'aethrix-night').catch(() => {});

    await context.close();
  }

  await browser.close();
  stopServer();
  cleanup();

  console.log(`\n✓ Screenshots saved to ${OUT_DIR}\n`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  stopServer();
  cleanup();
  process.exit(1);
});

