import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewFindings } from '../server/review-result.ts';

test('keeps every finding, complete descriptions and suggested fixes in the current schema', () => {
  const input = Array.from({ length: 205 }, (_, i) => ({ file: 'b/src/api.ts', line: i + 1, severity: 'high', category: 'security', message: 'Detail '.repeat(500), suggestion: 'Fix '.repeat(1000) }));
  const findings = normalizeReviewFindings(input);
  assert.equal(findings.length, 205);
  assert.equal(findings[0].file_path, 'src/api.ts');
  assert.equal(findings[0].body, input[0].message + '\n\nSuggested fix:\n' + input[0].suggestion);
});

test('malformed entries are rejected instead of silently disappearing', () => {
  const finding = { file: 'src/api.ts', line: null, severity: 'high', title: 'SQL injection', body: 'Use parameters.' };
  for (const bad of [null, {}, { ...finding, severity: 'urgent' }, { ...finding, body: '' }, { ...finding, line: -1 }, { ...finding, suggestion: {} }]) assert.throws(() => normalizeReviewFindings([finding, bad]), /Invalid finding 2/);
  assert.equal(normalizeReviewFindings([finding])[0].line_number, null);
  assert.deepEqual(normalizeReviewFindings([]), []);
});
