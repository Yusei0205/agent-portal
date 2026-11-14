/**
 * Pipe-mode terminal helpers — pure logic, no DOM.
 *
 * Used by xterm-terminal.jsx when the server reports pty: false (Windows
 * fallback without node-pty). These helpers live in a separate module so they
 * can be unit-tested in Node.js without a browser or xterm instance.
 *
 * Exports:
 *   isClearCommand(line) → boolean
 *   LineBuffer           — local echo + line buffering + echo suppression
 */

/**
 * Returns true if `line` (trimmed, case-insensitive) is the 'clear' or 'cls'
 * shell command so the caller can clear the xterm buffer locally instead of
 * forwarding it to the server.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isClearCommand(line) {
  const t = line.trim().toLowerCase();
  return t === 'clear' || t === 'cls';
}

/**
 * Stateful line buffer for pipe mode (no PTY).
 *
 * Responsibilities:
 *  1. Local echo — printable characters and backspace are echoed immediately
 *     so the user can see what they are typing before pressing Enter.
 *  2. Line buffering — characters accumulate until Enter is pressed; the
 *     completed line is returned as `send` so the caller can forward it.
 *  3. Echo suppression — cmd.exe echoes the command text before printing
 *     output when receiving input over a pipe, causing each command to appear
 *     twice (once from local echo, once from the server).  After sending a
 *     line we remember it and strip that prefix from the next server output
 *     chunk so the command does not appear twice.
 */
export class LineBuffer {
  constructor() {
    /** @type {string} Characters typed so far on the current line. */
    this.buffer = '';
    /**
     * @type {string|null}
     * The last line sent, held for one server-output round trip so its echo
     * can be stripped.  Cleared after the first use.
     */
    this._pendingEcho = null;
  }

  /**
   * Process one xterm `onData` payload in pipe mode.
   *
   * @param {string} data - raw data from xterm's onData callback
   * @returns {{ echo: string|null, send: string|null, clear: boolean }}
   *   echo  — text to write to the terminal immediately (local echo / cursor)
   *   send  — text to send to the server (`null` = nothing to send yet)
   *   clear — true if the terminal screen should be cleared (clear / cls command)
   */
  handleKey(data) {
    // Enter: flush the buffer
    if (data === '\r') {
      const line = this.buffer;
      this.buffer = '';
      this._pendingEcho = line;
      return { echo: '\r\n', send: line + '\r\n', clear: isClearCommand(line) };
    }

    // Backspace (DEL 0x7F) or BS (0x08): erase the last character
    if (data === '\x7f' || data === '\x08') {
      if (this.buffer.length > 0) {
        this.buffer = this.buffer.slice(0, -1);
        return { echo: '\b \b', send: null, clear: false };
      }
      return { echo: null, send: null, clear: false };
    }

    // Ctrl+C: interrupt — send immediately, reset buffer
    if (data === '\x03') {
      this.buffer = '';
      this._pendingEcho = null;
      return { echo: '^C\r\n', send: '\x03', clear: false };
    }

    // Printable characters (code point ≥ 0x20)
    if (data.length === 1 && data.charCodeAt(0) >= 0x20) {
      this.buffer += data;
      return { echo: data, send: null, clear: false };
    }

    // All other sequences (arrow keys, function keys, ESC sequences, etc.)
    // are not supported in pipe mode — the shell has no line editor to
    // process them.
    return { echo: null, send: null, clear: false };
  }

  /**
   * Filter raw server output to suppress the command echo produced by
   * cmd.exe when it receives input over a pipe.
   *
   * When cmd.exe receives a completed line via piped stdin it prints that
   * line before executing it.  This results in the command text appearing
   * twice: once from local echo (in handleKey) and once in the server's
   * stdout.  This method strips the leading echo from the first output
   * chunk that arrives after a command was sent.
   *
   * The suppression applies at most once per sent command and only when the
   * output starts with the exact command text followed by a line ending.
   *
   * @param {string} text - decoded server output text
   * @returns {string} filtered output, safe to write directly to the terminal
   */
  filterOutput(text) {
    if (this._pendingEcho === null) return text;
    const echo = this._pendingEcho;
    this._pendingEcho = null; // consume — only suppress once
    if (text.startsWith(echo + '\r\n')) return text.slice(echo.length + 2);
    if (text.startsWith(echo + '\n'))   return text.slice(echo.length + 1);
    return text;
  }

  /**
   * Reset buffer and pending echo state.
   * Call on reconnect so stale state from a previous session does not bleed
   * into the new connection.
   */
  reset() {
    this.buffer = '';
    this._pendingEcho = null;
  }
}
