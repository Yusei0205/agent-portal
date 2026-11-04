/**
 * Unit tests for web/src/lib/curlBuilder.js
 *
 * Run with:
 *   npm run test:affected -- --module testing-module --backend-only
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error — plain JS module without type declarations
import { buildCurl, shellQuote, prettyBody } from '../web/src/lib/curlBuilder.js';

// ══════════════════════════════════════════════════════════════════════════════
// shellQuote
// ══════════════════════════════════════════════════════════════════════════════

describe('shellQuote', () => {
  it('wraps a plain string in single quotes', () => {
    assert.equal(shellQuote('hello'), "'hello'");
  });

  it('handles an empty string', () => {
    assert.equal(shellQuote(''), "''");
  });

  it('escapes an embedded single quote', () => {
    // "don't"  →  'don'"'"'t'
    assert.equal(shellQuote("don't"), "'don'\"'\"'t'");
  });

  it('escapes multiple embedded single quotes', () => {
    const result = shellQuote("it's a 'test'");
    // Must start and end with single-quote
    assert.match(result, /^'/);
    assert.match(result, /'$/);
    // The escape bridge pattern must be present
    assert.ok(result.includes("\"'\""), 'should contain the escape bridge');
    // Unquoted value must round-trip (simulate shell interpretation):
    // 'it'"'"'s a '"'"'test'"'"'  →  it's a 'test'
    // We verify the overall structure is correct by checking the content preserved.
    assert.ok(result.includes('it'), 'should contain the original text segments');
    assert.ok(result.includes("test"), 'should contain the test segment');
  });

  it('handles a string that is only single quotes', () => {
    const result = shellQuote("'''");
    // Three single quotes need 3 escape bridges
    assert.ok(result.length > 3, 'should be longer than the raw input');
    // No bare single quote should appear except as part of the escape pattern
    assert.ok(result.includes("\"'\""), 'escape bridge must appear');
  });

  it('handles special shell characters that do NOT need escaping inside single quotes', () => {
    // $, `, ", \ are safe inside single-quoted strings
    const s = 'echo $HOME && ls -la "file" `date`';
    const result = shellQuote(s);
    // Should be wrapped in single quotes
    assert.ok(result.startsWith("'") && result.endsWith("'"));
    // Content should be preserved between outer quotes
    assert.ok(result.includes(s), 'content should appear verbatim inside quotes');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// buildCurl — basic
// ══════════════════════════════════════════════════════════════════════════════

describe('buildCurl — returns empty for invalid input', () => {
  it('returns empty string for null', () => {
    assert.equal(buildCurl(null), '');
  });

  it('returns empty string when url is missing', () => {
    assert.equal(buildCurl({ method: 'POST' }), '');
  });

  it('returns empty string for undefined', () => {
    assert.equal(buildCurl(undefined), '');
  });
});

describe('buildCurl — GET', () => {
  it('generates a simple GET request', () => {
    const result = buildCurl({ method: 'GET', url: 'https://api.example.com/users' });
    assert.ok(result.startsWith('curl -X GET'), 'should start with curl -X GET');
    assert.ok(result.includes("'https://api.example.com/users'"), 'should include quoted URL');
  });

  it('defaults to GET when method is absent', () => {
    const result = buildCurl({ url: 'https://api.example.com/items' });
    assert.ok(result.includes('curl -X GET'), 'should default to GET');
  });

  it('does NOT include --data-raw for GET even when body is provided', () => {
    const result = buildCurl({ method: 'GET', url: 'https://api.example.com/', body: '{"key":"val"}' });
    assert.ok(!result.includes('--data-raw'), 'GET should not emit --data-raw');
  });

  it('does NOT include --data-raw for HEAD even when body is provided', () => {
    const result = buildCurl({ method: 'HEAD', url: 'https://api.example.com/', body: 'payload' });
    assert.ok(!result.includes('--data-raw'), 'HEAD should not emit --data-raw');
  });

  it('does NOT include -H when headers is null', () => {
    const result = buildCurl({ method: 'GET', url: 'https://api.example.com/', headers: null });
    assert.ok(!result.includes('-H'), 'null headers should produce no -H flags');
  });

  it('does NOT include -H when headers object is empty', () => {
    const result = buildCurl({ method: 'GET', url: 'https://api.example.com/', headers: {} });
    assert.ok(!result.includes('-H'), 'empty headers should produce no -H flags');
  });
});

describe('buildCurl — POST with body', () => {
  it('includes --data-raw for POST with a string body', () => {
    const result = buildCurl({
      method: 'POST',
      url: 'https://api.example.com/users',
      body: '{"name":"Alice"}',
    });
    assert.ok(result.includes('--data-raw'), 'should include --data-raw');
    assert.ok(result.includes('{"name":"Alice"}'), 'should include the body content');
  });

  it('serialises an object body to JSON', () => {
    const result = buildCurl({
      method: 'POST',
      url: 'https://api.example.com/users',
      body: { name: 'Alice', age: 30 },
    });
    assert.ok(result.includes('--data-raw'), 'should include --data-raw');
    assert.ok(result.includes('"name"'), 'serialised object should contain key name');
    assert.ok(result.includes('"Alice"'), 'serialised object should contain value');
  });

  it('omits --data-raw when body is null', () => {
    const result = buildCurl({ method: 'POST', url: 'https://api.example.com/users', body: null });
    assert.ok(!result.includes('--data-raw'), 'null body should not emit --data-raw');
  });

  it('omits --data-raw when body is absent', () => {
    const result = buildCurl({ method: 'POST', url: 'https://api.example.com/users' });
    assert.ok(!result.includes('--data-raw'), 'absent body should not emit --data-raw');
  });

  it('escapes single quotes in the body using the POSIX shell escape pattern', () => {
    const result = buildCurl({
      method: 'POST',
      url: 'https://api.example.com/notes',
      body: "it's a test",
    });
    assert.ok(result.includes('--data-raw'), 'should still include --data-raw');
    // The escape bridge pattern must appear in the output
    assert.ok(result.includes("\"'\""), 'single quote in body should be escaped via bridge pattern');
  });
});

describe('buildCurl — headers', () => {
  it('emits one -H flag per header', () => {
    const result = buildCurl({
      method: 'POST',
      url: 'https://api.example.com/data',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer tok123',
      },
      body: '{}',
    });
    const hCount = (result.match(/-H /g) || []).length;
    assert.equal(hCount, 2, 'should emit exactly 2 -H flags');
    assert.ok(result.includes('Content-Type: application/json'), 'should include Content-Type header');
    assert.ok(result.includes('Authorization: Bearer tok123'), 'should include Authorization header');
  });

  it('wraps header values in single quotes', () => {
    const result = buildCurl({
      method: 'GET',
      url: 'https://api.example.com/',
      headers: { Accept: 'application/json' },
    });
    assert.ok(result.includes("-H '"), 'header value should be single-quoted');
  });

  it('escapes single quotes inside header values', () => {
    const result = buildCurl({
      method: 'GET',
      url: 'https://api.example.com/',
      headers: { 'X-Note': "it's fine" },
    });
    assert.ok(result.includes("\"'\""), 'single quote in header value should be escaped');
  });
});

describe('buildCurl — line continuations', () => {
  it('uses backslash-newline line continuations for multi-line output', () => {
    const result = buildCurl({
      method: 'POST',
      url: 'https://api.example.com/',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.ok(result.includes(' \\\n'), 'multi-part curl should use line continuations');
  });

  it('single-line GET has no backslash continuations', () => {
    const result = buildCurl({ method: 'GET', url: 'https://api.example.com/' });
    assert.ok(!result.includes('\\\n'), 'no continuation for single-line GET');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// prettyBody
// ══════════════════════════════════════════════════════════════════════════════

describe('prettyBody', () => {
  it('returns null for null item', () => {
    assert.equal(prettyBody(null), null);
  });

  it('returns null when body is null', () => {
    assert.equal(prettyBody({ body: null }), null);
  });

  it('returns null when body is undefined', () => {
    assert.equal(prettyBody({ body: undefined }), null);
  });

  it('returns null when item has no body property', () => {
    assert.equal(prettyBody({}), null);
  });

  it('formats an object body as pretty-printed JSON', () => {
    const result = prettyBody({ body: { name: 'Alice', age: 30 } });
    assert.ok(result !== null, 'result should not be null');
    assert.ok(result.includes('\n'), 'should be multi-line');
    assert.ok(result.includes('  '), 'should use 2-space indent');
    const parsed = JSON.parse(result);
    assert.equal(parsed.name, 'Alice');
    assert.equal(parsed.age, 30);
  });

  it('re-formats a compact JSON string body with indentation', () => {
    const result = prettyBody({ body: '{"name":"Bob","score":99}' });
    assert.ok(result !== null);
    assert.ok(result.includes('\n'), 'compact JSON string should be reformatted');
    const parsed = JSON.parse(result);
    assert.equal(parsed.name, 'Bob');
  });

  it('returns a non-JSON string body as-is', () => {
    assert.equal(prettyBody({ body: 'plain text body' }), 'plain text body');
  });

  it('returns an empty string body as-is (not JSON)', () => {
    assert.equal(prettyBody({ body: '' }), '');
  });

  it('handles nested object bodies', () => {
    const result = prettyBody({ body: { user: { id: 1, roles: ['admin'] } } });
    assert.ok(result !== null);
    const parsed = JSON.parse(result);
    assert.equal(parsed.user.roles[0], 'admin');
  });
});
