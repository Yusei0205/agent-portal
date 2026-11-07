/**
 * DynamoDB implementation of WorkspacesRepository.
 *
 * Table: portal-code
 * PK=WS#<projectId>  SK=WS#<isoCreatedAt>#<id>
 * GSI-P10EntityId: PK=id, SK=entityType
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, av } from './dynamo-client.ts';
import type { WorkspacesRepository, WorkspaceRecord, CreateWorkspaceInput } from './workspaces.ts';

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_CODE ?? 'portal-code-test';
}

function pk(projectId: string): string { return `WS#${projectId}`; }
function sk(createdAt: string, id: string): string { return `WS#${createdAt}#${id}`; }

function itemToRecord(item: Record<string, AttributeValue>): WorkspaceRecord {
  return {
    id: getString(item, 'id') ?? '',
    project_id: getString(item, 'project_id') ?? '',
    name: getString(item, 'name') ?? '',
    repo_ids: getString(item, 'repo_ids') ?? '[]',
    created_at: getString(item, 'created_at') ?? '',
    default_engine: getString(item, 'default_engine') ?? '',
    default_agent: getString(item, 'default_agent') ?? '',
    default_model: getString(item, 'default_model') ?? '',
  };
}

export class DynamoDbWorkspacesRepository implements WorkspacesRepository {
  private readonly client: DynamoDBClient;
  constructor() { this.client = getDynamoDbClient(); }

  async ensureTables(): Promise<void> {
    const { CreateTableCommand, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');
    const tbl = table();
    try { await this.client.send(new DescribeTableCommand({ TableName: tbl })); return; } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e;
    }
    await this.client.send(new CreateTableCommand({
      TableName: tbl,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'id', AttributeType: 'S' },
        { AttributeName: 'entityType', AttributeType: 'S' },
        { AttributeName: 'workflowId', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-P10EntityId',
          KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }, { AttributeName: 'entityType', KeyType: 'RANGE' }],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI-P10WorkflowId',
          KeySchema: [{ AttributeName: 'workflowId', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }));
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const desc = await this.client.send(new DescribeTableCommand({ TableName: tbl }));
      if (desc.Table?.TableStatus === 'ACTIVE') return;
    }
    throw new Error(`Table ${tbl} did not become ACTIVE`);
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const item = {
      PK: av(pk(input.project_id)), SK: av(sk(input.created_at, input.id)),
      id: av(input.id), entityType: av('workspace'),
      ...marshalItem({ project_id: input.project_id, name: input.name, repo_ids: input.repo_ids,
        created_at: input.created_at, default_engine: input.default_engine,
        default_agent: input.default_agent, default_model: input.default_model }),
    };
    await this.client.send(new PutItemCommand({ TableName: table(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    return itemToRecord(item);
  }

  async getById(id: string): Promise<WorkspaceRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(), IndexName: 'GSI-P10EntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('workspace') },
      Limit: 1,
    }));
    const item = res.Items?.[0];
    return item ? itemToRecord(item) : null;
  }

  async getByIdForProject(id: string, projectId: string): Promise<WorkspaceRecord | null> {
    const f = await this.getById(id);
    if (!f || f.project_id !== projectId) return null;
    return f;
  }

  async listByProject(projectId: string): Promise<WorkspaceRecord[]> {
    const items: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const res = await this.client.send(new QueryCommand({
        TableName: table(), KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': av(pk(projectId)) },
        ExclusiveStartKey: lastKey,
      }));
      if (res.Items) items.push(...res.Items);
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return items.map(itemToRecord).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async update(id: string, projectId: string, patch: Partial<WorkspaceRecord>): Promise<WorkspaceRecord | null> {
    const f = await this.getByIdForProject(id, projectId);
    if (!f) return null;
    const keys = Object.keys(patch).filter((k) => !['id', 'project_id', 'created_at'].includes(k));
    if (keys.length === 0) return f;
    const exprParts = keys.map((k, i) => `#f${i} = :v${i}`);
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};
    keys.forEach((k, i) => {
      names[`#f${i}`] = k;
      vals[`:v${i}`] = av((patch as Record<string, unknown>)[k] as string);
    });
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: av(pk(projectId)), SK: av(sk(f.created_at, id)) },
      UpdateExpression: `SET ${exprParts.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: vals,
    }));
    return { ...f, ...patch };
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const f = await this.getByIdForProject(id, projectId);
    if (!f) return false;
    await this.client.send(new DeleteItemCommand({
      TableName: table(),
      Key: { PK: av(pk(projectId)), SK: av(sk(f.created_at, id)) },
    }));
    return true;
  }
}
