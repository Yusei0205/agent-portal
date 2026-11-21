/**
 * Contract tests for AgentcoreLoginRepository.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentcoreLoginRepository } from '../server/repositories/agentcore-login.ts';
import { clearAgentcoreLoginRepository } from '../server/repositories/agentcore-login.ts';
import { generateId, now } from '../server/util.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function credId() { return `cred-ac-${RUN_TAG}-${generateId().slice(0, 6)}`; }

const SAMPLE_PAYLOAD = {
  access_token: 'test-access-token',
  expires_at: new Date(Date.now() + 28_800_000).toISOString(),
  refresh_token: 'test-refresh-token',
  region: 'us-east-1',
  start_url: 'https://d-test.awsapps.com/start',
};

function runSuite(label: string, setup: () => Promise<AgentcoreLoginRepository>): void {
  describe(label, () => {
    let repo: AgentcoreLoginRepository;

    before(async () => { repo = await setup(); });
    after(() => { clearAgentcoreLoginRepository(); });

    test('create and get round trip', async () => {
      const id = credId();
      await repo.create(id, now());
      const entry = await repo.get(id);
      assert.ok(entry);
      assert.equal(entry.credentialId, id);
      assert.equal(entry.settled, false);
      assert.equal(entry.state, null);
    });

    test('get returns null for unknown credential', async () => {
      assert.equal(await repo.get(`no-such-${RUN_TAG}`), null);
    });

    test('complete marks entry settled with token payload', async () => {
      const id = credId();
      await repo.create(id, now());
      await repo.complete(id, SAMPLE_PAYLOAD);
      const entry = await repo.get(id);
      assert.ok(entry);
      assert.equal(entry.settled, true);
      assert.equal(entry.state, 'complete');
      assert.ok(entry.tokenPayload);
      assert.equal(entry.tokenPayload!.access_token, 'test-access-token');
    });

    test('fail marks entry settled with error', async () => {
      const id = credId();
      await repo.create(id, now());
      await repo.fail(id, 'Login timed out');
      const entry = await repo.get(id);
      assert.ok(entry);
      assert.equal(entry.settled, true);
      assert.equal(entry.state, 'failed');
      assert.equal(entry.errorMessage, 'Login timed out');
    });

    test('delete removes the entry', async () => {
      const id = credId();
      await repo.create(id, now());
      await repo.delete(id);
      assert.equal(await repo.get(id), null);
    });

    test('create replaces existing entry', async () => {
      const id = credId();
      await repo.create(id, now());
      await repo.complete(id, SAMPLE_PAYLOAD);
      await repo.create(id, now());
      const entry = await repo.get(id);
      assert.ok(entry);
      assert.equal(entry.settled, false);
    });
  });
}

runSuite('In-memory (SQLite mode)', async () => {
  const { InMemoryAgentcoreLoginRepository } = await import('../server/repositories/agentcore-login-sqlite.ts');
  return new InMemoryAgentcoreLoginRepository();
});

(async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const require2 = process.env.REQUIRE_DYNAMODB === '1';
  if (!endpoint) {
    if (require2) throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT not set');
    describe('DynamoDB Local suite', () => { test('SKIP — DynamoDB Local not reachable', () => {}); });
    return;
  }

  process.env.DYNAMODB_TABLE_PORTAL_RUNS = `portal-runs-ac-test-${RUN_TAG}`;
  const { clearDynamoDbClient, getDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
  clearDynamoDbClient();
  const { DynamoDbAgentcoreLoginRepository, ensureAgentcoreLoginTableExists } =
    await import('../server/repositories/agentcore-login-dynamodb.ts');
  await ensureAgentcoreLoginTableExists(getDynamoDbClient());

  runSuite('DynamoDB Local suite', async () => new DynamoDbAgentcoreLoginRepository());
})();
