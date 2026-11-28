/**
 * DynamoDB implementation of FeedbackRepository.
 *
 * Table: portal-feedback  (DYNAMODB_TABLE_PORTAL_FEEDBACK, default 'portal-feedback'; defined in infra/tables.json)
 * Key design:  PK=FEEDBACK   SK=FB#<id>
 * Updates read, merge and write the whole item. Feedback is edited by a few admins and never in a hot loop.
 */

import { GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import type { FeedbackPatch, FeedbackRecord, FeedbackRepository } from './feedback.ts';

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_FEEDBACK ?? 'portal-feedback';
}

export async function ensureFeedbackTableExists(client: DynamoDBClient): Promise<void> {
  const { CreateTableCommand, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');
  const tableName = table();
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (e: unknown) {
    if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e;
    await client.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
    }));
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const desc = await client.send(new DescribeTableCommand({ TableName: tableName }));
      if (desc.Table?.TableStatus === 'ACTIVE') break;
    }
  }
}

function itemToRecord(item: Record<string, AttributeValue>): FeedbackRecord {
  return {
    id: getString(item, 'id') ?? '',
    user_id: getString(item, 'user_id') ?? '',
    user_name: getString(item, 'user_name'),
    kind: (getString(item, 'kind') ?? 'other') as FeedbackRecord['kind'],
    title: getString(item, 'title') ?? '',
    body: getString(item, 'body') ?? '',
    page: getString(item, 'page'),
    status: (getString(item, 'status') ?? 'new') as FeedbackRecord['status'],
    admin_note: getString(item, 'admin_note'),
    project_id: getString(item, 'project_id'),
    workflow_id: getString(item, 'workflow_id'),
    repo_id: getString(item, 'repo_id'),
    branch: getString(item, 'branch'),
    pr_url: getString(item, 'pr_url'),
    pr_number: item.pr_number ? getNumber(item, 'pr_number') : null,
    decision_note: getString(item, 'decision_note'),
    decided_by_name: getString(item, 'decided_by_name'),
    decided_at: getString(item, 'decided_at'),
    created_at: getString(item, 'created_at') ?? '',
    updated_at: getString(item, 'updated_at') ?? '',
  };
}

function recordToItem(rec: FeedbackRecord): Record<string, AttributeValue> {
  return {
    PK: av('FEEDBACK'),
    SK: av(`FB#${rec.id}`),
    ...marshalItem(rec as unknown as Record<string, string | number | null>),
  };
}

export class DynamoDbFeedbackRepository implements FeedbackRepository {
  private readonly client: DynamoDBClient;
  constructor() { this.client = getDynamoDbClient(); }

  async ensureTables(): Promise<void> {
    await ensureFeedbackTableExists(this.client);
  }

  async create(rec: FeedbackRecord): Promise<void> {
    await this.client.send(new PutItemCommand({ TableName: table(), Item: recordToItem(rec) }));
  }

  async getById(id: string): Promise<FeedbackRecord | null> {
    const res = await this.client.send(new GetItemCommand({
      TableName: table(),
      Key: { PK: av('FEEDBACK'), SK: av(`FB#${id}`) },
      ConsistentRead: true,
    }));
    return res.Item ? itemToRecord(res.Item) : null;
  }

  async listAll(): Promise<FeedbackRecord[]> {
    const out: FeedbackRecord[] = [];
    let key: Record<string, AttributeValue> | undefined;
    do {
      const res = await this.client.send(new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ExpressionAttributeValues: { ':pk': av('FEEDBACK'), ':p': av('FB#') },
        ExclusiveStartKey: key,
      }));
      for (const it of res.Items ?? []) out.push(itemToRecord(it));
      key = res.LastEvaluatedKey;
    } while (key);
    return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 500);
  }

  async listByUser(userId: string): Promise<FeedbackRecord[]> {
    return (await this.listAll()).filter((f) => f.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 200);
  }

  async update(id: string, patch: FeedbackPatch): Promise<FeedbackRecord | null> {
    const cur = await this.getById(id);
    if (!cur) return null;
    const next: FeedbackRecord = { ...cur, ...patch, id: cur.id, user_id: cur.user_id, created_at: cur.created_at };
    await this.create(next);
    return next;
  }
}
