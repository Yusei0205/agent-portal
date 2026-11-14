/**
 * Unit tests for web/src/lib/terminal-pipe.js
 *
 * Pure logic — no DOM, no xterm instance needed.  Runs in Node.js via the
 * built-in test runner.
 *
 * Run with:
 *   npm run test:affected -- --module ide --backend-only
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error — plain-JS module without type declarations
import { isClearCommand, LineBuffer } from '../web/src/lib/terminal-pipe.js';

// ══════════════════════════════════════════════════════════════════════════════
// isClearCommand
// ══════════════════════════════════════════════════════════════════════════════

describe('isClearCommand', () => {
  it('recognises "clear"', () => assert.equal(isClearCommand('clear'), true));
  it('recognises "cls"',   () => assert.equal(isClearCommand('cls'),   true));

  it('is case-insensitive', () => {
    assert.equal(isClearCommand('CLEAR'), true);
    assert.equal(isClearCommand('CLS'),   true);
    assert.equal(isClearCommand('Clear'), true);
    assert.equal(isClearCommand('Cls'),   true);
  });

  it('strips surrounding whitespace', () => {
    assert.equal(isClearCommand('  clear  '), true);
    assert.equal(isClearCommand('\tcls\t'),   true);
  });

  it('rejects other commands', () => {
    assert.equal(isClearCommand('dir'),    false);
    assert.equal(isClearCommand('clearx'), false);
    assert.equal(isClearCommand('xcls'),   false);
    assert.equal(isClearCommand(''),       false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LineBuffer — handleKey
// ══════════════════════════════════════════════════════════════════════════════

describe('LineBuffer › handleKey', () => {
  it('echoes printable characters and buffers them', () => {
    const lb = new LineBuffer();
    const r = lb.handleKey('a');
    assert.equal(r.echo,  'a');
    assert.equal(r.send,  null);
    assert.equal(r.clear, false);
    assert.equal(lb.buffer, 'a');
  });

  it('accumulates multiple characters in order', () => {
    const lb = new LineBuffer();
    lb.handleKey('h');
    lb.handleKey('i');
    assert.equal(lb.buffer, 'hi');
  });

  it('handles DEL (0x7F) backspace', () => {
    const lb = new LineBuffer();
    lb.handleKey('a');
    lb.handleKey('b');
    const r = lb.handleKey('\x7f');
    assert.equal(r.echo, '\b \b');
    assert.equal(r.send, null);
    assert.equal(lb.buffer, 'a');
  });

  it('handles BS (0x08) backspace', () => {
    const lb = new LineBuffer();
    lb.handleKey('z');
    const r = lb.handleKey('\x08');
    assert.equal(r.echo, '\b \b');
    assert.equal(lb.buffer, '');
  });

  it('ignores backspace on an empty buffer', () => {
    const lb = new LineBuffer();
    const r = lb.handleKey('\x7f');
    assert.equal(r.echo, null);
    assert.equal(r.send, null);
  });

  it('handles Enter (CR) — flushes buffer, returns send payload', () => {
    const lb = new LineBuffer();
    'dir'.split('').forEach((c) => lb.handleKey(c));
    const r = lb.handleKey('\r');
    assert.equal(r.echo,  '\r\n');
    assert.equal(r.send,  'dir\r\n');
    assert.equal(r.clear, false);
    assert.equal(lb.buffer, '');
  });

  it('sets clear=true when Enter is pressed after typing "clear"', () => {
    const lb = new LineBuffer();
    'clear'.split('').forEach((c) => lb.handleKey(c));
    assert.equal(lb.handleKey('\r').clear, true);
  });

  it('sets clear=true when Enter is pressed after typing "cls"', () => {
    const lb = new LineBuffer();
    'cls'.split('').forEach((c) => lb.handleKey(c));
    assert.equal(lb.handleKey('\r').clear, true);
  });

  it('sets clear=true for "CLEAR" (case-insensitive)', () => {
    const lb = new LineBuffer();
    'CLEAR'.split('').forEach((c) => lb.handleKey(c));
    assert.equal(lb.handleKey('\r').clear, true);
  });

  it('handles Ctrl+C — echoes ^C, resets buffer, sends 0x03', () => {
    const lb = new LineBuffer();
    lb.handleKey('a');
    lb.handleKey('b');
    const r = lb.handleKey('\x03');
    assert.equal(r.echo, '^C\r\n');
    assert.equal(r.send, '\x03');
    assert.equal(lb.buffer, '');
  });

  it('does not set pendingEcho after Ctrl+C', () => {
    const lb = new LineBuffer();
    lb.handleKey('\x03');
    assert.equal((lb as any)._pendingEcho, null);
  });

  it('ignores unsupported sequences (arrow keys, ESC, etc.)', () => {
    const lb = new LineBuffer();
    const r = lb.handleKey('\x1b[A'); // up-arrow ESC sequence
    assert.equal(r.echo,  null);
    assert.equal(r.send,  null);
    assert.equal(r.clear, false);
  });

  it('does not echo characters with code < 0x20 (control codes)', () => {
    const lb = new LineBuffer();
    // 0x01 = Ctrl+A
    const r = lb.handleKey('\x01');
    assert.equal(r.echo, null);
    assert.equal(r.send, null);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LineBuffer — filterOutput (echo suppression)
// ══════════════════════════════════════════════════════════════════════════════

describe('LineBuffer › filterOutput', () => {
  it('passes output through unchanged when no command is pending', () => {
    const lb = new LineBuffer();
    assert.equal(lb.filterOutput('some output\r\n'), 'some output\r\n');
  });

  it('strips the command echo from server output (CRLF line ending)', () => {
    const lb = new LineBuffer();
    'dir'.split('').forEach((c) => lb.handleKey(c));
    lb.handleKey('\r'); // triggers _pendingEcho = 'dir'
    const out = lb.filterOutput('dir\r\n Volume in drive C\r\n');
    assert.equal(out, ' Volume in drive C\r\n');
  });

  it('strips the command echo from server output (LF-only line ending)', () => {
    const lb = new LineBuffer();
    'ls'.split('').forEach((c) => lb.handleKey(c));
    lb.handleKey('\r');
    const out = lb.filterOutput('ls\nfoo bar\n');
    assert.equal(out, 'foo bar\n');
  });

  it('passes through unchanged when output does not start with the echo', () => {
    const lb = new LineBuffer();
    'dir'.split('').forEach((c) => lb.handleKey(c));
    lb.handleKey('\r');
    // Output starts with the prompt, not the bare command
    const out = lb.filterOutput('C:\\> dir\r\noutput\r\n');
    assert.equal(out, 'C:\\> dir\r\noutput\r\n');
  });

  it('suppresses echo only once per sent command', () => {
    const lb = new LineBuffer();
    'dir'.split('').forEach((c) => lb.handleKey(c));
    lb.handleKey('\r');
    lb.filterOutput('dir\r\nfirst chunk\r\n'); // consumes _pendingEcho
    // Second output must not be suppressed
    const second = lb.filterOutput('dir\r\nsecond chunk\r\n');
    assert.equal(second, 'dir\r\nsecond chunk\r\n');
  });

  it('strips an empty-line echo (Enter on blank line) with CRLF', () => {
    const lb = new LineBuffer();
    // No characters typed; just Enter → pending echo = ''
    lb.handleKey('\r');
    const out = lb.filterOutput('\r\nprompt>\r\n');
    assert.equal(out, 'prompt>\r\n');
  });

  it('strips an empty-line echo with LF-only', () => {
    const lb = new LineBuffer();
    lb.handleKey('\r');
    const out = lb.filterOutput('\nprompt>\n');
    assert.equal(out, 'prompt>\n');
  });

  it('clears _pendingEcho after filtering regardless of whether it matched', () => {
    const lb = new LineBuffer();
    'foo'.split('').forEach((c) => lb.handleKey(c));
    lb.handleKey('\r');
    lb.filterOutput('unrelated output\r\n'); // no match, but still consumed
    assert.equal((lb as any)._pendingEcho, null);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LineBuffer — reset
// ══════════════════════════════════════════════════════════════════════════════

describe('LineBuffer › reset', () => {
  it('clears buffer and pending echo', () => {
    const lb = new LineBuffer();
    lb.handleKey('a');
    lb.handleKey('b');
    'dir'.split('').forEach((c) => lb.handleKey(c));
    lb.handleKey('\r'); // sets _pendingEcho = 'dir'
    lb.reset();
    assert.equal(lb.buffer,               '');
    assert.equal((lb as any)._pendingEcho, null);
  });

  it('is safe to call on a fresh instance', () => {
    const lb = new LineBuffer();
    assert.doesNotThrow(() => lb.reset());
    assert.equal(lb.buffer,               '');
    assert.equal((lb as any)._pendingEcho, null);
  });
});
