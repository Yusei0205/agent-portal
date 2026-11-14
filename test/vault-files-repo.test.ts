/**
 * Contract tests for VaultFilesRepository.
 *
 * The same assertions run against both SQLite and DynamoDB Local.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to turn the skip into a failure.
 *
 * To run locally (PowerShell 5.1 — no &&):
 *   docker run -d --rm --name ddb-vault -p 8000:8000 amazon/dynamodb-local
 *   $env:DYNAMODB_ENDPOINT='http://localhost:8000'; $env:REQUIRE_DYNAMODB='1'
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/vault-files-repo.test.ts
 *   docker stop ddb-vault
 *   Remove-Item Env:DYNAMODB_ENDPOINT; Remove-Item Env:REQUIRE_DYNAMODB
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './fixtures.ts';
import { SqliteVaultFilesRepository } from '../server/repositories/vault-files-sqlite.ts';
import type { VaultFilesRepository } from '../server/repositories/vault-files.ts';
import { clearVaultFilesRepository } from '../server/repositories/vault-files.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

// ── FK helpers ────────────────────────────────────────────────────────────────

function maybeProject(id: string, isSqlite: boolean): void {
  if (!isSqlite) return;
  try {
    insert('projects', {
      id,
      slug: `slug-${id}`,
      name: `proj-${id}`,
      description: '',
      notes: '',
      created_by: null,
      created_at: now(),
      archived: 0,
      default_lead_agent: '',
      default_model: '',
      monthly_budget_usd: null,
      team_id: null,
      vault_generated: 0,
    });
  } catch { /* duplicate */ }
}

function makeInput(overrides: Partial<Parameters<VaultFilesRepository['create']>[0]> = {}) {
  return {
    id: generateId(),
    project_id: null as string | null,
    user_id: null as string | null,
    name: 'file.pdf',
    path: 'vault/portal/file.pdf',
    size_bytes: 1024,
    mime_type: 'application/pdf',
    uploaded_by: null as string | null,  // nullable FK to users
    folder: null,
    source_workflow_id: null,
    created_at: now(),
    ...overrides,
  };
}

// ── Shared contract ───────────────────────────────────────────────────────────

function runContract(label: string, makeRepo: () => Promise<VaultFilesRepository>): void {
  describe(`${label} -- VaultFilesRepository contract`, () => {
    let repo: VaultFilesRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    const isSqlite = label === 'SQLite';

    before(async () => {
      repo = await makeRepo();
    });

    after(() => {
      clearVaultFilesRepository();
    });

    // ── CRUD ─────────────────────────────────────────────────────────────────

    test('create -- stores and returns vault file', async () => {
      const pid = `vpid-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      const f = await repo.create(makeInput({ id, project_id: pid, name: 'a.pdf' }));
      assert.equal(f.id, id);
      assert.equal(f.project_id, pid);
      assert.equal(f.name, 'a.pdf');
    });

    test('getById -- returns vault file', async () => {
      const pid = `vpid2-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.create(makeInput({ id, project_id: pid }));
      const found = await repo.getById(id);
      assert.ok(found);
      assert.equal(found.id, id);
    });

    test('getById -- returns null for unknown', async () => {
      const found = await repo.getById(`missing-${sfx}`);
      assert.equal(found, null);
    });

    test('getByIdForProject -- returns file for correct project', async () => {
      const pid = `vproj-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.create(makeInput({ id, project_id: pid }));
      const found = await repo.getByIdForProject(id, pid);
      assert.ok(found);
    });

    test('getByIdForProject -- returns null for wrong project', async () => {
      const pid = `vproj2-${sfx}`;
      maybeProject(pid, isSqlite);
      const otherpid = `vproj3-${sfx}`;
      maybeProject(otherpid, isSqlite);
      const id = generateId();
      await repo.create(makeInput({ id, project_id: pid }));
      const notFound = await repo.getByIdForProject(id, otherpid);
      assert.equal(notFound, null);
    });

    test('getByIdForProject -- returns portal file (project_id=null) for any project', async () => {
      const pid = `vportalproj-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.create(makeInput({ id, project_id: null }));
      const found = await repo.getByIdForProject(id, pid);
      assert.ok(found, 'portal-scoped file must be visible for any project lookup');
    });

    test('delete -- removes file', async () => {
      const pid = `vdel-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.create(makeInput({ id, project_id: pid }));
      await repo.delete(id);
      assert.equal(await repo.getById(id), null);
    });

    test('updateSizeAndMime -- updates file', async () => {
      const pid = `vupd-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.create(makeInput({ id, project_id: pid, size_bytes: 100, mime_type: 'application/pdf' }));
      await repo.updateSizeAndMime(id, 999, 'image/png');
      const f = await repo.getById(id);
      assert.ok(f);
      assert.equal(f.size_bytes, 999);
      assert.equal(f.mime_type, 'image/png');
    });

    test('updateFolder -- sets folder', async () => {
      const pid = `vfold-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.create(makeInput({ id, project_id: pid }));
      await repo.updateFolder(id, 'Sessions/MySession');
      const f = await repo.getById(id);
      assert.ok(f);
      assert.equal(f.folder, 'Sessions/MySession');
    });

    test('updateFolder -- sets folder to null', async () => {
      const pid = `vfold2-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.create(makeInput({ id, project_id: pid, folder: 'Sessions/Old' }));
      await repo.updateFolder(id, null);
      const f = await repo.getById(id);
      assert.ok(f);
      assert.equal(f.folder, null);
    });

    // ── List by project/scope ─────────────────────────────────────────────────

    test('listByProject -- returns project scope files', async () => {
      const pid = `vlst-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.create(makeInput({ id, project_id: pid, user_id: null }));
      const files = await repo.listByProject(pid, 'userX', 'project');
      assert.ok(files.some((f) => f.id === id));
    });

    test('listByProject -- project scope excludes personal files', async () => {
      const pid = `vlst2-${sfx}`;
      maybeProject(pid, isSqlite);
      const personalId = generateId();
      await repo.create(makeInput({ id: personalId, project_id: pid, user_id: 'userA' }));
      const files = await repo.listByProject(pid, 'userA', 'project');
      assert.ok(!files.some((f) => f.id === personalId), 'personal file must not appear in project scope');
    });

    test('listByProject -- personal scope returns only own files', async () => {
      const pid = `vlst3-${sfx}`;
      maybeProject(pid, isSqlite);
      const myId = generateId();
      const otherId = generateId();
      await repo.create(makeInput({ id: myId, project_id: pid, user_id: 'userA' }));
      await repo.create(makeInput({ id: otherId, project_id: pid, user_id: 'userB' }));
      const files = await repo.listByProject(pid, 'userA', 'personal');
      assert.ok(files.some((f) => f.id === myId));
      assert.ok(!files.some((f) => f.id === otherId), 'other user files must not appear');
    });

    test('listByProject -- combined returns all accessible files', async () => {
      const pid = `vlst4-${sfx}`;
      maybeProject(pid, isSqlite);
      const projId = generateId();
      const persId = generateId();
      const portalId = generateId();
      await repo.create(makeInput({ id: projId, project_id: pid, user_id: null }));
      await repo.create(makeInput({ id: persId, project_id: pid, user_id: 'userC' }));
      await repo.create(makeInput({ id: portalId, project_id: null, user_id: null }));
      const files = await repo.listByProject(pid, 'userC', null);
      assert.ok(files.some((f) => f.id === projId), 'project file must be included');
      assert.ok(files.some((f) => f.id === persId), 'personal file must be included');
      assert.ok(files.some((f) => f.id === portalId), 'portal file must be included');
    });

    test('listPortal -- returns portal-scoped files only', async () => {
      const portalId = generateId();
      const pid = `vlstp-${sfx}`;
      maybeProject(pid, isSqlite);
      const projId = generateId();
      await repo.create(makeInput({ id: portalId, project_id: null }));
      await repo.create(makeInput({ id: projId, project_id: pid }));
      const files = await repo.listPortal();
      assert.ok(files.some((f) => f.id === portalId));
      assert.ok(!files.some((f) => f.id === projId), 'project file must not appear in portal list');
    });

    // ── Bulk ─────────────────────────────────────────────────────────────────

    test('bulkDelete -- removes multiple files', async () => {
      const pid = `vbulk-${sfx}`;
      maybeProject(pid, isSqlite);
      const id1 = generateId();
      const id2 = generateId();
      await repo.create(makeInput({ id: id1, project_id: pid }));
      await repo.create(makeInput({ id: id2, project_id: pid }));
      await repo.bulkDelete([id1, id2]);
      assert.equal(await repo.getById(id1), null);
      assert.equal(await repo.getById(id2), null);
    });

    test('bulkUpdateFolder -- updates folder for multiple files', async () => {
      const pid = `vbf-${sfx}`;
      maybeProject(pid, isSqlite);
      const id1 = generateId();
      const id2 = generateId();
      await repo.create(makeInput({ id: id1, project_id: pid }));
      await repo.create(makeInput({ id: id2, project_id: pid }));
      await repo.bulkUpdateFolder([id1, id2], 'NewFolder');
      const f1 = await repo.getById(id1);
      const f2 = await repo.getById(id2);
      assert.equal(f1?.folder, 'NewFolder');
      assert.equal(f2?.folder, 'NewFolder');
    });

    test('findByWorkflowFolderName -- finds existing vault file', async () => {
      const pid = `vwfname-${sfx}`;
      maybeProject(pid, isSqlite);
      const wfId = `wf-${sfx}`;
      const id = generateId();
      await repo.create(makeInput({
        id,
        project_id: pid,
        user_id: null,
        name: 'output.md',
        folder: 'Sessions/Test',
        source_workflow_id: wfId,
      }));
      const found = await repo.findByWorkflowFolderName(pid, 'Sessions/Test', 'output.md', wfId);
      assert.ok(found);
      assert.equal(found.id, id);
    });

    test('findByWorkflowFolderName -- returns null for wrong workflow', async () => {
      const pid = `vwfname2-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.create(makeInput({
        id,
        project_id: pid,
        user_id: null,
        name: 'out.md',
        folder: 'Sessions/Test',
        source_workflow_id: 'wf-A',
      }));
      const notFound = await repo.findByWorkflowFolderName(pid, 'Sessions/Test', 'out.md', 'wf-B');
      assert.equal(notFound, null);
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

runContract('SQLite', async () => {
  createTestDb();
  return new SqliteVaultFilesRepository();
});

// ── DynamoDB suite ────────────────────────────────────────────────────────────

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const require = process.env.REQUIRE_DYNAMODB === '1';

  if (!endpoint) {
    if (require) throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT is not set');
    test.skip('DynamoDB Local suite -- DYNAMODB_ENDPOINT not set');
    return;
  }

  const { DynamoDbVaultFilesRepository } = await import('../server/repositories/vault-files-dynamodb.ts');

  runContract('DynamoDB', async () => {
    const repo = new DynamoDbVaultFilesRepository();
    await repo.ensureTables();
    return repo;
  });
});
