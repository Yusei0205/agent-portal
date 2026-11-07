import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertWebUrl } from '../agent-runner/src/browser-tools.ts';

describe('assertWebUrl', () => {
  it('accepts http and https', () => {
    assert.equal(assertWebUrl('https://example.com'), 'https://example.com/');
    assert.equal(assertWebUrl('http://example.com/a?b=1'), 'http://example.com/a?b=1');
  });
  it('rejects other schemes and junk', () => {
    for (const bad of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'not a url', '']) {
      assert.throws(() => assertWebUrl(bad), bad);
    }
  });
});
