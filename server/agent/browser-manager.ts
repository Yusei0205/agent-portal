/**
 * browser-manager.ts — Per-session Chromium browser manager.
 *
 * Launches one Chromium instance per active workflow session and exposes it via
 * a CDP HTTP endpoint (http://127.0.0.1:<port>).  The Playwright MCP entry in
 * the materialised home dir is then rewritten to use `--cdp-endpoint` so the
 * agent connects to this browser instead of launching its own.
 *
 * The portal's live-view WebSocket connects to the same CDP HTTP endpoint to
 * stream Page.startScreencast frames to the browser panel.
 *
 * Lifecycle:
 *   launchSessionBrowser(workflowId, workDir)  → CDP endpoint URL
 *   shutdownSessionBrowser(workflowId)         → close browser
 *   shutdownAllBrowsers()                      → server shutdown
 *
 * Idle shutdown: when no viewers are connected and no agent activity has
 * occurred for VIEWER_IDLE_MS, the browser is closed automatically.
 *
 * Concurrency: capped at PORTAL_BROWSER_MAX (default 4).
 */

import net from 'node:net';
import path from 'node:path';
import fsp from 'node:fs/promises';

// ── Public types ──────────────────────────────────────────────────────────────

export interface LatestFrame {
  dataBase64: string;  // JPEG, base64-encoded
  url: string;
  title: string;
  ts: number;          // Date.now()
}

export interface SessionBrowserState {
  running: true;
  cdpEndpoint: string;
  controlEnabled: boolean;
  latestFrame: LatestFrame | null;
}

// ── Internal state ────────────────────────────────────────────────────────────

interface BrowserHandle {
  close(): Promise<void>;
  on(event: 'disconnected', cb: () => void): void;
}

interface SessionRecord {
  workflowId: string;
  port: number;
  cdpEndpoint: string;
  browser: BrowserHandle;
  controlEnabled: boolean;
  lastActivity: number;
  activeViewers: number;
  latestFrame: LatestFrame | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const _sessions = new Map<string, SessionRecord>();

// ── Constants ─────────────────────────────────────────────────────────────────

const VIEWER_IDLE_MS = 10 * 60_000;  // shut down after 10 min with no viewers + no activity

// ── Helpers ───────────────────────────────────────────────────────────────────

function allocFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function loadChromium(): Promise<{ launch(opts: object): Promise<BrowserHandle> }> {
  try {
    const pw = await import('playwright');
    return pw.chromium as unknown as { launch(opts: object): Promise<BrowserHandle> };
  } catch {
    const pw = await import('playwright-core');
    return pw.chromium as unknown as { launch(opts: object): Promise<BrowserHandle> };
  }
}

function scheduleIdleShutdown(rec: SessionRecord): void {
  if (rec.idleTimer) clearTimeout(rec.idleTimer);
  const t = setTimeout(async () => {
    rec.idleTimer = null;
    if (_sessions.get(rec.workflowId) !== rec || rec.activeViewers > 0) return;
    if (Date.now() - rec.lastActivity >= VIEWER_IDLE_MS) {
      await shutdownSessionBrowser(rec.workflowId).catch(() => {/* ignore */});
    } else {
      // Agent was active during the window; check again later.
      scheduleIdleShutdown(rec);
    }
  }, VIEWER_IDLE_MS);
  if (typeof t === 'object' && t !== null && 'unref' in t) {
    (t as { unref(): void }).unref();
  }
  rec.idleTimer = t;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Launch a Chromium browser for the given workflow session.
 * Returns the CDP HTTP endpoint (http://127.0.0.1:<port>).
 * Reuses the existing browser if already running for this session.
 * Throws when the concurrent browser cap is reached.
 */
export async function launchSessionBrowser(workflowId: string, workDir: string): Promise<string> {
  const existing = _sessions.get(workflowId);
  if (existing) return existing.cdpEndpoint;

  if (_sessions.size >= Number(process.env.PORTAL_BROWSER_MAX ?? '4')) {
    throw new Error(
      `Portal browser limit reached (${process.env.PORTAL_BROWSER_MAX ?? '4'} concurrent sessions). ` +
        `Stop another session first, or set PORTAL_BROWSER_MAX to increase the limit.`,
    );
  }

  const chromium = await loadChromium();
  const port = await allocFreePort();
  const browserDir = path.join(workDir, '.browser');
  await fsp.mkdir(browserDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
    ],
  });

  const cdpEndpoint = `http://127.0.0.1:${port}`;
  const rec: SessionRecord = {
    workflowId,
    port,
    cdpEndpoint,
    browser,
    controlEnabled: false,
    lastActivity: Date.now(),
    activeViewers: 0,
    latestFrame: null,
    idleTimer: null,
  };

  browser.on('disconnected', () => {
    _sessions.delete(workflowId);
    if (rec.idleTimer) clearTimeout(rec.idleTimer);
  });

  _sessions.set(workflowId, rec);
  // Start the idle clock now so a browser that nobody ever views still closes.
  scheduleIdleShutdown(rec);
  return cdpEndpoint;
}

/** Return the public session browser state, or null if not running. */
export function getSessionBrowserState(workflowId: string): SessionBrowserState | null {
  const rec = _sessions.get(workflowId);
  if (!rec) return null;
  return {
    running: true,
    cdpEndpoint: rec.cdpEndpoint,
    controlEnabled: rec.controlEnabled,
    latestFrame: rec.latestFrame,
  };
}

/** Mark recent agent activity; resets the idle shutdown timer. */
export function markAgentActivity(workflowId: string): void {
  const rec = _sessions.get(workflowId);
  if (rec) rec.lastActivity = Date.now();
}

/** Enable or disable remote control input for the session. */
export function setControlEnabled(workflowId: string, enabled: boolean): void {
  const rec = _sessions.get(workflowId);
  if (rec) rec.controlEnabled = enabled;
}

/** Increment the viewer count; resets the idle timer while viewers are connected. */
export function addViewer(workflowId: string): void {
  const rec = _sessions.get(workflowId);
  if (!rec) return;
  rec.activeViewers++;
  rec.lastActivity = Date.now();
  if (rec.idleTimer) {
    clearTimeout(rec.idleTimer);
    rec.idleTimer = null;
  }
}

/** Decrement the viewer count and start the idle shutdown timer when none remain. */
export function removeViewer(workflowId: string): void {
  const rec = _sessions.get(workflowId);
  if (!rec) return;
  rec.activeViewers = Math.max(0, rec.activeViewers - 1);
  if (rec.activeViewers === 0) scheduleIdleShutdown(rec);
}

/** Store the latest screen frame (for the GET /browser REST endpoint). */
export function updateLatestFrame(workflowId: string, frame: LatestFrame): void {
  const rec = _sessions.get(workflowId);
  if (rec) rec.latestFrame = frame;
}

/** Close the browser for a session. Safe to call when not running. */
export async function shutdownSessionBrowser(workflowId: string): Promise<void> {
  const rec = _sessions.get(workflowId);
  if (!rec) return;
  _sessions.delete(workflowId);
  if (rec.idleTimer) clearTimeout(rec.idleTimer);
  try { await rec.browser.close(); } catch { /* browser may already be gone */ }
}

/** Close all session browsers. Called on server shutdown. */
export async function shutdownAllBrowsers(): Promise<void> {
  const ids = [..._sessions.keys()];
  await Promise.allSettled(ids.map((id) => shutdownSessionBrowser(id)));
}
