/**
 * xterm.js terminal — dynamically imported to keep it out of the main bundle.
 *
 * PTY mode (server reports pty: true):
 *   Keystrokes are forwarded raw; the PTY handles echo, line-editing,
 *   tab completion, Ctrl+C, arrow-key history, and clear/cls natively.
 *
 * Pipe mode (server reports pty: false — Windows without node-pty):
 *   Local echo + line buffering via LineBuffer. clear/cls handled locally.
 *   Doubled echo from cmd.exe is suppressed via LineBuffer.filterOutput.
 *   A hint is shown: interactive programs and tab completion unavailable.
 *
 * Scroll fix (2025):
 *   - scrollback raised to 5000 lines.
 *   - The container (.ide-terminal-host) no longer has padding or
 *     overflow:hidden (both caused FitAddon to miscalculate available height
 *     under box-sizing:border-box, which clipped the scrollbar and last row).
 *   - Initial fit is deferred to requestAnimationFrame so the container has
 *     been laid out before FitAddon measures it.
 *   - ResizeObserver on the container re-runs fit on every size change:
 *     panel drag, sidebar toggle, window resize.
 *   - New cols/rows are sent to the server via the existing resize message.
 *
 * Copy/paste:
 *   - copyOnSelect: true (selection auto-copies to clipboard)
 *   - Ctrl+Shift+C: copy selection
 *   - Ctrl+Shift+V: paste from clipboard
 *   - Ctrl+V in PTY mode is forwarded to the shell (standard terminal behaviour)
 *
 * Theme:
 *   - Colours read from CSS variables on .ide-terminal-panel at mount time
 *     so all app themes can re-skin the terminal.  Hardcoded VS Code Dark+
 *     fallbacks are used when the variables are not defined.
 */
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { LineBuffer } from '../../lib/terminal-pipe.js';

// ── Theme helpers ─────────────────────────────────────────────────────────────

/**
 * Read a CSS custom property from `el` (or its computed style).
 * Returns `fallback` when the variable is not defined or empty.
 *
 * @param {Element} el
 * @param {string}  name     CSS variable name, e.g. '--term-bg'
 * @param {string}  fallback
 * @returns {string}
 */
function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Build an xterm Theme object from CSS variables defined on the terminal
 * panel element.  Defaults are VS Code Dark+ colours so the terminal looks
 * correct even before any theme customisation.
 *
 * Themes that want to restyle the terminal can override the --term-* variables
 * on .ide-terminal-panel in their theme CSS file.
 *
 * @param {Element} el  - element to read variables from (closest .ide-terminal-panel)
 * @returns {import('@xterm/xterm').ITheme}
 */
function buildTheme(el) {
  const g = (n, fb) => cssVar(el, n, fb);
  return {
    background:          g('--term-bg',            '#1e1e1e'),
    foreground:          g('--term-fg',            '#d4d4d4'),
    cursor:              g('--term-cursor',        '#d4d4d4'),
    cursorAccent:        g('--term-bg',            '#1e1e1e'),
    selectionBackground: g('--term-selection',     'rgba(255,255,255,0.2)'),
    black:               g('--term-black',         '#000000'),
    red:                 g('--term-red',           '#cd3131'),
    green:               g('--term-green',         '#0dbc79'),
    yellow:              g('--term-yellow',        '#e5e510'),
    blue:                g('--term-blue',          '#2472c8'),
    magenta:             g('--term-magenta',       '#bc3fbc'),
    cyan:                g('--term-cyan',          '#11a8cd'),
    white:               g('--term-white',         '#e5e5e5'),
    brightBlack:         g('--term-bright-black',  '#666666'),
    brightRed:           g('--term-bright-red',    '#f14c4c'),
    brightGreen:         g('--term-bright-green',  '#23d18b'),
    brightYellow:        g('--term-bright-yellow', '#f5f543'),
    brightBlue:          g('--term-bright-blue',   '#3b8eea'),
    brightMagenta:       g('--term-bright-magenta','#d670d6'),
    brightCyan:          g('--term-bright-cyan',   '#29b8db'),
    brightWhite:         g('--term-bright-white',  '#e5e5e5'),
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   workflowId: string,
 *   onClose?: () => void,
 * }} props
 */
export function XtermTerminal({ workflowId, onClose }) {
  const containerRef   = useRef(null);
  const termRef        = useRef(null);
  const fitRef         = useRef(null);
  const wsRef          = useRef(null);
  const reconnectTimer = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Read theme from the closest panel element (set in ide.css).
    const panelEl = container.closest('.ide-terminal-panel') ?? container;

    const term = new Terminal({
      theme:        buildTheme(panelEl),
      fontSize:     13,
      fontFamily:   'var(--mono, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace)',
      convertEol:   true,
      scrollback:   5000,
      cursorBlink:  true,
      // Copy selected text to clipboard automatically (like most terminal emulators)
      copyOnSelect: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // Defer the first fit so the browser has completed layout for the
    // container before FitAddon measures it.  Without this, the container
    // may still report zero height immediately after mount.
    requestAnimationFrame(() => {
      try { fit.fit(); } catch { /* ignore — terminal may be disposed already */ }
      term.focus();
    });

    termRef.current = term;
    fitRef.current  = fit;

    // Re-fit whenever the container changes size (panel drag, sidebar toggle,
    // window resize — all propagate through the CSS flex chain to the container).
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* ignore */ }
    });
    ro.observe(container);

    let closed = false;

    // ── Pipe-mode state ───────────────────────────────────────────────────
    // isPty: optimistic true; updated from the server's 'ready' message.
    // lineBuffer: handles local echo, line accumulation, and echo suppression.
    // shell: shell name reported by the server (e.g. 'powershell').
    const pipeState = {
      isPty:      true,
      lineBuffer: new LineBuffer(),
      shell:      /** @type {string|null} */ (null),
    };

    // ── WebSocket connection ──────────────────────────────────────────────

    function connect() {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url   = `${proto}//${location.host}/api/terminal/ws?workflowId=${encodeURIComponent(workflowId)}`;
      const ws    = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        term.writeln('\r\n\x1b[32m● Terminal connected\x1b[0m\r\n');
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);

          if (msg.type === 'ready') {
            pipeState.isPty  = msg.pty !== false;
            pipeState.shell  = msg.shell ?? null;
            pipeState.lineBuffer.reset(); // clear stale state on (re)connect

            if (!pipeState.isPty) {
              // Pipe-mode: warn that interactive features are unavailable
              term.writeln(
                '\r\n\x1b[90m⚠ Basic terminal mode: interactive programs and tab completion are unavailable.\x1b[0m\r\n',
              );
            }

            // Honour the server's reported dimensions if they differ from ours
            const cols = msg.cols || term.cols;
            const rows = msg.rows || term.rows;
            if (cols !== term.cols || rows !== term.rows) {
              term.resize(cols, rows);
            }

          } else if (msg.type === 'output') {
            const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
            if (!pipeState.isPty && bytes.length > 0) {
              // In pipe mode, attempt to strip cmd.exe's command echo
              const text     = new TextDecoder().decode(bytes);
              const filtered = pipeState.lineBuffer.filterOutput(text);
              term.write(filtered !== text
                ? new TextEncoder().encode(filtered)
                : bytes);
            } else {
              term.write(bytes);
            }

          } else if (msg.type === 'exit') {
            term.writeln(`\r\n\x1b[90mProcess exited (${msg.code})\x1b[0m`);
            wsRef.current = null;

          } else if (msg.type === 'error') {
            term.writeln(`\r\n\x1b[31mError: ${msg.message}\x1b[0m`);

          } else if (msg.type === 'pong') {
            // heartbeat acknowledgement — no action needed
          }
        } catch { /* ignore malformed messages */ }
      };

      ws.onerror = () => {
        term.writeln('\r\n\x1b[31m● Connection error\x1b[0m');
      };

      ws.onclose = () => {
        if (closed) return;
        term.writeln('\r\n\x1b[90m● Disconnected. Reconnecting in 3s…\x1b[0m');
        reconnectTimer.current = setTimeout(connect, 3000);
      };
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    /** Encode a UTF-8 string to base64 for the WebSocket input message. */
    function encodeInput(str) {
      const bytes = new TextEncoder().encode(str);
      return btoa(String.fromCharCode(...bytes));
    }

    /** Copy the current selection to the system clipboard (best-effort). */
    function copySelection() {
      const sel = term.getSelection();
      if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
    }

    /** Read from the system clipboard and forward to the active shell. */
    function pasteFromClipboard() {
      const ws = wsRef.current;
      navigator.clipboard?.readText().then((text) => {
        if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
        if (pipeState.isPty) {
          // PTY: send raw to the shell
          ws.send(JSON.stringify({ type: 'input', data: encodeInput(text) }));
        } else {
          // Pipe: insert each printable character into the line buffer and echo
          for (const ch of text) {
            if (ch.charCodeAt(0) >= 0x20) {
              const r = pipeState.lineBuffer.handleKey(ch);
              if (r.echo) term.write(r.echo);
            }
          }
        }
      }).catch(() => {});
    }

    // Intercept Ctrl+Shift+C (copy) and Ctrl+Shift+V (paste) before the
    // events can reach the PTY, so clipboard operations always work.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.shiftKey) {
        if (e.key === 'C') { copySelection();      return false; }
        if (e.key === 'V') { pasteFromClipboard(); return false; }
      }
      return true; // let everything else through to xterm / PTY
    });

    // ── Input handler ─────────────────────────────────────────────────────

    term.onData((data) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      if (!pipeState.isPty) {
        // ── Pipe mode: local echo + line buffer ──────────────────────────
        const r = pipeState.lineBuffer.handleKey(data);
        if (r.echo) term.write(r.echo);
        if (r.clear) {
          // Handle clear/cls locally; do NOT send to the server (cmd.exe's
          // cls would be a no-op over a pipe and would generate noise).
          term.clear();
          return;
        }
        if (r.send !== null) {
          ws.send(JSON.stringify({ type: 'input', data: encodeInput(r.send) }));
        }
        return;
      }

      // ── PTY mode: forward raw bytes straight to the shell ─────────────
      // The PTY handles echo, line-editing, tab completion, Ctrl+C, etc.
      ws.send(JSON.stringify({ type: 'input', data: encodeInput(data) }));
    });

    // ── Resize → tell server ──────────────────────────────────────────────

    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    connect();

    // Heartbeat to keep the WebSocket alive through proxies / load-balancers
    const pingTimer = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);

    return () => {
      closed = true;
      clearTimeout(reconnectTimer.current);
      clearInterval(pingTimer);
      ro.disconnect();
      const ws = wsRef.current;
      if (ws) { ws.close(); wsRef.current = null; }
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
    };
  }, [workflowId]);

  return (
    <div
      ref={containerRef}
      className="ide-terminal-host"
      aria-label="Terminal"
      title="Terminal — copy on select · Ctrl+Shift+C copy · Ctrl+Shift+V paste · Ctrl+C interrupt"
      // Click anywhere on the host to re-focus the hidden xterm textarea
      onClick={() => termRef.current?.focus()}
    />
  );
}
