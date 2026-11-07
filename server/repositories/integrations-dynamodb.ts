/**
 * DynamoDB implementation of IntegrationsRepository.
 *
 * Table: portal-projects  (DYNAMODB_TABLE_PORTAL_PROJECTS, default 'portal-projects')
 * Key design:
 *   PK=MCPINT#<projectId>   SK=INT#<id>
 * Lookup by id only:
 *   PK=MCPINTID#<id>        SK=#LOOKUP
 */

import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import type {
  IntegrationsRepository,
  IntegrationRecord,
  CreateIntegrationInput,
  UpdateIntegrationFields,
} from './integrations.ts';

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_PROJECTS ?? 'portal-projects';
}

function pk(projectId: string) { return av(`MCPINT#${projectId}`); }
function sk(id: string) { return av(`INT#${id}`); }

function itemToRecord(item: Record<string, AttributeValue>): IntegrationRecord {
  return {
    id: getString(item, 'id') ?? '',
    project_id: getString(item, 'project_id'),
    name: getString(item, 'name') ?? '',
    type: getString(item, 'type') ?? '',
    config_enc: getString(item, 'config_enc'),
    enabled: getNumber(item, 'enabled'),
    created_by: getString(item, 'created_by'),
    created_at: getString(item, 'created_at') ?? '',
  };
}

export async function ensureIntegrationsTableExists(client: DynamoDBClient): Promise<void> {
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

export class DynamoDbIntegrationsRepository implements IntegrationsRepository {
  private readonly client: DynamoDBClient;
  constructor() { this.client = getDynamoDbClient(); }

  async ensureTables(): Promise<void> {
    await ensureIntegrationsTableExists(this.client);
  }

  async getById(id: string): Promise<IntegrationRecord | null> {
    const lookup = await this.client.send(new GetItemCommand({
      TableName: table(),
      Key: { PK: av(`MCPINTID#${id}`), SK: av('#LOOKUP') },
    }));
    if (!lookup.Item) return null;
    const projectId = getString(lookup.Item, 'project_id') ?? '';
    return this.getByIdAndProject(id, projectId);
  }

  async getByIdAndProject(id: string, projectId: string): Promise<IntegrationRecord | null> {
    const res = await this.client.send(new GetItemCommand({
      TableName: table(),
      Key: { PK: pk(projectId), SK: sk(id) },
    }));
    return res.Item ? itemToRecord(res.Item) : null;
  }

  async listByProject(projectId: string): Promise<IntegrationRecord[]> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': pk(projectId), ':prefix': av('INT#') },
    }));
    return (res.Items ?? []).map(itemToRecord).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async create(input: CreateIntegrationInput): Promise<IntegrationRecord> {
    const item: Record<string, AttributeValue> = {
      PK: pk(input.project_id),
      SK: sk(input.id),
      ...marshalItem({
        id: input.id,
        project_id: input.project_id,
        name: input.name,
        type: input.type,
        config_enc: input.config_enc,
        enabled: input.enabled,
        created_by: input.created_by,
        created_at: input.created_at,
      }),
    };
    await Promise.all([
      this.client.send(new PutItemCommand({ TableName: table(), Item: item })),
      this.client.send(new PutItemCommand({
        TableName: table(),
        Item: {
          PK: av(`MCPINTID#${input.id}`),
          SK: av('#LOOKUP'),
          ...marshalItem({ project_id: input.project_id, id: input.id }),
        },
      })),
    ]);
    return itemToRecord(item);
  }

  async update(
    id: string,
    projectId: string,
    fields: UpdateIntegrationFields,
  ): Promise<IntegrationRecord | null> {
    const expr: string[] = [];
    const vals: Record<string, AttributeValue> = {};
    const names: Record<string, string> = {};
    if (fields.name !== undefined) { expr.push('#nm = :nm'); names['#nm'] = 'name'; vals[':nm'] = av(fields.name); }
    if (fields.enabled !== undefined) { expr.push('enabled = :en'); vals[':en'] = { N: String(fields.enabled) }; }
    if (fields.config_enc !== undefined) { expr.push('config_enc = :ce'); vals[':ce'] = av(fields.config_enc); }
    if (expr.length === 0) return this.getByIdAndProject(id, projectId);
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: pk(projectId), SK: sk(id) },
      UpdateExpression: `SET ${expr.join(', ')}`,
      ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
      ExpressionAttributeValues: vals,
    }));
    return this.getByIdAndProject(id, projectId);
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const existing = await this.getByIdAndProject(id, projectId);
    if (!existing) return false;
    await Promise.all([
      this.client.send(new DeleteItemCommand({
        TableName: table(),
        Key: { PK: pk(projectId), SK: sk(id) },
      })),
      this.client.send(new DeleteItemCommand({
        TableName: table(),
        Key: { PK: av(`MCPINTID#${id}`), SK: av('#LOOKUP') },
      })),
    ]);
    return true;
  }
}
