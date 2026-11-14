/**
 * DynamoDB implementation of AwsAccountsRepository.
 *
 * Table: portal-projects  (DYNAMODB_TABLE_PORTAL_PROJECTS, default 'portal-projects')
 * Key design:
 *   PK=AWSACCT#<projectId>   SK=ACCT#<id>
 */

import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, av } from './dynamo-client.ts';
import type {
  AwsAccountsRepository,
  AwsAccountRecord,
  CreateAwsAccountInput,
  UpdateAwsAccountFields,
} from './aws-accounts.ts';

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_PROJECTS ?? 'portal-projects';
}

function pk(projectId: string) { return av(`AWSACCT#${projectId}`); }
function sk(id: string) { return av(`ACCT#${id}`); }

function itemToRecord(item: Record<string, AttributeValue>): AwsAccountRecord {
  return {
    id: getString(item, 'id') ?? '',
    project_id: getString(item, 'project_id'),
    name: getString(item, 'name') ?? '',
    auth_method: getString(item, 'auth_method') ?? '',
    region: getString(item, 'region'),
    credentials_enc: getString(item, 'credentials_enc'),
    profile_name: getString(item, 'profile_name'),
    created_by: getString(item, 'created_by'),
    created_at: getString(item, 'created_at') ?? '',
  };
}

export async function ensureAwsAccountsTableExists(client: DynamoDBClient): Promise<void> {
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

export class DynamoDbAwsAccountsRepository implements AwsAccountsRepository {
  private readonly client: DynamoDBClient;
  constructor() { this.client = getDynamoDbClient(); }

  async ensureTables(): Promise<void> {
    await ensureAwsAccountsTableExists(this.client);
  }

  async getById(id: string): Promise<AwsAccountRecord | null> {
    // Without projectId we must query; use a sparse ID index approach: scan-less
    // For now we accept that getById is not used on the hot path for aws-accounts.
    // The only call that uses just id (without projectId) is the /test route which
    // immediately gets the account with getByIdAndProject. So this is sufficient.
    // Fallback: scan via a filter (acceptable since it's admin-only, not on hot path).
    // Per spec: no table scans. Log to bug backlog.
    // Simple approach: store a lookup pointer like credentials
    const lookupRes = await this.client.send(new GetItemCommand({
      TableName: table(),
      Key: { PK: av(`AWSACCTID#${id}`), SK: av('#LOOKUP') },
    }));
    if (!lookupRes.Item) return null;
    const projectId = getString(lookupRes.Item, 'project_id') ?? '';
    return this.getByIdAndProject(id, projectId);
  }

  async getByIdAndProject(id: string, projectId: string): Promise<AwsAccountRecord | null> {
    const res = await this.client.send(new GetItemCommand({
      TableName: table(),
      Key: { PK: pk(projectId), SK: sk(id) },
    }));
    return res.Item ? itemToRecord(res.Item) : null;
  }

  async listByProject(projectId: string): Promise<AwsAccountRecord[]> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': pk(projectId), ':prefix': av('ACCT#') },
    }));
    return (res.Items ?? []).map(itemToRecord).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async create(input: CreateAwsAccountInput): Promise<AwsAccountRecord> {
    const item: Record<string, AttributeValue> = {
      PK: pk(input.project_id),
      SK: sk(input.id),
      ...marshalItem({
        id: input.id,
        project_id: input.project_id,
        name: input.name,
        auth_method: input.auth_method,
        region: input.region,
        credentials_enc: input.credentials_enc,
        profile_name: input.profile_name,
        created_by: input.created_by,
        created_at: input.created_at,
      }),
    };
    await Promise.all([
      this.client.send(new PutItemCommand({ TableName: table(), Item: item })),
      this.client.send(new PutItemCommand({
        TableName: table(),
        Item: {
          PK: av(`AWSACCTID#${input.id}`),
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
    fields: UpdateAwsAccountFields,
  ): Promise<AwsAccountRecord | null> {
    const keys = Object.keys(fields) as Array<keyof UpdateAwsAccountFields>;
    if (keys.length === 0) return this.getByIdAndProject(id, projectId);
    const expr: string[] = [];
    const vals: Record<string, AttributeValue> = {};
    const names: Record<string, string> = {};
    for (const k of keys) {
      const v = fields[k] ?? null;
      if (k === 'name') { expr.push('#nm = :nm'); names['#nm'] = 'name'; vals[':nm'] = av(v as string); }
      else if (k === 'region') { expr.push('#rg = :rg'); names['#rg'] = 'region'; vals[':rg'] = av(v); }
      else if (k === 'profile_name') { expr.push('profile_name = :pn'); vals[':pn'] = av(v); }
      else if (k === 'credentials_enc') { expr.push('credentials_enc = :ce'); vals[':ce'] = av(v); }
    }
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
        Key: { PK: av(`AWSACCTID#${id}`), SK: av('#LOOKUP') },
      })),
    ]);
    return true;
  }
}
