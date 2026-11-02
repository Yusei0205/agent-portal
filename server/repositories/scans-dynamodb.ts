/**
 * DynamoDB implementation of ScansRepository.
 *
 * Table: portal-code
 * Scans:     PK=SCAN#<projectId>   SK=SCAN#<isoCreatedAt>#<id>
 * ScanFiles: PK=SCANFILES#<scanId> SK=FILE#<id>
 * GSI-P10EntityId: PK=id, SK=entityType='scan'
 * GSI-P10WorkflowId: PK=workflowId (sparse)
 */

import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import type { ScansRepository, ScanRecord, ScanFileRecord, CreateScanInput, CreateScanFileInput, ScanStatus } from './scans.ts';

function table(): string { return process.env.DYNAMODB_TABLE_PORTAL_CODE ?? 'portal-code-test'; }

function scanPk(projectId: string | null): string { return `SCAN#${projectId ?? 'null'}`; }
function scanSk(createdAt: string, id: string): string { return `SCAN#${createdAt}#${id}`; }
function filesPk(scanId: string): string { return `SCANFILES#${scanId}`; }
function fileSk(id: string): string { return `FILE#${id}`; }

function itemToScan(item: Record<string, AttributeValue>): ScanRecord {
  return {
    id: getString(item, 'id') ?? '', project_id: getString(item, 'project_id'),
    repo_id: getString(item, 'repo_id'), branch: getString(item, 'branch'),
    pinned_sha: getString(item, 'pinned_sha'),
    include_paths: getString(item, 'include_paths') ?? '[]',
    exclude_paths: getString(item, 'exclude_paths') ?? '[]',
    background_doc_ids: getString(item, 'background_doc_ids') ?? '[]',
    model_role: getString(item, 'model_role'), provider_id: getString(item, 'provider_id'),
    model_id: getString(item, 'model_id'), status: getString(item, 'status') as ScanStatus ?? 'estimating',
    fail_reason: getString(item, 'fail_reason'),
    budget_tokens: item.budget_tokens?.N != null ? Number(item.budget_tokens.N) : null,
    estimated_files: item.estimated_files?.N != null ? Number(item.estimated_files.N) : null,
    estimated_bytes: item.estimated_bytes?.N != null ? Number(item.estimated_bytes.N) : null,
    estimated_tokens: item.estimated_tokens?.N != null ? Number(item.estimated_tokens.N) : null,
    estimated_cost_usd: item.estimated_cost_usd?.N != null ? Number(item.estimated_cost_usd.N) : null,
    estimated_minutes: item.estimated_minutes?.N != null ? Number(item.estimated_minutes.N) : null,
    files_total: getNumber(item, 'files_total'), files_done: getNumber(item, 'files_done'),
    tokens_used: getNumber(item, 'tokens_used'), cost_usd: getNumber(item, 'cost_usd'),
    input_tokens: getNumber(item, 'input_tokens'), output_tokens: getNumber(item, 'output_tokens'),
    summary: getString(item, 'summary'), review_id: getString(item, 'review_id'),
    created_by: getString(item, 'created_by'), created_at: getString(item, 'created_at') ?? '',
    started_at: getString(item, 'started_at'), completed_at: getString(item, 'completed_at'),
    workflow_id: getString(item, 'workflow_id'),
  };
}

function itemToFile(item: Record<string, AttributeValue>): ScanFileRecord {
  return {
    id: getString(item, 'id') ?? '', scan_id: getString(item, 'scan_id') ?? '',
    file_path: getString(item, 'file_path') ?? '', status: getString(item, 'status') ?? 'pending',
    tokens_used: getNumber(item, 'tokens_used'), done_at: getString(item, 'done_at'),
    file_sha: getString(item, 'file_sha'),
    file_size: item['file_size'] ? getNumber(item, 'file_size') : null,
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

function numAttr(v: number | null | undefined): AttributeValue {
  return v != null ? { N: String(v) } : { NULL: true };
}

export class DynamoDbScansRepository implements ScansRepository {
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

  async create(input: CreateScanInput): Promise<ScanRecord> {
    const item: Record<string, AttributeValue> = {
      PK: av(scanPk(input.project_id)), SK: av(scanSk(input.created_at, input.id)),
      id: av(input.id), entityType: av('scan'),
      ...marshalItem({
        project_id: input.project_id, repo_id: input.repo_id, branch: input.branch,
        pinned_sha: input.pinned_sha, include_paths: input.include_paths, exclude_paths: input.exclude_paths,
        background_doc_ids: input.background_doc_ids, model_role: input.model_role,
        provider_id: input.provider_id, model_id: input.model_id, status: input.status,
        fail_reason: input.fail_reason, summary: input.summary, review_id: input.review_id,
        created_by: input.created_by, created_at: input.created_at, started_at: input.started_at,
        completed_at: input.completed_at, workflow_id: input.workflow_id,
      }),
      budget_tokens: numAttr(input.budget_tokens), estimated_files: numAttr(input.estimated_files),
      estimated_bytes: numAttr(input.estimated_bytes), estimated_tokens: numAttr(input.estimated_tokens),
      estimated_cost_usd: numAttr(input.estimated_cost_usd), estimated_minutes: numAttr(input.estimated_minutes),
      files_total: { N: String(input.files_total) }, files_done: { N: String(input.files_done) },
      tokens_used: { N: String(input.tokens_used) }, cost_usd: { N: String(input.cost_usd) },
      input_tokens: { N: String(input.input_tokens) }, output_tokens: { N: String(input.output_tokens) },
    };
    if (input.workflow_id) item.workflowId = av(input.workflow_id);
    await this.client.send(new PutItemCommand({ TableName: table(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    return itemToScan(item);
  }

  async getById(id: string): Promise<ScanRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(), IndexName: 'GSI-P10EntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('scan') }, Limit: 1,
    }));
    const item = res.Items?.[0];
    return item ? itemToScan(item) : null;
  }

  async getByIdForProject(id: string, projectId: string): Promise<ScanRecord | null> {
    const f = await this.getById(id);
    if (!f || f.project_id !== projectId) return null;
    return f;
  }

  async getByWorkflowId(workflowId: string): Promise<ScanRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(), IndexName: 'GSI-P10WorkflowId',
      KeyConditionExpression: 'workflowId = :wf',
      ExpressionAttributeValues: { ':wf': av(workflowId) },
      FilterExpression: 'entityType = :et',
      ExpressionAttributeNames: {},
      Limit: 1,
    }));
    const item = res.Items?.find((i) => getString(i, 'entityType') === 'scan');
    return item ? itemToScan(item) : null;
  }

  async listByProject(
    projectId: string,
    opts: { status?: ScanStatus; limit: number; offset: number },
  ): Promise<{ items: ScanRecord[]; total: number }> {
    let all = await paginateAll(this.client, {
      TableName: table(), KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': av(scanPk(projectId)) },
    });
    if (opts.status) all = all.filter((i) => getString(i, 'status') === opts.status);
    const records = all.map(itemToScan).sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { items: records.slice(opts.offset, opts.offset + opts.limit), total: records.length };
  }

  async update(id: string, patch: Partial<ScanRecord>): Promise<void> {
    const f = await this.getById(id);
    if (!f) return;
    const keys = Object.keys(patch).filter((k) => !['id', 'project_id', 'created_at'].includes(k));
    if (keys.length === 0) return;
    const exprParts = keys.map((_, i) => `#f${i} = :v${i}`);
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};
    keys.forEach((k, i) => {
      names[`#f${i}`] = k === 'status' ? '#status_alias' : k;
      if (k === 'status') names[`#f${i}`] = `#f${i}`;
      const v = (patch as Record<string, unknown>)[k];
      vals[`:v${i}`] = typeof v === 'number' ? { N: String(v) } : av(v as string | null);
    });
    // Fix name aliases
    const exprParts2 = keys.map((k, i) => `${k === 'status' ? '#statusfld' : `#f${i}`} = :v${i}`);
    const names2: Record<string, string> = {};
    const vals2: Record<string, AttributeValue> = {};
    keys.forEach((k, i) => {
      const alias = k === 'status' ? '#statusfld' : `#k${i}`;
      names2[alias] = k;
      const v = (patch as Record<string, unknown>)[k];
      vals2[`:v${i}`] = typeof v === 'number' ? { N: String(v) } : av(v as string | null);
    });
    const expr = keys.map((k, i) => `${k === 'status' ? '#statusfld' : `#k${i}`} = :v${i}`);
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: av(scanPk(f.project_id)), SK: av(scanSk(f.created_at, id)) },
      UpdateExpression: `SET ${expr.join(', ')}`,
      ExpressionAttributeNames: names2, ExpressionAttributeValues: vals2,
    }));
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const f = await this.getByIdForProject(id, projectId);
    if (!f) return false;
    await this.client.send(new DeleteItemCommand({ TableName: table(), Key: { PK: av(scanPk(projectId)), SK: av(scanSk(f.created_at, id)) } }));
    return true;
  }

  async createFile(input: CreateScanFileInput): Promise<ScanFileRecord> {
    const item: Record<string, AttributeValue> = {
      PK: av(filesPk(input.scan_id)), SK: av(fileSk(input.id)),
      id: av(input.id), entityType: av('scanfile'),
      ...marshalItem({ scan_id: input.scan_id, file_path: input.file_path, status: input.status, done_at: input.done_at, file_sha: input.file_sha ?? null }),
      tokens_used: { N: String(input.tokens_used) },
      ...(input.file_size != null ? { file_size: { N: String(input.file_size) } } : {}),
    };
    await this.client.send(new PutItemCommand({ TableName: table(), Item: item }));
    return itemToFile(item);
  }

  async listFiles(scanId: string): Promise<ScanFileRecord[]> {
    const items = await paginateAll(this.client, { TableName: table(), KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': av(filesPk(scanId)) } });
    return items.map(itemToFile);
  }

  async updateFile(id: string, patch: Partial<ScanFileRecord>): Promise<void> {
    // For simplicity: fetch by ID, then rewrite key. In practice scan_id is known by callers.
    // We need to find the item first.
    const res = await this.client.send(new QueryCommand({
      TableName: table(), IndexName: 'GSI-P10EntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('scanfile') }, Limit: 1,
    }));
    const item = res.Items?.[0];
    if (!item) return;
    const scanId = getString(item, 'scan_id') ?? '';
    const keys = Object.keys(patch).filter((k) => !['id', 'scan_id'].includes(k));
    if (keys.length === 0) return;
    const expr = keys.map((k, i) => `#k${i} = :v${i}`);
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};
    keys.forEach((k, i) => {
      names[`#k${i}`] = k;
      const v = (patch as Record<string, unknown>)[k];
      vals[`:v${i}`] = typeof v === 'number' ? { N: String(v) } : av(v as string | null);
    });
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: av(filesPk(scanId)), SK: av(fileSk(id)) },
      UpdateExpression: `SET ${expr.join(', ')}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: vals,
    }));
  }
}
