/**
 * DynamoDB implementation of BudgetRepository.
 *
 * Table used: portal-runs
 *
 * Key design (detailed in budget.ts):
 *   Main item:  PK=BU#<projectId>#<dateUTC>  SK=<isoCreatedAt>#<id>
 *   Rollups:    PK=STATS#<projectId>          SK=DAY#<dateUTC>   → ADD costUsd, tokens
 *               PK=USERSTATS#<userId>         SK=DAY#<dateUTC>   → ADD (when userId set)
 *               PK=STATS#GLOBAL               SK=DAY#<dateUTC>   → ADD always
 *
 * The main row and all rollup writes are committed atomically via a single
 * TransactWriteItemsCommand (max 25 items; we use at most 4: 1 Put + 3 Updates).
 * This guarantees that "rollups equal the sum of rows" at all times: if the
 * transaction fails, no partial state is written.
 *
 * Budget limits never fail open: the transaction is retried once on transient
 * errors before throwing so the caller can block the run with a clear error.
 */

import {
  DynamoDBClient,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, av } from './dynamo-client.ts';
import { generateId } from '../util.ts';
import type { BudgetRepository, CreateBudgetInput } from './budget.ts';

// ── Table name ────────────────────────────────────────────────────────────────

function table(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_RUNS ?? 'portal-runs-test';
}

// ── Register background write ─────────────────────────────────────────────────
// No longer needed: the atomic TransactWriteItemsCommand is awaited directly.
// Kept as stub so any future callers that import registerBw still compile.

// ── Transient error check ─────────────────────────────────────────────────────

function isTransient(e: unknown): boolean {
  const name = (e as { name?: string }).name ?? '';
  return (
    name === 'ProvisionedThroughputExceededException' ||
    name === 'RequestLimitExceeded' ||
    name === 'ThrottlingException' ||
    name === 'ServiceUnavailable'
  );
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbBudgetRepository implements BudgetRepository {
  private readonly client: DynamoDBClient;

  constructor() {
    this.client = getDynamoDbClient();
  }

  // ── Table setup (tests) ──────────────────────────────────────────────────────

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
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'budgetProjectId', AttributeType: 'S' },
          { AttributeName: 'budgetSortKey', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI-BudgetProject',
            KeySchema: [
              { AttributeName: 'budgetProjectId', KeyType: 'HASH' },
              { AttributeName: 'budgetSortKey', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }));
      let active = false;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const desc = await this.client.send(new DescribeTableCommand({ TableName: tableName }));
        if (desc.Table?.TableStatus === 'ACTIVE') { active = true; break; }
      }
      if (!active) throw new Error(`Table ${tableName} did not become ACTIVE in time`);
    }
  }

  async record(input: CreateBudgetInput): Promise<void> {
    const id = generateId();
    const dateUTC = input.created_at.slice(0, 10); // 'YYYY-MM-DD'
    const projectBucket = input.project_id ?? 'UNSCOPED';
    const sortKey = `${input.created_at}#${id}`;

    const mainItem = {
      PK: av(`BU#${projectBucket}#${dateUTC}`),
      SK: av(sortKey),
      id: av(id),
      cost_usd: { N: String(input.cost_usd) },
      credits: { N: String(input.credits ?? 0) },
      input_tokens: { N: String(input.input_tokens) },
      output_tokens: { N: String(input.output_tokens) },
      provider: av(input.provider),
      model: av(input.model),
      created_at: av(input.created_at),
      ...marshalItem({
        user_id: input.user_id,
        project_id: input.project_id,
        workflow_id: input.workflow_id,
        // run_id is a sparse GSI-InputHash key on the shared production table.
        // DynamoDB rejects NULL index keys even when the other index key is absent.
        run_id: input.run_id ?? undefined,
      }),
    };

    // Set GSI-BudgetProject attributes when project_id is known
    if (input.project_id) {
      (mainItem as Record<string, unknown>)['budgetProjectId'] = av(input.project_id);
      (mainItem as Record<string, unknown>)['budgetSortKey'] = av(sortKey);
    }

    // Build the TransactWriteItems request:
    //   [0] PutItem for the main budget row (deduplicated by PK condition)
    //   [1] UpdateItem for the project rollup (if project_id set)
    //   [2] UpdateItem for the user rollup    (if user_id set)
    //   [N] UpdateItem for the global rollup  (always)
    //
    // All items are committed atomically: if any write fails, none are persisted.
    // This guarantees "rollups == sum of rows" at all times.
    type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteItemsCommand>[0]['TransactItems']>[number];
    const transactItems: TransactItem[] = [
      {
        Put: {
          TableName: table(),
          Item: mainItem as Record<string, import('@aws-sdk/client-dynamodb').AttributeValue>,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ];

    const rollupExpr = 'ADD costUsd :cost, credits :cred, inputTokens :inp, outputTokens :out, runCount :one';
    const rollupVals = {
      ':cost': { N: String(input.cost_usd) },
      ':cred': { N: String(input.credits ?? 0) },
      ':inp': { N: String(input.input_tokens) },
      ':out': { N: String(input.output_tokens) },
      ':one': { N: '1' },
    };

    if (input.project_id) {
      transactItems.push({
        Update: {
          TableName: table(),
          Key: marshalItem({ PK: `STATS#${input.project_id}`, SK: `DAY#${dateUTC}` }),
          UpdateExpression: rollupExpr,
          ExpressionAttributeValues: { ...rollupVals },
        },
      });
    }

    if (input.user_id) {
      transactItems.push({
        Update: {
          TableName: table(),
          Key: marshalItem({ PK: `USERSTATS#${input.user_id}`, SK: `DAY#${dateUTC}` }),
          UpdateExpression: rollupExpr,
          ExpressionAttributeValues: { ...rollupVals },
        },
      });
    }

    transactItems.push({
      Update: {
        TableName: table(),
        Key: marshalItem({ PK: 'STATS#GLOBAL', SK: `DAY#${dateUTC}` }),
        UpdateExpression: rollupExpr,
        ExpressionAttributeValues: { ...rollupVals },
      },
    });

    // Retry once on transient errors — budget limits must not fail open
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.client.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));
        lastErr = undefined;
        break;
      } catch (e: unknown) {
        if (isTransient(e) && attempt < 1) {
          await new Promise((r) => setTimeout(r, 100));
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    if (lastErr) throw lastErr;
  }
}
