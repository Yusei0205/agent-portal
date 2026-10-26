/**
 * Optional tool-pack registry.
 *
 * Five packs are defined:
 *   'uv'      — Python / uvx runner, needed by the AWS integration and custom MCP servers.
 *   'kiro'    — Kiro CLI engine, needed by the Kiro provider.
 *   'browser' — Web browser MCP server, needed by the browser integration.
 *   'drawio'  — Icon diagrams: the draw.io MCP server (shape lookup) and the draw.io viewer files that draw
 *               diagrams offline; admin-installed with a live log (drawio-pack.ts). Off by default.
 *   'docs'    — Document libraries (pdfjs-dist, docx, exceljs, pptxgenjs): PDF upload, Word/Excel/PPTX
 *               generation. Detected by whether the npm packages are installed in node_modules.
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
import { DRAWIO_PACK_ID, DRAWIO_PIN, IMAGE_LIBS, RENDERER_FILES, drawioPackState, manifestFile, mcpPrefix, packDir, rendererDir, shapeIndexFile, type PackManifest } from './drawio-pack.ts';
import { DOCS_PACK_ID, docsPackState, clearDocsPackCache } from './docs-pack.ts';

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
  /** Packs with several parts (the Icon diagrams pack) say which part is in place. */
  parts?: { id: string; label: string; ok: boolean; reason: string }[];
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
    // npm is a .cmd file on Windows, which only runs through the shell.
    const r = await exec(cmd, args, { env, timeout: 300_000, maxBuffer: 5 * 1024 * 1024, shell: /\.cmd$/i.test(cmd) });
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

async function detectDrawio(): Promise<{ status: PackStatus; reason: string; parts: NonNullable<ToolPack['parts']> }> {
  const st = drawioPackState();
  const parts = [
    { id: 'tool', label: 'draw.io MCP server and shape index', ok: st.tool.ok, reason: st.tool.reason },
    { id: 'renderer', label: 'draw.io viewer files (pictures and exports)', ok: st.renderer.ok, reason: st.renderer.reason },
  ];
  if (!st.tool.ok) return { status: 'missing', reason: st.tool.reason, parts };
  return { status: 'available', reason: st.renderer.ok ? `${st.tool.reason}; the viewer files are installed` : `${st.tool.reason}; ${st.renderer.reason}, so previews and exports need them`, parts };
}

function detectDocs(): { status: PackStatus; reason: string; parts: NonNullable<ToolPack['parts']> } {
  const st = docsPackState();
  const parts = st.parts.map((p) => ({ id: p.id, label: p.label, ok: p.available, reason: p.reason }));
  return { status: st.available ? 'available' : 'missing', reason: st.reason, parts };
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

  const [uv, kiro, browser, drawio] = await Promise.all([
    detectUv(run),
    detectKiro(run),
    detectBrowser(probe),
    detectDrawio(),
  ]);

  const docs = detectDocs();

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
    {
      id: DRAWIO_PACK_ID,
      label: 'Icon diagrams (draw.io)',
      neededBy: 'Icon-style architecture diagrams (official AWS, Azure, Google Cloud and Kubernetes icons) in diagrams, documents and presentations',
      status: drawio.status,
      reason: drawio.reason,
      hint: 'An admin can install the Icon diagrams pack under Settings › Tools',
      parts: drawio.parts,
    },
    {
      id: DOCS_PACK_ID,
      label: 'Documents & spreadsheets',
      neededBy: 'Upload PDF files; generate Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files',
      status: docs.status,
      reason: docs.reason,
      hint: 'Run: npm install pdfjs-dist docx exceljs pptxgenjs (or install the Documents pack under Settings › Tools)',
      parts: docs.parts,
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

/** What the Icon diagrams install checks against. The real values are DRAWIO_PIN and RENDERER_FILES; tests pass their own. */
export interface DrawioPins {
  mcpPackage: string;
  mcpVersion: string;
  mcpIntegrity: string;
  indexCommit: string;
  indexSha256: string;
  viewerTag: string;
  files: { name: string; source: string; sha256: string }[];
}

/** The environment of the npm run: the program search path, a home and cache inside the data folder, and proxy settings. No secrets. */
function npmEnv(cacheDir: string): Record<string, string> {
  const env: Record<string, string> = { HOME: dataPath('home'), npm_config_cache: cacheDir, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', CI: '1' };
  for (const k of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

function sha1Blob(buf: Buffer): string {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/**
 * Install the Icon diagrams pack under packDir():
 *   1. the draw.io MCP server, an exact npm version installed with --ignore-scripts, checked against its pinned integrity;
 *   2. its shape index (the package downloads it from a CDN on first use; here it is fetched once and SHA-256 checked);
 *   3. the draw.io viewer files the portal draws diagrams with (SHA-256 checked);
 *   4. best effort, the Azure icon image folder (each file checked against its git blob hash).
 * pack.json is written last. Steps 1 to 3 failing fails the install; step 4 failing only says so in the log.
 */
export async function installDrawioPack(job: InstallJob, downloader: Downloader, shellRunner: ShellRunner, pins: DrawioPins = { ...DRAWIO_PIN, files: RENDERER_FILES }): Promise<void> {
  const dir = packDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(manifestFile(), { force: true });
  const tmp = fs.mkdtempSync(path.join(dir, '.install-'));
  try {
    const prefix = mcpPrefix();
    fs.mkdirSync(prefix, { recursive: true });
    fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ name: 'icon-diagrams-host', private: true, version: '0.0.0' }));
    const spec = `${pins.mcpPackage}@${pins.mcpVersion}`;
    addLog(job, `Installing ${spec} with npm (install scripts off)…`);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = await shellRunner(npm, ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', spec], npmEnv(path.join(dir, '.npm-cache')));
    if (r.output) addLog(job, r.output.slice(-1500));
    if (!r.ok) throw new Error('npm install of the draw.io MCP server failed (is npm on the PATH and the npm registry reachable?)');
    let integrity = '';
    let version = '';
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(prefix, 'node_modules', '.package-lock.json'), 'utf8'));
      const entry = lock?.packages?.['node_modules/@drawio/mcp'];
      integrity = String(entry?.integrity ?? '');
      version = String(entry?.version ?? '');
    } catch {
      /* checked below */
    }
    if (version !== pins.mcpVersion || integrity !== pins.mcpIntegrity) {
      throw new Error(`The installed ${spec} does not match the pinned version and integrity (got ${version || 'nothing'} ${integrity.slice(0, 20)}). Nothing was kept.`);
    }
    addLog(job, `Integrity verified: ${integrity.slice(0, 24)}…`);

    addLog(job, 'Downloading the shape index (about 5 MB)…');
    const idxTmp = path.join(tmp, 'search-index.json');
    await downloader(`https://cdn.jsdelivr.net/gh/jgraph/drawio-mcp@${pins.indexCommit}/shape-search/search-index.json`, idxTmp);
    const idxSha = sha256File(idxTmp);
    if (idxSha !== pins.indexSha256) throw new Error(`SHA-256 mismatch for the shape index: expected ${pins.indexSha256}, got ${idxSha}`);
    const parsed = JSON.parse(fs.readFileSync(idxTmp, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length < 1000) throw new Error('The shape index is not the expected list of shapes');
    fs.renameSync(idxTmp, shapeIndexFile());
    addLog(job, `Shape index installed (${parsed.length} shapes).`);

    const rdir = rendererDir();
    fs.mkdirSync(rdir, { recursive: true });
    for (const f of pins.files) {
      addLog(job, `Downloading the draw.io viewer file ${f.name} (${pins.viewerTag})…`);
      const t = path.join(tmp, f.name);
      await downloader(`https://raw.githubusercontent.com/jgraph/drawio/${pins.viewerTag}/src/main/webapp/${f.source}`, t);
      const sha = sha256File(t);
      if (sha !== f.sha256) throw new Error(`SHA-256 mismatch for ${f.name}: expected ${f.sha256}, got ${sha}`);
      fs.renameSync(t, path.join(rdir, f.name));
    }
    addLog(job, 'Viewer files installed.');

    const images: string[] = [];
    for (const lib of IMAGE_LIBS) {
      try {
        const n = await installImageLib(job, downloader, tmp, lib, pins);
        if (n) images.push(lib);
      } catch (e: any) {
        addLog(job, `The ${lib} icon images were not installed (${String(e?.message ?? e).slice(0, 200)}). Diagrams that use those icons still work, but the picture shows those icons blank. Run the install again later to retry.`);
      }
    }

    const manifest: PackManifest = { mcp: spec, indexSha256: idxSha, viewerTag: pins.viewerTag, images, installedAt: now() };
    fs.writeFileSync(manifestFile(), JSON.stringify(manifest, null, 2));
    addLog(job, `Installed ${spec}. The "Icon diagrams" integration is ready for sessions that choose the icon style.`);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Download one folder of draw.io's icon images from the pinned release, checking every file's git blob hash. Returns how many files. */
async function installImageLib(job: InstallJob, downloader: Downloader, tmp: string, lib: string, pins: DrawioPins): Promise<number> {
  addLog(job, `Listing the ${lib} icon images…`);
  const listing = path.join(tmp, `${lib}-tree.json`);
  await downloader(`https://api.github.com/repos/jgraph/drawio/git/trees/${pins.viewerTag}:src/main/webapp/img/lib/${lib}?recursive=1`, listing);
  const tree = JSON.parse(fs.readFileSync(listing, 'utf8'));
  if (tree?.truncated || !Array.isArray(tree?.tree)) throw new Error('the file list was not usable');
  const files = (tree.tree as { path: string; type: string; sha: string; size: number }[]).filter((t) => t.type === 'blob' && /^[\w./-]+\.(?:svg|png)$/.test(t.path) && !t.path.includes('..') && t.size <= 200_000);
  if (!files.length || files.length > 3000) throw new Error('the file list was not what was expected');
  const root = path.join(rendererDir(), 'img', 'lib', lib);
  const stage = path.join(tmp, `img-${lib}`);
  fs.mkdirSync(stage, { recursive: true });
  addLog(job, `Downloading ${files.length} ${lib} icon images…`);
  let next = 0;
  let done = 0;
  const failed: string[] = [];
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      const dest = path.join(stage, f.path);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await downloader(`https://raw.githubusercontent.com/jgraph/drawio/${pins.viewerTag}/src/main/webapp/img/lib/${lib}/${f.path}`, dest);
        if (sha1Blob(fs.readFileSync(dest)) !== f.sha) throw new Error('hash mismatch');
        done++;
      } catch {
        failed.push(f.path);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (failed.length > files.length * 0.02) throw new Error(`${failed.length} of ${files.length} files could not be downloaded or did not match their checksum`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.renameSync(stage, root);
  addLog(job, `${done} ${lib} icon images installed${failed.length ? ` (${failed.length} skipped)` : ''}.`);
  return done;
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
    } else if (job.packId === DRAWIO_PACK_ID) {
      await installDrawioPack(job, downloader, shellRunner);
      try {
        const { ensureBuiltInDrawioIntegration } = await import('./integrations.ts');
        clearPackCache();
        await ensureBuiltInDrawioIntegration();
      } catch (e: any) {
        addLog(job, `The "Icon diagrams" integration could not be created yet (${String(e?.message ?? e).slice(0, 200)}); it is created the first time a session needs it.`);
      }
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

/** Packs an admin can install from Settings (the browser pack runs as its own container). */
const INSTALLABLE = ['uv', 'kiro', DRAWIO_PACK_ID];

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
   * Admin only. Starts a background install job for uv, kiro or drawio (Icon diagrams).
   * Returns 403 for non-admins with the exact message required by the spec.
   * Returns 409 if a job is already running for that pack.
   */
  post('/api/tools/:id/install', async (ctx) => {
    const packId = ctx.params.id;
    if (!INSTALLABLE.includes(packId)) {
      throw new HttpError(404, `Unknown pack "${packId}". Valid ids: ${INSTALLABLE.join(', ')}`);
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
    if (!INSTALLABLE.includes(packId)) {
      throw new HttpError(404, `Unknown pack "${packId}". Valid ids: ${INSTALLABLE.join(', ')}`);
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
