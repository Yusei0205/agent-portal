import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDbSessionsRepository } from '../server/repositories/sessions-dynamodb.ts';

test('cloud agent history paginates filtered events and orders resumed runs by time', async () => {
  const repo = new DynamoDbSessionsRepository();
  (repo as any).listRunsByWorkflow = async () => [{ id: 'new-run' }, { id: 'old-run' }];
  const queries: any[] = [];
  (repo as any).client = { send: async (command: any) => {
    const q = command.input;
    queries.push(q);
    assert.match(q.FilterExpression, /#eventType IN/);
    assert.equal(q.ScanIndexForward, false);
    const run = q.ExpressionAttributeValues[':pk'].S;
    if (run === 'RUN#new-run' && !q.ExclusiveStartKey) return { Items: [], LastEvaluatedKey: { PK: { S: run }, SK: { S: 'SEQ#000001000' } } };
    return { Items: [{ SK: { S: run === 'RUN#new-run' ? 'SEQ#000000002' : 'SEQ#000002001' }, type: { S: 'subagent-finished' }, payload: { S: '{}' }, created_at: { S: run === 'RUN#new-run' ? '2026-11-08T02:00:00Z' : '2026-11-08T01:00:00Z' } }] };
  } };
  const events = await repo.listWorkflowRunEventsByType('session', ['subagent-started', 'subagent-finished'], 10);
  assert.equal(queries.length, 3, 'continues after an empty filtered page');
  assert.deepEqual(events.map(e => e.run_id), ['new-run', 'old-run']);
});
