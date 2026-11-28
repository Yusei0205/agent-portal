/**
 * Test run execution engine.
 *
 * Routes:
 *   POST /api/projects/:pid/tests/:tpid/scripts/:sid/run   — start run for one script
 *   POST /api/projects/:pid/tests/:tpid/groups/:gid/run    — start run for entire group
 *   GET  /api/projects/:pid/tests/:tpid/runs               — list runs
 *   GET  /api/projects/:pid/tests/:tpid/runs/:rid          — get run + step results
 *   POST /api/projects/:pid/tests/:tpid/runs/:rid/cancel   — cancel run
 *   GET  /api/projects/:pid/tests/:tpid/runs/:rid/steps/:stepIdx/screenshot — serve screenshot
 */

import { testingRepo } from './data.ts';
import { registerBackgroundJob, runInBackground } from '../background-jobs.ts';
import { restoreFile } from '../durable-files.ts';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { all, one, run, insert, getDb } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now } from '../util.ts';
import { config } from '../config.ts';
import { auditRaw } from '../audit.ts';
import { getSetting } from '../settings.ts';
import { findBrowser } from '../docimage.ts';
import {
  requireTestProject,
  hasScope,
} from './helpers.ts';
import type { TestProject, TestScript, TestRun, TestGroup } from './helpers.ts';
import { validateSteps } from './types.ts';
import type { Step, LocatorShape } from './types.ts';
import { resolveVaultRefs } from './vault.ts';
import { assertNotBlocked, privateNetworksAllowed } from './ssrf.ts';
import { guardedFetch } from './guarded-fetch.ts';
import { callTextModel } from './model-provider.ts';

// ── In-memory concurrency + cancellation tracking ─────────────────────────────

let runningCount = 0;
const cancelledRuns = new Set<string>();

export function _resetRunnerState(): void {
  runningCount = 0;
  cancelledRuns.clear();
}

// ── Injectable mkdir (seam for testing mkdir failure) ─────────────────────────

let _mkdirFn: (path: string, opts?: { recursive?: boolean }) => Promise<unknown> = (p, o) =>
  fsp.mkdir(p, o);
export function _setMkdirFn(fn: (path: string, opts?: { recursive?: boolean }) => Promise<unknown>): void {
  _mkdirFn = fn;
}
export function _resetMkdirFn(): void {
  _mkdirFn = (p, o) => fsp.mkdir(p, o);
}

/** Queue a test run in the background. Used by MCP tools. */
export async function queueTestRun(runId: string, scripts: TestScript[], tp: TestProject): Promise<void> {
  return executeRun(runId, scripts, tp);
}

/** Expose running count and cancellation set for MCP tools. */
export { runningCount as _runningCount, cancelledRuns as _cancelledRuns };

// ── Agent step injectable ──────────────────────────────────────────────────────

export type AgentStepFn = (instruction: string, pageHtml: string) => Promise<void>;

// null = use built-in real implementation; set via setAgentStepFn for tests
let _agentStepFn: AgentStepFn | null = null;

export function setAgentStepFn(fn: AgentStepFn | null): void {
  _agentStepFn = fn;
}

// ── Real agent step implementation ────────────────────────────────────────────

/** Strip password field values from HTML before sending to the model. */
function stripPasswordValues(html: string): string {
  return html.replace(
    /(<input(?=[^>]*type=["']?password["']?)[^>]*)\s+value=["'][^"']*["']/gi,
    '$1',
  );
}

/**
 * Ask the portal model for a list of concrete test steps that accomplish the
 * given instruction, then execute them on the current page.
 *
 * Steps are validated (no `agent` kind allowed, max 10) and executed in order.
 * Any vault refs in the model output are resolved as usual at execution time.
 */
async function runAgentStepOnPage(
  instruction: string,
  rawHtml: string,
  page: PageLike,
  tp: TestProject,
  scriptId: string,
  stepIdx: number,
  runId: string,
  artifactDir: string,
  allowPrivateNetworks: boolean,
): Promise<void> {
  // Build the step-generation prompt
  const STEP_SCHEMA = `Respond ONLY with a JSON array of step objects (max 10).
Available kinds: goto, click, fill, select, press, upload, assert_visible, assert_text, assert_url, wait, api_request.
Do NOT use kind "agent".
Locator shapes: {role,name}, {label}, {text}, {testId}, {css}.
For vault values use {{vault.<name>.username|password|totp|value}}.`;

  const safeHtml = stripPasswordValues(rawHtml).slice(0, 32_000);
  const userMessage = `Instruction: ${instruction}\n\nCurrent page HTML (truncated):\n${safeHtml}`;

  const text = await callTextModel(STEP_SCHEMA, userMessage, { maxTokens: 2048 });
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('Model did not return a JSON array');
  let modelOutput: unknown = JSON.parse(m[0]);

  if (!Array.isArray(modelOutput)) throw new Error('Agent step: model output must be a JSON array');
  if (modelOutput.length > 10) modelOutput = (modelOutput as unknown[]).slice(0, 10);

  // Validate — reject any `agent` kind to prevent recursion
  const { validateSteps: _validateSteps } = await import('./types.ts');
  const subSteps = _validateSteps(modelOutput);
  if (subSteps.some((s) => s.kind === 'agent')) {
    throw new Error('Agent step: model returned an "agent" sub-step (not allowed)');
  }

  // Execute each sub-step
  for (let i = 0; i < subSteps.length; i++) {
    const subStepMaskedLocators: LocatorLike[] = [];
    const subResult = await executeStep(
      subSteps[i], page, tp, scriptId, stepIdx * 100 + i, runId, artifactDir, allowPrivateNetworks, subStepMaskedLocators,
    );
    if (!subResult.passed) {
      throw new Error(`Agent sub-step ${i}: ${subResult.error}`);
    }
  }
}

// ── Playwright lazy loader ────────────────────────────────────────────────────

interface PlaywrightLike {
  chromium: {
    launch(opts?: object): Promise<BrowserLike>;
    executablePath?(): string;
  };
}
interface BrowserLike {
  newContext(opts?: object): Promise<ContextLike>;
  close(): Promise<void>;
}
interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
interface PageLike {
  goto(url: string, opts?: object): Promise<unknown>;
  locator(selector: string): LocatorLike;
  getByRole(role: string, opts?: object): LocatorLike;
  getByLabel(label: string): LocatorLike;
  getByText(text: string): LocatorLike;
  getByTestId(id: string): LocatorLike;
  screenshot(opts?: object): Promise<Buffer>;
  evaluate<T>(fn: () => T): Promise<T>;
  url(): string;
  content(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
  waitForSelector(selector: string, opts?: object): Promise<unknown>;
  setDefaultTimeout(ms: number): void;
  route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
}
interface RouteLike {
  request(): { url(): string };
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
}
interface LocatorLike {
  click(opts?: object): Promise<void>;
  fill(value: string): Promise<void>;
  selectOption(value: string): Promise<void>;
  press(key: string): Promise<void>;
  setInputFiles(files: string | string[]): Promise<void>;
  waitFor(opts?: object): Promise<void>;
  textContent(opts?: object): Promise<string | null>;
  isVisible(opts?: object): Promise<boolean>;
}

async function loadPlaywright(): Promise<PlaywrightLike | null> {
  try {
    return await import('playwright') as unknown as PlaywrightLike;
  } catch {
    try {
      return await import('playwright-core') as unknown as PlaywrightLike;
    } catch {
      return null;
    }
  }
}

function buildLocator(page: PageLike, loc: LocatorShape): LocatorLike {
  if ('role' in loc) return page.getByRole(loc.role, { name: loc.name });
  if ('label' in loc) return page.getByLabel(loc.label);
  if ('text' in loc) return page.getByText(loc.text);
  if ('testId' in loc) return page.getByTestId(loc.testId);
  if ('css' in loc) return page.locator(loc.css);
  throw new Error('Invalid locator');
}

// ── Masked screenshot helper ──────────────────────────────────────────────────

/**
 * Take a screenshot masking both password inputs and any locators that
 * were filled with vault-resolved values during this test run.
 *
 * If the masked screenshot fails for any reason, no fallback screenshot is
 * taken — a failed screenshot means no screenshot (never leaks vault secrets).
 */
async function takeScreenshot(
  page: PageLike,
  screenshotPath: string,
  extraMaskLocators: LocatorLike[] = [],
): Promise<void> {
  const absDir = path.dirname(screenshotPath);
  await fsp.mkdir(absDir, { recursive: true });

  const maskList = [page.locator('input[type="password"]'), ...extraMaskLocators];

  await (page as unknown as {
    screenshot(opts: {
      path: string;
      mask?: LocatorLike[];
      maskColor?: string;
    }): Promise<Buffer>;
  }).screenshot({
    path: screenshotPath,
    mask: maskList,
    maskColor: '#000000',
  });
  // No fallback: if masking fails the screenshot is not taken.
}

// ── JSON path evaluation (dot-notation, no new dep) ───────────────────────────

function evalJsonPath(obj: unknown, jsonPath: string): unknown {
  const parts = jsonPath.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ── SSRF-safe fetch (redirect-following + per-hop check) ─────────────────────

const MAX_REDIRECT_HOPS = 5;

/**
 * Fetch `url` with `redirect: 'manual'` and follow up to MAX_REDIRECT_HOPS
 * redirect hops manually, calling `assertNotBlocked` on every Location header
 * before following it.  This prevents SSRF via open redirects.
 */
export async function fetchWithSsrfCheck(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  allowPrivateNetworks: boolean,
): Promise<Response> {
  let currentUrl = url;
  // Only send the body on the first request; redirects use GET with no body.
  let currentMethod = method;
  let currentBody: string | undefined = body;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const resp = await guardedFetch(currentUrl, {
      method: currentMethod,
      headers,
      body: currentBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    }, allowPrivateNetworks);

    if (resp.status >= 300 && resp.status < 400) {
      if (hop === MAX_REDIRECT_HOPS) {
        throw new Error(`Too many redirects (> ${MAX_REDIRECT_HOPS}) for ${url}`);
      }
      const location = resp.headers.get('location');
      if (!location) {
        // No Location header — treat as non-redirect response
        return resp;
      }
      // Resolve relative Location against current URL
      const nextUrl = new URL(location, currentUrl).href;
      // SSRF check on each hop location before following
      await assertNotBlocked(nextUrl, allowPrivateNetworks);
      currentUrl = nextUrl;
      // Standard: redirect with GET + no body for 301/302/303; 307/308 preserve method
      if (resp.status !== 307 && resp.status !== 308) {
        currentMethod = 'GET';
        currentBody = undefined;
        delete headers['content-type'];
        delete headers['Content-Type'];
      }
      continue;
    }

    return resp;
  }
  /* istanbul ignore next */
  throw new Error('Unexpected end of redirect loop');
}

// ── Step executor ─────────────────────────────────────────────────────────────

async function executeStep(
  step: Step,
  page: PageLike,
  tp: TestProject,
  scriptId: string,
  stepIdx: number,
  runId: string,
  artifactDir: string,
  allowPrivateNetworks: boolean,
  vaultMaskedLocators: LocatorLike[],
): Promise<{ passed: boolean; error?: string; screenshotPath?: string }> {
  const screenshotPath = path.join(artifactDir, `step-${stepIdx}.png`);

  try {
    switch (step.kind) {
      case 'goto': {
        const url = step.path.startsWith('http://') || step.path.startsWith('https://')
          ? step.path
          : `${tp.app_url}${step.path.startsWith('/') ? '' : '/'}${step.path}`;
        await assertNotBlocked(url, allowPrivateNetworks);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: tp.timeout_secs * 1000 } as object);
        break;
      }
      case 'click': {
        const loc = buildLocator(page, step.locator);
        await loc.click();
        break;
      }
      case 'fill': {
        const value = await resolveVaultRefs(step.value, tp.id);
        const loc = buildLocator(page, step.locator);
        await loc.fill(value);
        // Track locator for masking if the value was resolved from the vault
        if (value !== step.value) {
          vaultMaskedLocators.push(loc);
        }
        break;
      }
      case 'select': {
        const value = await resolveVaultRefs(step.value, tp.id);
        const loc = buildLocator(page, step.locator);
        await loc.selectOption(value);
        // Track locator for masking if the value was resolved from the vault
        if (value !== step.value) {
          vaultMaskedLocators.push(loc);
        }
        break;
      }
      case 'press': {
        if (step.locator) {
          await buildLocator(page, step.locator).press(step.key);
        } else {
          await page.locator('body').press(step.key);
        }
        break;
      }
      case 'upload': {
        const fileRef = step.file.match(/^\{\{file\.([^}]+)\}\}$/);
        if (!fileRef) throw new Error(`Invalid file ref: ${step.file}`);
        const fileName = fileRef[1];
        const fileRow = await testingRepo().getVaultFileByTestProjectAndName(tp.id, fileName);
        if (!fileRow) throw new Error(`Vault file "${fileName}" not found`);
        const absFilePath = path.join(config.dataDir, String(fileRow.path));
        if (!(await restoreFile(absFilePath))) throw new Error(`Vault file "${fileName}" not on disk`);
        const loc = buildLocator(page, step.locator);
        await loc.setInputFiles(absFilePath);
        break;
      }
      case 'assert_visible': {
        const loc = buildLocator(page, step.locator);
        await loc.waitFor({ state: 'visible', timeout: tp.timeout_secs * 1000 } as object);
        const visible = await loc.isVisible();
        if (!visible) throw new Error(`Expected element to be visible`);
        break;
      }
      case 'assert_text': {
        const loc = buildLocator(page, step.locator);
        await loc.waitFor({ state: 'visible', timeout: tp.timeout_secs * 1000 } as object);
        const actual = await loc.textContent();
        if (step.exact) {
          if (actual?.trim() !== step.text) {
            throw new Error(`Expected text "${step.text}" but got "${actual?.trim()}"`);
          }
        } else {
          if (!actual?.includes(step.text)) {
            throw new Error(`Expected text to contain "${step.text}" but got "${actual?.trim()}"`);
          }
        }
        break;
      }
      case 'assert_url': {
        const currentUrl = page.url();
        if (step.exact) {
          if (currentUrl !== step.url) {
            throw new Error(`Expected URL "${step.url}" but got "${currentUrl}"`);
          }
        } else {
          if (!currentUrl.includes(step.url)) {
            throw new Error(`Expected URL to contain "${step.url}" but got "${currentUrl}"`);
          }
        }
        break;
      }
      case 'wait': {
        if (step.ms !== undefined) {
          await page.waitForTimeout(step.ms);
        } else if (step.locator) {
          await buildLocator(page, step.locator).waitFor({ state: 'visible', timeout: tp.timeout_secs * 1000 } as object);
        }
        break;
      }
      case 'api_request': {
        const baseUrl = tp.api_base_url ?? tp.app_url;
        const url = step.path.startsWith('http://') || step.path.startsWith('https://')
          ? step.path
          : `${baseUrl.replace(/\/$/, '')}${step.path.startsWith('/') ? '' : '/'}${step.path}`;
        await assertNotBlocked(url, allowPrivateNetworks);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (step.headers) {
          for (const [k, v] of Object.entries(step.headers)) {
            headers[k] = await resolveVaultRefs(v, tp.id);
          }
        }
        const bodyStr = step.body !== undefined
          ? await resolveVaultRefs(JSON.stringify(step.body), tp.id)
          : undefined;
        // Follow redirects manually so every hop is checked for SSRF.
        // This also closes the DNS-rebinding gap: we re-check the Location
        // URL (which may be an IP literal) before following each hop.
        const resp = await fetchWithSsrfCheck(url, step.method, headers, bodyStr, tp.timeout_secs * 1000, allowPrivateNetworks);
        if (step.expectedStatus !== undefined && resp.status !== step.expectedStatus) {
          throw new Error(`Expected status ${step.expectedStatus} but got ${resp.status}`);
        }
        if (step.jsonAssertions?.length) {
          const respJson = await resp.json().catch(() => null);
          for (const assertion of step.jsonAssertions) {
            const actual = evalJsonPath(respJson, assertion.jsonPath);
            if (JSON.stringify(actual) !== JSON.stringify(assertion.expected)) {
              throw new Error(
                `JSON assertion failed: ${assertion.jsonPath} expected ${JSON.stringify(assertion.expected)} got ${JSON.stringify(actual)}`,
              );
            }
          }
        }
        // api_request has no screenshot
        return { passed: true };
      }
      case 'agent': {
        const html = await page.content();
        if (_agentStepFn) {
          await _agentStepFn(step.instruction, html);
        } else {
          await runAgentStepOnPage(step.instruction, html, page, tp, scriptId, stepIdx, runId, artifactDir, allowPrivateNetworks);
        }
        break;
      }
    }

    await takeScreenshot(page, screenshotPath, vaultMaskedLocators);
    return { passed: true, screenshotPath };
  } catch (err) {
    const errMsg = String((err as Error).message ?? err);
    try { await takeScreenshot(page, screenshotPath, vaultMaskedLocators); } catch { /* best effort — no unmasked fallback */ }
    return { passed: false, error: errMsg, screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : undefined };
  }
}

// ── Run executor ──────────────────────────────────────────────────────────────

async function executeRun(runId: string, scripts: TestScript[], tp: TestProject): Promise<void> {
  await testingRepo().updateTestRun(runId, { status: 'running', started_at: now() });

  const artifactDir = path.join(config.dataDir, 'test-runs', runId);
  const executablePath = findBrowser() ?? undefined;
  let browser: BrowserLike | null = null;
  let ctx: ContextLike | null = null;

  runningCount++;
  try {
    // mkdir inside the try so the finally always decrements — no early-return leaks
    await _mkdirFn(artifactDir, { recursive: true });
    await testingRepo().updateTestRun(runId, { artifact_dir: artifactDir });

    // SSRF guard setting — metadata/link-local always blocked; private networks allowed by default
    const allowPrivateNetworks = privateNetworksAllowed(getSetting(getDb(), 'test.allowPrivateNetworks'));

    const pw = await loadPlaywright();
    if (!pw) {
      const onLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
      await testingRepo().updateTestRun(runId, {
        status: 'error',
        error: onLambda
          ? 'Browser test runs are not available on the cloud portal yet (they need a browser runtime).'
          : 'playwright or playwright-core is not installed',
        finished_at: now(),
      });
      return; // finally runs → counter correctly decremented; no double-decrement possible
    }

    browser = await pw.chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox'],
    } as object);

    ctx = await browser.newContext({
      viewport: { width: tp.viewport_width, height: tp.viewport_height },
    } as object);

    let runPassed = true;
    let runError: string | undefined;

    for (const script of scripts) {
      if (cancelledRuns.has(runId)) {
        await testingRepo().updateTestRun(runId, { status: 'cancelled', finished_at: now() });
        break;
      }

      const page = await ctx.newPage();
      page.setDefaultTimeout(tp.timeout_secs * 1000);

      // Enforce SSRF guard at the browser level so redirects and sub-resources are covered
      await page.route('**/*', async (route) => {
        try {
          const reqUrl = route.request().url();
          const { checkSsrf } = await import('./ssrf.ts');
          const parsed = new URL(reqUrl);
          const result = await checkSsrf(parsed.hostname, allowPrivateNetworks);
          if (result.blocked) {
            await route.abort('blockedbycontentblocker');
            return;
          }
        } catch {
          // parse error or abort already — continue
        }
        await route.continue();
      }).catch(() => {}); // page.route may not be available in all playwright versions

      let steps: Step[];
      try { steps = validateSteps(JSON.parse(String(script.steps || '[]'))); }
      catch { steps = []; }

      // Per-page list of locators filled with vault-resolved values, for screenshot masking.
      const vaultMaskedLocators: LocatorLike[] = [];

      for (let i = 0; i < steps.length; i++) {
        if (cancelledRuns.has(runId)) break;

        const stepStart = Date.now();
        const result = await executeStep(steps[i], page, tp, script.id, i, runId, artifactDir, allowPrivateNetworks, vaultMaskedLocators);
        const duration = Date.now() - stepStart;

        const stepId = generateId();
        const relScreenshot = result.screenshotPath
          ? path.relative(config.dataDir, result.screenshotPath)
          : null;

        await testingRepo().createRunStep({
          id: stepId,
          run_id: runId,
          script_id: script.id,
          step_index: i,
          status: result.passed ? 'passed' : 'failed',
          duration_ms: duration,
          error: result.error ?? null,
          screenshot_path: relScreenshot,
          created_at: now(),
        });

        if (!result.passed) {
          runPassed = false;
          runError = result.error;
          break; // stop script on first failure
        }
      }

      await page.evaluate(() => { /* noop */ }).catch(() => {});
    }

    if (cancelledRuns.has(runId)) {
      await testingRepo().updateTestRun(runId, { status: 'cancelled', finished_at: now() });
    } else {
      await testingRepo().updateTestRun(runId, {
        status: runPassed ? 'passed' : 'failed',
        error: runError ?? null,
        finished_at: now(),
      });
    }
  } catch (err) {
    const errMsg = String((err as Error).message ?? err);
    await testingRepo().updateTestRun(runId, { status: 'error', error: errMsg, finished_at: now() }).catch(() => { /* best effort */ });
  } finally {
    cancelledRuns.delete(runId);
    runningCount = Math.max(0, runningCount - 1);
    try { await ctx?.close(); } catch { /* best effort */ }
    try { await browser?.close(); } catch { /* best effort */ }
  }
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerRunRoutes(): void {
  registerBackgroundJob('test-run', async (a) => {
    const runId = String(a.runId);
    try {
      const tp = (await testingRepo().getTestProjectById(String(a.testProjectId))) as unknown as TestProject | null;
      if (!tp) throw new Error('Test project not found');
      const scripts: TestScript[] = [];
      for (const id of (a.scriptIds as string[]) ?? []) {
        const sc = (await testingRepo().getTestScriptById(id)) as unknown as TestScript | null;
        if (sc) scripts.push(sc);
      }
      await executeRun(runId, scripts, tp);
    } catch (e) {
      await testingRepo().updateTestRun(runId, { status: 'error', error: String((e as Error).message ?? e), finished_at: now() })
        .catch(() => { /* DB may be closed in tests — best effort */ });
    }
  });

  // POST /api/projects/:pid/tests/:tpid/scripts/:sid/run — run one script
  router.post('/api/projects/:pid/tests/:tpid/scripts/:sid/run', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const script = (await testingRepo().getTestScriptByTestProjectAndId(tp.id, req.params.sid)) as unknown as TestScript | null;
    if (!script) { sendJson(res, 404, { error: 'Script not found' }); return; }

    const maxConcurrent = Number(getSetting(getDb(), 'test.run_concurrency') ?? '2') || 2;
    if (runningCount >= maxConcurrent) {
      sendJson(res, 429, { error: `Concurrency limit reached (max ${maxConcurrent} concurrent runs)` });
      return;
    }

    const runId = generateId();
    const ts = now();
    await testingRepo().createTestRun({
      id: runId,
      test_project_id: tp.id,
      script_id: script.id,
      group_id: null,
      status: 'queued',
      error: null,
      artifact_dir: null,
      created_by: req.user!.id,
      created_at: ts,
      started_at: null,
      finished_at: null,
    });

    auditRaw(req.user!.id, 'test_run.start', `test_run:${runId}`, { scriptId: script.id });
    // Start execution in the background (a separate Lambda invocation in the cloud).
    await runInBackground('test-run', { runId, testProjectId: tp.id, scriptIds: [script.id] });

    sendJson(res, 202, { runId });
  });

  // POST /api/projects/:pid/tests/:tpid/groups/:gid/run — run whole group
  router.post('/api/projects/:pid/tests/:tpid/groups/:gid/run', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const group = (await testingRepo().getTestGroupByTestProjectAndId(tp.id, req.params.gid)) as unknown as TestGroup | null;
    if (!group) { sendJson(res, 404, { error: 'Group not found' }); return; }

    const scripts = ((await testingRepo().listScriptsByGroup(group.id)) as unknown as TestScript[])
      .sort((a, b) => a.sort_order - b.sort_order);

    const maxConcurrent = Number(getSetting(getDb(), 'test.run_concurrency') ?? '2') || 2;
    if (runningCount >= maxConcurrent) {
      sendJson(res, 429, { error: `Concurrency limit reached (max ${maxConcurrent} concurrent runs)` });
      return;
    }

    const runId = generateId();
    const ts = now();
    await testingRepo().createTestRun({
      id: runId,
      test_project_id: tp.id,
      script_id: null,
      group_id: group.id,
      status: 'queued',
      error: null,
      artifact_dir: null,
      created_by: req.user!.id,
      created_at: ts,
      started_at: null,
      finished_at: null,
    });

    auditRaw(req.user!.id, 'test_run.start_group', `test_run:${runId}`, { groupId: group.id });
    await runInBackground('test-run', { runId, testProjectId: tp.id, scriptIds: scripts.map((x) => x.id) });

    sendJson(res, 202, { runId });
  });

  // GET /api/projects/:pid/tests/:tpid/runs — list runs
  router.get('/api/projects/:pid/tests/:tpid/runs', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const limit = Math.min(200, Math.max(1, Number(req.query.get('limit') || 50)));
    const offset = Math.max(0, Number(req.query.get('offset') || 0));
    const runs = (await testingRepo().listRunsByTestProject(tp.id, limit, offset))
      .map((r) => ({
        id: r.id, script_id: r.script_id, group_id: r.group_id, status: r.status, error: r.error,
        created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at, created_by: r.created_by,
      })) as Row[];
    sendJson(res, 200, { runs });
  });

  // GET /api/projects/:pid/tests/:tpid/runs/:rid — get run + steps
  router.get('/api/projects/:pid/tests/:tpid/runs/:rid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const testRun = (await testingRepo().getTestRunByTestProjectAndId(tp.id, req.params.rid)) as unknown as TestRun | null;
    if (!testRun) { sendJson(res, 404, { error: 'Run not found' }); return; }
    const steps = (await testingRepo().listStepsByRun(testRun.id))
      .sort((a, b) => a.step_index - b.step_index)
      .map((x) => ({
        id: x.id, script_id: x.script_id, step_index: x.step_index, status: x.status, duration_ms: x.duration_ms,
        error: x.error, screenshot_path: x.screenshot_path, created_at: x.created_at,
      })) as Row[];
    sendJson(res, 200, { run: testRun, steps });
  });

  // POST /api/projects/:pid/tests/:tpid/runs/:rid/cancel
  router.post('/api/projects/:pid/tests/:tpid/runs/:rid/cancel', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const testRun = (await testingRepo().getTestRunByTestProjectAndId(tp.id, req.params.rid)) as unknown as TestRun | null;
    if (!testRun) { sendJson(res, 404, { error: 'Run not found' }); return; }

    if (testRun.status === 'running' || testRun.status === 'queued') {
      cancelledRuns.add(testRun.id);
      await testingRepo().updateTestRun(testRun.id, { status: 'cancelled', finished_at: now() });
    }

    const updated = (await testingRepo().getTestRunById(testRun.id)) as unknown as TestRun;
    sendJson(res, 200, { run: updated });
  });

  // GET /api/projects/:pid/tests/:tpid/runs/:rid/steps/:stepIdx/screenshot
  router.get('/api/projects/:pid/tests/:tpid/runs/:rid/steps/:stepIdx/screenshot', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const testRun = (await testingRepo().getTestRunByTestProjectAndId(tp.id, req.params.rid)) as unknown as TestRun | null;
    if (!testRun) { sendJson(res, 404, { error: 'Run not found' }); return; }

    const stepIdx = parseInt(req.params.stepIdx, 10);
    const stepRow = (await testingRepo().listStepsByRun(testRun.id)).find((x) => x.step_index === stepIdx);
    if (!stepRow?.screenshot_path) { sendJson(res, 404, { error: 'Screenshot not found' }); return; }

    const absPath = path.join(config.dataDir, String(stepRow.screenshot_path));
    if (!(await restoreFile(absPath))) { sendJson(res, 404, { error: 'Screenshot file not found on disk' }); return; }

    const stat = fs.statSync(absPath);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(absPath).pipe(res);
  });
}
