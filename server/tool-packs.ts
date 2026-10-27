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
import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { HttpError, generateId, now } from './util.ts';
import {
  hasPdfCapability,
  hasDocxCapability,
  hasExcelCapability,
  hasPptxCapability,
} from './docs-pack.ts';

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

// ── Detection helpers ─────────────────────────────────────────────────────────

function spawnCheck(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', shell: false });
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

async function detectDrawio(): Promise<'available' | 'not-available'> {
  const dir = process.env.ICON_DIAGRAMS_DIR;
  if (!dir) return 'not-available';
  const pkgFile = path.join(dir, 'package.json');
  return fs.existsSync(pkgFile) ? 'available' : 'not-available';
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

  const [uvStatus, kiroStatus, browserStatus, drawioStatus, headroomStatus] =
    await Promise.all([
      detectUv(),
      detectKiro(),
      detectBrowser(),
      detectDrawio(),
      detectHeadroom(),
    ]);

  const docsStatus = detectDocs();

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
    job.error = String((e as Error)?.message ?? e).slice(0, 500);
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

async function spawnWithLog(
  job: InstallJob,
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const actualCmd = isWindows && !cmd.endsWith('.cmd') ? `${cmd}.cmd` : cmd;

    const child = spawn(actualCmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      addLogLine(job, chunk.toString('utf8').trim());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      addLogLine(job, chunk.toString('utf8').trim());
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });
  });
}

async function installUv(job: InstallJob): Promise<void> {
  addLogLine(job, 'Downloading and installing uv via installer script…');
  // On Linux/Mac, use the official installer
  if (process.platform === 'win32') {
    addLogLine(job, 'Downloading uv for Windows via PowerShell…');
    await spawnWithLog(job, 'powershell', [
      '-Command',
      'irm https://astral.sh/uv/install.ps1 | iex',
    ]);
  } else {
    addLogLine(job, 'Downloading uv for Linux/macOS…');
    await spawnWithLog(job, 'sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
  }
  addLogLine(job, 'uv installed successfully.');
}

async function installKiro(job: InstallJob): Promise<void> {
  addLogLine(job, 'Downloading Kiro CLI installer…');
  if (process.platform === 'win32') {
    addLogLine(job, 'Download kiro-cli for Windows from https://kiro.dev/downloads');
    throw new Error('Kiro CLI Windows install must be done manually. See https://kiro.dev/downloads');
  }
  await spawnWithLog(job, 'sh', ['-c', 'curl -LsSf https://cli.kiro.dev/install | sh']);
  addLogLine(job, 'Kiro CLI installed. Run: kiro-cli login --use-device-flow');
}

async function installDrawio(job: InstallJob): Promise<void> {
  addLogLine(job, 'Installing draw.io MCP server via npm…');
  const dir = process.env.ICON_DIAGRAMS_DIR ?? './data/tools/icon-diagrams';
  fs.mkdirSync(dir, { recursive: true });

  // Write a package.json placeholder
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({ name: 'icon-diagrams-host', private: true, version: '0.0.0' }),
    );
  }

  await spawnWithLog(
    job,
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--prefix', dir, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '@drawio/mcp'],
  );
  addLogLine(job, 'draw.io MCP server installed.');
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
