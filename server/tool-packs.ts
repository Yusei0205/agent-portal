/**
 * Tool-pack registry — detects availability of the six optional tool packs
 * and provides install routes for the three that can be installed via the UI.
 *
 * Packs:
 *   uv       — Python / uvx runner (AWS integration, custom MCP servers)
 *   kiro     — Kiro CLI engine
 *   browser  — Web browser MCP server
 *   drawio   — Icon diagrams (draw.io MCP + viewer files)
 *   docs     — Document libraries (pdfjs-dist, docx, exceljs, pptxgenjs)
 *   headroom — Headroom proxy for Anthropic API
 */

import { spawn } from 'node:child_process';
import type { SpawnOptions, ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usesDynamoDb } from './repositories/backend.ts';
import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { HttpError, generateId, now } from './util.ts';
import {
  hasPdfCapability,
  hasDocxCapability,
  hasExcelCapability,
  hasPptxCapability,
} from './docs-pack.ts';
import {
  packDir,
  mcpPrefix,
  mcpEntry,
  shapeIndexFile,
  manifestFile,
  rendererDir,
  DRAWIO_PIN,
  RENDERER_FILES,
  IMAGE_LIBS,
  type PackManifest,
  drawioPackState,
  ensureDrawioPackRestored,
  persistDrawioPack,
} from './drawio-pack.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolPack {
  id: string;
  name: string;
  description: string;
  status: 'available' | 'not-available' | 'installing' | 'error';
  /** Whether this pack can be installed via the Install button. */
  installable: boolean;
  /** How to enable when not installable. */
  detail?: string;
}

export type InstallStatus = 'pending' | 'running' | 'done' | 'failed';

export interface InstallJob {
  id: string;
  packId: string;
  status: InstallStatus;
  log: string[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** Subscribers waiting for new log lines (SSE connections). */
  subscribers: Set<(line: string) => void>;
}

// ── In-memory install job store ───────────────────────────────────────────────

const installJobs = new Map<string, InstallJob>();

function getInstallJob(packId: string): InstallJob | null {
  return installJobs.get(packId) ?? null;
}

// ── Spawn indirection (replaceable in tests) ──────────────────────────────────

type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
let _spawnImpl: SpawnFn = spawn as SpawnFn;

/**
 * Replace the spawn implementation used by all installers.
 * Pass null to restore the real spawn.
 * For use in tests only — do NOT call in production code.
 */
export function _setSpawnForTest(fn: SpawnFn | null): void {
  _spawnImpl = fn ?? (spawn as SpawnFn);
}

// ── Fetch indirection (replaceable in tests) ─────────────────────────────────

type FetchFn = typeof fetch;
let _fetchImpl: FetchFn = fetch;

/**
 * Replace the fetch implementation used by all HTTP downloaders.
 * Pass null to restore the real fetch.
 * For use in tests only — do NOT call in production code.
 */
export function _setFetchForTest(fn: FetchFn | null): void {
  _fetchImpl = fn ?? fetch;
}

// ── SHA-256 overrides (replaceable in tests) ──────────────────────────────────
//
// The production installer verifies downloads against the hashes pinned in
// DRAWIO_PIN / RENDERER_FILES.  Tests that need a "full success" path would
// otherwise have to produce content that pre-image-attacks those hashes.
// Instead, tests can supply their own fake content and override the expected
// hashes here so that downloadAndVerify() accepts the fake content.

let _testIndexSha256: string | null = null;
let _testRendererShas: Map<string, string> | null = null;

/**
 * Override the expected SHA-256 values used during draw.io installation.
 * indexSha overrides DRAWIO_PIN.indexSha256;
 * rendererShas is a map of { [fileName]: sha256 } overriding each renderer file's hash.
 * Pass null for either to clear the override.
 * For use in tests only.
 */
export function _setDrawioHashesForTest(
  indexSha: string | null,
  rendererShas: Record<string, string> | null,
): void {
  _testIndexSha256 = indexSha;
  _testRendererShas = rendererShas ? new Map(Object.entries(rendererShas)) : null;
}

function getIndexSha256(): string {
  return _testIndexSha256 ?? DRAWIO_PIN.indexSha256;
}

function getRendererFileSha256(fileName: string, defaultSha: string): string {
  return _testRendererShas?.get(fileName) ?? defaultSha;
}

// ── Platform helper (overrideable in tests) ───────────────────────────────────

let _platformOverride: string | null = null;

/**
 * Override the detected platform.
 * Pass null to restore the real platform.
 * For use in tests only.
 */
export function _setPlatformForTest(platform: string | null): void {
  _platformOverride = platform;
}

const currentPlatform = (): string => _platformOverride ?? process.platform;

// ── Detection helpers ─────────────────────────────────────────────────────────

/**
 * Resolve the actual executable and argument list for the current platform.
 *
 * On Windows:
 *  - 'powershell' → 'powershell.exe' directly (it is a real .exe, no wrapper needed).
 *  - All other commands → 'cmd.exe' /d /c <cmd>.cmd [args...]
 *    .cmd scripts cannot be spawned directly with shell:false on current Node versions
 *    (EINVAL); cmd.exe /d /c is the safe wrapper.  /d disables AutoRun registry entries
 *    which prevents injection through the registry.  All arguments are fixed strings from
 *    the installer, never user-supplied input.
 *  - Commands already ending in .cmd or .exe are used as-is inside the cmd.exe wrapper.
 *
 * On non-Windows: command and args are returned unchanged.
 *
 * The original `cmd` is preserved for use in error messages so that errors say
 * '"npm" failed' rather than '"cmd.exe" failed'.
 */
function resolveSpawnArgs(
  cmd: string,
  args: string[],
): { spawnCmd: string; spawnArgs: string[] } {
  if (currentPlatform() !== 'win32') {
    return { spawnCmd: cmd, spawnArgs: args };
  }
  // powershell.exe is a real executable; no cmd.exe wrapper needed.
  if (cmd === 'powershell') {
    return { spawnCmd: 'powershell.exe', spawnArgs: args };
  }
  // All other Windows commands: wrap with cmd.exe.
  // If the caller already passed 'npm.cmd', use it as-is; bare names get .cmd appended.
  const resolved =
    cmd.endsWith('.cmd') || cmd.endsWith('.exe') ? cmd : `${cmd}.cmd`;
  return { spawnCmd: 'cmd.exe', spawnArgs: ['/d', '/c', resolved, ...args] };
}

function spawnCheck(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const { spawnCmd, spawnArgs } = resolveSpawnArgs(cmd, args);
      const child = _spawnImpl(spawnCmd, spawnArgs, { stdio: 'ignore', shell: false });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      // Timeout after 5 seconds
      setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve(false);
      }, 5000);
    } catch {
      resolve(false);
    }
  });
}

async function probeUrl(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function detectUv(): Promise<'available' | 'not-available'> {
  // Try `uvx --version` — on Windows this may be `uvx.exe`
  const ok = await spawnCheck('uvx', ['--version']);
  return ok ? 'available' : 'not-available';
}

async function detectKiro(): Promise<'available' | 'not-available'> {
  const ok = await spawnCheck('kiro-cli', ['--version']);
  return ok ? 'available' : 'not-available';
}

async function detectBrowser(): Promise<'available' | 'not-available'> {
  const url = process.env.PORTAL_BROWSER_MCP_URL;
  if (!url) return 'not-available';
  const ok = await probeUrl(`${url.replace(/\/$/, '')}/health`);
  return ok ? 'available' : 'not-available';
}

function detectDrawio(): 'available' | 'not-available' {
  // Use drawioPackState() so that detectDrawio() and the post-install state check
  // agree on what "available" means: MCP entry, shape index, AND all renderer files.
  const { tool, renderer } = drawioPackState();
  return tool.ok && renderer.ok ? 'available' : 'not-available';
}

function detectDocs(): 'available' | 'not-available' {
  const ok =
    hasPdfCapability() &&
    hasDocxCapability() &&
    hasExcelCapability() &&
    hasPptxCapability();
  return ok ? 'available' : 'not-available';
}

async function detectHeadroom(): Promise<'available' | 'not-available'> {
  const url = process.env.HEADROOM_PROXY_URL;
  if (!url) return 'not-available';
  const ok = await probeUrl(`${url.replace(/\/$/, '')}/health`);
  return ok ? 'available' : 'not-available';
}

// ── Cache ─────────────────────────────────────────────────────────────────────

interface CacheEntry {
  packs: ToolPack[];
  at: number;
}

let _cache: CacheEntry | null = null;
const CACHE_TTL_MS = 30_000;

export function clearPackCache(): void {
  _cache = null;
}

// ── Public detection API ──────────────────────────────────────────────────────

export async function getToolPacks(): Promise<ToolPack[]> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) {
    return _cache.packs;
  }
  await ensureDrawioPackRestored().catch(() => {});

  const [uvStatus, kiroStatus, browserStatus, headroomStatus] =
    await Promise.all([
      detectUv(),
      detectKiro(),
      detectBrowser(),
      detectHeadroom(),
    ]);

  const docsStatus = detectDocs();
  const drawioStatus = detectDrawio();

  // Overlay 'installing' status from active jobs
  const jobStatus = (id: string): 'installing' | null => {
    const job = installJobs.get(id);
    if (job && (job.status === 'pending' || job.status === 'running')) return 'installing';
    return null;
  };

  const packs: ToolPack[] = [
    {
      id: 'uv',
      name: 'uv / uvx',
      description: 'AWS integration in agent runs, custom uvx-based MCP servers',
      status: jobStatus('uv') ?? uvStatus,
      installable: true,
    },
    {
      id: 'kiro',
      name: 'Kiro CLI',
      description: 'Kiro engine for agent runs',
      status: jobStatus('kiro') ?? kiroStatus,
      installable: true,
    },
    {
      id: 'browser',
      name: 'Browser MCP',
      description: 'Web browser integration in agent runs',
      status: browserStatus,
      installable: false,
      detail: 'Start with: docker compose --profile browser up -d',
    },
    {
      id: 'drawio',
      name: 'Icon diagrams (draw.io)',
      description:
        'Architecture diagrams with official AWS, Azure, Google Cloud and Kubernetes icons in diagrams, documents and decks',
      status: jobStatus('drawio') ?? drawioStatus,
      installable: true,
    },
    {
      id: 'docs',
      name: 'Documents & spreadsheets',
      description:
        'Upload PDF files; generate Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files',
      status: docsStatus,
      installable: false,
      detail: 'Run: npm install pdfjs-dist docx exceljs pptxgenjs',
    },
    {
      id: 'headroom',
      name: 'Headroom proxy',
      description: 'Anthropic API proxy for rate-limit management',
      status: headroomStatus,
      installable: false,
      detail: 'Set the HEADROOM_PROXY_URL environment variable to your proxy URL',
    },
  ];

  // In the cloud, agents run in the AgentCore runner images, not where the portal runs, so installing here would change
  // nothing for them. What the runners have is fixed when the image is built.
  if (usesDynamoDb()) {
    for (const p of packs) {
      if (p.id === 'uv' || p.id === 'kiro') {
        p.status = 'available';
        p.installable = false;
        p.detail = 'Included in the runner image';
      } else if (p.id === 'drawio' && process.env.ICON_DIAGRAMS_DIR) {
        // The portal image carries the pack (installed when the image is built), so there is nothing to install here.
        p.installable = false;
        p.detail = p.status === 'available' ? 'Included in the portal image' : 'Expected in the portal image but not found';
      } else if (p.id === 'browser') {
        const on = process.env.PORTAL_AGENTCORE_BROWSER === '1';
        p.name = 'Cloud browser (AgentCore)';
        p.status = on ? 'available' : 'not-available';
        p.installable = false;
        p.detail = on ? 'Agents can open pages; watch and take over in the Browser tab' : 'Turn on when deploying: cdk deploy -c agentcoreBrowser=true';
      }
    }
  }

  _cache = { packs, at: Date.now() };
  return packs;
}

// ── Install logic ─────────────────────────────────────────────────────────────

const INSTALLABLE_PACK_IDS = ['uv', 'kiro', 'drawio'];

function addLogLine(job: InstallJob, line: string): void {
  job.log.push(line);
  for (const sub of job.subscribers) {
    try {
      sub(line);
    } catch {
      // subscriber may have closed
    }
  }
}

async function runInstall(job: InstallJob): Promise<void> {
  job.status = 'running';
  addLogLine(job, `Starting install of ${job.packId}…`);

  try {
    if (job.packId === 'uv') {
      await installUv(job);
    } else if (job.packId === 'kiro') {
      await installKiro(job);
    } else if (job.packId === 'drawio') {
      await installDrawio(job);
    } else {
      throw new Error(`Unknown pack: ${job.packId}`);
    }

    job.status = 'done';
    job.finishedAt = now();
    addLogLine(job, 'Install complete.');
  } catch (e: unknown) {
    job.status = 'failed';
    job.finishedAt = now();
    // Do NOT truncate: the full message is what the UI shows.
    job.error = String((e as Error)?.message ?? e);
    addLogLine(job, `Error: ${job.error}`);
  } finally {
    clearPackCache();
    // Notify all subscribers that stream is done
    for (const sub of job.subscribers) {
      try {
        sub('\x00done');
      } catch { /* ignore */ }
    }
    job.subscribers.clear();
  }
}

/**
 * Install the Icon diagrams pack into packDir() (set ICON_DIAGRAMS_DIR first). Used when the cloud portal image is
 * built (scripts/install-drawio-pack.ts), so the pack ships inside the image and is never fetched from S3 at run time.
 * Returns the install log; throws when the install fails.
 */
export async function installDrawioPackForBuild(log: (line: string) => void = () => {}): Promise<void> {
  const job: InstallJob = {
    id: generateId(),
    packId: 'drawio',
    status: 'pending',
    log: [],
    startedAt: now(),
    finishedAt: null,
    error: null,
    subscribers: new Set([log]),
  };
  await runInstall(job);
  if (job.status !== 'done') throw new Error(job.error ?? 'The Icon diagrams pack did not install');
}

/**
 * Run an install job synchronously for tests.
 * Creates and runs a job; returns it once settled (status 'done' or 'failed').
 * For use in tests only.
 */
export async function _runInstallJobForTest(packId: string): Promise<InstallJob> {
  const job: InstallJob = {
    id: generateId(),
    packId,
    status: 'pending',
    log: [],
    startedAt: now(),
    finishedAt: null,
    error: null,
    subscribers: new Set(),
  };
  await runInstall(job);
  return job;
}

async function spawnWithLog(
  job: InstallJob,
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { spawnCmd, spawnArgs } = resolveSpawnArgs(cmd, args);

    let child: ChildProcess;
    try {
      child = _spawnImpl(spawnCmd, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: opts.env ?? process.env,
        cwd: opts.cwd,
      });
    } catch (e) {
      // Synchronous throw from spawn itself (e.g. bad options) — rare but handle it.
      // Use the original `cmd` in the message (not spawnCmd) so the error is human-readable.
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        reject(new Error(`Command not found: "${cmd}". Ensure it is installed and available on the PATH.`));
      } else {
        reject(new Error(`Failed to start "${cmd}": ${err.message}`));
      }
      return;
    }

    // Collect stderr lines so we can include them in the exit-code error message.
    const stderrLines: string[] = [];

    child.stdout?.on('data', (chunk: Buffer) => {
      addLogLine(job, chunk.toString('utf8').trim());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        addLogLine(job, text);
        // Keep the last 20 stderr lines for error context; avoids unbounded growth.
        stderrLines.push(text);
        if (stderrLines.length > 20) stderrLines.shift();
      }
    });
    child.on('error', (e) => {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        reject(new Error(`Command not found: "${cmd}". Ensure it is installed and available on the PATH.`));
      } else {
        reject(new Error(`Failed to start "${cmd}": ${err.message}`));
      }
    });
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        const exitInfo = signal ? `killed by signal ${signal}` : `exit code ${code}`;
        const hint = stderrLines.length
          ? `\nRelevant output:\n  ${stderrLines.slice(-5).join('\n  ')}`
          : '';
        reject(new Error(`"${cmd}" failed (${exitInfo}).${hint}`));
      }
    });
  });
}

// ── HTTP download helpers ─────────────────────────────────────────────────────

/**
 * Download a URL to a Buffer.
 * Throws with a descriptive error on HTTP error or network failure, naming the
 * file, URL, and reason — never fails silently.
 */
async function downloadToBuffer(url: string, displayName: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await _fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    throw new Error(
      `Cannot download ${displayName} from ${url}: network error — ${msg}. ` +
      `Ensure the container has outbound internet access (ports 80 and 443).`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Cannot download ${displayName} from ${url}: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Download a file to a temp path, verify its SHA-256, then atomically rename it into place.
 * Throws on network/HTTP error, checksum mismatch, or write failure — never skips silently.
 */
async function downloadAndVerify(
  url: string,
  destPath: string,
  expectedSha256: string,
  displayName: string,
): Promise<void> {
  const buf = await downloadToBuffer(url, displayName);
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== expectedSha256) {
    throw new Error(
      `Checksum mismatch for ${displayName} (from ${url}):\n` +
      `  expected: ${expectedSha256}\n` +
      `  actual:   ${actual}\n` +
      `The pinned hash in DRAWIO_PIN may need updating.`,
    );
  }
  const tmp = `${destPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, destPath);
  } catch (e: unknown) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error(
      `Failed to write ${displayName} to ${destPath}: ${(e as Error)?.message ?? String(e)}`,
    );
  }
}

async function installUv(job: InstallJob): Promise<void> {
  addLogLine(job, 'Downloading and installing uv…');
  if (currentPlatform() === 'win32') {
    addLogLine(job, 'Downloading uv for Windows via PowerShell…');
    await spawnWithLog(job, 'powershell', [
      '-Command',
      'irm https://astral.sh/uv/install.ps1 | iex',
    ]);
  } else {
    // Pre-flight: verify curl is available before trying to use it.
    const hasCurl = await spawnCheck('curl', ['--version']);
    if (!hasCurl) {
      throw new Error(
        'curl is not installed in this image. Cannot download the uv installer. ' +
        'Add curl to the container image (e.g. apt-get install -y curl) or install uv another way.',
      );
    }

    // Download the installer to a temp file, then run it as a separate step.
    // This avoids the pipeline-exit-code problem: `curl … | sh` exits with sh's
    // code even when curl failed, so a download failure is silently ignored.
    const tmpScript = path.join(os.tmpdir(), `uv-install-${Date.now()}.sh`);
    addLogLine(job, 'Downloading uv installer script…');
    try {
      await spawnWithLog(job, 'curl', ['-LsSf', 'https://astral.sh/uv/install.sh', '-o', tmpScript]);
      addLogLine(job, 'Running uv installer…');
      await spawnWithLog(job, 'sh', [tmpScript]);
    } finally {
      try { fs.unlinkSync(tmpScript); } catch { /* best-effort cleanup */ }
    }
  }

  // Verify: confirm the binary was written where the installer is expected to put it.
  const uvBin = path.join(process.env.HOME ?? '/root', '.local', 'bin', 'uvx');
  const verified = fs.existsSync(uvBin) || await spawnCheck('uvx', ['--version']);
  if (!verified) {
    throw new Error(
      `uv was not found after installation. Expected binary at ${uvBin}. ` +
      `The installer may have put it in a different location — check the log above.`,
    );
  }
  addLogLine(job, `uv verified (${uvBin}).`);
}

async function installKiro(job: InstallJob): Promise<void> {
  addLogLine(job, 'Downloading Kiro CLI installer…');
  if (currentPlatform() === 'win32') {
    throw new Error('Kiro CLI Windows install must be done manually. See https://kiro.dev/downloads');
  }

  // Pre-flight: verify curl is available.
  const hasCurl = await spawnCheck('curl', ['--version']);
  if (!hasCurl) {
    throw new Error(
      'curl is not installed in this image. Cannot download the Kiro CLI installer. ' +
      'Add curl to the container image (e.g. apt-get install -y curl).',
    );
  }

  // Download to a temp file first (avoids hidden pipeline failures).
  const tmpScript = path.join(os.tmpdir(), `kiro-install-${Date.now()}.sh`);
  try {
    await spawnWithLog(job, 'curl', ['-LsSf', 'https://cli.kiro.dev/install', '-o', tmpScript]);
    addLogLine(job, 'Running Kiro CLI installer…');
    await spawnWithLog(job, 'sh', [tmpScript]);
  } finally {
    try { fs.unlinkSync(tmpScript); } catch { /* best-effort cleanup */ }
  }

  // Verify: check the binary was installed.
  const kiroBin = path.join(process.env.HOME ?? '/root', '.local', 'bin', 'kiro-cli');
  const verified = fs.existsSync(kiroBin) || await spawnCheck('kiro-cli', ['--version']);
  if (!verified) {
    throw new Error(
      `kiro-cli was not found after installation. Expected binary at ${kiroBin}. ` +
      `The installer may have put it in a different location — check the log above.`,
    );
  }
  addLogLine(job, `Kiro CLI verified (${kiroBin}). Run: kiro-cli login --use-device-flow`);
}

async function installDrawio(job: InstallJob): Promise<void> {
  // Use the canonical location that the rest of the server reads from (packDir() →
  // ICON_DIAGRAMS_DIR or dataPath('tools','icon-diagrams')). The old code used a
  // relative './data/tools/icon-diagrams' fallback which resolves against the process
  // working directory — not the data volume — making the installed files invisible to
  // detection and unusable by the non-root runtime user.
  const mcpDir = mcpPrefix();  // e.g. /data/tools/icon-diagrams/mcp
  const baseDir = packDir();   // e.g. /data/tools/icon-diagrams
  const renDir = rendererDir(); // e.g. /data/tools/icon-diagrams/renderer

  addLogLine(job, `Installing draw.io pack to ${baseDir}…`);

  // ── Step 1: Ensure required directories are writable ─────────────────────
  for (const dir of [mcpDir, renDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      throw new Error(
        `Cannot create directory ${dir}: ${msg}. ` +
        `Ensure ${baseDir} is writable by the current user (uid ${process.getuid?.() ?? 'unknown'}).`,
      );
    }
    // Double-check write access even if mkdirSync succeeds on an existing read-only dir.
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      throw new Error(
        `Directory ${dir} is not writable by the current user (uid ${process.getuid?.() ?? 'unknown'}). ` +
        `Check the permissions on ${baseDir}.`,
      );
    }
  }

  // ── Step 2: Install the @drawio/mcp npm package ───────────────────────────
  const hasNpm = await spawnCheck('npm', ['--version']);
  if (!hasNpm) {
    throw new Error(`npm is not available on the PATH. Cannot install ${DRAWIO_PIN.mcpPackage}.`);
  }

  addLogLine(job, `Installing ${DRAWIO_PIN.mcpPackage}@${DRAWIO_PIN.mcpVersion} via npm…`);
  await spawnWithLog(
    job,
    'npm',
    [
      'install',
      '--prefix', mcpDir,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      `${DRAWIO_PIN.mcpPackage}@${DRAWIO_PIN.mcpVersion}`,
    ],
  );

  // Verify: confirm the entry point the server uses was actually created.
  const entry = mcpEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(
      `npm install ran but the expected entry point was not created: ${entry}. ` +
      `The installation may be incomplete — check the log above.`,
    );
  }
  addLogLine(job, `MCP server installed at ${entry}.`);

  // ── Step 3: Download shape-index.json (SHA-256 verified) ─────────────────
  // The package does not ship this file; it normally downloads it from a CDN on first
  // use.  We pin a specific commit so the server never needs network at run time.
  const shapeIndexUrl =
    `https://raw.githubusercontent.com/jgraph/drawio-mcp/${DRAWIO_PIN.indexCommit}/shape-search/search-index.json`;
  addLogLine(job, `Downloading shape index from commit ${DRAWIO_PIN.indexCommit.slice(0, 8)}…`);
  await downloadAndVerify(
    shapeIndexUrl,
    shapeIndexFile(),
    getIndexSha256(),
    'shape-index.json',
  );
  addLogLine(job, `Shape index verified (sha256 OK).`);

  // ── Step 4: Download renderer files (SHA-256 verified) ───────────────────
  const viewerBase =
    `https://raw.githubusercontent.com/jgraph/drawio/${DRAWIO_PIN.viewerTag}/src/main/webapp`;
  addLogLine(job, `Downloading draw.io viewer files (${DRAWIO_PIN.viewerTag})…`);
  for (const file of RENDERER_FILES) {
    const url = `${viewerBase}/${file.source}`;
    const dest = path.join(renDir, file.name);
    addLogLine(job, `  Downloading ${file.name}…`);
    await downloadAndVerify(url, dest, getRendererFileSha256(file.name, file.sha256), file.name);
  }
  addLogLine(job, `Renderer files installed.`);

  // ── Step 5: Download Azure icon images (best effort) ─────────────────────
  // Failure here must not block the install: an icon that is not installed is just
  // left blank in the rendered diagram.  Successes are recorded in pack.json.
  const imageRelPaths: string[] = [];
  for (const lib of IMAGE_LIBS) {
    const listUrl =
      `https://api.github.com/repos/jgraph/drawio/contents/src/main/webapp/img/lib/${lib}?ref=${DRAWIO_PIN.viewerTag}`;
    let listing: Array<{ name: string; type: string; download_url: string | null }>;
    try {
      addLogLine(job, `Listing ${lib} icon images…`);
      const buf = await downloadToBuffer(listUrl, `image list (${lib})`);
      const parsed = JSON.parse(buf.toString('utf8'));
      if (!Array.isArray(parsed)) throw new Error('GitHub API returned unexpected shape');
      listing = parsed;
    } catch (e: unknown) {
      addLogLine(
        job,
        `Warning: could not list ${lib} images from GitHub API: ${(e as Error)?.message ?? String(e)}. ` +
        `Skipping image downloads — icon images will be blank until the pack is reinstalled.`,
      );
      continue;
    }

    const imageFiles = listing.filter((f) => f.type === 'file');
    addLogLine(job, `Downloading ${imageFiles.length} ${lib} image(s)…`);
    let failCount = 0;
    for (const imgFile of imageFiles) {
      const imgUrl =
        imgFile.download_url ??
        `${viewerBase}/img/lib/${lib}/${imgFile.name}`;
      const imgDest = path.join(renDir, 'img', 'lib', lib, imgFile.name);
      try {
        const buf = await downloadToBuffer(imgUrl, `${lib}/${imgFile.name}`);
        fs.mkdirSync(path.dirname(imgDest), { recursive: true });
        const tmp = `${imgDest}.tmp`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, imgDest);
        imageRelPaths.push(`img/lib/${lib}/${imgFile.name}`);
      } catch (e: unknown) {
        failCount++;
        addLogLine(
          job,
          `Warning: could not download ${lib}/${imgFile.name}: ${(e as Error)?.message ?? String(e)}`,
        );
      }
    }
    if (failCount > 0) {
      addLogLine(
        job,
        `Warning: ${failCount} of ${imageFiles.length} ${lib} image(s) failed to download.`,
      );
    } else if (imageFiles.length > 0) {
      addLogLine(job, `Downloaded all ${imageFiles.length} ${lib} image(s).`);
    }
  }

  // ── Step 6: Write pack.json LAST ─────────────────────────────────────────
  // A missing or incomplete pack.json means the pack is treated as not installed by
  // drawioPackState() and detectDrawio().  Writing it last ensures a partial install
  // never falsely reports as complete.
  const manifest: PackManifest = {
    mcp: `${DRAWIO_PIN.mcpPackage}@${DRAWIO_PIN.mcpVersion}`,
    indexSha256: DRAWIO_PIN.indexSha256,
    viewerTag: DRAWIO_PIN.viewerTag,
    images: imageRelPaths,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestFile(), JSON.stringify(manifest, null, 2));
  addLogLine(job, `draw.io pack installed (${imageRelPaths.length} icon image(s) available).`);
  // The local disk can vanish (Lambda /tmp), so keep a copy in the storage backend.
  addLogLine(job, 'Saving a durable copy of the pack…');
  await persistDrawioPack();
  addLogLine(job, 'Durable copy saved.');
}

// ── Routes ────────────────────────────────────────────────────────────────────

function requireAdmin(req: PortalRequest, res: PortalResponse): boolean {
  if (!req.user?.is_admin) {
    sendJson(res, 403, { error: 'Admin access required' });
    return false;
  }
  return true;
}

export function registerToolPackRoutes(): void {
  // GET /api/settings/packs — list all packs with current status
  router.get('/api/settings/packs', requireAuth(async (_req, res) => {
    const packs = await getToolPacks();
    sendJson(res, 200, { packs });
  }));

  // POST /api/settings/packs/:id/install — start an install job
  router.post('/api/settings/packs/:id/install', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const packId = req.params.id;

    if (!INSTALLABLE_PACK_IDS.includes(packId)) {
      throw new HttpError(
        400,
        `Pack "${packId}" cannot be installed via the UI. Valid installable packs: ${INSTALLABLE_PACK_IDS.join(', ')}`,
      );
    }

    const existing = installJobs.get(packId);
    if (existing && (existing.status === 'pending' || existing.status === 'running')) {
      throw new HttpError(409, `An install of "${packId}" is already in progress`);
    }

    const job: InstallJob = {
      id: generateId(),
      packId,
      status: 'pending',
      log: [],
      startedAt: now(),
      finishedAt: null,
      error: null,
      subscribers: new Set(),
    };
    installJobs.set(packId, job);

    // Start in background
    setImmediate(() => {
      runInstall(job).catch((e: unknown) => {
        console.error('[tool-install]', e);
      });
    });

    sendJson(res, 200, {
      job: {
        id: job.id,
        packId: job.packId,
        status: job.status,
        log: job.log,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        error: job.error,
      },
    });
  }));

  // GET /api/settings/packs/:id/install/log — SSE stream of install log
  router.sse('/api/settings/packs/:id/install/log', requireAuth((req: PortalRequest, res: PortalResponse) => {
    const packId = req.params.id;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const sendEvent = (data: string) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const job = installJobs.get(packId);
    if (!job) {
      sendEvent('No install job found for this pack.');
      res.end();
      return;
    }

    // Send existing log lines
    for (const line of job.log) {
      sendEvent(line);
    }

    // If already done, end immediately
    if (job.status === 'done' || job.status === 'failed') {
      sendEvent('\x00done');
      res.end();
      return;
    }

    // Subscribe for new lines
    const subscriber = (line: string) => {
      if (line === '\x00done') {
        res.end();
        return;
      }
      sendEvent(line);
    };

    job.subscribers.add(subscriber);

    req.on('close', () => {
      job.subscribers.delete(subscriber);
    });
  }));
}
