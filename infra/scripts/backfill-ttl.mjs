#!/usr/bin/env node
/**
 * Adds the `ttl` attribute (created_at/now + 14 days) to records written before TTL was switched on, so they expire too.
 * Dry run by default (counts only). `--apply` writes. Items older than 14 days expire at once, so check the count first.
 *   node infra/scripts/backfill-ttl.mjs [--apply] [--profile agentcore] [--region ap-southeast-1]
 * Covers portal-events (all items) and portal-testing (test runs, steps, traces, generations only).
 */
import { DynamoDBClient, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const apply = process.argv.includes('--apply');
const client = new DynamoDBClient({ region: arg('--region', 'ap-southeast-1'), credentials: fromIni({ profile: arg('--profile', 'agentcore') }) });
const DAY = 14 * 24 * 3600;
const now = Math.floor(Date.now() / 1000);
const targets = [
  { table: 'portal-events', filter: 'attribute_not_exists(#t)' },
  { table: 'portal-testing', filter: 'attribute_not_exists(#t) AND (begins_with(PK,:a) OR begins_with(PK,:b) OR begins_with(PK,:c) OR begins_with(PK,:d) OR begins_with(PK,:e))',
    values: { ':a': { S: 'TR#' }, ':b': { S: 'TRS#' }, ':c': { S: 'TRACE_CS#' }, ':d': { S: 'TRACE_GN#' }, ':e': { S: 'TGN#' } } },
];

for (const { table, filter, values } of targets) {
  let key, seen = 0, stale = 0, done = 0;
  do {
    const r = await client.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key, FilterExpression: filter,
      ExpressionAttributeNames: { '#t': 'ttl' }, ...(values ? { ExpressionAttributeValues: values } : {}),
      ProjectionExpression: 'PK, SK, created_at' }));
    key = r.LastEvaluatedKey;
    for (const it of r.Items ?? []) {
      seen++;
      const created = Date.parse(it.created_at?.S ?? '');
      const ttl = (Number.isFinite(created) ? Math.floor(created / 1000) : now) + DAY;
      if (ttl < now) stale++;
      if (apply) {
        await client.send(new UpdateItemCommand({ TableName: table, Key: { PK: it.PK, SK: it.SK },
          UpdateExpression: 'SET #t = :v', ExpressionAttributeNames: { '#t': 'ttl' }, ExpressionAttributeValues: { ':v': { N: String(ttl) } } }));
        done++;
      }
    }
  } while (key);
  console.log(`${table}: ${seen} without ttl, ${stale} already older than 14 days${apply ? `, ${done} updated` : ' (dry run)'}`);
}
