import { describe, before, after, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { insert } from '../server/db.ts';
import { SqliteAutomationsRepository, type AutomationsRepository } from '../server/repositories/automations.ts';
import { generateId, now } from '../server/util.ts';

function contract(make: () => Promise<AutomationsRepository>) {
  let repo: AutomationsRepository; const project = generateId();
  before(async () => { repo = await make(); });
  it('creates once, isolates projects, and filters entity prefixes', async () => {
    const value = { revision: 1, name: 'draft', graph: { secret: 'none' } };
    assert.equal(await repo.put(project, 'DEF#a', value, null), true);
    assert.equal(await repo.put(project, 'DEF#a', { ...value, name: 'overwritten' }, null), false);
    assert.deepEqual(await repo.get(project, 'DEF#a'), value);
    assert.equal(await repo.get('other-project', 'DEF#a'), null);
    await repo.put(project, 'RUN#b', { revision: 1, status: 'waiting' }, null);
    assert.equal((await repo.list(project, 'DEF#')).length, 1);
    assert.equal((await repo.list(project, 'RUN#')).length, 1);
  });
  it('admits exactly one concurrent transition and preserves the winner', async () => {
    const values = [{ revision: 2, winner: 'a' }, { revision: 2, winner: 'b' }];
    const results = await Promise.all(values.map((v) => repo.put(project, 'DEF#a', v, 1)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(await repo.get(project, 'DEF#a'), values[results.indexOf(true)]);
    assert.equal(await repo.put(project, 'DEF#a', { revision: 3 }, 1), false);
    assert.equal(await repo.put(project, 'DEF#missing', { revision: 2 }, 1), false);
  });
  it('rejects oversized records before they reach DynamoDB limits', async () => {
    await assert.rejects(repo.put(project, 'DEF#big', { revision: 1, payload: 'x'.repeat(300_000) }, null), /300 KB/);
  });
  return project;
}
describe('SQLite automation records', () => {
  before(() => createTestDb()); after(async () => cleanup());
  const project = contract(async () => new SqliteAutomationsRepository());
  before(() => { insert('projects', { id: project, slug: project, name: 'automation', description: '', notes: '', created_at: now() }); });
});
describe('DynamoDB automation records', { skip: !process.env.DYNAMODB_ENDPOINT }, () => {
  const table = `portal-code-automation-${Date.now()}`;
  const original = process.env.DYNAMODB_TABLE_PORTAL_CODE;
  let client: any;
  before(async () => {
    process.env.DYNAMODB_TABLE_PORTAL_CODE = table;
    const { getDynamoDbClient } = await import('../server/repositories/dynamo-client.ts'); client = getDynamoDbClient();
    const { CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
    await client.send(new CreateTableCommand({ TableName: table, BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }], AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }] }));
  });
  after(async () => {
    try { const { DeleteTableCommand } = await import('@aws-sdk/client-dynamodb'); await client?.send(new DeleteTableCommand({ TableName: table })); }
    finally { if (original === undefined) delete process.env.DYNAMODB_TABLE_PORTAL_CODE; else process.env.DYNAMODB_TABLE_PORTAL_CODE = original; }
  });
  contract(async () => { const { DynamoAutomationsRepository } = await import('../server/repositories/automations-dynamodb.ts'); return new DynamoAutomationsRepository(); });
});
if (process.env.REQUIRE_DYNAMODB && !process.env.DYNAMODB_ENDPOINT) throw new Error('DYNAMODB_ENDPOINT required');
