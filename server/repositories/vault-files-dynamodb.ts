/**
 * DynamoDB implementation of VaultFilesRepository.
 *
 * Table: portal-content
 *
 * Key design:
 *   Project scope:  PK=VAULTPROJ#<projectId>          SK=VFILE#<isoCreatedAt>#<fileId>
 *   Personal scope: PK=VAULTPERS#<projectId>#<userId>  SK=VFILE#<isoCreatedAt>#<fileId>
 *   Portal scope:   PK=VAULTPORTAL                     SK=VFILE#<isoCreatedAt>#<fileId>
 *   GSI-ContentEntityId: PK=id, SK=entityType         →  getById
 *
 * Combined listings (project + personal + portal) run 3 parallel Queries and merge in-app.
 * No Scan needed.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  BatchWriteItemCommand,
  BatchGetItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import type {
  VaultFilesRepository,
  VaultFileRecord,
  CreateVaultFileInput,
} from './vault-files.ts';

// ── Table name ────────────────────────────────────────────────────────────────

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_CONTENT ?? 'portal-content-test';
}

// ── Key builders ──────────────────────────────────────────────────────────────

function vaultPk(record: { project_id: string | null; user_id: string | null }): string {
  if (record.project_id == null) return 'VAULTPORTAL';
  if (record.user_id != null) return `VAULTPERS#${record.project_id}#${record.user_id}`;
  return `VAULTPROJ#${record.project_id}`;
}

function vaultSk(createdAt: string, id: string): string {
  return `VFILE#${createdAt}#${id}`;
}

// ── Row converter ─────────────────────────────────────────────────────────────

function itemToRecord(item: Record<string, AttributeValue>): VaultFileRecord {
  return {
    id: getString(item, 'id') ?? '',
    project_id: getString(item, 'project_id'),
    user_id: getString(item, 'user_id'),
    name: getString(item, 'name') ?? '',
    path: getString(item, 'path') ?? '',
    size_bytes: getNumber(item, 'size_bytes') || null,
    mime_type: getString(item, 'mime_type'),
    uploaded_by: getString(item, 'uploaded_by'),
    folder: getString(item, 'folder'),
    source_workflow_id: getString(item, 'source_workflow_id'),
    created_at: getString(item, 'created_at') ?? '',
  };
}

// ── Pagination helper ─────────────────────────────────────────────────────────

async function paginateAll(
  client: DynamoDBClient,
  params: ConstructorParameters<typeof QueryCommand>[0],
): Promise<Array<Record<string, AttributeValue>>> {
  const items: Array<Record<string, AttributeValue>> = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await client.send(new QueryCommand({ ...params, ExclusiveStartKey: lastKey }));
    if (res.Items) items.push(...res.Items);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class DynamoDbVaultFilesRepository implements VaultFilesRepository {
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
          { AttributeName: 'id', AttributeType: 'S' },
          { AttributeName: 'entityType', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI-ContentEntityId',
            KeySchema: [
              { AttributeName: 'id', KeyType: 'HASH' },
              { AttributeName: 'entityType', KeyType: 'RANGE' },
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

  async create(input: CreateVaultFileInput): Promise<VaultFileRecord> {
    const pk = vaultPk(input);
    const sk = vaultSk(input.created_at, input.id);
    const item: Record<string, AttributeValue> = {
      PK: av(pk),
      SK: av(sk),
      id: av(input.id),
      entityType: av('vaultfile'),
      name: av(input.name),
      path: av(input.path),
      size_bytes: { N: String(input.size_bytes) },
      mime_type: av(input.mime_type),
      uploaded_by: av(input.uploaded_by),
      created_at: av(input.created_at),
      ...marshalItem({
        project_id: input.project_id,
        user_id: input.user_id,
        folder: input.folder,
        source_workflow_id: input.source_workflow_id,
      }),
    };
    await this.client.send(new PutItemCommand({
      TableName: table(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return itemToRecord(item);
  }

  async getById(id: string): Promise<VaultFileRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(),
      IndexName: 'GSI-ContentEntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('vaultfile') },
      Limit: 1,
    }));
    const item = res.Items?.[0];
    return item ? itemToRecord(item) : null;
  }

  async getByIdForProject(id: string, projectId: string): Promise<VaultFileRecord | null> {
    const f = await this.getById(id);
    if (!f) return null;
    if (f.project_id !== null && f.project_id !== projectId) return null;
    return f;
  }

  async listByProject(
    projectId: string,
    userId: string,
    scope?: 'project' | 'personal' | 'portal' | null,
  ): Promise<VaultFileRecord[]> {
    const tbl = table();
    let allItems: Array<Record<string, AttributeValue>> = [];

    if (!scope || scope === 'project') {
      allItems.push(...await paginateAll(this.client, {
        TableName: tbl,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': av(`VAULTPROJ#${projectId}`) },
      }));
    }
    if (!scope || scope === 'personal') {
      allItems.push(...await paginateAll(this.client, {
        TableName: tbl,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': av(`VAULTPERS#${projectId}#${userId}`) },
      }));
    }
    if (!scope || scope === 'portal') {
      allItems.push(...await paginateAll(this.client, {
        TableName: tbl,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': av('VAULTPORTAL') },
      }));
    }
    if (scope === 'project') {
      return allItems.map(itemToRecord).sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    if (scope === 'personal') {
      return allItems.map(itemToRecord).sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    if (scope === 'portal') {
      return allItems.map(itemToRecord).sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    return allItems.map(itemToRecord).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async listByScope(
    scope: 'project' | 'personal' | 'portal',
    projectId: string,
    userId: string,
    folderFilter?: string | null,
  ): Promise<VaultFileRecord[]> {
    const items = await this.listByProject(projectId, userId, scope);
    if (!folderFilter) return items;
    return items.filter(
      (f) => f.folder === folderFilter || (f.folder != null && f.folder.startsWith(folderFilter + '/')),
    );
  }

  async listPortal(): Promise<VaultFileRecord[]> {
    const items = await paginateAll(this.client, {
      TableName: table(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': av('VAULTPORTAL') },
    });
    return items.map(itemToRecord).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async delete(id: string): Promise<void> {
    const f = await this.getById(id);
    if (!f) return;
    await this.client.send(new DeleteItemCommand({
      TableName: table(),
      Key: { PK: av(vaultPk(f)), SK: av(vaultSk(f.created_at, f.id)) },
    }));
  }

  async updateSizeAndMime(id: string, sizeBytes: number, mimeType: string): Promise<void> {
    const f = await this.getById(id);
    if (!f) return;
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: av(vaultPk(f)), SK: av(vaultSk(f.created_at, f.id)) },
      UpdateExpression: 'SET size_bytes = :s, mime_type = :m',
      ExpressionAttributeValues: { ':s': { N: String(sizeBytes) }, ':m': av(mimeType) },
    }));
  }

  async updateFolder(id: string, folder: string | null): Promise<void> {
    const f = await this.getById(id);
    if (!f) return;
    if (folder == null) {
      await this.client.send(new UpdateItemCommand({
        TableName: table(),
        Key: { PK: av(vaultPk(f)), SK: av(vaultSk(f.created_at, f.id)) },
        UpdateExpression: 'REMOVE folder',
      }));
    } else {
      await this.client.send(new UpdateItemCommand({
        TableName: table(),
        Key: { PK: av(vaultPk(f)), SK: av(vaultSk(f.created_at, f.id)) },
        UpdateExpression: 'SET folder = :f',
        ExpressionAttributeValues: { ':f': av(folder) },
      }));
    }
  }

  async bulkDelete(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.delete(id);
    }
  }

  async bulkUpdateFolder(ids: string[], folder: string | null): Promise<void> {
    for (const id of ids) {
      await this.updateFolder(id, folder);
    }
  }

  async findByWorkflowFolderName(
    projectId: string,
    folder: string,
    name: string,
    workflowId: string,
  ): Promise<VaultFileRecord | null> {
    const items = await paginateAll(this.client, {
      TableName: table(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': av(`VAULTPROJ#${projectId}`),
        ':f': av(folder),
        ':n': av(name),
        ':wf': av(workflowId),
      },
      FilterExpression: 'folder = :f AND #nm = :n AND source_workflow_id = :wf',
      ExpressionAttributeNames: { '#nm': 'name' },
    });
    const match = items.find(
      (item) => getString(item, 'folder') === folder
        && getString(item, 'name') === name
        && getString(item, 'source_workflow_id') === workflowId,
    );
    return match ? itemToRecord(match) : null;
  }

  async validateProjectFiles(fileIds: string[], projectId: string): Promise<string | null> {
    for (const id of fileIds) {
      const f = await this.getById(id);
      if (!f || f.project_id !== projectId || f.user_id !== null) return id;
    }
    return null;
  }

  async getByIds(ids: string[]): Promise<VaultFileRecord[]> {
    const results: VaultFileRecord[] = [];
    for (const id of ids) {
      const f = await this.getById(id);
      if (f) results.push(f);
    }
    return results;
  }
}
