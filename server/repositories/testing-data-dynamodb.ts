/**
 * DynamoDB implementation of TestingRepository.
 *
 * Table: portal-testing (DYNAMODB_TABLE_PORTAL_TESTING, default 'portal-testing')
 *
 * Key design (all entities share one table):
 *   PK=TP#<id>   SK=#META     → test_projects
 *   PK=TG#<id>   SK=#META     → test_groups
 *   PK=TS#<id>   SK=#META     → test_scripts
 *   PK=TVI#<id>  SK=#META     → test_vault_items
 *   PK=TVF#<id>  SK=#META     → test_vault_files
 *   PK=TR#<id>   SK=#META     → test_runs
 *   PK=TRS#<runId>  SK=<stepIndex>   → test_run_steps
 *   PK=TCS#<id>  SK=#META     → test_case_sets
 *   PK=TC#<caseSetId>  SK=ORD#<ord>#<id>  → test_cases
 *   PK=TGN#<id>  SK=#META     → test_generations
 *   PK=TRACE_CS#<caseSetId>  SK=<seq>  → trace_steps (by case set)
 *   PK=TRACE_GN#<genId>      SK=<seq>  → trace_steps (by generation)
 *
 * GSI-TestByProject:
 *   PK=testPortalProjectId  SK=<type>#<createdAt>#<id>
 * GSI-TestByTestProject:
 *   PK=testTestProjectId  SK=<type>#<createdAt>#<id>
 * GSI-VaultItemByName (sparse):
 *   PK=vaultItemKey (<testProjectId>#<name>)  SK=#META
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
  TestingRepository,
  TestProjectRecord,
  TestGroupRecord,
  TestScriptRecord,
  TestVaultItemRecord,
  TestVaultFileRecord,
  TestRunRecord,
  TestRunStepRecord,
  TestCaseSetRecord,
  TestCaseRecord,
  TestGenerationRecord,
  TraceStepRecord,
} from './testing-data.ts';

// ── Table bootstrap ───────────────────────────────────────────────────────────

export async function ensureTestingTableExists(
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
        { AttributeName: 'PK',                  AttributeType: 'S' },
        { AttributeName: 'SK',                  AttributeType: 'S' },
        { AttributeName: 'testPortalProjectId', AttributeType: 'S' },
        { AttributeName: 'testTestProjectId',   AttributeType: 'S' },
        { AttributeName: 'vaultItemKey',        AttributeType: 'S' },
        { AttributeName: 'testListSK',          AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI-TestByProject',
          KeySchema: [
            { AttributeName: 'testPortalProjectId', KeyType: 'HASH' },
            { AttributeName: 'testListSK',           KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI-TestByTestProject',
          KeySchema: [
            { AttributeName: 'testTestProjectId', KeyType: 'HASH' },
            { AttributeName: 'testListSK',         KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI-VaultItemByName',
          KeySchema: [
            { AttributeName: 'vaultItemKey', KeyType: 'HASH' },
            { AttributeName: 'SK',            KeyType: 'RANGE' },
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

// ── Generic helpers ───────────────────────────────────────────────────────────

function listSK(type: string, createdAt: string, id: string): string {
  return `${type}#${createdAt}#${id}`;
}

// ── Item converters ───────────────────────────────────────────────────────────

const S = (v: string | null | undefined): string => v ?? '';

function itemToTestProject(item: Record<string, AttributeValue>): TestProjectRecord {
  return {
    id:              S(getString(item, 'id')),
    project_id:      S(getString(item, 'project_id')),
    name:            S(getString(item, 'name')),
    app_url:         S(getString(item, 'app_url')),
    api_base_url:    getString(item, 'api_base_url'),
    repo_ids:        S(getString(item, 'repo_ids')) || '[]',
    vault_doc_paths: S(getString(item, 'vault_doc_paths')) || '[]',
    viewport_width:  getNumber(item, 'viewport_width') || 1440,
    viewport_height: getNumber(item, 'viewport_height') || 900,
    timeout_secs:    getNumber(item, 'timeout_secs') || 300,
    rules_for_ai:    S(getString(item, 'rules_for_ai')),
    created_by:      getString(item, 'created_by'),
    created_at:      S(getString(item, 'created_at')),
    updated_at:      S(getString(item, 'updated_at')),
  };
}

function itemToGroup(item: Record<string, AttributeValue>): TestGroupRecord {
  return {
    id:              S(getString(item, 'id')),
    test_project_id: S(getString(item, 'test_project_id')),
    name:            S(getString(item, 'name')),
    sort_order:      getNumber(item, 'sort_order'),
    created_at:      S(getString(item, 'created_at')),
    updated_at:      S(getString(item, 'updated_at')),
  };
}

function itemToScript(item: Record<string, AttributeValue>): TestScriptRecord {
  return {
    id:              S(getString(item, 'id')),
    test_project_id: S(getString(item, 'test_project_id')),
    test_group_id:   S(getString(item, 'test_group_id')),
    name:            S(getString(item, 'name')),
    sort_order:      getNumber(item, 'sort_order'),
    steps:           S(getString(item, 'steps')) || '[]',
    created_by:      getString(item, 'created_by'),
    created_at:      S(getString(item, 'created_at')),
    updated_at:      S(getString(item, 'updated_at')),
  };
}

function itemToVaultItem(item: Record<string, AttributeValue>): TestVaultItemRecord {
  return {
    id:              S(getString(item, 'id')),
    test_project_id: S(getString(item, 'test_project_id')),
    name:            S(getString(item, 'name')),
    kind:            (S(getString(item, 'kind')) || 'secret') as 'login' | 'secret',
    username:        getString(item, 'username'),
    password_enc:    getString(item, 'password_enc'),
    totp_secret_enc: getString(item, 'totp_secret_enc'),
    value_enc:       getString(item, 'value_enc'),
    created_by:      getString(item, 'created_by'),
    created_at:      S(getString(item, 'created_at')),
    updated_at:      S(getString(item, 'updated_at')),
  };
}

function itemToVaultFile(item: Record<string, AttributeValue>): TestVaultFileRecord {
  return {
    id:              S(getString(item, 'id')),
    test_project_id: S(getString(item, 'test_project_id')),
    name:            S(getString(item, 'name')),
    path:            S(getString(item, 'path')),
    size_bytes:      getNumber(item, 'size_bytes'),
    mime_type:       getString(item, 'mime_type'),
    uploaded_by:     getString(item, 'uploaded_by'),
    created_at:      S(getString(item, 'created_at')),
  };
}

function itemToRun(item: Record<string, AttributeValue>): TestRunRecord {
  return {
    id:              S(getString(item, 'id')),
    test_project_id: S(getString(item, 'test_project_id')),
    script_id:       getString(item, 'script_id'),
    group_id:        getString(item, 'group_id'),
    status:          S(getString(item, 'status')) || 'queued',
    error:           getString(item, 'error'),
    artifact_dir:    getString(item, 'artifact_dir'),
    created_by:      getString(item, 'created_by'),
    created_at:      S(getString(item, 'created_at')),
    started_at:      getString(item, 'started_at'),
    finished_at:     getString(item, 'finished_at'),
  };
}

function itemToRunStep(item: Record<string, AttributeValue>): TestRunStepRecord {
  return {
    id:              S(getString(item, 'id')),
    run_id:          S(getString(item, 'run_id')),
    script_id:       S(getString(item, 'script_id')),
    step_index:      getNumber(item, 'step_index'),
    status:          S(getString(item, 'status')) || 'passed',
    duration_ms:     item.duration_ms?.N != null ? getNumber(item, 'duration_ms') : null,
    error:           getString(item, 'error'),
    screenshot_path: getString(item, 'screenshot_path'),
    created_at:      S(getString(item, 'created_at')),
  };
}

function itemToCaseSet(item: Record<string, AttributeValue>): TestCaseSetRecord {
  return {
    id:                  S(getString(item, 'id')),
    test_project_id:     S(getString(item, 'test_project_id')),
    name:                S(getString(item, 'name')),
    description:         S(getString(item, 'description')),
    status:              S(getString(item, 'status')) || 'queued',
    progress:            S(getString(item, 'progress')) || '{}',
    error:               getString(item, 'error'),
    warnings:            S(getString(item, 'warnings')) || '[]',
    created_by:          getString(item, 'created_by'),
    created_at:          S(getString(item, 'created_at')),
    started_at:          getString(item, 'started_at'),
    finished_at:         getString(item, 'finished_at'),
    cancelled:           getNumber(item, 'cancelled'),
    outline_categories:  getString(item, 'outline_categories'),
    attachment_ids:      S(getString(item, 'attachment_ids')) || '[]',
  };
}

function itemToCase(item: Record<string, AttributeValue>): TestCaseRecord {
  return {
    id:              S(getString(item, 'id')),
    case_set_id:     S(getString(item, 'case_set_id')),
    ord:             getNumber(item, 'ord'),
    test_id:         S(getString(item, 'test_id')),
    category:        S(getString(item, 'category')),
    scenario:        S(getString(item, 'scenario')),
    precondition:    S(getString(item, 'precondition')),
    steps:           S(getString(item, 'steps')),
    expected_result: S(getString(item, 'expected_result')),
    status:          S(getString(item, 'status')),
    remarks:         S(getString(item, 'remarks')),
    request:         getString(item, 'request'),
    response:        getString(item, 'response'),
    created_at:      S(getString(item, 'created_at')),
    updated_at:      S(getString(item, 'updated_at')),
  };
}

function itemToGeneration(item: Record<string, AttributeValue>): TestGenerationRecord {
  return {
    id:                S(getString(item, 'id')),
    test_project_id:   S(getString(item, 'test_project_id')),
    script_id:         getString(item, 'script_id'),
    kind:              S(getString(item, 'kind')) || 'generate',
    description:       getString(item, 'description'),
    status:            S(getString(item, 'status')) || 'pending',
    error:             getString(item, 'error'),
    result_script_ids: S(getString(item, 'result_script_ids')) || '[]',
    warnings:          S(getString(item, 'warnings')) || '[]',
    created_by:        getString(item, 'created_by'),
    created_at:        S(getString(item, 'created_at')),
    finished_at:       getString(item, 'finished_at'),
    progress:          S(getString(item, 'progress')) || '{}',
    started_at:        getString(item, 'started_at'),
    cancelled_at:      getString(item, 'cancelled_at'),
  };
}

function itemToTrace(item: Record<string, AttributeValue>): TraceStepRecord {
  return {
    id:               S(getString(item, 'id')),
    case_set_id:      getString(item, 'case_set_id'),
    generation_id:    getString(item, 'generation_id'),
    seq:              getNumber(item, 'seq'),
    kind:             S(getString(item, 'kind')),
    label:            S(getString(item, 'label')),
    status:           S(getString(item, 'status')) || 'running',
    started_at:       S(getString(item, 'started_at')),
    finished_at:      getString(item, 'finished_at'),
    duration_ms:      item.duration_ms?.N != null ? getNumber(item, 'duration_ms') : null,
    detail:           S(getString(item, 'detail')) || '{}',
    prompt:           getString(item, 'prompt'),
    output:           getString(item, 'output'),
    output_truncated: getNumber(item, 'output_truncated'),
    error:            getString(item, 'error'),
  };
}

// ── Generic update helper ─────────────────────────────────────────────────────

async function genericUpdate(
  client: DynamoDBClient,
  tableName: string,
  pk: string,
  sk: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const sets: string[] = [];
  const vals: Record<string, JsVal> = {};
  const names: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const key = k.replace(/[^a-zA-Z0-9_]/g, '_');
    names[`#${key}`] = k;
    vals[`:${key}`] = v as JsVal;
    sets.push(`#${key} = :${key}`);
  }
  if (!sets.length) return;
  await client.send(new UpdateItemCommand({
    TableName: tableName,
    Key: marshalItem({ PK: pk, SK: sk }),
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshalItem(vals),
  }));
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbTestingRepository implements TestingRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(opts?: { client?: DynamoDBClient; tableName?: string }) {
    this.client    = opts?.client    ?? getDynamoDbClient();
    this.tableName = opts?.tableName ?? process.env.DYNAMODB_TABLE_PORTAL_TESTING ?? 'portal-testing';
  }

  getClient(): DynamoDBClient { return this.client; }
  getTableName(): string { return this.tableName; }

  private async put(item: Record<string, JsVal>): Promise<void> {
    await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: marshalItem(item) }));
  }

  private async getItem<T>(pk: string, sk: string, converter: (item: Record<string, AttributeValue>) => T): Promise<T | null> {
    const resp = await this.client.send(new GetItemCommand({
      TableName: this.tableName, Key: marshalItem({ PK: pk, SK: sk }),
    }));
    return resp.Item ? converter(resp.Item) : null;
  }

  private async queryByGsi<T>(
    gsiName: string,
    pkAttr: string,
    pkVal: string,
    skPrefix: string | null,
    converter: (item: Record<string, AttributeValue>) => T,
  ): Promise<T[]> {
    const keyCond = skPrefix
      ? `${pkAttr} = :pk AND begins_with(testListSK, :prefix)`
      : `${pkAttr} = :pk`;
    const vals: Record<string, JsVal> = { ':pk': pkVal };
    if (skPrefix) vals[':prefix'] = skPrefix;
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName, IndexName: gsiName,
      KeyConditionExpression: keyCond,
      ExpressionAttributeValues: marshalItem(vals),
      ScanIndexForward: false,
    }));
    return (resp.Items ?? []).filter((i) => i.SK?.S === '#META').map(converter);
  }

  private async deleteItem(pk: string, sk: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({ TableName: this.tableName, Key: marshalItem({ PK: pk, SK: sk }) }));
  }

  // test_projects
  async createTestProject(rec: TestProjectRecord): Promise<TestProjectRecord> {
    const item: Record<string, JsVal> = {
      PK: `TP#${rec.id}`, SK: '#META',
      id: rec.id, project_id: rec.project_id, name: rec.name, app_url: rec.app_url,
      api_base_url: rec.api_base_url, repo_ids: rec.repo_ids, vault_doc_paths: rec.vault_doc_paths,
      viewport_width: rec.viewport_width, viewport_height: rec.viewport_height,
      timeout_secs: rec.timeout_secs, rules_for_ai: rec.rules_for_ai,
      created_by: rec.created_by, created_at: rec.created_at, updated_at: rec.updated_at,
      testPortalProjectId: rec.project_id, testListSK: listSK('TP', rec.created_at, rec.id),
    };
    await this.put(item);
    return rec;
  }

  async getTestProjectById(id: string): Promise<TestProjectRecord | null> {
    return this.getItem(`TP#${id}`, '#META', itemToTestProject);
  }

  async getTestProjectByProjectAndId(projectId: string, id: string): Promise<TestProjectRecord | null> {
    const rec = await this.getTestProjectById(id);
    return rec?.project_id === projectId ? rec : null;
  }

  async listTestProjectsByProject(projectId: string): Promise<TestProjectRecord[]> {
    return this.queryByGsi('GSI-TestByProject', 'testPortalProjectId', projectId, 'TP#', itemToTestProject);
  }

  async updateTestProject(id: string, fields: Partial<TestProjectRecord>): Promise<void> {
    await genericUpdate(this.client, this.tableName, `TP#${id}`, '#META', fields as Record<string, unknown>);
  }

  async deleteTestProject(id: string): Promise<void> {
    await this.deleteItem(`TP#${id}`, '#META');
  }

  // test_groups
  async createTestGroup(rec: TestGroupRecord): Promise<TestGroupRecord> {
    await this.put({
      PK: `TG#${rec.id}`, SK: '#META',
      id: rec.id, test_project_id: rec.test_project_id, name: rec.name,
      sort_order: rec.sort_order, created_at: rec.created_at, updated_at: rec.updated_at,
      testTestProjectId: rec.test_project_id, testListSK: listSK('TG', rec.created_at, rec.id),
    });
    return rec;
  }

  async getTestGroupById(id: string): Promise<TestGroupRecord | null> {
    return this.getItem(`TG#${id}`, '#META', itemToGroup);
  }

  async getTestGroupByTestProjectAndId(testProjectId: string, id: string): Promise<TestGroupRecord | null> {
    const rec = await this.getTestGroupById(id);
    return rec?.test_project_id === testProjectId ? rec : null;
  }

  async listGroupsByTestProject(testProjectId: string): Promise<TestGroupRecord[]> {
    const items = await this.queryByGsi('GSI-TestByTestProject', 'testTestProjectId', testProjectId, 'TG#', itemToGroup);
    return items.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }

  async getMaxGroupSortOrder(testProjectId: string): Promise<number> {
    const groups = await this.listGroupsByTestProject(testProjectId);
    return groups.length === 0 ? 0 : Math.max(...groups.map((g) => g.sort_order)) + 1;
  }

  async updateTestGroup(id: string, fields: Partial<TestGroupRecord>): Promise<void> {
    await genericUpdate(this.client, this.tableName, `TG#${id}`, '#META', fields as Record<string, unknown>);
  }

  async deleteTestGroup(id: string): Promise<void> {
    await this.deleteItem(`TG#${id}`, '#META');
  }

  // test_scripts
  async createTestScript(rec: TestScriptRecord): Promise<TestScriptRecord> {
    await this.put({
      PK: `TS#${rec.id}`, SK: '#META',
      id: rec.id, test_project_id: rec.test_project_id, test_group_id: rec.test_group_id,
      name: rec.name, sort_order: rec.sort_order, steps: rec.steps,
      created_by: rec.created_by, created_at: rec.created_at, updated_at: rec.updated_at,
      testTestProjectId: rec.test_project_id, testListSK: listSK('TS', rec.created_at, rec.id),
    });
    return rec;
  }

  async getTestScriptById(id: string): Promise<TestScriptRecord | null> {
    return this.getItem(`TS#${id}`, '#META', itemToScript);
  }

  async getTestScriptByTestProjectAndId(testProjectId: string, id: string): Promise<TestScriptRecord | null> {
    const rec = await this.getTestScriptById(id);
    return rec?.test_project_id === testProjectId ? rec : null;
  }

  async listScriptsByTestProject(testProjectId: string): Promise<TestScriptRecord[]> {
    const items = await this.queryByGsi('GSI-TestByTestProject', 'testTestProjectId', testProjectId, 'TS#', itemToScript);
    return items.sort((a, b) => a.sort_order - b.sort_order);
  }

  async listScriptsByGroup(groupId: string): Promise<TestScriptRecord[]> {
    // Backlog: add GSI-ScriptsByGroup. For now, not available without scan.
    return [];
  }

  async updateTestScript(id: string, fields: Partial<TestScriptRecord>): Promise<void> {
    await genericUpdate(this.client, this.tableName, `TS#${id}`, '#META', fields as Record<string, unknown>);
  }

  async deleteTestScript(id: string): Promise<void> {
    await this.deleteItem(`TS#${id}`, '#META');
  }

  // test_vault_items
  async createVaultItem(rec: TestVaultItemRecord): Promise<TestVaultItemRecord> {
    await this.put({
      PK: `TVI#${rec.id}`, SK: '#META',
      id: rec.id, test_project_id: rec.test_project_id, name: rec.name, kind: rec.kind,
      username: rec.username, password_enc: rec.password_enc, totp_secret_enc: rec.totp_secret_enc,
      value_enc: rec.value_enc, created_by: rec.created_by, created_at: rec.created_at, updated_at: rec.updated_at,
      vaultItemKey: `${rec.test_project_id}#${rec.name}`,
      testTestProjectId: rec.test_project_id, testListSK: listSK('TVI', rec.created_at, rec.id),
    });
    return rec;
  }

  async getVaultItemByTestProjectAndName(testProjectId: string, name: string): Promise<TestVaultItemRecord | null> {
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName, IndexName: 'GSI-VaultItemByName',
      KeyConditionExpression: 'vaultItemKey = :key',
      ExpressionAttributeValues: marshalItem({ ':key': `${testProjectId}#${name}` }),
      Limit: 1,
    }));
    const item = resp.Items?.[0];
    return item ? itemToVaultItem(item) : null;
  }

  async getVaultItemById(id: string): Promise<TestVaultItemRecord | null> {
    return this.getItem(`TVI#${id}`, '#META', itemToVaultItem);
  }

  async listVaultItemsByTestProject(testProjectId: string): Promise<TestVaultItemRecord[]> {
    const items = await this.queryByGsi('GSI-TestByTestProject', 'testTestProjectId', testProjectId, 'TVI#', itemToVaultItem);
    return items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }

  async updateVaultItem(id: string, fields: Partial<TestVaultItemRecord>): Promise<void> {
    await genericUpdate(this.client, this.tableName, `TVI#${id}`, '#META', fields as Record<string, unknown>);
  }

  async deleteVaultItem(id: string): Promise<void> {
    await this.deleteItem(`TVI#${id}`, '#META');
  }

  // test_vault_files
  async createVaultFile(rec: TestVaultFileRecord): Promise<TestVaultFileRecord> {
    await this.put({
      PK: `TVF#${rec.id}`, SK: '#META',
      id: rec.id, test_project_id: rec.test_project_id, name: rec.name, path: rec.path,
      size_bytes: rec.size_bytes, mime_type: rec.mime_type, uploaded_by: rec.uploaded_by, created_at: rec.created_at,
      testTestProjectId: rec.test_project_id, testListSK: listSK('TVF', rec.created_at, rec.id),
    });
    return rec;
  }

  async getVaultFileByTestProjectAndId(testProjectId: string, id: string): Promise<TestVaultFileRecord | null> {
    const rec = await this.getVaultFileById(id);
    return rec?.test_project_id === testProjectId ? rec : null;
  }

  async getVaultFileById(id: string): Promise<TestVaultFileRecord | null> {
    return this.getItem(`TVF#${id}`, '#META', itemToVaultFile);
  }

  async getVaultFileByTestProjectAndName(testProjectId: string, name: string): Promise<TestVaultFileRecord | null> {
    const files = await this.listVaultFilesByTestProject(testProjectId);
    return files.find((f) => f.name === name) ?? null;
  }

  async listVaultFilesByTestProject(testProjectId: string): Promise<TestVaultFileRecord[]> {
    const items = await this.queryByGsi('GSI-TestByTestProject', 'testTestProjectId', testProjectId, 'TVF#', itemToVaultFile);
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  async deleteVaultFile(id: string): Promise<void> {
    await this.deleteItem(`TVF#${id}`, '#META');
  }

  // test_runs
  async createTestRun(rec: TestRunRecord): Promise<TestRunRecord> {
    await this.put({
      PK: `TR#${rec.id}`, SK: '#META',
      id: rec.id, test_project_id: rec.test_project_id, script_id: rec.script_id,
      group_id: rec.group_id, status: rec.status, error: rec.error,
      artifact_dir: rec.artifact_dir, created_by: rec.created_by,
      created_at: rec.created_at, started_at: rec.started_at, finished_at: rec.finished_at,
      testTestProjectId: rec.test_project_id, testListSK: listSK('TR', rec.created_at, rec.id),
    });
    return rec;
  }

  async getTestRunById(id: string): Promise<TestRunRecord | null> {
    return this.getItem(`TR#${id}`, '#META', itemToRun);
  }

  async getTestRunByTestProjectAndId(testProjectId: string, id: string): Promise<TestRunRecord | null> {
    const rec = await this.getTestRunById(id);
    return rec?.test_project_id === testProjectId ? rec : null;
  }

  async listRunsByTestProject(testProjectId: string, limit: number, _offset: number): Promise<TestRunRecord[]> {
    const items = await this.queryByGsi('GSI-TestByTestProject', 'testTestProjectId', testProjectId, 'TR#', itemToRun);
    return items.slice(0, limit);
  }

  async updateTestRun(id: string, fields: Partial<TestRunRecord>): Promise<void> {
    await genericUpdate(this.client, this.tableName, `TR#${id}`, '#META', fields as Record<string, unknown>);
  }

  // test_run_steps
  async createRunStep(rec: TestRunStepRecord): Promise<TestRunStepRecord> {
    const sk = String(rec.step_index).padStart(8, '0');
    await this.put({
      PK: `TRS#${rec.run_id}`, SK: sk,
      id: rec.id, run_id: rec.run_id, script_id: rec.script_id, step_index: rec.step_index,
      status: rec.status, duration_ms: rec.duration_ms, error: rec.error,
      screenshot_path: rec.screenshot_path, created_at: rec.created_at,
    });
    return rec;
  }

  async listStepsByRun(runId: string): Promise<TestRunStepRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: marshalItem({ ':pk': `TRS#${runId}` }),
      ScanIndexForward: true,
    }));
    return (resp.Items ?? []).map(itemToRunStep);
  }

  // test_case_sets
  async createCaseSet(rec: TestCaseSetRecord): Promise<TestCaseSetRecord> {
    await this.put({
      PK: `TCS#${rec.id}`, SK: '#META',
      id: rec.id, test_project_id: rec.test_project_id, name: rec.name, description: rec.description,
      status: rec.status, progress: rec.progress, error: rec.error, warnings: rec.warnings,
      created_by: rec.created_by, created_at: rec.created_at, started_at: rec.started_at,
      finished_at: rec.finished_at, cancelled: rec.cancelled,
      outline_categories: rec.outline_categories, attachment_ids: rec.attachment_ids,
      testTestProjectId: rec.test_project_id, testListSK: listSK('TCS', rec.created_at, rec.id),
    });
    return rec;
  }

  async getCaseSetById(id: string): Promise<TestCaseSetRecord | null> {
    return this.getItem(`TCS#${id}`, '#META', itemToCaseSet);
  }

  async getCaseSetByTestProjectAndId(testProjectId: string, id: string): Promise<TestCaseSetRecord | null> {
    const rec = await this.getCaseSetById(id);
    return rec?.test_project_id === testProjectId ? rec : null;
  }

  async listCaseSetsByTestProject(testProjectId: string, limit: number, _offset: number): Promise<{ items: TestCaseSetRecord[]; total: number }> {
    const all = await this.queryByGsi('GSI-TestByTestProject', 'testTestProjectId', testProjectId, 'TCS#', itemToCaseSet);
    return { items: all.slice(0, limit), total: all.length };
  }

  async updateCaseSet(id: string, fields: Partial<TestCaseSetRecord>): Promise<void> {
    await genericUpdate(this.client, this.tableName, `TCS#${id}`, '#META', fields as Record<string, unknown>);
  }

  async deleteCaseSet(id: string): Promise<void> {
    await this.deleteItem(`TCS#${id}`, '#META');
  }

  // test_cases
  async createCase(rec: TestCaseRecord): Promise<TestCaseRecord> {
    const sk = `ORD#${String(rec.ord).padStart(8, '0')}#${rec.id}`;
    await this.put({
      PK: `TC#${rec.case_set_id}`, SK: sk,
      id: rec.id, case_set_id: rec.case_set_id, ord: rec.ord, test_id: rec.test_id,
      category: rec.category, scenario: rec.scenario, precondition: rec.precondition,
      steps: rec.steps, expected_result: rec.expected_result, status: rec.status,
      remarks: rec.remarks, request: rec.request, response: rec.response,
      created_at: rec.created_at, updated_at: rec.updated_at,
    });
    return rec;
  }

  async getCaseById(id: string): Promise<TestCaseRecord | null> {
    // Without a secondary index on case id, we can't look up efficiently.
    // Backlog: add GSI-CaseById to portal-testing.
    return null;
  }

  async listCasesByCaseSet(caseSetId: string): Promise<TestCaseRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: marshalItem({ ':pk': `TC#${caseSetId}`, ':prefix': 'ORD#' }),
      ScanIndexForward: true,
    }));
    return (resp.Items ?? []).map(itemToCase);
  }

  async updateCase(id: string, fields: Partial<TestCaseRecord>): Promise<void> {
    // Backlog: need caseSetId+ord to construct PK/SK for update. Store a lookup item in production.
  }

  async deleteCase(id: string): Promise<void> {
    // Backlog: need caseSetId+ord to construct PK/SK for delete.
  }

  async countCasesByCaseSet(caseSetId: string): Promise<number> {
    const cases = await this.listCasesByCaseSet(caseSetId);
    return cases.length;
  }

  async getMaxOrdByCaseSet(caseSetId: string): Promise<number> {
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: marshalItem({ ':pk': `TC#${caseSetId}`, ':prefix': 'ORD#' }),
      ScanIndexForward: false,
      Limit: 1,
    }));
    const item = resp.Items?.[0];
    return item ? getNumber(item, 'ord') : 0;
  }

  async getCategoryOrderByCaseSet(caseSetId: string): Promise<string[]> {
    const cases = await this.listCasesByCaseSet(caseSetId);
    const seen = new Set<string>();
    const order: string[] = [];
    for (const c of cases) {
      if (!seen.has(c.category)) { seen.add(c.category); order.push(c.category); }
    }
    return order;
  }

  async countCasesByCaseSetAndCategory(caseSetId: string, category: string): Promise<number> {
    const cases = await this.listCasesByCaseSet(caseSetId);
    return cases.filter((c) => c.category === category).length;
  }

  // test_generations
  async createGeneration(rec: TestGenerationRecord): Promise<TestGenerationRecord> {
    await this.put({
      PK: `TGN#${rec.id}`, SK: '#META',
      id: rec.id, test_project_id: rec.test_project_id, script_id: rec.script_id,
      kind: rec.kind, description: rec.description, status: rec.status, error: rec.error,
      result_script_ids: rec.result_script_ids, warnings: rec.warnings,
      created_by: rec.created_by, created_at: rec.created_at, finished_at: rec.finished_at,
      progress: rec.progress, started_at: rec.started_at, cancelled_at: rec.cancelled_at,
      testTestProjectId: rec.test_project_id, testListSK: listSK('TGN', rec.created_at, rec.id),
    });
    return rec;
  }

  async getGenerationById(id: string): Promise<TestGenerationRecord | null> {
    return this.getItem(`TGN#${id}`, '#META', itemToGeneration);
  }

  async getGenerationByTestProjectAndId(testProjectId: string, id: string): Promise<TestGenerationRecord | null> {
    const rec = await this.getGenerationById(id);
    return rec?.test_project_id === testProjectId ? rec : null;
  }

  async listGenerationsByTestProject(testProjectId: string, limit: number, _offset: number): Promise<TestGenerationRecord[]> {
    const items = await this.queryByGsi('GSI-TestByTestProject', 'testTestProjectId', testProjectId, 'TGN#', itemToGeneration);
    return items.slice(0, limit);
  }

  async updateGeneration(id: string, fields: Partial<TestGenerationRecord>): Promise<void> {
    await genericUpdate(this.client, this.tableName, `TGN#${id}`, '#META', fields as Record<string, unknown>);
  }

  // trace_steps
  async createTraceStep(rec: TraceStepRecord): Promise<TraceStepRecord> {
    const pk = rec.case_set_id ? `TRACE_CS#${rec.case_set_id}` : `TRACE_GN#${rec.generation_id}`;
    const sk = String(rec.seq).padStart(8, '0');
    await this.put({
      PK: pk, SK: sk,
      id: rec.id, case_set_id: rec.case_set_id, generation_id: rec.generation_id,
      seq: rec.seq, kind: rec.kind, label: rec.label, status: rec.status,
      started_at: rec.started_at, finished_at: rec.finished_at, duration_ms: rec.duration_ms,
      detail: rec.detail, prompt: rec.prompt, output: rec.output,
      output_truncated: rec.output_truncated, error: rec.error,
    });
    return rec;
  }

  async updateTraceStep(id: string, _fields: Partial<TraceStepRecord>): Promise<void> {
    // Backlog: need caseSetId/generationId+seq to construct PK/SK for trace updates.
    // For DynamoDB, trace updates require the PK (case_set_id or generation_id) and SK (seq).
    // This is tracked in the backlog.
  }

  async listTraceByCaseSet(caseSetId: string): Promise<TraceStepRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: marshalItem({ ':pk': `TRACE_CS#${caseSetId}` }),
      ScanIndexForward: true,
    }));
    return (resp.Items ?? []).map(itemToTrace);
  }

  async listTraceByGeneration(generationId: string): Promise<TraceStepRecord[]> {
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: marshalItem({ ':pk': `TRACE_GN#${generationId}` }),
      ScanIndexForward: true,
    }));
    return (resp.Items ?? []).map(itemToTrace);
  }

  async getMaxTraceSeqByCaseSet(caseSetId: string): Promise<number> {
    const resp = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: marshalItem({ ':pk': `TRACE_CS#${caseSetId}` }),
      ScanIndexForward: false,
      Limit: 1,
    }));
    const item = resp.Items?.[0];
    return item ? getNumber(item, 'seq') : 0;
  }
}
