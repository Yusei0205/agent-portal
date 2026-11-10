/**
 * DynamoDB implementation of SimulationRepository.
 *
 * Table: portal-projects  (DYNAMODB_TABLE_PORTAL_PROJECTS, default 'portal-projects')
 * See simulation.ts for the key design. Structured fields (spec, rules, operation modes) are stored as JSON strings;
 * a spec must stay under DynamoDB's 400 KB item limit (the largest sheet in the sample is well below that).
 */

import { GetItemCommand, PutItemCommand, DeleteItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import type { ApiSpec, MockRule } from '../api-sim/types.ts';
import type { SimApiRecord, SimApiUpdate, SimVersionRecord, SimulationRepository } from './simulation.ts';

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_PROJECTS ?? 'portal-projects';
}

const apiKey = (projectId: string, id: string) => ({ PK: av(`SIMAPI#${projectId}`), SK: av(`API#${id}`) });
const verKey = (apiId: string, v: number) => ({ PK: av(`SIMVER#${apiId}`), SK: av(`V#${String(v).padStart(6, '0')}`) });
const ruleKey = (apiId: string, id: string) => ({ PK: av(`SIMRULE#${apiId}`), SK: av(`R#${id}`) });

function parse<T>(raw: string | null, fallback: T): T {
  try { return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}

function toApi(i: Record<string, AttributeValue>): SimApiRecord {
  return {
    id: getString(i, 'id') ?? '',
    project_id: getString(i, 'project_id') ?? '',
    name: getString(i, 'name') ?? '',
    group_name: getString(i, 'group_name') ?? '',
    source_key: getString(i, 'source_key') ?? '',
    mode: (getString(i, 'mode') ?? 'mock') as SimApiRecord['mode'],
    live_base_url: getString(i, 'live_base_url') ?? '',
    require_explicit_rule: getNumber(i, 'require_explicit_rule') === 1,
    operation_modes: parse(getString(i, 'operation_modes'), {}),
    approved_version: getNumber(i, 'approved_version'),
    latest_version: getNumber(i, 'latest_version'),
    created_by: getString(i, 'created_by'),
    created_at: getString(i, 'created_at') ?? '',
    updated_at: getString(i, 'updated_at') ?? '',
  };
}

function apiItem(r: SimApiRecord): Record<string, AttributeValue> {
  return {
    ...apiKey(r.project_id, r.id),
    ...marshalItem({
      id: r.id, project_id: r.project_id, name: r.name, group_name: r.group_name, source_key: r.source_key, mode: r.mode,
      live_base_url: r.live_base_url, require_explicit_rule: r.require_explicit_rule ? 1 : 0,
      operation_modes: JSON.stringify(r.operation_modes), approved_version: r.approved_version,
      latest_version: r.latest_version, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
    }),
  };
}

function toVersion(i: Record<string, AttributeValue>): SimVersionRecord {
  return {
    api_id: getString(i, 'api_id') ?? '',
    version: getNumber(i, 'version'),
    status: getString(i, 'status') === 'approved' ? 'approved' : 'draft',
    label: getString(i, 'label') ?? '',
    spec: parse<ApiSpec>(getString(i, 'spec_json'), { openapi: '3.0.3', info: { title: '', version: '1' }, paths: {} }),
    created_by: getString(i, 'created_by'),
    created_at: getString(i, 'created_at') ?? '',
  };
}

export class DynamoDbSimulationRepository implements SimulationRepository {
  private readonly client: DynamoDBClient;
  constructor() { this.client = getDynamoDbClient(); }

  private async queryAll(pk: string, prefix: string): Promise<Array<Record<string, AttributeValue>>> {
    const out: Array<Record<string, AttributeValue>> = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const res = await this.client.send(new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ExpressionAttributeValues: { ':pk': av(pk), ':p': av(prefix) },
        ExclusiveStartKey: start,
      }));
      out.push(...(res.Items ?? []));
      start = res.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async listApis(projectId: string): Promise<SimApiRecord[]> {
    const items = await this.queryAll(`SIMAPI#${projectId}`, 'API#');
    return items.map(toApi).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name));
  }

  async getApi(projectId: string, id: string): Promise<SimApiRecord | null> {
    const res = await this.client.send(new GetItemCommand({ TableName: table(), Key: apiKey(projectId, id) }));
    return res.Item ? toApi(res.Item) : null;
  }

  async createApi(rec: SimApiRecord): Promise<SimApiRecord> {
    await this.client.send(new PutItemCommand({ TableName: table(), Item: apiItem(rec) }));
    return rec;
  }

  async updateApi(projectId: string, id: string, fields: SimApiUpdate): Promise<SimApiRecord | null> {
    const cur = await this.getApi(projectId, id);
    if (!cur) return null;
    const next: SimApiRecord = { ...cur, ...fields, updated_at: new Date().toISOString() };
    await this.client.send(new PutItemCommand({ TableName: table(), Item: apiItem(next) }));
    return next;
  }

  async deleteApi(projectId: string, id: string): Promise<boolean> {
    if (!(await this.getApi(projectId, id))) return false;
    const children = [
      ...(await this.queryAll(`SIMVER#${id}`, 'V#')),
      ...(await this.queryAll(`SIMRULE#${id}`, 'R#')),
    ];
    for (const c of children) {
      await this.client.send(new DeleteItemCommand({ TableName: table(), Key: { PK: c.PK, SK: c.SK } }));
    }
    await this.client.send(new DeleteItemCommand({ TableName: table(), Key: apiKey(projectId, id) }));
    return true;
  }

  async addVersion(rec: SimVersionRecord): Promise<void> {
    await this.client.send(new PutItemCommand({
      TableName: table(),
      Item: { ...verKey(rec.api_id, rec.version), ...marshalItem({ api_id: rec.api_id, version: rec.version, status: rec.status, label: rec.label, spec_json: JSON.stringify(rec.spec), created_by: rec.created_by, created_at: rec.created_at }) },
    }));
  }

  async getVersion(apiId: string, version: number): Promise<SimVersionRecord | null> {
    const res = await this.client.send(new GetItemCommand({ TableName: table(), Key: verKey(apiId, version) }));
    return res.Item ? toVersion(res.Item) : null;
  }

  async listVersions(apiId: string): Promise<SimVersionRecord[]> {
    return (await this.queryAll(`SIMVER#${apiId}`, 'V#')).map(toVersion).sort((a, b) => a.version - b.version);
  }

  async updateVersion(apiId: string, version: number, fields: { status?: 'draft' | 'approved'; spec?: ApiSpec }): Promise<void> {
    const cur = await this.getVersion(apiId, version);
    if (!cur) return;
    await this.addVersion({ ...cur, ...(fields.status ? { status: fields.status } : {}), ...(fields.spec ? { spec: fields.spec } : {}) });
  }

  async listRules(apiId: string): Promise<MockRule[]> {
    // Rules are tried in the order they were created, so keep that order (the sort key is the random id).
    return (await this.queryAll(`SIMRULE#${apiId}`, 'R#'))
      .sort((a, b) => (getString(a, 'created_at') ?? '').localeCompare(getString(b, 'created_at') ?? ''))
      .map((i) => parse<MockRule | null>(getString(i, 'rule_json'), null))
      .filter((r): r is MockRule => r !== null);
  }

  async putRule(apiId: string, rule: MockRule): Promise<void> {
    const key = ruleKey(apiId, rule.id);
    const existing = await this.client.send(new GetItemCommand({ TableName: table(), Key: key }));
    const at = new Date().toISOString();
    const created = (existing.Item && getString(existing.Item, 'created_at')) || at;
    await this.client.send(new PutItemCommand({
      TableName: table(),
      Item: { ...key, ...marshalItem({ rule_json: JSON.stringify(rule), created_at: created, updated_at: at }) },
    }));
  }

  async deleteRule(apiId: string, ruleId: string): Promise<boolean> {
    const res = await this.client.send(new DeleteItemCommand({ TableName: table(), Key: ruleKey(apiId, ruleId), ReturnValues: 'ALL_OLD' }));
    return res.Attributes !== undefined;
  }
}
