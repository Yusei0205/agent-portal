/**
 * DynamoDB implementation of OutputFilesRepository.
 *
 * Table: portal-content
 *
 * Key design:
 *   PK=WFOUT#<workflowId>  SK=OUTFILE#<isoCreatedAt>#<fileId>
 *   GSI-ContentEntityId: PK=id, SK=entityType  →  getById
 *
 * Latest-version-per-path deduplication is done in-app (not a scan):
 *   listLatestByWorkflow fetches all output files for a workflow partition and
 *   applies max-version-per-path grouping in application code.
 *
 * Null handling: nullable attributes (refused_reason, hash, vault_file_id, mime_type,
 * size_bytes) are NOT stored when null. This allows attribute_not_exists(refused_reason)
 * to correctly identify non-refused files.
 */

import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, getString, getNumber, av } from './dynamo-client.ts';
import type {
  OutputFilesRepository,
  OutputFileRecord,
  CreateOutputFileInput,
} from './output-files.ts';

// ── Table name ────────────────────────────────────────────────────────────────

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_CONTENT ?? 'portal-content-test';
}

// ── Row converter ─────────────────────────────────────────────────────────────

function itemToRecord(item: Record<string, AttributeValue>): OutputFileRecord {
  return {
    id: getString(item, 'id') ?? '',
    workflow_id: getString(item, 'workflow_id') ?? '',
    run_id: getString(item, 'run_id') ?? '',
    name: getString(item, 'name') ?? '',
    path: getString(item, 'path') ?? '',
    size_bytes: item['size_bytes']?.N != null ? Number(item['size_bytes'].N) : null,
    mime_type: getString(item, 'mime_type'),
    version: getNumber(item, 'version') || 1,
    refused_reason: getString(item, 'refused_reason'),
    hash: getString(item, 'hash'),
    vault_file_id: getString(item, 'vault_file_id'),
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

export class DynamoDbOutputFilesRepository implements OutputFilesRepository {
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

  async create(input: CreateOutputFileInput): Promise<OutputFileRecord> {
    const sk = `OUTFILE#${input.created_at}#${input.id}`;
    const item: Record<string, AttributeValue> = {
      PK: av(`WFOUT#${input.workflow_id}`),
      SK: av(sk),
      id: av(input.id),
      entityType: av('outfile'),
      workflow_id: av(input.workflow_id),
      run_id: av(input.run_id),
      name: av(input.name),
      path: av(input.path),
      version: { N: String(input.version) },
      created_at: av(input.created_at),
    };
    // Only include optional attributes when non-null (allows attribute_not_exists filters)
    if (input.size_bytes != null) item['size_bytes'] = { N: String(input.size_bytes) };
    if (input.mime_type != null) item['mime_type'] = av(input.mime_type);
    if (input.refused_reason != null) item['refused_reason'] = av(input.refused_reason);
    if (input.hash != null) item['hash'] = av(input.hash);

    await this.client.send(new PutItemCommand({ TableName: table(), Item: item }));
    return itemToRecord(item);
  }

  async getById(id: string, workflowId: string): Promise<OutputFileRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(),
      IndexName: 'GSI-ContentEntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('outfile') },
      Limit: 1,
    }));
    const item = res.Items?.[0];
    if (!item) return null;
    const rec = itemToRecord(item);
    if (rec.workflow_id !== workflowId) return null;
    return rec;
  }

  async getLatestByPath(workflowId: string, filePath: string): Promise<OutputFileRecord | null> {
    const items = await paginateAll(this.client, {
      TableName: table(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': av(`WFOUT#${workflowId}`) },
    });
    let latest: OutputFileRecord | null = null;
    for (const item of items) {
      if (getString(item, 'path') !== filePath) continue;
      if (item['refused_reason'] != null) continue;
      const rec = itemToRecord(item);
      if (!latest || rec.version > latest.version) latest = rec;
    }
    return latest;
  }

  async listLatestByWorkflow(workflowId: string): Promise<OutputFileRecord[]> {
    const items = await paginateAll(this.client, {
      TableName: table(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': av(`WFOUT#${workflowId}`) },
    });
    const all = items
      .filter((item) => item['refused_reason'] == null)
      .map(itemToRecord);

    // Dedup: keep latest version per path
    const latestByPath = new Map<string, OutputFileRecord>();
    for (const rec of all) {
      const existing = latestByPath.get(rec.path);
      if (!existing || rec.version > existing.version) {
        latestByPath.set(rec.path, rec);
      }
    }
    return [...latestByPath.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async updateVaultFileId(id: string, vaultFileId: string): Promise<void> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(),
      IndexName: 'GSI-ContentEntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('outfile') },
      Limit: 1,
    }));
    const item = res.Items?.[0];
    if (!item) return;
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: item['PK'], SK: item['SK'] },
      UpdateExpression: 'SET vault_file_id = :v',
      ExpressionAttributeValues: { ':v': av(vaultFileId) },
    }));
  }

  async countByWorkflow(workflowId: string): Promise<number> {
    const items = await paginateAll(this.client, {
      TableName: table(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': av(`WFOUT#${workflowId}`) },
      Select: 'ALL_ATTRIBUTES',
    });
    return items.filter((item) => item['refused_reason'] == null).length;
  }
}
