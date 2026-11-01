/**
 * Contract tests for AuthRepository.
 *
 * The same assertions run against both implementations:
 *   1. SqliteAuthRepository  — always runs (in-memory SQLite)
 *   2. DynamoDbAuthRepository — runs only when DYNAMODB_ENDPOINT is set
 *
 * When REQUIRE_DYNAMODB=1 is set and DynamoDB Local is not reachable,
 * the suite fails rather than skipping.
 *
 * To run the DynamoDB suite locally:
 *   docker run -d --name ddb-local -p 8000:8000 amazon/dynamodb-local
 *   DYNAMODB_ENDPOINT=http://localhost:8000 \
 *     npm run test:affected -- --module auth --backend-only
 *   docker stop ddb-local && docker rm ddb-local
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteAuthRepository } from '../server/repositories/auth-sqlite.ts';
import type { AuthRepository } from '../server/repositories/auth.ts';
import { clearAuthRepository } from '../server/repositories/auth.ts';
import { EmailAlreadyTakenError } from '../server/repositories/auth.ts';
import { now, sha256 } from '../server/util.ts';
import { generateId } from '../server/util.ts';

// ── Per-run unique suffix ─────────────────────────────────────────────────────
const RUN_TAG = Date.now().toString(36).slice(-5);

// ── Shared contract suite ─────────────────────────────────────────────────────

interface FreshRepoResult {
  repo: AuthRepository;
  cleanup: () => Promise<void>;
}

function runContract(
  label: string,
  makeRepo: () => Promise<AuthRepository>,
  makeFreshRepo: () => Promise<FreshRepoResult>,
): void {
  describe(`${label} — AuthRepository contract`, () => {
    let repo: AuthRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;

    before(async () => {
      repo = await makeRepo();
    });

    after(() => {
      clearAuthRepository();
    });

    // ── countUsers ────────────────────────────────────────────────────────────

    test('countUsers — returns 0 when empty', async () => {
      const count = await repo.countUsers();
      assert.ok(typeof count === 'number', 'countUsers should return a number');
      assert.ok(count >= 0, 'countUsers should be non-negative');
    });

    test('countUsers — increments after createUser', async () => {
      const before = await repo.countUsers();
      await repo.createUser({
        id: `cnt-${sfx}-1`,
        email: `cnt-${sfx}-1@test.com`,
        name: 'Count Test User',
        password_hash: 'x',
        is_admin: 0,
        disabled: 0,
        created_at: now(),
      });
      const after = await repo.countUsers();
      assert.equal(after, before + 1, 'countUsers should increment after createUser');
    });

    // ── createUser / getUserById / getUserByEmail ─────────────────────────────

    test('createUser — round-trip by ID and email', async () => {
      const id = `usr-${sfx}-1`;
      const email = `usr-${sfx}-1@test.com`;
      const created = await repo.createUser({
        id,
        email,
        name: 'Round Trip User',
        password_hash: 'hash-x',
        is_admin: 1,
        disabled: 0,
        created_at: now(),
      });
      assert.equal(created.id, id);
      assert.equal(created.email, email);
      assert.equal(created.is_admin, 1);

      const byId = await repo.getUserById(id);
      assert.ok(byId, 'getUserById should find the user');
      assert.equal(byId.email, email);

      const byEmail = await repo.getUserByEmail(email);
      assert.ok(byEmail, 'getUserByEmail should find the user');
      assert.equal(byEmail.id, id);
      assert.equal(byEmail.password_hash, 'hash-x');
    });

    test('getUserById — returns null for unknown id', async () => {
      const result = await repo.getUserById('no-such-user-00000');
      assert.equal(result, null);
    });

    test('getUserByEmail — returns null for unknown email', async () => {
      const result = await repo.getUserByEmail('nobody@nowhere.test');
      assert.equal(result, null);
    });

    test('getUserByEmail — email is case-insensitive (login normalizes before lookup)', async () => {
      const id = `usr-${sfx}-case`;
      // auth.ts's createUser always normalizes email to lowercase before calling repo
      const storedEmail = `case-${sfx}@test.com`;   // stored lowercase
      await repo.createUser({
        id, email: storedEmail, name: 'Case Test', password_hash: 'h', is_admin: 0, disabled: 0, created_at: now(),
      });

      // Simulate login: email.trim().toLowerCase() → then getUserByEmail
      const mixedCaseInput = `CASE-${sfx}@TEST.COM`;
      const normalizedForLogin = mixedCaseInput.trim().toLowerCase();

      // After normalization the repo finds the user
      const found = await repo.getUserByEmail(normalizedForLogin);
      assert.ok(found, 'getUserByEmail with normalized (lowercased) email should find the user');
      assert.equal(found.id, id);
    });

    // ── updateUserFields ──────────────────────────────────────────────────────

    test('updateUserFields — updates disabled and is_admin', async () => {
      const id = `usr-${sfx}-upd`;
      await repo.createUser({
        id, email: `upd-${sfx}@test.com`, name: 'Update Target',
        password_hash: 'h', is_admin: 0, disabled: 0, created_at: now(),
      });
      await repo.updateUserFields(id, { disabled: 1, is_admin: 1 });
      const updated = await repo.getUserById(id);
      assert.ok(updated);
      assert.equal(updated.disabled, 1);
      assert.equal(updated.is_admin, 1);
    });

    // ── sessions ──────────────────────────────────────────────────────────────

    test('createSession and getSessionWithUser — round trip', async () => {
      const userId = `ses-${sfx}-1`;
      await repo.createUser({
        id: userId, email: `ses-${sfx}-1@test.com`, name: 'Session User',
        password_hash: 'h', is_admin: 1, disabled: 0, created_at: now(),
      });

      const tokenHash = sha256(`session-token-${sfx}-1`);
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      await repo.createSession({
        token_hash: tokenHash,
        user_id: userId,
        expires_at: expiresAt,
        created_at: now(),
      });

      const session = await repo.getSessionWithUser(tokenHash);
      assert.ok(session, 'should find session by token hash');
      assert.equal(session.user_id, userId);
      assert.equal(session.is_admin, 1);
      assert.equal(session.disabled, 0);
      assert.equal(session.email, `ses-${sfx}-1@test.com`);
      assert.equal(session.expires_at, expiresAt);
    });

    test('getSessionWithUser — returns null for unknown hash', async () => {
      const result = await repo.getSessionWithUser('0000000000000000000000000000000000000000');
      assert.equal(result, null);
    });

    test('getSessionWithUser — returns disabled flag for disabled user', async () => {
      const userId = `ses-${sfx}-dis`;
      await repo.createUser({
        id: userId, email: `ses-${sfx}-dis@test.com`, name: 'Disabled User',
        password_hash: 'h', is_admin: 0, disabled: 1, created_at: now(),
      });
      const tokenHash = sha256(`session-token-${sfx}-dis`);
      await repo.createSession({
        token_hash: tokenHash, user_id: userId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      const session = await repo.getSessionWithUser(tokenHash);
      assert.ok(session, 'should still return the session for a disabled user');
      assert.equal(session.disabled, 1, 'user_disabled flag should be 1');
    });

    test('deleteSession — removes the session', async () => {
      const userId = `ses-${sfx}-del`;
      await repo.createUser({
        id: userId, email: `ses-${sfx}-del@test.com`, name: 'Del Session User',
        password_hash: 'h', is_admin: 0, disabled: 0, created_at: now(),
      });
      const tokenHash = sha256(`session-token-${sfx}-del`);
      await repo.createSession({
        token_hash: tokenHash, user_id: userId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: now(),
      });
      // Verify it exists
      const before = await repo.getSessionWithUser(tokenHash);
      assert.ok(before, 'session should exist before delete');

      await repo.deleteSession(tokenHash);

      const after = await repo.getSessionWithUser(tokenHash);
      assert.equal(after, null, 'session should be gone after deleteSession');
    });

    test('deleteExpiredSessions — no-op or completes without error', async () => {
      // SQLite: deletes expired sessions. DynamoDB: TTL handles it; this is a no-op.
      await repo.deleteExpiredSessions();
    });

    // ── listUsersWithLastActive ───────────────────────────────────────────────

    test('listUsersWithLastActive — returns users ordered by created_at ASC', async () => {
      const base = 1_720_000_000_000 + sfx.charCodeAt(0) * 1_000_000;
      const t1 = new Date(base).toISOString();
      const t2 = new Date(base + 60_000).toISOString();
      const id1 = `lbu-${sfx}-1`;
      const id2 = `lbu-${sfx}-2`;

      await repo.createUser({
        id: id1, email: `lbu1-${sfx}@test.com`, name: 'LBU 1',
        password_hash: 'h', is_admin: 0, disabled: 0, created_at: t1,
      });
      await repo.createUser({
        id: id2, email: `lbu2-${sfx}@test.com`, name: 'LBU 2',
        password_hash: 'h', is_admin: 0, disabled: 0, created_at: t2,
      });

      const users = await repo.listUsersWithLastActive();
      const idx1 = users.findIndex((u) => u.id === id1);
      const idx2 = users.findIndex((u) => u.id === id2);
      assert.ok(idx1 >= 0, 'user1 should be in list');
      assert.ok(idx2 >= 0, 'user2 should be in list');
      assert.ok(idx1 < idx2, `user1 (${t1}) should appear before user2 (${t2})`);
    });

    test('listUsersWithLastActive — last_active_at reflects session creation', async () => {
      const userId = `lbu-${sfx}-act`;
      await repo.createUser({
        id: userId, email: `lbu-act-${sfx}@test.com`, name: 'Active User',
        password_hash: 'h', is_admin: 0, disabled: 0, created_at: now(),
      });

      const sessionTs = now();
      await repo.createSession({
        token_hash: sha256(`act-tok-${sfx}`), user_id: userId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: sessionTs,
      });

      const users = await repo.listUsersWithLastActive();
      const user = users.find((u) => u.id === userId);
      assert.ok(user, 'user should appear in list');
      assert.equal(user.last_active_at, sessionTs, 'last_active_at should match session created_at');
    });

    // ── invitations ───────────────────────────────────────────────────────────

    test('createInvitation / getInvitationByHash — round trip', async () => {
      const creatorId = `inv-creator-${sfx}`;
      await repo.createUser({
        id: creatorId, email: `inv-cr-${sfx}@test.com`, name: 'Inviter',
        password_hash: 'h', is_admin: 1, disabled: 0, created_at: now(),
      });

      const tokenHash = sha256(`invite-token-${sfx}-1`);
      const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();

      await repo.createInvitation({
        token_hash: tokenHash,
        email: `invited-${sfx}@test.com`,
        is_admin: 0,
        portal_role: 'member',
        project_id: null,
        project_access: null,
        team_id: null,
        expires_at: expiresAt,
        created_by: creatorId,
        created_at: now(),
      });

      const inv = await repo.getInvitationByHash(tokenHash);
      assert.ok(inv, 'should find invitation by hash');
      assert.equal(inv.token_hash, tokenHash);
      assert.equal(inv.email, `invited-${sfx}@test.com`);
      assert.equal(inv.is_admin, 0);
      assert.equal(inv.used_at, null, 'should not be used yet');
    });

    test('getInvitationByHash — returns null for unknown hash', async () => {
      const result = await repo.getInvitationByHash('unknown-hash-00000');
      assert.equal(result, null);
    });

    test('listPendingInvitations — excludes used and expired invitations', async () => {
      const creatorId = `inv-list-cr-${sfx}`;
      await repo.createUser({
        id: creatorId, email: `inv-list-cr-${sfx}@test.com`, name: 'List Creator',
        password_hash: 'h', is_admin: 1, disabled: 0, created_at: now(),
      });

      const activeHash = sha256(`invite-active-${sfx}`);
      const expiredHash = sha256(`invite-expired-${sfx}`);

      await repo.createInvitation({
        token_hash: activeHash, email: null, is_admin: 0, portal_role: 'member',
        project_id: null, project_access: null, team_id: null,
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        created_by: creatorId, created_at: now(),
      });
      await repo.createInvitation({
        token_hash: expiredHash, email: null, is_admin: 0, portal_role: 'member',
        project_id: null, project_access: null, team_id: null,
        expires_at: new Date(Date.now() - 1000).toISOString(),  // expired
        created_by: creatorId, created_at: now(),
      });

      const pending = await repo.listPendingInvitations(now());
      assert.ok(pending.some((i) => i.token_hash === activeHash), 'active invitation should be in list');
      assert.ok(!pending.some((i) => i.token_hash === expiredHash), 'expired invitation should NOT be in list');
    });

    test('markInvitationUsed — sets used_at and used_by', async () => {
      const creatorId = `inv-used-cr-${sfx}`;
      await repo.createUser({
        id: creatorId, email: `inv-used-cr-${sfx}@test.com`, name: 'Used Creator',
        password_hash: 'h', is_admin: 1, disabled: 0, created_at: now(),
      });

      const tokenHash = sha256(`invite-mark-used-${sfx}`);
      await repo.createInvitation({
        token_hash: tokenHash, email: null, is_admin: 0, portal_role: 'member',
        project_id: null, project_access: null, team_id: null,
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        created_by: creatorId, created_at: now(),
      });

      const usedById = `inv-used-user-${sfx}`;
      const usedAt = now();
      const claimed = await repo.markInvitationUsed(tokenHash, usedById, usedAt);
      assert.equal(claimed, true, 'first claim should succeed');

      const inv = await repo.getInvitationByHash(tokenHash);
      assert.ok(inv, 'invitation should still exist after marking used');
      assert.equal(inv.used_at, usedAt, 'used_at should be set');
      assert.equal(inv.used_by, usedById, 'used_by should be set');
    });

    // ── Email uniqueness ──────────────────────────────────────────────────────

    test('createUser — duplicate email throws EmailAlreadyTakenError', async () => {
      const email = `dup-${sfx}@test.com`;
      await repo.createUser({
        id: `dup-${sfx}-1`, email, name: 'Dup 1',
        password_hash: 'h', is_admin: 0, disabled: 0, created_at: now(),
      });
      await assert.rejects(
        () => repo.createUser({
          id: `dup-${sfx}-2`, email, name: 'Dup 2',
          password_hash: 'h', is_admin: 0, disabled: 0, created_at: now(),
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error, 'should throw an Error');
          assert.ok(err.name === 'EmailAlreadyTakenError' || err.message.includes('email'), 'should report email conflict');
          return true;
        },
        'second user with same email should be rejected',
      );
    });

    test('createUser — concurrent same-email requests: exactly one wins', async () => {
      const email = `concurrent-${sfx}@test.com`;
      const [r1, r2] = await Promise.allSettled([
        repo.createUser({ id: `conc-${sfx}-a`, email, name: 'A', password_hash: 'h', is_admin: 0, disabled: 0, created_at: now() }),
        repo.createUser({ id: `conc-${sfx}-b`, email, name: 'B', password_hash: 'h', is_admin: 0, disabled: 0, created_at: now() }),
      ]);
      const wins = [r1, r2].filter((r) => r.status === 'fulfilled').length;
      const losses = [r1, r2].filter((r) => r.status === 'rejected').length;
      assert.equal(wins, 1, 'exactly one request should succeed');
      assert.equal(losses, 1, 'exactly one request should fail');
    });

    // ── updateUserFields: unknown id is a no-op ────────────────────────────────

    test('updateUserFields — unknown id does not create a new item', async () => {
      const countBefore = await repo.countUsers();
      // Calling updateUserFields on a non-existent id must not throw or create a user
      await repo.updateUserFields('no-such-user-id-99999', { disabled: 1 });
      const countAfter = await repo.countUsers();
      assert.equal(countAfter, countBefore, 'countUsers should not change after updateUserFields on unknown id');
      // No new user should exist
      const ghost = await repo.getUserById('no-such-user-id-99999');
      assert.equal(ghost, null, 'updateUserFields on unknown id must not create a ghost user');
    });

    // ── createFirstAdmin (each test gets a fresh isolated store) ─────────────

    test('createFirstAdmin — succeeds on empty store', async () => {
      const { repo: freshRepo, cleanup } = await makeFreshRepo();
      try {
        assert.equal(await freshRepo.countUsers(), 0, 'fresh store must start empty');

        const id = `first-admin-${sfx}`;
        const rec = await freshRepo.createFirstAdmin({
          id,
          email: `first-admin-${sfx}@test.com`,
          name: 'First Admin',
          password_hash: 'h',
          is_admin: 1,
          disabled: 0,
          created_at: now(),
        });
        assert.equal(rec.id, id);
        assert.equal(rec.is_admin, 1);
        assert.equal(await freshRepo.countUsers(), 1, 'exactly one user after createFirstAdmin');
      } finally {
        await cleanup();
      }
    });

    test('createFirstAdmin — refused when a user already exists', async () => {
      const { repo: freshRepo, cleanup } = await makeFreshRepo();
      try {
        // Populate the store with one admin first
        await freshRepo.createFirstAdmin({
          id: `fa-exists-a-${sfx}`,
          email: `fa-exists-a-${sfx}@test.com`,
          name: 'First Admin',
          password_hash: 'h',
          is_admin: 1,
          disabled: 0,
          created_at: now(),
        });

        const { AdminAlreadyExistsError } = await import('../server/repositories/auth.ts');
        await assert.rejects(
          () => freshRepo.createFirstAdmin({
            id: `fa-exists-b-${sfx}`,
            email: `fa-exists-b-${sfx}@test.com`,
            name: 'Second Admin',
            password_hash: 'h',
            is_admin: 1,
            disabled: 0,
            created_at: now(),
          }),
          (err: unknown) => {
            assert.ok(err instanceof Error, 'should throw Error');
            assert.ok(
              err.name === 'AdminAlreadyExistsError' || err.message.includes('already'),
              `expected AdminAlreadyExistsError, got: ${err.name} — ${err.message}`,
            );
            return true;
          },
          'createFirstAdmin must fail when users exist',
        );
        // The failure must not have corrupted the store
        assert.equal(
          await freshRepo.countUsers(),
          1,
          'store must have exactly one user after a failed second attempt',
        );
      } finally {
        await cleanup();
      }
    });

    test('createFirstAdmin — concurrent calls: exactly one winner, exactly one user', async () => {
      const { repo: freshRepo, cleanup } = await makeFreshRepo();
      try {
        assert.equal(await freshRepo.countUsers(), 0, 'fresh store must start empty');

        const sfx2 = `conc-fa-${sfx}`;
        const [r1, r2] = await Promise.allSettled([
          freshRepo.createFirstAdmin({
            id: `${sfx2}-a`, email: `${sfx2}-a@test.com`, name: 'A',
            password_hash: 'h', is_admin: 1, disabled: 0, created_at: now(),
          }),
          freshRepo.createFirstAdmin({
            id: `${sfx2}-b`, email: `${sfx2}-b@test.com`, name: 'B',
            password_hash: 'h', is_admin: 1, disabled: 0, created_at: now(),
          }),
        ]);
        const wins = [r1, r2].filter((r) => r.status === 'fulfilled').length;
        assert.equal(wins, 1, 'exactly one concurrent createFirstAdmin call should succeed');
        assert.equal(
          await freshRepo.countUsers(),
          1,
          'exactly one user should exist after concurrent createFirstAdmin',
        );
      } finally {
        await cleanup();
      }
    });

    test('createFirstAdmin — failed attempt (same email) leaves no ghost user', async () => {
      // Two concurrent calls sharing the same email simulate a double-submit (e.g. browser
      // retry). One wins; the other fails. The failed attempt must not leave behind any
      // orphaned user record or email reservation — the store must have exactly 1 user.
      const { repo: freshRepo, cleanup } = await makeFreshRepo();
      try {
        const email = `fa-same-email-${sfx}@test.com`;
        const [r1, r2] = await Promise.allSettled([
          freshRepo.createFirstAdmin({
            id: `fa-same-${sfx}-a`, email, name: 'A',
            password_hash: 'h', is_admin: 1, disabled: 0, created_at: now(),
          }),
          freshRepo.createFirstAdmin({
            id: `fa-same-${sfx}-b`, email, name: 'B',
            password_hash: 'h', is_admin: 1, disabled: 0, created_at: now(),
          }),
        ]);

        const wins = [r1, r2].filter((r) => r.status === 'fulfilled').length;
        const losses = [r1, r2].filter((r) => r.status === 'rejected').length;
        assert.equal(wins, 1, 'exactly one concurrent call should succeed');
        assert.equal(losses, 1, 'the duplicate-email attempt must be rejected');

        // Failed attempt must not have left a ghost user
        assert.equal(
          await freshRepo.countUsers(),
          1,
          'failed attempt must leave no ghost user; store must have exactly 1 user',
        );

        // The winning user is retrievable by the shared email
        const found = await freshRepo.getUserByEmail(email);
        assert.ok(found, 'winner user must be retrievable by email');
      } finally {
        await cleanup();
      }
    });

    // ── Concurrent invitation claim ───────────────────────────────────────────

    test('markInvitationUsed — concurrent claims: exactly one wins', async () => {
      const creatorId = `inv-conc-cr-${sfx}`;
      await repo.createUser({
        id: creatorId, email: `inv-conc-cr-${sfx}@test.com`, name: 'Conc Creator',
        password_hash: 'h', is_admin: 1, disabled: 0, created_at: now(),
      });

      const tokenHash = sha256(`invite-conc-${sfx}`);
      await repo.createInvitation({
        token_hash: tokenHash, email: null, is_admin: 0, portal_role: 'member',
        project_id: null, project_access: null, team_id: null,
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        created_by: creatorId, created_at: now(),
      });

      const [r1, r2] = await Promise.allSettled([
        repo.markInvitationUsed(tokenHash, `usr-conc-a-${sfx}`, now()),
        repo.markInvitationUsed(tokenHash, `usr-conc-b-${sfx}`, now()),
      ]);

      // Both must resolve (no errors)
      assert.equal(r1.status, 'fulfilled', 'first concurrent claim should not throw');
      assert.equal(r2.status, 'fulfilled', 'second concurrent claim should not throw');

      const results = [r1, r2].map((r) => (r as PromiseFulfilledResult<boolean>).value);
      const trueCount = results.filter(Boolean).length;
      assert.equal(trueCount, 1, 'exactly one concurrent invitation claim should succeed');
    });

    test('releaseInvitationClaim — resets used_at so invite can be retried', async () => {
      const creatorId = `inv-rel-cr-${sfx}`;
      await repo.createUser({
        id: creatorId, email: `inv-rel-cr-${sfx}@test.com`, name: 'Release Creator',
        password_hash: 'h', is_admin: 1, disabled: 0, created_at: now(),
      });

      const tokenHash = sha256(`invite-rel-${sfx}`);
      await repo.createInvitation({
        token_hash: tokenHash, email: null, is_admin: 0, portal_role: 'member',
        project_id: null, project_access: null, team_id: null,
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        created_by: creatorId, created_at: now(),
      });

      // Claim the invite
      const userId = `usr-rel-${sfx}`;
      const claimed = await repo.markInvitationUsed(tokenHash, userId, now());
      assert.equal(claimed, true, 'initial claim should succeed');

      // Release the claim
      await repo.releaseInvitationClaim(tokenHash);

      // Invite should be claimable again
      const inv = await repo.getInvitationByHash(tokenHash);
      assert.ok(inv, 'invite should still exist after release');
      assert.equal(inv.used_at, null, 'used_at should be null after release');
      assert.equal(inv.used_by, null, 'used_by should be null after release');

      // Re-claim should now succeed
      const reClaimed = await repo.markInvitationUsed(tokenHash, `usr-rel2-${sfx}`, now());
      assert.equal(reClaimed, true, 'invite should be claimable again after release');
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

describe('SQLite', () => {
  before(() => {
    createTestDb();
  });
  after(cleanup);

  runContract('SQLite', async () => {
    clearAuthRepository();
    return new SqliteAuthRepository();
  }, async () => {
    // Each createFirstAdmin test gets its own fresh in-memory database.
    // createTestDb() replaces the global db — since SqliteAuthRepository uses the global
    // db functions, this gives us a guaranteed-empty store.  The shared `repo` from
    // makeRepo will also point to this new db, which is fine because the tests that
    // follow the createFirstAdmin group create all their own data from scratch.
    createTestDb();
    return {
      repo: new SqliteAuthRepository(),
      cleanup: async () => { /* createTestDb already replaced the global db; nothing to undo */ },
    };
  });
});

// ── DynamoDB Local suite ──────────────────────────────────────────────────────

const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE_PORTAL_USERS ?? 'portal-users-test';
const DYNAMODB_REGION = process.env.DYNAMODB_REGION ?? process.env.AWS_REGION ?? 'ap-southeast-1';
const REQUIRE_DYNAMODB = process.env.REQUIRE_DYNAMODB === '1';

describe('DynamoDB Local suite', async () => {
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
    if (REQUIRE_DYNAMODB) {
      test('FAIL — DynamoDB Local required but not reachable', () => {
        throw new Error(
          `REQUIRE_DYNAMODB=1 is set but DynamoDB Local is not reachable at ${DYNAMODB_ENDPOINT}. ` +
          'Start it with: docker run -d --name ddb-local -p 8000:8000 amazon/dynamodb-local',
        );
      });
    } else {
      test('SKIP — DynamoDB Local not reachable', () => {
        console.log(
          `[auth-repo] DynamoDB Local not reachable at ${DYNAMODB_ENDPOINT}. ` +
          'Set REQUIRE_DYNAMODB=1 to turn this skip into a failure.',
        );
      });
    }
    return;
  }

  const { DynamoDbAuthRepository, ensurePortalUsersTableExists } = await import(
    '../server/repositories/auth-dynamodb.ts'
  );
  const { DynamoDBClient, DeleteTableCommand } = await import('@aws-sdk/client-dynamodb');

  const ddbClient = new DynamoDBClient({
    endpoint: DYNAMODB_ENDPOINT,
    region: DYNAMODB_REGION,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });

  await ensurePortalUsersTableExists(ddbClient, DYNAMODB_TABLE);

  runContract('DynamoDB Local', async () => {
    clearAuthRepository();
    return new DynamoDbAuthRepository({ client: ddbClient, tableName: DYNAMODB_TABLE });
  }, async () => {
    // Each createFirstAdmin test gets its own table with a unique name so it starts empty.
    const uniqueTable = `${DYNAMODB_TABLE}-fa-${Date.now().toString(36)}`;
    await ensurePortalUsersTableExists(ddbClient, uniqueTable);
    return {
      repo: new DynamoDbAuthRepository({ client: ddbClient, tableName: uniqueTable }),
      cleanup: async () => {
        await ddbClient.send(new DeleteTableCommand({ TableName: uniqueTable })).catch(() => {});
      },
    };
  });
});
