/**
 * Audit round-3 regression tests.
 *
 * Fix 1 — db.ts startup recovery: p10_scans in-flight states flipped to 'failed'.
 * Fix 2 — db.ts startup recovery: p10_reviews in 'running'/'pending' flipped to 'failed'.
 * Fix 3 — db.ts startup recovery: repositories in 'cloning' flipped to 'error'.
 * Fix 4 — PATCH /api/projects/:id/workflows/:wid accepts goal/trustTools/maxIterations (settings panel).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDb, closeDb, isDbOpen } from '../server/db.ts';
import type { Row } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

// ── DB recovery tests (isolated DB, no shared server) ─────────────────────────

let tmpDir: string;
let tmpDbPath: string;

// Set up a persistent file-based DB for recovery tests.
// Each test seeds rows, closes the DB (simulating a crash), reopens
// (triggering startup recovery), then asserts on the recovered state.

{
  let beforeRan = false;
  const ensureDb = () => {
    if (beforeRan) return;
    beforeRan = true;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-recov3-'));
    tmpDbPath = path.join(tmpDir, 'recov3.db');
    openDb(tmpDbPath);
    closeDb();
  };

  describe('Fix 1 — p10_scans in-flight states → failed on restart', () => {
    before(() => ensureDb());
    after(() => {
      if (isDbOpen()) closeDb();
    });

    for (const stuckStatus of ['estimating', 'queued', 'fetching', 'reviewing'] as const) {
      it(`scan in status=${stuckStatus} → failed on restart`, () => {
        if (isDbOpen()) closeDb();
        const db = openDb(tmpDbPath);

        const userId = generateId();
        db.prepare(
          'INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?,?,?,?,0,0,?)',
        ).run(userId, `scan-u-${userId}@t.com`, 'U', 'x', now());

        const projId = generateId();
        db.prepare(
          `INSERT INTO projects (id, slug, name, description, notes, created_by, created_at, archived, default_lead_agent, default_model, vault_generated)
           VALUES (?,?,?,?,?,?,?,0,'','',1)`,
        ).run(projId, `slug-${projId}`, 'P', '', '', userId, now());

        const repoId = generateId();
        db.prepare(
          `INSERT INTO repositories (id, project_id, name, url, provider, status, created_at)
           VALUES (?,?,'r','http://x','github','ready',?)`,
        ).run(repoId, projId, now());

        const scanId = generateId();
        db.prepare(
          `INSERT INTO p10_scans
             (id, project_id, repo_id, branch, pinned_sha, include_paths, exclude_paths,
              background_doc_ids, model_role, provider_id, model_id, status, fail_reason,
              budget_tokens, estimated_files, estimated_bytes, estimated_tokens,
              estimated_cost_usd, estimated_minutes, files_total, files_done, tokens_used,
              cost_usd, input_tokens, output_tokens, summary, review_id,
              created_by, created_at, started_at, completed_at, workflow_id)
           VALUES (?,?,?,NULL,NULL,'[]','[]','[]',NULL,NULL,NULL,?,' ',NULL,NULL,NULL,NULL,NULL,NULL,0,0,0,0,0,0,NULL,NULL,?,?,NULL,NULL,NULL)`,
        ).run(scanId, projId, repoId, stuckStatus, userId, now());

        closeDb(); // simulate crash

        // Restart triggers recovery
        const db2 = openDb(tmpDbPath);
        const row = db2.prepare('SELECT status FROM p10_scans WHERE id = ?').get(scanId) as Row | undefined;
        assert.equal(
          String(row?.status ?? ''),
          'failed',
          `scan in '${stuckStatus}' must be flipped to 'failed' after restart`,
        );
        closeDb();
      });
    }

    it('completed/failed scans are unaffected by recovery', () => {
      if (isDbOpen()) closeDb();
      const db = openDb(tmpDbPath);

      const userId = generateId();
      db.prepare(
        'INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?,?,?,?,0,0,?)',
      ).run(userId, `scan-term-${userId}@t.com`, 'U', 'x', now());

      const projId = generateId();
      db.prepare(
        `INSERT INTO projects (id, slug, name, description, notes, created_by, created_at, archived, default_lead_agent, default_model, vault_generated)
         VALUES (?,?,?,?,?,?,?,0,'','',1)`,
      ).run(projId, `slug-t-${projId}`, 'P', '', '', userId, now());

      const repoId = generateId();
      db.prepare(
        `INSERT INTO repositories (id, project_id, name, url, provider, status, created_at)
         VALUES (?,?,'r','http://x','github','ready',?)`,
      ).run(repoId, projId, now());

      const ids: Record<string, string> = {};
      for (const st of ['completed', 'failed'] as const) {
        const id = generateId();
        ids[st] = id;
        db.prepare(
          `INSERT INTO p10_scans
             (id, project_id, repo_id, branch, pinned_sha, include_paths, exclude_paths,
              background_doc_ids, model_role, provider_id, model_id, status, fail_reason,
              budget_tokens, estimated_files, estimated_bytes, estimated_tokens,
              estimated_cost_usd, estimated_minutes, files_total, files_done, tokens_used,
              cost_usd, input_tokens, output_tokens, summary, review_id,
              created_by, created_at, started_at, completed_at, workflow_id)
           VALUES (?,?,?,NULL,NULL,'[]','[]','[]',NULL,NULL,NULL,?,' ',NULL,NULL,NULL,NULL,NULL,NULL,0,0,0,0,0,0,NULL,NULL,?,?,NULL,NULL,NULL)`,
        ).run(id, projId, repoId, st, userId, now());
      }

      closeDb();

      const db2 = openDb(tmpDbPath);
      for (const [st, id] of Object.entries(ids)) {
        const row = db2.prepare('SELECT status FROM p10_scans WHERE id = ?').get(id) as Row | undefined;
        assert.equal(
          String(row?.status ?? ''),
          st,
          `terminal status '${st}' must remain unchanged after restart`,
        );
      }
      closeDb();
    });
  });

  describe('Fix 2 — p10_reviews in running/pending → failed on restart', () => {
    before(() => ensureDb());
    after(() => {
      if (isDbOpen()) closeDb();
    });

    for (const stuckStatus of ['running', 'pending'] as const) {
      it(`review in status=${stuckStatus} → failed on restart`, () => {
        if (isDbOpen()) closeDb();
        const db = openDb(tmpDbPath);

        const userId = generateId();
        db.prepare(
          'INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?,?,?,?,0,0,?)',
        ).run(userId, `rev-u-${userId}@t.com`, 'U', 'x', now());

        const projId = generateId();
        db.prepare(
          `INSERT INTO projects (id, slug, name, description, notes, created_by, created_at, archived, default_lead_agent, default_model, vault_generated)
           VALUES (?,?,?,?,?,?,?,0,'','',1)`,
        ).run(projId, `rslug-${projId}`, 'P', '', '', userId, now());

        const reviewId = generateId();
        db.prepare(
          `INSERT INTO p10_reviews
             (id, project_id, base_ref, head_ref, pr_number, repo_id, status, post_mode,
              from_loop, workflow_id, min_severity, summary, created_by, created_at)
           VALUES (?,?,'main','feat/x',NULL,NULL,?,'draft',NULL,NULL,'medium',NULL,?,?)`,
        ).run(reviewId, projId, stuckStatus, userId, now());

        closeDb();

        const db2 = openDb(tmpDbPath);
        const row = db2.prepare('SELECT status FROM p10_reviews WHERE id = ?').get(reviewId) as Row | undefined;
        assert.equal(
          String(row?.status ?? ''),
          'failed',
          `review in '${stuckStatus}' must be flipped to 'failed' after restart`,
        );
        closeDb();
      });
    }
  });

  describe('Fix 3 — repositories in cloning → error on restart', () => {
    before(() => ensureDb());
    after(() => {
      if (isDbOpen()) closeDb();
    });

    it('repository in status=cloning → error on restart', () => {
      if (isDbOpen()) closeDb();
      const db = openDb(tmpDbPath);

      const userId = generateId();
      db.prepare(
        'INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?,?,?,?,0,0,?)',
      ).run(userId, `repo-u-${userId}@t.com`, 'U', 'x', now());

      const projId = generateId();
      db.prepare(
        `INSERT INTO projects (id, slug, name, description, notes, created_by, created_at, archived, default_lead_agent, default_model, vault_generated)
         VALUES (?,?,?,?,?,?,?,0,'','',1)`,
      ).run(projId, `cslug-${projId}`, 'P', '', '', userId, now());

      const repoId = generateId();
      db.prepare(
        `INSERT INTO repositories (id, project_id, name, url, provider, status, created_at)
         VALUES (?,?,'myrepo','https://github.com/x/y','github','cloning',?)`,
      ).run(repoId, projId, now());

      closeDb();

      const db2 = openDb(tmpDbPath);
      const row = db2.prepare('SELECT status, last_error FROM repositories WHERE id = ?').get(repoId) as Row | undefined;
      assert.equal(
        String(row?.status ?? ''),
        'error',
        `repository in 'cloning' must be flipped to 'error' after restart`,
      );
      assert.ok(row?.last_error, 'last_error must be populated after restart recovery');
      closeDb();
    });

    it('ready and error repos are unaffected by recovery', () => {
      if (isDbOpen()) closeDb();
      const db = openDb(tmpDbPath);

      const userId = generateId();
      db.prepare(
        'INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?,?,?,?,0,0,?)',
      ).run(userId, `repo-term-${userId}@t.com`, 'U', 'x', now());

      const projId = generateId();
      db.prepare(
        `INSERT INTO projects (id, slug, name, description, notes, created_by, created_at, archived, default_lead_agent, default_model, vault_generated)
         VALUES (?,?,?,?,?,?,?,0,'','',1)`,
      ).run(projId, `cslug2-${projId}`, 'P', '', '', userId, now());

      const ids: Record<string, string> = {};
      for (const st of ['ready', 'error'] as const) {
        const id = generateId();
        ids[st] = id;
        db.prepare(
          `INSERT INTO repositories (id, project_id, name, url, provider, status, created_at)
           VALUES (?,?,'r','http://x','github',?,?)`,
        ).run(id, projId, st, now());
      }

      closeDb();

      const db2 = openDb(tmpDbPath);
      for (const [st, id] of Object.entries(ids)) {
        const row = db2.prepare('SELECT status FROM repositories WHERE id = ?').get(id) as Row | undefined;
        assert.equal(
          String(row?.status ?? ''),
          st,
          `terminal status '${st}' must remain unchanged after restart`,
        );
      }
      closeDb();
    });
  });
}

// ── PATCH workflow settings test (needs a live server) ────────────────────────

describe('Fix 4 — PATCH /api/projects/:id/workflows/:wid accepts settings fields', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    const ar = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: {
        email: `patch-wf-admin-${Date.now()}@example.com`,
        name: 'Admin',
        password: 'password1234',
        provider: 'demo',
      },
    });
    adminCookie = ar.cookie ?? '';

    const pr = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'PATCH WF Test' },
      cookie: adminCookie,
    });
    projectId = ((pr.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
  });

  after(async () => {
    await cleanup();
  });

  async function createWorkflow(): Promise<string> {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'Initial goal', engine: 'demo' },
      cookie: adminCookie,
    });
    return ((r.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
  }

  it('PATCH with only title still works', async () => {
    const wid = await createWorkflow();
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wid}`, {
      method: 'PATCH',
      body: { title: 'New title' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.title, 'New title');
  });

  it('PATCH with goal, trustTools, maxIterations (no title) — 200', async () => {
    const wid = await createWorkflow();
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wid}`, {
      method: 'PATCH',
      body: { goal: 'Updated goal', trustTools: true, maxIterations: 5 },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.goal, 'Updated goal');
    assert.equal(wf.trust_tools, true);
    assert.equal(wf.max_iterations, 5);
  });

  it('PATCH with no fields returns 400', async () => {
    const wid = await createWorkflow();
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wid}`, {
      method: 'PATCH',
      body: {},
      cookie: adminCookie,
    });
    assert.equal(r.status, 400, `Expected 400 for empty patch, got ${r.status}`);
  });

  it('PATCH goal and title together — both updated', async () => {
    const wid = await createWorkflow();
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wid}`, {
      method: 'PATCH',
      body: { title: 'My session', goal: 'Do something interesting' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.title, 'My session');
    assert.equal(wf.goal, 'Do something interesting');
  });

  it('PATCH maxIterations is clamped (max 100)', async () => {
    const wid = await createWorkflow();
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wid}`, {
      method: 'PATCH',
      body: { maxIterations: 999 },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.ok(Number(wf.max_iterations) <= 100, 'max_iterations must be clamped to 100');
  });

  it('unauthenticated PATCH returns 401', async () => {
    const wid = await createWorkflow();
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wid}`, {
      method: 'PATCH',
      body: { title: 'X' },
    });
    assert.equal(r.status, 401);
  });
});
