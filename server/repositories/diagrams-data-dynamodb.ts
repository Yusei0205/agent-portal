/**
 * DynamoDB implementation of DiagramRepository.
 *
 * Table: portal-create (DYNAMODB_TABLE_PORTAL_CREATE, default 'portal-create')
 *
 * Key design:
 *   PK=DIAG#<id>  SK=#META     → canonical diagram item
 *   PK=DIAG#<diagId>  SK=DVER#<version_padded>  → diagram_versions items
 * GSI-DiagByProject:
 *   PK=diagProjectId  SK=<updatedAt>#<id>
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
  DiagramRepository,
  DiagramRecord,
  DiagramVersionRecord,
  CreateDiagramInput,
  CreateDiagramVersionInput,
  DiagramUpdate,
} from './diagrams-data.ts';

// ── Table bootstrap ───────────────────────────────────────────────────────────

export async function ensureDiagramTableExists(
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
        { AttributeName: 'PK',            AttributeType: 'S' },
        { AttributeName: 'SK',            AttributeType: 'S' },
        { AttributeName: 'diagProjectId', AttributeType: 'S' },
        { AttributeName: 'listSK',        AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-DiagByProject',
          KeySchema: [
            { AttributeName: 'diagProjectId', KeyType: 'HASH' },
            { AttributeName: 'listSK',         KeyType: 'RANGE' },
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

// ── Item converters ───────────────────────────────────────────────────────────

function itemToDiagram(item: Record<string, AttributeValue>): DiagramRecord {
  return {
    id:                  getString(item, 'id') ?? '',
    project_id:          getString(item, 'project_id') ?? '',
    kind:                getString(item, 'kind') ?? '',
    title:               getString(item, 'title') ?? '',
    slug:                getString(item, 'slug') ?? '',
    focus:               getString(item, 'focus') ?? '',
    repo_ids:            getString(item, 'repo_ids') ?? '[]',
    status:              getString(item, 'status') ?? '',
    error:               getString(item, 'error'),
    version:             getNumber(item, 'version'),
    source_hash:         getString(item, 'source_hash'),
    stale:               getNumber(item, 'stale'),
    pending_workflow_id: getString(item, 'pending_workflow_id'),
    pending_sources:     getString(item, 'pending_sources') ?? '[]',
    created_by:          getString(item, 'created_by'),
    created_at:          getString(item, 'created_at') ?? '',
    updated_at:          getString(item, 'updated_at') ?? '',
    format:              getString(item, 'format') ?? 'mermaid',
    style:               getString(item, 'style') ?? 'mermaid',
    cloud:               getString(item, 'cloud') ?? '',
    lead_agent:          getString(item, 'lead_agent') ?? '',
    trust_tools:         getNumber(item, 'trust_tools'),
    workflow_id:         getString(item, 'workflow_id'),
    ingested_run_id:     getString(item, 'ingested_run_id'),
    attachment_ids:      getString(item, 'attachment_ids') ?? '[]',
  };
}

function itemToVersion(item: Record<string, AttributeValue>): DiagramVersionRecord {
  return {
    diagram_id:  getString(item, 'diagram_id') ?? '',
    version:     getNumber(item, 'version'),
    mermaid:     getString(item, 'mermaid') ?? '',
    description: getString(item, 'description') ?? '',
    citations:   getString(item, 'citations') ?? '[]',
    sources:     getString(item, 'sources') ?? '[]',
    source_hash: getString(item, 'source_hash'),
    workflow_id: getString(item, 'workflow_id'),
    run_id:      getString(item, 'run_id'),
    created_by:  getString(item, 'created_by'),
    created_at:  getString(item, 'created_at') ?? '',
    format:      getString(item, 'format') ?? 'mermaid',
    style:       getString(item, 'style') ?? 'mermaid',
    cloud:       getString(item, 'cloud') ?? '',
    drawio:      getString(item, 'drawio'),
    stats:       getString(item, 'stats') ?? '{}',
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbDiagramRepository implements DiagramRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string }) {
    this.client    = opts?.client    ?? getDynamoDbClient();
    this.tableName = opts?.tableName ?? process.env.DYNAMODB_TABLE_PORTAL_CREATE ?? 'portal-create';
  }

  getClient(): DynamoDBClient { return this.client; }
  getTableName(): string { return this.tableName; }

  private pk(id: string): string { return `DIAG#${id}`; }
  private verSK(version: number): string { return `DVER#${String(version).padStart(8, '0')}`; }

  async create(input: CreateDiagramInput): Promise<DiagramRecord> {
    const item: Record<string, JsVal> = {
      PK:                  this.pk(input.id),
      SK:                  '#META',
      id:                  input.id,
      project_id:          input.project_id,
      kind:                input.kind,
      title:               input.title,
      slug:                input.slug,
      focus:               input.focus,
      repo_ids:            input.repo_ids,
      status:              input.status,
      error:               input.error,
      version:             0,
      source_hash:         null,
      stale:               0,
      pending_workflow_id: null,
      pending_sources:     '[]',
      created_by:          input.created_by,
      created_at:          input.created_at,
      updated_at:          input.updated_at,
      format:              input.format,
      style:               input.style,
      cloud:               input.cloud,
      lead_agent:          input.lead_agent,
      trust_tools:         input.trust_tools,
      workflow_id:         null,
      ingested_run_id:     null,
      attachment_ids:      input.attachment_ids,
      diagProjectId:       input.project_id,
      listSK:              `${input.updated_at}#${input.id}`,
    };
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: marshalItem(item) }));
    return { ...input, version: 0, source_hash: null, stale: 0, pending_workflow_id: null, pending_sources: '[]', workflow_id: null, ingested_run_id: null } as DiagramRecord;
  }

  async getById(id: string): Promise<DiagramRecord | null> {
    const resp = await this.client.send(new GetItemCommand({
      TableName: this.tableName,
      Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
    }));
    return resp.Item ? itemToDiagram(resp.Item) : null;
  }

  async getByProjectAndId(projectId: string, id: string): Promise<DiagramRecord | null> {
    const rec = await this.getById(id);
    return rec?.project_id === projectId ? rec : null;
  }

  async getBySlug(projectId: string, slug: string): Promise<DiagramRecord | null> {
    // Backlog: add GSI-DiagBySlug. For now, list all and filter.
    const items = await this.listByProject(projectId);
    return items.find((d) => d.slug === slug) ?? null;
  }

  async slugExists(projectId: string, slug: string): Promise<boolean> {
    return !!(await this.getBySlug(projectId, slug));
  }

  async listByProject(projectId: string): Promise<DiagramRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName:              this.tableName,
      IndexName:              'GSI-DiagByProject',
      KeyConditionExpression: 'diagProjectId = :pid',
      ExpressionAttributeValues: marshalItem({ ':pid': projectId }),
      ScanIndexForward:       false,
    }));
    return (resp.Items ?? []).filter((item) => (item.SK?.S ?? '') === '#META').map(itemToDiagram);
  }

  async update(id: string, fields: DiagramUpdate): Promise<void> {
    const sets: string[] = [];
    const vals: Record<string, JsVal> = {};
    const exprNames: Record<string, string> = {};
    const add = (attr: string, val: JsVal) => {
      const key = attr.replace(/[^a-zA-Z0-9_]/g, '_');
      exprNames[`#${key}`] = attr;
      vals[`:${key}`] = val;
      sets.push(`#${key} = :${key}`);
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) add(k, v as JsVal);
    }
    if (sets.length === 0) return;
    await this.client.send(new UpdateItemCommand({
      TableName:                 this.tableName,
      Key:                       marshalItem({ PK: this.pk(id), SK: '#META' }),
      UpdateExpression:          `SET ${sets.join(', ')}`,
      ExpressionAttributeNames:  exprNames,
      ExpressionAttributeValues: marshalItem(vals),
    }));
  }

  async delete(id: string): Promise<void> {
    const versions = await this.listVersions(id);
    for (const v of versions) {
      await this.client.send(new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshalItem({ PK: this.pk(id), SK: this.verSK(v.version) }),
      }));
    }
    await this.client.send(new DeleteItemCommand({
      TableName: this.tableName,
      Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
    }));
  }

  async createVersion(input: CreateDiagramVersionInput): Promise<DiagramVersionRecord> {
    const item: Record<string, JsVal> = {
      PK:          this.pk(input.diagram_id),
      SK:          this.verSK(input.version),
      diagram_id:  input.diagram_id,
      version:     input.version,
      mermaid:     input.mermaid,
      description: input.description,
      citations:   input.citations,
      sources:     input.sources,
      source_hash: input.source_hash,
      workflow_id: input.workflow_id,
      run_id:      input.run_id,
      created_by:  input.created_by,
      created_at:  input.created_at,
      format:      input.format,
      style:       input.style,
      cloud:       input.cloud,
      drawio:      input.drawio,
      stats:       input.stats,
    };
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: marshalItem(item) }));
    return input;
  }

  async getLatestVersion(diagramId: string): Promise<DiagramVersionRecord | null> {
    const versions = await this.listVersions(diagramId);
    return versions.length > 0 ? versions[0] : null;
  }

  async listVersions(diagramId: string): Promise<DiagramVersionRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName:              this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: marshalItem({ ':pk': this.pk(diagramId), ':prefix': 'DVER#' }),
      ScanIndexForward:       false,
    }));
    return (resp.Items ?? []).map(itemToVersion);
  }

  async getVersionByNumber(diagramId: string, version: number): Promise<DiagramVersionRecord | null> {
    const resp = await this.client.send(new GetItemCommand({
      TableName: this.tableName,
      Key: marshalItem({ PK: this.pk(diagramId), SK: this.verSK(version) }),
    }));
    return resp.Item ? itemToVersion(resp.Item) : null;
  }
}
