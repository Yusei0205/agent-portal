/**
 * DynamoDB implementation of AuditRepository.
 *
 * Table: portal-projects (DYNAMODB_TABLE_PORTAL_PROJECTS, default 'portal-projects')
 *
 * Key schema (audit entries):
 *   PK = AUDIT#<yearMonthUTC>   (e.g. AUDIT#2026-11)
 *   SK = <isoTs>#<entryId>      (ISO timestamp prefix → lexicographic order = time order)
 *
 * Key schema (metadata):
 *   PK = AUDIT_META   SK = #FIRST_MONTH   → earliest audit month (set on first append)
 *
 * GSI-ActorAudit:
 *   PK = actorId, SK = ts       → actor-filtered queries (D3)
 *
 * Portal-users table (DYNAMODB_TABLE_PORTAL_USERS, default 'portal-users'):
 *   Used for batched actor name/email lookups after the audit query.
 *
 * ## Pagination
 *   Monthly partitions: each page needs at most 1–2 Query calls even on a sparse log.
 *   Date-partitioned queries return a cursor encoding { month, lastKey } so that
 *   page 2 resumes from exactly where page 1 stopped. Iteration runs from the
 *   current month down to the stored AUDIT_META#FIRST_MONTH, not a fixed window.
 */

import {
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
  BatchGetItemCommand,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  getDynamoDbClient,
  marshalItem,
  getString,
  type JsVal,
} from './dynamo-client.ts';
import { now } from '../util.ts';
import type {
  AuditRepository,
  AuditEntry,
  AppendAuditInput,
  AuditQueryOptions,
  AuditQueryResult,
} from './audit.ts';
import { generateId } from '../util.ts';

// ── Table bootstrap ───────────────────────────────────────────────────────────

export async function ensureAuditTableExists(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return;
  } catch (e: unknown) {
    if (!(e instanceof ResourceNotFoundException)) throw e;
  }
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'PK',      AttributeType: 'S' },
          { AttributeName: 'SK',      AttributeType: 'S' },
          { AttributeName: 'actorId', AttributeType: 'S' },
          { AttributeName: 'ts',      AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI-ActorAudit',
            KeySchema: [
              { AttributeName: 'actorId', KeyType: 'HASH' },
              { AttributeName: 'ts',      KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  } catch (e: unknown) {
    if (!(e instanceof ResourceInUseException)) throw e;
  }
}

// ── Item converter ─────────────────────────────────────────────────────────────

function itemToEntry(item: Record<string, AttributeValue>): AuditEntry {
  let detail: object = {};
  try { detail = JSON.parse(getString(item, 'detail') ?? '{}'); } catch { /* keep {} */ }

  return {
    id:     getString(item, 'entryId') ?? '',
    ts:     getString(item, 'ts') ?? '',
    actor_id:    getString(item, 'actorId'),
    actor_name:  null,   // filled by enrichWithActors()
    actor_email: null,   // filled by enrichWithActors()
    action:      getString(item, 'action') ?? '',
    target:      getString(item, 'target'),
    detail,
    ip:          getString(item, 'ip'),
  };
}

// ── Date/month helpers ─────────────────────────────────────────────────────────

function monthFromIso(iso: string): string {
  return iso.slice(0, 7); // 'yyyy-mm'
}

/**
 * Generate UTC year-months from `startMonth` down to `endMonth` (inclusive),
 * newest first.  Returns at most `maxMonths` entries.
 */
function monthRange(startMonth: string, endMonth: string, maxMonths = 120): string[] {
  const months: string[] = [];
  const [sy, sm] = startMonth.split('-').map(Number);
  const [ey, em] = endMonth.split('-').map(Number);
  let y = sy, m = sm;

  while ((y > ey || (y === ey && m >= em)) && months.length < maxMonths) {
    months.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
    m--;
    if (m === 0) { m = 12; y--; }
  }
  return months;
}

// ── Actor enrichment ──────────────────────────────────────────────────────────

/**
 * Enrich audit entries with actor name and email from the portal-users table.
 * Uses a single BatchGetItem call per unique actorId.
 */
async function enrichWithActors(
  entries: AuditEntry[],
  client: DynamoDBClient,
  usersTable: string,
): Promise<void> {
  const actorIds = [...new Set(entries.map((e) => e.actor_id).filter((id): id is string => id != null))];
  if (actorIds.length === 0) return;

  const BATCH = 100;
  const userMap = new Map<string, { name: string | null; email: string | null }>();

  for (let i = 0; i < actorIds.length; i += BATCH) {
    const slice = actorIds.slice(i, i + BATCH);
    let remaining = slice.map((id) => ({
      PK: { S: `USER#${id}` },
      SK: { S: '#META' },
    }));
    let attempt = 0;

    while (remaining.length > 0) {
      let resp;
      try {
        resp = await client.send(
          new BatchGetItemCommand({
            RequestItems: { [usersTable]: { Keys: remaining } },
          }),
        );
      } catch (e: unknown) {
        // If the users table doesn't exist (e.g. in audit-only tests), skip enrichment
        if (e instanceof Error && (e.name === 'ResourceNotFoundException' || e.name === 'ResourceNotExistsException')) {
          return;
        }
        throw e;
      }
      for (const item of resp.Responses?.[usersTable] ?? []) {
        const id = getString(item, 'id');
        if (id) {
          userMap.set(id, {
            name:  getString(item, 'name'),
            email: getString(item, 'email'),
          });
        }
      }
      const unprocessed = resp.UnprocessedKeys?.[usersTable]?.Keys;
      if (!unprocessed || unprocessed.length === 0) break;
      remaining = unprocessed as Array<{ PK: { S: string }; SK: { S: string } }>;
      attempt++;
      await new Promise<void>((r) => setTimeout(r, Math.min(50 * 2 ** attempt, 2000)));
    }
  }

  for (const entry of entries) {
    if (entry.actor_id && userMap.has(entry.actor_id)) {
      const u = userMap.get(entry.actor_id)!;
      entry.actor_name  = u.name;
      entry.actor_email = u.email;
    }
  }
}

// ── Cursor encoding ───────────────────────────────────────────────────────────

interface DateCursor {
  date: string;
  lastKey: Record<string, AttributeValue> | null;
}

function encodeCursor(c: DateCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64');
}

function decodeCursor(s: string): DateCursor | null {
  try {
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as DateCursor;
  } catch {
    return null;
  }
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbAuditRepository implements AuditRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;
  private readonly usersTableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string; usersTableName?: string }) {
    this.client = opts?.client ?? getDynamoDbClient();
    this.tableName =
      opts?.tableName ??
      process.env.DYNAMODB_TABLE_PORTAL_PROJECTS ??
      'portal-projects';
    this.usersTableName =
      opts?.usersTableName ??
      process.env.DYNAMODB_TABLE_PORTAL_USERS ??
      'portal-users';
  }

  async append(input: AppendAuditInput): Promise<void> {
    const ts = now();
    const entryId = generateId();
    const month = monthFromIso(ts);
    const sk = `${ts}#${entryId}`;

    const item: Record<string, JsVal> = {
      PK:      `AUDIT#${month}`,
      SK:      sk,
      entryId,
      ts,
      action:  input.action,
      detail:  JSON.stringify(input.detail ?? {}),
    };
    if (input.actorId != null) item.actorId = input.actorId;
    if (input.target != null) item.target = input.target;
    if (input.ip != null) item.ip = input.ip;

    await this.client.send(
      new PutItemCommand({ TableName: this.tableName, Item: marshalItem(item) }),
    );

    // Record the earliest audit month (set-if-not-exists) so pagination can
    // find the oldest entries without looping over an unbounded month range.
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { PK: { S: 'AUDIT_META' }, SK: { S: '#FIRST_MONTH' } },
        UpdateExpression: 'SET firstMonth = if_not_exists(firstMonth, :m)',
        ExpressionAttributeValues: marshalItem({ ':m': month }),
      }),
    );
  }

  /**
   * Return the earliest recorded audit month, or 12 months ago if no metadata exists.
   * This bounds month-partition iteration without an unbounded loop.
   */
  private async getEarliestMonth(): Promise<string> {
    try {
      const resp = await this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: { PK: { S: 'AUDIT_META' }, SK: { S: '#FIRST_MONTH' } },
        }),
      );
      const m = resp.Item ? getString(resp.Item, 'firstMonth') : null;
      if (m) return m;
    } catch {
      // Ignore errors — fall back to 12-month window
    }
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - 12);
    return d.toISOString().slice(0, 7);
  }

  async query(opts: AuditQueryOptions): Promise<AuditQueryResult> {
    const limit = opts.limit;
    const actorId = opts.actorId;
    const actionPrefix = opts.action;

    // Actor-filtered: use GSI-ActorAudit
    if (actorId) {
      return this._queryByActor(actorId, actionPrefix, limit, opts.cursor);
    }

    // Unfiltered: iterate date partitions newest-first
    return this._queryByDate(actionPrefix, limit, opts.cursor);
  }

  private async _queryByActor(
    actorId: string,
    actionPrefix: string | undefined,
    limit: number,
    cursor?: string,
  ): Promise<AuditQueryResult> {
    const entries: AuditEntry[] = [];
    let lastKey: Record<string, AttributeValue> | undefined = cursor
      ? (JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as Record<string, AttributeValue>)
      : undefined;

    const filter = actionPrefix ? 'begins_with(#act, :ap)' : undefined;
    const exprNames = actionPrefix ? { '#act': 'action' } : undefined;
    const extraVals: Record<string, JsVal> = {};
    if (actionPrefix) extraVals[':ap'] = actionPrefix;

    do {
      const resp = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'GSI-ActorAudit',
          KeyConditionExpression: 'actorId = :aid',
          ...(filter ? { FilterExpression: filter } : {}),
          ExpressionAttributeValues: marshalItem({ ':aid': actorId, ...extraVals }),
          ...(exprNames ? { ExpressionAttributeNames: exprNames } : {}),
          ScanIndexForward: false,
          Limit: limit - entries.length,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      entries.push(...(resp.Items ?? []).map(itemToEntry));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey && entries.length < limit);

    const hasMore = !!lastKey;
    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify(lastKey)).toString('base64')
      : undefined;

    const result = entries.slice(0, limit);
    await enrichWithActors(result, this.client, this.usersTableName);

    return { entries: result, total: null, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  }

  private async _queryByDate(
    actionPrefix: string | undefined,
    limit: number,
    cursor?: string,
  ): Promise<AuditQueryResult> {
    const entries: AuditEntry[] = [];

    // Decode cursor: { month, lastKey }
    let resumeMonth: string | null = null;
    let resumeKey: Record<string, AttributeValue> | undefined;

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        resumeMonth = decoded.date;  // field name kept as 'date' for cursor compat
        resumeKey = decoded.lastKey ?? undefined;
      }
    }

    const currentMonth = new Date().toISOString().slice(0, 7);
    const startMonth = resumeMonth ?? currentMonth;
    const earliestMonth = await this.getEarliestMonth();

    const months = monthRange(startMonth, earliestMonth);

    let finalMonth: string | undefined;
    let finalKey: Record<string, AttributeValue> | undefined;

    for (let mi = 0; mi < months.length; mi++) {
      const month = months[mi];
      if (entries.length >= limit) {
        finalMonth = month;
        finalKey = undefined;
        break;
      }

      // Only use the resume key for the first month in iteration
      let partitionKey: Record<string, AttributeValue> | undefined =
        (mi === 0) ? resumeKey : undefined;

      do {
        const filter = actionPrefix ? 'begins_with(#act, :ap)' : undefined;
        const exprNames = actionPrefix ? { '#act': 'action' } : undefined;
        const extraVals: Record<string, JsVal> = {};
        if (actionPrefix) extraVals[':ap'] = actionPrefix;

        const resp = await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'PK = :pk',
            ...(filter ? { FilterExpression: filter } : {}),
            ExpressionAttributeValues: marshalItem({ ':pk': `AUDIT#${month}`, ...extraVals }),
            ...(exprNames ? { ExpressionAttributeNames: exprNames } : {}),
            ScanIndexForward: false,
            Limit: limit - entries.length,
            ...(partitionKey ? { ExclusiveStartKey: partitionKey } : {}),
          }),
        );
        entries.push(...(resp.Items ?? []).map(itemToEntry));
        partitionKey = resp.LastEvaluatedKey;

        if (partitionKey && entries.length >= limit) {
          finalMonth = month;
          finalKey = partitionKey;
          break;
        }
      } while (partitionKey && entries.length < limit);

      if (finalMonth) break;
    }

    const hasMore = finalMonth != null;
    let nextCursor: string | undefined;
    if (hasMore && finalMonth) {
      nextCursor = encodeCursor({ date: finalMonth, lastKey: finalKey ?? null });
    }

    const result = entries.slice(0, limit);
    await enrichWithActors(result, this.client, this.usersTableName);

    return { entries: result, total: null, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  }

  /** Expose internals for test setup. */
  getClient(): DynamoDBClient { return this.client; }
  getTableName(): string { return this.tableName; }
}
