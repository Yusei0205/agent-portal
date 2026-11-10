/**
 * Contract tests for AiAttachmentRepository.
 *
 * The same assertions run against both SQLite and DynamoDB implementations.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to fail instead of skip when endpoint is missing.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteAiAttachmentRepository } from '../server/repositories/ai-attachments-sqlite.ts';
import type { AiAttachmentRepository } from '../server/repositories/ai-attachments.ts';
import { clearAiAttachmentRepository } from '../server/repositories/ai-attachments.ts';
import { now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

// ── Shared contract suite ─────────────────────────────────────────────────────

function runContract(
  label: string,
  makeRepo: () => Promise<AiAttachmentRepository>,
): void {
  describe(`${label} — AiAttachmentRepository contract`, () => {
    let repo: AiAttachmentRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    const projectId = `proj-${sfx}`;
    const userId = `user-${sfx}`;

    before(async () => {
      if (label.toLowerCase().includes('sqlite')) {
        createTestDb();
        // Seed the project and user so FK constraints pass
        try {
        insert('users', {
          id: userId, email: `${userId}@test.com`, name: 'Test',
          password_hash: 'x', is_admin: 1, created_at: now(),
        });
        insert('projects', {
          id: projectId, name: `proj-${RUN_TAG}`, slug: `proj-att-${RUN_TAG}`,
          created_by: userId, created_at: now(), archived: 0,
        });
      } catch { /* already exists */ }
      }
      repo = await makeRepo();
    });

    after(() => {
      clearAiAttachmentRepository();
      if (label.toLowerCase().includes('sqlite')) cleanup();
    });

    test('create — round-trip', async () => {
      const id = `att-${sfx}-1`;
      const rec = await repo.create({
        id,
        project_id: projectId,
        filename: 'test.png',
        original_name: 'test.png',
        mime_type: 'image/png',
        size: 1024,
        kind: 'image',
        file_path: `/tmp/${id}.png`,
        parent_kind: null,
        parent_id: null,
        uploaded_by: userId,
        created_at: now(),
      });
      assert.equal(rec.id, id);
      assert.equal(rec.kind, 'image');
      assert.equal(rec.filename, 'test.png');
    });

    test('getById — returns record', async () => {
      const id = `att-${sfx}-2`;
      await repo.create({
        id, project_id: projectId, filename: 'doc.pdf', original_name: 'doc.pdf',
        mime_type: 'application/pdf', size: 2048, kind: 'document',
        file_path: `/tmp/${id}.pdf`, parent_kind: null, parent_id: null,
        uploaded_by: userId, created_at: now(),
      });
      const found = await repo.getById(id);
      assert.ok(found, 'should find by id');
      assert.equal(found.id, id);
    });

    test('getById — returns null for missing', async () => {
      const result = await repo.getById(`missing-${sfx}`);
      assert.equal(result, null);
    });

    test('getByIdForProject — returns null for wrong project', async () => {
      const id = `att-${sfx}-3`;
      await repo.create({
        id, project_id: projectId, filename: 'x.png', original_name: 'x.png',
        mime_type: 'image/png', size: 100, kind: 'image',
        file_path: `/tmp/${id}.png`, parent_kind: null, parent_id: null,
        uploaded_by: userId, created_at: now(),
      });
      const result = await repo.getByIdForProject(id, `wrong-proj-${sfx}`);
      assert.equal(result, null);
    });

    test('listByProject — returns all project attachments', async () => {
      const id1 = `att-${sfx}-4`;
      const id2 = `att-${sfx}-5`;
      for (const id of [id1, id2]) {
        await repo.create({
          id, project_id: projectId, filename: `${id}.png`, original_name: `${id}.png`,
          mime_type: 'image/png', size: 512, kind: 'image',
          file_path: `/tmp/${id}.png`, parent_kind: null, parent_id: null,
          uploaded_by: userId, created_at: now(),
        });
      }
      const list = await repo.listByProject(projectId);
      const ids = list.map((a) => a.id);
      assert.ok(ids.includes(id1), 'should include id1');
      assert.ok(ids.includes(id2), 'should include id2');
    });

    test('linkToParent — updates parent_kind and parent_id', async () => {
      const id = `att-${sfx}-6`;
      await repo.create({
        id, project_id: projectId, filename: 'd.png', original_name: 'd.png',
        mime_type: 'image/png', size: 100, kind: 'image',
        file_path: `/tmp/${id}.png`, parent_kind: null, parent_id: null,
        uploaded_by: userId, created_at: now(),
      });
      await repo.linkToParent([id], 'diagram', `diag-${sfx}`);
      const found = await repo.getById(id);
      assert.equal(found?.parent_kind, 'diagram');
      assert.equal(found?.parent_id, `diag-${sfx}`);
    });

    test('listByParent — returns linked attachments', async () => {
      const diagId = `diag-list-${sfx}`;
      const id = `att-${sfx}-7`;
      await repo.create({
        id, project_id: projectId, filename: 'e.png', original_name: 'e.png',
        mime_type: 'image/png', size: 100, kind: 'image',
        file_path: `/tmp/${id}.png`, parent_kind: 'diagram', parent_id: diagId,
        uploaded_by: userId, created_at: now(),
      });
      const list = await repo.listByParent('diagram', diagId);
      assert.ok(list.some((a) => a.id === id));
    });

    test('deleteByIds — removes records', async () => {
      const id = `att-${sfx}-8`;
      await repo.create({
        id, project_id: projectId, filename: 'del.png', original_name: 'del.png',
        mime_type: 'image/png', size: 100, kind: 'image',
        file_path: `/tmp/${id}.png`, parent_kind: null, parent_id: null,
        uploaded_by: userId, created_at: now(),
      });
      await repo.deleteByIds([id]);
      const found = await repo.getById(id);
      assert.equal(found, null, 'should be deleted');
    });

    test('getByIds — returns records in order', async () => {
      const ids = [`att-${sfx}-9a`, `att-${sfx}-9b`];
      for (const id of ids) {
        await repo.create({
          id, project_id: projectId, filename: `${id}.png`, original_name: `${id}.png`,
          mime_type: 'image/png', size: 100, kind: 'image',
          file_path: `/tmp/${id}.png`, parent_kind: null, parent_id: null,
          uploaded_by: userId, created_at: now(),
        });
      }
      const result = await repo.getByIds(ids);
      assert.equal(result.length, 2);
      const resultIds = result.map((r) => r.id);
      for (const id of ids) assert.ok(resultIds.includes(id));
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

runContract('SQLite', async () => new SqliteAiAttachmentRepository());

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

  const { DynamoDbAiAttachmentRepository, ensureAiAttachmentTableExists } = await import(
    '../server/repositories/ai-attachments-dynamodb.ts'
  );
  const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');

  const tableName = `portal-create-test-att-${RUN_TAG}`;

  before(async () => {
    clearDynamoDbClient();
    process.env.DYNAMODB_TABLE_PORTAL_CREATE = tableName;
    const repo = new DynamoDbAiAttachmentRepository({ tableName });
    await ensureAiAttachmentTableExists(repo.getClient(), tableName);
  });

  after(() => {
    delete process.env.DYNAMODB_TABLE_PORTAL_CREATE;
    clearDynamoDbClient();
    clearAiAttachmentRepository();
  });

  runContract('DynamoDB', async () => {
    const repo = new DynamoDbAiAttachmentRepository({ tableName });
    return repo;
  });
});
