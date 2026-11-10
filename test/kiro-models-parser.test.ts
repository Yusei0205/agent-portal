/**
 * Unit tests for parseKiroModelsTable — the pure parser for the
 * `kiro-cli chat --list-models --output-format text` output.
 *
 * The sample text used here is the verbatim real output from kiro-cli 2.36.0,
 * so this test suite is the regression guard against future format changes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseKiroModelsTable } from '../server/models.ts';

// ── Verbatim real sample from kiro-cli 2.36.0 ────────────────────────────────

const REAL_SAMPLE = `Available models (* = default):

* auto                 1.00x credits      Models chosen by task for optimal usage and consistent quality
  claude-opus-5.5      2.00x credits      Claude Opus 5.5 model with 1M context window
  claude-sonnet-5.5    1.30x credits      Claude Sonnet 5.5 model with 1M context window
  claude-haiku-4.5     0.40x credits      The latest Claude Haiku model
  deepseek-3.2         0.25x credits      Experimental preview of DeepSeek V3.2
  qwen3-coder-next     0.05x credits      Experimental preview of Qwen3 Coder Next
`;

// ── Parsing the real sample ───────────────────────────────────────────────────

describe('parseKiroModelsTable — real sample', () => {
  it('parses all 6 model entries', () => {
    const result = parseKiroModelsTable(REAL_SAMPLE);
    assert.ok(!result.error, `unexpected error: ${result.error}`);
    assert.equal(result.models.length, 6, `expected 6 models, got ${result.models.length}`);
  });

  it('returns source kiro-cli', () => {
    const result = parseKiroModelsTable(REAL_SAMPLE);
    assert.equal(result.source, 'kiro-cli');
  });

  it('marks only "auto" as default:true', () => {
    const result = parseKiroModelsTable(REAL_SAMPLE);
    const defaults = result.models.filter((m) => m.default === true);
    assert.equal(defaults.length, 1, `expected exactly 1 default model, got ${defaults.length}`);
    assert.equal(defaults[0].id, 'auto');
  });

  it('non-default entries do not have default:true', () => {
    const result = parseKiroModelsTable(REAL_SAMPLE);
    const nonDefaults = result.models.filter((m) => m.id !== 'auto');
    for (const m of nonDefaults) {
      assert.ok(m.default !== true, `${m.id} should not be marked as default`);
    }
  });

  it('model IDs match expected values', () => {
    const result = parseKiroModelsTable(REAL_SAMPLE);
    const ids = result.models.map((m) => m.id);
    assert.ok(ids.includes('auto'), 'should include auto');
    assert.ok(ids.includes('claude-opus-5.5'), 'should include claude-opus-5.5');
    assert.ok(ids.includes('claude-sonnet-5.5'), 'should include claude-sonnet-5.5');
    assert.ok(ids.includes('claude-haiku-4.5'), 'should include claude-haiku-4.5');
    assert.ok(ids.includes('deepseek-3.2'), 'should include deepseek-3.2');
    assert.ok(ids.includes('qwen3-coder-next'), 'should include qwen3-coder-next');
  });

  it('labels include em-dash separator between id and description', () => {
    const result = parseKiroModelsTable(REAL_SAMPLE);
    for (const m of result.models) {
      assert.ok(m.label.includes('—'), `label for ${m.id} should contain em-dash: "${m.label}"`);
    }
  });

  it('labels include credit multiplier in parentheses', () => {
    const result = parseKiroModelsTable(REAL_SAMPLE);
    for (const m of result.models) {
      assert.ok(m.label.includes('credits)'), `label for ${m.id} should end with "credits)": "${m.label}"`);
    }
  });

  it('auto label is correctly formatted', () => {
    const result = parseKiroModelsTable(REAL_SAMPLE);
    const auto = result.models.find((m) => m.id === 'auto');
    assert.ok(auto, 'auto model not found');
    assert.equal(
      auto!.label,
      'auto — Models chosen by task for optimal usage and consistent quality (1.00x credits)',
    );
  });

  it('claude-sonnet-5.5 label is correctly formatted', () => {
    const result = parseKiroModelsTable(REAL_SAMPLE);
    const m = result.models.find((e) => e.id === 'claude-sonnet-5.5');
    assert.ok(m, 'claude-sonnet-5.5 not found');
    assert.equal(
      m!.label,
      'claude-sonnet-5.5 — Claude Sonnet 5.5 model with 1M context window (1.30x credits)',
    );
  });
});

// ── Header and blank lines are skipped ───────────────────────────────────────

describe('parseKiroModelsTable — header and blank lines', () => {
  it('skips the "Available models (* = default):" header line', () => {
    const result = parseKiroModelsTable(REAL_SAMPLE);
    const ids = result.models.map((m) => m.id);
    // The header text must not appear as a model ID
    assert.ok(!ids.some((id) => id.includes('Available')), 'header must not appear as a model');
    assert.ok(!ids.some((id) => id.includes('default')), '"default" text must not appear as a model');
  });

  it('handles extra blank lines gracefully', () => {
    const withExtraBlanks = '\n\n' + REAL_SAMPLE + '\n\n';
    const result = parseKiroModelsTable(withExtraBlanks);
    assert.equal(result.models.length, 6, 'extra blank lines must not affect parsed count');
  });
});

// ── Garbage lines are ignored ────────────────────────────────────────────────

describe('parseKiroModelsTable — garbage line handling', () => {
  it('ignores lines that do not match the table format', () => {
    const withGarbage =
      'Available models (* = default):\n' +
      '\n' +
      '  some garbage that is not a model row\n' +
      'another bad line\n' +
      '* auto                 1.00x credits      Models chosen by task for optimal usage\n' +
      '  this has no credit info\n';
    const result = parseKiroModelsTable(withGarbage);
    assert.equal(result.models.length, 1, `garbage lines must be skipped; got ${result.models.length} models`);
    assert.equal(result.models[0].id, 'auto');
  });

  it('ignores a JSON line (regression: old --output-format json output)', () => {
    const jsonLine = '{"type":"model","id":"claude-sonnet-4-5","name":"Claude Sonnet 4.5"}\n';
    const result = parseKiroModelsTable(jsonLine);
    assert.ok(result.error, 'JSON line must not be parsed as a model row → no models error');
    assert.equal(result.models.length, 0);
  });
});

// ── Empty output returns error ────────────────────────────────────────────────

describe('parseKiroModelsTable — empty / header-only output', () => {
  it('returns error when output is completely empty', () => {
    const result = parseKiroModelsTable('');
    assert.ok(typeof result.error === 'string' && result.error.length > 0, 'empty output must return error');
    assert.equal(result.models.length, 0);
  });

  it('returns error when output contains only the header', () => {
    const result = parseKiroModelsTable('Available models (* = default):\n');
    assert.ok(typeof result.error === 'string' && result.error.length > 0, 'header-only must return error');
    assert.equal(result.models.length, 0);
    assert.equal(result.source, 'kiro-cli');
  });

  it('error message mentions "no models"', () => {
    const result = parseKiroModelsTable('');
    assert.ok(result.error!.toLowerCase().includes('no models'), `error: "${result.error}"`);
  });
});
