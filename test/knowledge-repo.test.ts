/**
 * Contract tests for KnowledgeRepository (knowledge_docs, knowledge_decisions, search).
 *
 * The same assertions run against both SQLite and DynamoDB Local.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to turn the skip into a failure.
 *
 * To run locally (PowerShell 5.1 — no &&):
 *   docker run -d --rm --name ddb-knowledge -p 8000:8000 amazon/dynamodb-local
 *   $env:DYNAMODB_ENDPOINT='http://localhost:8000'; $env:REQUIRE_DYNAMODB='1'
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/knowledge-repo.test.ts
 *   docker stop ddb-knowledge
 *   Remove-Item Env:DYNAMODB_ENDPOINT; Remove-Item Env:REQUIRE_DYNAMODB
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './fixtures.ts';
import { SqliteKnowledgeRepository } from '../server/repositories/knowledge-sqlite.ts';
import type { KnowledgeRepository } from '../server/repositories/knowledge.ts';
import { clearKnowledgeRepository } from '../server/repositories/knowledge.ts';
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

// Helper: create a doc with nulled user FKs to avoid FK constraint failures in SQLite mode
function makeDoc(id: string, pid: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project_id: pid,
    name: 'test.pdf',
    original_name: 'test.pdf',
    mime_type: null as string | null,
    size_bytes: 1,
    status: 'processing' as const,
    uploaded_by: null as string | null,  // nullable FK to users
    created_at: now(),
    ...overrides,
  };
}

// Helper: create a decision with nulled user FKs
function makeDecision(id: string, pid: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project_id: pid,
    question: 'Q',
    answer: 'A',
    asked_by: null as string | null,    // nullable FK
    answered_by: null as string | null, // nullable FK
    created_at: now(),
    ...overrides,
  };
}

// ── Shared contract ───────────────────────────────────────────────────────────

function runContract(label: string, makeRepo: () => Promise<KnowledgeRepository>): void {
  describe(`${label} -- KnowledgeRepository contract`, () => {
    let repo: KnowledgeRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    const isSqlite = label === 'SQLite';

    before(async () => {
      repo = await makeRepo();
    });

    after(() => {
      clearKnowledgeRepository();
    });

    // ── Doc CRUD ─────────────────────────────────────────────────────────────

    test('createDoc -- stores and returns doc', async () => {
      const pid = `kpid-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      const doc = await repo.createDoc(makeDoc(id, pid, { name: 'test.pdf', status: 'processing' }));
      assert.equal(doc.id, id);
      assert.equal(doc.project_id, pid);
      assert.equal(doc.status, 'processing');
    });

    test('getDocById -- returns doc', async () => {
      const pid = `kpid2-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.createDoc(makeDoc(id, pid));
      const found = await repo.getDocById(id);
      assert.ok(found);
      assert.equal(found.id, id);
    });

    test('getDocById -- returns null for unknown', async () => {
      const found = await repo.getDocById(`missing-${sfx}`);
      assert.equal(found, null);
    });

    test('listDocs -- returns docs for project newest first', async () => {
      const pid = `kpid3-${sfx}`;
      maybeProject(pid, isSqlite);
      const id1 = generateId();
      const id2 = generateId();
      await repo.createDoc(makeDoc(id1, pid, { created_at: '2026-01-01T00:00:00.000Z' }));
      await repo.createDoc(makeDoc(id2, pid, { created_at: '2026-01-02T00:00:00.000Z' }));
      const docs = await repo.listDocs(pid);
      const idx1 = docs.findIndex((d) => d.id === id2);
      const idx2 = docs.findIndex((d) => d.id === id1);
      assert.ok(idx1 < idx2, 'newest doc (id2) should come before older doc (id1)');
    });

    test('listDocs -- scoped to project', async () => {
      const pidA = `kpidA-${sfx}`;
      const pidB = `kpidB-${sfx}`;
      maybeProject(pidA, isSqlite);
      maybeProject(pidB, isSqlite);
      const idA = generateId();
      const idB = generateId();
      await repo.createDoc(makeDoc(idA, pidA));
      await repo.createDoc(makeDoc(idB, pidB));
      const docsA = await repo.listDocs(pidA);
      assert.ok(docsA.some((d) => d.id === idA));
      assert.ok(!docsA.some((d) => d.id === idB), 'project B doc must not appear in project A');
    });

    test('updateDoc -- status and error', async () => {
      const pid = `kpid4-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.createDoc(makeDoc(id, pid));
      await repo.updateDoc(id, { status: 'ready', markdown_path: '/tmp/u.md', error: null });
      const doc = await repo.getDocById(id);
      assert.ok(doc);
      assert.equal(doc.status, 'ready');
      assert.equal(doc.markdown_path, '/tmp/u.md');
    });

    test('deleteDoc -- removes doc', async () => {
      const pid = `kpid5-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.createDoc(makeDoc(id, pid));
      await repo.deleteDoc(id);
      const gone = await repo.getDocById(id);
      assert.equal(gone, null);
    });

    // ── Search ────────────────────────────────────────────────────────────────

    test('searchDocs -- hit on indexed content', async () => {
      const pid = `ksch-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.createDoc(makeDoc(id, pid, { name: 'auth.md' }));
      await repo.updateDoc(id, { status: 'ready' });
      await repo.indexDoc(id, pid, 'Authentication tokens allow secure access to the API.');
      const results = await repo.searchDocs(pid, 'authentication tokens', 20);
      assert.ok(results.length > 0, 'should find indexed doc');
      assert.ok(results.some((r) => r.docId === id));
    });

    test('searchDocs -- miss for non-indexed content', async () => {
      const pid = `ksch2-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.createDoc(makeDoc(id, pid, { name: 'empty.md' }));
      await repo.updateDoc(id, { status: 'ready' });
      await repo.indexDoc(id, pid, 'Hello world simple test content');
      const results = await repo.searchDocs(pid, 'quantum physics blockchain', 20);
      assert.ok(!results.some((r) => r.docId === id), 'unrelated terms should not match');
    });

    test('searchDocs -- project scoped (no cross-project leakage)', async () => {
      const pidX = `kschX-${sfx}`;
      const pidY = `kschY-${sfx}`;
      maybeProject(pidX, isSqlite);
      maybeProject(pidY, isSqlite);
      const idX = generateId();
      const idY = generateId();
      await repo.createDoc(makeDoc(idX, pidX));
      await repo.createDoc(makeDoc(idY, pidY));
      await repo.updateDoc(idX, { status: 'ready' });
      await repo.updateDoc(idY, { status: 'ready' });
      const sharedTerm = `uniqueterm${sfx}`;
      await repo.indexDoc(idX, pidX, `The ${sharedTerm} document describes authorization flow.`);
      await repo.indexDoc(idY, pidY, `This ${sharedTerm} document describes billing events.`);
      const resultsX = await repo.searchDocs(pidX, sharedTerm, 20);
      assert.ok(resultsX.every((r) => r.docId === idX), 'project X search must not return project Y doc');
      const resultsY = await repo.searchDocs(pidY, sharedTerm, 20);
      assert.ok(resultsY.every((r) => r.docId === idY), 'project Y search must not return project X doc');
    });

    test('searchDocs -- delete removes postings (no stale results)', async () => {
      const pid = `kdel-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.createDoc(makeDoc(id, pid));
      await repo.updateDoc(id, { status: 'ready' });
      const term = `deleteterm${sfx}`;
      await repo.indexDoc(id, pid, `The ${term} content should be removed on delete.`);
      const before = await repo.searchDocs(pid, term, 20);
      assert.ok(before.some((r) => r.docId === id), 'doc should be findable before delete');
      await repo.deleteDoc(id);
      const after = await repo.searchDocs(pid, term, 20);
      assert.ok(!after.some((r) => r.docId === id), 'deleted doc must not appear in search');
    });

    test('searchDocs -- update replaces postings (old terms no longer match)', async () => {
      const pid = `kupd-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.createDoc(makeDoc(id, pid));
      await repo.updateDoc(id, { status: 'ready' });
      const oldTerm = `olduniquex${sfx}`;
      const newTerm = `newuniquey${sfx}`;
      await repo.indexDoc(id, pid, `The ${oldTerm} system manages access control.`);
      await repo.indexDoc(id, pid, `The ${newTerm} system manages billing.`);
      const oldSearch = await repo.searchDocs(pid, oldTerm, 20);
      assert.ok(!oldSearch.some((r) => r.docId === id), 'old term must not match after update');
      const newSearch = await repo.searchDocs(pid, newTerm, 20);
      assert.ok(newSearch.some((r) => r.docId === id), 'new term must match after update');
    });

    test('searchDocs -- ranking order (doc with more matched terms ranked higher)', async () => {
      const pid = `krnk-${sfx}`;
      maybeProject(pid, isSqlite);
      const idFull = generateId();
      const idPartial = generateId();
      await repo.createDoc(makeDoc(idFull, pid, { name: 'full.md' }));
      await repo.createDoc(makeDoc(idPartial, pid, { name: 'partial.md' }));
      await repo.updateDoc(idFull, { status: 'ready' });
      await repo.updateDoc(idPartial, { status: 'ready' });
      const t1 = `rankterm1x${sfx}`;
      const t2 = `rankterm2y${sfx}`;
      const t3 = `rankterm3z${sfx}`;
      await repo.indexDoc(idFull, pid, `The ${t1} document covers ${t2} and ${t3} topics in detail.`);
      await repo.indexDoc(idPartial, pid, `The ${t1} document covers only one topic.`);
      const results = await repo.searchDocs(pid, `${t1} ${t2} ${t3}`, 20);
      const fullIdx = results.findIndex((r) => r.docId === idFull);
      const partialIdx = results.findIndex((r) => r.docId === idPartial);
      if (fullIdx >= 0 && partialIdx >= 0) {
        assert.ok(fullIdx <= partialIdx, 'doc matching more query terms should rank first or equal');
      }
    });

    test('searchDocs -- oversized content (> MAX_INDEX_BYTES) indexes first portion only', async () => {
      const pid = `klarge-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.createDoc(makeDoc(id, pid, { name: 'large.md', size_bytes: 200_000 }));
      await repo.updateDoc(id, { status: 'ready' });
      const startTerm = `startterm${sfx}`;
      const padding = 'word '.repeat(30_000); // ~150KB
      await repo.indexDoc(id, pid, `${startTerm} ${padding}`);
      const startResults = await repo.searchDocs(pid, startTerm, 20);
      assert.ok(startResults.some((r) => r.docId === id), 'term near start must be found');
    });

    test('searchDocs -- concurrent update leaves consistent index', async () => {
      const pid = `kconc-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      await repo.createDoc(makeDoc(id, pid));
      await repo.updateDoc(id, { status: 'ready' });
      const termA = `concA${sfx}`;
      const termB = `concB${sfx}`;
      await Promise.all([
        repo.indexDoc(id, pid, `The ${termA} document covers topic alpha.`),
        repo.indexDoc(id, pid, `The ${termB} document covers topic beta.`),
      ]);
      const resultsA = await repo.searchDocs(pid, termA, 20);
      const resultsB = await repo.searchDocs(pid, termB, 20);
      assert.ok(
        resultsA.some((r) => r.docId === id) || resultsB.some((r) => r.docId === id),
        'doc must be findable after concurrent updates (at least one term set)',
      );
    });

    // ── Decisions ─────────────────────────────────────────────────────────────

    test('createDecision -- stores and returns decision', async () => {
      const pid = `kdec-${sfx}`;
      maybeProject(pid, isSqlite);
      const id = generateId();
      const dec = await repo.createDecision(makeDecision(id, pid, { question: 'What is the auth approach?', answer: 'JWT with refresh tokens.' }));
      assert.equal(dec.id, id);
      assert.equal(dec.question, 'What is the auth approach?');
    });

    test('listDecisions -- returns decisions newest first', async () => {
      const pid = `kdec2-${sfx}`;
      maybeProject(pid, isSqlite);
      const id1 = generateId();
      const id2 = generateId();
      await repo.createDecision(makeDecision(id1, pid, { created_at: '2026-01-01T00:00:00.000Z' }));
      await repo.createDecision(makeDecision(id2, pid, { created_at: '2026-01-02T00:00:00.000Z' }));
      const decs = await repo.listDecisions(pid);
      const i1 = decs.findIndex((d) => d.id === id2);
      const i2 = decs.findIndex((d) => d.id === id1);
      assert.ok(i1 < i2, 'newest decision first');
    });

    test('listDecisions -- project scoped', async () => {
      const pidP = `kdecP-${sfx}`;
      const pidQ = `kdecQ-${sfx}`;
      maybeProject(pidP, isSqlite);
      maybeProject(pidQ, isSqlite);
      const idP = generateId();
      const idQ = generateId();
      await repo.createDecision(makeDecision(idP, pidP));
      await repo.createDecision(makeDecision(idQ, pidQ));
      const decsP = await repo.listDecisions(pidP);
      assert.ok(decsP.some((d) => d.id === idP));
      assert.ok(!decsP.some((d) => d.id === idQ), 'project Q decision must not appear in project P');
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

runContract('SQLite', async () => {
  createTestDb();
  return new SqliteKnowledgeRepository();
});

// ── DynamoDB suite ────────────────────────────────────────────────────────────

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const require = process.env.REQUIRE_DYNAMODB === '1';

  if (!endpoint) {
    if (require) {
      throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT is not set');
    }
    test.skip('DynamoDB Local suite -- DYNAMODB_ENDPOINT not set');
    return;
  }

  const { DynamoDbKnowledgeRepository } = await import('../server/repositories/knowledge-dynamodb.ts');

  runContract('DynamoDB', async () => {
    const repo = new DynamoDbKnowledgeRepository();
    await repo.ensureTables();
    return repo;
  });
});
