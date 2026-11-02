/**
 * DynamoDB implementation of LoopSpecsRepository.
 *
 * Table: portal-p10
 * Specs:  PK=LOOPSPEC#<projectId>  SK=SPEC#<id>  (project)
 *         PK=LOOPSPEC_BUILTIN       SK=SPEC#<id>  (builtin)
 * Runs:   PK=LOOPRUN#<specId>       SK=RUN#<isoStartedAt>#<id>
 * GSI-P10EntityId: id / entityType
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
import type { LoopSpecsRepository, LoopSpecRecord, LoopRunRecord, CreateLoopSpecInput, CreateLoopRunInput } from './loop-specs.ts';

function table(): string { return process.env.DYNAMODB_TABLE_PORTAL_P10 ?? 'portal-p10-test'; }

function specPk(projectId: string | null, isBuiltin: number): string {
  return isBuiltin ? 'LOOPSPEC_BUILTIN' : `LOOPSPEC#${projectId ?? 'null'}`;
}
function specSk(id: string): string { return `SPEC#${id}`; }
function runPk(specId: string): string { return `LOOPRUN#${specId}`; }
function runSk(startedAt: string, id: string): string { return `RUN#${startedAt}#${id}`; }

function itemToSpec(item: Record<string, AttributeValue>): LoopSpecRecord {
  return {
    id: getString(item, 'id') ?? '', project_id: getString(item, 'project_id'),
    name: getString(item, 'name') ?? '', description: getString(item, 'description'),
    trigger_type: getString(item, 'trigger_type') ?? 'manual',
    trigger_config: getString(item, 'trigger_config') ?? '{}',
    goal_template: getString(item, 'goal_template') ?? '', rules: getString(item, 'rules'),
    stop_config: getString(item, 'stop_config') ?? '{}',
    max_iterations: getNumber(item, 'max_iterations') || 10,
    enabled: getNumber(item, 'enabled'), is_builtin: getNumber(item, 'is_builtin'),
    created_at: getString(item, 'created_at') ?? '',
  };
}

function itemToRun(item: Record<string, AttributeValue>): LoopRunRecord {
  return {
    id: getString(item, 'id') ?? '', spec_id: getString(item, 'spec_id') ?? '',
    status: getString(item, 'status') ?? '', iteration: getNumber(item, 'iteration'),
    last_workflow_id: getString(item, 'last_workflow_id'),
    started_at: getString(item, 'started_at') ?? '', finished_at: getString(item, 'finished_at'),
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

export class DynamoDbLoopSpecsRepository implements LoopSpecsRepository {
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

  async createSpec(input: CreateLoopSpecInput): Promise<LoopSpecRecord> {
    const item = {
      PK: av(specPk(input.project_id, input.is_builtin)), SK: av(specSk(input.id)),
      id: av(input.id), entityType: av('loopspec'),
      ...marshalItem({ project_id: input.project_id, name: input.name, description: input.description,
        trigger_type: input.trigger_type, trigger_config: input.trigger_config,
        goal_template: input.goal_template, rules: input.rules, stop_config: input.stop_config,
        created_at: input.created_at }),
      max_iterations: { N: String(input.max_iterations) },
      enabled: { N: String(input.enabled) },
      is_builtin: { N: String(input.is_builtin) },
    };
    await this.client.send(new PutItemCommand({ TableName: table(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    return itemToSpec(item);
  }

  async getSpecById(id: string): Promise<LoopSpecRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(), IndexName: 'GSI-P10EntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('loopspec') }, Limit: 1,
    }));
    const item = res.Items?.[0];
    return item ? itemToSpec(item) : null;
  }

  async listSpecsByProject(projectId: string): Promise<LoopSpecRecord[]> {
    const [builtins, custom] = await Promise.all([
      paginateAll(this.client, { TableName: table(), KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': av('LOOPSPEC_BUILTIN') } }),
      paginateAll(this.client, { TableName: table(), KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': av(`LOOPSPEC#${projectId}`) } }),
    ]);
    const builtinSpecs = builtins.map(itemToSpec).sort((a, b) => a.name.localeCompare(b.name));
    const customSpecs = custom.map(itemToSpec).sort((a, b) => a.created_at.localeCompare(b.created_at));
    return [...builtinSpecs, ...customSpecs];
  }

  async updateSpec(id: string, projectId: string, patch: Partial<LoopSpecRecord>): Promise<LoopSpecRecord | null> {
    const spec = await this.getSpecById(id);
    if (!spec || spec.project_id !== projectId || spec.is_builtin) return null;
    const keys = Object.keys(patch).filter((k) => !['id', 'project_id', 'created_at', 'is_builtin'].includes(k));
    if (keys.length === 0) return spec;
    const exprParts = keys.map((_, i) => `#f${i} = :v${i}`);
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};
    keys.forEach((k, i) => {
      names[`#f${i}`] = k;
      const v = (patch as Record<string, unknown>)[k];
      vals[`:v${i}`] = typeof v === 'number' ? { N: String(v) } : av(v as string | null);
    });
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: av(specPk(projectId, 0)), SK: av(specSk(id)) },
      UpdateExpression: `SET ${exprParts.join(', ')}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: vals,
    }));
    return { ...spec, ...patch };
  }

  async deleteSpec(id: string, projectId: string): Promise<boolean> {
    const spec = await this.getSpecById(id);
    if (!spec || spec.project_id !== projectId || spec.is_builtin) return false;
    await this.client.send(new DeleteItemCommand({ TableName: table(), Key: { PK: av(specPk(projectId, 0)), SK: av(specSk(id)) } }));
    return true;
  }

  async createRun(input: CreateLoopRunInput): Promise<LoopRunRecord> {
    const item = {
      PK: av(runPk(input.spec_id)), SK: av(runSk(input.started_at, input.id)),
      id: av(input.id), entityType: av('looprun'),
      ...marshalItem({ spec_id: input.spec_id, status: input.status,
        last_workflow_id: input.last_workflow_id, started_at: input.started_at, finished_at: input.finished_at }),
      iteration: { N: String(input.iteration) },
    };
    await this.client.send(new PutItemCommand({ TableName: table(), Item: item }));
    return itemToRun(item);
  }

  async getRunById(id: string): Promise<LoopRunRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(), IndexName: 'GSI-P10EntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('looprun') }, Limit: 1,
    }));
    const item = res.Items?.[0];
    return item ? itemToRun(item) : null;
  }

  async getLastRunBySpec(specId: string): Promise<LoopRunRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(), KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': av(runPk(specId)) },
      ScanIndexForward: false, Limit: 1,
    }));
    const item = res.Items?.[0];
    return item ? itemToRun(item) : null;
  }

  async listRunsBySpec(specId: string, limit: number): Promise<LoopRunRecord[]> {
    const items: Array<Record<string, AttributeValue>> = [];
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const res = await this.client.send(new QueryCommand({
        TableName: table(), KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': av(runPk(specId)) },
        ScanIndexForward: false, Limit: limit,
        ExclusiveStartKey: lastKey,
      }));
      if (res.Items) items.push(...res.Items);
      lastKey = res.LastEvaluatedKey;
    } while (lastKey && items.length < limit);
    return items.slice(0, limit).map(itemToRun);
  }
}
