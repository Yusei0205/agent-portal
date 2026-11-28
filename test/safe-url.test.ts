import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module shared with the web app
import { safeUrl } from '../web/src/lib/safeUrl.js';

describe('safeUrl', () => {
  it('keeps web addresses, site paths and anchors', () => {
    assert.equal(safeUrl('https://example.atlassian.net/browse/A-1'), 'https://example.atlassian.net/browse/A-1');
    assert.equal(safeUrl('http://localhost:8787/x'), 'http://localhost:8787/x');
    assert.equal(safeUrl('/api/files/1'), '/api/files/1');
    assert.equal(safeUrl('#/p/1/sessions'), '#/p/1/sessions');
  });
  it('drops script and data addresses, protocol-relative links and junk', () => {
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', '//evil.example/x', 'not a url', '', '   ', null, undefined, 42]) {
      assert.equal(safeUrl(bad as never), undefined, String(bad));
    }
  });
});
