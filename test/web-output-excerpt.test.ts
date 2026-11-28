import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module shared with the web app
import { isExcerptable, excerptLines } from '../web/src/lib/outputFileUtils.js';

describe('output file excerpt', () => {
  it('offers an excerpt for small text and code files only', () => {
    assert.equal(isExcerptable({ name: 'page.py', size_bytes: 4800 }), true);
    assert.equal(isExcerptable({ name: 'README.MD', size_bytes: 10 }), true);
    assert.equal(isExcerptable({ name: 'report.xlsx', size_bytes: 18000 }), false);
    assert.equal(isExcerptable({ name: 'big.log', size_bytes: 5_000_000 }), false);
    assert.equal(isExcerptable({ name: 'empty.txt', size_bytes: 0 }), false);
    assert.equal(isExcerptable(null), false);
  });
  it('takes the first lines, says when it cut, and shortens very long lines', () => {
    const e = excerptLines(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n', 12);
    assert.equal(e.lines.length, 12);
    assert.equal(e.total, 30);
    assert.equal(e.truncated, true);
    assert.equal(e.lines[0], 'line 1');
    assert.equal(excerptLines('short').truncated, false);
    assert.equal(excerptLines('x'.repeat(500)).lines[0].length, 161);
  });
});
