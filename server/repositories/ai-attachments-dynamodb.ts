/**
 * DynamoDB implementation of AiAttachmentRepository.
 *
 * Table: portal-create (DYNAMODB_TABLE_PORTAL_CREATE, default 'portal-create')
 *
 * Key design:
 *   PK=ATT#<id>  SK=#META
 * GSI-AttByProject:
 *   PK=attProjectId (<projectId>)  SK=<createdAt>#<id>
 * GSI-AttByParent (sparse):
 *   PK=attParentKey (<parentKind>#<parentId>)  SK=<createdAt>#<id>
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
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, type JsVal } from './dynamo-client.ts';
import type {
  AiAttachmentRepository,
  AiAttachmentRecord,
  CreateAiAttachmentInput,
  AttachmentParentKind,
} from './ai-attachments.ts';

// ── Table bootstrap ───────────────────────────────────────────────────────────

export async function ensureAiAttachmentTableExists(
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
        { AttributeName: 'attProjectId', AttributeType: 'S' },
        { AttributeName: 'attParentKey', AttributeType: 'S' },
        { AttributeName: 'listSK',       AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-AttByProject',
          KeySchema: [
            { AttributeName: 'attProjectId', KeyType: 'HASH' },
            { AttributeName: 'listSK',        KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI-AttByParent',
          KeySchema: [
            { AttributeName: 'attParentKey', KeyType: 'HASH' },
            { AttributeName: 'listSK',        KeyType: 'RANGE' },
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

// ── Item converter ─────────────────────────────────────────────────────────────

import type { AttributeValue } from '@aws-sdk/client-dynamodb';

function itemToRecord(item: Record<string, AttributeValue>): AiAttachmentRecord {
  return {
    id:            getString(item, 'id') ?? '',
    project_id:    getString(item, 'project_id') ?? '',
    filename:      getString(item, 'filename') ?? '',
    original_name: getString(item, 'original_name') ?? '',
    mime_type:     getString(item, 'mime_type') ?? '',
    size:          getNumber(item, 'size'),
    kind:          (getString(item, 'kind') ?? 'document') as AiAttachmentRecord['kind'],
    file_path:     getString(item, 'file_path') ?? '',
    parent_kind:   getString(item, 'parent_kind') as AttachmentParentKind | null,
    parent_id:     getString(item, 'parent_id'),
    uploaded_by:   getString(item, 'uploaded_by'),
    created_at:    getString(item, 'created_at') ?? '',
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbAiAttachmentRepository implements AiAttachmentRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string }) {
    this.client    = opts?.client    ?? getDynamoDbClient();
    this.tableName = opts?.tableName ?? process.env.DYNAMODB_TABLE_PORTAL_CREATE ?? 'portal-create';
  }

  getClient(): DynamoDBClient { return this.client; }
  getTableName(): string { return this.tableName; }

  private pk(id: string): string { return `ATT#${id}`; }
  private listSK(createdAt: string, id: string): string { return `${createdAt}#${id}`; }

  async create(input: CreateAiAttachmentInput): Promise<AiAttachmentRecord> {
    const item: Record<string, JsVal> = {
      PK:           this.pk(input.id),
      SK:           '#META',
      id:           input.id,
      project_id:   input.project_id,
      filename:     input.filename,
      original_name: input.original_name,
      mime_type:    input.mime_type,
      size:         input.size,
      kind:         input.kind,
      file_path:    input.file_path,
      parent_kind:  input.parent_kind,
      parent_id:    input.parent_id,
      uploaded_by:  input.uploaded_by,
      created_at:   input.created_at,
      // GSI attrs
      attProjectId: input.project_id,
      listSK:       this.listSK(input.created_at, input.id),
    };
    if (input.parent_kind && input.parent_id) {
      item.attParentKey = `${input.parent_kind}#${input.parent_id}`;
    }
    await this.client.send(new PutItemCommand({
      TableName: this.tableName,
      Item: marshalItem(item),
    }));
    return input as AiAttachmentRecord;
  }

  async getById(id: string): Promise<AiAttachmentRecord | null> {
    const resp = await this.client.send(new GetItemCommand({
      TableName: this.tableName,
      Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
    }));
    return resp.Item ? itemToRecord(resp.Item) : null;
  }

  async getByIdForProject(id: string, projectId: string): Promise<AiAttachmentRecord | null> {
    const rec = await this.getById(id);
    if (!rec || rec.project_id !== projectId) return null;
    return rec;
  }

  async getByIds(ids: string[]): Promise<AiAttachmentRecord[]> {
    const results: AiAttachmentRecord[] = [];
    for (const id of ids) {
      const rec = await this.getById(id);
      if (rec) results.push(rec);
    }
    return results;
  }

  async listByProject(projectId: string): Promise<AiAttachmentRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName:              this.tableName,
      IndexName:              'GSI-AttByProject',
      KeyConditionExpression: 'attProjectId = :pid',
      ExpressionAttributeValues: marshalItem({ ':pid': projectId }),
      ScanIndexForward:       false,
    }));
    return (resp.Items ?? []).map(itemToRecord);
  }

  async listByParent(parentKind: AttachmentParentKind, parentId: string): Promise<AiAttachmentRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName:              this.tableName,
      IndexName:              'GSI-AttByParent',
      KeyConditionExpression: 'attParentKey = :pk',
      ExpressionAttributeValues: marshalItem({ ':pk': `${parentKind}#${parentId}` }),
    }));
    return (resp.Items ?? []).map(itemToRecord);
  }

  async listOrphanedBefore(cutoff: string): Promise<AiAttachmentRecord[]> {
    // No efficient DynamoDB way without a scan; return empty and rely on TTL.
    // Backlog: add a GSI-OrphanedAtts or use TTL for cleanup.
    return [];
  }

  async linkToParent(ids: string[], parentKind: AttachmentParentKind, parentId: string): Promise<void> {
    for (const id of ids) {
      await this.client.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
        UpdateExpression: 'SET parent_kind = :pk, parent_id = :pi, attParentKey = :apk',
        ExpressionAttributeValues: marshalItem({
          ':pk':  parentKind,
          ':pi':  parentId,
          ':apk': `${parentKind}#${parentId}`,
        }),
      }));
    }
  }

  async deleteByParent(parentKind: AttachmentParentKind, parentId: string): Promise<void> {
    const items = await this.listByParent(parentKind, parentId);
    for (const item of items) {
      await this.client.send(new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshalItem({ PK: this.pk(item.id), SK: '#META' }),
      }));
    }
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.client.send(new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
      }));
    }
  }

  async deleteOrphanedBefore(_cutoff: string): Promise<void> {
    // Backlog: DynamoDB orphan cleanup relies on TTL; not implemented here.
  }
}
