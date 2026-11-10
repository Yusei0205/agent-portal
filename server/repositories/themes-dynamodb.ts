/**
 * DynamoDB implementation of ThemesRepository.
 *
 * Table: portal-config  (DYNAMODB_TABLE_PORTAL_CONFIG, default 'portal-config')
 * Key design:
 *   PK=THEMES   SK=THEME#<id>
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
  ThemesRepository,
  ThemeRecord,
  CreateThemeInput,
  UpdateThemeFields,
} from './themes.ts';

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_CONFIG ?? 'portal-config';
}

function itemToRecord(item: Record<string, AttributeValue>): ThemeRecord {
  return {
    id: getString(item, 'id') ?? '',
    name: getString(item, 'name') ?? '',
    template_json: getString(item, 'template_json') ?? '{}',
    builtin_override: getNumber(item, 'builtin_override'),
    created_by: getString(item, 'created_by'),
    updated_by: getString(item, 'updated_by'),
    created_at: getString(item, 'created_at') ?? '',
    updated_at: getString(item, 'updated_at') ?? '',
  };
}

export async function ensureThemesTableExists(client: DynamoDBClient): Promise<void> {
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

export class DynamoDbThemesRepository implements ThemesRepository {
  private readonly client: DynamoDBClient;
  constructor() { this.client = getDynamoDbClient(); }

  async ensureTables(): Promise<void> {
    await ensureThemesTableExists(this.client);
  }

  async getById(id: string): Promise<ThemeRecord | null> {
    const res = await this.client.send(new GetItemCommand({
      TableName: table(),
      Key: { PK: av('THEMES'), SK: av(`THEME#${id}`) },
    }));
    return res.Item ? itemToRecord(res.Item) : null;
  }

  async getOverrideById(id: string): Promise<ThemeRecord | null> {
    const rec = await this.getById(id);
    if (!rec || rec.builtin_override !== 1) return null;
    return rec;
  }

  async getCustomById(id: string): Promise<ThemeRecord | null> {
    const rec = await this.getById(id);
    if (!rec || rec.builtin_override !== 0) return null;
    return rec;
  }

  async hasOverride(id: string): Promise<boolean> {
    const rec = await this.getOverrideById(id);
    return rec != null;
  }

  async listCustom(): Promise<ThemeRecord[]> {
    const all = await this.listAll();
    return all.filter((t) => t.builtin_override === 0).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async listAll(): Promise<ThemeRecord[]> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': av('THEMES'), ':prefix': av('THEME#') },
    }));
    return (res.Items ?? []).map(itemToRecord).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async create(input: CreateThemeInput): Promise<ThemeRecord> {
    const item: Record<string, AttributeValue> = {
      PK: av('THEMES'),
      SK: av(`THEME#${input.id}`),
      ...marshalItem({
        id: input.id,
        name: input.name,
        template_json: input.template_json,
        builtin_override: input.builtin_override,
        created_by: input.created_by,
        updated_by: input.updated_by,
        created_at: input.created_at,
        updated_at: input.updated_at,
      }),
    };
    await this.client.send(new PutItemCommand({ TableName: table(), Item: item }));
    return itemToRecord(item);
  }

  async update(id: string, fields: UpdateThemeFields): Promise<ThemeRecord | null> {
    const expr: string[] = [];
    const vals: Record<string, AttributeValue> = {};
    const names: Record<string, string> = {};
    if (fields.name !== undefined) { expr.push('#nm = :nm'); names['#nm'] = 'name'; vals[':nm'] = av(fields.name); }
    if (fields.template_json !== undefined) { expr.push('template_json = :tj'); vals[':tj'] = av(fields.template_json); }
    if (fields.updated_by !== undefined) { expr.push('updated_by = :ub'); vals[':ub'] = av(fields.updated_by); }
    if (fields.updated_at !== undefined) { expr.push('updated_at = :ua'); vals[':ua'] = av(fields.updated_at); }
    if (expr.length === 0) return this.getById(id);
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: av('THEMES'), SK: av(`THEME#${id}`) },
      UpdateExpression: `SET ${expr.join(', ')}`,
      ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
      ExpressionAttributeValues: vals,
    }));
    return this.getById(id);
  }

  async delete(id: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({
      TableName: table(),
      Key: { PK: av('THEMES'), SK: av(`THEME#${id}`) },
    }));
  }
}
