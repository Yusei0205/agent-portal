/**
 * DynamoDB implementation of InboxRepository.
 *
 * Table used: portal-runs
 *
 * Key design:
 *   PK=INBOX_ITEM#<id>    SK=#META           — canonical item (all fields)
 *   PK=INBOX_COUNT#<pid>  SK=#UNRESOLVED     — per-project unresolved counter
 *   PK=INBOX_COUNT#GLOBAL SK=#UNRESOLVED     — global unresolved counter
 *
 * GSI-InboxByProject:
 *   PK=inboxProjectId  SK=inboxSortKey ('<resolved>#<isoCreatedAt>#<id>')
 *   Used for per-project listing.
 *
 * GSI-InboxGlobal (sparse):
 *   PK=inboxGlobal ('INBOX')  SK=inboxSortKey
 *   inboxGlobal is SET on create (unresolved) and REMOVED on resolve.
 *   Used for admin global listing without a Scan.
 *
 * Resolve race-safety:
 *   resolveConditional uses TransactWriteItems:
 *     1. UpdateItem item: SET resolved=1, update inboxSortKey → condition resolved = 0
 *     2. UpdateItem project counter: ADD count -1
 *     3. UpdateItem global counter: ADD count -1
 *   Only one concurrent caller wins; the loser gets TransactionCanceledException.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  BatchGetItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import type { InboxRepository, InboxRecord, CreateInboxInput } from './inbox.ts';

// ── Table name ────────────────────────────────────────────────────────────────

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_RUNS ?? 'portal-runs-test';
}

// ── Row converter ─────────────────────────────────────────────────────────────

function itemToRecord(item: Record<string, AttributeValue>): InboxRecord {
  return {
    id: getString(item, 'id') ?? '',
    project_id: getString(item, 'project_id'),
    workflow_id: getString(item, 'workflow_id'),
    run_id: getString(item, 'run_id'),
    type: (getString(item, 'type') ?? 'push') as InboxRecord['type'],
    payload: getString(item, 'payload') ?? '{}',
    resolved: getNumber(item, 'resolved'),
    resolved_by: getString(item, 'resolved_by'),
    resolved_at: getString(item, 'resolved_at'),
    created_at: getString(item, 'created_at') ?? '',
  };
}

// ── Paginate helper ───────────────────────────────────────────────────────────

async function paginateQuery(
  client: DynamoDBClient,
  params: ConstructorParameters<typeof QueryCommand>[0],
  maxItems?: number,
): Promise<Array<Record<string, AttributeValue>>> {
  const items: Array<Record<string, AttributeValue>> = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await client.send(new QueryCommand({ ...params, ExclusiveStartKey: lastKey }));
    if (res.Items) items.push(...res.Items);
    lastKey = res.LastEvaluatedKey;
    if (maxItems != null && items.length >= maxItems) break;
  } while (lastKey);
  return items;
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbInboxRepository implements InboxRepository {
  private readonly client: DynamoDBClient;

  constructor() {
    this.client = getDynamoDbClient();
  }

  // ── Table setup (tests) ──────────────────────────────────────────────────────

  async ensureTables(): Promise<void> {
    const { CreateTableCommand, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');
    const tableName = table();
    try {
      await this.client.send(new DescribeTableCommand({ TableName: tableName }));
    } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e;
      await this.client.send(new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'inboxProjectId', AttributeType: 'S' },
          { AttributeName: 'inboxSortKey', AttributeType: 'S' },
          { AttributeName: 'inboxGlobal', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI-InboxByProject',
            KeySchema: [
              { AttributeName: 'inboxProjectId', KeyType: 'HASH' },
              { AttributeName: 'inboxSortKey', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI-InboxGlobal',
            KeySchema: [
              { AttributeName: 'inboxGlobal', KeyType: 'HASH' },
              { AttributeName: 'inboxSortKey', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }));
      let active = false;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const desc = await this.client.send(new DescribeTableCommand({ TableName: tableName }));
        if (desc.Table?.TableStatus === 'ACTIVE') { active = true; break; }
      }
      if (!active) throw new Error(`Table ${tableName} did not become ACTIVE in time`);
    }
  }

  async create(input: CreateInboxInput): Promise<InboxRecord> {
    const sortKey = `0#${input.created_at}#${input.id}`;
    const item: Record<string, AttributeValue> = {
      PK: av(`INBOX_ITEM#${input.id}`),
      SK: av('#META'),
      id: av(input.id),
      type: av(input.type),
      payload: av(input.payload),
      resolved: { N: '0' },
      created_at: av(input.created_at),
      // GSI-InboxGlobal — present on unresolved items (sparse)
      inboxGlobal: av('INBOX'),
      inboxSortKey: av(sortKey),
      ...marshalItem({
        project_id: input.project_id,
        workflow_id: input.workflow_id,
        run_id: input.run_id,
        resolved_by: null,
        resolved_at: null,
      }),
    };
    // GSI-InboxByProject — only when project_id is set
    if (input.project_id) {
      item['inboxProjectId'] = av(input.project_id);
    }

    await this.client.send(new PutItemCommand({
      TableName: table(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));

    // Increment counters (best-effort background writes)
    const counterPuts: Array<Promise<unknown>> = [];
    if (input.project_id) {
      counterPuts.push(this.client.send(new UpdateItemCommand({
        TableName: table(),
        Key: marshalItem({ PK: `INBOX_COUNT#${input.project_id}`, SK: '#UNRESOLVED' }),
        UpdateExpression: 'ADD #cnt :one',
        ExpressionAttributeNames: { '#cnt': 'count' },
        ExpressionAttributeValues: { ':one': { N: '1' } },
      })));
    }
    counterPuts.push(this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: marshalItem({ PK: 'INBOX_COUNT#GLOBAL', SK: '#UNRESOLVED' }),
      UpdateExpression: 'ADD #cnt :one',
      ExpressionAttributeNames: { '#cnt': 'count' },
      ExpressionAttributeValues: { ':one': { N: '1' } },
    })));
    await Promise.all(counterPuts);

    return itemToRecord(item);
  }

  async getById(id: string): Promise<InboxRecord | null> {
    const res = await this.client.send(new GetItemCommand({
      TableName: table(),
      Key: marshalItem({ PK: `INBOX_ITEM#${id}`, SK: '#META' }),
    }));
    return res.Item ? itemToRecord(res.Item) : null;
  }

  async listUnresolvedByProjects(
    projectIds: string[],
    opts: { limit: number; offset?: number },
  ): Promise<{ items: InboxRecord[]; total: number }> {
    if (projectIds.length === 0) return { items: [], total: 0 };
    const limit = opts.limit;

    // Query each project partition in parallel
    const perProjectResults = await Promise.all(
      projectIds.map((pid) =>
        paginateQuery(this.client, {
          TableName: table(),
          IndexName: 'GSI-InboxByProject',
          KeyConditionExpression: 'inboxProjectId = :pid AND begins_with(inboxSortKey, :prefix)',
          ExpressionAttributeValues: {
            ':pid': av(pid),
            ':prefix': av('0#'),
          },
          ScanIndexForward: false,
        }),
      ),
    );

    // Merge all items and sort newest first
    const allItems = perProjectResults
      .flat()
      .map(itemToRecord)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    const total = allItems.length;
    const offset = opts.offset ?? 0;
    const page = allItems.slice(offset, offset + limit);

    return { items: page, total };
  }

  async listAllUnresolved(opts: { limit: number; offset?: number }): Promise<{ items: InboxRecord[]; total: number }> {
    const limit = opts.limit;
    const items = await paginateQuery(this.client, {
      TableName: table(),
      IndexName: 'GSI-InboxGlobal',
      KeyConditionExpression: 'inboxGlobal = :g',
      ExpressionAttributeValues: { ':g': av('INBOX') },
      ScanIndexForward: false,
    });
    const records = items.map(itemToRecord);
    const total = records.length;
    const offset = opts.offset ?? 0;
    return { items: records.slice(offset, offset + limit), total };
  }

  async countUnresolvedByProjects(projectIds: string[]): Promise<number> {
    if (projectIds.length === 0) return 0;
    const keys = projectIds.map((pid) => ({
      PK: av(`INBOX_COUNT#${pid}`),
      SK: av('#UNRESOLVED'),
    }));
    // BatchGetItem in chunks of 100
    let total = 0;
    for (let i = 0; i < keys.length; i += 100) {
      const batch = keys.slice(i, i + 100);
      const res = await this.client.send(new BatchGetItemCommand({
        RequestItems: {
          [table()]: { Keys: batch },
        },
      }));
      for (const item of res.Responses?.[table()] ?? []) {
        total += Math.max(0, getNumber(item, 'count'));
      }
    }
    return total;
  }

  async countAllUnresolved(): Promise<number> {
    const res = await this.client.send(new GetItemCommand({
      TableName: table(),
      Key: marshalItem({ PK: 'INBOX_COUNT#GLOBAL', SK: '#UNRESOLVED' }),
    }));
    return res.Item ? Math.max(0, getNumber(res.Item, 'count')) : 0;
  }

  async resolveConditional(id: string, userId: string, resolvedAt: string): Promise<boolean> {
    // Read the item first to get project_id (needed for counter decrement)
    const existing = await this.getById(id);
    if (!existing) return false;
    if (existing.resolved !== 0) return false;

    const newSortKey = `1#${existing.created_at}#${id}`;

    type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteItemsCommand>[0]['TransactItems']>[number];
    const transactItems: TransactItem[] = [
      {
        Update: {
          TableName: table(),
          Key: marshalItem({ PK: `INBOX_ITEM#${id}`, SK: '#META' }),
          UpdateExpression: 'SET #resolved = :one, #resolved_by = :resolvedBy, #resolved_at = :resolvedAt, inboxSortKey = :newSk REMOVE inboxGlobal',
          ConditionExpression: '#resolved = :zero',
          ExpressionAttributeNames: {
            '#resolved': 'resolved',
            '#resolved_by': 'resolved_by',
            '#resolved_at': 'resolved_at',
          },
          ExpressionAttributeValues: {
            ':one': { N: '1' },
            ':zero': { N: '0' },
            ':resolvedBy': av(userId),
            ':resolvedAt': av(resolvedAt),
            ':newSk': av(newSortKey),
          },
        },
      },
    ];

    // Decrement global counter
    transactItems.push({
      Update: {
        TableName: table(),
        Key: marshalItem({ PK: 'INBOX_COUNT#GLOBAL', SK: '#UNRESOLVED' }),
        UpdateExpression: 'ADD #cnt :neg',
        ExpressionAttributeNames: { '#cnt': 'count' },
        ExpressionAttributeValues: { ':neg': { N: '-1' } },
      },
    });

    // Decrement project counter if scoped
    if (existing.project_id) {
      transactItems.push({
        Update: {
          TableName: table(),
          Key: marshalItem({ PK: `INBOX_COUNT#${existing.project_id}`, SK: '#UNRESOLVED' }),
          UpdateExpression: 'ADD #cnt :neg',
          ExpressionAttributeNames: { '#cnt': 'count' },
          ExpressionAttributeValues: { ':neg': { N: '-1' } },
        },
      });
    }

    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));
      return true;
    } catch (e: unknown) {
      const name = (e as { name?: string }).name ?? '';
      if (name === 'TransactionCanceledException') {
        const reasons = (e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return false; // already resolved
      }
      throw e;
    }
  }
}
