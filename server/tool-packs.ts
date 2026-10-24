/**
 * Optional tool-pack registry.
 *
 * Three packs are defined:
 *   'uv'      — Python / uvx runner, needed by the AWS integration and custom MCP servers.
 *   'kiro'    — Kiro CLI engine, needed by the Kiro provider.
 *   'browser' — Web browser MCP server, needed by the browser integration.
 *
 * Detection is injectable so tests need no real tools or network.
 *
 * Task 5 adds:
 *   POST /api/tools/:id/install  — admin-only background install job
 *   GET  /api/tools/:id/install  — read job state (for UI reload after restart)
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { get, post, openSse, HANDLED } from './http.ts';
import { getSettings } from './settings.ts';
import { dataPath } from './config.ts';
import { HttpError, newId, now } from './util.ts';
import { auditRaw } from './audit.ts';
import { publish, subscribe, projectChannel } from './events.ts';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PackStatus = 'available' | 'missing' | 'not configured';

export interface ToolPack {
  id: string;
  label: string;
  neededBy: string;
  status: PackStatus;
  reason: string;
  hint: string;
}

/* ------------------------------------------------------------------ */
/* Injected I/O (overridden in tests)                                  */
/* ------------------------------------------------------------------ */

export type CommandRunner = (cmd: string, args: string[]) => Promise<{ ok: boolean; output: string }>;
export type HttpProbe = (url: string) => Promise<{ ok: boolean }>;

/**
 * Downloader injectable for tests.
 * download(url, dest) must write to dest and resolve when done, or reject on error.
 * The default implementation uses Node's fetch + fs streams.
 */
export type Downloader = (url: string, dest: string) => Promise<void>;

/**
 * Shell command runner injectable for tests (used by install job for running the kiro installer).
 * shellRun(cmd, args, env) must return { ok, output }.
 */
export type ShellRunner = (cmd: string, args: string[], env: Record<string, string>) => Promise<{ ok: boolean; output: string }>;

const defaultRunner: CommandRunner = async (cmd, args) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  try {
    const r = await exec(cmd, args, { timeout: 5000 });
    return { ok: true, output: r.stdout.toString() };
  } catch (e: any) {
    return { ok: false, output: String(e?.stderr ?? e?.message ?? '') };
  }
};

const defaultProbe: HttpProbe = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { ok: r.ok || r.status < 500 };
  } catch {
    return { ok: false };
  }
};

const defaultDownloader: Downloader = async (url, dest) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buf));
};

const defaultShellRunner: ShellRunner = async (cmd, args, env) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  try {
    const r = await exec(cmd, args, { env, timeout: 300_000, maxBuffer: 5 * 1024 * 1024 });
    return { ok: true, output: r.stdout.toString() + r.stderr.toString() };
  } catch (e: any) {
    return { ok: false, output: String(e?.stderr ?? e?.stdout ?? e?.message ?? '') };
  }
};

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 60_000; // 1 minute — positive results only
const NEGATIVE_TTL_MS = 5_000; // 5 s — negative/not-configured results expire quickly

interface CacheEntry {
  packs: ToolPack[];
  at: number;
  allPositive: boolean; // true when every pack status is 'available' or 'not configured' (no misses)
}

let cache: CacheEntry | null = null;

/** Force the next call to re-detect all packs (e.g. after installing a tool). */
export function clearPackCache(): void {
  cache = null;
}

/* ------------------------------------------------------------------ */
/* Detection helpers                                                   */
/* ------------------------------------------------------------------ */

async function detectUv(run: CommandRunner): Promise<{ status: PackStatus; reason: string }> {
  const r = await run('uvx', ['--version']);
  if (r.ok) return { status: 'available', reason: `uvx found (${r.output.trim().split('\n')[0]})` };
  return { status: 'missing', reason: 'uvx not found on PATH' };
}

async function detectKiro(run: CommandRunner, kiroCmd?: string): Promise<{ status: PackStatus; reason: string }> {
  // Honour the custom kiro-cli command from Settings if configured, or the injected override.
  let cmd = kiroCmd;
  if (cmd === undefined) {
    try {
      const s = getSettings();
      cmd = s.kiro?.command?.trim() || 'kiro-cli';
    } catch {
      cmd = 'kiro-cli';
    }
  }
  const r = await run(cmd, ['--version']);
  if (r.ok) return { status: 'available', reason: `kiro-cli found (${r.output.trim().split('\n')[0]})` };
  return { status: 'missing', reason: `kiro-cli not found (tried: ${cmd})` };
}

async function detectBrowser(probe: HttpProbe): Promise<{ status: PackStatus; reason: string }> {
  const url = process.env.PORTAL_BROWSER_MCP_URL;
  if (!url) return { status: 'not configured', reason: 'PORTAL_BROWSER_MCP_URL is not set' };
  const r = await probe(url);
  if (r.ok) return { status: 'available', reason: `browser MCP reachable at ${url}` };
  return { status: 'missing', reason: `browser MCP URL set but not reachable: ${url}` };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Return the current status of all optional tool packs.
 * Results are cached for CACHE_TTL_MS milliseconds.
 */
export async function getToolPacks(
  run: CommandRunner = defaultRunner,
  probe: HttpProbe = defaultProbe,
): Promise<ToolPack[]> {
  if (cache) {
    const ttl = cache.allPositive ? CACHE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - cache.at < ttl) {
      return cache.packs;
    }
  }

  const [uv, kiro, browser] = await Promise.all([
    detectUv(run),
    detectKiro(run),
    detectBrowser(probe),
  ]);

  const packs: ToolPack[] = [
    {
      id: 'uv',
      label: 'uv / uvx',
      neededBy: 'AWS integration, custom MCP servers that use uvx',
      status: uv.status,
      reason: uv.reason,
      hint: 'An admin can install uv under Settings › Tools',
    },
    {
      id: 'kiro',
      label: 'Kiro CLI',
      neededBy: 'Kiro engine (Settings › Model provider › Kiro)',
      status: kiro.status,
      reason: kiro.reason,
      hint: 'An admin can install kiro-cli under Settings › Tools',
    },
    {
      id: 'browser',
      label: 'Browser MCP',
      neededBy: 'Web browser integration',
      status: browser.status,
      reason: browser.reason,
      hint: 'Run: docker compose --profile browser up -d',
    },
  ];

  const allPositive = packs.every((p) => p.status !== 'missing');
  cache = { packs, at: Date.now(), allPositive };
  return packs;
}

/**
 * Return the hint text for a specific pack id, or a generic fallback.
 * Used by session start checks to return a 400 with a helpful message.
 */
export async function packHint(packId: string): Promise<string> {
  const packs = await getToolPacks();
  return packs.find((p) => p.id === packId)?.hint ?? `The "${packId}" pack is not available`;
}

/* ------------------------------------------------------------------ */
/* Install jobs (Task 5)                                               */
/* ------------------------------------------------------------------ */

export type InstallStatus = 'pending' | 'running' | 'done' | 'failed';

export interface InstallJob {
  id: string;
  packId: string;
  status: InstallStatus;
  log: string[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

/** One active job per pack id at most. */
const installJobs = new Map<string, InstallJob>();

/** Return the current install job for a pack, or null. */
export function getInstallJob(packId: string): InstallJob | null {
  return installJobs.get(packId) ?? null;
}

/**
 * Pinned uv release version. Update deliberately when a new version has been
 * vetted against the portal and its SHA-256 checksums are known.
 */
const UV_VERSION = '0.7.4';

/**
 * SHA-256 checksums for the two Linux uv tarballs we download.
 * Format:  '<arch>': '<hex-sha256>'
 * Source:  https://github.com/astral-sh/uv/releases/download/0.7.4/uv-<arch>-unknown-linux-gnu.tar.gz.sha256
 * These are the verified checksums for uv 0.7.4 fetched from the official release.
 */
const UV_SHA256: Record<string, string> = {
  'x86_64': '5264d9b2bf021fccbaf6edb97bc17ce4863687745f2443460a8ca71e55891614',
  'aarch64': 'c407e4c7431ee6cb28deb842edb49fea1ee3f5674a357f11244bfb0fd57e2ae4',
};

/**
 * Install uv into /data/tools/bin.
 * Downloads a pinned release tarball for the container architecture,
 * verifies SHA-256, extracts the `uv` and `uvx` binaries.
 */
async function installUv(
  job: InstallJob,
  downloader: Downloader,
): Promise<void> {
  const toolsBin = dataPath('tools', 'bin');
  fs.mkdirSync(toolsBin, { recursive: true });

  // Detect container arch.
  const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64';
  const tarName = `uv-${arch}-unknown-linux-gnu.tar.gz`;
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${tarName}`;
  const expectedSha = UV_SHA256[arch];

  addLog(job, `Downloading uv ${UV_VERSION} for ${arch}…`);
  addLog(job, `URL: ${url}`);

  // Use a temp directory inside /data/tools so it's on the same filesystem (atomic rename).
  const tmpDir = fs.mkdtempSync(path.join(toolsBin, '.uv-install-'));
  const tarPath = path.join(tmpDir, tarName);

  try {
    await downloader(url, tarPath);

    // Verify SHA-256.
    addLog(job, 'Verifying checksum…');
    const actual = sha256File(tarPath);
    if (!expectedSha) {
      throw new Error(`No pinned checksum for architecture "${arch}". Cannot verify download integrity. Update UV_SHA256 in tool-packs.ts with the correct digest from https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${arch}-unknown-linux-gnu.tar.gz.sha256`);
    }
    if (actual !== expectedSha) {
      throw new Error(`SHA-256 mismatch: expected ${expectedSha}, got ${actual}`);
    }

    // Extract using Node's built-in tar (node:child_process with system tar).
    addLog(job, 'Extracting…');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('tar', ['-xzf', tarPath, '-C', tmpDir, '--strip-components=1'], { timeout: 60_000 });

    // Move binaries into place atomically.
    for (const bin of ['uv', 'uvx']) {
      const src = path.join(tmpDir, bin);
      const dst = path.join(toolsBin, bin);
      if (fs.existsSync(src)) {
        fs.chmodSync(src, 0o755);
        fs.renameSync(src, dst);
        addLog(job, `Installed: ${dst}`);
      }
    }

    // Read installed version.
    try {
      const { execFile: ef2 } = await import('node:child_process');
      const { promisify: p2 } = await import('node:util');
      const r = await p2(ef2)(path.join(toolsBin, 'uv'), ['--version'], { timeout: 5000 });
      addLog(job, `Installed: ${r.stdout.trim()}`);
    } catch { /* version read is best-effort */ }
  } finally {
    // Always clean up temp dir.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Install kiro-cli.
 * The official Kiro CLI does not publish a standalone binary with a verifiable checksum;
 * its canonical install method is the installer script at https://cli.kiro.dev/install.
 * Kiro does not publish a signed checksum or versioned release URL for this script.
 *
 * Security path taken (as noted in the review):
 *   - Download the installer to a temp file (never pipe straight to bash).
 *   - Compute its SHA-256 and record it in both the audit log and the job log so any
 *     change to the installer is observable after the fact.
 *   - Run that file, not a pipe.
 * This is the best we can do without a published checksum from the Kiro team.
 * If Kiro publishes verifiable checksums in future, add them here in the same style
 * as UV_SHA256 above.
 */
async function installKiro(
  job: InstallJob,
  downloader: Downloader,
  shellRunner: ShellRunner,
): Promise<void> {
  const homeDir = dataPath('home');
  const binDir = dataPath('home', '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  // Download the installer script to a temp file (do NOT pipe to bash).
  addLog(job, 'Downloading Kiro CLI installer to temp file…');
  const tmpDir = fs.mkdtempSync(path.join(homeDir, '.kiro-install-'));
  const installerPath = path.join(tmpDir, 'install.sh');

  try {
    await downloader('https://cli.kiro.dev/install', installerPath);
    fs.chmodSync(installerPath, 0o755);

    // Record the SHA-256 of the downloaded installer so it is auditable.
    const installerSha = sha256File(installerPath);
    addLog(job, `Installer SHA-256: ${installerSha} (Kiro does not publish a reference checksum; record this for audit purposes)`);
    // Also emit to audit log so admins can track installer changes across installs.
    auditRaw(null, 'tool.install.installer_sha256', `pack:kiro`, { packId: 'kiro', sha256: installerSha, url: 'https://cli.kiro.dev/install' }, null);

    // Run the installer with HOME set to our data home so it installs there,
    // and PATH extended with the bin dirs.
    addLog(job, 'Running kiro-cli installer (HOME=/data/home)…');
    const env: Record<string, string> = {
      HOME: homeDir,
      PATH: `${dataPath('tools', 'bin')}:${binDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      // Disable any interactive UI.
      CI: '1',
      KIRO_SKIP_BINARY_PINNING: '0',
    };
    // Preserve proxy settings if present.
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
      if (process.env[k]) env[k] = process.env[k]!;
    }

    const r = await shellRunner('bash', [installerPath], env);
    if (r.output) addLog(job, r.output.slice(-2000));
    if (!r.ok) throw new Error('kiro-cli installer exited with a non-zero code');

    // Verify kiro-cli is now on PATH in its installed location.
    const kiroPath = path.join(binDir, 'kiro-cli');
    if (!fs.existsSync(kiroPath)) {
      // Check the tools/bin dir too.
      const alt = dataPath('tools', 'bin', 'kiro-cli');
      if (!fs.existsSync(alt)) throw new Error('kiro-cli not found after install — check installer output above');
      addLog(job, `kiro-cli found at ${alt}`);
    } else {
      addLog(job, `kiro-cli found at ${kiroPath}`);
    }

    // Record installed version.
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const cmd = fs.existsSync(kiroPath) ? kiroPath : dataPath('tools', 'bin', 'kiro-cli');
      const rv = await promisify(execFile)(cmd, ['--version'], { timeout: 5000, env });
      addLog(job, `Installed: ${rv.stdout.trim()}`);
    } catch { /* version read is best-effort */ }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function sha256File(filePath: string): string {
  const h = createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

function addLog(job: InstallJob, line: string): void {
  job.log.push(line);
  // Emit progress SSE on a portal-wide channel that the UI can subscribe to.
  // We use the run channel with a special prefix so it reaches open SSE connections.
  try {
    // Publish on the global install channel so any connected admin can see progress.
    publish('portal:installs', 'tool.install.progress', { packId: job.packId, jobId: job.id, line });
  } catch { /* non-fatal */ }
}

/** Internal: run an install job in the background. */
async function runInstallJob(
  job: InstallJob,
  downloader: Downloader,
  shellRunner: ShellRunner,
  actorId: string | null,
  actorIp: string | null,
): Promise<void> {
  job.status = 'running';
  job.startedAt = now();
  addLog(job, `Starting install of ${job.packId}…`);

  try {
    if (job.packId === 'uv') {
      await installUv(job, downloader);
    } else if (job.packId === 'kiro') {
      await installKiro(job, downloader, shellRunner);
    } else {
      throw new Error(`Unknown pack id: ${job.packId}`);
    }

    job.status = 'done';
    job.finishedAt = now();
    addLog(job, `Install complete.`);
    auditRaw(actorId, 'tool.install', `pack:${job.packId}`, { packId: job.packId, status: 'done' }, actorIp);
  } catch (e: any) {
    job.status = 'failed';
    job.finishedAt = now();
    job.error = String(e?.message ?? e).slice(0, 500);
    addLog(job, `Error: ${job.error}`);
    auditRaw(actorId, 'tool.install', `pack:${job.packId}`, { packId: job.packId, status: 'failed', error: job.error }, actorIp);
  } finally {
    clearPackCache();
    // Emit final status.
    publish('portal:installs', 'tool.install.done', { packId: job.packId, jobId: job.id, status: job.status, error: job.error });
  }
}

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

/** Admin-only message returned for non-admin users. */
export const NON_ADMIN_INSTALL_MESSAGE = 'Ask an admin to install this under Settings \u203a Tools.';

export function registerToolRoutes(
  downloader: Downloader = defaultDownloader,
  shellRunner: ShellRunner = defaultShellRunner,
): void {
  /** Any signed-in user can check which optional tools are available. */
  get('/api/tool-packs', async (_ctx) => {
    const packs = await getToolPacks();
    // Also expose the built-in browser integration ID so the frontend never hardcodes it.
    const { BUILTIN_BROWSER_ID } = await import('./integrations.ts');
    return { packs, builtinBrowserId: BUILTIN_BROWSER_ID };
  });

  /**
   * POST /api/tools/:id/install
   * Admin only. Starts a background install job for uv or kiro.
   * Returns 403 for non-admins with the exact message required by the spec.
   * Returns 409 if a job is already running for that pack.
   */
  post('/api/tools/:id/install', async (ctx) => {
    const packId = ctx.params.id;
    if (packId !== 'uv' && packId !== 'kiro') {
      throw new HttpError(404, `Unknown pack "${packId}". Valid ids: uv, kiro`);
    }
    if (!ctx.user?.is_admin) {
      throw new HttpError(403, NON_ADMIN_INSTALL_MESSAGE);
    }

    const existing = installJobs.get(packId);
    if (existing && (existing.status === 'pending' || existing.status === 'running')) {
      throw new HttpError(409, `An install of "${packId}" is already in progress`);
    }

    const job: InstallJob = {
      id: newId('job_'),
      packId,
      status: 'pending',
      log: [],
      startedAt: now(),
      finishedAt: null,
      error: null,
    };
    installJobs.set(packId, job);

    // Start in background — do not await.
    const actorId = ctx.user.id;
    const actorIp = ctx.ip;
    setImmediate(() => {
      runInstallJob(job, downloader, shellRunner, actorId, actorIp).catch((e) => {
        console.error('[tool-install]', e);
      });
    });

    return { job: jobView(job) };
  }, { auth: 'user' });

  /**
   * GET /api/tools/:id/install
   * Returns the current install job state (for UI reload after restart).
   * Auth: any signed-in user.
   */
  get('/api/tools/:id/install', (ctx) => {
    const packId = ctx.params.id;
    if (packId !== 'uv' && packId !== 'kiro') {
      throw new HttpError(404, `Unknown pack "${packId}". Valid ids: uv, kiro`);
    }
    const job = installJobs.get(packId);
    return { job: job ? jobView(job) : null };
  });

  /**
   * GET /api/tools/stream
   * Server-sent events for install progress. Any signed-in user may listen.
   * Events:
   *   tool.install.progress  – { packId, jobId, line }
   *   tool.install.done      – { packId, jobId, status, error }
   */
  get('/api/tools/stream', (ctx) => {
    const sse = openSse(ctx);
    sse.onClose(subscribe('portal:installs', (event, data) => sse.send(event, data)));
    return HANDLED;
  });
}

function jobView(job: InstallJob) {
  return {
    id: job.id,
    packId: job.packId,
    status: job.status,
    log: job.log,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
  };
}
