/**
 * The markdown preview for files must not run script: it goes through the same DOMPurify sanitizer as the rest.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
(globalThis as unknown as Record<string, unknown>).window = dom.window;
(globalThis as unknown as Record<string, unknown>).document = dom.window.document;

describe('sanitizeMarkdown on file previews', () => {
  it('removes event handlers, script tags and javascript links', async () => {
    const { sanitizeMarkdown } = await import('../web/src/lib/sanitize.js');
    const out = sanitizeMarkdown('<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a><iframe src="https://e.example"></iframe>');
    assert.ok(!/onerror|<script|javascript:|<iframe/i.test(out), out);
  });
});
