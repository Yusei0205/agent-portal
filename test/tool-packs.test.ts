/**
 * tool-packs.test.ts — Unit tests for the tool-pack installer logic.
 *
 * Tests that failures are always reported as 'failed' with a specific, readable
 * cause, and that 'Install complete' / status 'done' is only reached when the
 * installed tool can actually be found.
 *
 * Covered scenarios:
 *   uv:      curl missing, curl download fails, installer script fails,
 *            binary not found after install, successful install
 *   kiro:    curl missing, curl download fails, installer script fails,
 *            binary not found after install, successful install
 *   drawio:  directory not writable (Linux only), npm missing,
 *            npm install fails, entry-point file missing after install,
 *            full successful install (shape index + renderer files + images),
 *            download failure (shape index, renderer file), checksum mismatch,
 *            image listing/download partial failure (best effort)
 *   Windows: powershell.exe used (not powershell.cmd), npm wrapped with cmd.exe
 */

import { describe, it, afterEach, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import {
  _setSpawnForTest,
  _setPlatformForTest,
  _setFetchForTest,
  _setDrawioHashesForTest,
  _runInstallJobForTest,
} from '../server/tool-packs.ts';
import { setConfig } from '../server/config.ts';
import type { Config } from '../server/config.ts';
import { randomBytes } from 'node:crypto';
import { DRAWIO_PIN, RENDERER_FILES } from '../server/drawio-pack.ts';

// ── Mock helpers ──────────────────────────────────────────────────────────────

interface SpawnBehavior {
  code?: number;
  stderr?: string;
  stdout?: string;
  /** Simulate ENOENT (command not found on OS level). */
  enoent?: boolean;
}

type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

/**
 * Build a queued spawn mock. Each spawn call consumes the next entry in the queue.
 * After the queue is exhausted, all subsequent calls succeed with code 0.
 */
function makeQueuedSpawn(queue: SpawnBehavior[]): SpawnFn {
  let idx = 0;
  return (_cmd: string, _args: string[], _opts: SpawnOptions): ChildProcess => {
    const behavior = queue[idx++] ?? { code: 0 };
    const emitter = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (emitter as any).stdout = stdout;
    (emitter as any).stderr = stderr;
    (emitter as any).kill = () => {};

    setImmediate(() => {
      if (behavior.enoent) {
        const err = Object.assign(new Error(`spawn ENOENT`), { code: 'ENOENT' });
        emitter.emit('error', err);
      } else {
        if (behavior.stderr) stderr.emit('data', Buffer.from(behavior.stderr));
        if (behavior.stdout) stdout.emit('data', Buffer.from(behavior.stdout));
        emitter.emit('close', behavior.code ?? 0, null);
      }
    });

    return emitter as unknown as ChildProcess;
  };
}

/**
 * Build a recording spawn mock: every call is appended to `calls`, then the
 * constant `behavior` is returned.  Useful when you need to inspect which
 * executable was actually spawned (e.g. Windows platform tests).
 */
interface SpawnCall {
  cmd: string;
  args: string[];
}

function makeRecordingSpawn(behavior: SpawnBehavior, calls: SpawnCall[]): SpawnFn {
  return (cmd: string, args: string[], _opts: SpawnOptions): ChildProcess => {
    calls.push({ cmd, args });
    const emitter = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (emitter as any).stdout = stdout;
    (emitter as any).stderr = stderr;
    (emitter as any).kill = () => {};
    setImmediate(() => {
      if (behavior.enoent) {
        const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
        emitter.emit('error', err);
      } else {
        if (behavior.stderr) stderr.emit('data', Buffer.from(behavior.stderr));
        if (behavior.stdout) stdout.emit('data', Buffer.from(behavior.stdout));
        emitter.emit('close', behavior.code ?? 0, null);
      }
    });
    return emitter as unknown as ChildProcess;
  };
}

// ── Fetch mock helpers ────────────────────────────────────────────────────────

type FetchMockEntry = { body: Buffer; status?: number };

/**
 * Build a fetch mock from a URL→response map.
 * Throws if an unexpected URL is requested (catches accidental real network calls in tests).
 */
function makeFetchMock(
  responses: Record<string, FetchMockEntry>,
  opts: { throwOnUnknown?: boolean } = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    const entry = responses[url];
    if (!entry) {
      if (opts.throwOnUnknown ?? true) {
        throw new Error(`Unexpected fetch URL in test: ${url}`);
      }
      // Return 404 for unknown URLs when throwOnUnknown=false (used for best-effort tests)
      return {
        ok: false, status: 404, statusText: 'Not Found',
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response;
    }
    const status = entry.status ?? 200;
    const ok = status >= 200 && status < 300;
    const buf = entry.body;
    return {
      ok, status,
      statusText: ok ? 'OK' : 'Error',
      arrayBuffer: async () =>
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    } as Response;
  };
}

/**
 * URL constants matching installDrawio's choices — kept in one place so tests
 * and production code stay in sync.
 */
const SHAPE_INDEX_URL =
  `https://raw.githubusercontent.com/jgraph/drawio-mcp/${DRAWIO_PIN.indexCommit}/shape-search/search-index.json`;
const VIEWER_BASE_URL =
  `https://raw.githubusercontent.com/jgraph/drawio/${DRAWIO_PIN.viewerTag}/src/main/webapp`;
const AZURE_LIST_URL =
  `https://api.github.com/repos/jgraph/drawio/contents/src/main/webapp/img/lib/azure2?ref=${DRAWIO_PIN.viewerTag}`;

/**
 * Set up fetch mock + hash overrides for a successful draw.io install.
 * Uses fake (but correctly-hashed) content so downloadAndVerify passes.
 * Returns the fake content map for further assertions.
 */
function setupSuccessfulDrawioFetch(
  extra: Record<string, FetchMockEntry> = {},
): { fakeIndex: Buffer; fakeViewer: Buffer; fakeShapes: Buffer; fakeStencils: Buffer } {
  const fakeIndex = Buffer.from('{"shapes":[]}');
  const fakeViewer = Buffer.from('/* viewer-static.min.js */');
  const fakeShapes = Buffer.from('/* shapes-14-6-5.min.js */');
  const fakeStencils = Buffer.from('/* stencils.min.js */');

  _setDrawioHashesForTest(
    createHash('sha256').update(fakeIndex).digest('hex'),
    {
      'viewer-static.min.js': createHash('sha256').update(fakeViewer).digest('hex'),
      'shapes.min.js': createHash('sha256').update(fakeShapes).digest('hex'),
      'stencils.min.js': createHash('sha256').update(fakeStencils).digest('hex'),
    },
  );

  _setFetchForTest(makeFetchMock({
    [SHAPE_INDEX_URL]: { body: fakeIndex },
    [`${VIEWER_BASE_URL}/${RENDERER_FILES[0].source}`]: { body: fakeViewer },
    [`${VIEWER_BASE_URL}/${RENDERER_FILES[1].source}`]: { body: fakeShapes },
    [`${VIEWER_BASE_URL}/${RENDERER_FILES[2].source}`]: { body: fakeStencils },
    [AZURE_LIST_URL]: { body: Buffer.from('[]') }, // no images → nothing to download
    ...extra,
  }));

  return { fakeIndex, fakeViewer, fakeShapes, fakeStencils };
}

// ── State tracking for cleanup ────────────────────────────────────────────────

let savedHome: string | undefined;
let savedIconDiagramsDir: string | undefined;
let tmpDirs: string[] = [];

function saveTmpDir(d: string): string {
  tmpDirs.push(d);
  return d;
}

// Provide a minimal config so packDir() / dataPath() don't throw on the
// "no ICON_DIAGRAMS_DIR" fallback path.  The draw.io tests always set
// ICON_DIAGRAMS_DIR so they never reach that branch.
before(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-tool-packs-config-'));
  saveTmpDir(dataDir);
  setConfig({
    root: process.cwd(),
    port: 0,
    host: '127.0.0.1',
    dataDir,
    webDir: path.join(process.cwd(), 'dist', 'web'),
    secretKey: randomBytes(32).toString('hex'),
    cookieSecure: 'false',
    demoSpeed: 0,
    maxUploadBytes: 50 * 1024 * 1024,
    trustProxy: false,
    awsRegion: 'us-east-1',
    deployTarget: null,
  } as Config);
});

afterEach(() => {
  _setSpawnForTest(null);
  _setPlatformForTest(null);
  _setFetchForTest(null);
  _setDrawioHashesForTest(null, null);

  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  savedHome = undefined;

  if (savedIconDiagramsDir !== undefined) process.env.ICON_DIAGRAMS_DIR = savedIconDiagramsDir;
  else delete process.env.ICON_DIAGRAMS_DIR;
  savedIconDiagramsDir = undefined;
});

after(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── Helpers for writable temp dirs ────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return saveTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function setHomeDir(dir: string): void {
  savedHome = process.env.HOME;
  process.env.HOME = dir;
}

function setIconDiagramsDir(dir: string): void {
  savedIconDiagramsDir = process.env.ICON_DIAGRAMS_DIR;
  process.env.ICON_DIAGRAMS_DIR = dir;
}

// ── uv install ────────────────────────────────────────────────────────────────

describe('installUv — Linux paths (platform forced to linux)', () => {
  beforeEach(() => {
    _setPlatformForTest('linux');
  });

  it('fails with a clear message when curl is not installed', async () => {
    // spawnCheck('curl', ['--version']) → close(1) → hasCurl=false
    _setSpawnForTest(makeQueuedSpawn([{ code: 1 }]));

    const job = await _runInstallJobForTest('uv');

    assert.equal(job.status, 'failed', 'job must be failed, not done');
    assert.ok(
      job.error?.includes('curl is not installed'),
      `error must mention "curl is not installed"; got: ${job.error}`,
    );
    assert.ok(
      !job.log.includes('Install complete.'),
      '"Install complete." must not appear in log',
    );
  });

  it('fails when curl exits with ENOENT (command not found at OS level)', async () => {
    // spawnCheck fires ENOENT → resolve(false) → hasCurl=false
    _setSpawnForTest(makeQueuedSpawn([{ enoent: true }]));

    const job = await _runInstallJobForTest('uv');

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('curl is not installed'),
      `error must mention curl; got: ${job.error}`,
    );
  });

  it('fails when curl exits non-zero while downloading the installer script', async () => {
    // call 1: spawnCheck curl --version → 0 (curl exists)
    // call 2: spawnWithLog curl -LsSf ... → non-zero (download fails)
    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 },
      { code: 22, stderr: 'curl: (22) The requested URL returned error: 404' },
    ]));

    const job = await _runInstallJobForTest('uv');

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('exit code 22') || job.error?.includes('"curl" failed'),
      `error must mention curl failure; got: ${job.error}`,
    );
    assert.ok(
      !job.log.some((l) => l === 'Install complete.'),
      '"Install complete." must not appear in log',
    );
  });

  it('fails when the installer script exits non-zero', async () => {
    // call 1: spawnCheck curl → 0
    // call 2: spawnWithLog curl download → 0
    // call 3: spawnWithLog sh installer → non-zero
    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 },
      { code: 0 },
      { code: 1, stderr: 'install: error downloading uv binary' },
    ]));

    const job = await _runInstallJobForTest('uv');

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('"sh" failed') || job.error?.includes('exit code 1'),
      `error must mention sh failure; got: ${job.error}`,
    );
  });

  it('fails when uv binary is not found after a nominally successful install', async () => {
    // All three spawns succeed, but HOME points to a dir without uvx.
    const tmpHome = makeTmpDir('test-uv-home-');
    setHomeDir(tmpHome);
    // Do NOT create tmpHome/.local/bin/uvx

    // call 1: spawnCheck curl → 0
    // call 2: spawnWithLog curl download → 0
    // call 3: spawnWithLog sh installer → 0
    // call 4: spawnCheck uvx --version → 1 (not on PATH either)
    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 1 },
    ]));

    const job = await _runInstallJobForTest('uv');

    assert.equal(job.status, 'failed', 'must be failed when binary not found');
    assert.ok(
      job.error?.includes('uv was not found after installation'),
      `error must mention "uv was not found"; got: ${job.error}`,
    );
    assert.ok(
      !job.log.some((l) => l === 'Install complete.'),
      '"Install complete." must not appear in log',
    );
  });

  it('reports done only after the binary is verified at its expected path', async () => {
    const tmpHome = makeTmpDir('test-uv-home-ok-');
    setHomeDir(tmpHome);

    // Create the uvx binary so the file-exists check passes.
    const binDir = path.join(tmpHome, '.local', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'uvx'), '#!/bin/sh\n', { mode: 0o755 });

    // call 1: spawnCheck curl → 0
    // call 2: spawnWithLog curl download → 0
    // call 3: spawnWithLog sh installer → 0
    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 },
      { code: 0 },
      { code: 0 },
    ]));

    const job = await _runInstallJobForTest('uv');

    assert.equal(job.status, 'done', `expected done; error: ${job.error}`);
    assert.ok(
      job.log.some((l) => l === 'Install complete.'),
      'log must contain "Install complete."',
    );
    assert.equal(job.error, null);
  });

  it('does not truncate long error messages', async () => {
    const longStderr = 'X'.repeat(1000);
    // call 1: spawnCheck curl → 0 (curl exists)
    // call 2: spawnWithLog curl download → 1 (fails with long stderr)
    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 },
      { code: 1, stderr: longStderr },
    ]));

    const job = await _runInstallJobForTest('uv');

    assert.equal(job.status, 'failed');
    // job.error must not be cut at 500 chars
    assert.ok(
      (job.error?.length ?? 0) > 500,
      `error must not be truncated at 500 chars; length = ${job.error?.length}`,
    );
  });
});

// ── kiro install ──────────────────────────────────────────────────────────────

describe('installKiro — Linux paths (platform forced to linux)', () => {
  beforeEach(() => {
    _setPlatformForTest('linux');
  });

  it('fails with a clear message when curl is not installed', async () => {
    _setSpawnForTest(makeQueuedSpawn([{ code: 1 }]));

    const job = await _runInstallJobForTest('kiro');

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('curl is not installed'),
      `error must mention curl; got: ${job.error}`,
    );
  });

  it('fails when curl download of the installer exits non-zero', async () => {
    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 },
      { code: 6, stderr: 'curl: (6) Could not resolve host: cli.kiro.dev' },
    ]));

    const job = await _runInstallJobForTest('kiro');

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('"curl" failed') || job.error?.includes('exit code 6'),
      `error must mention curl failure; got: ${job.error}`,
    );
  });

  it('fails when the installer script exits non-zero', async () => {
    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 },
      { code: 0 },
      { code: 1, stderr: 'kiro-cli install: unsupported architecture' },
    ]));

    const job = await _runInstallJobForTest('kiro');

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('"sh" failed') || job.error?.includes('exit code 1'),
      `error must mention sh failure; got: ${job.error}`,
    );
  });

  it('fails when kiro-cli binary is not found after install', async () => {
    const tmpHome = makeTmpDir('test-kiro-home-');
    setHomeDir(tmpHome);
    // Do NOT create the kiro-cli binary

    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 }, // curl check
      { code: 0 }, // curl download
      { code: 0 }, // sh installer
      { code: 1 }, // kiro-cli --version verification
    ]));

    const job = await _runInstallJobForTest('kiro');

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('kiro-cli was not found after installation'),
      `error must mention "kiro-cli was not found"; got: ${job.error}`,
    );
  });

  it('reports done when kiro-cli binary is verified at the expected path', async () => {
    const tmpHome = makeTmpDir('test-kiro-home-ok-');
    setHomeDir(tmpHome);

    const binDir = path.join(tmpHome, '.local', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'kiro-cli'), '#!/bin/sh\n', { mode: 0o755 });

    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 }, // curl check
      { code: 0 }, // curl download
      { code: 0 }, // sh installer
    ]));

    const job = await _runInstallJobForTest('kiro');

    assert.equal(job.status, 'done', `expected done; error: ${job.error}`);
    assert.equal(job.error, null);
  });

  it('reports the Windows manual-install message when platform is win32', async () => {
    _setPlatformForTest('win32');
    _setSpawnForTest(makeQueuedSpawn([])); // no spawns should be called

    const job = await _runInstallJobForTest('kiro');

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('Windows install must be done manually'),
      `error must mention Windows manual install; got: ${job.error}`,
    );
  });
});

// ── drawio install ────────────────────────────────────────────────────────────

describe('installDrawio', () => {
  it('uses the canonical pack directory (packDir/mcpPrefix), not a relative path', async () => {
    // The installer must target packDir()/mcp, not ./data/tools/icon-diagrams
    const tmpBase = makeTmpDir('test-drawio-base-');
    setIconDiagramsDir(tmpBase);

    // Simulate successful npm and create the expected entry-point file.
    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 }, // npm --version check
      { code: 0 }, // npm install
    ]));

    // Pre-create the mcpEntry path that the installer verifies.
    // packDir() = tmpBase, mcpPrefix() = tmpBase/mcp
    // mcpEntry() = tmpBase/mcp/node_modules/@drawio/mcp/src/index.js
    const { mcpEntry, manifestFile } = await import('../server/drawio-pack.ts');
    const entryPath = mcpEntry();
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, '// mock entry\n');

    // Provide fake content for all downloads so the installer can proceed to completion.
    setupSuccessfulDrawioFetch();

    const job = await _runInstallJobForTest('drawio');

    assert.equal(job.status, 'done', `expected done; error: ${job.error}`);

    // Confirm the manifest was written at the canonical location.
    assert.ok(
      fs.existsSync(manifestFile()),
      `manifest must exist at ${manifestFile()} after install`,
    );
  });

  it('fails when npm is not available on the PATH', async () => {
    const tmpBase = makeTmpDir('test-drawio-no-npm-');
    setIconDiagramsDir(tmpBase);

    // npm --version → non-zero → hasNpm=false
    _setSpawnForTest(makeQueuedSpawn([{ code: 1 }]));

    const job = await _runInstallJobForTest('drawio');

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('npm is not available'),
      `error must mention npm; got: ${job.error}`,
    );
  });

  it('fails when npm install exits non-zero', async () => {
    const tmpBase = makeTmpDir('test-drawio-npm-fail-');
    setIconDiagramsDir(tmpBase);

    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 }, // npm --version → exists
      { code: 1, stderr: 'npm ERR! ERESOLVE unable to resolve dependency tree' },
    ]));

    const job = await _runInstallJobForTest('drawio');

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('"npm" failed') || job.error?.includes('npm.cmd') || job.error?.includes('exit code 1'),
      `error must mention npm failure; got: ${job.error}`,
    );
  });

  it('fails when the @drawio/mcp entry-point file is missing after npm install', async () => {
    const tmpBase = makeTmpDir('test-drawio-no-entry-');
    setIconDiagramsDir(tmpBase);

    // npm succeeds but does NOT create the entry-point file
    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 }, // npm --version
      { code: 0 }, // npm install
    ]));

    const job = await _runInstallJobForTest('drawio');

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('entry point was not created') || job.error?.includes('node_modules'),
      `error must mention missing entry point; got: ${job.error}`,
    );
  });

  it('fails when the pack directory is not writable (Linux only)', {
    skip: process.platform === 'win32' || process.getuid?.() === 0
      ? 'skipped on Windows or when running as root'
      : false,
  }, async () => {
    const outerTmp = makeTmpDir('test-drawio-perm-');
    const restrictedDir = path.join(outerTmp, 'restricted');
    fs.mkdirSync(restrictedDir, { mode: 0o555 }); // read-only

    setIconDiagramsDir(path.join(restrictedDir, 'icon-diagrams'));

    // No spawn calls expected — should fail before spawning anything.
    _setSpawnForTest(makeQueuedSpawn([]));

    const job = await _runInstallJobForTest('drawio');

    // Restore permissions for cleanup
    try { fs.chmodSync(restrictedDir, 0o755); } catch { /* ignore */ }

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('not writable') || job.error?.includes('Cannot create'),
      `error must describe permission problem; got: ${job.error}`,
    );
  });

  it('writes pack.json manifest on successful install', async () => {
    const tmpBase = makeTmpDir('test-drawio-manifest-');
    setIconDiagramsDir(tmpBase);

    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 }, // npm --version
      { code: 0 }, // npm install
    ]));

    // Create the expected entry-point file.
    const { mcpEntry, manifestFile } = await import('../server/drawio-pack.ts');
    const entryPath = mcpEntry();
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, '// mock\n');

    // Provide fake content so the download steps succeed.
    setupSuccessfulDrawioFetch();

    const job = await _runInstallJobForTest('drawio');
    assert.equal(job.status, 'done', `expected done; error: ${job.error}`);

    const manifest = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
    assert.ok(manifest.mcp?.startsWith('@drawio/mcp@'), 'manifest.mcp must include package version');
    assert.ok(manifest.installedAt, 'manifest.installedAt must be set');
    // pack.json must carry the real (pinned) values, not empty strings.
    assert.equal(manifest.indexSha256, DRAWIO_PIN.indexSha256, 'manifest.indexSha256 must be the real pin value');
    assert.equal(manifest.viewerTag, DRAWIO_PIN.viewerTag, 'manifest.viewerTag must be the real pin value');
    assert.ok(Array.isArray(manifest.images), 'manifest.images must be an array');
  });
});

// ── spawnWithLog ENOENT translation ──────────────────────────────────────────

describe('spawnWithLog — ENOENT from spawn error event', () => {
  beforeEach(() => {
    _setPlatformForTest('linux');
  });

  it('translates ENOENT into a readable "Command not found" message', async () => {
    // Make curl check pass, but sh fires ENOENT (command not in image).
    // call 1: spawnCheck curl → 0
    // call 2: spawnWithLog curl download → 0
    // call 3: spawnWithLog sh installer → ENOENT
    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 },
      { code: 0 },
      { enoent: true },
    ]));

    const tmpHome = makeTmpDir('test-uv-enoent-');
    setHomeDir(tmpHome);

    const job = await _runInstallJobForTest('uv');

    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('Command not found') || job.error?.includes('not found'),
      `ENOENT must produce "Command not found" error; got: ${job.error}`,
    );
    // Must NOT leak raw OS error codes like "ENOENT"
    assert.ok(
      !job.error?.includes('spawn sh ENOENT'),
      'error must not expose raw "spawn sh ENOENT" message',
    );
  });
});

// ── drawio install — download verification ────────────────────────────────────

describe('installDrawio — download verification', () => {
  /** Shared helper: pre-create the mcpEntry file and mock npm to succeed. */
  async function setupNpmSuccess(tmpBase: string): Promise<void> {
    const { mcpEntry } = await import('../server/drawio-pack.ts');
    const entryPath = mcpEntry();
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, '// mock\n');
    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 }, // npm --version
      { code: 0 }, // npm install
    ]));
  }

  it('full success path: downloads shape index, renderer files, and writes manifest with real pin values', async () => {
    const tmpBase = makeTmpDir('test-drawio-full-');
    setIconDiagramsDir(tmpBase);
    await setupNpmSuccess(tmpBase);
    setupSuccessfulDrawioFetch();

    const job = await _runInstallJobForTest('drawio');
    assert.equal(job.status, 'done', `expected done; error: ${job.error}`);
    assert.ok(job.log.some((l) => l === 'Install complete.'), 'log must contain Install complete.');

    // Shape index must exist on disk.
    const { shapeIndexFile, rendererDir, manifestFile: getManifest } = await import('../server/drawio-pack.ts');
    assert.ok(fs.existsSync(shapeIndexFile()), `shape-index.json must exist at ${shapeIndexFile()}`);

    // Renderer files must exist on disk.
    const renDir = rendererDir();
    for (const f of RENDERER_FILES) {
      assert.ok(
        fs.existsSync(path.join(renDir, f.name)),
        `renderer file ${f.name} must exist in ${renDir}`,
      );
    }

    // pack.json must carry the real (pinned) values — not empty strings.
    const manifest = JSON.parse(fs.readFileSync(getManifest(), 'utf8'));
    assert.equal(manifest.indexSha256, DRAWIO_PIN.indexSha256);
    assert.equal(manifest.viewerTag, DRAWIO_PIN.viewerTag);
    assert.ok(manifest.mcp.startsWith('@drawio/mcp@'));
  });

  it('fails when shape-index download returns a network error, naming file and URL', async () => {
    const tmpBase = makeTmpDir('test-drawio-idx-fail-');
    setIconDiagramsDir(tmpBase);
    await setupNpmSuccess(tmpBase);

    // Only set hash overrides (no fetch mock) — _fetchImpl will throw on the index URL.
    setupSuccessfulDrawioFetch(); // sets hash overrides and fetch mock
    // Override: make the shape-index URL fail with a network error.
    _setFetchForTest(makeFetchMock({
      [SHAPE_INDEX_URL]: { body: Buffer.alloc(0), status: 0 }, // status 0 triggers network error path
    }, { throwOnUnknown: false }));
    // Overwrite the fetch so shape-index throws a network error
    const realFetch = _setFetchForTest; // keep reference
    _setFetchForTest(async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === SHAPE_INDEX_URL) {
        throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com');
      }
      // Other URLs: succeed (renderer + images aren't reached anyway)
      throw new Error(`Unexpected URL: ${url}`);
    });

    const job = await _runInstallJobForTest('drawio');
    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes('shape-index.json'),
      `error must name the file; got: ${job.error}`,
    );
    assert.ok(
      job.error?.includes(SHAPE_INDEX_URL),
      `error must name the URL; got: ${job.error}`,
    );
    assert.ok(
      job.error?.includes('network error') || job.error?.includes('Cannot download'),
      `error must describe the network failure; got: ${job.error}`,
    );
  });

  it('fails when shape-index download returns HTTP 404, naming file, URL and status', async () => {
    const tmpBase = makeTmpDir('test-drawio-idx-404-');
    setIconDiagramsDir(tmpBase);
    await setupNpmSuccess(tmpBase);

    _setFetchForTest(makeFetchMock({
      [SHAPE_INDEX_URL]: { body: Buffer.from('Not Found'), status: 404 },
    }, { throwOnUnknown: false }));

    const job = await _runInstallJobForTest('drawio');
    assert.equal(job.status, 'failed');
    assert.ok(job.error?.includes('shape-index.json'), `must name file; got: ${job.error}`);
    assert.ok(job.error?.includes(SHAPE_INDEX_URL), `must name URL; got: ${job.error}`);
    assert.ok(job.error?.includes('404'), `must include HTTP status; got: ${job.error}`);
  });

  it('fails on shape-index checksum mismatch, naming file, URL, expected and actual hashes', async () => {
    const tmpBase = makeTmpDir('test-drawio-idx-hash-');
    setIconDiagramsDir(tmpBase);
    await setupNpmSuccess(tmpBase);

    // Return wrong content (hash will NOT match DRAWIO_PIN.indexSha256).
    // Do NOT call _setDrawioHashesForTest so the real pinned hash is used.
    _setFetchForTest(makeFetchMock({
      [SHAPE_INDEX_URL]: { body: Buffer.from('{"wrong": true}') },
    }, { throwOnUnknown: false }));

    const job = await _runInstallJobForTest('drawio');
    assert.equal(job.status, 'failed');
    assert.ok(job.error?.includes('shape-index.json'), `must name file; got: ${job.error}`);
    assert.ok(job.error?.includes(SHAPE_INDEX_URL), `must name URL; got: ${job.error}`);
    assert.ok(
      job.error?.includes('expected:') && job.error?.includes('actual:'),
      `must show expected vs actual hash; got: ${job.error}`,
    );
    assert.ok(
      job.error?.includes(DRAWIO_PIN.indexSha256),
      `must show the expected hash; got: ${job.error}`,
    );
  });

  it('fails when a renderer file download returns HTTP error, naming the file and URL', async () => {
    const tmpBase = makeTmpDir('test-drawio-ren-fail-');
    setIconDiagramsDir(tmpBase);
    await setupNpmSuccess(tmpBase);

    const { fakeIndex } = setupSuccessfulDrawioFetch(); // sets up hash overrides
    // Override fetch: shape-index succeeds, first renderer file fails.
    const failUrl = `${VIEWER_BASE_URL}/${RENDERER_FILES[0].source}`;
    _setFetchForTest(makeFetchMock({
      [SHAPE_INDEX_URL]: { body: fakeIndex },
      [failUrl]: { body: Buffer.from('Service Unavailable'), status: 503 },
    }, { throwOnUnknown: false }));

    const job = await _runInstallJobForTest('drawio');
    assert.equal(job.status, 'failed');
    assert.ok(
      job.error?.includes(RENDERER_FILES[0].name),
      `must name the renderer file; got: ${job.error}`,
    );
    assert.ok(
      job.error?.includes(failUrl),
      `must name the URL; got: ${job.error}`,
    );
    assert.ok(job.error?.includes('503'), `must include HTTP status; got: ${job.error}`);
  });

  it('succeeds when image list API fails (best effort) — images are skipped with a warning', async () => {
    const tmpBase = makeTmpDir('test-drawio-img-api-fail-');
    setIconDiagramsDir(tmpBase);
    await setupNpmSuccess(tmpBase);

    const { fakeIndex, fakeViewer, fakeShapes, fakeStencils } = setupSuccessfulDrawioFetch();
    // Override fetch: all required files succeed, but image list API returns 403.
    _setFetchForTest(makeFetchMock({
      [SHAPE_INDEX_URL]: { body: fakeIndex },
      [`${VIEWER_BASE_URL}/${RENDERER_FILES[0].source}`]: { body: fakeViewer },
      [`${VIEWER_BASE_URL}/${RENDERER_FILES[1].source}`]: { body: fakeShapes },
      [`${VIEWER_BASE_URL}/${RENDERER_FILES[2].source}`]: { body: fakeStencils },
      [AZURE_LIST_URL]: { body: Buffer.from('{"message":"rate limit"}'), status: 403 },
    }));

    const job = await _runInstallJobForTest('drawio');
    assert.equal(job.status, 'done', `best-effort images must not block install; error: ${job.error}`);
    assert.ok(
      job.log.some((l) => l.toLowerCase().includes('warning') && l.includes('azure2')),
      `log must include a warning about azure2 images; log: ${job.log.join('\n')}`,
    );
    // images array in manifest should be empty
    const { manifestFile } = await import('../server/drawio-pack.ts');
    const manifest = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
    assert.deepEqual(manifest.images, [], 'images must be empty when listing fails');
  });

  it('succeeds when some image downloads fail (best effort) — only successes recorded in manifest', async () => {
    const tmpBase = makeTmpDir('test-drawio-img-partial-');
    setIconDiagramsDir(tmpBase);
    await setupNpmSuccess(tmpBase);

    const { fakeIndex, fakeViewer, fakeShapes, fakeStencils } = setupSuccessfulDrawioFetch();
    const imgOkUrl =
      `https://raw.githubusercontent.com/jgraph/drawio/${DRAWIO_PIN.viewerTag}/src/main/webapp/img/lib/azure2/ok.svg`;
    const imgFailUrl =
      `https://raw.githubusercontent.com/jgraph/drawio/${DRAWIO_PIN.viewerTag}/src/main/webapp/img/lib/azure2/fail.svg`;
    const listingJson = Buffer.from(JSON.stringify([
      { name: 'ok.svg',   type: 'file', download_url: imgOkUrl },
      { name: 'fail.svg', type: 'file', download_url: imgFailUrl },
    ]));

    _setFetchForTest(makeFetchMock({
      [SHAPE_INDEX_URL]: { body: fakeIndex },
      [`${VIEWER_BASE_URL}/${RENDERER_FILES[0].source}`]: { body: fakeViewer },
      [`${VIEWER_BASE_URL}/${RENDERER_FILES[1].source}`]: { body: fakeShapes },
      [`${VIEWER_BASE_URL}/${RENDERER_FILES[2].source}`]: { body: fakeStencils },
      [AZURE_LIST_URL]: { body: listingJson },
      [imgOkUrl]: { body: Buffer.from('<svg/>') },
      [imgFailUrl]: { body: Buffer.from('error'), status: 500 },
    }));

    const job = await _runInstallJobForTest('drawio');
    assert.equal(job.status, 'done', `partial image failure must not block install; error: ${job.error}`);
    assert.ok(
      job.log.some((l) => l.toLowerCase().includes('warning') && l.includes('fail.svg')),
      `log must warn about failed image; log: ${job.log.join('\n')}`,
    );
    const { manifestFile } = await import('../server/drawio-pack.ts');
    const manifest = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
    assert.ok(
      manifest.images.includes('img/lib/azure2/ok.svg'),
      'successfully downloaded image must be in manifest',
    );
    assert.ok(
      !manifest.images.includes('img/lib/azure2/fail.svg'),
      'failed image must NOT be in manifest',
    );
  });
});

// ── Windows spawn — regression fix ───────────────────────────────────────────

describe('Windows spawn — resolveSpawnArgs regression fix', () => {
  afterEach(() => {
    _setPlatformForTest(null);
    _setSpawnForTest(null);
  });

  it('uses powershell.exe (not powershell.cmd) on Windows for the uv install', async () => {
    _setPlatformForTest('win32');
    const calls: SpawnCall[] = [];
    // Record all spawn calls; make every call succeed with code 0.
    _setSpawnForTest(makeRecordingSpawn({ code: 0 }, calls));

    const tmpHome = makeTmpDir('test-uv-win-ps-');
    savedHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Create the uvx binary so the post-install file-exists check passes.
    const binDir = path.join(tmpHome, '.local', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'uvx'), '');

    const job = await _runInstallJobForTest('uv');

    // The install may succeed or fail for other reasons; what matters is that
    // powershell.exe was invoked, not powershell.cmd.
    assert.ok(
      calls.some((c) => c.cmd === 'powershell.exe'),
      `powershell.exe must be in spawn calls; got: ${calls.map((c) => c.cmd).join(', ')}`,
    );
    assert.ok(
      !calls.some((c) => c.cmd === 'powershell.cmd'),
      `powershell.cmd must NEVER appear in spawn calls`,
    );
  });

  it('wraps npm with cmd.exe /d /c npm.cmd on Windows (no shell:true required)', async () => {
    _setPlatformForTest('win32');
    const calls: SpawnCall[] = [];
    // All spawns succeed so we reach the npm install step.
    _setSpawnForTest(makeRecordingSpawn({ code: 0 }, calls));

    const tmpBase = makeTmpDir('test-drawio-win-npm-');
    setIconDiagramsDir(tmpBase);
    // Provide a fetch mock so the install can proceed past npm (otherwise it
    // fails at downloads and we never see the npm spawn recorded).
    // We don't need a full successful install here — just confirm the npm spawn call.
    setupSuccessfulDrawioFetch();

    await _runInstallJobForTest('drawio');

    // The npm --version check and npm install must go through cmd.exe /d /c npm.cmd.
    const npmCalls = calls.filter(
      (c) => c.cmd === 'cmd.exe' && c.args.includes('npm.cmd'),
    );
    assert.ok(
      npmCalls.length >= 1,
      `npm must be wrapped with cmd.exe /d /c npm.cmd; spawn calls: ${JSON.stringify(calls.map((c) => ({ cmd: c.cmd, args: c.args.slice(0, 4) })))}`,
    );
    // Verify /d is present (disables AutoRun — injection guard).
    assert.ok(
      npmCalls.every((c) => c.args[0] === '/d' && c.args[1] === '/c'),
      `cmd.exe must be called with /d /c; args: ${JSON.stringify(npmCalls[0]?.args)}`,
    );
    // powershell.cmd must never appear.
    assert.ok(
      !calls.some((c) => c.cmd === 'powershell.cmd'),
      'powershell.cmd must never appear in any spawn call',
    );
  });

  it('install succeeds end-to-end on a simulated Windows environment', async () => {
    // Full happy-path test: all spawns succeed + downloads work → job.status done.
    _setPlatformForTest('win32');
    _setSpawnForTest(makeQueuedSpawn([
      { code: 0 }, // npm --version check (via cmd.exe)
      { code: 0 }, // npm install (via cmd.exe)
    ]));

    const tmpBase = makeTmpDir('test-drawio-win-full-');
    setIconDiagramsDir(tmpBase);

    // Pre-create entry point.
    const { mcpEntry } = await import('../server/drawio-pack.ts');
    const entryPath = mcpEntry();
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, '// mock\n');

    setupSuccessfulDrawioFetch();

    const job = await _runInstallJobForTest('drawio');
    assert.equal(
      job.status,
      'done',
      `Windows draw.io install must complete; error: ${job.error}`,
    );
  });
});
