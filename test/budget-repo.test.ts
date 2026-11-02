/**
 * Contract tests for BudgetRepository.
 *
 * The same assertions run against both SQLite and DynamoDB implementations.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to turn the skip into a failure.
 *
 * To run locally (PowerShell 5.1 — no &&):
 *   docker run -d --rm --name ddb-budget -p 8000:8000 amazon/dynamodb-local
 *   $env:DYNAMODB_ENDPOINT='http://localhost:8000'; $env:REQUIRE_DYNAMODB='1'
 *   npm run test:affected -- --module budget --backend-only
 *   docker stop ddb-budget
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteBudgetRepository } from '../server/repositories/budget-sqlite.ts';
import type { BudgetRepository } from '../server/repositories/budget.ts';
import { clearBudgetRepository } from '../server/repositories/budget.ts';
import { now } from '../server/util.ts';
import { one } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

// ── Shared contract suite ─────────────────────────────────────────────────────

function runContract(label: string, makeRepo: () => Promise<BudgetRepository>): void {
  describe(`${label} -- BudgetRepository contract`, () => {
    let repo: BudgetRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;

    before(async () => {
      repo = await makeRepo();
    });

    after(() => {
      clearBudgetRepository();
    });

    test('record -- stores a budget entry', async () => {
      const workflowTag = `wf-budget-${sfx}`;
      await repo.record({
        user_id: null,
        project_id: null,
        workflow_id: null,
        run_id: null,
        cost_usd: 1.5,
        input_tokens: 100,
        output_tokens: 50,
        provider: 'test',
        model: workflowTag,
        created_at: now(),
      });
      // Verify (SQLite only — DynamoDB verified through rollup assertions)
      if (label === 'SQLite') {
        const row = one<{ cost_usd: number }>(`SELECT cost_usd FROM budget_usage WHERE model = ?`, workflowTag);
        assert.ok(row, 'budget_usage row should exist');
        assert.ok(Math.abs(Number(row.cost_usd) - 1.5) < 0.001, 'cost_usd should match');
      } else {
        assert.ok(true, 'record succeeded');
      }
    });

    test('record -- handles zero cost', async () => {
      await assert.doesNotReject(() =>
        repo.record({
          user_id: null,
          project_id: null,
          workflow_id: null,
          run_id: null,
          cost_usd: 0,
          input_tokens: 0,
          output_tokens: 0,
          provider: 'test',
          model: 'test-model',
          created_at: now(),
        }),
      );
    });

    test('record -- multiple entries accumulate (SQLite rollup matches)', async () => {
      if (label !== 'SQLite') {
        return;
      }
      const modelTag = `acc-${sfx}`;
      const ts = now();
      await repo.record({ user_id: null, project_id: null, workflow_id: null, run_id: null, cost_usd: 1.0, input_tokens: 100, output_tokens: 50, provider: 'test', model: modelTag, created_at: ts });
      await repo.record({ user_id: null, project_id: null, workflow_id: null, run_id: null, cost_usd: 2.5, input_tokens: 200, output_tokens: 100, provider: 'test', model: modelTag, created_at: ts });

      const agg = one<{ total_cost: number; total_input: number; total_output: number }>(
        `SELECT
           COALESCE(SUM(cost_usd), 0)     AS total_cost,
           COALESCE(SUM(input_tokens), 0) AS total_input,
           COALESCE(SUM(output_tokens), 0) AS total_output
         FROM budget_usage WHERE model = ?`,
        modelTag,
      );
      assert.ok(agg, 'aggregate row should exist');
      assert.ok(Math.abs(Number(agg.total_cost) - 3.5) < 0.001, 'total cost should be 3.5');
      assert.equal(Number(agg.total_input), 300, 'total input tokens should be 300');
      assert.equal(Number(agg.total_output), 150, 'total output tokens should be 150');
    });

    test('record -- DynamoDB rollup counters are written', async () => {
      if (label !== 'DynamoDB') return;

      const { getDynamoDbClient, marshalItem, getNumber } = await import('../server/repositories/dynamo-client.ts');
      const { GetItemCommand } = await import('@aws-sdk/client-dynamodb');
      const client = getDynamoDbClient();
      const tableName = process.env.DYNAMODB_TABLE_PORTAL_RUNS ?? 'portal-runs-test';

      const projectId = `proj-rollup-${sfx}`;
      const ts = now();
      const date = ts.slice(0, 10);

      await repo.record({ user_id: null, project_id: projectId, workflow_id: null, run_id: null, cost_usd: 2.0, input_tokens: 200, output_tokens: 100, provider: 'test', model: 'm', created_at: ts });
      await repo.record({ user_id: null, project_id: projectId, workflow_id: null, run_id: null, cost_usd: 3.0, input_tokens: 300, output_tokens: 150, provider: 'test', model: 'm', created_at: ts });

      // Check project rollup
      const projRollup = await client.send(new GetItemCommand({
        TableName: tableName,
        Key: marshalItem({ PK: `STATS#${projectId}`, SK: `DAY#${date}` }),
      }));
      assert.ok(projRollup.Item, 'project rollup item should exist');
      const projCost = getNumber(projRollup.Item, 'costUsd');
      assert.ok(projCost >= 5.0, `project rollup costUsd should be >= 5.0 (got ${projCost})`);

      // Check global rollup
      const globalRollup = await client.send(new GetItemCommand({
        TableName: tableName,
        Key: marshalItem({ PK: 'STATS#GLOBAL', SK: `DAY#${date}` }),
      }));
      assert.ok(globalRollup.Item, 'global rollup item should exist');
    });

    test('record -- DynamoDB rollups equal the sum of rows (atomicity contract)', async () => {
      if (label !== 'DynamoDB') return;

      const { getDynamoDbClient, marshalItem, getNumber } = await import('../server/repositories/dynamo-client.ts');
      const { GetItemCommand } = await import('@aws-sdk/client-dynamodb');
      const client = getDynamoDbClient();
      const tableName = process.env.DYNAMODB_TABLE_PORTAL_RUNS ?? 'portal-runs-test';

      const projectId = `proj-atomic-${sfx}`;
      const ts1 = new Date(Date.now() - 2000).toISOString();
      const ts2 = new Date(Date.now() - 1000).toISOString();
      const ts3 = now();
      const date = ts1.slice(0, 10);

      // Write 3 rows in sequence
      await repo.record({ user_id: null, project_id: projectId, workflow_id: null, run_id: null, cost_usd: 1.0, input_tokens: 100, output_tokens: 50, provider: 'test', model: 'm', created_at: ts1 });
      await repo.record({ user_id: null, project_id: projectId, workflow_id: null, run_id: null, cost_usd: 2.0, input_tokens: 200, output_tokens: 100, provider: 'test', model: 'm', created_at: ts2 });
      await repo.record({ user_id: null, project_id: projectId, workflow_id: null, run_id: null, cost_usd: 3.0, input_tokens: 300, output_tokens: 150, provider: 'test', model: 'm', created_at: ts3 });

      // Rollup must equal sum of rows (atomicity: TransactWriteItems ensures no partial state)
      const projRollup = await client.send(new GetItemCommand({
        TableName: tableName,
        Key: marshalItem({ PK: `STATS#${projectId}`, SK: `DAY#${date}` }),
      }));
      assert.ok(projRollup.Item, 'project rollup should exist');
      const runCount = getNumber(projRollup.Item, 'runCount');
      const totalCost = getNumber(projRollup.Item, 'costUsd');
      const totalInput = getNumber(projRollup.Item, 'inputTokens');
      const totalOutput = getNumber(projRollup.Item, 'outputTokens');
      assert.equal(runCount, 3, `runCount should be 3 (got ${runCount})`);
      assert.ok(Math.abs(totalCost - 6.0) < 0.001, `totalCost should be 6.0 (got ${totalCost})`);
      assert.equal(totalInput, 600, `totalInput should be 600 (got ${totalInput})`);
      assert.equal(totalOutput, 300, `totalOutput should be 300 (got ${totalOutput})`);
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

describe('SQLite suite', () => {
  before(async () => {
    await createTestDb();
  });
  after(cleanup);
  runContract('SQLite', async () => new SqliteBudgetRepository());
});

// ── DynamoDB Local suite ──────────────────────────────────────────────────────

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB === '1') {
      throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT is not set');
    }
    test.skip('DynamoDB Local not available — set DYNAMODB_ENDPOINT to run');
    return;
  }

  let repo: import('../server/repositories/budget-dynamodb.ts').DynamoDbBudgetRepository;

  before(async () => {
    const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
    clearDynamoDbClient();
    process.env.DYNAMODB_TABLE_PORTAL_RUNS = `portal-runs-budget-test-${RUN_TAG}`;
    const { DynamoDbBudgetRepository } = await import('../server/repositories/budget-dynamodb.ts');
    repo = new DynamoDbBudgetRepository();
    await repo.ensureTables();
  });

  after(async () => {
    delete process.env.DYNAMODB_TABLE_PORTAL_RUNS;
    const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
    clearDynamoDbClient();
    clearBudgetRepository();
  });

  runContract('DynamoDB', async () => repo);
});
