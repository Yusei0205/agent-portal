/**
 * infra/scripts/apply-upload-bucket-config.mjs: the CORS and lifecycle rules for direct uploads are merged into what the bucket
 * already has, never replacing it (S3 replaces the whole configuration on every write).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS script
import { corsRule, lifecycleRule, mergeRule, hasRule, CORS_RULE_ID, LIFECYCLE_RULE_ID } from '../infra/scripts/apply-upload-bucket-config.mjs';

// The one rule the live bucket has today (checked with aws s3api on 2026-11-10).
const snapshots = { ID: 'expire-workspace-snapshots', Status: 'Enabled', Filter: { Prefix: 'data/workspace-snapshots/' }, Expiration: { Days: 14 } };

describe('the rules', () => {
  it('lets the portal PUT a file and read its ETag, for as long as a browser may remember it', () => {
    const rule = corsRule(['https://d1tah6dqw2fe9f.cloudfront.net']);
    assert.equal(rule.ID, CORS_RULE_ID);
    assert.deepEqual(rule.AllowedOrigins, ['https://d1tah6dqw2fe9f.cloudfront.net']);
    assert.deepEqual(rule.AllowedMethods, ['PUT'], 'nothing else is opened up');
    assert.deepEqual(rule.ExposeHeaders, ['ETag']);
    assert.equal(rule.MaxAgeSeconds, 3000);
  });

  it('expires the staging folder after a day, under the portal\'s prefix, and aborts unfinished uploads', () => {
    for (const prefix of ['data', 'data/']) {
      const rule = lifecycleRule(prefix);
      assert.equal(rule.ID, LIFECYCLE_RULE_ID);
      assert.equal(rule.Filter.Prefix, 'data/upload-staging/');
      assert.equal(rule.Expiration.Days, 1);
      assert.equal(rule.AbortIncompleteMultipartUpload.DaysAfterInitiation, 1);
      assert.equal(rule.Status, 'Enabled');
    }
  });
});

describe('mergeRule', () => {
  it('adds the rule next to the ones that are there, and leaves them exactly as they are', () => {
    const merged = mergeRule([snapshots], lifecycleRule('data'));
    assert.deepEqual(merged.map((r: { ID: string }) => r.ID), ['expire-workspace-snapshots', LIFECYCLE_RULE_ID]);
    assert.deepEqual(merged[0], snapshots);
  });

  it('adds to a bucket that has nothing yet (no CORS today)', () => {
    assert.deepEqual(mergeRule([], corsRule(['https://x.example'])).length, 1);
    assert.deepEqual(mergeRule(undefined, corsRule(['https://x.example'])).length, 1);
  });

  it('replaces its own earlier rule instead of adding a second, keeping the order', () => {
    const old = { ...lifecycleRule('data'), Expiration: { Days: 7 } };
    const merged = mergeRule([old, snapshots], lifecycleRule('data'));
    assert.equal(merged.length, 2);
    assert.equal(merged[0].Expiration.Days, 1);
    assert.deepEqual(merged[1], snapshots);
  });

  it('does not change the list it was given', () => {
    const rules = [snapshots];
    mergeRule(rules, lifecycleRule('data'));
    assert.equal(rules.length, 1);
  });
});

describe('hasRule', () => {
  it('says whether exactly this rule is already there, so running it again changes nothing', () => {
    const rule = lifecycleRule('data');
    assert.equal(hasRule([snapshots, rule], rule), true);
    assert.equal(hasRule([snapshots], rule), false);
    assert.equal(hasRule([{ ...rule, Expiration: { Days: 2 } }], rule), false, 'a rule of the same ID with other settings is updated');
    assert.equal(hasRule(undefined, rule), false);
  });
});
