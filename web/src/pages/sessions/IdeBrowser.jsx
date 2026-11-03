/**
 * IdeBrowser — Chrome-like live browser panel.
 *
 * Connects to WS /api/workflows/:id/browser/live and renders frames on a
 * <canvas> for flicker-free playback. Remote-control mode forwards mouse
 * + keyboard events to the agent's browser.
 *
 * Props:
 *   workflowId  string
 *   liveData    { url?, screenshotBase64?, recordedAt? } | null  — SSE fallback
 *   onPopOut    () => void   — called when user expands to main area
 *   onPopIn     () => void   — called when user collapses back to sidebar
 *   isPopped    boolean      — true when rendered in the main-area overlay
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { realtimeAvailable } from '../../lib/realtime.js';
import { Icon } from '../../components/Icon.jsx';

// AgentCore Live View (AWS DCV video stream of the agent's cloud browser). Loaded only when a cloud browser is open.
const BrowserLiveView = lazy(() =>
  import('../../../vendor/agentcore-live-view/BrowserLiveView.js').then((m) => ({ default: m.BrowserLiveView })));
const LIVE_POLL_MS = 5000;

// ── Constants ─────────────────────────────────────────────────────────────────
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000]; // exponential backoff ms
const MOVE_THROTTLE_MS = 33; // ~30 moves / second

// ── Helpers ───────────────────────────────────────────────────────────────────
function getModifiers(e) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

function tryHostname(url) {
  try { return new URL(url).hostname; } catch { return url || 'New tab'; }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusDot({ wsState, running }) {
  let dotColor, label;
  if (wsState === 'connected' && running) {
    dotColor = '#22c55e';
    label = 'Live';
  } else if (wsState === 'connected' && !running) {
    dotColor = '#f59e0b';
    label = 'Idle';
  } else if (wsState === 'connecting') {
    dotColor = 'var(--ink-3)';
    label = 'Connecting…';
  } else {
    dotColor = 'var(--ink-3)';
    label = 'Not running';
  }
  return (
    <span className="idb-status" aria-label={label} title={label}>
      <span className="idb-status-dot" style={{ background: dotColor }} />
      <span className="idb-status-label">{label}</span>
    </span>
  );
}

function ToggleSwitch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={`idb-toggle${checked ? ' is-on' : ''}`}
      onClick={onChange}
    >
      <span className="idb-toggle-knob" />
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * @param {{
 *   workflowId: string,
 *   liveData?:  { url?: string, screenshotBase64?: string, recordedAt?: string } | null,
 *   onPopOut?:  () => void,
 *   onPopIn?:   () => void,
 *   isPopped?:  boolean,
 * }} props
 */
export function IdeBrowser({ workflowId, liveData, onPopOut, onPopIn, isPopped }) {
  // ── Connection state ───────────────────────────────────────────────────────
  const [wsState, setWsState]         = useState('idle');    // idle|connecting|connected|disconnected
  const [wsError, setWsError]         = useState(null);

  // ── Cloud mode: the portal cannot hold a WebSocket, so the agent's browser is shown through AgentCore Live View ──
  const [cloudMode, setCloudMode]     = useState(null);      // null = not known yet
  const [live, setLive]               = useState(null);      // { url, sessionId, width, height } while a cloud browser is open

  // ── Browser state (from WS 'state' messages) ────────────────────────────
  const [running, setRunning]           = useState(false);
  const [controlEnabled, setControlEnabled] = useState(false);
  const [currentUrl, setCurrentUrl]     = useState('');
  const [pageTitle, setPageTitle]       = useState('');
  const [tabs, setTabs]                 = useState([]);

  // ── Local UI state ─────────────────────────────────────────────────────────
  const [addressInput, setAddressInput]     = useState('');
  const [addressFocused, setAddressFocused] = useState(false);
  const [hasFrame, setHasFrame]             = useState(false); // first live frame drawn
  const [viewportFocused, setViewportFocused] = useState(false);
  const [fallbackScreenshot, setFallbackScreenshot] = useState(null);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const canvasRef              = useRef(null);
  const wsRef                  = useRef(null);
  const reconnectTimerRef      = useRef(null);
  const reconnectAttemptRef    = useRef(0);
  const closedRef              = useRef(false);
  const frameDimsRef           = useRef({ w: 1280, h: 720 });
  const lastMoveRef            = useRef(0);
  const controlBusyRef         = useRef(false);
  const hasFrameRef            = useRef(false);
  const visibleRef             = useRef(!document.hidden);

  // ── Pause rendering when tab is in background ──────────────────────────────
  useEffect(() => {
    const handler = () => { visibleRef.current = !document.hidden; };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // ── Initial poll — fallback screenshot ────────────────────────────────────
  useEffect(() => {
    let active = true;
    api.get(`/api/workflows/${workflowId}/browser`).then((res) => {
      if (!active) return;
      if (res?.screenshotBase64) setFallbackScreenshot(res.screenshotBase64);
      if (res?.url) setCurrentUrl((u) => u || res.url);
    }).catch(() => {});
    return () => { active = false; };
  }, [workflowId]);

  // ── Sync address bar with currentUrl (when not editing) ────────────────────
  useEffect(() => {
    if (!addressFocused) setAddressInput(currentUrl);
  }, [currentUrl, addressFocused]);

  // ── Draw a JPEG frame onto the canvas (flicker-free) ──────────────────────
  const drawFrame = useCallback((base64, w, h) => {
    if (!visibleRef.current) return;
    if (w) frameDimsRef.current = { w, h: h || 720 };

    const doDraw = (bmpOrImg) => {
      const cv = canvasRef.current;
      if (!cv) return;
      const natural = bmpOrImg.width ?? bmpOrImg.naturalWidth;
      const naturalH = bmpOrImg.height ?? bmpOrImg.naturalHeight;
      if (cv.width !== natural)  cv.width  = natural;
      if (cv.height !== naturalH) cv.height = naturalH;
      const ctx = cv.getContext('2d');
      ctx.drawImage(bmpOrImg, 0, 0);
      if (typeof bmpOrImg.close === 'function') bmpOrImg.close(); // ImageBitmap
      if (!hasFrameRef.current) {
        hasFrameRef.current = true;
        setHasFrame(true);
      }
    };

    if (typeof createImageBitmap === 'function') {
      try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        createImageBitmap(blob).then(doDraw).catch(() => {});
      } catch { /* ignore bad frames */ }
    } else {
      // Fallback: Image element
      const img = new Image();
      img.onload = () => doDraw(img);
      img.src = `data:image/jpeg;base64,${base64}`;
    }
  }, []);

  // ── WebSocket lifecycle ───────────────────────────────────────────────────
  const sendWs = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    closedRef.current = false;
    if (cloudMode !== false) return undefined; // cloud: Live View below; unknown yet: wait

    function connect() {
      if (closedRef.current) return;
      setWsState('connecting');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/api/workflows/${encodeURIComponent(workflowId)}/browser/live`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (closedRef.current) { ws.close(); return; }
        reconnectAttemptRef.current = 0;
        setWsState('connected');
        setWsError(null);
      };

      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'frame') {
          if (msg.url)   setCurrentUrl(msg.url);
          if (msg.title) setPageTitle(msg.title);
          drawFrame(msg.data, msg.width, msg.height);

        } else if (msg.type === 'state') {
          setRunning(!!msg.running);
          setControlEnabled(!!msg.control);
          if (msg.url)   setCurrentUrl(msg.url);
          if (msg.title) setPageTitle(msg.title);
          if (Array.isArray(msg.tabs)) setTabs(msg.tabs);

        } else if (msg.type === 'error') {
          setWsError(msg.message || 'Browser error');
        }
      };

      ws.onerror = () => {
        setWsState('disconnected');
      };

      ws.onclose = () => {
        if (closedRef.current) return;
        setWsState('disconnected');
        const delay = RECONNECT_DELAYS[
          Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS.length - 1)
        ];
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    // Heartbeat ping
    const pingTimer = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);

    return () => {
      closedRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      clearInterval(pingTimer);
      const ws = wsRef.current;
      if (ws) { ws.close(); wsRef.current = null; }
    };
  }, [workflowId, drawFrame, cloudMode]);

  useEffect(() => {
    let cancelled = false;
    realtimeAvailable().then((v) => { if (!cancelled) setCloudMode(Boolean(v)); }).catch(() => { if (!cancelled) setCloudMode(false); });
    return () => { cancelled = true; };
  }, []);

  // While a cloud browser is open, ask the portal for a signed Live View address (and notice when it closes).
  useEffect(() => {
    if (cloudMode !== true) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const r = await api.get(`/api/workflows/${workflowId}/browser/live-view`);
        if (cancelled) return;
        if (r?.available && r.url) {
          // A new address is signed on every call, so keep the first one for as long as it is the same browser session.
          // A new browser session starts with the agent in control, so the switch starts off again.
          setLive((cur) => { if (!cur || cur.sessionId !== r.sessionId) setControlEnabled(false); return cur && cur.sessionId === r.sessionId ? cur : { url: r.url, sessionId: r.sessionId, width: r.width, height: r.height }; });
        } else {
          setLive(null);
        }
      } catch { /* try again on the next tick */ }
      if (!cancelled) timer = setTimeout(tick, LIVE_POLL_MS);
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [cloudMode, workflowId]);

  // ── Remote-control toggle ────────────────────────────────────────────────
  const handleControlToggle = useCallback(async () => {
    if (controlBusyRef.current) return;
    controlBusyRef.current = true;
    const next = !controlEnabled;
    setControlEnabled(next); // optimistic
    try {
      // cloud: pauses the agent's control of the browser (AgentCore) so the person can drive it through Live View
      await api.post(cloudMode ? `/api/workflows/${workflowId}/browser/live-view/control` : `/api/workflows/${workflowId}/browser/control`, { enabled: next });
    } catch {
      setControlEnabled((v) => !v); // revert on failure
    } finally {
      controlBusyRef.current = false;
    }
  }, [controlEnabled, workflowId, cloudMode]);

  // ── Coordinate mapping (CSS-pixel viewport → frame pixels) ────────────────
  const mapCoords = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { w, h } = frameDimsRef.current;
    const scaleX = w / rect.width;
    const scaleY = h / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top)  * scaleY),
    };
  }, []);

  // ── Mouse event forwarding ────────────────────────────────────────────────
  const handleMouseMove = useCallback((e) => {
    if (!controlEnabled) return;
    const now = Date.now();
    if (now - lastMoveRef.current < MOVE_THROTTLE_MS) return;
    lastMoveRef.current = now;
    const { x, y } = mapCoords(e);
    sendWs({ type: 'mouse', action: 'move', x, y, button: 'left', clickCount: 0, deltaX: 0, deltaY: 0, modifiers: getModifiers(e) });
  }, [controlEnabled, mapCoords, sendWs]);

  const handleMouseDown = useCallback((e) => {
    if (!controlEnabled) return;
    e.preventDefault();
    canvasRef.current?.focus();
    const { x, y } = mapCoords(e);
    const button = e.button === 0 ? 'left' : e.button === 1 ? 'middle' : 'right';
    sendWs({ type: 'mouse', action: 'down', x, y, button, clickCount: e.detail || 1, deltaX: 0, deltaY: 0, modifiers: getModifiers(e) });
  }, [controlEnabled, mapCoords, sendWs]);

  const handleMouseUp = useCallback((e) => {
    if (!controlEnabled) return;
    const { x, y } = mapCoords(e);
    const button = e.button === 0 ? 'left' : e.button === 1 ? 'middle' : 'right';
    sendWs({ type: 'mouse', action: 'up', x, y, button, clickCount: e.detail || 1, deltaX: 0, deltaY: 0, modifiers: getModifiers(e) });
  }, [controlEnabled, mapCoords, sendWs]);

  const handleWheel = useCallback((e) => {
    if (!controlEnabled) return;
    e.preventDefault();
    const { x, y } = mapCoords(e);
    sendWs({ type: 'mouse', action: 'wheel', x, y, button: 'left', clickCount: 0, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: getModifiers(e) });
  }, [controlEnabled, mapCoords, sendWs]);

  // ── Keyboard event forwarding (only when canvas is focused) ───────────────
  const handleKeyDown = useCallback((e) => {
    if (!controlEnabled || !viewportFocused) return;
    if (e.key === 'Escape') {
      // Escape releases focus back to the app — do NOT forward to browser
      canvasRef.current?.blur();
      setViewportFocused(false);
      return;
    }
    e.preventDefault();
    sendWs({ type: 'key', action: 'down', key: e.key, code: e.code, text: '', modifiers: getModifiers(e) });
    // Also send 'char' for printable keys
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      sendWs({ type: 'key', action: 'char', key: e.key, code: e.code, text: e.key, modifiers: getModifiers(e) });
    }
  }, [controlEnabled, viewportFocused, sendWs]);

  const handleKeyUp = useCallback((e) => {
    if (!controlEnabled || !viewportFocused) return;
    if (e.key === 'Escape') return;
    e.preventDefault();
    sendWs({ type: 'key', action: 'up', key: e.key, code: e.code, text: '', modifiers: getModifiers(e) });
  }, [controlEnabled, viewportFocused, sendWs]);

  // ── Navigation ────────────────────────────────────────────────────────────
  const handleAddressSubmit = useCallback((e) => {
    e.preventDefault();
    if (!controlEnabled) return;
    let url = addressInput.trim();
    if (url && !url.includes('://') && !url.startsWith('about:') && !url.startsWith('data:')) {
      url = `https://${url}`;
    }
    if (url) sendWs({ type: 'navigate', url });
    setAddressFocused(false);
  }, [addressInput, controlEnabled, sendWs]);

  // ── Tab switching ─────────────────────────────────────────────────────────
  const handleTabClick = useCallback((tabId) => {
    if (!controlEnabled) return;
    sendWs({ type: 'tab', id: tabId });
  }, [controlEnabled, sendWs]);

  // ── Toolbar nav ───────────────────────────────────────────────────────────
  const handleBack    = useCallback(() => { if (controlEnabled) sendWs({ type: 'back' });    }, [controlEnabled, sendWs]);
  const handleForward = useCallback(() => { if (controlEnabled) sendWs({ type: 'forward' }); }, [controlEnabled, sendWs]);
  const handleReload  = useCallback(() => { if (wsState === 'connected') sendWs({ type: 'reload' }); }, [wsState, sendWs]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const canControl = wsState === 'connected' && controlEnabled;

  // Build a synthetic tab list if the server hasn't sent any
  const tabList = tabs.length > 0
    ? tabs
    : currentUrl
      ? [{ id: '__default__', title: pageTitle || tryHostname(currentUrl), url: currentUrl, active: true }]
      : [];

  const showFallback = !hasFrame && !live && (liveData?.screenshotBase64 || fallbackScreenshot);
  const showEmpty    = !hasFrame && !live && !liveData?.screenshotBase64 && !fallbackScreenshot;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={`idb-panel${isPopped ? ' is-popped' : ''}`}>

      {/* ── Tab strip ──────────────────────────────────────────────────────── */}
      {tabList.length > 0 && (
        <div className="idb-tabstrip" role="tablist" aria-label="Browser tabs">
          {tabList.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={!!tab.active}
              className={`idb-tab${tab.active ? ' is-active' : ''}`}
              onClick={() => handleTabClick(tab.id)}
              title={tab.url}
            >
              <span className="idb-tab-title">{tab.title || tryHostname(tab.url)}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div className="idb-toolbar" role="toolbar" aria-label="Browser controls">
        {!cloudMode && (<>
        <button
          type="button"
          className="btn-icon"
          aria-label="Back"
          title="Back"
          onClick={handleBack}
          disabled={!canControl}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label="Forward"
          title="Forward"
          onClick={handleForward}
          disabled={!canControl}
        >
          <Icon name="chevron-right" size={14} />
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label="Reload"
          title="Reload"
          onClick={handleReload}
          disabled={wsState !== 'connected'}
        >
          <Icon name="refresh" size={14} />
        </button>

        {/* Address bar */}
        <form
          className="idb-address-form"
          onSubmit={handleAddressSubmit}
          aria-label="Address bar"
        >
          <input
            type="text"
            className={`idb-address${!controlEnabled ? ' is-readonly' : ''}`}
            value={addressFocused ? addressInput : (currentUrl || '')}
            readOnly={!controlEnabled}
            aria-label="URL"
            aria-readonly={!controlEnabled}
            placeholder="about:blank"
            onFocus={() => {
              if (!controlEnabled) return;
              setAddressFocused(true);
              setAddressInput(currentUrl);
            }}
            onBlur={() => {
              setAddressFocused(false);
              setAddressInput(currentUrl);
            }}
            onChange={(e) => setAddressInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setAddressFocused(false);
                setAddressInput(currentUrl);
                e.currentTarget.blur();
              }
            }}
          />
        </form>
        </>)}

        {/* Status dot */}
        <StatusDot wsState={cloudMode ? (live ? 'connected' : 'disconnected') : wsState} running={cloudMode ? Boolean(live) : running} />

        {/* Remote control toggle */}
        <div className="idb-remote-wrap">
          <span className="idb-remote-label">Remote</span>
          <ToggleSwitch
            checked={controlEnabled}
            onChange={handleControlToggle}
            label={controlEnabled ? 'Disable remote control' : 'Enable remote control'}
          />
        </div>

        {/* Pop-out / pop-in */}
        {onPopOut && !isPopped && (
          <button
            type="button"
            className="btn-icon"
            aria-label="Expand browser to main area"
            title="Expand to main area"
            onClick={onPopOut}
          >
            <Icon name="external" size={14} />
          </button>
        )}
        {onPopIn && isPopped && (
          <button
            type="button"
            className="btn-icon"
            aria-label="Collapse browser back to sidebar"
            title="Collapse to sidebar"
            onClick={onPopIn}
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>

      {/* ── Remote-control active banner ────────────────────────────────────── */}
      {controlEnabled && (
        <div className="idb-control-banner" role="status" aria-live="polite">
          <Icon name="warning" size={13} />
          {cloudMode ? 'You are controlling the browser — the agent is paused' : 'You are controlling the browser — the agent may also act'}
        </div>
      )}

      {/* ── Socket error inline ──────────────────────────────────────────────── */}
      {wsError && (
        <div className="idb-error-banner" role="alert">
          <Icon name="warning" size={13} />
          {wsError}
        </div>
      )}

      {/* ── Viewport ─────────────────────────────────────────────────────────── */}
      <div
        className={`idb-viewport${canControl ? ' can-control' : ''}`}
        aria-label="Live browser view"
      >
        {/* Live canvas — always mounted so the ref is stable */}
        <canvas
          ref={canvasRef}
          className={`idb-canvas${hasFrame ? ' is-visible' : ''}`}
          tabIndex={controlEnabled ? 0 : -1}
          aria-label="Live browser view"
          style={{ cursor: controlEnabled ? 'default' : 'default' }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onFocus={() => setViewportFocused(true)}
          onBlur={() => setViewportFocused(false)}
          onContextMenu={(e) => { if (controlEnabled) e.preventDefault(); }}
        />

        {/* AgentCore Live View: real video of the agent's cloud browser; the shield keeps it view-only until Remote is on */}
        {cloudMode && live && (
          <div className="idb-live-wrap">
            <Suspense fallback={null}>
              <BrowserLiveView key={live.sessionId} signedUrl={live.url} remoteWidth={live.width} remoteHeight={live.height} />
            </Suspense>
            {!controlEnabled && <div className="idb-live-shield" title="View only. Switch Remote on to take control." />}
          </div>
        )}

        {/* Fallback screenshot — shown before first live frame arrives */}
        {showFallback && (
          <img
            className="idb-fallback"
            src={`data:image/png;base64,${liveData?.screenshotBase64 || fallbackScreenshot}`}
            alt="Last known browser screenshot"
          />
        )}

        {/* Empty state — no browser activity yet */}
        {showEmpty && (
          <div className="idb-empty" aria-live="polite">
            <Icon name="browser" size={32} />
            <p>The agent&rsquo;s browser will appear here when it opens a page</p>
            {wsState === 'disconnected' && (
              <p style={{ fontSize: '0.77rem', opacity: 0.6, marginTop: 4 }}>
                Reconnecting…
              </p>
            )}
          </div>
        )}

        {/* View-only hover overlay (shown only when live and not in control mode) */}
        {hasFrame && !controlEnabled && (
          <div className="idb-viewonly-hint" aria-hidden="true">
            View only — turn on Remote control to interact
          </div>
        )}
      </div>
    </div>
  );
}
