/**
 * browser-live.ts — Live browser view WebSocket + control routes.
 *
 * Routes:
 *   POST /api/workflows/:id/browser/control
 *       Set remote-control toggle for the session browser (project editor only).
 *       Body: { enabled: boolean }
 *
 * WebSocket endpoint (upgrade, not HTTP):
 *   ws://.../api/workflows/:id/browser/live
 *       Streams Chrome CDP screencast frames to the browser panel.
 *       Authentication: session cookie only (API tokens rejected).
 *       Access: project member (read) for viewing, project editor for control.
 *
 * Server → client messages (JSON):
 *   { type: 'frame',  data: string, url: string, title: string, ts: number }
 *   { type: 'state',  running: boolean, control: boolean,
 *                     url: string|null, title: string|null,
 *                     tabs: Array<{id,title,url,active}> }
 *   { type: 'error',  message: string }
 *   { type: 'pong' }
 *
 * Client → server messages (JSON), accepted when control=enabled only:
 *   { type: 'mouse',    action: 'move'|'down'|'up'|'wheel',
 *                       x, y, button, clickCount, deltaX, deltaY, modifiers }
 *   { type: 'key',      action: 'down'|'up'|'char',
 *                       key, code, text, modifiers }
 *   { type: 'navigate', url: string }   — http/https only
 *   { type: 'back' }
 *   { type: 'forward' }
 *   { type: 'reload' }
 *   { type: 'tab',      id: string }
 *   { type: 'ping' }
 */

import { createHash } from 'node:crypto';
import http from 'node:http';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import type WebSocket from 'ws';
import { router, sendJson, parseCookies } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, getDb } from './db.ts';
import type { Row } from './db.ts';
import { appendAudit } from './audit.ts';
import {
  getSessionBrowserState,
  setControlEnabled,
  addViewer,
  removeViewer,
  updateLatestFrame,
  markAgentActivity,
} from './agent/browser-manager.ts';
import type { LatestFrame } from './agent/browser-manager.ts';

import { getMemberRow } from './project-access.ts';
// ── Auth helpers (mirrors terminal.ts) ───────────────────────────────────────

interface AuthResult {
  userId: string;
  isAdmin: boolean;
}

function authenticateUpgrade(req: http.IncomingMessage): AuthResult | null {
  const cookieHeader = req.headers.cookie ?? '';
  if (!cookieHeader) return null;
  const cookies = parseCookies(cookieHeader);
  const token = cookies['portal_session'];
  if (!token) return null;

  const tokenHash = createHash('sha256').update(decodeURIComponent(token)).digest('hex');
  const row = one<{ id: string; is_admin: number; disabled: number; expires_at: string }>(
    `SELECT u.id, u.is_admin, u.disabled, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    tokenHash,
  );
  if (!row) return null;
  if (row.disabled) return null;
  if (row.expires_at < new Date().toISOString()) return null;

  return { userId: row.id, isAdmin: Boolean(row.is_admin) };
}

function checkOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host ?? '';
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Require project read access for a workflow. */
async function canReadWorkflow(userId: string, isAdmin: boolean, workflowId: string): Promise<Row | undefined> {
  if (isAdmin) {
    return one<Row>('SELECT * FROM p6_workflows WHERE id = ?', workflowId);
  }
  const wf = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', workflowId);
  if (!wf || !wf.project_id) return undefined;
  const member = await getMemberRow(String(wf.project_id), userId);
  return member ? wf : undefined;
}

/** Require project editor access for a workflow (for control toggle). */
async function canWriteWorkflow(userId: string, isAdmin: boolean, workflowId: string): Promise<boolean> {
  if (isAdmin) return true;
  const wf = one<Row>('SELECT project_id FROM p6_workflows WHERE id = ?', workflowId);
  if (!wf || !wf.project_id) return false;
  const member = await getMemberRow(String(wf.project_id), userId);
  if (!member) return false;
  return ['editor', 'owner'].includes(String(member.access));
}

// ── URL validation ────────────────────────────────────────────────────────────

function validateNavigateUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'Invalid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http and https URLs are allowed';
  }
  return null; // ok
}

// ── CDP helpers ───────────────────────────────────────────────────────────────

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function fetchCdpTargets(cdpEndpoint: string): Promise<CdpTarget[]> {
  const res = await fetch(`${cdpEndpoint}/json`, { signal: AbortSignal.timeout(3000) });
  const list = (await res.json()) as CdpTarget[];
  return list.filter((t) => t.type === 'page');
}

// ── Rate limiter ──────────────────────────────────────────────────────────────

function makeRateLimiter(maxPerSec: number): () => boolean {
  let count = 0;
  let windowStart = Date.now();
  return () => {
    const now = Date.now();
    if (now - windowStart > 1000) { count = 0; windowStart = now; }
    count++;
    return count <= maxPerSec;
  };
}

// ── WebSocket server ──────────────────────────────────────────────────────────

let _wss: WebSocketServer | null = null;

function getWss(): WebSocketServer {
  if (!_wss) _wss = new WebSocketServer({ noServer: true });
  return _wss;
}

// ── Live session handler ──────────────────────────────────────────────────────

/**
 * Manage one live browser WebSocket connection.
 * Connects to Chrome CDP, streams screencast frames, and handles control input.
 */
async function handleLiveSession(
  ws: WebSocket,
  workflowId: string,
  auth: AuthResult,
): Promise<void> {
  const safeSend = (msg: object): void => {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    } catch { /* ignore */ }
  };

  // Check if browser is running for this session
  const browserState = getSessionBrowserState(workflowId);
  if (!browserState) {
    safeSend({ type: 'state', running: false, control: false, url: null, title: null, tabs: [] });
    ws.close();
    return;
  }

  addViewer(workflowId);

  const { cdpEndpoint } = browserState;
  let closed = false;
  let cdpWs: InstanceType<typeof WsClient> | null = null;
  let currentTargetId: string | null = null;
  let currentUrl: string | null = null;
  let currentTitle: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let msgIdSeq = 1;
  const pendingRpc = new Map<number, (result: unknown) => void>();

  const rateCheck = makeRateLimiter(60);

  function cleanup(): void {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (cdpWs) {
      try { cdpWs.close(); } catch { /* ignore */ }
      cdpWs = null;
    }
    removeViewer(workflowId);
  }

  function sendCdp(method: string, params?: object): Promise<unknown> {
    const id = msgIdSeq++;
    return new Promise<unknown>((resolve) => {
      pendingRpc.set(id, resolve);
      try {
        cdpWs?.send(JSON.stringify({ id, method, params: params ?? {} }));
      } catch {
        pendingRpc.delete(id);
        resolve(null);
      }
      // Resolve after 5 s even if no response
      setTimeout(() => {
        if (pendingRpc.has(id)) { pendingRpc.delete(id); resolve(null); }
      }, 5000).unref?.();
    });
  }

  async function sendStateUpdate(): Promise<void> {
    try {
      const state = getSessionBrowserState(workflowId);
      const targets = await fetchCdpTargets(cdpEndpoint).catch(() => [] as CdpTarget[]);
      const tabs = targets.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.id === currentTargetId,
      }));
      safeSend({
        type: 'state',
        running: Boolean(state),
        control: state?.controlEnabled ?? false,
        url: currentUrl,
        title: currentTitle,
        tabs,
        agentActive: Boolean(state),
      });
    } catch { /* ignore */ }
  }

  async function connectToTarget(target: CdpTarget): Promise<void> {
    if (cdpWs) {
      try { cdpWs.close(); } catch { /* ignore */ }
      cdpWs = null;
      pendingRpc.clear();
    }

    currentTargetId = target.id;
    currentUrl = target.url !== 'about:blank' ? target.url : null;
    currentTitle = target.title || null;

    const ws2 = new WsClient(target.webSocketDebuggerUrl);
    cdpWs = ws2;

    ws2.on('open', async () => {
      if (closed) { ws2.close(); return; }
      await sendCdp('Page.enable', {});
      await sendCdp('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: 1280,
        everyNthFrame: 1,
      });
      await sendStateUpdate();
    });

    ws2.on('message', (raw: Buffer) => {
      if (closed) return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; }
      catch { return; }

      // RPC response
      if (typeof msg.id === 'number' && pendingRpc.has(msg.id)) {
        pendingRpc.get(msg.id)!(msg.result);
        pendingRpc.delete(msg.id);
        return;
      }

      const method = msg.method as string | undefined;
      if (!method) return;

      if (method === 'Page.screencastFrame') {
        const params = msg.params as {
          data: string;
          metadata: { timestamp?: number; deviceWidth?: number; deviceHeight?: number };
          sessionId: number;
        };
        const frame: LatestFrame = {
          dataBase64: params.data,
          url: currentUrl ?? '',
          title: currentTitle ?? '',
          ts: Date.now(),
        };
        updateLatestFrame(workflowId, frame);
        markAgentActivity(workflowId);
        // width/height are the page viewport in CSS pixels (what Input.dispatchMouseEvent
        // expects), not the possibly downscaled JPEG size. The viewer maps clicks with them.
        safeSend({
          type: 'frame',
          data: params.data,
          url: currentUrl,
          title: currentTitle,
          ts: frame.ts,
          width: params.metadata?.deviceWidth,
          height: params.metadata?.deviceHeight,
        });
        // Ack the frame to keep the stream flowing
        sendCdp('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {/* ok */});
      } else if (method === 'Page.frameNavigated') {
        const frame = (msg.params as { frame?: { url?: string; id?: string } })?.frame;
        if (frame?.url) {
          currentUrl = frame.url !== 'about:blank' ? frame.url : currentUrl;
          sendStateUpdate().catch(() => {/* ignore */});
        }
      } else if (method === 'Page.navigatedWithinDocument') {
        const urlParam = (msg.params as { url?: string })?.url;
        if (urlParam) {
          currentUrl = urlParam;
          sendStateUpdate().catch(() => {/* ignore */});
        }
      } else if (method === 'Target.targetDestroyed') {
        // Current page was closed — will reconnect on next poll
      }
    });

    ws2.on('close', () => {
      if (cdpWs === ws2) {
        cdpWs = null;
        currentTargetId = null;
      }
      pendingRpc.clear();
    });

    ws2.on('error', () => {
      if (cdpWs === ws2) {
        cdpWs = null;
        currentTargetId = null;
      }
      pendingRpc.clear();
    });
  }

  // Initial state
  safeSend({ type: 'state', running: true, control: browserState.controlEnabled, url: null, title: null, tabs: [] });

  // Try to connect to a page target, polling until one appears (max ~30 s)
  let connectAttempts = 0;
  async function tryConnectInitial(): Promise<void> {
    if (closed) return;
    const targets = await fetchCdpTargets(cdpEndpoint).catch(() => [] as CdpTarget[]);
    if (targets.length > 0) {
      await connectToTarget(targets[targets.length - 1]);
      return;
    }
    connectAttempts++;
    if (connectAttempts < 60) {
      setTimeout(tryConnectInitial, 500).unref?.();
    } else {
      safeSend({ type: 'state', running: true, control: false, url: null, title: null, tabs: [] });
    }
  }

  tryConnectInitial().catch(() => {/* ignore */});

  // Poll for new/changed targets to follow tab switches and new pages
  pollTimer = setInterval(async () => {
    if (closed) return;
    const targets = await fetchCdpTargets(cdpEndpoint).catch(() => null);
    if (!targets) return;

    if (targets.length === 0) return;

    // Switch to the most-recently created page if current target is gone or if
    // there's now only one target and we're not connected
    const mostRecent = targets[targets.length - 1];
    if (!currentTargetId || !targets.find((t) => t.id === currentTargetId)) {
      await connectToTarget(mostRecent).catch(() => {/* ignore */});
    }
  }, 2000);
  if (typeof pollTimer === 'object' && pollTimer !== null && 'unref' in pollTimer) {
    (pollTimer as { unref(): void }).unref();
  }

  // ── Handle messages from the portal client ─────────────────────────────────
  ws.on('message', (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; }
    catch { return; }

    const msgType = String(msg.type ?? '');

    if (msgType === 'ping') {
      safeSend({ type: 'pong' });
      return;
    }

    // All other messages require control to be enabled
    const state = getSessionBrowserState(workflowId);
    if (!state?.controlEnabled) {
      safeSend({ type: 'error', message: 'Remote control is not enabled for this session' });
      return;
    }

    // Rate limit input events
    if (!rateCheck()) {
      safeSend({ type: 'error', message: 'Input rate limit exceeded' });
      return;
    }

    switch (msgType) {
      case 'mouse': {
        if (!cdpWs || cdpWs.readyState !== cdpWs.OPEN) {
          safeSend({ type: 'error', message: 'No active browser page to control' });
          break;
        }
        const action = String(msg.action ?? '');
        const cdpAction: Record<string, string> = {
          move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased', wheel: 'mouseWheel',
        };
        const cdpType = cdpAction[action];
        if (!cdpType) break;
        sendCdp('Input.dispatchMouseEvent', {
          type: cdpType,
          x: Number(msg.x ?? 0),
          y: Number(msg.y ?? 0),
          button: String(msg.button ?? 'none'),
          clickCount: Number(msg.clickCount ?? 0),
          deltaX: Number(msg.deltaX ?? 0),
          deltaY: Number(msg.deltaY ?? 0),
          modifiers: Number(msg.modifiers ?? 0),
        }).catch(() => {/* ignore */});
        break;
      }
      case 'key': {
        if (!cdpWs || cdpWs.readyState !== cdpWs.OPEN) {
          safeSend({ type: 'error', message: 'No active browser page to control' });
          break;
        }
        const action = String(msg.action ?? '');
        const cdpKeyAction: Record<string, string> = {
          down: 'keyDown', up: 'keyUp', char: 'char',
        };
        const cdpType = cdpKeyAction[action];
        if (!cdpType) break;
        sendCdp('Input.dispatchKeyEvent', {
          type: cdpType,
          key: String(msg.key ?? ''),
          code: String(msg.code ?? ''),
          text: String(msg.text ?? ''),
          modifiers: Number(msg.modifiers ?? 0),
        }).catch(() => {/* ignore */});
        break;
      }
      case 'navigate': {
        const url = String(msg.url ?? '');
        const urlErr = validateNavigateUrl(url);
        if (urlErr) {
          safeSend({ type: 'error', message: urlErr });
          break;
        }
        if (!cdpWs || cdpWs.readyState !== cdpWs.OPEN) {
          safeSend({ type: 'error', message: 'No active browser page to control' });
          break;
        }
        sendCdp('Page.navigate', { url }).catch(() => {/* ignore */});
        break;
      }
      case 'back':
        if (!cdpWs || cdpWs.readyState !== cdpWs.OPEN) break;
        sendCdp('Page.goBack', {}).catch(() => {/* ignore */});
        break;
      case 'forward':
        if (!cdpWs || cdpWs.readyState !== cdpWs.OPEN) break;
        sendCdp('Page.goForward', {}).catch(() => {/* ignore */});
        break;
      case 'reload':
        if (!cdpWs || cdpWs.readyState !== cdpWs.OPEN) break;
        sendCdp('Page.reload', {}).catch(() => {/* ignore */});
        break;
      case 'tab': {
        const targetId = String(msg.id ?? '');
        if (!targetId) break;
        fetchCdpTargets(cdpEndpoint).then(async (targets) => {
          const target = targets.find((t) => t.id === targetId);
          if (target) await connectToTarget(target).catch(() => {/* ignore */});
        }).catch(() => {/* ignore */});
        break;
      }
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

// ── WebSocket upgrade handler ─────────────────────────────────────────────────

const LIVE_PATH_RE = /^\/api\/workflows\/([^/]+)\/browser\/live$/;

/**
 * Handle WebSocket upgrade for /api/workflows/:id/browser/live.
 * Called from the combined upgrade handler in index.ts.
 */
export async function handleBrowserLiveUpgrade(
  req: http.IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = LIVE_PATH_RE.exec(url.pathname);
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // Origin check (CSRF-equivalent)
  if (!checkOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // API tokens are explicitly refused — browser session only
  if (req.headers.authorization) {
    socket.write(
      'HTTP/1.1 403 Forbidden\r\nX-Browser-Error: API tokens cannot be used for live browser access\r\nConnection: close\r\n\r\n',
    );
    socket.destroy();
    return;
  }

  const auth = authenticateUpgrade(req);
  if (!auth) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const workflowId = match[1];

  // Check project membership
  const wf = await canReadWorkflow(auth.userId, auth.isAdmin, workflowId);
  if (!wf) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  getWss().handleUpgrade(req, socket, head, (ws) => {
    handleLiveSession(ws, workflowId, auth).catch((err: unknown) => {
      console.error('[browser-live] Unhandled session error:', err);
      try { ws.close(); } catch { /* ignore */ }
    });
  });
}

// ── HTTP routes ───────────────────────────────────────────────────────────────

export function registerBrowserLiveRoutes(): void {
  // POST /api/workflows/:id/browser/control
  router.post(
    '/api/workflows/:id/browser/control',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!req.user) {
        sendJson(res, 401, { error: 'Sign in to continue' });
        return;
      }
      if (req.authViaToken) {
        sendJson(res, 403, { error: 'This endpoint requires browser authentication, not an API token' });
        return;
      }

      const workflowId = req.params.id;
      if (!await canWriteWorkflow(req.user.id, Boolean(req.user.is_admin), workflowId)) {
        sendJson(res, 403, { error: 'Project editor access required' });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const enabled = Boolean(body.enabled);

      const browserState = getSessionBrowserState(workflowId);
      if (!browserState) {
        sendJson(res, 404, { error: 'No live browser is running for this session' });
        return;
      }

      setControlEnabled(workflowId, enabled);

      try {
        appendAudit(
          getDb(),
          req.user!.id,
          'session.browser.control',
          `workflow:${workflowId}`,
          { enabled },
          req.ip,
        );
      } catch { /* best-effort audit */ }

      sendJson(res, 200, { control: enabled });
    },
  );
}
