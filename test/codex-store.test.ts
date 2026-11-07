import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoCodexStore } from '../server/repositories/codex-store.ts';

const endpoint = process.env.DYNAMODB_ENDPOINT;
it('coordinates Codex credentials and callback consumption across DynamoDB clients', { skip: !endpoint }, async () => {
  // This test creates and deletes a temporary table only on DynamoDB Local.
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(endpoint!).hostname));
  const options = { endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } };
  const clientA = new DynamoDBClient(options), clientB = new DynamoDBClient(options);
  const table = 'codex-test-' + randomUUID();
  await clientA.send(new CreateTableCommand({ TableName: table, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }] }));
  try {
    const a = new DynamoCodexStore(clientA, table), b = new DynamoCodexStore(clientB, table);
    assert.equal(await a.put('user', 'encrypted-first', 0), true);
    assert.equal(await b.put('user', 'stale', 0), false);
    const first = (await a.get('user'))!;
    const clock = Date.now();
    const locked = await Promise.all([a.lock('user', 'instance-A', clock, clock + 10000), b.lock('user', 'instance-B', clock, clock + 10000)]);
    assert.equal(locked.filter(Boolean).length, 1);
    const winner = locked[0] ? 'instance-A' : 'instance-B';
    await b.unlock('user', 'wrong-owner');
    assert.equal(await a.lock('user', 'other', clock, clock + 10000), false);
    await a.unlock('user', winner);
    assert.equal(await b.put('user', 'encrypted-rotated', first.version), true);
    assert.equal(await a.put('user', 'stale', first.version), false);
    const current = (await b.get('user'))!;
    assert.equal(await a.remove('user', current.version), true);
    assert.equal((await b.get('user'))!.ciphertext, '');
    assert.equal(await b.lock('user', 'disconnected', clock, clock + 10000), false);
    assert.equal(await a.put('user', 'resurrected', current.version), false);
    const tombstone = (await a.get('user'))!;
    assert.equal(await b.put('user', 'encrypted-reconnected', tombstone.version), true);
    assert.equal(await a.put('user', 'old-refresh', first.version), false);
    await a.createAttempt('user', 'state', { ciphertext: 'encrypted-pkce', expiresAt: clock + 60000 });
    assert.equal(await b.consumeAttempt('another-user', 'state', clock), null);
    const consumed = await Promise.all([a.consumeAttempt('user', 'state', clock), b.consumeAttempt('user', 'state', clock)]);
    assert.equal(consumed.filter(Boolean).length, 1);
    await a.createAttempt('user', 'expired', { ciphertext: 'encrypted-pkce', expiresAt: clock - 10000 });
    assert.equal(await b.consumeAttempt('user', 'expired', clock), null);
  } finally {
    await clientA.send(new DeleteTableCommand({ TableName: table }));
    clientA.destroy(); clientB.destroy();
  }
});
