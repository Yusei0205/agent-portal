/**
 * DynamoDB implementation of AutofixFindingsRepository.
 *
 * Table: portal-projects (DYNAMODB_TABLE_PORTAL_PROJECTS, default 'portal-projects'). See autofix-findings.ts for the
 * key design. A transition is one conditional write on the finding's status; the workflow lookup item is written in
 * the same transaction when the patch sets workflow_id.
 */

import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, getString, getNumber, av } from './dynamo-client.ts';
import type { JsVal } from './dynamo-client.ts';
import { generateId, now } from '../util.ts';
import { FINDING_STATUSES, PATCHABLE_FIELDS } from './autofix-findings.ts';
import type { AutofixFinding, AutofixFindingsRepository, FindingPatch, FindingStatus, UpsertFindingInput } from './autofix-findings.ts';

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_PROJECTS ?? 'portal-projects';
}

type Item = Record<string, AttributeValue>;

const findingKey = (projectId: string, id: string) => ({ PK: av(`PROJECT#${projectId}`), SK: av(`AFIND#${id}`) });
const fpKey = (projectId: string, fp: string) => ({ PK: av(`PROJECT#${projectId}`), SK: av(`AFFP#${fp}`) });
const idKey = (id: string) => ({ PK: av(`AFID#${id}`), SK: av('#META') });
const workflowKey = (workflowId: string) => ({ PK: av(`AFWF#${workflowId}`), SK: av('#META') });

const optNum = (i: Item, k: string): number | null => (i[k] && i[k].N != null ? Number(i[k].N) : null);

function toFinding(i: Item): AutofixFinding {
  return {
    id: getString(i, 'id') ?? '',
    project_id: getString(i, 'project_id') ?? '',
    source: (getString(i, 'source') ?? 'ci_failed') as AutofixFinding['source'],
    kind: getString(i, 'kind') ?? '',
    fingerprint: getString(i, 'fingerprint') ?? '',
    severity: (getString(i, 'severity') ?? 'medium') as AutofixFinding['severity'],
    evidence: getString(i, 'evidence') ?? '',
    status: (getString(i, 'status') ?? 'new') as FindingStatus,
    repo_id: getString(i, 'repo_id'),
    branch: getString(i, 'branch'),
    commit_sha: getString(i, 'commit_sha'),
    workflow_id: getString(i, 'workflow_id'),
    fix_branch: getString(i, 'fix_branch'),
    pr_number: optNum(i, 'pr_number'),
    pr_url: getString(i, 'pr_url'),
    attempts: getNumber(i, 'attempts'),
    occurrences: getNumber(i, 'occurrences'),
    cost_usd: getNumber(i, 'cost_usd'),
    cooldown_until: getString(i, 'cooldown_until'),
    pr_branch: getString(i, 'pr_branch'),
    pr_head_sha: getString(i, 'pr_head_sha'),
    previous_attempt: getString(i, 'previous_attempt'),
    created_at: getString(i, 'created_at') ?? '',
    updated_at: getString(i, 'updated_at') ?? '',
  };
}

function findingItem(f: AutofixFinding): Item {
  const attrs: Record<string, JsVal> = { ...f };
  const item: Item = { ...findingKey(f.project_id, f.id) };
  for (const [k, v] of Object.entries(attrs)) item[k] = av(v);
  return item;
}

/** Cancellation reason codes of a failed transaction (empty when the error carries none). */
function reasonCodes(e: unknown): string[] {
  const reasons = (e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return Array.isArray(reasons) ? reasons.map((r) => String(r?.Code ?? '')) : [];
}

/**
 * Whether the write collided with another in-flight write (not a failed condition): the item may well still be in the state the
 * caller wanted, so the write is tried again. DynamoDB reports it as TransactionConflict in the cancellation reasons of a cancelled
 * transaction, or as a TransactionConflictException on a plain update.
 */
function isConflict(e: unknown): boolean {
  const name = (e as { name?: string }).name ?? '';
  if (name === 'TransactionConflictException') return true;
  return name === 'TransactionCanceledException' && reasonCodes(e).includes('TransactionConflict');
}

/** A real failed condition (the status or the key was not as required): the write did not apply and retrying cannot change that. */
function isCancelled(e: unknown): boolean {
  const name = (e as { name?: string }).name ?? '';
  if (name === 'ConditionalCheckFailedException') return true;
  // A transaction cancelled for a conflict is not a failed condition, even when another item of it also failed.
  return name === 'TransactionCanceledException' && !isConflict(e);
}

/** How many times a write that collided with another is tried before the collision is reported as an error. */
const CONFLICT_TRIES = 3;

export class DynamoDbAutofixFindingsRepository implements AutofixFindingsRepository {
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

  private async partition(projectId: string): Promise<AutofixFinding[]> {
    const out: AutofixFinding[] = [];
    let lastKey: Item | undefined;
    do {
      const res = await this.client.send(new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ExpressionAttributeValues: { ':pk': av(`PROJECT#${projectId}`), ':p': av('AFIND#') },
        ConsistentRead: true,
        ExclusiveStartKey: lastKey,
      }));
      for (const i of res.Items ?? []) out.push(toFinding(i));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return out;
  }

  private async bumpOccurrences(projectId: string, id: string): Promise<AutofixFinding | null> {
    try {
      const res = await this.client.send(new UpdateItemCommand({
        TableName: table(),
        Key: findingKey(projectId, id),
        UpdateExpression: 'ADD occurrences :one SET updated_at = :now',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':one': { N: '1' }, ':now': av(now()) },
        ReturnValues: 'ALL_NEW',
      }));
      return res.Attributes ? toFinding(res.Attributes) : null;
    } catch (e) {
      if (isCancelled(e)) return null;
      throw e;
    }
  }

  async upsertByFingerprint(i: UpsertFindingInput): Promise<{ finding: AutofixFinding; created: boolean }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const dedupe = await this.getItem(fpKey(i.project_id, i.fingerprint));
      if (dedupe) {
        const bumped = await this.bumpOccurrences(i.project_id, getString(dedupe, 'id') ?? '');
        if (bumped) return { finding: bumped, created: false };
        continue;
      }
      const ts = now();
      const finding: AutofixFinding = {
        id: generateId(), project_id: i.project_id, source: i.source, kind: i.kind, fingerprint: i.fingerprint,
        severity: i.severity, evidence: i.evidence, status: 'new', repo_id: i.repo_id, branch: i.branch,
        commit_sha: i.commit_sha, workflow_id: null, fix_branch: null, pr_number: null, pr_url: null, attempts: 0,
        occurrences: 1, cost_usd: 0, cooldown_until: null, pr_branch: null, pr_head_sha: null, previous_attempt: null,
        created_at: ts, updated_at: ts,
      };
      try {
        await this.client.send(new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: table(), Item: findingItem(finding), ConditionExpression: 'attribute_not_exists(PK)' } },
            {
              Put: {
                TableName: table(),
                Item: { ...fpKey(i.project_id, i.fingerprint), id: av(finding.id), project_id: av(i.project_id), fingerprint: av(i.fingerprint) },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            { Put: { TableName: table(), Item: { ...idKey(finding.id), project_id: av(i.project_id) } } },
          ],
        }));
        return { finding, created: true };
      } catch (e) {
        if (!isCancelled(e)) throw e; // lost the race to another writer: loop and count an occurrence on theirs
      }
    }
    throw new Error('autofix findings: upsert did not settle');
  }

  async getById(id: string): Promise<AutofixFinding | null> {
    // Findings are keyed by project, so an id alone goes through the id lookup item written at creation.
    const lookup = await this.getItem(idKey(id));
    if (!lookup) return null;
    const projectId = getString(lookup, 'project_id');
    if (!projectId) return null;
    const item = await this.getItem(findingKey(projectId, id));
    return item ? toFinding(item) : null;
  }

  async getByFingerprint(projectId: string, fp: string): Promise<AutofixFinding | null> {
    const dedupe = await this.getItem(fpKey(projectId, fp));
    const id = dedupe ? getString(dedupe, 'id') : null;
    if (!id) return null;
    const item = await this.getItem(findingKey(projectId, id));
    return item ? toFinding(item) : null;
  }

  async getByFixBranch(projectId: string, branch: string): Promise<AutofixFinding | null> {
    const matches = (await this.partition(projectId)).filter((f) => f.fix_branch === branch);
    matches.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    return matches[0] ?? null;
  }

  async getByWorkflowId(workflowId: string): Promise<AutofixFinding | null> {
    const lookup = await this.getItem(workflowKey(workflowId));
    if (!lookup) return null;
    const projectId = getString(lookup, 'project_id');
    const id = getString(lookup, 'id');
    if (!projectId || !id) return null;
    const item = await this.getItem(findingKey(projectId, id));
    const f = item ? toFinding(item) : null;
    return f && f.workflow_id === workflowId ? f : null; // a later transition may have pointed the finding elsewhere
  }

  async list(projectId: string, o: { status?: FindingStatus; limit: number }): Promise<AutofixFinding[]> {
    const rows = (await this.partition(projectId)).filter((f) => !o.status || f.status === o.status);
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    return rows.slice(0, o.limit);
  }

  async transition(id: string, from: FindingStatus[], patch: FindingPatch): Promise<boolean> {
    if (from.length === 0) return false;
    const lookup = await this.getItem(idKey(id));
    const projectId = lookup ? getString(lookup, 'project_id') : null;
    if (!projectId) return false;

    const values: Record<string, JsVal> = { ...(patch as Record<string, JsVal>) };
    if (values.updated_at === undefined) values.updated_at = now();
    const keys = PATCHABLE_FIELDS.filter((k) => values[k] !== undefined);
    const names: Record<string, string> = { '#status': 'status' };
    const vals: Item = {};
    from.forEach((s, n) => { vals[`:from${n}`] = av(s); });
    const sets = keys.map((k, n) => { names[`#k${n}`] = k; vals[`:v${n}`] = av(values[k]); return `#k${n} = :v${n}`; });

    const update = {
      TableName: table(),
      Key: findingKey(projectId, id),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: `attribute_exists(PK) AND #status IN (${from.map((_, n) => `:from${n}`).join(', ')})`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: vals,
    };
    const workflowId = typeof values.workflow_id === 'string' && values.workflow_id ? values.workflow_id : null;
    for (let attempt = 1; ; attempt++) {
      try {
        if (workflowId) {
          await this.client.send(new TransactWriteItemsCommand({
            TransactItems: [
              { Update: update },
              { Put: { TableName: table(), Item: { ...workflowKey(workflowId), project_id: av(projectId), id: av(id) } } },
            ],
          }));
        } else {
          await this.client.send(new UpdateItemCommand(update));
        }
        return true;
      } catch (e) {
        // A conflict says nothing about the status: try again; after the last try the error is reported (the write did not apply).
        if (isConflict(e) && attempt < CONFLICT_TRIES) continue;
        if (isCancelled(e)) return false;
        throw e;
      }
    }
  }

  async countByStatus(projectId: string): Promise<Record<FindingStatus, number>> {
    const out = Object.fromEntries(FINDING_STATUSES.map((s) => [s, 0])) as Record<FindingStatus, number>;
    for (const f of await this.partition(projectId)) out[f.status] = (out[f.status] ?? 0) + 1;
    return out;
  }

  async sumCostSince(projectId: string, sinceIso: string): Promise<number> {
    let total = 0;
    for (const f of await this.partition(projectId)) if (f.updated_at >= sinceIso) total += f.cost_usd;
    return total;
  }
}
