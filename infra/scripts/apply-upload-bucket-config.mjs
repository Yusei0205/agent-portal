#!/usr/bin/env node
/**
 * One-off setup of the portal's storage bucket for direct uploads (attachments up to 50 MB).
 *
 * The browser PUTs a file straight to S3 with a presigned link, which needs two things on the bucket that CDK cannot set because
 * the bucket is imported, not created by the stack:
 *
 *   1. CORS: the portal's address may PUT. The bucket has none today.
 *   2. A lifecycle rule that expires `data/upload-staging/` after a day, for files that were uploaded and never completed.
 *
 * Both calls REPLACE the bucket's whole configuration, so this reads what is there and adds or updates only its own two rules
 * (the existing `expire-workspace-snapshots` rule is kept). Without --apply it only shows what it would write.
 *
 *   node infra/scripts/apply-upload-bucket-config.mjs --bucket cy-ai-bucket --origin https://d1tah6dqw2fe9f.cloudfront.net
 *   node infra/scripts/apply-upload-bucket-config.mjs --bucket cy-ai-bucket --origin https://... --apply
 *
 * Options: --region (default ap-southeast-1), --prefix (the portal's STORAGE_S3_PREFIX, default data), AWS_PROFILE as usual.
 * More than one origin: repeat --origin.
 */

import { pathToFileURL } from 'node:url';

export const CORS_RULE_ID = 'portal-direct-upload';
export const LIFECYCLE_RULE_ID = 'expire-upload-staging';

/** The CORS rule: the portal's origins may PUT a file and read its ETag back. */
export function corsRule(origins) {
  return {
    ID: CORS_RULE_ID,
    AllowedOrigins: origins,
    AllowedMethods: ['PUT'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3000,
  };
}

/** The lifecycle rule: whatever is left in the staging folder after a day goes, and so do unfinished multipart uploads. */
export function lifecycleRule(prefix) {
  return {
    ID: LIFECYCLE_RULE_ID,
    Status: 'Enabled',
    Filter: { Prefix: `${prefix.replace(/\/+$/, '')}/upload-staging/` },
    Expiration: { Days: 1 },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
  };
}

/** `existing` rules with this one added, or replaced when a rule of the same ID is there. The others are untouched, in their order. */
export function mergeRule(existing, rule) {
  const rules = Array.isArray(existing) ? existing : [];
  const at = rules.findIndex((r) => r.ID === rule.ID);
  return at < 0 ? [...rules, rule] : rules.map((r, i) => (i === at ? rule : r));
}

/** True when `rules` already holds exactly this rule. */
export function hasRule(rules, rule) {
  return Array.isArray(rules) && rules.some((r) => r.ID === rule.ID && JSON.stringify(r) === JSON.stringify(rule));
}

function parseArgs(argv) {
  const out = { origins: [], region: 'ap-southeast-1', prefix: 'data', apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--bucket') out.bucket = argv[++i];
    else if (a === '--origin') out.origins.push(argv[++i]);
    else if (a === '--region') out.region = argv[++i];
    else if (a === '--prefix') out.prefix = argv[++i];
    else throw new Error(`Unknown option ${a}`);
  }
  if (!out.bucket) throw new Error('--bucket is required');
  if (out.origins.length === 0) throw new Error('--origin is required (the portal address, for example https://d1tah6dqw2fe9f.cloudfront.net)');
  for (const o of out.origins) if (!/^https?:\/\/[^/\s*]+$/.test(o)) throw new Error(`--origin must be a bare address like https://host, got "${o}"`);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { S3Client, GetBucketCorsCommand, PutBucketCorsCommand, GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: args.region });
  const missing = (e) => ['NoSuchCORSConfiguration', 'NoSuchLifecycleConfiguration'].includes(e?.name);

  const cors = await s3.send(new GetBucketCorsCommand({ Bucket: args.bucket })).then((r) => r.CORSRules ?? [], (e) => { if (missing(e)) return []; throw e; });
  const life = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: args.bucket })).then((r) => r.Rules ?? [], (e) => { if (missing(e)) return []; throw e; });
  const wantCors = corsRule(args.origins);
  const wantLife = lifecycleRule(args.prefix);

  console.log(`Bucket ${args.bucket} (${args.region})`);
  console.log(`CORS now: ${cors.length ? cors.map((r) => r.ID ?? '(no id)').join(', ') : 'none'}`);
  console.log(`Lifecycle now: ${life.length ? life.map((r) => r.ID ?? '(no id)').join(', ') : 'none'}`);
  const corsDone = hasRule(cors, wantCors);
  const lifeDone = hasRule(life, wantLife);
  console.log(`\nCORS rule ${CORS_RULE_ID}: ${corsDone ? 'already as wanted' : 'will be written'}\n${JSON.stringify(wantCors, null, 2)}`);
  console.log(`\nLifecycle rule ${LIFECYCLE_RULE_ID}: ${lifeDone ? 'already as wanted' : 'will be written'}\n${JSON.stringify(wantLife, null, 2)}`);
  console.log(`\nOther rules kept as they are: CORS ${cors.filter((r) => r.ID !== CORS_RULE_ID).length}, lifecycle ${life.filter((r) => r.ID !== LIFECYCLE_RULE_ID).length}`);

  if (!args.apply) { console.log('\nNothing was changed. Run again with --apply to write it.'); return; }
  if (!corsDone) await s3.send(new PutBucketCorsCommand({ Bucket: args.bucket, CORSConfiguration: { CORSRules: mergeRule(cors, wantCors) } }));
  if (!lifeDone) await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket: args.bucket, LifecycleConfiguration: { Rules: mergeRule(life, wantLife) } }));
  console.log('\nApplied. Check with: aws s3api get-bucket-cors / get-bucket-lifecycle-configuration');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Failed: ${e.message}`); process.exit(1); });
}
