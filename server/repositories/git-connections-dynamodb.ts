/**
 * DynamoDB implementation of GitConnectionsRepository.
 *
 * Table: portal-p10
 * PK=GITCONN#<userId>   SK=CONN#<id>   (personal)
 * PK=GITCONN_SHARED     SK=CONN#<id>   (shared)
 * GSI-P10EntityId: PK=id, SK=entityType='gitconn'
 */

import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, av } from './dynamo-client.ts';
import type { GitConnectionsRepository, GitConnectionRecord, CreateGitConnectionInput } from './git-connections.ts';

function table(): string { return process.env.DYNAMODB_TABLE_PORTAL_P10 ?? 'portal-p10-test'; }

function pk(ownerId: string | null, scope: string): string {
  return scope === 'shared' ? 'GITCONN_SHARED' : `GITCONN#${ownerId ?? 'anon'}`;
}
function sk(id: string): string { return `CONN#${id}`; }

function itemToRecord(item: Record<string, AttributeValue>): GitConnectionRecord {
  return {
    id: getString(item, 'id') ?? '',
    name: getString(item, 'name') ?? '',
    provider: getString(item, 'provider') ?? '',
    credentials_enc: getString(item, 'credentials_enc'),
    scope: getString(item, 'scope') ?? 'personal',
    owner_id: getString(item, 'owner_id'),
    created_at: getString(item, 'created_at') ?? '',
  };
}

async function paginateAll(client: DynamoDBClient, params: ConstructorParameters<typeof QueryCommand>[0]): Promise<Array<Record<string, AttributeValue>>> {
  const items: Array<Record<string, AttributeValue>> = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await client.send(new QueryCommand({ ...params, ExclusiveStartKey: lastKey }));
    if (res.Items) items.push(...res.Items);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export class DynamoDbGitConnectionsRepository implements GitConnectionsRepository {
  private readonly client: DynamoDBClient;
  constructor() { this.client = getDynamoDbClient(); }

  async ensureTables(): Promise<void> {
    const { CreateTableCommand, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');
    const tbl = table();
    try { await this.client.send(new DescribeTableCommand({ TableName: tbl })); return; } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e;
    }
    await this.client.send(new CreateTableCommand({
      TableName: tbl, BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'id', AttributeType: 'S' }, { AttributeName: 'entityType', AttributeType: 'S' },
        { AttributeName: 'workflowId', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        { IndexName: 'GSI-P10EntityId', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }, { AttributeName: 'entityType', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
        { IndexName: 'GSI-P10WorkflowId', KeySchema: [{ AttributeName: 'workflowId', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' } },
      ],
    }));
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const desc = await this.client.send(new DescribeTableCommand({ TableName: tbl }));
      if (desc.Table?.TableStatus === 'ACTIVE') return;
    }
    throw new Error(`Table ${tbl} did not become ACTIVE`);
  }

  async create(input: CreateGitConnectionInput): Promise<GitConnectionRecord> {
    const item = {
      PK: av(pk(input.owner_id, input.scope)), SK: av(sk(input.id)),
      id: av(input.id), entityType: av('gitconn'),
      ...marshalItem({ name: input.name, provider: input.provider, credentials_enc: input.credentials_enc,
        scope: input.scope, owner_id: input.owner_id, created_at: input.created_at }),
    };
    await this.client.send(new PutItemCommand({ TableName: table(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    return itemToRecord(item);
  }

  async getById(id: string): Promise<GitConnectionRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(), IndexName: 'GSI-P10EntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('gitconn') },
      Limit: 1,
    }));
    const item = res.Items?.[0];
    return item ? itemToRecord(item) : null;
  }

  async listByUserOrShared(userId: string): Promise<GitConnectionRecord[]> {
    const [personal, shared] = await Promise.all([
      paginateAll(this.client, { TableName: table(), KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': av(`GITCONN#${userId}`) } }),
      paginateAll(this.client, { TableName: table(), KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': av('GITCONN_SHARED') } }),
    ]);
    return [...personal, ...shared].map(itemToRecord).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listByProviderForUser(provider: string, userId: string): Promise<GitConnectionRecord[]> {
    const all = await this.listByUserOrShared(userId);
    return all.filter((c) => c.provider === provider);
  }

  async update(id: string, patch: Partial<GitConnectionRecord>): Promise<GitConnectionRecord | null> {
    const f = await this.getById(id);
    if (!f) return null;
    const keys = Object.keys(patch).filter((k) => !['id', 'created_at'].includes(k));
    if (keys.length === 0) return f;
    const exprParts = keys.map((_, i) => `#f${i} = :v${i}`);
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};
    keys.forEach((k, i) => { names[`#f${i}`] = k; vals[`:v${i}`] = av((patch as Record<string, unknown>)[k] as string | null); });
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: av(pk(f.owner_id, f.scope)), SK: av(sk(id)) },
      UpdateExpression: `SET ${exprParts.join(', ')}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: vals,
    }));
    return { ...f, ...patch };
  }

  async delete(id: string): Promise<boolean> {
    const f = await this.getById(id);
    if (!f) return false;
    await this.client.send(new DeleteItemCommand({ TableName: table(), Key: { PK: av(pk(f.owner_id, f.scope)), SK: av(sk(id)) } }));
    return true;
  }
}
