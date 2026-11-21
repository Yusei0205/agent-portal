/**
 * DynamoDB implementation of PresentationRepository.
 *
 * Table: portal-create (DYNAMODB_TABLE_PORTAL_CREATE, default 'portal-create')
 *
 * Key design:
 *   PK=PRES#<id>  SK=#META
 * GSI-PresByProject:
 *   PK=presProjectId  SK=<createdAt>#<id>
 * GSI-PresByWorkflow (sparse):
 *   PK=presWorkflowId  SK=#META
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
  PresentationRepository,
  PresentationRecord,
  CreatePresentationInput,
  PresentationUpdate,
} from './presentations-data.ts';

// ── Table bootstrap ───────────────────────────────────────────────────────────

export async function ensurePresentationTableExists(
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
        { AttributeName: 'PK',             AttributeType: 'S' },
        { AttributeName: 'SK',             AttributeType: 'S' },
        { AttributeName: 'presProjectId',  AttributeType: 'S' },
        { AttributeName: 'presWorkflowId', AttributeType: 'S' },
        { AttributeName: 'listSK',         AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-PresByProject',
          KeySchema: [
            { AttributeName: 'presProjectId', KeyType: 'HASH' },
            { AttributeName: 'listSK',         KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI-PresByWorkflow',
          KeySchema: [
            { AttributeName: 'presWorkflowId', KeyType: 'HASH' },
            { AttributeName: 'SK',              KeyType: 'RANGE' },
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

function itemToRecord(item: Record<string, AttributeValue>): PresentationRecord {
  return {
    id:             getString(item, 'id') ?? '',
    project_id:     getString(item, 'project_id') ?? '',
    name:           getString(item, 'name') ?? '',
    topic:          getString(item, 'topic'),
    source_kind:    getString(item, 'source_kind') ?? '',
    source_ref:     getString(item, 'source_ref'),
    audience:       getString(item, 'audience'),
    slide_count:    getNumber(item, 'slide_count'),
    diagram_style:  getString(item, 'diagram_style') ?? 'mermaid',
    diagram_cloud:  getString(item, 'diagram_cloud'),
    lead_agent:     getString(item, 'lead_agent'),
    trust_all_tools: getNumber(item, 'trust_all_tools'),
    pptx_path:      getString(item, 'pptx_path'),
    preview_json:   getString(item, 'preview_json'),
    workflow_id:    getString(item, 'workflow_id'),
    stale:          getNumber(item, 'stale'),
    status:         getString(item, 'status') ?? 'ready',
    error:          getString(item, 'error'),
    created_by:     getString(item, 'created_by'),
    created_at:     getString(item, 'created_at') ?? '',
    updated_at:     getString(item, 'updated_at') ?? '',
    attachment_ids: getString(item, 'attachment_ids') ?? '[]',
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbPresentationRepository implements PresentationRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string }) {
    this.client    = opts?.client    ?? getDynamoDbClient();
    this.tableName = opts?.tableName ?? process.env.DYNAMODB_TABLE_PORTAL_CREATE ?? 'portal-create';
  }

  getClient(): DynamoDBClient { return this.client; }
  getTableName(): string { return this.tableName; }

  private pk(id: string): string { return `PRES#${id}`; }
  private listSK(createdAt: string, id: string): string { return `${createdAt}#${id}`; }

  async create(input: CreatePresentationInput): Promise<PresentationRecord> {
    const item: Record<string, JsVal> = {
      PK:            this.pk(input.id),
      SK:            '#META',
      id:            input.id,
      project_id:    input.project_id,
      name:          input.name,
      topic:         input.topic,
      source_kind:   input.source_kind,
      source_ref:    input.source_ref,
      audience:      input.audience,
      slide_count:   input.slide_count,
      diagram_style: input.diagram_style,
      diagram_cloud: input.diagram_cloud,
      lead_agent:    input.lead_agent,
      trust_all_tools: input.trust_all_tools,
      pptx_path:     null,
      preview_json:  null,
      workflow_id:   null,
      stale:         0,
      status:        input.status,
      error:         null,
      created_by:    input.created_by,
      created_at:    input.created_at,
      updated_at:    input.updated_at,
      attachment_ids: input.attachment_ids,
      presProjectId: input.project_id,
      listSK:        this.listSK(input.created_at, input.id),
    };
    await this.client.send(new PutItemCommand({
      TableName: this.tableName,
      Item: marshalItem(item),
    }));
    return { ...input, pptx_path: null, preview_json: null, workflow_id: null, stale: 0, error: null } as PresentationRecord;
  }

  async getById(id: string, projectId: string): Promise<PresentationRecord | null> {
    const resp = await this.client.send(new GetItemCommand({
      TableName: this.tableName,
      Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
    }));
    if (!resp.Item) return null;
    const rec = itemToRecord(resp.Item);
    return rec.project_id === projectId ? rec : null;
  }

  async getByWorkflowId(workflowId: string): Promise<PresentationRecord | null> {
    const resp = await this.client.send(new QueryCommand({
      TableName:              this.tableName,
      IndexName:              'GSI-PresByWorkflow',
      KeyConditionExpression: 'presWorkflowId = :wid',
      ExpressionAttributeValues: marshalItem({ ':wid': workflowId }),
      Limit: 1,
    }));
    const item = resp.Items?.[0];
    return item ? itemToRecord(item) : null;
  }

  async listByProject(projectId: string): Promise<PresentationRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName:              this.tableName,
      IndexName:              'GSI-PresByProject',
      KeyConditionExpression: 'presProjectId = :pid',
      ExpressionAttributeValues: marshalItem({ ':pid': projectId }),
      ScanIndexForward:       false,
    }));
    return (resp.Items ?? []).map(itemToRecord);
  }

  async countByProject(projectId: string): Promise<number> {
    const items = await this.listByProject(projectId);
    return items.length;
  }

  async update(id: string, fields: PresentationUpdate): Promise<void> {
    const sets: string[] = [];
    const vals: Record<string, JsVal> = {};
    const exprNames: Record<string, string> = {};

    const add = (attr: string, val: JsVal, useExprName?: string) => {
      const safe = useExprName ?? attr.replace(/[^a-zA-Z0-9_]/g, '_');
      const nameKey = `#${safe}`;
      const valKey  = `:${safe}`;
      exprNames[nameKey] = attr;
      vals[valKey] = val;
      sets.push(`${nameKey} = ${valKey}`);
    };

    if (fields.name !== undefined)          add('name', fields.name);
    if (fields.topic !== undefined)         add('topic', fields.topic);
    if (fields.source_ref !== undefined)    add('source_ref', fields.source_ref);
    if (fields.audience !== undefined)      add('audience', fields.audience);
    if (fields.slide_count !== undefined)   add('slide_count', fields.slide_count);
    if (fields.diagram_style !== undefined) add('diagram_style', fields.diagram_style);
    if (fields.diagram_cloud !== undefined) add('diagram_cloud', fields.diagram_cloud);
    if (fields.lead_agent !== undefined)    add('lead_agent', fields.lead_agent);
    if (fields.trust_all_tools !== undefined) add('trust_all_tools', fields.trust_all_tools);
    if (fields.pptx_path !== undefined)     add('pptx_path', fields.pptx_path);
    if (fields.preview_json !== undefined)  add('preview_json', fields.preview_json);
    if (fields.workflow_id !== undefined) {
      add('workflow_id', fields.workflow_id);
      if (fields.workflow_id) {
        add('presWorkflowId', fields.workflow_id);
      }
    }
    if (fields.stale !== undefined)         add('stale', fields.stale);
    if (fields.status !== undefined)        add('status', fields.status);
    if (fields.error !== undefined)         add('error', fields.error);
    if (fields.updated_at !== undefined)    add('updated_at', fields.updated_at);
    if (fields.attachment_ids !== undefined) add('attachment_ids', fields.attachment_ids);

    if (sets.length === 0) return;
    await this.client.send(new UpdateItemCommand({
      TableName: this.tableName,
      Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: marshalItem(vals),
    }));
  }

  async delete(id: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({
      TableName: this.tableName,
      Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
    }));
  }
}
