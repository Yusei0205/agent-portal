/**
 * Contract tests for LearnRepository.
 *
 * Covers: learn_docs, quizzes, quiz_attempts, paths, doc_reads.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteLearnRepository } from '../server/repositories/learn-sqlite.ts';
import type { LearnRepository } from '../server/repositories/learn.ts';
import { clearLearnRepository } from '../server/repositories/learn.ts';
import { now, generateId } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function runContract(
  label: string,
  makeRepo: () => Promise<LearnRepository>,
  projectId: string,
  userId: string,
): void {
  describe(`${label} — LearnRepository contract`, () => {
    let repo: LearnRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;

    before(async () => { repo = await makeRepo(); });
    after(() => { clearLearnRepository(); });

    // ── learn_docs ─────────────────────────────────────────────────────────────

    test('createDoc — round-trip', async () => {
      const id = `ld-${sfx}-1`;
      const rec = await repo.createDoc({
        id, project_id: projectId, title: 'API Guide', slug: `api-guide-${sfx}`,
        kind: 'feature-guide', focus: '', doc_ids: '[]', source_refs: '[]',
        source_hash: null, business_md: 'Content here', technical_md: '',
        glossary: '[]', status: 'draft', stale: 0, error: null, run_id: null,
        created_by: userId, created_at: now(), updated_at: now(),
        approved_by: null, published_at: null, audience: null,
      });
      assert.equal(rec.id, id);
      assert.equal(rec.title, 'API Guide');
    });

    test('getDocById — returns null for missing', async () => {
      const result = await repo.getDocById(`missing-${sfx}`);
      assert.equal(result, null);
    });

    test('listDocsByProject — includes created doc', async () => {
      const id = `ld-${sfx}-2`;
      await repo.createDoc({
        id, project_id: projectId, title: 'Setup Guide', slug: `setup-${sfx}`,
        kind: 'overview', focus: '', doc_ids: '[]', source_refs: '[]',
        source_hash: null, business_md: '', technical_md: '',
        glossary: '[]', status: 'draft', stale: 0, error: null, run_id: null,
        created_by: userId, created_at: now(), updated_at: now(),
        approved_by: null, published_at: null, audience: null,
      });
      const docs = await repo.listDocsByProject(projectId);
      assert.ok(docs.some((d) => d.id === id));
    });

    test('updateDoc — changes status', async () => {
      const id = `ld-${sfx}-3`;
      await repo.createDoc({
        id, project_id: projectId, title: 'Patch Test', slug: `patch-${sfx}`,
        kind: 'overview', focus: '', doc_ids: '[]', source_refs: '[]',
        source_hash: null, business_md: '', technical_md: '',
        glossary: '[]', status: 'draft', stale: 0, error: null, run_id: null,
        created_by: userId, created_at: now(), updated_at: now(),
        approved_by: null, published_at: null, audience: null,
      });
      await repo.updateDoc(id, { status: 'published', updated_at: now() });
      const found = await repo.getDocById(id);
      assert.equal(found?.status, 'published');
    });

    // ── quizzes ────────────────────────────────────────────────────────────────

    test('createQuiz — round-trip', async () => {
      const id = `qz-${sfx}-1`;
      const rec = await repo.createQuiz({
        id, project_id: projectId, title: 'API Quiz', audience: 'engineers',
        difficulty: 'medium', learn_doc_id: null, doc_ids: '[]', source_refs: '[]',
        source_hash: null, questions: '[]', dropped: 0, status: 'draft',
        stale: 0, error: null, run_id: null,
        created_by: userId, created_at: now(), updated_at: now(),
        approved_by: null, published_at: null,
      });
      assert.equal(rec.id, id);
      assert.equal(rec.title, 'API Quiz');
    });

    test('listQuizzesByProject — includes created quiz', async () => {
      const id = `qz-${sfx}-2`;
      await repo.createQuiz({
        id, project_id: projectId, title: 'Listed Quiz', audience: 'everyone',
        difficulty: 'easy', learn_doc_id: null, doc_ids: '[]', source_refs: '[]',
        source_hash: null, questions: '[]', dropped: 0, status: 'draft',
        stale: 0, error: null, run_id: null,
        created_by: userId, created_at: now(), updated_at: now(),
        approved_by: null, published_at: null,
      });
      const quizzes = await repo.listQuizzesByProject(projectId);
      assert.ok(quizzes.some((q) => q.id === id));
    });

    // ── quiz_attempts ──────────────────────────────────────────────────────────

    test('createAttempt and listAttemptsByQuiz', async () => {
      const quizId = `qz-${sfx}-3`;
      await repo.createQuiz({
        id: quizId, project_id: projectId, title: 'Attempt Quiz', audience: 'everyone',
        difficulty: 'easy', learn_doc_id: null, doc_ids: '[]', source_refs: '[]',
        source_hash: null, questions: '[{"id":"q1","type":"mcq","question":"Q?","answer":"A"}]',
        dropped: 0, status: 'published',
        stale: 0, error: null, run_id: null,
        created_by: userId, created_at: now(), updated_at: now(),
        approved_by: null, published_at: now(),
      });
      const attId = `att-${sfx}-1`;
      await repo.createAttempt({
        id: attId, quiz_id: quizId, user_id: userId,
        answers: '["A"]', results: '[true]', score: 1, total: 1, created_at: now(),
      });
      const attempts = await repo.listAttemptsByQuiz(quizId, userId);
      assert.ok(attempts.some((a) => a.id === attId));
    });

    // ── paths ──────────────────────────────────────────────────────────────────

    test('createPath — round-trip', async () => {
      const id = `path-${sfx}-1`;
      const rec = await repo.createPath({
        id, project_id: projectId, title: 'Onboarding Path', audience: 'everyone',
        description: 'Learn the basics', steps: '[]', status: 'draft',
        created_by: userId, created_at: now(), updated_at: now(),
      });
      assert.equal(rec.id, id);
      assert.equal(rec.title, 'Onboarding Path');
    });

    test('listPathsByProject — includes created path', async () => {
      const id = `path-${sfx}-2`;
      await repo.createPath({
        id, project_id: projectId, title: 'Eng Path', audience: 'engineers',
        description: '', steps: '[]', status: 'draft',
        created_by: userId, created_at: now(), updated_at: now(),
      });
      const paths = await repo.listPathsByProject(projectId);
      assert.ok(paths.some((p) => p.id === id));
    });

    // ── doc_reads ──────────────────────────────────────────────────────────────

    test('markRead and isRead', async () => {
      const docId = `ld-${sfx}-4`;
      await repo.createDoc({
        id: docId, project_id: projectId, title: 'Read Test', slug: `read-test-${sfx}`,
        kind: 'overview', focus: '', doc_ids: '[]', source_refs: '[]',
        source_hash: null, business_md: '', technical_md: '',
        glossary: '[]', status: 'published', stale: 0, error: null, run_id: null,
        created_by: userId, created_at: now(), updated_at: now(),
        approved_by: null, published_at: now(), audience: null,
      });
      const readUserId = userId;  // Use existing user to satisfy FK constraint
      assert.equal(await repo.isRead(docId, readUserId), false);
      await repo.markRead(docId, readUserId, now());
      assert.equal(await repo.isRead(docId, readUserId), true);
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

const sqliteProjectId = `proj-learn-${RUN_TAG}`;
const sqliteUserId = `usr-learn-${RUN_TAG}`;

runContract(
  'SQLite',
  async () => {
    createTestDb();
    try {
      insert('users', {
        id: sqliteUserId, email: `${sqliteUserId}@test.com`, name: 'Test',
        password_hash: 'x', is_admin: 1, created_at: now(),
      });
      insert('projects', {
        id: sqliteProjectId, name: `proj-learn-${RUN_TAG}`, slug: `proj-learn-${RUN_TAG}`,
        created_by: sqliteUserId, created_at: now(), archived: 0,
      });
    } catch { /* already exists */ }
    return new SqliteLearnRepository();
  },
  sqliteProjectId,
  sqliteUserId,
);

// ── DynamoDB suite ────────────────────────────────────────────────────────────

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB === '1') {
      throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT is not set');
    }
    test.skip('DynamoDB Local not available (DYNAMODB_ENDPOINT not set)', () => {});
    return;
  }

  const { DynamoDbLearnRepository, ensureLearnTableExists } = await import(
    '../server/repositories/learn-dynamodb.ts'
  );
  const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');

  const tableName = `portal-learn-test-${RUN_TAG}`;
  const dynProjectId = `proj-ln-dyn-${RUN_TAG}`;
  const dynUserId = `usr-ln-dyn-${RUN_TAG}`;

  before(async () => {
    clearDynamoDbClient();
    process.env.DYNAMODB_TABLE_PORTAL_LEARN = tableName;
    const repo = new DynamoDbLearnRepository({ tableName });
    await ensureLearnTableExists(repo.getClient(), tableName);
  });

  after(() => {
    delete process.env.DYNAMODB_TABLE_PORTAL_LEARN;
    clearDynamoDbClient();
    clearLearnRepository();
  });

  runContract(
    'DynamoDB',
    async () => new DynamoDbLearnRepository({ tableName }),
    dynProjectId,
    dynUserId,
  );
});
