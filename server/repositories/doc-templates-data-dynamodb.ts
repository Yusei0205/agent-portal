/**
 * DynamoDB implementation of DocTemplateRepository.
 *
 * Table: portal-create (DYNAMODB_TABLE_PORTAL_CREATE, default 'portal-create')
 *
 * Key design:
 *   PK=DTPL#<id>  SK=#META
 * GSI-TplByProject (sparse):
 *   PK=tplProjectId  SK=<type>#<createdAt>#<id>
 */

import {
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, type JsVal } from './dynamo-client.ts';
import type {
  DocTemplateRepository,
  DocTemplateRecord,
  CreateDocTemplateInput,
} from './doc-templates-data.ts';

export async function ensureDocTemplateTableExists(
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
    await client.send(new CreateTableCommand({
      TableName: tableName,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK',           AttributeType: 'S' },
        { AttributeName: 'SK',           AttributeType: 'S' },
        { AttributeName: 'tplProjectId', AttributeType: 'S' },
        { AttributeName: 'tplListSK',    AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-TplByProject',
          KeySchema: [
            { AttributeName: 'tplProjectId', KeyType: 'HASH' },
            { AttributeName: 'tplListSK',     KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }));
  } catch (e: unknown) {
    if (!(e instanceof ResourceInUseException)) throw e;
  }
}

function itemToRecord(item: Record<string, AttributeValue>): DocTemplateRecord {
  return {
    id:          getString(item, 'id') ?? '',
    project_id:  getString(item, 'project_id'),
    name:        getString(item, 'name') ?? '',
    type:        getString(item, 'type') ?? '',
    path:        getString(item, 'path') ?? '',
    is_default:  getNumber(item, 'is_default'),
    uploaded_by: getString(item, 'uploaded_by'),
    created_at:  getString(item, 'created_at') ?? '',
  };
}

const PORTAL_PARTITION = 'PORTAL_TEMPLATES';

export class DynamoDbDocTemplateRepository implements DocTemplateRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string }) {
    this.client    = opts?.client    ?? getDynamoDbClient();
    this.tableName = opts?.tableName ?? process.env.DYNAMODB_TABLE_PORTAL_CREATE ?? 'portal-create';
  }

  getClient(): DynamoDBClient { return this.client; }
  getTableName(): string { return this.tableName; }

  private pk(id: string): string { return `DTPL#${id}`; }

  async create(input: CreateDocTemplateInput): Promise<DocTemplateRecord> {
    const projectPartition = input.project_id ?? PORTAL_PARTITION;
    const item: Record<string, JsVal> = {
      PK:           this.pk(input.id),
      SK:           '#META',
      id:           input.id,
      project_id:   input.project_id,
      name:         input.name,
      type:         input.type,
      path:         input.path,
      is_default:   input.is_default,
      uploaded_by:  input.uploaded_by,
      created_at:   input.created_at,
      tplProjectId: projectPartition,
      tplListSK:    `${input.type}#${input.created_at}#${input.id}`,
    };
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: marshalItem(item) }));
    return input;
  }

  async getById(id: string): Promise<DocTemplateRecord | null> {
    const resp = await this.client.send(new GetItemCommand({
      TableName: this.tableName,
      Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
    }));
    return resp.Item ? itemToRecord(resp.Item) : null;
  }

  async listByProject(projectId: string): Promise<DocTemplateRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName:              this.tableName,
      IndexName:              'GSI-TplByProject',
      KeyConditionExpression: 'tplProjectId = :pid',
      ExpressionAttributeValues: marshalItem({ ':pid': projectId }),
    }));
    return (resp.Items ?? []).map(itemToRecord);
  }

  async listPortal(): Promise<DocTemplateRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName:              this.tableName,
      IndexName:              'GSI-TplByProject',
      KeyConditionExpression: 'tplProjectId = :pid',
      ExpressionAttributeValues: marshalItem({ ':pid': PORTAL_PARTITION }),
    }));
    return (resp.Items ?? []).map(itemToRecord);
  }

  async setDefault(id: string, projectId: string | null, type: string): Promise<void> {
    // Get all templates for this scope and type, clear default flag
    const templates = projectId ? await this.listByProject(projectId) : await this.listPortal();
    const sameType = templates.filter((t) => t.type === type && t.id !== id);
    for (const t of sameType) {
      await this.client.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: marshalItem({ PK: this.pk(t.id), SK: '#META' }),
        UpdateExpression: 'SET is_default = :zero',
        ExpressionAttributeValues: marshalItem({ ':zero': 0 }),
      }));
    }
    await this.client.send(new UpdateItemCommand({
      TableName: this.tableName,
      Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
      UpdateExpression: 'SET is_default = :one',
      ExpressionAttributeValues: marshalItem({ ':one': 1 }),
    }));
  }

  async delete(id: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({
      TableName: this.tableName,
      Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
    }));
  }
}
