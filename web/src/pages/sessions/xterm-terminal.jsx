/**
 * xterm.js terminal — dynamically imported to keep it out of the main bundle.
 *
 * Bug fixes (2024):
 *   1. term.focus() is now called after term.open() so the terminal immediately
 *      accepts keyboard input.  Previously no focus call was made, so xterm's
 *      hidden textarea never received events and typing appeared to do nothing.
 *
 *   2. Pipe-mode local echo: when node-pty is unavailable (Windows fallback) the
 *      server spawns cmd.exe with stdio pipes.  Piped cmd.exe does not echo input
 *      and only processes a line after a newline.  We now detect pipe mode from the
 *      'ready' message (pty: false) and implement local echo + line-buffering so the
 *      user can see what they type and submit commands with Enter.
 */
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * @param {{
 *   workflowId: string,
 *   onClose?: () => void,
 * }} props
 */
export function XtermTerminal({ workflowId, onClose }) {
  const containerRef = useRef(null);
  const termRef      = useRef(null);
  const fitRef       = useRef(null);
  const wsRef        = useRef(null);
  const reconnectTimer = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
      fontSize: 13,
      fontFamily: 'var(--mono, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace)',
      convertEol: true,
      scrollback: 2000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    // Fix: give keyboard focus immediately so the hidden textarea captures key events.
    term.focus();
    termRef.current = term;
    fitRef.current  = fit;

    // Resize observer to fit terminal when container resizes
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* ignore */ }
    });
    ro.observe(containerRef.current);

    let closed = false;

    // Pipe-mode state: updated from the server's 'ready' message.
    // isPty starts true (optimistic) and is set to false if the server cannot
    // acquire a PTY (Windows without node-pty).
    // lineBuffer accumulates characters typed in pipe mode for local echo.
    const pipeState = { isPty: true, lineBuffer: '' };

    function connect() {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/api/terminal/ws?workflowId=${encodeURIComponent(workflowId)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        term.writeln('\r\n\x1b[32m● Terminal connected\x1b[0m\r\n');
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'ready') {
            // pty: false means server fell back to pipe mode (e.g. Windows, no node-pty)
            pipeState.isPty = msg.pty !== false;
            pipeState.lineBuffer = ''; // reset buffer on (re)connect
            const cols = msg.cols || 80;
            const rows = msg.rows || 24;
            term.resize(cols, rows);
          } else if (msg.type === 'output') {
            const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
            term.write(bytes);
          } else if (msg.type === 'exit') {
            term.writeln(`\r\n\x1b[90mProcess exited (${msg.code})\x1b[0m`);
            wsRef.current = null;
          } else if (msg.type === 'error') {
            term.writeln(`\r\n\x1b[31mError: ${msg.message}\x1b[0m`);
          } else if (msg.type === 'pong') {
            // heartbeat ack
          }
        } catch { /* ignore */ }
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

    /** Encode a string (UTF-8) to base64 for the WebSocket input message. */
    function encodeInput(str) {
      const bytes = new TextEncoder().encode(str);
      return btoa(String.fromCharCode(...bytes));
    }

    // Handle input from user
    term.onData((data) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      if (!pipeState.isPty) {
        // ── Pipe / no-PTY mode (Windows fallback without node-pty) ───────────
        // cmd.exe with piped stdin does not echo characters back to stdout,
        // and only processes the line after receiving a newline character.
        // We implement local echo + line-buffering here so the user can see
        // what they are typing before pressing Enter.
        if (data === '\r') {
          // Enter: echo newline, flush the buffered line to the shell
          term.write('\r\n');
          const line = pipeState.lineBuffer + '\r\n';
          pipeState.lineBuffer = '';
          ws.send(JSON.stringify({ type: 'input', data: encodeInput(line) }));
        } else if (data === '\x7f' || data === '\x08') {
          // Backspace / DEL: remove last character from buffer and screen
          if (pipeState.lineBuffer.length > 0) {
            pipeState.lineBuffer = pipeState.lineBuffer.slice(0, -1);
            term.write('\b \b');
          }
        } else if (data === '\x03') {
          // Ctrl+C: interrupt (send immediately, reset buffer)
          term.write('^C\r\n');
          pipeState.lineBuffer = '';
          ws.send(JSON.stringify({ type: 'input', data: btoa('\x03') }));
        } else if (data.length === 1 && data.charCodeAt(0) >= 0x20) {
          // Printable character: echo locally and buffer for submission
          pipeState.lineBuffer += data;
          term.write(data);
        }
        // Other control sequences (arrow keys, function keys, etc.) are not
        // supported in pipe mode — the shell has no line editor to process them.
        return;
      }

      // ── PTY mode: pass raw data straight to the shell ────────────────────
      ws.send(JSON.stringify({ type: 'input', data: encodeInput(data) }));
    });

    // Resize → tell server
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    connect();

    // Heartbeat
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
      // Clicking anywhere on the terminal host re-focuses the hidden xterm textarea
      onClick={() => termRef.current?.focus()}
    />
  );
}
