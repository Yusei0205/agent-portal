import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSince } from '../server/mail.ts';

describe('Mail page day window', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  test('uses the start of the day the page sent', () => {
    assert.equal(parseSince('2026-11-09T00:00:00Z', now), Date.parse('2026-11-09T00:00:00Z') / 1000);
  });
  test('falls back to the last 24 hours for a missing or invalid value', () => {
    assert.equal(parseSince(null, now), (now - 86_400_000) / 1000);
    assert.equal(parseSince('nonsense', now), (now - 86_400_000) / 1000);
  });
  test('never reaches back more than 3 days or into the future', () => {
    assert.equal(parseSince('2020-01-01T00:00:00Z', now), (now - 3 * 86_400_000) / 1000);
    assert.equal(parseSince('2030-01-01T00:00:00Z', now), now / 1000);
  });
});
