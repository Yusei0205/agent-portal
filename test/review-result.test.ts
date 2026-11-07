import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewResult } from '../server/review-result.ts';

const files = new Set(['src/api.ts']);
const finding = { file: 'src/api.ts', line: 4, severity: 'high', category: 'security', message: 'SQL injection', suggestion: 'Use parameters.' };

test('review keeps every finding and complete descriptions and fixes', () => {
  const findings = Array.from({ length: 205 }, (_, i) => ({ ...finding, line: i + 1, message: 'Detail '.repeat(500), suggestion: 'Fix '.repeat(1000) }));
  const result = parseReviewResult('```json\n' + JSON.stringify({ summary: 'Security assessment', findings }) + '\n```', files);
  assert.deepEqual(result.findings, findings);
});

test('invalid reviewer output never becomes a successful empty report', () => {
  for (const text of ['', 'No issues found', '{}', '{"summary":"ok"}', '{"summary":"ok","findings":null}']) {
    assert.throws(() => parseReviewResult(text, files), /invalid report/);
  }
  assert.deepEqual(parseReviewResult('{"summary":"No issues found","findings":[]}', files).findings, []);
});

test('invalid findings fail visibly instead of silently disappearing', () => {
  for (const bad of [null, { ...finding, file: 'unknown.ts' }, { ...finding, severity: 'urgent' }, { ...finding, message: '' }, { ...finding, line: -1 }]) {
    assert.throws(() => parseReviewResult(JSON.stringify({ summary: 'Review', findings: [finding, bad] }), files), /invalid finding \(2\)/);
  }
});

test('file-level findings and diff prefixes remain supported', () => {
  const result = parseReviewResult(JSON.stringify({ summary: 'Review', findings: [{ ...finding, file: 'b/src/api.ts', line: null }] }), files);
  assert.equal(result.findings[0].file, 'src/api.ts');
  assert.equal(result.findings[0].line, null);
});
