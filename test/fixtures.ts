/**
 * Test fixtures and helpers for P0 foundation tests.
 */

import type { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, isDbOpen } from '../server/db.ts';
import { setConfig } from '../server/config.ts';
import type { Config } from '../server/config.ts';
import { startServer } from '../server/index.ts';
import type http from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ── In-memory test DB ─────────────────────────────────────────────────────────

/** Creates an in-memory SQLite database with all migrations applied. */
export function createTestDb(): DatabaseSync {
  if (isDbOpen()) closeDb();
  return openDb(':memory:');
}

// ── Test config ───────────────────────────────────────────────────────────────

function makeTestDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
}

export function createTestConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = makeTestDataDir();
  return {
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
    ...overrides,
  };
}

// ── Test server ───────────────────────────────────────────────────────────────

interface TestServer {
  server: http.Server;
  baseUrl: string;
  port: number;
}

const activeServers: http.Server[] = [];
const testDataDirs: string[] = [];

/**
 * Starts a fresh server on a random port with an isolated in-memory database.
 * Returns the server and its base URL.
 */
export async function createTestServer(): Promise<TestServer> {
  // Close any existing DB so we start fresh
  if (isDbOpen()) closeDb();

  const cfg = createTestConfig();
  testDataDirs.push(cfg.dataDir);
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  // Set config before opening DB so routes and config proxy work
  setConfig(cfg);

  // Open an in-memory DB (isolated per test run)
  openDb(':memory:');

  // Start server passing the config directly to skip loadConfig
  const server = await startServer({ port: 0, host: '127.0.0.1', config: cfg });
  activeServers.push(server);

  const addr = server.address() as { port: number };
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return { server, baseUrl, port };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

/** Closes all test servers and the database. */
export async function cleanup(): Promise<void> {
  for (const server of activeServers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
  if (isDbOpen()) closeDb();
  for (const dir of testDataDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// ── HTTP fetch helpers ────────────────────────────────────────────────────────

interface FetchOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  cookie?: string;
}

export interface FetchResult {
  status: number;
  body: unknown;
  headers: Headers;
  cookie?: string;
}

/** Fetch a JSON endpoint on the test server. */
export async function fetchJson(
  baseUrl: string,
  urlPath: string,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'agent-portal',
    ...opts.headers,
  };
  if (opts.cookie) headers['Cookie'] = opts.cookie;

  const method = opts.method ?? (opts.body != null ? 'POST' : 'GET');

  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });

  let body: unknown;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    body = await res.json();
  } else {
    body = await res.text();
  }

  // Extract the name=value from the Set-Cookie header
  const setCookieHeader = res.headers.get('set-cookie') ?? '';
  const cookie = setCookieHeader ? setCookieHeader.split(';')[0] : undefined;

  return { status: res.status, body, headers: res.headers, cookie };
}
