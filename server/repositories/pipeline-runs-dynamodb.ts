/**
 * DynamoDB implementation of PipelineRunsRepository.
 *
 * Table: portal-projects (DYNAMODB_TABLE_PORTAL_PROJECTS, default 'portal-projects'). See pipeline-runs.ts for the key design.
 * Every write that must not lose a race is a conditional write: the run upsert (newest attempt/status rank wins), markAlerted
 * (the channel's attempt must be lower) and putAlert (updated_at must be the expected one, or the item must not exist).
 */

import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, getString, getNumber, av } from './dynamo-client.ts';
import type { JsVal } from './dynamo-client.ts';
import { now } from '../util.ts';
import { latestOfEachBranch, newestFirst, pruneVictims, statusRank } from './pipeline-runs.ts';
import type { PipelineAlert, PipelineRun, PipelineRunsRepository, PipelineStatus, UpsertRunInput } from './pipeline-runs.ts';

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_PROJECTS ?? 'portal-projects';
}

type Item = Record<string, AttributeValue>;

const runKey = (projectId: string, runId: number) => ({ PK: av(`PROJECT#${projectId}`), SK: av(`PRUN#${runId}`) });
const alertKey = (projectId: string, repoId: string, workflowId: number, branch: string) => ({ PK: av(`PROJECT#${projectId}`), SK: av(`PALERT#${repoId}#${workflowId}#${branch}`) });

const optStr = (i: Item, k: string): string | null => getString(i, k);

function toRun(i: Item): PipelineRun {
  return {
    project_id: getString(i, 'project_id') ?? '',
    repo_id: getString(i, 'repo_id') ?? '',
    repo_full_name: getString(i, 'repo_full_name') ?? '',
    run_id: getNumber(i, 'run_id'),
    run_attempt: getNumber(i, 'run_attempt'),
    run_number: getNumber(i, 'run_number'),
    workflow_id: getNumber(i, 'workflow_id'),
    workflow_name: getString(i, 'workflow_name') ?? '',
    branch: getString(i, 'branch') ?? '',
    head_sha: getString(i, 'head_sha') ?? '',
    actor: getString(i, 'actor') ?? '',
    event: getString(i, 'event') ?? '',
    status: (getString(i, 'status') ?? 'other') as PipelineStatus,
    html_url: getString(i, 'html_url') ?? '',
    started_at: optStr(i, 'started_at'),
    completed_at: optStr(i, 'completed_at'),
    inbox_alerted_attempt: getNumber(i, 'inbox_alerted_attempt'),
    chat_alerted_attempt: getNumber(i, 'chat_alerted_attempt'),
    updated_at: getString(i, 'updated_at') ?? '',
  };
}

function toAlert(i: Item): PipelineAlert {
  return {
    project_id: getString(i, 'project_id') ?? '',
    repo_id: getString(i, 'repo_id') ?? '',
    workflow_id: getNumber(i, 'workflow_id'),
    branch: getString(i, 'branch') ?? '',
    open: getNumber(i, 'open') === 1,
    inbox_id: optStr(i, 'inbox_id'),
    last_run_id: getNumber(i, 'last_run_id'),
    last_run_number: getNumber(i, 'last_run_number'),
    failures: getNumber(i, 'failures'),
    updated_at: getString(i, 'updated_at') ?? '',
  };
}

/** The attributes a delivery sets on a run (everything except the key and the alerted attempts). */
function runFields(r: UpsertRunInput, ts: string): Record<string, JsVal> {
  return {
    project_id: r.project_id, repo_id: r.repo_id, repo_full_name: r.repo_full_name, run_id: r.run_id, run_attempt: r.run_attempt,
    run_number: r.run_number, workflow_id: r.workflow_id, workflow_name: r.workflow_name, branch: r.branch, head_sha: r.head_sha,
    actor: r.actor, event: r.event, status: r.status, status_rank: statusRank(r.status), html_url: r.html_url,
    started_at: r.started_at, completed_at: r.completed_at, updated_at: ts,
  };
}

/** Cancellation reason codes of a failed transaction (empty when the error carries none). */
function reasonCodes(e: unknown): string[] {
  const reasons = (e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return Array.isArray(reasons) ? reasons.map((r) => String(r?.Code ?? '')) : [];
}

/**
 * Whether the write collided with another in-flight write (not a failed condition): the item may well still be in the state the
 * caller wanted, so the write is tried again. DynamoDB reports it as TransactionConflict in the cancellation reasons of a cancelled
 * transaction, or as a TransactionConflictException on a plain write.
 */
function isConflict(e: unknown): boolean {
  const name = (e as { name?: string }).name ?? '';
  if (name === 'TransactionConflictException') return true;
  return name === 'TransactionCanceledException' && reasonCodes(e).includes('TransactionConflict');
}

/** A real failed condition: the write did not apply and retrying cannot change that. */
function isCancelled(e: unknown): boolean {
  const name = (e as { name?: string }).name ?? '';
  if (name === 'ConditionalCheckFailedException') return true;
  return name === 'TransactionCanceledException' && !isConflict(e);
}

/** How many times a write that collided with another is tried before the collision is reported as an error. */
const CONFLICT_TRIES = 3;

/** Run a conditional write: true when it applied, false when its condition failed, retrying a collision up to CONFLICT_TRIES times. */
async function conditional(write: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await write();
      return true;
    } catch (e) {
      if (isConflict(e) && attempt < CONFLICT_TRIES) continue;
      if (isCancelled(e)) return false;
      throw e;
    }
  }
}

export class DynamoDbPipelineRunsRepository implements PipelineRunsRepository {
  private readonly client: DynamoDBClient;
  constructor() { this.client = getDynamoDbClient(); }

  /** Create the table when it does not exist (tests; production tables are provisioned elsewhere). */
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
        KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
        AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      }));
      let active = false;
      for (let n = 0; n < 60; n++) {
        await new Promise((r) => setTimeout(r, 500));
        const desc = await this.client.send(new DescribeTableCommand({ TableName: tableName }));
        if (desc.Table?.TableStatus === 'ACTIVE') { active = true; break; }
      }
      if (!active) throw new Error(`Table ${tableName} did not become ACTIVE in time`);
    }
  }

  private async getItem(key: Item): Promise<Item | null> {
    const res = await this.client.send(new GetItemCommand({ TableName: table(), Key: key, ConsistentRead: true }));
    return res.Item ?? null;
  }

  private async partition(projectId: string): Promise<PipelineRun[]> {
    const out: PipelineRun[] = [];
    let lastKey: Item | undefined;
    do {
      const res = await this.client.send(new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ExpressionAttributeValues: { ':pk': av(`PROJECT#${projectId}`), ':p': av('PRUN#') },
        ConsistentRead: true,
        ExclusiveStartKey: lastKey,
      }));
      for (const i of res.Items ?? []) out.push(toRun(i));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return out;
  }

  async upsertRun(r: UpsertRunInput): Promise<{ run: PipelineRun; created: boolean }> {
    const key = runKey(r.project_id, r.run_id);
    for (let attempt = 0; attempt < 5; attempt++) {
      const ts = now();
      const fields = runFields(r, ts);
      const created = await conditional(() => this.client.send(new PutItemCommand({
        TableName: table(),
        Item: { ...key, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, av(v)])), inbox_alerted_attempt: av(0), chat_alerted_attempt: av(0) },
        ConditionExpression: 'attribute_not_exists(PK)',
      })));
      if (created) return { run: toRun((await this.getItem(key)) ?? {}), created: true };

      // Exists: the newer (attempt, status rank) wins, decided by the condition so two racing deliveries cannot leave the older one stored.
      const names: Record<string, string> = { '#attempt': 'run_attempt', '#rank': 'status_rank' };
      const vals: Item = { ':attempt': av(r.run_attempt), ':rank': av(statusRank(r.status)) };
      const sets: string[] = [];
      Object.entries(fields).forEach(([k, v], n) => {
        if (k === 'project_id' || k === 'run_id') return;
        names[`#f${n}`] = k; vals[`:v${n}`] = av(v); sets.push(`#f${n} = :v${n}`);
      });
      await conditional(() => this.client.send(new UpdateItemCommand({
        TableName: table(),
        Key: key,
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(PK) AND (#attempt < :attempt OR (#attempt = :attempt AND #rank <= :rank))',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: vals,
      })));
      const item = await this.getItem(key);
      if (item) return { run: toRun(item), created: false };
      // The row vanished (pruned) between the put and the update: try the put again.
    }
    throw new Error('pipeline runs: upsert did not settle');
  }

  async latestPerBranch(projectId: string): Promise<PipelineRun[]> {
    return latestOfEachBranch(await this.partition(projectId));
  }

  async history(projectId: string, repoId: string, workflowId: number, branch: string, limit: number): Promise<PipelineRun[]> {
    return (await this.partition(projectId))
      .filter((r) => r.repo_id === repoId && r.workflow_id === workflowId && r.branch === branch)
      .sort(newestFirst)
      .slice(0, limit);
  }

  async prune(projectId: string, repoId: string, workflowId: number, keep: number): Promise<number> {
    const runs = (await this.partition(projectId)).filter((r) => r.repo_id === repoId && r.workflow_id === workflowId);
    let deleted = 0;
    for (const v of pruneVictims(runs, keep)) {
      try {
        await this.client.send(new DeleteItemCommand({ TableName: table(), Key: runKey(projectId, v.run_id), ConditionExpression: 'attribute_exists(PK)' }));
        deleted++;
      } catch (e) {
        if (!isCancelled(e)) throw e; // already gone
      }
    }
    return deleted;
  }

  async markAlerted(projectId: string, runId: number, attempt: number, channel: 'inbox' | 'chat'): Promise<boolean> {
    const attr = channel === 'inbox' ? 'inbox_alerted_attempt' : 'chat_alerted_attempt';
    return conditional(() => this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: runKey(projectId, runId),
      UpdateExpression: 'SET #a = :attempt',
      ConditionExpression: 'attribute_exists(PK) AND #a < :attempt',
      ExpressionAttributeNames: { '#a': attr },
      ExpressionAttributeValues: { ':attempt': av(attempt) },
    })));
  }

  async getAlert(projectId: string, repoId: string, workflowId: number, branch: string): Promise<PipelineAlert | null> {
    const item = await this.getItem(alertKey(projectId, repoId, workflowId, branch));
    return item ? toAlert(item) : null;
  }

  async putAlert(a: PipelineAlert, expectedUpdatedAt: string | null): Promise<boolean> {
    const item: Item = {
      ...alertKey(a.project_id, a.repo_id, a.workflow_id, a.branch),
      project_id: av(a.project_id), repo_id: av(a.repo_id), workflow_id: av(a.workflow_id), branch: av(a.branch),
      open: av(a.open ? 1 : 0), inbox_id: av(a.inbox_id), last_run_id: av(a.last_run_id), last_run_number: av(a.last_run_number),
      failures: av(a.failures), updated_at: av(a.updated_at),
    };
    return conditional(() => this.client.send(new PutItemCommand(expectedUpdatedAt == null
      ? { TableName: table(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' }
      : {
        TableName: table(), Item: item, ConditionExpression: 'attribute_exists(PK) AND #u = :expected',
        ExpressionAttributeNames: { '#u': 'updated_at' }, ExpressionAttributeValues: { ':expected': av(expectedUpdatedAt) },
      })));
  }
}
