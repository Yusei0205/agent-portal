/**
 * Contract tests for create-module repositories:
 *   PresentationRepository, GeneratedDocRepository, DiagramRepository, DocTemplateRepository.
 *
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqlitePresentationRepository } from '../server/repositories/presentations-data-sqlite.ts';
import { SqliteGeneratedDocRepository } from '../server/repositories/generated-docs-data-sqlite.ts';
import { SqliteDiagramRepository } from '../server/repositories/diagrams-data-sqlite.ts';
import { SqliteDocTemplateRepository } from '../server/repositories/doc-templates-data-sqlite.ts';
import type { PresentationRepository } from '../server/repositories/presentations-data.ts';
import type { GeneratedDocRepository } from '../server/repositories/generated-docs-data.ts';
import type { DiagramRepository } from '../server/repositories/diagrams-data.ts';
import type { DocTemplateRepository } from '../server/repositories/doc-templates-data.ts';
import { clearPresentationRepository } from '../server/repositories/presentations-data.ts';
import { clearGeneratedDocRepository as clearGdoc } from '../server/repositories/generated-docs-data.ts';
import { clearDiagramRepository as clearDiag } from '../server/repositories/diagrams-data.ts';
import { clearDocTemplateRepository as clearDtpl } from '../server/repositories/doc-templates-data.ts';
import { now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

// ── Helper ────────────────────────────────────────────────────────────────────

function seedProjectUser(projectId: string, userId: string): void {
  try {
    insert('users', {
      id: userId, email: `${userId}@test.com`, name: 'Test',
      password_hash: 'x', is_admin: 1, created_at: now(),
    });
    insert('projects', {
      id: projectId, name: `proj-${RUN_TAG}`, slug: `proj-cr-${RUN_TAG}`,
      created_by: userId, created_at: now(), archived: 0,
    });
  } catch { /* already exists */ }
}

// ── Presentations contract ─────────────────────────────────────────────────────

function runPresentationContract(
  label: string,
  makeRepo: () => Promise<PresentationRepository>,
  projectId: string,
  userId: string,
): void {
  describe(`${label} — PresentationRepository contract`, () => {
    let repo: PresentationRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;

    before(async () => { repo = await makeRepo(); });
    after(() => { /* repo is local; no global singleton to clear */ });

    test('create — round-trip', async () => {
      const id = `pres-${sfx}-1`;
      const rec = await repo.create({
        id, project_id: projectId, name: 'Q3 Review', topic: 'Q3 results',
        source_kind: 'topic', source_ref: null, audience: 'executives',
        slide_count: 10, diagram_style: 'mermaid', diagram_cloud: null,
        lead_agent: null, trust_all_tools: 0, status: 'ready',
        created_by: userId, created_at: now(), updated_at: now(), attachment_ids: '[]',
      });
      assert.equal(rec.id, id);
      assert.equal(rec.name, 'Q3 Review');
    });

    test('getById — returns record for correct project', async () => {
      const id = `pres-${sfx}-2`;
      await repo.create({
        id, project_id: projectId, name: 'Arch Overview', topic: null,
        source_kind: 'topic', source_ref: null, audience: null,
        slide_count: 12, diagram_style: 'mermaid', diagram_cloud: null,
        lead_agent: null, trust_all_tools: 0, status: 'ready',
        created_by: userId, created_at: now(), updated_at: now(), attachment_ids: '[]',
      });
      const found = await repo.getById(id, projectId);
      assert.ok(found);
      assert.equal(found.id, id);
    });

    test('getById — returns null for wrong project', async () => {
      const id = `pres-${sfx}-3`;
      await repo.create({
        id, project_id: projectId, name: 'X', topic: null,
        source_kind: 'topic', source_ref: null, audience: null,
        slide_count: 5, diagram_style: 'mermaid', diagram_cloud: null,
        lead_agent: null, trust_all_tools: 0, status: 'ready',
        created_by: userId, created_at: now(), updated_at: now(), attachment_ids: '[]',
      });
      const result = await repo.getById(id, `wrong-${sfx}`);
      assert.equal(result, null);
    });

    test('listByProject — includes created presentation', async () => {
      const id = `pres-${sfx}-4`;
      await repo.create({
        id, project_id: projectId, name: 'Listed Pres', topic: 'test',
        source_kind: 'topic', source_ref: null, audience: null,
        slide_count: 8, diagram_style: 'mermaid', diagram_cloud: null,
        lead_agent: null, trust_all_tools: 0, status: 'ready',
        created_by: userId, created_at: now(), updated_at: now(), attachment_ids: '[]',
      });
      const list = await repo.listByProject(projectId);
      assert.ok(list.some((p) => p.id === id));
    });

    test('update — changes status', async () => {
      const id = `pres-${sfx}-5`;
      await repo.create({
        id, project_id: projectId, name: 'Update Test', topic: null,
        source_kind: 'topic', source_ref: null, audience: null,
        slide_count: 6, diagram_style: 'mermaid', diagram_cloud: null,
        lead_agent: null, trust_all_tools: 0, status: 'ready',
        created_by: userId, created_at: now(), updated_at: now(), attachment_ids: '[]',
      });
      await repo.update(id, { status: 'generating', updated_at: now() });
      const found = await repo.getById(id, projectId);
      assert.equal(found?.status, 'generating');
    });

    test('delete — removes record', async () => {
      const id = `pres-${sfx}-6`;
      await repo.create({
        id, project_id: projectId, name: 'Del Pres', topic: null,
        source_kind: 'topic', source_ref: null, audience: null,
        slide_count: 5, diagram_style: 'mermaid', diagram_cloud: null,
        lead_agent: null, trust_all_tools: 0, status: 'ready',
        created_by: userId, created_at: now(), updated_at: now(), attachment_ids: '[]',
      });
      await repo.delete(id);
      const found = await repo.getById(id, projectId);
      assert.equal(found, null);
    });
  });
}

// ── GeneratedDoc contract ──────────────────────────────────────────────────────

function runGenDocContract(
  label: string,
  makeRepo: () => Promise<GeneratedDocRepository>,
  projectId: string,
  userId: string,
): void {
  describe(`${label} — GeneratedDocRepository contract`, () => {
    let repo: GeneratedDocRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;

    before(async () => { repo = await makeRepo(); });
    after(() => { clearGdoc(); });

    test('create — round-trip', async () => {
      const id = `gd-${sfx}-1`;
      const rec = await repo.create({
        id, project_id: projectId, name: 'API Docs', doc_type: 'api',
        sources_json: '{}', diagram_style: 'mermaid', diagram_cloud: null,
        lead_agent: null, trust_all_tools: 0, audience: 'engineers',
        latest_version_id: null, stale: 0,
        created_by: userId, created_at: now(), attachment_ids: '[]',
      });
      assert.equal(rec.id, id);
      assert.equal(rec.doc_type, 'api');
    });

    test('getById — returns null for wrong project', async () => {
      const id = `gd-${sfx}-2`;
      await repo.create({
        id, project_id: projectId, name: 'X', doc_type: 'overview',
        sources_json: '{}', diagram_style: 'mermaid', diagram_cloud: null,
        lead_agent: null, trust_all_tools: 0, audience: null,
        latest_version_id: null, stale: 0,
        created_by: userId, created_at: now(), attachment_ids: '[]',
      });
      const result = await repo.getById(id, `wrong-${sfx}`);
      assert.equal(result, null);
    });

    test('createVersion — creates and retrieves version', async () => {
      const docId = `gd-${sfx}-3`;
      await repo.create({
        id: docId, project_id: projectId, name: 'V Doc', doc_type: 'runbook',
        sources_json: '{}', diagram_style: 'mermaid', diagram_cloud: null,
        lead_agent: null, trust_all_tools: 0, audience: null,
        latest_version_id: null, stale: 0,
        created_by: userId, created_at: now(), attachment_ids: '[]',
      });
      const vId = `gdv-${sfx}-1`;
      const ver = await repo.createVersion({
        id: vId, doc_id: docId, version_num: 1,
        md_path: '/tmp/doc.md', docx_path: null, warnings: null,
        workflow_id: null, created_at: now(),
      });
      assert.equal(ver.id, vId);
      assert.equal(ver.version_num, 1);

      const latest = await repo.getLatestVersion(docId);
      assert.ok(latest);
      assert.equal(latest.id, vId);
    });

    test('listByProject — includes created doc', async () => {
      const id = `gd-${sfx}-4`;
      await repo.create({
        id, project_id: projectId, name: 'Listed', doc_type: 'user-guide',
        sources_json: '{}', diagram_style: 'mermaid', diagram_cloud: null,
        lead_agent: null, trust_all_tools: 0, audience: null,
        latest_version_id: null, stale: 0,
        created_by: userId, created_at: now(), attachment_ids: '[]',
      });
      const list = await repo.listByProject(projectId);
      assert.ok(list.some((d) => d.id === id));
    });
  });
}

// ── Diagram contract ──────────────────────────────────────────────────────────

function runDiagramContract(
  label: string,
  makeRepo: () => Promise<DiagramRepository>,
  projectId: string,
  userId: string,
): void {
  describe(`${label} — DiagramRepository contract`, () => {
    let repo: DiagramRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;

    before(async () => { repo = await makeRepo(); });
    after(() => { clearDiag(); });

    test('create — round-trip', async () => {
      const id = `diag-${sfx}-1`;
      const rec = await repo.create({
        id, project_id: projectId, kind: 'component', title: 'Auth Flow',
        slug: `auth-flow-${sfx}`, focus: '', repo_ids: '[]', status: 'ready',
        error: null, format: 'mermaid', style: 'mermaid', cloud: '',
        lead_agent: '', trust_tools: 0, created_by: userId,
        created_at: now(), updated_at: now(), attachment_ids: '[]',
      });
      assert.equal(rec.id, id);
      assert.equal(rec.kind, 'component');
    });

    test('getByProjectAndId — returns null for wrong project', async () => {
      const id = `diag-${sfx}-2`;
      await repo.create({
        id, project_id: projectId, kind: 'data', title: 'DB Schema',
        slug: `db-schema-${sfx}`, focus: '', repo_ids: '[]', status: 'ready',
        error: null, format: 'mermaid', style: 'mermaid', cloud: '',
        lead_agent: '', trust_tools: 0, created_by: userId,
        created_at: now(), updated_at: now(), attachment_ids: '[]',
      });
      const result = await repo.getByProjectAndId(`wrong-${sfx}`, id);
      assert.equal(result, null);
    });

    test('createVersion — creates and retrieves', async () => {
      const diagId = `diag-${sfx}-3`;
      await repo.create({
        id: diagId, project_id: projectId, kind: 'component', title: 'V Diag',
        slug: `v-diag-${sfx}`, focus: '', repo_ids: '[]', status: 'ready',
        error: null, format: 'mermaid', style: 'mermaid', cloud: '',
        lead_agent: '', trust_tools: 0, created_by: userId,
        created_at: now(), updated_at: now(), attachment_ids: '[]',
      });
      const ver = await repo.createVersion({
        diagram_id: diagId, version: 1, mermaid: 'graph TD\n  A-->B',
        description: 'First version', citations: '[]', sources: '[]',
        source_hash: null, workflow_id: null, run_id: null, created_by: userId,
        created_at: now(), format: 'mermaid', style: 'mermaid', cloud: '',
        drawio: null, stats: '{}',
      });
      assert.equal(ver.version, 1);

      const latest = await repo.getLatestVersion(diagId);
      assert.ok(latest);
      assert.equal(latest.version, 1);
    });

    test('listByProject — includes created diagram', async () => {
      const id = `diag-${sfx}-4`;
      await repo.create({
        id, project_id: projectId, kind: 'component', title: 'Listed',
        slug: `listed-diag-${sfx}`, focus: '', repo_ids: '[]', status: 'ready',
        error: null, format: 'mermaid', style: 'mermaid', cloud: '',
        lead_agent: '', trust_tools: 0, created_by: userId,
        created_at: now(), updated_at: now(), attachment_ids: '[]',
      });
      const list = await repo.listByProject(projectId);
      assert.ok(list.some((d) => d.id === id));
    });

    test('slugExists — true for existing, false for missing', async () => {
      const id = `diag-${sfx}-5`;
      const slug = `slug-test-${sfx}`;
      await repo.create({
        id, project_id: projectId, kind: 'component', title: 'Slug Test',
        slug, focus: '', repo_ids: '[]', status: 'ready',
        error: null, format: 'mermaid', style: 'mermaid', cloud: '',
        lead_agent: '', trust_tools: 0, created_by: userId,
        created_at: now(), updated_at: now(), attachment_ids: '[]',
      });
      assert.equal(await repo.slugExists(projectId, slug), true);
      assert.equal(await repo.slugExists(projectId, `no-such-slug-${sfx}`), false);
    });
  });
}

// ── DocTemplate contract ──────────────────────────────────────────────────────

function runDocTemplateContract(
  label: string,
  makeRepo: () => Promise<DocTemplateRepository>,
  projectId: string,
  userId: string,
): void {
  describe(`${label} — DocTemplateRepository contract`, () => {
    let repo: DocTemplateRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;

    before(async () => { repo = await makeRepo(); });
    after(() => { clearDtpl(); });

    test('create — round-trip', async () => {
      const id = `dtpl-${sfx}-1`;
      const rec = await repo.create({
        id, project_id: projectId, name: 'Word Template',
        type: 'docx', path: `/templates/${id}.docx`,
        is_default: 0, uploaded_by: userId, created_at: now(),
      });
      assert.equal(rec.id, id);
      assert.equal(rec.type, 'docx');
    });

    test('listByProject — includes created template', async () => {
      const id = `dtpl-${sfx}-2`;
      await repo.create({
        id, project_id: projectId, name: 'PPT Template',
        type: 'pptx', path: `/templates/${id}.pptx`,
        is_default: 0, uploaded_by: userId, created_at: now(),
      });
      const list = await repo.listByProject(projectId);
      assert.ok(list.some((t) => t.id === id));
    });

    test('setDefault — marks as default', async () => {
      const id = `dtpl-${sfx}-3`;
      await repo.create({
        id, project_id: projectId, name: 'Default Tmpl',
        type: 'docx', path: `/templates/${id}.docx`,
        is_default: 0, uploaded_by: userId, created_at: now(),
      });
      await repo.setDefault(id, projectId, 'docx');
      const found = await repo.getById(id);
      assert.equal(found?.is_default, 1);
    });

    test('delete — removes record', async () => {
      const id = `dtpl-${sfx}-4`;
      await repo.create({
        id, project_id: projectId, name: 'Del Template',
        type: 'pptx', path: `/templates/${id}.pptx`,
        is_default: 0, uploaded_by: userId, created_at: now(),
      });
      await repo.delete(id);
      const found = await repo.getById(id);
      assert.equal(found, null);
    });
  });
}

// ── SQLite suites ─────────────────────────────────────────────────────────────

const sqliteProjectId = `proj-cr-${RUN_TAG}`;
const sqliteUserId = `usr-cr-${RUN_TAG}`;

runPresentationContract(
  'SQLite',
  async () => {
    createTestDb();
    seedProjectUser(sqliteProjectId, sqliteUserId);
    return new SqlitePresentationRepository();
  },
  sqliteProjectId,
  sqliteUserId,
);

runGenDocContract(
  'SQLite',
  async () => {
    return new SqliteGeneratedDocRepository();
  },
  sqliteProjectId,
  sqliteUserId,
);

runDiagramContract(
  'SQLite',
  async () => new SqliteDiagramRepository(),
  sqliteProjectId,
  sqliteUserId,
);

runDocTemplateContract(
  'SQLite',
  async () => new SqliteDocTemplateRepository(),
  sqliteProjectId,
  sqliteUserId,
);

// ── DynamoDB suites ────────────────────────────────────────────────────────────

describe('DynamoDB Local suites', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB === '1') {
      throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT is not set');
    }
    test.skip('DynamoDB Local not available (DYNAMODB_ENDPOINT not set)', () => {});
    return;
  }

  const { DynamoDbPresentationRepository, ensurePresentationTableExists } = await import(
    '../server/repositories/presentations-data-dynamodb.ts'
  );
  const { DynamoDbGeneratedDocRepository, ensureGeneratedDocTableExists } = await import(
    '../server/repositories/generated-docs-data-dynamodb.ts'
  );
  const { DynamoDbDiagramRepository, ensureDiagramTableExists } = await import(
    '../server/repositories/diagrams-data-dynamodb.ts'
  );
  const { DynamoDbDocTemplateRepository, ensureDocTemplateTableExists } = await import(
    '../server/repositories/doc-templates-data-dynamodb.ts'
  );
  const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');

  // Use separate tables per entity to avoid GSI conflicts
  const presTable = `portal-pres-test-${RUN_TAG}`;
  const gdocTable = `portal-gdoc-test-${RUN_TAG}`;
  const diagTable = `portal-diag-test-${RUN_TAG}`;
  const dtplTable = `portal-dtpl-test-${RUN_TAG}`;
  const dynProjectId = `proj-dyn-${RUN_TAG}`;
  const dynUserId = `usr-dyn-${RUN_TAG}`;

  before(async () => {
    clearDynamoDbClient();
    const presRepo = new DynamoDbPresentationRepository({ tableName: presTable });
    await ensurePresentationTableExists(presRepo.getClient(), presTable);
    const gdocRepo = new DynamoDbGeneratedDocRepository({ tableName: gdocTable });
    await ensureGeneratedDocTableExists(gdocRepo.getClient(), gdocTable);
    const diagRepo = new DynamoDbDiagramRepository({ tableName: diagTable });
    await ensureDiagramTableExists(diagRepo.getClient(), diagTable);
    const dtplRepo = new DynamoDbDocTemplateRepository({ tableName: dtplTable });
    await ensureDocTemplateTableExists(dtplRepo.getClient(), dtplTable);
  });

  after(() => {
    clearDynamoDbClient();
  });

  runPresentationContract(
    'DynamoDB',
    async () => new DynamoDbPresentationRepository({ tableName: presTable }),
    dynProjectId,
    dynUserId,
  );
  runGenDocContract(
    'DynamoDB',
    async () => new DynamoDbGeneratedDocRepository({ tableName: gdocTable }),
    dynProjectId,
    dynUserId,
  );
  runDiagramContract(
    'DynamoDB',
    async () => new DynamoDbDiagramRepository({ tableName: diagTable }),
    dynProjectId,
    dynUserId,
  );
  runDocTemplateContract(
    'DynamoDB',
    async () => new DynamoDbDocTemplateRepository({ tableName: dtplTable }),
    dynProjectId,
    dynUserId,
  );
});
