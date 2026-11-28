/**
 * Contract tests for ApiTokenRepository.
 *
 * The same assertions are verified against both implementations:
 *   1. SqliteApiTokenRepository  — always runs (in-memory SQLite)
 *   2. DynamoDbApiTokenRepository — runs only when DynamoDB Local is reachable
 *      at DYNAMODB_ENDPOINT (default http://localhost:8000)
 *
 * If DynamoDB Local is not reachable the DynamoDB suite is skipped with a
 * diagnostic message; it never fails the build.
 *
 * To run the DynamoDB suite locally:
 *   docker run -d --name ddb-local -p 8000:8000 amazon/dynamodb-local
 *   DYNAMODB_TABLE_PORTAL_USERS=portal-users-test \
 *     DYNAMODB_ENDPOINT=http://localhost:8000 \
 *     npm run test:affected -- --module api-tokens --backend-only
 *   docker stop ddb-local && docker rm ddb-local
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteApiTokenRepository } from '../server/repositories/api-tokens-sqlite.ts';
import type { ApiTokenRepository } from '../server/repositories/api-tokens.ts';
import { clearApiTokenRepository } from '../server/repositories/api-tokens.ts';
import { now, sha256 } from '../server/util.ts';
import { insert } from '../server/db.ts';

// ── Per-run unique suffix ─────────────────────────────────────────────────────
// DynamoDB Local persists state between runs.  Incorporating a run-unique tag
// in every token ID and hash ensures PutItem(ConditionExpression) never
// fails due to a leftover item from a previous test run.

const RUN_TAG = Date.now().toString(36).slice(-5); // 5 base-36 chars, e.g. 'k2a3b'

// ── Test users ────────────────────────────────────────────────────────────────

const USER_A = 'repo-contract-user-a';  // is_admin=1
const USER_B = 'repo-contract-user-b';  // regular user
const USER_C = 'repo-contract-user-c';  // disabled=1

interface UserSeed {
  id: string;
  email: string;
  name: string;
  is_admin: number;
  disabled: number;
}

const DEFAULT_USERS: UserSeed[] = [
  { id: USER_A, email: 'repo-a@test.com',    name: 'Repo Admin A',       is_admin: 1, disabled: 0 },
  { id: USER_B, email: 'repo-b@test.com',    name: 'Repo User B',        is_admin: 0, disabled: 0 },
  { id: USER_C, email: 'repo-c@test.com',    name: 'Repo Disabled C',    is_admin: 0, disabled: 1 },
];

// ── Shared contract suite ─────────────────────────────────────────────────────

function runContract(
  label: string,
  makeRepo: () => Promise<ApiTokenRepository>,
  seedUsersFn: (users: UserSeed[]) => Promise<void>,
): void {
  describe(`${label} — ApiTokenRepository contract`, () => {
    let repo: ApiTokenRepository;
    // Per-suite, per-run suffix: first 3 chars of the suite label + run-unique tag.
    // Ensures token IDs and hashes don't collide between SQLite/DynamoDB suites
    // or between successive test runs against DynamoDB Local.
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;

    before(async () => {
      repo = await makeRepo();
      await seedUsersFn(DEFAULT_USERS);
    });

    after(() => {
      clearApiTokenRepository();
    });

    // ── create ────────────────────────────────────────────────────────────────

    test('create — stores and returns a token record', async () => {
      const id = `cre-${sfx}-1`;
      const hash = sha256('ap_create_' + sfx);
      const record = await repo.create({
        id,
        user_id: USER_A,
        name: 'Create test',
        token_hash: hash,
        prefix: ('ap_' + sfx).slice(0, 10),
        scope: 'read',
        scopes: JSON.stringify(['read']),
        project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });

      assert.equal(record.id, id);
      assert.equal(record.user_id, USER_A);
      assert.equal(record.token_hash, hash);
      assert.equal(record.revoked_at, null);
    });

    // ── getByIdAndUser ────────────────────────────────────────────────────────

    test('getByIdAndUser — returns token for correct user', async () => {
      const id = `gbi-${sfx}-1`;
      await repo.create({
        id, user_id: USER_A, name: 'lookup',
        token_hash: sha256('ap_gbi_' + sfx),
        prefix: 'ap_gbi', scope: 'read', scopes: '["read"]',
        project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      const found = await repo.getByIdAndUser(id, USER_A);
      assert.ok(found, 'should find token by id+user');
      assert.equal(found.id, id);
    });

    test('getByIdAndUser — returns null for wrong user', async () => {
      const id = `gbi-${sfx}-2`;
      await repo.create({
        id, user_id: USER_A, name: 'wronguser',
        token_hash: sha256('ap_gbi2_' + sfx),
        prefix: 'ap_gbi2', scope: 'read', scopes: '["read"]',
        project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      const notFound = await repo.getByIdAndUser(id, 'wrong-user-00000');
      assert.equal(notFound, null);
    });

    // ── getByHash ─────────────────────────────────────────────────────────────

    test('getByHash — returns token with user fields', async () => {
      const id = `gbh-${sfx}-1`;
      const hash = sha256('ap_gbh_' + sfx);
      await repo.create({
        id, user_id: USER_A, name: 'hash-lookup',
        token_hash: hash,
        prefix: 'ap_gbh', scope: 'write', scopes: '["read","write"]',
        project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      const row = await repo.getByHash(hash);
      assert.ok(row, 'should find token by hash');
      assert.equal(row.id, id);
      assert.equal(row.scope, 'write');
      assert.ok(typeof row.user_email === 'string', 'user_email should be a string');
      assert.ok(typeof row.user_name === 'string', 'user_name should be a string');
    });

    test('getByHash — returns correct user_is_admin and user_email/name', async () => {
      const id = `gbh-${sfx}-2`;
      const hash = sha256('ap_gbhadmin_' + sfx);
      await repo.create({
        id, user_id: USER_A, name: 'admin-token',
        token_hash: hash,
        prefix: 'ap_adm', scope: 'read', scopes: '["read"]',
        project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      const row = await repo.getByHash(hash);
      assert.ok(row, 'should find token');
      assert.equal(row.user_is_admin, 1, 'USER_A should be admin');
      assert.equal(row.user_disabled, 0, 'USER_A should not be disabled');
      assert.equal(row.user_email, 'repo-a@test.com');
      assert.equal(row.user_name, 'Repo Admin A');
    });

    test('getByHash — disabled user token returns user_disabled=1', async () => {
      const id = `gbh-${sfx}-3`;
      const hash = sha256('ap_gbhdis_' + sfx);
      await repo.create({
        id, user_id: USER_C, name: 'disabled-user-token',
        token_hash: hash,
        prefix: 'ap_dis', scope: 'read', scopes: '["read"]',
        project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      const row = await repo.getByHash(hash);
      assert.ok(row, 'should find token even for disabled user');
      assert.equal(row.user_disabled, 1, 'user_disabled should be 1 for disabled user');
      assert.equal(row.user_email, 'repo-c@test.com');
    });

    test('getByHash — returns null for unknown hash', async () => {
      const row = await repo.getByHash('00000000000000000000000000000000000000');
      assert.equal(row, null);
    });

    // ── listByUser ────────────────────────────────────────────────────────────

    test('listByUser — returns tokens for user, excludes delegates', async () => {
      const id1 = `lbu-${sfx}-1`;
      const id2 = `lbu-${sfx}-2`;
      await repo.create({
        id: id1, user_id: USER_B, name: 'visible',
        token_hash: sha256('ap_lbu1_' + sfx),
        prefix: 'ap_lb1', scope: 'read', scopes: '["read"]',
        project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      await repo.create({
        id: id2, user_id: USER_B, name: '[delegate]',
        token_hash: sha256('ap_lbu2_' + sfx),
        prefix: 'ap_lb2', scope: 'read', scopes: '["delegate"]',
        project_id: null, workflow_id: 'wf-lbu-test',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      const tokens = await repo.listByUser(USER_B);
      assert.ok(tokens.some((t) => t.id === id1), 'should include regular token');
      assert.ok(!tokens.some((t) => t.id === id2), 'should exclude delegate token');
    });

    test('listByUser — returns tokens newest first', async () => {
      const userId = `lbu-ord-${sfx}`;
      await seedUsersFn([{
        id: userId, email: `lbuord-${sfx}@test.com`, name: 'LBU Order', is_admin: 0, disabled: 0,
      }]);
      // Use timestamps derived from the run tag so each run gets different values.
      // Adding a per-suite offset (charCodeAt 0) keeps SQLite and DynamoDB ranges apart.
      const base = 1_700_000_000_000 + sfx.charCodeAt(0) * 1_000_000;
      const t1 = new Date(base).toISOString();
      const t2 = new Date(base + 60_000).toISOString();
      const t3 = new Date(base + 120_000).toISOString();

      await repo.create({
        id: `lbu-o1-${sfx}`, user_id: userId, name: 'Order 1',
        token_hash: sha256('lbu_o1_' + sfx), prefix: 'lbu_o1',
        scope: 'read', scopes: '["read"]', project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: t1,
      });
      await repo.create({
        id: `lbu-o2-${sfx}`, user_id: userId, name: 'Order 2',
        token_hash: sha256('lbu_o2_' + sfx), prefix: 'lbu_o2',
        scope: 'read', scopes: '["read"]', project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: t2,
      });
      await repo.create({
        id: `lbu-o3-${sfx}`, user_id: userId, name: 'Order 3',
        token_hash: sha256('lbu_o3_' + sfx), prefix: 'lbu_o3',
        scope: 'read', scopes: '["read"]', project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: t3,
      });

      const tokens = await repo.listByUser(userId);
      assert.equal(tokens.length, 3, 'should return 3 tokens');
      assert.equal(tokens[0].created_at, t3, 'first token should be newest (t3)');
      assert.equal(tokens[1].created_at, t2, 'second token should be t2');
      assert.equal(tokens[2].created_at, t1, 'third token should be oldest (t1)');
    });

    // ── countActive ───────────────────────────────────────────────────────────

    test('countActive — counts non-revoked, non-expired tokens', async () => {
      const id = `cnt-${sfx}-1`;
      await repo.create({
        id, user_id: USER_A, name: 'for-count',
        token_hash: sha256('ap_cnt_' + sfx),
        prefix: 'ap_cnt', scope: 'read', scopes: '["read"]',
        project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      const count = await repo.countActive(USER_A);
      assert.ok(count >= 1, `countActive should be >= 1, got ${count}`);
    });

    test('countActive — excludes revoked tokens', async () => {
      const userId = `cnt2-${sfx}`;
      await seedUsersFn([{
        id: userId, email: `cnt2-${sfx}@test.com`, name: 'Count2', is_admin: 0, disabled: 0,
      }]);
      const id = `cnt2-${sfx}-1`;
      await repo.create({
        id, user_id: userId, name: 'to-revoke',
        token_hash: sha256('cnt2_' + sfx), prefix: 'cnt2',
        scope: 'read', scopes: '["read"]', project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      const before = await repo.countActive(userId);
      assert.equal(before, 1, 'should have 1 active token before revoke');

      await repo.revoke(id, userId, now());
      const after = await repo.countActive(userId);
      assert.equal(after, 0, 'countActive should be 0 after revoking the only token');
    });

    test('countActive — excludes expired tokens', async () => {
      const userId = `cnt3-${sfx}`;
      await seedUsersFn([{
        id: userId, email: `cnt3-${sfx}@test.com`, name: 'Count3', is_admin: 0, disabled: 0,
      }]);
      await repo.create({
        id: `cnt3-${sfx}-1`, user_id: userId, name: 'expired',
        token_hash: sha256('cnt3_' + sfx), prefix: 'cnt3',
        scope: 'read', scopes: '["read"]', project_id: null,
        expires_at: new Date(Date.now() - 1000).toISOString(),
        created_at: now(),
      });
      const count = await repo.countActive(userId);
      assert.equal(count, 0, 'expired token should not be counted as active');
    });

    // ── updateLastUsed ────────────────────────────────────────────────────────

    test('updateLastUsed — sets last_used_at', async () => {
      const id = `lu-${sfx}-1`;
      await repo.create({
        id, user_id: USER_A, name: 'last-used',
        token_hash: sha256('ap_lu_' + sfx),
        prefix: 'ap_lu', scope: 'read', scopes: '["read"]',
        project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      const ts = now();
      await repo.updateLastUsed(id, USER_A, ts);
      const row = await repo.getByIdAndUser(id, USER_A);
      assert.ok(row, 'token should still exist');
      assert.equal(row.last_used_at, ts);
    });

    // ── revoke ────────────────────────────────────────────────────────────────

    test('revoke — sets revoked_at', async () => {
      const id = `rev-${sfx}-1`;
      await repo.create({
        id, user_id: USER_A, name: 'to-revoke',
        token_hash: sha256('ap_rev_' + sfx),
        prefix: 'ap_rev', scope: 'read', scopes: '["read"]',
        project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      const ts = now();
      await repo.revoke(id, USER_A, ts);
      const row = await repo.getByIdAndUser(id, USER_A);
      assert.ok(row, 'token should still exist after revoke');
      assert.equal(row.revoked_at, ts);
    });

    // ── listAll ───────────────────────────────────────────────────────────────

    test('listAll — returns all non-delegate tokens with user metadata', async () => {
      // Use timestamps derived from the run tag so each run gets different values.
      const base = 1_710_000_000_000 + sfx.charCodeAt(0) * 1_000_000;
      const t1 = new Date(base).toISOString();
      const t2 = new Date(base + 60_000).toISOString();
      const t3 = new Date(base + 120_000).toISOString();

      const id1 = `la1-${sfx}`;
      const id2 = `la2-${sfx}`;
      const id3 = `la3-${sfx}`;
      const idD = `laD-${sfx}`;

      await repo.create({
        id: id1, user_id: USER_A, name: 'ListAll 1',
        token_hash: sha256('la1_' + sfx), prefix: 'la_1',
        scope: 'read', scopes: '["read"]', project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: t1,
      });
      await repo.create({
        id: id2, user_id: USER_B, name: 'ListAll 2',
        token_hash: sha256('la2_' + sfx), prefix: 'la_2',
        scope: 'read', scopes: '["read"]', project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: t2,
      });
      await repo.create({
        id: id3, user_id: USER_A, name: 'ListAll 3',
        token_hash: sha256('la3_' + sfx), prefix: 'la_3',
        scope: 'read', scopes: '["read"]', project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: t3,
      });
      // Delegate token — must NOT appear in listAll
      await repo.create({
        id: idD, user_id: USER_A, name: '[delegate]',
        token_hash: sha256('laD_' + sfx), prefix: 'la_D',
        scope: 'read', scopes: '["delegate"]', project_id: null,
        workflow_id: 'wf-listall-test',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });

      const all = await repo.listAll();
      assert.ok(Array.isArray(all), 'listAll should return an array');

      // Delegate token must be absent
      assert.ok(!all.some((t) => t.id === idD), 'delegate token must be excluded from listAll');

      // All three regular tokens must be present
      const found = all.filter((t) => [id1, id2, id3].includes(t.id));
      assert.equal(found.length, 3, 'all 3 non-delegate tokens should appear');

      // Newest first: t3 > t2 > t1
      const idx1 = all.findIndex((t) => t.id === id1);
      const idx2 = all.findIndex((t) => t.id === id2);
      const idx3 = all.findIndex((t) => t.id === id3);
      assert.ok(idx3 < idx2, `id3 (${t3}) should appear before id2 (${t2}) — got indices ${idx3}, ${idx2}`);
      assert.ok(idx2 < idx1, `id2 (${t2}) should appear before id1 (${t1}) — got indices ${idx2}, ${idx1}`);

      // User metadata must be populated
      const t3Row = all.find((t) => t.id === id3)!;
      assert.ok(t3Row, 'id3 should be found');
      assert.ok(t3Row.user_name.length > 0, 'user_name should be non-empty');
      assert.ok(t3Row.user_email.length > 0, 'user_email should be non-empty');
    });

    test('listAll — includes tokens of disabled users', async () => {
      const id = `laC-${sfx}`;
      await repo.create({
        id, user_id: USER_C, name: 'Disabled user token',
        token_hash: sha256('laC_' + sfx), prefix: 'la_C',
        scope: 'read', scopes: '["read"]', project_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      const all = await repo.listAll();
      const row = all.find((t) => t.id === id);
      assert.ok(row, 'token for disabled user should appear in listAll');
      assert.equal(row.user_email, 'repo-c@test.com');
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

describe('SQLite', () => {
  before(() => {
    createTestDb();
  });
  after(cleanup);

  runContract(
    'SQLite',
    async () => {
      clearApiTokenRepository();
      return new SqliteApiTokenRepository();
    },
    async (users) => {
      for (const u of users) {
        try {
          insert('users', {
            id: u.id,
            email: u.email,
            name: u.name,
            password_hash: 'x',
            is_admin: u.is_admin,
            disabled: u.disabled,
            created_at: now(),
          });
        } catch { /* already exists — idempotent */ }
      }
    },
  );
});

// ── DynamoDB Local suite ──────────────────────────────────────────────────────
// Use an async describe so node:test --test mode waits for the connectivity
// check before collecting tests.  Top-level await is not honoured by the
// --test flag runner, but async describe callbacks are.

const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE_PORTAL_USERS ?? 'portal-users-test';
const DYNAMODB_REGION = process.env.DYNAMODB_REGION ?? process.env.AWS_REGION ?? 'ap-southeast-1';

describe('DynamoDB Local suite', async () => {
  // checkDynamoDbLocal lives inside async describe so node:test awaits it
  async function checkDynamoDbLocal(endpoint: string): Promise<boolean> {
    try {
      const { DynamoDBClient, ListTablesCommand } = await import('@aws-sdk/client-dynamodb');
      const client = new DynamoDBClient({
        endpoint,
        region: DYNAMODB_REGION,
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      });
      await client.send(new ListTablesCommand({}));
      return true;
    } catch {
      return false;
    }
  }

  const ddbReachable = await checkDynamoDbLocal(DYNAMODB_ENDPOINT);

  if (!ddbReachable) {
    test('SKIP — DynamoDB Local not reachable', () => {
      console.log(
        `[api-tokens-repo] DynamoDB Local not reachable at ${DYNAMODB_ENDPOINT}. ` +
          'To run DynamoDB tests:\n' +
          '  docker run -d --name ddb-local -p 8000:8000 amazon/dynamodb-local\n' +
          '  DYNAMODB_ENDPOINT=http://localhost:8000 ' +
          'npm run test:affected -- --module api-tokens --backend-only\n' +
          '  docker stop ddb-local && docker rm ddb-local',
      );
    });
    return;
  }

  const { DynamoDbApiTokenRepository, ensureTableExists } = await import(
    '../server/repositories/api-tokens-dynamodb.ts'
  );
  const { DynamoDBClient, PutItemCommand } = await import('@aws-sdk/client-dynamodb');

  const ddbClient = new DynamoDBClient({
    endpoint: DYNAMODB_ENDPOINT,
    region: DYNAMODB_REGION,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });

  await ensureTableExists(ddbClient, DYNAMODB_TABLE);

  runContract(
    'DynamoDB Local',
    async () => {
      clearApiTokenRepository();
      return new DynamoDbApiTokenRepository({ client: ddbClient, tableName: DYNAMODB_TABLE });
    },
    async (users) => {
      for (const u of users) {
        await ddbClient.send(
          new PutItemCommand({
            TableName: DYNAMODB_TABLE,
            Item: {
              PK: { S: `USER#${u.id}` },
              SK: { S: '#META' },
              id: { S: u.id },
              email: { S: u.email },
              name: { S: u.name },
              isAdmin: { N: String(u.is_admin) },
              disabled: { N: String(u.disabled) },
            },
          }),
        );
      }
    },
  );
});
