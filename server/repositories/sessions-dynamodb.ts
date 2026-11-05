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
 *   WF#<workflowId>          | #WFSEQ                            | atomic workflow-event counter
 *
 * Key design (portal-events):
 *   PK           | SK                         | Entity
 *   RUN#<runId>  | SEQ#<10-digit-zero-padded> | p6_events
 *
 * GSIs on portal-runs:
 *   GSI-ProjectWorkflows: PK=projectId,   SK=wfGsiSk       — list workflows per project
 *   GSI-WorkflowStatus:   PK=projectId,   SK=statusGsiSk   — filter by status per project
 *   GSI-StatusGlobal:     PK=gStatus,     SK=wfGsiSk       — listRunning/listIdle (cross-project)
 *   GSI-ChildWorkflows:   PK=gParentId,   SK=wfGsiSk       — listChildWorkflows (sparse)
 *   GSI-RunId:            PK=runId                         — resolve run without workflowId
 *   GSI-InputHash:        PK=inputHash,   SK=run_id        — F13 getInputByHash
 *   GSI-InputId:          PK=inputId                       — getInputById without run_id
 *
 * Attribute notes:
 *   gStatus    — workflow status string; set on every workflow (dense); used for GSI-StatusGlobal
 *   gParentId  — parent_id string; set only when parent_id is non-null (sparse); GSI-ChildWorkflows
 *   inputId    — input id string; set on every input item; GSI-InputId
 *
 * Oversized-payload strategy:
 *   If payload JSON exceeds 380 000 bytes it is truncated to 380 000 bytes
 *   and `\n[PAYLOAD TRUNCATED — original size: N bytes]` is appended.
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
import type { AttributeValue, GlobalSecondaryIndex } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import { now, HttpError } from '../util.ts';
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
    integrations: getString(item, 'integrations') ?? '[]',
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
    loop_state: getString(item, 'loop_state') ?? '',
    budget_usd: item['budget_usd'] ? getNumber(item, 'budget_usd') : null,
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
    credits: getNumber(item, 'credits'),
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

// ── Auto-increment for workflow events ────────────────────────────────────────
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

// ── In-app filters for listWorkflowsByProject ──────────────────────────────────

function applyWorkflowFilters(items: WorkflowRecord[], opts: ListWorkflowsOpts): WorkflowRecord[] {
  let result = items;
  if (opts.status) result = result.filter((w) => w.status === opts.status);
  if (opts.engine) result = result.filter((w) => w.engine === opts.engine);
  if (opts.search) {
    const lc = opts.search.toLowerCase();
    result = result.filter((w) => w.goal.toLowerCase().includes(lc));
  }
  return result;
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbSessionsRepository implements SessionsRepository {
  private readonly client: DynamoDBClient;

  constructor() {
    this.client = getDynamoDbClient();
  }

  // ── Table setup (called on first use in tests) ──────────────────────────────

  async ensureTables(): Promise<void> {
    const { CreateTableCommand, DescribeTableCommand } =
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
        const gsiDefs: GlobalSecondaryIndex[] = extraGsi ? [
          {
            IndexName: 'GSI-ProjectWorkflows',
            KeySchema: [
              { AttributeName: 'projectId', KeyType: 'HASH' },
              { AttributeName: 'wfGsiSk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI-WorkflowStatus',
            KeySchema: [
              { AttributeName: 'projectId', KeyType: 'HASH' },
              { AttributeName: 'statusGsiSk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI-StatusGlobal',
            KeySchema: [
              { AttributeName: 'gStatus', KeyType: 'HASH' },
              { AttributeName: 'wfGsiSk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI-ChildWorkflows',
            KeySchema: [
              { AttributeName: 'gParentId', KeyType: 'HASH' },
              { AttributeName: 'wfGsiSk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI-RunId',
            KeySchema: [
              { AttributeName: 'runId', KeyType: 'HASH' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI-InputHash',
            KeySchema: [
              { AttributeName: 'inputHash', KeyType: 'HASH' },
              { AttributeName: 'run_id', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI-InputId',
            KeySchema: [
              { AttributeName: 'inputId', KeyType: 'HASH' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI-IdleCandidate',
            KeySchema: [
              { AttributeName: 'idleCandidate', KeyType: 'HASH' },
              { AttributeName: 'last_turn_at_idle', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'GSI-ChildIdle',
            KeySchema: [
              { AttributeName: 'childIdleCandidate', KeyType: 'HASH' },
              { AttributeName: 'updated_at_child_idle', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
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
            { AttributeName: 'gStatus', AttributeType: 'S' },
            { AttributeName: 'gParentId', AttributeType: 'S' },
            { AttributeName: 'runId', AttributeType: 'S' },
            { AttributeName: 'inputHash', AttributeType: 'S' },
            { AttributeName: 'run_id', AttributeType: 'S' },
            { AttributeName: 'inputId', AttributeType: 'S' },
            { AttributeName: 'idleCandidate', AttributeType: 'S' },
            { AttributeName: 'last_turn_at_idle', AttributeType: 'S' },
            { AttributeName: 'childIdleCandidate', AttributeType: 'S' },
            { AttributeName: 'updated_at_child_idle', AttributeType: 'S' },
          ] : [
            { AttributeName: 'PK', AttributeType: 'S' },
            { AttributeName: 'SK', AttributeType: 'S' },
          ],
          GlobalSecondaryIndexes: gsiDefs.length > 0 ? gsiDefs : undefined,
        }));
        // Wait for table to become active
        let active = false;
        for (let i = 0; i < 60; i++) {
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
  ): Promise<{ workflows: WorkflowRecord[]; total: number | null; cursor?: string }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    if (opts.cursor) {
      try { exclusiveStartKey = JSON.parse(opts.cursor); } catch { /* ignore */ }
    }

    // Loop until we have limit+1 matching items or exhaust all DynamoDB pages.
    // This ensures full pages even when in-app filters (status/engine/search) remove items.
    const matching: Array<{ wf: WorkflowRecord; storedWfGsiSk: string }> = [];
    let lastDdbKey: Record<string, AttributeValue> | undefined = exclusiveStartKey;
    const batchSize = Math.max(limit * 3, 100);

    while (true) {
      const res = await this.client.send(new QueryCommand({
        TableName: runsTable(),
        IndexName: 'GSI-ProjectWorkflows',
        KeyConditionExpression: 'projectId = :pid AND begins_with(wfGsiSk, :prefix)',
        ExpressionAttributeValues: {
          ':pid': av(projectId),
          ':prefix': av('WF#'),
        },
        ScanIndexForward: false,
        Limit: batchSize,
        ExclusiveStartKey: lastDdbKey,
      }));

      const batch = (res.Items ?? []).map((item) => ({
        wf: itemToWorkflow(item),
        // Read stored wfGsiSk directly from the item so the cursor doesn't
        // diverge from the index key when a status-only update happened
        // (which updates gStatus but not wfGsiSk).
        storedWfGsiSk: getString(item, 'wfGsiSk') ?? `WF#${getString(item, 'updated_at') ?? ''}#${getString(item, 'id') ?? ''}`,
      }));
      const filtered = batch.filter(({ wf }) => {
        if (opts.status && wf.status !== opts.status) return false;
        if (opts.engine && wf.engine !== opts.engine) return false;
        if (opts.search && !wf.goal.toLowerCase().includes(opts.search.toLowerCase())) return false;
        return true;
      });
      matching.push(...filtered);
      lastDdbKey = res.LastEvaluatedKey;

      // Stop once we have enough to fill the page and determine if there's a next page.
      if (matching.length > limit) break;
      // Stop if DynamoDB has no more data.
      if (!lastDdbKey) break;
    }

    const pageRecords = matching.slice(0, limit);
    const page = pageRecords.map(({ wf }) => wf);
    const hasMore = matching.length > limit || lastDdbKey != null;

    let cursor: string | undefined;
    if (hasMore && pageRecords.length > 0) {
      // Use the stored wfGsiSk from the last item on this page.
      // This guarantees the ExclusiveStartKey matches the index key exactly,
      // even if the item's updated_at was changed by a status-only update
      // that did not touch wfGsiSk.
      const last = pageRecords[pageRecords.length - 1];
      cursor = JSON.stringify({
        PK: { S: `WF#${last.wf.id}` },
        SK: { S: '#META' },
        projectId: { S: projectId },
        wfGsiSk: { S: last.storedWfGsiSk },
      });
    }

    return { workflows: page, total: null, cursor };
  }

  async listRunningWorkflows(): Promise<WorkflowRecord[]> {
    const items = await paginateQuery(this.client, {
      TableName: runsTable(),
      IndexName: 'GSI-StatusGlobal',
      KeyConditionExpression: '#gs = :running',
      ExpressionAttributeNames: { '#gs': 'gStatus' },
      ExpressionAttributeValues: { ':running': av('running') },
    });
    return items.map((item) => itemToWorkflow(item));
  }

  async listIdleWorkflows(cutoff: string): Promise<WorkflowRecord[]> {
    // Query GSI-IdleCandidate: only workflows with status done/pending,
    // stop_reason='', and last_turn_at set are in this sparse index.
    // The key condition last_turn_at_idle < cutoff maps to last_turn_at < cutoff
    // because last_turn_at_idle = last_turn_at + '#' + id and ISO dates are
    // lexicographically sortable (the appended '#id' sorts after the timestamp
    // itself, so items with last_turn_at exactly = cutoff are excluded — correct
    // boundary: only items strictly before the cutoff are returned).
    const items = await paginateQuery(this.client, {
      TableName: runsTable(),
      IndexName: 'GSI-IdleCandidate',
      KeyConditionExpression: 'idleCandidate = :idle AND last_turn_at_idle < :cutoff',
      ExpressionAttributeValues: {
        ':idle': av('IDLE'),
        ':cutoff': av(cutoff),
      },
    });
    return items.map((item) => itemToWorkflow(item));
  }

  async listChildWorkflows(parentId: string): Promise<WorkflowRecord[]> {
    const items = await paginateQuery(this.client, {
      TableName: runsTable(),
      IndexName: 'GSI-ChildWorkflows',
      KeyConditionExpression: 'gParentId = :pid',
      ExpressionAttributeValues: { ':pid': av(parentId) },
      ScanIndexForward: true,
    });
    return items.map((item) => itemToWorkflow(item));
  }

  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRecord> {
    const wfGsiSk = `WF#${input.updated_at}#${input.id}`;
    const statusGsiSk = `STATUS#${input.status}#${input.updated_at}`;

    const item: Record<string, AttributeValue> = {
      PK: av(`WF#${input.id}`),
      SK: av('#META'),
      id: av(input.id),
      // GSI-StatusGlobal — set on every workflow (dense)
      gStatus: av(input.status),
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
        kind: input.kind ?? null,
        wfGsiSk,
        statusGsiSk,
      }),
      childCount: { N: '0' },
    };

    // GSI-ProjectWorkflows — only when project_id is set (non-null)
    if (input.project_id) {
      item['projectId'] = av(input.project_id);
    }

    // GSI-ChildWorkflows — only when parent_id is set (sparse GSI)
    if (input.parent_id) {
      item['gParentId'] = av(input.parent_id);
    }

    // GSI-IdleCandidate — sparse: only when status is done/pending, stop_reason='', last_turn_at is set
    const idleCandidateStatuses = new Set(['done', 'pending']);
    const stopReason = input.stop_reason ?? '';
    if (idleCandidateStatuses.has(input.status) && stopReason === '' && input.updated_at) {
      // For a newly-created workflow there is no last_turn_at yet (it's set when a
      // message is sent or the first run finishes). Skip for now; it will be set
      // by the first updateWorkflow call that touches last_turn_at.
    }

    await this.client.send(new PutItemCommand({
      TableName: runsTable(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));

    // If this is a child workflow, atomically increment the parent's child count
    // and write the EDGESTATS edge rollup for the G8 agent-network graph.
    // The repository owns this bookkeeping so every caller gets it automatically —
    // no separate incrementWorkflowChildCount call is needed at the route layer.
    if (input.parent_id) {
      await this.incrementWorkflowChildCount(input.parent_id, 1);
      // Write edge rollup: fetch parent's lead_agent, then ADD 1 to per-project
      // and GLOBAL EDGESTATS buckets.  Best-effort — errors here must not fail
      // the workflow creation (the workflow itself was already persisted above).
      try {
        const parent = await this.getWorkflowById(input.parent_id);
        if (parent) {
          const sourceAgent = (parent.lead_agent ?? '').trim() || 'default';
          const targetAgent = (input.lead_agent ?? '').trim() || 'default';
          const safeSrc = sourceAgent.replace(/#/g, '_');
          const safeTgt = targetAgent.replace(/#/g, '_');
          const edgeDate = (input.created_at ?? new Date().toISOString()).slice(0, 10);
          const edgeSk = `DAY#${edgeDate}#${safeSrc}#${safeTgt}`;
          const edgeUpdates: Array<{ pk: string }> = [];
          if (input.project_id) edgeUpdates.push({ pk: `EDGESTATS#${input.project_id}` });
          edgeUpdates.push({ pk: 'EDGESTATS#GLOBAL' });
          await Promise.all(edgeUpdates.map(({ pk }) =>
            this.client.send(new UpdateItemCommand({
              TableName: runsTable(),
              Key: marshalItem({ PK: pk, SK: edgeSk }),
              UpdateExpression: 'ADD #cnt :one',
              ExpressionAttributeNames: { '#cnt': 'count' },
              ExpressionAttributeValues: { ':one': { N: '1' } },
            })),
          ));
        }
      } catch {
        // Non-fatal: edge rollup is a best-effort stats counter.
      }
    }

    return itemToWorkflow(item);
  }

  async updateWorkflowConditional(
    id: string,
    expectedStatus: string,
    patch: Partial<WorkflowRecord>,
    opts?: { hintParentId?: string | null },
  ): Promise<boolean> {
    const allowed: (keyof WorkflowRecord)[] = [
      'title', 'goal', 'status', 'stop_reason', 'engine', 'trust_tools',
      'lead_agent', 'workspace_id', 'output_files_enabled', 'repo_ids', 'integrations',
      'iteration_count', 'max_iterations', 'last_turn_at', 'credential_id',
      'model', 'engine_session_id', 'engine_session_engine', 'updated_at',
      'parent_id', 'work_dir', 'jira_key', 'jira_summary', 'jira_url',
      'kind', 'run_timeout_minutes', 'loop_state', 'budget_usd',
    ];
    const setExprs: string[] = [];
    const removeExprs: string[] = [];
    const names: Record<string, string> = { '#curStatus': 'status' };
    const vals: Record<string, AttributeValue> = { ':expected': av(expectedStatus) };

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

    // For conditional updates: status is always known (it equals expectedStatus when
    // the condition holds). Pass expectedStatus as currentStatus for the idle-candidate
    // decision if status is not in the patch.
    const currentStatusForIdle = ('status' in patch && patch.status !== undefined)
      ? undefined  // already in patch, _buildGsiKeyExprs uses it directly
      : expectedStatus;

    this._buildGsiKeyExprs(id, patch, setExprs, names, vals, removeExprs, currentStatusForIdle, undefined, undefined, opts?.hintParentId);

    if (setExprs.length === 0 && removeExprs.length === 0) return false;

    const parts: string[] = [];
    if (setExprs.length > 0) parts.push(`SET ${setExprs.join(', ')}`);
    if (removeExprs.length > 0) parts.push(`REMOVE ${removeExprs.join(', ')}`);

    try {
      await this.client.send(new UpdateItemCommand({
        TableName: runsTable(),
        Key: marshalItem({ PK: `WF#${id}`, SK: '#META' }),
        UpdateExpression: parts.join(' '),
        ConditionExpression: '#curStatus = :expected AND attribute_exists(PK)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: vals,
      }));
      return true;
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  async updateWorkflow(id: string, patch: Partial<WorkflowRecord>): Promise<void> {
    const allowed: (keyof WorkflowRecord)[] = [
      'title', 'goal', 'status', 'stop_reason', 'engine', 'trust_tools',
      'lead_agent', 'workspace_id', 'output_files_enabled', 'repo_ids', 'integrations',
      'iteration_count', 'max_iterations', 'last_turn_at', 'credential_id',
      'model', 'engine_session_id', 'engine_session_engine', 'updated_at',
      'parent_id', 'work_dir', 'jira_key', 'jira_summary', 'jira_url',
      'kind', 'run_timeout_minutes', 'loop_state', 'budget_usd',
    ];
    const setExprs: string[] = [];
    const removeExprs: string[] = [];
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

    // When last_turn_at or stop_reason changes but status is NOT in the patch,
    // we need to read the current item to decide whether the idle candidate
    // should be set or removed.
    // When status changes (with or without stop_reason), we need parent_id for
    // the child-idle-candidate decision.
    const hasStatus = 'status' in patch && patch.status !== undefined;
    const hasLastTurnAt = 'last_turn_at' in patch && patch.last_turn_at !== undefined;
    const hasStopReason = 'stop_reason' in patch && patch.stop_reason !== undefined;

    let currentStatus: string | undefined;
    let currentStopReason: string | undefined;
    let currentLastTurnAt: string | null | undefined;
    let currentParentId: string | null | undefined;

    if (hasStatus || hasLastTurnAt || hasStopReason) {
      // Read the current item so we can make correct idle-candidate decisions.
      const current = await this.getWorkflowById(id);
      if (!hasStatus) currentStatus = current?.status ?? undefined;
      if (!hasStopReason) currentStopReason = current?.stop_reason ?? undefined;
      if (!hasLastTurnAt) currentLastTurnAt = current?.last_turn_at ?? null;
      currentParentId = current?.parent_id ?? null;
    }

    this._buildGsiKeyExprs(id, patch, setExprs, names, vals, removeExprs, currentStatus, currentStopReason, currentLastTurnAt, currentParentId);

    // Handle gParentId: set when parent_id becomes non-null, remove when nulled
    if ('parent_id' in patch) {
      const parentId = patch.parent_id as string | null | undefined;
      if (parentId) {
        names['#gPid'] = 'gParentId';
        vals[':gPid'] = av(parentId);
        setExprs.push('#gPid = :gPid');
      } else {
        names['#gPid'] = 'gParentId';
        removeExprs.push('#gPid');
      }
    }

    if (setExprs.length === 0 && removeExprs.length === 0) return;

    const parts: string[] = [];
    if (setExprs.length > 0) parts.push(`SET ${setExprs.join(', ')}`);
    if (removeExprs.length > 0) parts.push(`REMOVE ${removeExprs.join(', ')}`);

    await this.client.send(new UpdateItemCommand({
      TableName: runsTable(),
      Key: marshalItem({ PK: `WF#${id}`, SK: '#META' }),
      UpdateExpression: parts.join(' '),
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
      ExpressionAttributeValues: Object.keys(vals).length > 0 ? vals : undefined,
    }));
  }

  /** Build GSI key update expressions from patch without reading the item. */
  private _buildGsiKeyExprs(
    id: string,
    patch: Partial<WorkflowRecord>,
    setExprs: string[],
    names: Record<string, string>,
    vals: Record<string, AttributeValue>,
    removeExprs?: string[],
    currentStatus?: string,
    currentStopReason?: string,
    currentLastTurnAt?: string | null,
    currentParentId?: string | null,
  ): void {
    const hasStatus = 'status' in patch && patch.status !== undefined;
    const hasUpdatedAt = 'updated_at' in patch && patch.updated_at !== undefined;
    const hasStopReason = 'stop_reason' in patch && patch.stop_reason !== undefined;
    const hasLastTurnAt = 'last_turn_at' in patch && patch.last_turn_at !== undefined;

    if (hasStatus) {
      // Update gStatus (dense attribute for GSI-StatusGlobal)
      names['#gSt'] = 'gStatus';
      vals[':gSt'] = av(patch.status as string);
      setExprs.push('#gSt = :gSt');
    }

    if (hasStatus && hasUpdatedAt) {
      // Both status and updated_at are known: rebuild both GSI sort keys read-free.
      const updatedAt = patch.updated_at as string;
      const status = patch.status as string;
      names['#wfGsiSk'] = 'wfGsiSk';
      vals[':wfGsiSk'] = av(`WF#${updatedAt}#${id}`);
      setExprs.push('#wfGsiSk = :wfGsiSk');
      names['#statusGsiSk'] = 'statusGsiSk';
      vals[':statusGsiSk'] = av(`STATUS#${status}#${updatedAt}`);
      setExprs.push('#statusGsiSk = :statusGsiSk');
    } else if (hasUpdatedAt) {
      // updated_at changed but status did not: update wfGsiSk (ordering key) only.
      const updatedAt = patch.updated_at as string;
      names['#wfGsiSk'] = 'wfGsiSk';
      vals[':wfGsiSk'] = av(`WF#${updatedAt}#${id}`);
      setExprs.push('#wfGsiSk = :wfGsiSk');
    }

    // ── GSI-IdleCandidate management ───────────────────────────────────────────
    // Idle candidates are workflows with status in ('done','pending'),
    // stop_reason='', and last_turn_at set.  The sparse GSI-IdleCandidate
    // has PK=idleCandidate='IDLE', SK=last_turn_at_idle=last_turn_at+'#'+id.
    // Attributes are SET when conditions are met, REMOVED otherwise.

    const idleStatuses = new Set(['done', 'pending']);

    // Determine the effective status, stop_reason, and last_turn_at for the
    // idle-candidate decision.  If a value is in the patch, use it directly;
    // otherwise fall back to the caller-supplied current state.
    const effectiveStatus = hasStatus ? (patch.status as string) : currentStatus;
    const effectiveStopReason = hasStopReason ? (patch.stop_reason as string ?? '') : currentStopReason;
    const effectiveLastTurnAt = hasLastTurnAt
      ? (patch.last_turn_at as string | null | undefined) ?? null
      : (currentLastTurnAt ?? null);

    // Only manage the idle-candidate attributes if we have enough information.
    // If currentStatus is unknown (not provided and not in patch), we skip — the
    // caller must call _buildGsiKeyExprs with current* values for that case.
    const haveEnoughInfo = hasStatus || (currentStatus !== undefined);

    if (haveEnoughInfo && removeExprs !== undefined) {
      const shouldBeIdle =
        effectiveStatus !== undefined &&
        idleStatuses.has(effectiveStatus) &&
        effectiveStopReason === '' &&
        effectiveLastTurnAt !== null &&
        effectiveLastTurnAt !== undefined;

      names['#idleC'] = 'idleCandidate';
      names['#ltidle'] = 'last_turn_at_idle';

      if (shouldBeIdle) {
        vals[':idleC'] = av('IDLE');
        vals[':ltidle'] = av(`${effectiveLastTurnAt}#${id}`);
        setExprs.push('#idleC = :idleC');
        setExprs.push('#ltidle = :ltidle');
      } else {
        removeExprs.push('#idleC');
        removeExprs.push('#ltidle');
      }
    }

    // ── GSI-ChildIdle management ───────────────────────────────────────────────
    // Child idle candidates are workflows with parent_id IS NOT NULL,
    // status IN ('done','failed','paused'), and stop_reason=''.
    // The sparse GSI-ChildIdle has PK=childIdleCandidate='CHILD_IDLE',
    // SK=updated_at_child_idle=updated_at+'#'+id.
    // Attributes are SET when conditions are met, REMOVED otherwise.
    //
    // currentParentId (from patch, read, or hint) determines whether this
    // workflow is a child. If undefined, we skip to avoid a stale REMOVE.

    const haveParentInfo = currentParentId !== undefined;
    const effectiveUpdatedAt = ('updated_at' in patch && patch.updated_at !== undefined)
      ? (patch.updated_at as string)
      : undefined;

    if (haveEnoughInfo && haveParentInfo && removeExprs !== undefined && effectiveUpdatedAt !== undefined) {
      const terminalStatuses = new Set(['done', 'failed', 'paused']);
      const shouldBeChildIdle =
        effectiveStatus !== undefined &&
        terminalStatuses.has(effectiveStatus) &&
        effectiveStopReason === '' &&
        currentParentId !== null;

      names['#cic'] = 'childIdleCandidate';
      names['#atci'] = 'updated_at_child_idle';

      if (shouldBeChildIdle) {
        vals[':cic'] = av('CHILD_IDLE');
        vals[':atci'] = av(`${effectiveUpdatedAt}#${id}`);
        setExprs.push('#cic = :cic');
        setExprs.push('#atci = :atci');
      } else {
        removeExprs.push('#cic');
        removeExprs.push('#atci');
      }
    }
  }

  async deleteWorkflow(id: string): Promise<void> {
    // 1. Load workflow to get parent_id before deleting.
    const wf = await this.getWorkflowById(id);
    const parentId = wf?.parent_id ?? null;

    // 2. Query all items under WF#<id> in portal-runs.
    const wfItems = await paginateQuery(this.client, {
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': av(`WF#${id}`) },
    });

    // 3. Extract run IDs from RUN# SK items.
    const runIds: string[] = [];
    for (const item of wfItems) {
      const sk = getString(item, 'SK') ?? '';
      if (sk.startsWith('RUN#')) {
        // SK = RUN#<isoCreatedAt>#<runId>  → extract runId (last segment)
        const parts = sk.split('#');
        const runId = parts[parts.length - 1];
        if (runId) runIds.push(runId);
      }
    }

    // 4. For each run: delete events in portal-events and run items in portal-runs.
    for (const runId of runIds) {
      // Delete all events for this run in portal-events
      const eventItems = await paginateQuery(this.client, {
        TableName: eventsTable(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': av(`RUN#${runId}`) },
      });
      await batchDelete(this.client, eventsTable(), eventItems);

      // Delete all items under RUN#<runId> in portal-runs (inputs, #SEQ)
      const runItems = await paginateQuery(this.client, {
        TableName: runsTable(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': av(`RUN#${runId}`) },
      });
      await batchDelete(this.client, runsTable(), runItems);
    }

    // 5. Delete all items under WF#<id> in portal-runs (META, WFEVT, #WFSEQ).
    await batchDelete(this.client, runsTable(), wfItems);

    // 6. If there was a parent, decrement its child count.
    if (parentId) {
      await this.incrementWorkflowChildCount(parentId, -1);
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
      ExpressionAttributeValues: { ':delta': { N: String(delta) } },
    }));
  }

  // ── Runs ────────────────────────────────────────────────────────────────────

  async getRunById(id: string): Promise<RunRecord | null> {
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
    // Scan newest-first in small batches; the active run is almost always
    // among the most recent runs, so this is efficient in practice.
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const res = await this.client.send(new QueryCommand({
        TableName: runsTable(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': av(`WF#${workflowId}`),
          ':prefix': av('RUN#'),
        },
        ScanIndexForward: false,
        Limit: 100,
        ExclusiveStartKey: lastKey,
      }));
      for (const item of (res.Items ?? [])) {
        const run = itemToRun(item);
        if (run.status === 'pending' || run.status === 'running') return run;
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return null;
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
    let total_credits = 0;
    let total_input = 0;
    let total_output = 0;
    for (const r of runs) {
      total_cost += r.cost_usd;
      total_credits += r.credits;
      total_input += r.input_tokens;
      total_output += r.output_tokens;
    }
    return { total_cost, total_credits, total_input, total_output };
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
      credits: 0,
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
    const run = await this.getRunById(id);
    if (!run) return;

    const allowed: (keyof RunRecord)[] = [
      'status', 'started_at', 'finished_at', 'cost_usd', 'credits', 'input_tokens',
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

  async updateRunConditional(
    id: string,
    expectedStatus: string,
    patch: Partial<RunRecord>,
  ): Promise<boolean> {
    const run = await this.getRunById(id);
    if (!run) return false;

    const allowed: (keyof RunRecord)[] = [
      'status', 'started_at', 'finished_at', 'cost_usd', 'credits', 'input_tokens',
      'output_tokens', 'cache_write_tokens', 'cache_read_tokens',
      'stop_reason', 'time_limit_at', 'model', 'error',
    ];
    const setExprs: string[] = [];
    const names: Record<string, string> = { '#curSt': 'status' };
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

    const runSk = `RUN#${run.created_at}#${id}`;
    try {
      await this.client.send(new UpdateItemCommand({
        TableName: runsTable(),
        Key: marshalItem({ PK: `WF#${run.workflow_id}`, SK: runSk }),
        UpdateExpression: `SET ${setExprs.join(', ')}`,
        ConditionExpression: '#curSt = :expected',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: vals,
      }));
      return true;
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  async appendRunEvent(runId: string, type: string, payload: string, createdAt: string): Promise<AppendedEvent> {
    const safePayload = truncatePayload(payload);

    // Atomically increment the per-run sequence counter.
    // This is the single source of the event id — both the stored item and the
    // live stream must use this value (not an in-memory counter).
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
      // GSI-InputId PK — always set so getInputById can find it without run_id
      inputId: av(input.id),
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
    // Use GSI-InputId to find input without knowing run_id.
    const res = await this.client.send(new QueryCommand({
      TableName: runsTable(),
      IndexName: 'GSI-InputId',
      KeyConditionExpression: 'inputId = :iid',
      ExpressionAttributeValues: { ':iid': av(id) },
      Limit: 1,
    }));
    if (!res.Items || res.Items.length === 0) return null;
    return itemToInput(res.Items[0]);
  }

  async getInputByRunAndId(runId: string, inputId: string): Promise<InputRecord | null> {
    const res = await this.client.send(new GetItemCommand({
      TableName: runsTable(),
      Key: marshalItem({ PK: `RUN#${runId}`, SK: `INPUT#${inputId}` }),
    }));
    if (!res.Item) return null;
    return itemToInput(res.Item);
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

    const run_id = (patch as Record<string, unknown>)['run_id'] as string | undefined;
    if (!run_id) return false;

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
    if (!run_id) return;

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
    beforeOrAtDate?: string | null,
  ): Promise<Array<{ id: number; body: string; created_at: string }>> {
    const items = await paginateQuery(this.client, {
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#k = :human',
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
    if (beforeOrAtDate != null) results = results.filter((e) => e.created_at <= beforeOrAtDate);
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

  // ── Transcript ──────────────────────────────────────────────────────────────

  async listTranscript(
    workflowId: string,
    cursor: import('./sessions.ts').TranscriptCursor | null,
    limit: number,
  ): Promise<{ rows: import('./sessions.ts').TranscriptRow[]; nextCursor: import('./sessions.ts').TranscriptCursor | null }> {
    // 1. List all run IDs for this workflow.
    const runSkItems = await paginateQuery(this.client, {
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': av(`WF#${workflowId}`),
        ':prefix': av('RUN#'),
      },
    });
    const runEntries: Array<{ runId: string }> = runSkItems.map((item) => {
      const sk = getString(item, 'SK') ?? '';
      // SK = RUN#<isoCreatedAt>#<runId> — extract the last segment
      const parts = sk.split('#');
      return { runId: parts[parts.length - 1] };
    });

    // 2. Fetch all run events (paginate each run partition fully for correctness).
    //    Cap at MAX_TRANSCRIPT_EVENTS total to prevent excessive reads.
    const MAX_TRANSCRIPT_EVENTS = 10_000;
    const allRunRows: import('./sessions.ts').TranscriptRow[] = [];
    for (const { runId } of runEntries) {
      if (allRunRows.length >= MAX_TRANSCRIPT_EVENTS) break;
      const evtItems = await paginateQuery(this.client, {
        TableName: eventsTable(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': av(`RUN#${runId}`) },
        ScanIndexForward: true,
      }, MAX_TRANSCRIPT_EVENTS - allRunRows.length);
      for (const item of evtItems) {
        const sk = getString(item, 'SK') ?? '';
        allRunRows.push({
          src: 'r',
          id: seqFromSk(sk),
          created_at: getString(item, 'created_at') ?? '',
          kind: getString(item, 'type') ?? '',
          body: getString(item, 'payload') ?? '',
          run_id: runId,
        });
      }
    }

    // 3. Fetch all workflow events.
    const wfEvtItems = await paginateQuery(this.client, {
      TableName: runsTable(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': av(`WF#${workflowId}`),
        ':prefix': av('WFEVT#'),
      },
      ScanIndexForward: true,
    });
    const allWfRows: import('./sessions.ts').TranscriptRow[] = wfEvtItems.map((item) => ({
      src: 'w' as const,
      id: getNumber(item, 'evtId'),
      created_at: getString(item, 'created_at') ?? '',
      kind: getString(item, 'kind') ?? '',
      body: getString(item, 'body') ?? '',
      run_id: null,
    }));

    // 4. Merge and apply cursor filter.
    let allRows: import('./sessions.ts').TranscriptRow[] = [...allRunRows, ...allWfRows];

    if (cursor) {
      allRows = allRows.filter((row) => {
        if (row.created_at < cursor.ts) return true;
        if (row.created_at > cursor.ts) return false;
        if (row.src > cursor.src) return true;
        if (row.src < cursor.src) return false;
        return row.id < cursor.id;
      });
    }

    // 5. Sort descending: newest first, 'r' before 'w' at same ts, higher id first.
    allRows.sort((a, b) => {
      if (b.created_at > a.created_at) return 1;
      if (b.created_at < a.created_at) return -1;
      if (a.src < b.src) return -1;  // 'r' < 'w' → 'r' comes first
      if (a.src > b.src) return 1;
      return b.id - a.id;
    });

    // 6. Take limit rows and build next cursor.
    const page = allRows.slice(0, limit);
    const nextCursor: import('./sessions.ts').TranscriptCursor | null =
      page.length === limit
        ? { ts: page[page.length - 1].created_at, src: page[page.length - 1].src, id: page[page.length - 1].id }
        : null;

    return { rows: page, nextCursor };
  }

  // ── Delegation ──────────────────────────────────────────────────────────────

  async countRunningChildWorkflows(parentId: string): Promise<number> {
    const res = await this.client.send(new GetItemCommand({
      TableName: runsTable(),
      Key: marshalItem({ PK: `DLGPARENT#${parentId}`, SK: '#RUNNING' }),
    }));
    return res.Item ? Math.max(0, getNumber(res.Item, 'count')) : 0;
  }

  async countRunningChildrenByUser(userId: string): Promise<number> {
    const res = await this.client.send(new GetItemCommand({
      TableName: runsTable(),
      Key: marshalItem({ PK: `DLGUSER#${userId}`, SK: '#RUNNING' }),
    }));
    return res.Item ? Math.max(0, getNumber(res.Item, 'count')) : 0;
  }

  async createChildWorkflowChecked(
    input: CreateWorkflowInput,
    opts: { parentId: string; userId: string; maxRunningPerParent: number; maxRunningPerUser: number },
  ): Promise<WorkflowRecord> {
    const { parentId, userId, maxRunningPerParent, maxRunningPerUser } = opts;

    const wfGsiSk = `WF#${input.updated_at}#${input.id}`;
    const statusGsiSk = `STATUS#${input.status}#${input.updated_at}`;
    const wfItem: Record<string, AttributeValue> = {
      PK: av(`WF#${input.id}`),
      SK: av('#META'),
      id: av(input.id),
      gStatus: av(input.status),
      childCount: { N: '0' },
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
        parent_id: parentId,
        wfGsiSk,
        statusGsiSk,
      }),
    };
    if (input.project_id) wfItem['projectId'] = av(input.project_id);
    wfItem['gParentId'] = av(parentId);
    // Mark slot as held: this child currently occupies one slot in both
    // DLGPARENT and DLGUSER counters.
    wfItem['dlgSlotHeld'] = { N: '1' };

    // Build TransactItems: Put workflow + increment parent counter + increment user counter
    type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteItemsCommand>[0]['TransactItems']>[number];
    const transactItems: TransactItem[] = [
      {
        Put: {
          TableName: runsTable(),
          Item: wfItem,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ];

    // Parent running-children counter
    if (maxRunningPerParent > 0) {
      transactItems.push({
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `DLGPARENT#${parentId}`, SK: '#RUNNING' }),
          UpdateExpression: 'ADD #cnt :one',
          ConditionExpression: 'attribute_not_exists(#cnt) OR #cnt < :maxParent',
          ExpressionAttributeNames: { '#cnt': 'count' },
          ExpressionAttributeValues: { ':one': { N: '1' }, ':maxParent': { N: String(maxRunningPerParent) } },
        },
      });
    } else {
      transactItems.push({
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `DLGPARENT#${parentId}`, SK: '#RUNNING' }),
          UpdateExpression: 'ADD #cnt :one',
          ExpressionAttributeNames: { '#cnt': 'count' },
          ExpressionAttributeValues: { ':one': { N: '1' } },
        },
      });
    }

    // User running-children counter
    if (maxRunningPerUser > 0) {
      transactItems.push({
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `DLGUSER#${userId}`, SK: '#RUNNING' }),
          UpdateExpression: 'ADD #cnt :one',
          ConditionExpression: 'attribute_not_exists(#cnt) OR #cnt < :maxUser',
          ExpressionAttributeNames: { '#cnt': 'count' },
          ExpressionAttributeValues: { ':one': { N: '1' }, ':maxUser': { N: String(maxRunningPerUser) } },
        },
      });
    } else {
      transactItems.push({
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `DLGUSER#${userId}`, SK: '#RUNNING' }),
          UpdateExpression: 'ADD #cnt :one',
          ExpressionAttributeNames: { '#cnt': 'count' },
          ExpressionAttributeValues: { ':one': { N: '1' } },
        },
      });
    }

    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));
    } catch (e: unknown) {
      const name = (e as { name?: string }).name ?? '';
      if (name === 'TransactionCanceledException') {
        const reasons = (e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
        // Index 1: parent counter condition; Index 2: user counter condition
        if (reasons[1]?.Code === 'ConditionalCheckFailed') {
          throw new HttpError(
            429,
            `The maximum running children per parent (${maxRunningPerParent}) has been reached. Wait for a child to finish.`,
          );
        }
        if (reasons[2]?.Code === 'ConditionalCheckFailed') {
          throw new HttpError(
            429,
            `The maximum running delegated sessions per user (${maxRunningPerUser}) has been reached. Wait for a child to finish.`,
          );
        }
        if (reasons[0]?.Code === 'ConditionalCheckFailed') {
          throw new HttpError(409, 'Child workflow ID conflict — try again.');
        }
      }
      throw e;
    }

    // Increment parent total child count (distinct from the running-child counter)
    await this.incrementWorkflowChildCount(parentId, 1);

    return itemToWorkflow(wfItem);
  }

  async releaseChildDelegationSlot(childId: string, parentId: string, userId: string): Promise<void> {
    // TransactWriteItems:
    //   [0] Child item: condition dlgSlotHeld = 1 → SET dlgSlotHeld = 0
    //   [1] DLGPARENT counter: ADD count -1
    //   [2] DLGUSER counter:  ADD count -1
    //
    // If condition [0] fails (slot already 0 or attribute absent), the whole
    // transaction is cancelled — idempotent no-op.
    type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteItemsCommand>[0]['TransactItems']>[number];
    const transactItems: TransactItem[] = [
      {
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `WF#${childId}`, SK: '#META' }),
          UpdateExpression: 'SET #slot = :zero',
          ConditionExpression: 'attribute_exists(PK) AND #slot = :one',
          ExpressionAttributeNames: { '#slot': 'dlgSlotHeld' },
          ExpressionAttributeValues: { ':zero': { N: '0' }, ':one': { N: '1' } },
        },
      },
      {
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `DLGPARENT#${parentId}`, SK: '#RUNNING' }),
          UpdateExpression: 'ADD #cnt :neg',
          ExpressionAttributeNames: { '#cnt': 'count' },
          ExpressionAttributeValues: { ':neg': { N: '-1' } },
        },
      },
      {
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `DLGUSER#${userId}`, SK: '#RUNNING' }),
          UpdateExpression: 'ADD #cnt :neg',
          ExpressionAttributeNames: { '#cnt': 'count' },
          ExpressionAttributeValues: { ':neg': { N: '-1' } },
        },
      },
    ];

    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));
    } catch (e: unknown) {
      const name = (e as { name?: string }).name ?? '';
      if (name === 'TransactionCanceledException') {
        // Check if the child condition failed (slot already 0 — idempotent)
        const reasons = (e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return; // already released
      }
      throw e;
    }
  }

  async acquireChildDelegationSlot(
    childId: string,
    parentId: string,
    userId: string,
    maxRunningPerParent: number,
    maxRunningPerUser: number,
  ): Promise<void> {
    // TransactWriteItems:
    //   [0] Child item: condition dlgSlotHeld = 0 (or absent) → SET dlgSlotHeld = 1
    //   [1] DLGPARENT counter: ADD count +1 (with cap condition if maxParent > 0)
    //   [2] DLGUSER counter:  ADD count +1 (with cap condition if maxUser > 0)
    //
    // If condition [0] fails (slot already 1): idempotent no-op.
    // If condition [1] fails: parent cap exceeded → throw 429.
    // If condition [2] fails: user cap exceeded → throw 429.
    type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteItemsCommand>[0]['TransactItems']>[number];
    const transactItems: TransactItem[] = [
      {
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `WF#${childId}`, SK: '#META' }),
          UpdateExpression: 'SET #slot = :one',
          ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(#slot) OR #slot = :zero)',
          ExpressionAttributeNames: { '#slot': 'dlgSlotHeld' },
          ExpressionAttributeValues: { ':zero': { N: '0' }, ':one': { N: '1' } },
        },
      },
    ];

    if (maxRunningPerParent > 0) {
      transactItems.push({
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `DLGPARENT#${parentId}`, SK: '#RUNNING' }),
          UpdateExpression: 'ADD #cnt :one',
          ConditionExpression: 'attribute_not_exists(#cnt) OR #cnt < :maxParent',
          ExpressionAttributeNames: { '#cnt': 'count' },
          ExpressionAttributeValues: { ':one': { N: '1' }, ':maxParent': { N: String(maxRunningPerParent) } },
        },
      });
    } else {
      transactItems.push({
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `DLGPARENT#${parentId}`, SK: '#RUNNING' }),
          UpdateExpression: 'ADD #cnt :one',
          ExpressionAttributeNames: { '#cnt': 'count' },
          ExpressionAttributeValues: { ':one': { N: '1' } },
        },
      });
    }

    if (maxRunningPerUser > 0) {
      transactItems.push({
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `DLGUSER#${userId}`, SK: '#RUNNING' }),
          UpdateExpression: 'ADD #cnt :one',
          ConditionExpression: 'attribute_not_exists(#cnt) OR #cnt < :maxUser',
          ExpressionAttributeNames: { '#cnt': 'count' },
          ExpressionAttributeValues: { ':one': { N: '1' }, ':maxUser': { N: String(maxRunningPerUser) } },
        },
      });
    } else {
      transactItems.push({
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `DLGUSER#${userId}`, SK: '#RUNNING' }),
          UpdateExpression: 'ADD #cnt :one',
          ExpressionAttributeNames: { '#cnt': 'count' },
          ExpressionAttributeValues: { ':one': { N: '1' } },
        },
      });
    }

    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));
    } catch (e: unknown) {
      const name = (e as { name?: string }).name ?? '';
      if (name === 'TransactionCanceledException') {
        const reasons = (e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
        // Index 0: child slot condition (already held — idempotent)
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return;
        // Index 1: parent cap exceeded
        if (reasons[1]?.Code === 'ConditionalCheckFailed') {
          throw new HttpError(
            429,
            `The maximum running children per parent (${maxRunningPerParent}) has been reached. Wait for a child to finish.`,
          );
        }
        // Index 2: user cap exceeded
        if (reasons[2]?.Code === 'ConditionalCheckFailed') {
          throw new HttpError(
            429,
            `The maximum running delegated sessions per user (${maxRunningPerUser}) has been reached. Wait for a child to finish.`,
          );
        }
      }
      throw e;
    }
  }

  async listTerminalChildWorkflows(cutoff: string): Promise<WorkflowRecord[]> {
    // Query GSI-ChildIdle (sparse): only child workflows in terminal state with
    // stop_reason='' are indexed here. Once child-idle-stopped (stop_reason='child-idle')
    // the childIdleCandidate attribute is removed so they never appear again.
    // The SK < cutoff condition uses updated_at_child_idle = updated_at + '#' + id,
    // which is lexicographically equivalent to updated_at < cutoff for ISO timestamps.
    const items = await paginateQuery(this.client, {
      TableName: runsTable(),
      IndexName: 'GSI-ChildIdle',
      KeyConditionExpression: '#cic = :cic AND #atci < :cutoff',
      ExpressionAttributeNames: { '#cic': 'childIdleCandidate', '#atci': 'updated_at_child_idle' },
      ExpressionAttributeValues: {
        ':cic': av('CHILD_IDLE'),
        ':cutoff': av(cutoff),
      },
    });
    return items.map((item) => itemToWorkflow(item));
  }

  async listPendingWorkflows(): Promise<WorkflowRecord[]> {
    const items = await paginateQuery(this.client, {
      TableName: runsTable(),
      IndexName: 'GSI-StatusGlobal',
      KeyConditionExpression: '#gs = :pending',
      ExpressionAttributeNames: { '#gs': 'gStatus' },
      ExpressionAttributeValues: { ':pending': av('pending') },
    });
    return items.map((item) => itemToWorkflow(item));
  }

  async finalizeRun(
    id: string,
    expectedStatus: string,
    patch: Partial<RunRecord>,
    statsHint: import('./sessions.ts').RunFinalizeStats,
  ): Promise<boolean> {
    // Get the run item to find workflow_id, created_at, and current cost/tokens.
    const run = await this.getRunById(id);
    if (!run) return false;

    const allowed: (keyof RunRecord)[] = [
      'status', 'started_at', 'finished_at', 'cost_usd', 'credits', 'input_tokens',
      'output_tokens', 'cache_write_tokens', 'cache_read_tokens',
      'stop_reason', 'time_limit_at', 'model', 'error',
    ];
    const setExprs: string[] = [];
    const names: Record<string, import('@aws-sdk/client-dynamodb').AttributeValue> = {};
    const attrNames: Record<string, string> = { '#curSt': 'status' };
    const vals: Record<string, import('@aws-sdk/client-dynamodb').AttributeValue> = {
      ':expected': av(expectedStatus),
    };
    let i = 0;
    for (const k of allowed) {
      if (k in patch && patch[k] !== undefined) {
        const nk = `#f${i}`;
        const vk = `:fw${i}`;
        attrNames[nk] = k;
        vals[vk] = av(patch[k] as string | number | null);
        setExprs.push(`${nk} = ${vk}`);
        i++;
      }
    }
    void names;
    if (setExprs.length === 0) return false;

    const runSk = `RUN#${run.created_at}#${id}`;
    const termStatus = patch.status as string | undefined;
    const isTerminal = termStatus === 'done' || termStatus === 'failed' || termStatus === 'cancelled';

    // Compute duration from run.started_at + patch.finished_at
    const startedAt = run.started_at ? Date.parse(run.started_at) : null;
    const finishedAt = patch.finished_at ? Date.parse(patch.finished_at as string) : null;
    const durationMs = startedAt != null && finishedAt != null && finishedAt > startedAt
      ? finishedAt - startedAt
      : null;

    // Cost/tokens from the run item (already updated by the engine before finalization)
    const costUsd = run.cost_usd || 0;
    const credits = run.credits || 0;
    const inputTokens = run.input_tokens || 0;
    const outputTokens = run.output_tokens || 0;

    type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteItemsCommand>[0]['TransactItems']>[number];
    const transactItems: TransactItem[] = [
      {
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `WF#${run.workflow_id}`, SK: runSk }),
          UpdateExpression: `SET ${setExprs.join(', ')}`,
          ConditionExpression: '#curSt = :expected',
          ExpressionAttributeNames: attrNames,
          ExpressionAttributeValues: vals,
        },
      },
    ];

    if (isTerminal && termStatus) {
      const bucket = statsHint.projectId ?? 'UNSCOPED';
      const date = statsHint.dateUTC;
      const agentKey = statsHint.agentName || 'default';

      const statusAttr = termStatus === 'done' ? 'doneCount'
        : termStatus === 'failed' ? 'failedCount'
        : 'cancelledCount';

      // RUNSTATS rollup (per-project per-day)
      let rsExpr = `ADD #sc :one`;
      const rsNames: Record<string, string> = { '#sc': statusAttr };
      const rsVals: Record<string, import('@aws-sdk/client-dynamodb').AttributeValue> = { ':one': { N: '1' } };
      if (durationMs != null && durationMs > 0) {
        rsExpr += ', totalDurationMs :dur, durationCount :one';
        rsVals[':dur'] = { N: String(Math.round(durationMs)) };
      }
      transactItems.push({
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `RUNSTATS#${bucket}`, SK: `DAY#${date}` }),
          UpdateExpression: rsExpr,
          ExpressionAttributeNames: rsNames,
          ExpressionAttributeValues: rsVals,
        },
      });

      // AGENTSTATS rollup (per-project per-agent per-day)
      // SK format: DAY#<date>#AGENT#<name>  — date-led so BETWEEN queries are bounded.
      let asExpr = `ADD #asc :one, runs :one, costUsd :cost, credits :cred, inputTokens :inp, outputTokens :out`;
      const asNames: Record<string, string> = { '#asc': statusAttr };
      const asVals: Record<string, import('@aws-sdk/client-dynamodb').AttributeValue> = {
        ':one': { N: '1' },
        ':cost': { N: String(costUsd) },
        ':cred': { N: String(credits) },
        ':inp': { N: String(inputTokens) },
        ':out': { N: String(outputTokens) },
      };
      if (durationMs != null && durationMs > 0) {
        asExpr += ', totalDurationMs :dur, durationCount :one';
        asVals[':dur'] = { N: String(Math.round(durationMs)) };
      }
      // Safely encode agent name in SK (replace '#' with '_' so the date-led SK is unambiguous)
      const safeAgent = agentKey.replace(/#/g, '_');
      transactItems.push({
        Update: {
          TableName: runsTable(),
          Key: marshalItem({ PK: `AGENTSTATS#${bucket}`, SK: `DAY#${date}#AGENT#${safeAgent}` }),
          UpdateExpression: asExpr,
          ExpressionAttributeNames: asNames,
          ExpressionAttributeValues: asVals,
        },
      });

      // GLOBAL rollup — also written for every terminal run so admin queries
      // against RUNSTATS#GLOBAL and AGENTSTATS#GLOBAL return non-zero totals.
      // (bucket may already be 'GLOBAL' only if projectId was null/UNSCOPED, but
      //  we always write GLOBAL separately so the admin path always finds data.)
      if (bucket !== 'GLOBAL') {
        transactItems.push({
          Update: {
            TableName: runsTable(),
            Key: marshalItem({ PK: 'RUNSTATS#GLOBAL', SK: `DAY#${date}` }),
            UpdateExpression: rsExpr,
            ExpressionAttributeNames: rsNames,
            ExpressionAttributeValues: rsVals,
          },
        });
        transactItems.push({
          Update: {
            TableName: runsTable(),
            Key: marshalItem({ PK: 'AGENTSTATS#GLOBAL', SK: `DAY#${date}#AGENT#${safeAgent}` }),
            UpdateExpression: asExpr,
            ExpressionAttributeNames: asNames,
            ExpressionAttributeValues: asVals,
          },
        });
      }
    }

    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));
      return true;
    } catch (e: unknown) {
      const name = (e as { name?: string }).name ?? '';
      if (name === 'ConditionalCheckFailedException') return false;
      // TransactionCanceledException: check if the run condition failed (item 0)
      if (name === 'TransactionCanceledException') {
        const reasons = (e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return false;
      }
      throw e;
    }
  }
}



async function batchDelete(
  client: DynamoDBClient,
  tableName: string,
  items: Array<Record<string, AttributeValue>>,
): Promise<void> {
  if (items.length === 0) return;
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    let result = await client.send(new BatchWriteItemCommand({
      RequestItems: {
        [tableName]: batch.map((item) => ({
          DeleteRequest: { Key: { PK: item['PK'], SK: item['SK'] } },
        })),
      },
    }));
    // Retry unprocessed items
    while (result.UnprocessedItems && Object.keys(result.UnprocessedItems).length > 0) {
      await new Promise((r) => setTimeout(r, 100));
      result = await client.send(new BatchWriteItemCommand({
        RequestItems: result.UnprocessedItems,
      }));
    }
  }
}
