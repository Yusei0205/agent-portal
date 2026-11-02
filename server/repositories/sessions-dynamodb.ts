/**
 * DynamoDB implementation of SessionsRepository.
 *
 * Tables used:
 *   portal-runs   — workflows, runs, inputs, workflow-events
 *   portal-events — run events (isolated for write throughput)
 *
 * Key design (portal-runs):
 *   PK                       | SK                               | Entity
 *   WF#<workflowId>          | #META                            | p6_workflows
 *   WF#<workflowId>          | RUN#<isoCreatedAt>#<runId>        | p6_runs
 *   WF#<workflowId>          | WFEVT#<isoCreatedAt>#<id>         | p6_workflow_events
 *   RUN#<runId>              | INPUT#<inputId>                   | p6_inputs
 *   RUN#<runId>              | #SEQ                              | atomic event counter
 *
 * Key design (portal-events):
 *   PK           | SK                         | Entity
 *   RUN#<runId>  | SEQ#<10-digit-zero-padded> | p6_events
 *
 * GSIs on portal-runs:
 *   GSI-ProjectWorkflows: PK=projectId, SK=WF#<isoUpdatedAt>#<workflowId>
 *   GSI-WorkflowStatus:   PK=projectId, SK=STATUS#<status>#<isoUpdatedAt>
 *   GSI-RunId:            PK=runId → resolves run without knowing workflowId
 *   GSI-InputHash:        PK=inputHash → resolves input by hash (F13)
 *
 * Oversized-payload strategy:
 *   If payload JSON exceeds 380 000 bytes it is truncated to 380 000 bytes
 *   and `\n[PAYLOAD TRUNCATED — original size: N bytes]` is appended.
 *   This ensures every item stays within the DynamoDB 400 KB limit.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import type {
  SessionsRepository,
  WorkflowRecord,
  RunRecord,
  EventRecord,
  AppendedEvent,
  InputRecord,
  WorkflowEventRecord,
  CreateWorkflowInput,
  CreateRunInput,
  CreateInputInput,
  CreateWorkflowEventInput,
  ListWorkflowsOpts,
  RunTotals,
} from './sessions.ts';

// ── Table names ────────────────────────────────────────────────────────────────

function runsTable(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_RUNS ?? 'portal-runs-test';
}

function eventsTable(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_EVENTS ?? 'portal-events-test';
}

// ── Zero-padded sequence key ───────────────────────────────────────────────────

function padSeq(n: number): string {
  return String(n).padStart(10, '0');
}

function seqSk(n: number): string {
  return `SEQ#${padSeq(n)}`;
}

function seqFromSk(sk: string): number {
  return parseInt(sk.replace('SEQ#', ''), 10);
}

// ── Payload truncation ─────────────────────────────────────────────────────────

const MAX_PAYLOAD_BYTES = 380_000;

function truncatePayload(payload: string): string {
  if (payload.length <= MAX_PAYLOAD_BYTES) return payload;
  const marker = `\n[PAYLOAD TRUNCATED — original size: ${payload.length} bytes]`;
  return payload.slice(0, MAX_PAYLOAD_BYTES - marker.length) + marker;
}

// ── Attribute converters ───────────────────────────────────────────────────────

function itemToWorkflow(item: Record<string, AttributeValue>): WorkflowRecord {
  return {
    id: getString(item, 'id') ?? '',
    project_id: getString(item, 'project_id'),
    title: getString(item, 'title') ?? '',
    goal: getString(item, 'goal') ?? '',
    status: getString(item, 'status') ?? '',
    stop_reason: getString(item, 'stop_reason') ?? '',
    engine: getString(item, 'engine') ?? '',
    trust_tools: getNumber(item, 'trust_tools'),
    lead_agent: getString(item, 'lead_agent'),
    workspace_id: getString(item, 'workspace_id'),
    output_files_enabled: getNumber(item, 'output_files_enabled'),
    repo_ids: getString(item, 'repo_ids') ?? '[]',
    iteration_count: getNumber(item, 'iteration_count'),
    max_iterations: getNumber(item, 'max_iterations') || 10,
    last_turn_at: getString(item, 'last_turn_at'),
    credential_id: getString(item, 'credential_id'),
    model: getString(item, 'model') ?? '',
    engine_session_id: getString(item, 'engine_session_id'),
    engine_session_engine: getString(item, 'engine_session_engine'),
    created_by: getString(item, 'created_by'),
    created_at: getString(item, 'created_at') ?? '',
    updated_at: getString(item, 'updated_at') ?? '',
    parent_id: getString(item, 'parent_id'),
    work_dir: getString(item, 'work_dir'),
    jira_key: getString(item, 'jira_key') ?? '',
    jira_summary: getString(item, 'jira_summary') ?? '',
    jira_url: getString(item, 'jira_url') ?? '',
    kind: getString(item, 'kind'),
    run_timeout_minutes: item['run_timeout_minutes'] ? getNumber(item, 'run_timeout_minutes') : null,
    child_count: getNumber(item, 'childCount'),
    parent_title: getString(item, 'parentTitle'),
  };
}

function itemToRun(item: Record<string, AttributeValue>): RunRecord {
  return {
    id: getString(item, 'runId') ?? getString(item, 'id') ?? '',
    workflow_id: getString(item, 'workflow_id') ?? '',
    status: getString(item, 'status') ?? '',
    started_at: getString(item, 'started_at'),
    finished_at: getString(item, 'finished_at'),
    cost_usd: getNumber(item, 'cost_usd'),
    input_tokens: getNumber(item, 'input_tokens'),
    output_tokens: getNumber(item, 'output_tokens'),
    cache_write_tokens: getNumber(item, 'cache_write_tokens'),
    cache_read_tokens: getNumber(item, 'cache_read_tokens'),
    created_at: getString(item, 'created_at') ?? '',
    stop_reason: getString(item, 'stop_reason'),
    time_limit_at: getString(item, 'time_limit_at'),
    model: getString(item, 'model'),
    error: getString(item, 'error'),
  };
}

function itemToEvent(item: Record<string, AttributeValue>, runId: string): EventRecord {
  const sk = getString(item, 'SK') ?? '';
  const seq = seqFromSk(sk);
  return {
    id: seq,
    run_id: runId,
    type: getString(item, 'type') ?? '',
    payload: getString(item, 'payload') ?? '',
    created_at: getString(item, 'created_at') ?? '',
  };
}

function itemToInput(item: Record<string, AttributeValue>): InputRecord {
  return {
    id: getString(item, 'id') ?? '',
    run_id: getString(item, 'run_id') ?? '',
    project_id: getString(item, 'project_id'),
    tool_name: getString(item, 'tool_name'),
    tool_input: getString(item, 'tool_input'),
    payload: getString(item, 'payload') ?? '',
    input_hash: getString(item, 'input_hash'),
    type: getString(item, 'type') ?? 'approval',
    status: getString(item, 'status') ?? 'pending',
    allow_all: getNumber(item, 'allow_all'),
    response: getString(item, 'response'),
    answered_by: getString(item, 'answered_by'),
    answered_at: getString(item, 'answered_at'),
    expires_at: getString(item, 'expires_at'),
    created_at: getString(item, 'created_at') ?? '',
  };
}

function itemToWorkflowEvent(item: Record<string, AttributeValue>): WorkflowEventRecord {
  const id = getNumber(item, 'evtId') || getNumber(item, 'id');
  return {
    id,
    workflow_id: getString(item, 'workflow_id') ?? '',
    kind: getString(item, 'kind') ?? '',
    body: getString(item, 'body') ?? '',
    data: getString(item, 'data'),
    created_at: getString(item, 'created_at') ?? '',
    consumed: getNumber(item, 'consumed'),
  };
}

// ── Auto-increment simulation for workflow events ──────────────────────────────
// DynamoDB doesn't provide auto-increment. We use a counter item for workflow-events.
// PK=WF#<workflowId>, SK=#WFSEQ → attribute `seq`

async function nextWorkflowEventId(client: DynamoDBClient, workflowId: string): Promise<number> {
  const res = await client.send(new UpdateItemCommand({
    TableName: runsTable(),
    Key: marshalItem({ PK: `WF#${workflowId}`, SK: '#WFSEQ' }),
    UpdateExpression: 'ADD #seq :one',
    ExpressionAttributeNames: { '#seq': 'seq' },
    ExpressionAttributeValues: { ':one': { N: '1' } },
    ReturnValues: 'UPDATED_NEW',
  }));
  return getNumber(res.Attributes ?? {}, 'seq');
}

// ── Paginate a DynamoDB Query ──────────────────────────────────────────────────

async function paginateQuery(
  client: DynamoDBClient,
  params: ConstructorParameters<typeof QueryCommand>[0],
  maxItems?: number,
): Promise<Array<Record<string, AttributeValue>>> {
  const items: Array<Record<string, AttributeValue>> = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await client.send(new QueryCommand({
      ...params,
      ExclusiveStartKey: lastKey,
    }));
    if (res.Items) items.push(...res.Items);
    lastKey = res.LastEvaluatedKey;
    if (maxItems != null && items.length >= maxItems) break;
  } while (lastKey);
  return items;
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbSessionsRepository implements SessionsRepository {
  private readonly client: DynamoDBClient;

  constructor() {
    this.client = getDynamoDbClient();
  }

  // ── Table setup (called on first use in tests) ──────────────────────────────

  async ensureTables(): Promise<void> {
    const { CreateTableCommand, DescribeTableCommand, ResourceNotFoundException } =
      await import('@aws-sdk/client-dynamodb');
    for (const [tableName, extraGsi] of [
      [runsTable(), true],
      [eventsTable(), false],
    ] as [string, boolean][]) {
      try {
        await this.client.send(new DescribeTableCommand({ TableName: tableName }));
      } catch (e: unknown) {
        const name = (e as { name?: string }).name ?? '';
        if (name !== 'ResourceNotFoundException') throw e;
        const gsiDefs = extraGsi ? [
          {
            IndexName: 'GSI-ProjectWorkflows',
            KeySchema: [
              { AttributeName: 'projectId', KeyType: 'HASH' },
              { AttributeName: 'wfGsiSk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
            BillingMode: 'PAY_PER_REQUEST',
          },
          {
            IndexName: 'GSI-WorkflowStatus',
            KeySchema: [
              { AttributeName: 'projectId', KeyType: 'HASH' },
              { AttributeName: 'statusGsiSk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
            BillingMode: 'PAY_PER_REQUEST',
          },
          {
            IndexName: 'GSI-RunId',
            KeySchema: [
              { AttributeName: 'runId', KeyType: 'HASH' },
            ],
            Projection: { ProjectionType: 'ALL' },
            BillingMode: 'PAY_PER_REQUEST',
          },
          {
            IndexName: 'GSI-InputHash',
            KeySchema: [
              { AttributeName: 'inputHash', KeyType: 'HASH' },
              { AttributeName: 'run_id', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
            BillingMode: 'PAY_PER_REQUEST',
          },
        ] : [];
        await this.client.send(new CreateTableCommand({
          TableName: tableName,
          BillingMode: 'PAY_PER_REQUEST',
          KeySchema: [
            { AttributeName: 'PK', KeyType: 'HASH' },
            { AttributeName: 'SK', KeyType: 'RANGE' },
          ],
          AttributeDefinitions: extraGsi ? [
            { AttributeName: 'PK', AttributeType: 'S' },
            { AttributeName: 'SK', AttributeType: 'S' },
            { AttributeName: 'projectId', AttributeType: 'S' },
            { AttributeName: 'wfGsiSk', AttributeType: 'S' },
            { AttributeName: 'statusGsiSk', AttributeType: 'S' },
            { AttributeName: 'runId', AttributeType: 'S' },
            { AttributeName: 'inputHash', AttributeType: 'S' },
            { AttributeName: 'run_id', AttributeType: 'S' },
          ] : [
            { AttributeName: 'PK', AttributeType: 'S' },
            { AttributeName: 'SK', AttributeType: 'S' },
          ],
          GlobalSecondaryIndexes: gsiDefs.length > 0 ? gsiDefs : undefined,
        }));
        // Wait for table to become active
        let active = false;
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const desc = await this.client.send(new DescribeTableCommand({ TableName: tableName }));
          if (desc.Table?.TableStatus === 'ACTIVE') { active = true; break; }
        }
        if (!active) throw new Error(`Table ${tableName} did not become ACTIVE in time`);
      }
    }
  }

  // ── Workflows ───────────────────────────────────────────────────────────────

  async getWorkflowById(id: string): Promise<WorkflowRecord | null> {
    const res = await this.client.send(new GetItemCommand({
      TableName: runsTable(),
      Key: marshalItem({ PK: `WF#${id}`, SK: '#META' }),
    }));
    if (!res.Item) return null;
    return itemToWorkflow(res.Item);
  }

  async getWorkflowByProjectId(projectId: string, workflowId: string): Promise<WorkflowRecord | null> {
    const wf = await this.getWorkflowById(workflowId);
    if (!wf) return null;
    if (wf.project_id !== projectId) return null;
    return wf;
  }

  async listWorkflowsByProject(
    projectId: string,
    opts: ListWorkflowsOpts = {},
  ): Promise<{ workflows: WorkflowRecord[]; total: number; cursor?: string }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    if (opts.cursor) {
      try { exclusiveStartKey = JSON.parse(opts.cursor); } catch { /* ignore */ }
    }

    const res = await this.client.send(new QueryCommand({
      TableName: runsTable(),
      IndexName: 'GSI-ProjectWorkflows',
      KeyConditionExpression: 'projectId = :pid AND begins_with(wfGsiSk, :prefix)',
      ExpressionAttributeValues: {
        ':pid': av(projectId),
        ':prefix': av('WF#'),
      },
      ScanIndexForward: false,
      Limit: limit * 3, // over-fetch to allow application-side filtering
      ExclusiveStartKey: exclusiveStartKey,
    }));

    let items = (res.Items ?? []).map((item) => itemToWorkflow(item));

    // Application-side filtering
    if (opts.status) items = items.filter((w) => w.status === opts.status);
    if (opts.engine) items = items.filter((w) => w.engine === opts.engine);
    if (opts.search) {
      const lc = opts.search.toLowerCase();
      items = items.filter((w) => w.goal.toLowerCase().includes(lc));
    }

    const page = items.slice(0, limit);

    // Cursor: use DynamoDB's LastEvaluatedKey if available, otherwise
    // generate one from the last item in the page if more items exist
    let cursor: string | undefined;
    if (res.LastEvaluatedKey) {
      cursor = JSON.stringify(res.LastEvaluatedKey);
    } else if (items.length > limit) {
      // We have more items than the page size — build cursor from last page item
      const lastItem = page[page.length - 1];
      if (lastItem) {
        const wfGsiSk = `WF#${lastItem.updated_at}#${lastItem.id}`;
        cursor = JSON.stringify({
          PK: { S: `WF#${lastItem.id}` },
          SK: { S: '#META' },
          projectId: { S: projectId },
          wfGsiSk: { S: wfGsiSk },
        });
      }
    }

    const total = page.length + (cursor ? 1 : 0);

    return { workflows: page, total, cursor };
  }

  async listRunningWorkflows(): Promise<WorkflowRecord[]> {
    // S1-TODO(sessions): This requires scanning or querying GSI-WorkflowStatus across
    // all projectIds, which is not efficient without maintaining a global index.
    // For now, return empty in DynamoDB mode — callers that need this for shutdown
    // (driver.ts abortAllRuns) work off the in-memory controls map, not this query.
    return [];
  }

  async listIdleWorkflows(cutoff: string): Promise<WorkflowRecord[]> {
    // S1-TODO(sessions): Idle detection requires querying workflows by last_turn_at
    // across projects. In DynamoDB mode this is deferred — the idle-stop timer
    // checks are currently a best-effort feature and work correctly in SQLite mode.
    return [];
  }

  async listChildWorkflows(parentId: string): Promise<WorkflowRecord[]> {
    // S1-TODO(sessions): Requires a GSI on parentId. For now, we can't efficiently
    // list children without a scan. Return empty; callers handle null gracefully.
    return [];
  }

  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRecord> {
    const wfGsiSk = `WF#${input.updated_at}#${input.id}`;
    const statusGsiSk = `STATUS#${input.status}#${input.updated_at}`;

    const item: Record<string, AttributeValue> = {
      PK: av(`WF#${input.id}`),
      SK: av('#META'),
      id: av(input.id),
      ...marshalItem({
        project_id: input.project_id,
        title: input.title ?? '',
        goal: input.goal,
        status: input.status,
        stop_reason: input.stop_reason ?? '',
        engine: input.engine,
        trust_tools: input.trust_tools,
        lead_agent: input.lead_agent,
        workspace_id: input.workspace_id,
        output_files_enabled: input.output_files_enabled,
        repo_ids: input.repo_ids,
        iteration_count: input.iteration_count,
        max_iterations: input.max_iterations,
        credential_id: input.credential_id,
        model: input.model,
        jira_key: input.jira_key ?? '',
        jira_summary: input.jira_summary ?? '',
        jira_url: input.jira_url ?? '',
        created_by: input.created_by,
        created_at: input.created_at,
        updated_at: input.updated_at,
        parent_id: input.parent_id ?? null,
        wfGsiSk,     // GSI sort key for GSI-ProjectWorkflows
        statusGsiSk, // GSI sort key for GSI-WorkflowStatus
      }),
      childCount: { N: '0' },
    };

    // Only include GSI PK attributes when they have a value (DynamoDB rejects NULL for key attributes)
    if (input.project_id) {
      item['projectId'] = av(input.project_id);
    }

    await this.client.send(new PutItemCommand({
      TableName: runsTable(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));

    return itemToWorkflow(item);
  }

  async updateWorkflow(id: string, patch: Partial<WorkflowRecord>): Promise<void> {
    const allowed: (keyof WorkflowRecord)[] = [
      'title', 'goal', 'status', 'stop_reason', 'engine', 'trust_tools',
      'lead_agent', 'workspace_id', 'output_files_enabled', 'repo_ids',
      'iteration_count', 'max_iterations', 'last_turn_at', 'credential_id',
      'model', 'engine_session_id', 'engine_session_engine', 'updated_at',
      'parent_id', 'work_dir', 'jira_key', 'jira_summary', 'jira_url',
      'kind', 'run_timeout_minutes',
    ];
    const setExprs: string[] = [];
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};

    let i = 0;
    for (const k of allowed) {
      if (k in patch && patch[k] !== undefined) {
        const nameKey = `#a${i}`;
        const valKey = `:v${i}`;
        names[nameKey] = k;
        vals[valKey] = av(patch[k] as string | number | null);
        setExprs.push(`${nameKey} = ${valKey}`);
        i++;
      }
    }

    // Keep GSI sort keys in sync when status or updated_at changes
    if ('status' in patch || 'updated_at' in patch) {
      // We need both values to build the GSI SK — fetch the item to get what's missing
      const current = await this.getWorkflowById(id);
      if (current) {
        const updatedAt = (patch.updated_at as string | undefined) ?? current.updated_at;
        const status = (patch.status as string | undefined) ?? current.status;
        names['#wfGsiSk'] = 'wfGsiSk';
        vals[':wfGsiSk'] = av(`WF#${updatedAt}#${id}`);
        setExprs.push('#wfGsiSk = :wfGsiSk');
        names['#statusGsiSk'] = 'statusGsiSk';
        vals[':statusGsiSk'] = av(`STATUS#${status}#${updatedAt}`);
        setExprs.push('#statusGsiSk = :statusGsiSk');
      }
    }

    if (setExprs.length === 0) return;

    await this.client.send(new UpdateItemCommand({
      TableName: runsTable(),
      Key: marshalItem({ PK: `WF#${id}`, SK: '#META' }),
      UpdateExpression: `SET ${setExprs.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: vals,
      ConditionExpression: 'attribute_exists(PK)',
    }));
  }

  async deleteWorkflow(id: string): Promise<void> {
    // Delete main META item — cascade to RUN# items is S1-TODO (DynamoDB has no cascade)
    // For now delete the workflow META and its WFEVT children
    const items = await paginateQuery(this.client, {
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': av(`WF#${id}`) },
    });
    // BatchWrite in chunks of 25
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      await this.client.send(new BatchWriteItemCommand({
        RequestItems: {
          [runsTable()]: batch.map((item) => ({
            DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
          })),
        },
      }));
    }
  }

  async incrementWorkflowIteration(id: string): Promise<void> {
    await this.client.send(new UpdateItemCommand({
      TableName: runsTable(),
      Key: marshalItem({ PK: `WF#${id}`, SK: '#META' }),
      UpdateExpression: 'ADD #it :one',
      ExpressionAttributeNames: { '#it': 'iteration_count' },
      ExpressionAttributeValues: { ':one': { N: '1' } },
    }));
  }

  async incrementWorkflowChildCount(parentId: string, delta: 1 | -1): Promise<void> {
    await this.client.send(new UpdateItemCommand({
      TableName: runsTable(),
      Key: marshalItem({ PK: `WF#${parentId}`, SK: '#META' }),
      UpdateExpression: 'ADD childCount :delta',
      ExpressionAttributeNames: {},
      ExpressionAttributeValues: { ':delta': { N: String(delta) } },
    }));
  }

  // ── Runs ────────────────────────────────────────────────────────────────────

  async getRunById(id: string): Promise<RunRecord | null> {
    // Use GSI-RunId to find run without knowing workflowId
    const res = await this.client.send(new QueryCommand({
      TableName: runsTable(),
      IndexName: 'GSI-RunId',
      KeyConditionExpression: 'runId = :rid',
      ExpressionAttributeValues: { ':rid': av(id) },
      Limit: 1,
    }));
    if (!res.Items || res.Items.length === 0) return null;
    return itemToRun(res.Items[0]);
  }

  async getRunByWorkflowAndId(workflowId: string, runId: string): Promise<RunRecord | null> {
    const run = await this.getRunById(runId);
    if (!run) return null;
    if (run.workflow_id !== workflowId) return null;
    return run;
  }

  async getLatestRun(workflowId: string): Promise<RunRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': av(`WF#${workflowId}`),
        ':prefix': av('RUN#'),
      },
      ScanIndexForward: false,
      Limit: 1,
    }));
    if (!res.Items || res.Items.length === 0) return null;
    return itemToRun(res.Items[0]);
  }

  async getActiveRun(workflowId: string): Promise<RunRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#status IN (:pending, :running)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':pk': av(`WF#${workflowId}`),
        ':prefix': av('RUN#'),
        ':pending': av('pending'),
        ':running': av('running'),
      },
      ScanIndexForward: false,
      Limit: 20, // check recent runs; active run should be among them
    }));
    if (!res.Items || res.Items.length === 0) return null;
    return itemToRun(res.Items[0]);
  }

  async listRunsByWorkflow(workflowId: string, limit = 100): Promise<RunRecord[]> {
    const items = await paginateQuery(this.client, {
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': av(`WF#${workflowId}`),
        ':prefix': av('RUN#'),
      },
      ScanIndexForward: false,
      Limit: limit,
    }, limit);
    return items.map((item) => itemToRun(item));
  }

  async getRunTotals(workflowId: string): Promise<RunTotals> {
    const runs = await this.listRunsByWorkflow(workflowId, 1000);
    let total_cost = 0;
    let total_input = 0;
    let total_output = 0;
    for (const r of runs) {
      total_cost += r.cost_usd;
      total_input += r.input_tokens;
      total_output += r.output_tokens;
    }
    return { total_cost, total_input, total_output };
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const sk = `RUN#${input.created_at}#${input.id}`;
    const item: Record<string, AttributeValue> = {
      PK: av(`WF#${input.workflow_id}`),
      SK: av(sk),
      runId: av(input.id), // GSI-RunId PK
      ...marshalItem({
        id: input.id,
        workflow_id: input.workflow_id,
        status: input.status,
        started_at: input.started_at,
        finished_at: input.finished_at,
        cost_usd: input.cost_usd,
        input_tokens: input.input_tokens,
        output_tokens: input.output_tokens,
        created_at: input.created_at,
      }),
    };
    await this.client.send(new PutItemCommand({
      TableName: runsTable(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return {
      id: input.id,
      workflow_id: input.workflow_id,
      status: input.status,
      started_at: input.started_at,
      finished_at: input.finished_at,
      cost_usd: input.cost_usd,
      input_tokens: input.input_tokens,
      output_tokens: input.output_tokens,
      cache_write_tokens: 0,
      cache_read_tokens: 0,
      created_at: input.created_at,
      stop_reason: null,
      time_limit_at: null,
      model: null,
      error: null,
    };
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> {
    // Find the run's partition key (WF#<workflowId>) via GSI-RunId
    const run = await this.getRunById(id);
    if (!run) return; // run gone (test cleanup)

    const allowed: (keyof RunRecord)[] = [
      'status', 'started_at', 'finished_at', 'cost_usd', 'input_tokens',
      'output_tokens', 'cache_write_tokens', 'cache_read_tokens',
      'stop_reason', 'time_limit_at', 'model', 'error',
    ];
    const setExprs: string[] = [];
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};
    let i = 0;
    for (const k of allowed) {
      if (k in patch && patch[k] !== undefined) {
        const nk = `#a${i}`;
        const vk = `:v${i}`;
        names[nk] = k;
        vals[vk] = av(patch[k] as string | number | null);
        setExprs.push(`${nk} = ${vk}`);
        i++;
      }
    }
    if (setExprs.length === 0) return;

    const runSk = `RUN#${run.created_at}#${id}`;
    await this.client.send(new UpdateItemCommand({
      TableName: runsTable(),
      Key: marshalItem({ PK: `WF#${run.workflow_id}`, SK: runSk }),
      UpdateExpression: `SET ${setExprs.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: vals,
    }));
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  async appendRunEvent(runId: string, type: string, payload: string, createdAt: string): Promise<AppendedEvent> {
    const safePayload = truncatePayload(payload);

    // Atomically increment the sequence counter
    const res = await this.client.send(new UpdateItemCommand({
      TableName: runsTable(),
      Key: marshalItem({ PK: `RUN#${runId}`, SK: '#SEQ' }),
      UpdateExpression: 'ADD #seq :one',
      ExpressionAttributeNames: { '#seq': 'seq' },
      ExpressionAttributeValues: { ':one': { N: '1' } },
      ReturnValues: 'UPDATED_NEW',
    }));
    const seq = getNumber(res.Attributes ?? {}, 'seq');

    await this.client.send(new PutItemCommand({
      TableName: eventsTable(),
      Item: {
        PK: av(`RUN#${runId}`),
        SK: av(seqSk(seq)),
        ...marshalItem({ type, payload: safePayload, created_at: createdAt }),
      },
    }));

    return { id: seq, created_at: createdAt };
  }

  async listRunEventsFrom(runId: string, fromId: number, limit = 100): Promise<EventRecord[]> {
    const res = await this.client.send(new QueryCommand({
      TableName: eventsTable(),
      KeyConditionExpression: 'PK = :pk AND SK > :from',
      ExpressionAttributeValues: {
        ':pk': av(`RUN#${runId}`),
        ':from': av(seqSk(fromId)),
      },
      ScanIndexForward: true,
      Limit: limit,
    }));
    return (res.Items ?? []).map((item) => itemToEvent(item, runId));
  }

  async listRunEvents(runId: string, limit = 5000): Promise<EventRecord[]> {
    const items = await paginateQuery(this.client, {
      TableName: eventsTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': av(`RUN#${runId}`),
        ':prefix': av('SEQ#'),
      },
      ScanIndexForward: true,
    }, limit);
    return items.map((item) => itemToEvent(item, runId));
  }

  async listRunEventsBefore(runId: string, beforeId: number, limit = 100): Promise<EventRecord[]> {
    const res = await this.client.send(new QueryCommand({
      TableName: eventsTable(),
      KeyConditionExpression: 'PK = :pk AND SK < :before',
      ExpressionAttributeValues: {
        ':pk': av(`RUN#${runId}`),
        ':before': av(seqSk(beforeId)),
      },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return (res.Items ?? []).map((item) => itemToEvent(item, runId));
  }

  async listWorkflowRunEventsByType(
    workflowId: string,
    types: string[],
    limit = 200,
  ): Promise<EventRecord[]> {
    if (types.length === 0) return [];
    const runs = await this.listRunsByWorkflow(workflowId, 20);
    const typeSet = new Set(types);
    const results: EventRecord[] = [];
    for (const run of runs) {
      if (results.length >= limit) break;
      const events = await this.listRunEvents(run.id, limit);
      results.push(...events.filter((e) => typeSet.has(e.type)));
    }
    // Sort descending (newest first) to match the SQLite query order
    results.sort((a, b) => b.id - a.id);
    return results.slice(0, limit);
  }

  async listRunCompletionEvents(
    workflowId: string,
    excludeRunId: string,
    afterDate?: string | null,
  ): Promise<Array<{ payload: string; created_at: string }>> {
    const runs = await this.listRunsByWorkflow(workflowId, 100);
    const result: Array<{ payload: string; created_at: string }> = [];
    for (const run of runs) {
      if (run.id === excludeRunId) continue;
      const events = await this.listRunEvents(run.id);
      for (const e of events) {
        if (e.type !== 'run-complete') continue;
        if (afterDate && e.created_at <= afterDate) continue;
        result.push({ payload: e.payload, created_at: e.created_at });
      }
    }
    result.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return result;
  }

  // ── Inputs ──────────────────────────────────────────────────────────────────

  async createInput(input: CreateInputInput): Promise<InputRecord> {
    const item: Record<string, AttributeValue> = {
      PK: av(`RUN#${input.run_id}`),
      SK: av(`INPUT#${input.id}`),
      ...marshalItem({
        id: input.id,
        run_id: input.run_id,
        project_id: input.project_id,
        tool_name: input.tool_name,
        tool_input: input.tool_input,
        payload: truncatePayload(input.payload),
        input_hash: input.input_hash,
        inputHash: input.input_hash, // GSI-InputHash PK
        type: input.type,
        status: input.status,
        allow_all: input.allow_all,
        expires_at: input.expires_at,
        created_at: input.created_at,
      }),
    };
    await this.client.send(new PutItemCommand({
      TableName: runsTable(),
      Item: item,
    }));
    return {
      id: input.id,
      run_id: input.run_id,
      project_id: input.project_id,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      payload: input.payload,
      input_hash: input.input_hash,
      type: input.type,
      status: input.status,
      allow_all: input.allow_all,
      response: null,
      answered_by: null,
      answered_at: null,
      expires_at: input.expires_at,
      created_at: input.created_at,
    };
  }

  async getInputById(id: string): Promise<InputRecord | null> {
    // S1-TODO(sessions): Without knowing run_id we can't do a direct GetItem.
    // Callers in runs.ts pass only the inputId; they need a GSI on 'id'.
    // For now, the runs.ts input route (`GET /api/inputs/:id`) is left on SQLite
    // (marked S1-TODO in that file). This method is only called from converter paths
    // that also provide run_id via getInputByRunAndId.
    return null;
  }

  async getInputByHash(inputHash: string, runId: string): Promise<InputRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: runsTable(),
      IndexName: 'GSI-InputHash',
      KeyConditionExpression: 'inputHash = :hash AND run_id = :rid',
      ExpressionAttributeValues: {
        ':hash': av(inputHash),
        ':rid': av(runId),
      },
      Limit: 1,
    }));
    if (!res.Items || res.Items.length === 0) return null;
    return itemToInput(res.Items[0]);
  }

  async getPendingInput(runId: string): Promise<InputRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':pk': av(`RUN#${runId}`),
        ':prefix': av('INPUT#'),
        ':pending': av('pending'),
      },
      Limit: 1,
    }));
    if (!res.Items || res.Items.length === 0) return null;
    return itemToInput(res.Items[0]);
  }

  async listInputsByRun(runId: string): Promise<InputRecord[]> {
    const items = await paginateQuery(this.client, {
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': av(`RUN#${runId}`),
        ':prefix': av('INPUT#'),
      },
    });
    return items.map((item) => itemToInput(item));
  }

  async updateInputConditional(
    id: string,
    expectedStatus: string,
    patch: Partial<InputRecord>,
  ): Promise<boolean> {
    const allowed: (keyof InputRecord)[] = [
      'status', 'response', 'allow_all', 'answered_by', 'answered_at',
    ];
    const setExprs: string[] = [];
    const names: Record<string, string> = { '#s': 'status' };
    const vals: Record<string, AttributeValue> = { ':expected': av(expectedStatus) };
    let i = 0;
    for (const k of allowed) {
      if (k in patch && patch[k] !== undefined) {
        const nk = `#b${i}`;
        const vk = `:w${i}`;
        names[nk] = k;
        vals[vk] = av(patch[k] as string | number | null);
        setExprs.push(`${nk} = ${vk}`);
        i++;
      }
    }
    if (setExprs.length === 0) return false;

    // We need to know the run_id to build the PK
    const run_id = (patch as Record<string, unknown>)['run_id'] as string | undefined;
    if (!run_id) {
      // Without run_id, fall back to querying (should not normally happen)
      return false;
    }

    try {
      await this.client.send(new UpdateItemCommand({
        TableName: runsTable(),
        Key: marshalItem({ PK: `RUN#${run_id}`, SK: `INPUT#${id}` }),
        UpdateExpression: `SET ${setExprs.join(', ')}`,
        ConditionExpression: '#s = :expected',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: vals,
      }));
      return true;
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  async updateInput(id: string, patch: Partial<InputRecord>): Promise<void> {
    const run_id = (patch as Record<string, unknown>)['run_id'] as string | undefined;
    if (!run_id) return; // defensive

    const allowed: (keyof InputRecord)[] = [
      'status', 'response', 'allow_all', 'answered_by', 'answered_at',
    ];
    const setExprs: string[] = [];
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};
    let i = 0;
    for (const k of allowed) {
      if (k in patch && patch[k] !== undefined) {
        const nk = `#c${i}`;
        const vk = `:x${i}`;
        names[nk] = k;
        vals[vk] = av(patch[k] as string | number | null);
        setExprs.push(`${nk} = ${vk}`);
        i++;
      }
    }
    if (setExprs.length === 0) return;

    await this.client.send(new UpdateItemCommand({
      TableName: runsTable(),
      Key: marshalItem({ PK: `RUN#${run_id}`, SK: `INPUT#${id}` }),
      UpdateExpression: `SET ${setExprs.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: vals,
    }));
  }

  // ── Workflow events ──────────────────────────────────────────────────────────

  async appendWorkflowEvent(input: CreateWorkflowEventInput): Promise<void> {
    const evtId = await nextWorkflowEventId(this.client, input.workflow_id);
    const sk = `WFEVT#${input.created_at}#${String(evtId).padStart(10, '0')}`;
    await this.client.send(new PutItemCommand({
      TableName: runsTable(),
      Item: {
        PK: av(`WF#${input.workflow_id}`),
        SK: av(sk),
        ...marshalItem({
          workflow_id: input.workflow_id,
          kind: input.kind,
          body: input.body,
          data: input.data,
          created_at: input.created_at,
          evtId,
        }),
        consumed: { N: '0' },
      },
    }));
  }

  async listUnconsumedWorkflowEvents(workflowId: string): Promise<WorkflowEventRecord[]> {
    const items = await paginateQuery(this.client, {
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#c = :zero AND #k IN (:human, :command, :child)',
      ExpressionAttributeNames: { '#k': 'kind', '#c': 'consumed' },
      ExpressionAttributeValues: {
        ':pk': av(`WF#${workflowId}`),
        ':prefix': av('WFEVT#'),
        ':zero': { N: '0' },
        ':human': av('human'),
        ':command': av('command'),
        ':child': av('child-result'),
      },
      ScanIndexForward: true,
    });
    return items.map((item) => itemToWorkflowEvent(item));
  }

  async markWorkflowEventsConsumedUpTo(workflowId: string, maxId: number): Promise<void> {
    const events = await this.listUnconsumedWorkflowEvents(workflowId);
    const toMark = events.filter((e) => e.id <= maxId);
    for (const e of toMark) {
      const sk = `WFEVT#${e.created_at}#${String(e.id).padStart(10, '0')}`;
      await this.client.send(new UpdateItemCommand({
        TableName: runsTable(),
        Key: marshalItem({ PK: `WF#${workflowId}`, SK: sk }),
        UpdateExpression: 'SET #c = :one',
        ExpressionAttributeNames: { '#c': 'consumed' },
        ExpressionAttributeValues: { ':one': { N: '1' } },
      }));
    }
  }

  async markAllWorkflowEventsConsumed(workflowId: string): Promise<void> {
    const events = await this.listUnconsumedWorkflowEvents(workflowId);
    for (const e of events) {
      const sk = `WFEVT#${e.created_at}#${String(e.id).padStart(10, '0')}`;
      await this.client.send(new UpdateItemCommand({
        TableName: runsTable(),
        Key: marshalItem({ PK: `WF#${workflowId}`, SK: sk }),
        UpdateExpression: 'SET #c = :one',
        ExpressionAttributeNames: { '#c': 'consumed' },
        ExpressionAttributeValues: { ':one': { N: '1' } },
      }));
    }
  }

  async listHumanWorkflowEvents(
    workflowId: string,
    afterDate?: string | null,
    maxExcludeId?: number | null,
  ): Promise<Array<{ id: number; body: string; created_at: string }>> {
    const items = await paginateQuery(this.client, {
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: "#k = :human",
      ExpressionAttributeNames: { '#k': 'kind' },
      ExpressionAttributeValues: {
        ':pk': av(`WF#${workflowId}`),
        ':prefix': av('WFEVT#'),
        ':human': av('human'),
      },
      ScanIndexForward: true,
    });
    let results = items.map((item) => ({
      id: getNumber(item, 'evtId'),
      body: getString(item, 'body') ?? '',
      created_at: getString(item, 'created_at') ?? '',
    }));
    if (afterDate) results = results.filter((e) => e.created_at > afterDate);
    if (maxExcludeId != null) results = results.filter((e) => e.id < maxExcludeId);
    return results;
  }

  async getLastWorkflowEventTime(workflowId: string, kind: string, body: string): Promise<string | null> {
    const items = await paginateQuery(this.client, {
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#k = :kind AND #b = :body',
      ExpressionAttributeNames: { '#k': 'kind', '#b': 'body' },
      ExpressionAttributeValues: {
        ':pk': av(`WF#${workflowId}`),
        ':prefix': av('WFEVT#'),
        ':kind': av(kind),
        ':body': av(body),
      },
    });
    if (items.length === 0) return null;
    const times = items.map((item) => getString(item, 'created_at') ?? '').filter(Boolean);
    if (times.length === 0) return null;
    return times.reduce((max, t) => (t > max ? t : max), times[0]);
  }
}
