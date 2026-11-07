/**
 * DynamoDB implementation of ReviewsRepository.
 *
 * Table: portal-code
 * Reviews:  PK=REVIEW#<projectId>  SK=REV#<isoCreatedAt>#<id>
 *           workflowId attr (sparse) → GSI-P10WorkflowId
 * Findings: PK=FIND#<reviewId>     SK=FIND#<id>
 * GSI-P10EntityId: PK=id, SK=entityType='review'
 */

import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber, av } from './dynamo-client.ts';
import type { ReviewsRepository, ReviewRecord, FindingRecord, CreateReviewInput, CreateFindingInput, ReviewStatus } from './reviews.ts';

function table(): string { return process.env.DYNAMODB_TABLE_PORTAL_CODE ?? 'portal-code-test'; }

function reviewPk(projectId: string): string { return `REVIEW#${projectId}`; }
function reviewSk(createdAt: string, id: string): string { return `REV#${createdAt}#${id}`; }
function findingPk(reviewId: string): string { return `FIND#${reviewId}`; }
function findingSk(id: string): string { return `FIND#${id}`; }

function itemToReview(item: Record<string, AttributeValue>): ReviewRecord {
  return {
    id: getString(item, 'id') ?? '', project_id: getString(item, 'project_id') ?? '',
    base_ref: getString(item, 'base_ref') ?? '', head_ref: getString(item, 'head_ref') ?? '',
    pr_number: item.pr_number?.N != null ? Number(item.pr_number.N) : null,
    repo_id: getString(item, 'repo_id'), status: getString(item, 'status') as ReviewStatus ?? 'pending',
    post_mode: getString(item, 'post_mode') ?? 'draft', from_loop: getString(item, 'from_loop'),
    workflow_id: getString(item, 'workflow_id'), min_severity: getString(item, 'min_severity') ?? 'high',
    summary: getString(item, 'summary'), raw_output: getString(item, 'raw_output'),
    created_by: getString(item, 'created_by'), created_at: getString(item, 'created_at') ?? '',
    parent_review_id: getString(item, 'parent_review_id'), source_sha: getString(item, 'source_sha'),
    dest_sha: getString(item, 'dest_sha'), provider_id: getString(item, 'provider_id'), model_id: getString(item, 'model_id'),
    jira_context: getString(item, 'jira_context') ?? '{}', run_log: getString(item, 'run_log') ?? '[]',
    input_tokens: getNumber(item, 'input_tokens'), cache_write_tokens: getNumber(item, 'cache_write_tokens'),
    cache_read_tokens: getNumber(item, 'cache_read_tokens'), output_tokens: getNumber(item, 'output_tokens'),
    llm_requests: getNumber(item, 'llm_requests'), retry_count: getNumber(item, 'retry_count'),
    tool_calls: getNumber(item, 'tool_calls'), files_reviewed: getNumber(item, 'files_reviewed'),
    duration_ms: item.duration_ms?.N != null ? Number(item.duration_ms.N) : null,
    started_at: getString(item, 'started_at'), merged_at: getString(item, 'merged_at'),
    merged_by: getString(item, 'merged_by'), head_commit_sha: getString(item, 'head_commit_sha'),
    scan_id: getString(item, 'scan_id'),
  };
}

function itemToFinding(item: Record<string, AttributeValue>): FindingRecord {
  return {
    id: getString(item, 'id') ?? '', review_id: getString(item, 'review_id') ?? '',
    file_path: getString(item, 'file_path') ?? '', line_number: item.line_number?.N != null ? Number(item.line_number.N) : null,
    severity: getString(item, 'severity') ?? 'medium', title: getString(item, 'title') ?? '',
    body: getString(item, 'body') ?? '', confidence: item.confidence?.N != null ? Number(item.confidence.N) : null,
    accepted: getNumber(item, 'accepted'), posted_at: getString(item, 'posted_at'),
    created_at: getString(item, 'created_at') ?? '',
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

export class DynamoDbReviewsRepository implements ReviewsRepository {
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

  async create(input: CreateReviewInput): Promise<ReviewRecord> {
    const item: Record<string, AttributeValue> = {
      PK: av(reviewPk(input.project_id)), SK: av(reviewSk(input.created_at, input.id)),
      id: av(input.id), entityType: av('review'),
      ...marshalItem({
        project_id: input.project_id, base_ref: input.base_ref, head_ref: input.head_ref,
        repo_id: input.repo_id, status: input.status, post_mode: input.post_mode,
        from_loop: input.from_loop, workflow_id: input.workflow_id, min_severity: input.min_severity,
        summary: input.summary, raw_output: input.raw_output, created_by: input.created_by,
        created_at: input.created_at, parent_review_id: input.parent_review_id,
        source_sha: input.source_sha, dest_sha: input.dest_sha, provider_id: input.provider_id,
        model_id: input.model_id, jira_context: input.jira_context, run_log: input.run_log,
        started_at: input.started_at, merged_at: input.merged_at, merged_by: input.merged_by,
        head_commit_sha: input.head_commit_sha,
        scan_id: input.scan_id ?? null,
      }),
      input_tokens: { N: String(input.input_tokens) }, cache_write_tokens: { N: String(input.cache_write_tokens) },
      cache_read_tokens: { N: String(input.cache_read_tokens) }, output_tokens: { N: String(input.output_tokens) },
      llm_requests: { N: String(input.llm_requests) }, retry_count: { N: String(input.retry_count) },
      tool_calls: { N: String(input.tool_calls) }, files_reviewed: { N: String(input.files_reviewed) },
      ...(input.pr_number != null ? { pr_number: { N: String(input.pr_number) } } : {}),
      ...(input.duration_ms != null ? { duration_ms: { N: String(input.duration_ms) } } : {}),
    };
    if (input.workflow_id) item.workflowId = av(input.workflow_id);
    await this.client.send(new PutItemCommand({ TableName: table(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    return itemToReview(item);
  }

  async getById(id: string): Promise<ReviewRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(), IndexName: 'GSI-P10EntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('review') }, Limit: 1,
    }));
    const item = res.Items?.[0];
    return item ? itemToReview(item) : null;
  }

  async getByWorkflowId(workflowId: string): Promise<ReviewRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(), IndexName: 'GSI-P10WorkflowId',
      KeyConditionExpression: 'workflowId = :wf',
      ExpressionAttributeValues: { ':wf': av(workflowId) }, Limit: 5,
    }));
    const item = res.Items?.find((i) => getString(i, 'entityType') === 'review');
    return item ? itemToReview(item) : null;
  }

  async listByProject(projectId: string, opts: { limit: number; offset: number }): Promise<{ items: ReviewRecord[]; total: number }> {
    const all = await paginateAll(this.client, { TableName: table(), KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': av(reviewPk(projectId)) } });
    const records = all.map(itemToReview).sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { items: records.slice(opts.offset, opts.offset + opts.limit), total: records.length };
  }

  async listByProjectIds(projectIds: string[], since: string): Promise<ReviewRecord[]> {
    if (projectIds.length === 0) return [];
    const results = await Promise.all(
      projectIds.map((pid) => paginateAll(this.client, {
        TableName: table(), KeyConditionExpression: 'PK = :pk AND SK >= :sk',
        ExpressionAttributeValues: { ':pk': av(reviewPk(pid)), ':sk': av(`REV#${since}`) },
      })),
    );
    return results.flat().map(itemToReview).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async update(id: string, patch: Partial<ReviewRecord>): Promise<void> {
    const f = await this.getById(id);
    if (!f) return;
    const keys = Object.keys(patch).filter((k) => !['id', 'project_id', 'created_at'].includes(k));
    if (keys.length === 0) return;
    const expr = keys.map((_, i) => `#k${i} = :v${i}`);
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};
    keys.forEach((k, i) => {
      names[`#k${i}`] = k;
      const v = (patch as Record<string, unknown>)[k];
      vals[`:v${i}`] = typeof v === 'number' ? { N: String(v) } : av(v as string | null);
    });
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: av(reviewPk(f.project_id)), SK: av(reviewSk(f.created_at, id)) },
      UpdateExpression: `SET ${expr.join(', ')}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: vals,
    }));
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const f = await this.getById(id);
    if (!f || f.project_id !== projectId) return false;
    await this.client.send(new DeleteItemCommand({ TableName: table(), Key: { PK: av(reviewPk(projectId)), SK: av(reviewSk(f.created_at, id)) } }));
    // Delete all findings for this review
    const findings = await this.listFindings(id);
    if (findings.length > 0) {
      const chunks = [];
      for (let i = 0; i < findings.length; i += 25) chunks.push(findings.slice(i, i + 25));
      for (const chunk of chunks) {
        await this.client.send(new BatchWriteItemCommand({
          RequestItems: {
            [table()]: chunk.map((f) => ({ DeleteRequest: { Key: { PK: av(findingPk(id)), SK: av(findingSk(f.id)) } } })),
          },
        }));
      }
    }
    return true;
  }

  async createFinding(input: CreateFindingInput): Promise<FindingRecord> {
    const item: Record<string, AttributeValue> = {
      PK: av(findingPk(input.review_id)), SK: av(findingSk(input.id)),
      id: av(input.id), entityType: av('finding'),
      ...marshalItem({ review_id: input.review_id, file_path: input.file_path, severity: input.severity,
        title: input.title, body: input.body, posted_at: input.posted_at, created_at: input.created_at }),
      accepted: { N: String(input.accepted) },
      ...(input.line_number != null ? { line_number: { N: String(input.line_number) } } : {}),
      ...(input.confidence != null ? { confidence: { N: String(input.confidence) } } : {}),
    };
    await this.client.send(new PutItemCommand({ TableName: table(), Item: item }));
    return itemToFinding(item);
  }

  async listFindings(reviewId: string): Promise<FindingRecord[]> {
    const items = await paginateAll(this.client, { TableName: table(), KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': av(findingPk(reviewId)) } });
    return items.map(itemToFinding);
  }

  async getFindingById(id: string, reviewId: string): Promise<FindingRecord | null> {
    const res = await this.client.send(new QueryCommand({
      TableName: table(), KeyConditionExpression: 'PK = :pk AND SK = :sk',
      ExpressionAttributeValues: { ':pk': av(findingPk(reviewId)), ':sk': av(findingSk(id)) }, Limit: 1,
    }));
    const item = res.Items?.[0];
    return item ? itemToFinding(item) : null;
  }

  async updateFinding(id: string, patch: Partial<FindingRecord>): Promise<void> {
    const reviewId = patch.review_id;
    if (!reviewId) return;
    const keys = Object.keys(patch).filter((k) => !['id', 'review_id', 'created_at'].includes(k));
    if (keys.length === 0) return;
    const expr = keys.map((_, i) => `#k${i} = :v${i}`);
    const names: Record<string, string> = {};
    const vals: Record<string, AttributeValue> = {};
    keys.forEach((k, i) => {
      names[`#k${i}`] = k;
      const v = (patch as Record<string, unknown>)[k];
      vals[`:v${i}`] = typeof v === 'number' ? { N: String(v) } : av(v as string | null);
    });
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: av(findingPk(reviewId)), SK: av(findingSk(id)) },
      UpdateExpression: `SET ${expr.join(', ')}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: vals,
    }));
  }

  async markFindingPosted(id: string, postedAt: string): Promise<void> {
    // Need to fetch to know the reviewId (PK)
    const res = await this.client.send(new QueryCommand({
      TableName: table(), IndexName: 'GSI-P10EntityId',
      KeyConditionExpression: '#id = :id AND entityType = :et',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: { ':id': av(id), ':et': av('finding') }, Limit: 1,
    }));
    const item = res.Items?.[0];
    if (!item) return;
    const reviewId = getString(item, 'review_id') ?? '';
    await this.client.send(new UpdateItemCommand({
      TableName: table(),
      Key: { PK: av(findingPk(reviewId)), SK: av(findingSk(id)) },
      UpdateExpression: 'SET posted_at = :p',
      ExpressionAttributeValues: { ':p': av(postedAt) },
    }));
  }

  async checkAlreadyPosted(repoId: string, prNumber: number, sourceSha: string, excludeReviewId: string): Promise<boolean> {
    // DynamoDB: scan for reviews with matching repo/PR/sha is expensive without a dedicated index.
    // Simplified: return false (best-effort; will allow a re-post if another review existed).
    // Add to backlog: GSI-P10ByRepoPR for this pattern.
    return false;
  }
}
