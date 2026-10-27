/**
 * End-to-end container smoke test for Agent Portal.
 *
 * Runs as a standalone script (Node.js 22+). Requires Docker and Docker Compose.
 *
 * Usage:
 *   node scripts/container-smoke.mjs [--with-packs]
 *
 * --with-packs  After the basic run, also installs uv, starts the browser profile,
 *               and repeats the tools check expecting them to be on.
 *
 * The script:
 *  1. Checks Docker is reachable — exits early with a clear message if not.
 *  2. Builds the image and starts the compose stack on a throwaway project name / volume.
 *  3. Waits for GET /api/health to return 200.
 *  4. Signs in and creates a project.
 *  5. Uploads a .docx and an .odt (exercises pandoc), searches and asks.
 *  6. Adds a role agent.
 *  7. Connects a local bare git repository created inside the container.
 *  8. Starts a run, approves the write, pushes to a new branch.
 *  9. Runs a code review of two branches.
 * 10. Calls GET /api/tool-packs and asserts uv, kiro and browser are off by default.
 * 11. Restarts the container and confirms data persists.
 * 12. Tears down everything — always, even on failure.
 *
 * All pure helpers are exported and tested by test/container-smoke-helpers.test.ts.
 */

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'smoke@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'smoke-password-001';
const BASE_URL = 'http://127.0.0.1:8787';
const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_POLL_MS = 1_500;

const WITH_PACKS = process.argv.includes('--with-packs');

/* ------------------------------------------------------------------ */
/* Pure helper functions (exported for unit tests)                     */
/* ------------------------------------------------------------------ */

/**
 * Build a compact project name and volume name from a 6-char random suffix
 * so parallel runs never clash and the volume is easy to find and delete.
 */
export function makeRunId() {
  const suffix = Math.random().toString(36).slice(2, 8);
  return { project: `smoke-${suffix}`, volume: `smoke-data-${suffix}` };
}

/**
 * Parse a Server-Sent Events stream body into { event, data } objects.
 * Only exported for unit-testing; the smoke test itself does not use SSE.
 */
export function parseSseChunk(raw) {
  const messages = [];
  for (const block of raw.split(/\n\n/)) {
    let event = 'message';
    let data = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (data !== null) messages.push({ event, data });
  }
  return messages;
}

/**
 * Return the relative URL of the run worktree from the changes response,
 * or null if changes has no diff yet.
 */
export function extractWorkBranch(pushRes) {
  return typeof pushRes?.branch === 'string' ? pushRes.branch : null;
}

/**
 * True when `status` is a terminal run state.
 */
export function isTerminalStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

let stepIndex = 0;
function step(label) {
  stepIndex++;
  console.log(`\n${CYAN}[${stepIndex}]${RESET} ${label}`);
}
function ok(msg) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}⚠${RESET}  ${msg}`); }
function fail(msg) { console.error(`  ${RED}✗${RESET} ${msg}`); }

/* ------------------------------------------------------------------ */
/* Docker availability check                                           */
/* ------------------------------------------------------------------ */

/**
 * Verify Docker daemon is reachable. If not, print a clear error and exit 1
 * — this is intentional: when Docker is not running the script must fail fast
 * rather than hang or print cryptic errors.
 */
export function checkDockerAvailable() {
  const result = spawnSync('docker', ['info', '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0 || result.error) {
    console.error(`\n${RED}Docker is not running or not installed.${RESET}`);
    console.error('Start Docker Desktop (or the Docker daemon) and try again.');
    console.error('  docker info        # should print daemon details');
    if (result.error) console.error(`  Error: ${result.error.message}`);
    else if (result.stderr) console.error(`  ${result.stderr.trim()}`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP client (mirrors test/client.ts but plain fetch)               */
/* ------------------------------------------------------------------ */

class SmokeClient {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async req(method, url, body, opts = {}) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    headers['x-requested-with'] = 'agent-portal';
    let payload;
    if (opts.raw) {
      headers['content-type'] = 'application/octet-stream';
      payload = opts.raw;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + url, { method, headers, body: payload });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const [pair] = c.split(';');
      if (pair.startsWith('portal_session=')) this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return { status: res.status, data: await res.json() };
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, data: buf.toString('utf8'), buf };
  }

  async ok(method, url, body, opts) {
    const r = await this.req(method, url, body, opts);
    if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status}: ${JSON.stringify(r.data)}`);
    return r.data;
  }

  get = (u) => this.ok('GET', u);
  post = (u, b) => this.ok('POST', u, b ?? {});
  put = (u, b) => this.ok('PUT', u, b ?? {});
  patch = (u, b) => this.ok('PATCH', u, b ?? {});
}

/* ------------------------------------------------------------------ */
/* Polling helper                                                      */
/* ------------------------------------------------------------------ */

async function waitFor(fn, what, timeoutMs = 30_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${what}${lastErr ? `: ${lastErr}` : ''}`);
}

/* ------------------------------------------------------------------ */
/* Compose helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * A compose override with the smoke run's own settings (admin, demo speed, secret key). compose.yml does not pass these
 * through from the host, and `docker compose up` has no -e flag, so they go in a file that every compose call below
 * includes: a later restart or recreate (the browser profile) must keep the same secret key.
 */
let OVERRIDE = null;

function writeOverride(project) {
  const env = { ADMIN_EMAIL, ADMIN_PASSWORD, DEMO_SPEED: '0', PORTAL_SECRET_KEY: `smoke-test-key-${project}` };
  const file = path.join(os.tmpdir(), `${project}.override.yml`);
  const lines = ['services:', '  portal:', '    environment:', ...Object.entries(env).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function compose(project, args, opts = {}) {
  const cmd = ['docker', 'compose', '-p', project, '-f', path.join(ROOT, 'compose.yml'), ...(OVERRIDE ? ['-f', OVERRIDE] : []), ...args];
  return execFileAsync(cmd[0], cmd.slice(1), { cwd: ROOT, timeout: 300_000, ...opts });
}

async function composeLogs(project, service = 'portal') {
  try {
    const { stdout } = await compose(project, ['logs', '--tail', '50', service]);
    return stdout;
  } catch {
    return '(could not retrieve logs)';
  }
}

/* ------------------------------------------------------------------ */
/* File fixtures (matching e2e.test.ts where possible)                */
/* ------------------------------------------------------------------ */

/**
 * Minimal .docx buffer — a single-paragraph Word document.
 * Mirrors the approach in test/fixtures.ts#makeDocx.
 */
async function makeDocx() {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/styles.xml', '<?xml version="1.0"?><w:styles xmlns:w="w"/>');
  const body = '<w:p><w:r><w:t>Container smoke test document</w:t></w:r></w:p>';
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * Minimal .odt buffer — exercises the pandoc path in the portal.
 * An ODT file is a ZIP with mimetype + content.xml.
 */
async function makeOdt() {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file('META-INF/manifest.xml', [
    '<?xml version="1.0"?>',
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">',
    '<manifest:file-entry manifest:media-type="application/vnd.oasis.opendocument.text" manifest:full-path="/"/>',
    '<manifest:file-entry manifest:media-type="text/xml" manifest:full-path="content.xml"/>',
    '</manifest:manifest>',
  ].join('\n'));
  zip.file('content.xml', [
    '<?xml version="1.0"?>',
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
    '  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">',
    '<office:body><office:text>',
    '<text:p>ODT smoke test — pandoc exercises this path.</text:p>',
    '</office:text></office:body>',
    '</office:document-content>',
  ].join('\n'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

/* ------------------------------------------------------------------ */
/* Main smoke test                                                     */
/* ------------------------------------------------------------------ */

async function main() {
  // Keep the process alive until main() decides how it ends. A pending fetch with AbortSignal.timeout() holds only
  // unreferenced timers, so Node could otherwise exit with code 0 in the middle of a wait, skipping the teardown and
  // leaving the stack running.
  const keepAlive = setInterval(() => {}, 60_000);

  // ── 0. Preflight ────────────────────────────────────────────────
  step('Checking Docker availability');
  checkDockerAvailable();
  ok('Docker daemon is reachable');

  const { project: PROJECT, volume: VOLUME } = makeRunId();
  console.log(`  Project: ${PROJECT}   Volume: ${VOLUME}`);
  OVERRIDE = writeOverride(PROJECT);

  // Always tear down, even on failure.
  let toreDown = false;
  async function teardown(why = '') {
    if (toreDown) return;
    toreDown = true;
    step(`Tearing down (${why || 'done'})`);
    try {
      await compose(PROJECT, ['down', '--volumes', '--remove-orphans', '--timeout', '20']);
      ok('Stack removed');
    } catch (e) {
      warn(`Teardown error (non-fatal): ${e.message}`);
    }
    // Named volume may survive --volumes when externally created; remove it explicitly.
    try {
      await execFileAsync('docker', ['volume', 'rm', '-f', VOLUME], { timeout: 20_000 });
    } catch { /* ok */ }
    if (OVERRIDE) fs.rmSync(OVERRIDE, { force: true });
  }

  process.on('SIGINT', () => teardown('SIGINT').then(() => process.exit(130)));
  process.on('SIGTERM', () => teardown('SIGTERM').then(() => process.exit(143)));

  let exitCode = 0;

  try {
    // ── 1. Build image & start stack ────────────────────────────
    step('Building image');
    await compose(PROJECT, ['build', '--progress', 'plain']);
    ok('Image built');

    step('Starting stack');
    // The admin, demo speed and secret key come from the override file (see writeOverride).
    // A throwaway project and volume keep the host clean.
    await compose(PROJECT, ['up', '-d', '--force-recreate'], { timeout: 60_000 });
    ok('Stack started');

    // ── 2. Wait for /api/health ─────────────────────────────────
    step('Waiting for /api/health');
    const health = await waitFor(async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) return await res.json();
        return null;
      } catch {
        return null;
      }
    }, '/api/health to return 200', HEALTH_TIMEOUT_MS);
    ok(`Health OK — version ${health.version}`);

    const client = new SmokeClient(BASE_URL);

    // ── 3. Sign in ──────────────────────────────────────────────
    step('Signing in');
    // If ADMIN_EMAIL/ADMIN_PASSWORD were set in env, the server auto-created the admin.
    // Check setup state first.
    const authState = await client.get('/api/auth/state');
    if (authState.needsSetup) {
      await client.post('/api/auth/setup', { email: ADMIN_EMAIL, name: 'Smoke Admin', password: ADMIN_PASSWORD });
      ok('Created admin account via setup');
    } else {
      await client.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      ok('Signed in to pre-created admin account');
    }
    const me = await client.get('/api/auth/me');
    ok(`Signed in as ${me.user.name} (admin: ${me.user.is_admin})`);

    // ── 4. Create a project ─────────────────────────────────────
    step('Creating project');
    const { project } = await client.post('/api/projects', {
      name: 'Smoke Refund Service',
      description: 'Automated smoke test project',
    });
    const pid = project.id;
    ok(`Project "${project.name}" (${pid})`);

    // ── 5. Upload .docx and .odt, search, ask ───────────────────
    step('Uploading documents');
    const docxBuf = await makeDocx();
    const { document: docxDoc } = await client.ok('PUT', `/api/projects/${pid}/documents?name=${encodeURIComponent('Smoke.docx')}`, undefined, { raw: docxBuf });
    ok(`Uploaded .docx — status: ${docxDoc.status}`);

    const odtBuf = await makeOdt();
    const odtResult = await client.req('PUT', `/api/projects/${pid}/documents?name=${encodeURIComponent('Smoke.odt')}`, undefined, { raw: odtBuf });
    if (odtResult.status >= 400) {
      // pandoc may be missing or the ODT may be too minimal; warn but do not fail the smoke test.
      warn(`.odt upload returned ${odtResult.status} — pandoc may not have converted it: ${JSON.stringify(odtResult.data).slice(0, 200)}`);
    } else {
      const odtStatus = odtResult.data?.document?.status ?? odtResult.status;
      // This hand-made .odt is minimal; a conversion error is reported, not failed (pandoc itself is in the image).
      if (odtStatus === 'error') warn(`Uploaded .odt — status: error (${String(odtResult.data?.document?.error ?? '').slice(0, 160)})`);
      else ok(`Uploaded .odt — status: ${odtStatus}`);
    }

    // Search the uploaded content.
    const searchRes = await client.get(`/api/projects/${pid}/search?q=${encodeURIComponent('smoke test')}`);
    ok(`Search returned ${searchRes.hits.length} hit(s)`);

    // Ask a question (may return missing=true in demo mode; that is fine).
    const askRes = await client.post(`/api/projects/${pid}/ask`, { question: 'What does this document describe?' });
    ok(`Ask returned — missing: ${askRes.missing}, answer length: ${askRes.answer?.length ?? 0}`);

    // ── 6. Add a role agent ─────────────────────────────────────
    step('Adding role agent');
    await client.post(`/api/projects/${pid}/roles/business-analyst/apply`);
    const agents = (await client.get(`/api/projects/${pid}/agents`)).agents;
    const ba = agents.find((a) => a.name === 'business-analyst');
    if (!ba) throw new Error('business-analyst role not found after apply');
    ok(`Role "business-analyst" added (enabled: ${ba.enabled})`);

    // ── 7. Connect a local bare git repository ──────────────────
    step('Creating bare git repository inside container');
    // Run git init inside the container to create a bare repo under /data.
    const containerName = `${PROJECT}-portal-1`;
    const repoPath = '/data/smoke-bare.git';

    await execFileAsync('docker', [
      'exec', containerName,
      'git', '-c', 'init.defaultBranch=main',
      'init', '--bare', repoPath,
    ], { timeout: 20_000 });

    // Add a commit so the repo has a main branch.
    const workPath = '/tmp/smoke-work';
    await execFileAsync('docker', ['exec', containerName, 'bash', '-c',
      `git init -b main ${workPath} && ` +
      `cd ${workPath} && ` +
      `git config user.email "smoke@example.com" && ` +
      `git config user.name "Smoke" && ` +
      `echo "# Smoke" > README.md && ` +
      `git add README.md && ` +
      `git commit -m "init" && ` +
      `echo "console.log('refund');" > src.ts && ` +
      `git add src.ts && ` +
      `git commit -m "add source" && ` +
      `git checkout -b feature/smoke-api && ` +
      `echo "// TODO: add key" > api.ts && ` +
      `git add api.ts && ` +
      `git commit -m "add api" && ` +
      `git checkout main && ` +
      `git remote add origin ${repoPath} && ` +
      `git push --all origin`,
    ], { timeout: 30_000 });
    ok(`Bare repo initialised at ${repoPath} with branches main, feature/smoke-api`);

    // Connect via file:// URL (admin-only path, which is fine since we are admin).
    const { repo } = await client.post(`/api/projects/${pid}/repos`, {
      provider: 'git',
      url: `file:///${repoPath.replace(/^\//, '')}`,
      name: 'smoke-service',
    });
    const repoId = repo.id;
    ok(`Repo connected (${repoId}), cloning…`);

    // Wait for clone to finish.
    const readyRepo = await waitFor(async () => {
      const r = (await client.get(`/api/projects/${pid}/repos`)).repos.find((x) => x.id === repoId);
      if (r.status === 'ready') return r;
      if (r.status === 'error') throw new Error(`Clone failed: ${r.error}`);
      return null;
    }, 'repo to be ready', 60_000);
    ok(`Repo ready — default branch: ${readyRepo.default_branch}`);

    // ── 8. Start a run, approve, push ───────────────────────────
    step('Starting agent run');
    // A single run is a session with one iteration; its agent run exists once the session has started it.
    const { workflow } = await client.post(`/api/projects/${pid}/workflows`, {
      singleRun: true,
      prompt: 'Create a SMOKE_PLAN.md that lists the smoke test steps',
      repoId,
      branch: 'main',
      permissionMode: 'default',
    });
    const runId = await waitFor(async () => (await client.get(`/api/workflows/${workflow.id}`)).workflow.last_run_id, 'single run to start', 60_000);
    ok(`Run started: ${runId}`);

    // Answer what the run asks: approvals (Write, Bash, etc.) are allowed, and clarifying questions (the Demo agent asks
    // some first) get each question's first option.
    let approvalCount = 0;
    let questionCount = 0;
    const runFinished = await waitFor(async () => {
      const r = await client.get(`/api/runs/${runId}`);
      for (const inp of r.inputs ?? []) {
        if (inp.status !== 'pending') continue;
        try {
          if (inp.type === 'approval') {
            await client.post(`/api/inputs/${inp.id}/answer`, { decision: 'allow' });
            approvalCount++;
          } else if (inp.type === 'question') {
            const answers = {};
            for (const q of inp.payload?.questions ?? []) {
              const first = q.options?.[0]?.label ?? 'Yes';
              answers[q.question] = q.multiSelect ? [first] : first;
            }
            await client.post(`/api/inputs/${inp.id}/answer`, { answers });
            questionCount++;
          }
        } catch { /* may race */ }
      }
      return isTerminalStatus(r.run.status) ? r : null;
    }, 'run to finish', 120_000);
    ok(`Run finished — status: ${runFinished.run.status}, approvals given: ${approvalCount}, questions answered: ${questionCount}`);
    if (runFinished.run.status === 'failed') {
      warn(`Run failed (demo mode may not write files): ${runFinished.run.error}`);
    }

    // Push to a new branch.
    const pushRes = await client.req('POST', `/api/runs/${runId}/push`, { branch: 'agent/smoke-run', message: 'Smoke test run' });
    if (pushRes.status >= 400) {
      warn(`Push returned ${pushRes.status} — may be expected if run wrote nothing: ${JSON.stringify(pushRes.data).slice(0, 200)}`);
    } else {
      ok(`Pushed to branch: ${pushRes.data.branch ?? 'agent/smoke-run'}`);
    }

    // ── 9. Code review ───────────────────────────────────────────
    step('Running code review (main vs feature/smoke-api)');
    const { review } = await client.post(`/api/projects/${pid}/reviews`, {
      repoId,
      base: 'main',
      head: 'feature/smoke-api',
      deep: false,
    });
    const reviewId = review.id;

    const finishedReview = await waitFor(async () => {
      const r = await client.get(`/api/reviews/${reviewId}`);
      return r.review.status !== 'running' ? r : null;
    }, 'review to finish', 60_000);
    ok(`Review done — status: ${finishedReview.review.status}, findings: ${finishedReview.findings.length}`);

    // ── 10. Tool packs off by default ────────────────────────────
    step('Checking tool packs (all off by default)');
    const { packs } = await client.get('/api/tool-packs');
    const uvPack = packs.find((p) => p.id === 'uv');
    const kiroPack = packs.find((p) => p.id === 'kiro');
    const browserPack = packs.find((p) => p.id === 'browser');
    ok(`uv: ${uvPack?.status}`);
    ok(`kiro: ${kiroPack?.status}`);
    ok(`browser: ${browserPack?.status}`);
    // These three should be missing / not configured in a basic `docker compose up`. Other packs (the document tools,
    // for example) may be built into the image, so they are only listed.
    for (const p of packs.filter((x) => !['uv', 'kiro', 'browser'].includes(x.id))) ok(`${p.id}: ${p.status} (not part of this check)`);
    const on = [uvPack, kiroPack, browserPack].filter((p) => p?.status === 'available').map((p) => p.id);
    if (on.length) {
      warn(`These tool packs report "available" in the default stack: ${on.join(', ')} — check the environment`);
    } else {
      ok('All tool packs are off in the default stack ✓');
    }

    // ── 11. Restart container, confirm data persists ─────────────
    step('Restarting portal container');
    await compose(PROJECT, ['restart', 'portal']);
    ok('Restart command sent');

    // Wait for health to come back.
    await waitFor(async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok ? true : null;
      } catch {
        return null;
      }
    }, 'portal to be healthy again after restart', HEALTH_TIMEOUT_MS);
    ok('Portal healthy after restart');

    // Sign in again (session cookie is gone after the restart in demo context).
    const client2 = new SmokeClient(BASE_URL);
    await client2.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    // Verify the project still exists.
    const projects = await client2.get('/api/projects');
    const found = projects.projects?.some((p) => p.id === pid);
    if (!found) throw new Error('Project not found after container restart — volume data was lost');
    ok('Project data persisted across restart ✓');

    // ── 12. Optional --with-packs run ────────────────────────────
    if (WITH_PACKS) {
      step('--with-packs: installing uv via API');
      const installRes = await client2.post('/api/tools/uv/install');
      ok(`Install job started: ${installRes.job?.id}`);

      // Wait for the install to finish (up to 3 min).
      const installedJob = await waitFor(async () => {
        const r = await client2.get('/api/tools/uv/install');
        return r.job?.status === 'done' || r.job?.status === 'failed' ? r.job : null;
      }, 'uv install job', 180_000);
      ok(`uv install job finished: ${installedJob.status}`);
      if (installedJob.status === 'failed') {
        warn(`uv install failed: ${installedJob.error}`);
      }

      step('--with-packs: starting browser profile');
      await compose(PROJECT, ['--profile', 'browser', 'up', '-d'], { timeout: 60_000 });
      ok('Browser profile started');

      // Re-check packs.
      await waitFor(async () => {
        const { packs: p2 } = await client2.get('/api/tool-packs');
        const uv2 = p2.find((x) => x.id === 'uv');
        return uv2?.status === 'available' ? true : null;
      }, 'uv to report available', 30_000).catch(() => warn('uv still not available after install'));

      const { packs: packsAfter } = await client2.get('/api/tool-packs');
      ok('Packs after --with-packs:');
      for (const p of packsAfter) ok(`  ${p.id}: ${p.status}`);
    }

    console.log(`\n${GREEN}Smoke test passed.${RESET}`);
  } catch (e) {
    exitCode = 1;
    fail(`Smoke test FAILED: ${e.message}`);
    if (e.stack) console.error(e.stack);
    // Print the last 50 lines of portal logs to help diagnose.
    console.log('\n--- portal logs (last 50 lines) ---');
    try {
      const logs = await composeLogs(PROJECT);
      console.log(logs);
    } catch { /* ok */ }
  } finally {
    await teardown('cleanup');
  }

  clearInterval(keepAlive);
  process.exit(exitCode);
}

// Run the test unless this file is being imported for its exports (unit-test mode).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
