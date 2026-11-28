/**
 * DynamoDB implementation of GitReposRepository.
 *
 * Table: portal-code
 * PK=REPO#<projectId>  SK=REPO#<isoCreatedAt>#<id>
 * GSI-P10EntityId: PK=id, SK=entityType='repo'
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
import type { GitReposRepository, GitRepoRecord, CreateGitRepoInput } from './git-repos.ts';

function table(): string { return process.env.DYNAMODB_TABLE_PORTAL_CODE ?? 'portal-code-test'; }
function pk(projectId: string): string { return `REPO#${projectId}`; }
function sk(createdAt: string, id: string): string { return `REPO#${createdAt}#${id}`; }

function itemToRecord(item: Record<string, AttributeValue>): GitRepoRecord {
  return {
    id: getString(item, 'id') ?? '',
    project_id: getString(item, 'project_id') ?? '',
    name: getString(item, 'name') ?? '',
    url: getString(item, 'url') ?? '',
    provider: getString(item, 'provider') ?? '',
    status: getString(item, 'status') ?? '',
    default_branch: getString(item, 'default_branch'),
    identity: getString(item, 'identity'),
    last_synced_at: getString(item, 'last_synced_at'),
    last_error: getString(item, 'last_error'),
    created_at: getString(item, 'created_at') ?? '',
    connection_id: getString(item, 'connection_id'),
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

export class DynamoDbGitReposRepository implements GitReposRepository {
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

  async create(input: CreateGitRepoInput): Promise<GitRepoRecord> {
    const item = {
      PK: av(pk(input.project_id)), SK: av(sk(input.created_at, input.id)),
      id: av(input.id), entityType: av('repo'),
      ...marshalItem({ project_id: input.project_id, name: input.name, url: input.url,
        provider: input.provider, status: input.status, default_branch: input.default_branch,
        identity: input.identity, last_synced_at: input.last_synced_at, last_error: input.last_error,
        created_at: input.created_at, connection_id: input.connection_id }),
    };
    await this.client.send(new PutItemCommand({ TableName: table(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    return itemToRecord(item);
  }

  async getById(id: string): Promise<GitRepoRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(), IndexName: 'GSI-P10EntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('repo') }, Limit: 1,
    }));
    const item = res.Items?.[0];
    return item ? itemToRecord(item) : null;
  }

  async getByIdForProject(id: string, projectId: string): Promise<GitRepoRecord | null> {
    const f = await this.getById(id);
    if (!f || f.project_id !== projectId) return null;
    return f;
  }

  async listByProject(projectId: string): Promise<GitRepoRecord[]> {
    const items = await paginateAll(this.client, { TableName: table(), KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': av(pk(projectId)) } });
    return items.map(itemToRecord).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listUrlsByProject(projectId: string): Promise<string[]> {
    const items = await this.listByProject(projectId);
    return items.map((r) => r.url);
  }

  async updateStatus(id: string, status: string, extra?: { lastSyncedAt?: string | null; defaultBranch?: string | null; lastError?: string | null }): Promise<void> {
    const f = await this.getById(id);
    if (!f) return;
    const patch: Record<string, string | null> = { status };
    if (extra?.lastSyncedAt !== undefined) patch.last_synced_at = extra.lastSyncedAt;
    if (extra?.defaultBranch !== undefined) patch.default_branch = extra.defaultBranch;
    if (extra?.lastError !== undefined) patch.last_error = extra.lastError;
    const keys = Object.keys(patch);
    const exprParts = keys.map((_, i) => `#f${i} = :v${i}`);
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};
    keys.forEach((k, i) => { names[`#f${i}`] = k; vals[`:v${i}`] = av(patch[k]); });
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: av(pk(f.project_id)), SK: av(sk(f.created_at, id)) },
      UpdateExpression: `SET ${exprParts.join(', ')}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: vals,
    }));
  }

  async updateDefaultBranch(id: string, branch: string): Promise<void> {
    await this.updateStatus(id, 'ready', { defaultBranch: branch });
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const f = await this.getByIdForProject(id, projectId);
    if (!f) return false;
    await this.client.send(new DeleteItemCommand({ TableName: table(), Key: { PK: av(pk(projectId)), SK: av(sk(f.created_at, id)) } }));
    return true;
  }
}
