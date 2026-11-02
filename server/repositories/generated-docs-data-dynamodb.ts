/**
 * DynamoDB implementation of GeneratedDocRepository.
 *
 * Table: portal-create (DYNAMODB_TABLE_PORTAL_CREATE, default 'portal-create')
 *
 * Key design:
 *   PK=GDOC#<id>  SK=#META       → canonical generated_doc item
 *   PK=GDOC#<docId>  SK=VER#<versionNum>  → version items
 * GSI-GDocByProject:
 *   PK=gdocProjectId  SK=<createdAt>#<id>
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
  GeneratedDocRepository,
  GeneratedDocRecord,
  GeneratedDocVersionRecord,
  CreateGeneratedDocInput,
  CreateGeneratedDocVersionInput,
  GeneratedDocUpdate,
} from './generated-docs-data.ts';

// ── Table bootstrap ───────────────────────────────────────────────────────────

export async function ensureGeneratedDocTableExists(
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
        { AttributeName: 'gdocProjectId',  AttributeType: 'S' },
        { AttributeName: 'listSK',         AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-GDocByProject',
          KeySchema: [
            { AttributeName: 'gdocProjectId', KeyType: 'HASH' },
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

function itemToDoc(item: Record<string, AttributeValue>): GeneratedDocRecord {
  return {
    id:                getString(item, 'id') ?? '',
    project_id:        getString(item, 'project_id') ?? '',
    name:              getString(item, 'name') ?? '',
    doc_type:          getString(item, 'doc_type') ?? '',
    sources_json:      getString(item, 'sources_json') ?? '{}',
    diagram_style:     getString(item, 'diagram_style') ?? 'mermaid',
    diagram_cloud:     getString(item, 'diagram_cloud'),
    lead_agent:        getString(item, 'lead_agent'),
    trust_all_tools:   getNumber(item, 'trust_all_tools'),
    audience:          getString(item, 'audience'),
    latest_version_id: getString(item, 'latest_version_id'),
    stale:             getNumber(item, 'stale'),
    status:            getString(item, 'status') ?? 'ready',
    error:             getString(item, 'error'),
    created_by:        getString(item, 'created_by'),
    created_at:        getString(item, 'created_at') ?? '',
    attachment_ids:    getString(item, 'attachment_ids') ?? '[]',
  };
}

function itemToVersion(item: Record<string, AttributeValue>): GeneratedDocVersionRecord {
  return {
    id:          getString(item, 'id') ?? '',
    doc_id:      getString(item, 'doc_id') ?? '',
    version_num: getNumber(item, 'version_num'),
    md_path:     getString(item, 'md_path'),
    docx_path:   getString(item, 'docx_path'),
    warnings:    getString(item, 'warnings'),
    workflow_id: getString(item, 'workflow_id'),
    created_at:  getString(item, 'created_at') ?? '',
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbGeneratedDocRepository implements GeneratedDocRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string }) {
    this.client    = opts?.client    ?? getDynamoDbClient();
    this.tableName = opts?.tableName ?? process.env.DYNAMODB_TABLE_PORTAL_CREATE ?? 'portal-create';
  }

  getClient(): DynamoDBClient { return this.client; }
  getTableName(): string { return this.tableName; }

  private pk(id: string): string { return `GDOC#${id}`; }
  private verSK(vnum: number): string { return `VER#${String(vnum).padStart(8, '0')}`; }

  async create(input: CreateGeneratedDocInput): Promise<GeneratedDocRecord> {
    const item: Record<string, JsVal> = {
      PK:                this.pk(input.id),
      SK:                '#META',
      id:                input.id,
      project_id:        input.project_id,
      name:              input.name,
      doc_type:          input.doc_type,
      sources_json:      input.sources_json,
      diagram_style:     input.diagram_style,
      diagram_cloud:     input.diagram_cloud,
      lead_agent:        input.lead_agent,
      trust_all_tools:   input.trust_all_tools,
      audience:          input.audience,
      latest_version_id: input.latest_version_id,
      stale:             input.stale,
      status:            'ready',
      error:             null,
      created_by:        input.created_by,
      created_at:        input.created_at,
      attachment_ids:    input.attachment_ids,
      gdocProjectId:     input.project_id,
      listSK:            `${input.created_at}#${input.id}`,
    };
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: marshalItem(item) }));
    return { ...input, status: 'ready', error: null } as GeneratedDocRecord;
  }

  async getById(id: string, projectId: string): Promise<GeneratedDocRecord | null> {
    const resp = await this.client.send(new GetItemCommand({
      TableName: this.tableName,
      Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
    }));
    if (!resp.Item) return null;
    const rec = itemToDoc(resp.Item);
    return rec.project_id === projectId ? rec : null;
  }

  async listByProject(projectId: string): Promise<GeneratedDocRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName:              this.tableName,
      IndexName:              'GSI-GDocByProject',
      KeyConditionExpression: 'gdocProjectId = :pid',
      ExpressionAttributeValues: marshalItem({ ':pid': projectId }),
      ScanIndexForward:       false,
    }));
    return (resp.Items ?? []).filter((item) => {
      const sk = item.SK?.S ?? '';
      return sk === '#META';
    }).map(itemToDoc);
  }

  async countByProject(projectId: string): Promise<number> {
    const items = await this.listByProject(projectId);
    return items.length;
  }

  async update(id: string, fields: GeneratedDocUpdate): Promise<void> {
    const sets: string[] = [];
    const vals: Record<string, JsVal> = {};
    const exprNames: Record<string, string> = {};
    const add = (attr: string, val: JsVal) => {
      const key = attr.replace(/[^a-zA-Z0-9_]/g, '_');
      exprNames[`#${key}`] = attr;
      vals[`:${key}`] = val;
      sets.push(`#${key} = :${key}`);
    };
    if (fields.name !== undefined)              add('name', fields.name);
    if (fields.doc_type !== undefined)          add('doc_type', fields.doc_type);
    if (fields.sources_json !== undefined)      add('sources_json', fields.sources_json);
    if (fields.diagram_style !== undefined)     add('diagram_style', fields.diagram_style);
    if (fields.diagram_cloud !== undefined)     add('diagram_cloud', fields.diagram_cloud);
    if (fields.lead_agent !== undefined)        add('lead_agent', fields.lead_agent);
    if (fields.trust_all_tools !== undefined)   add('trust_all_tools', fields.trust_all_tools);
    if (fields.audience !== undefined)          add('audience', fields.audience);
    if (fields.latest_version_id !== undefined) add('latest_version_id', fields.latest_version_id);
    if (fields.stale !== undefined)             add('stale', fields.stale);
    if (fields.status !== undefined)            add('status', fields.status);
    if (fields.error !== undefined)             add('error', fields.error);
    if (fields.attachment_ids !== undefined)    add('attachment_ids', fields.attachment_ids);
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
    // Also delete all version items
    const versions = await this.listVersions(id);
    for (const v of versions) {
      await this.client.send(new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshalItem({ PK: this.pk(id), SK: this.verSK(v.version_num) }),
      }));
    }
    await this.client.send(new DeleteItemCommand({
      TableName: this.tableName,
      Key: marshalItem({ PK: this.pk(id), SK: '#META' }),
    }));
  }

  async createVersion(input: CreateGeneratedDocVersionInput): Promise<GeneratedDocVersionRecord> {
    const item: Record<string, JsVal> = {
      PK:          this.pk(input.doc_id),
      SK:          this.verSK(input.version_num),
      id:          input.id,
      doc_id:      input.doc_id,
      version_num: input.version_num,
      md_path:     input.md_path,
      docx_path:   input.docx_path,
      warnings:    input.warnings,
      workflow_id: input.workflow_id,
      created_at:  input.created_at,
    };
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: marshalItem(item) }));
    return input;
  }

  async getVersionById(id: string): Promise<GeneratedDocVersionRecord | null> {
    // Without a GSI on version id, we can't efficiently look up by id only.
    // Add a GSI or store version PK/SK in a lookup item for production.
    // Backlog: add GSI-VersionById to portal-create table.
    return null;
  }

  async getLatestVersion(docId: string): Promise<GeneratedDocVersionRecord | null> {
    const versions = await this.listVersions(docId);
    return versions.length > 0 ? versions[0] : null;
  }

  async getMaxVersionNum(docId: string): Promise<number> {
    const versions = await this.listVersions(docId);
    return versions.length > 0 ? Math.max(...versions.map((v) => v.version_num)) : 0;
  }

  async listVersions(docId: string): Promise<GeneratedDocVersionRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName:              this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: marshalItem({ ':pk': this.pk(docId), ':prefix': 'VER#' }),
      ScanIndexForward:       false,
    }));
    return (resp.Items ?? []).map(itemToVersion);
  }
}
