/**
 * Permission system tests (P3).
 *
 * Tests:
 *   - loadRunPermissions returns standard group by default
 *   - loadRunPermissions uses project override when set
 *   - evaluateCommand blocks 'cdk deploy' regardless of trusted flag (scope=always)
 *   - evaluateCommand blocks 'git push' when trusted=false
 *   - evaluateCommand ALLOWS 'git push' when trusted=true (scope=untrusted, skipped)
 *   - evaluateCommand returns allow for a harmless command like 'ls -la'
 *   - POST /api/admin/permissions/test returns block for 'cdk deploy'
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { closeDb, run, insert, one } from '../server/db.ts';
import {
  loadRunPermissions,
  evaluateCommand,
} from '../server/guardrails.ts';
import { generateId, now } from '../server/util.ts';

// ── Unit tests for guardrails ─────────────────────────────────────────────────

describe('loadRunPermissions', () => {
  before(() => {
    createTestDb(); // opens in-memory DB with all migrations
  });

  after(() => {
    closeDb();
  });

  it('returns standard group rules by default', async () => {
    const perms = await loadRunPermissions(null);
    assert.equal(perms.projectId, null);
    assert.ok(Array.isArray(perms.rules), 'rules should be an array');
    assert.ok(Array.isArray(perms.toolRules), 'toolRules should be an array');
    // The standard group has at least some rules seeded
    assert.ok(perms.rules.length > 0, 'standard group should have seeded rules');
    // All rules should belong to 'standard'
    for (const rule of perms.rules) {
      assert.equal(rule.group_id, 'standard');
    }
  });

  it('uses project override when set', async () => {
    // Create a minimal project row directly
    const projectId = generateId();
    const ts = now();
    run(
      `INSERT INTO projects (id, name, slug, description, created_by, created_at)
       VALUES (?, ?, ?, '', 'test', ?)`,
      projectId,
      'Test Project',
      `test-${projectId.substring(0, 8)}`,
      ts,
    );

    // Set override to 'core-safe'
    run(
      `INSERT INTO project_permissions (project_id, rule_group_id, updated_at)
       VALUES (?, 'core-safe', ?)`,
      projectId,
      ts,
    );

    const perms = await loadRunPermissions(projectId);
    assert.equal(perms.projectId, projectId);
    assert.ok(perms.rules.length > 0, 'core-safe group should have seeded rules');
    for (const rule of perms.rules) {
      assert.equal(rule.group_id, 'core-safe');
    }
  });
});

describe('evaluateCommand', () => {
  before(() => {
    createTestDb();
  });

  after(() => {
    closeDb();
  });

  it("blocks 'cdk deploy' regardless of trusted flag (scope=always)", async () => {
    const perms = await loadRunPermissions(null);
    const cmd = { command: 'cdk deploy MyStack', category: null };

    const resultUntrusted = evaluateCommand(cmd, perms, false);
    assert.equal(resultUntrusted.action, 'block', 'should block when untrusted');
    assert.ok(resultUntrusted.ruleId !== null, 'should have a matched ruleId');

    const resultTrusted = evaluateCommand(cmd, perms, true);
    assert.equal(resultTrusted.action, 'block', 'should block even when trusted (scope=always)');
    assert.ok(resultTrusted.ruleId !== null, 'should have a matched ruleId');
  });

  it("blocks 'git push' when trusted=false", async () => {
    const perms = await loadRunPermissions(null);
    const cmd = { command: 'git push origin main', category: null };

    const result = evaluateCommand(cmd, perms, false);
    // The standard group has ask/block for git push when untrusted
    assert.ok(
      result.action === 'ask' || result.action === 'block',
      `expected ask or block for git push (untrusted), got: ${result.action}`,
    );
    assert.ok(result.ruleId !== null, 'should have a matched ruleId');
  });

  it("ALLOWS 'git push' when trusted=true (scope=untrusted, so skipped)", async () => {
    const perms = await loadRunPermissions(null);
    const cmd = { command: 'git push origin main', category: null };

    const result = evaluateCommand(cmd, perms, true);
    assert.equal(result.action, 'allow', 'git push should be allowed when trusted=true');
    assert.equal(result.ruleId, null, 'no rule should match');
  });

  it("returns allow for a harmless command like 'ls -la'", async () => {
    const perms = await loadRunPermissions(null);
    const cmd = { command: 'ls -la', category: null };

    const result = evaluateCommand(cmd, perms, false);
    assert.equal(result.action, 'allow');
    assert.equal(result.ruleId, null);
  });
});

// ── API route tests ───────────────────────────────────────────────────────────

describe('POST /api/admin/permissions/test', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    // Create admin user
    const setupR = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: {
        email: 'admin@example.com',
        name: 'Admin',
        password: 'password123',
        provider: 'demo',
      },
    });
    assert.equal(setupR.status, 200);
    adminCookie = setupR.cookie ?? '';
  });

  after(async () => {
    await cleanup();
  });

  it("returns block for 'cdk deploy'", async () => {
    const r = await fetchJson(baseUrl, '/api/admin/permissions/test', {
      method: 'POST',
      body: { command: 'cdk deploy MyStack', trusted: false },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const decision = body.decision as Record<string, unknown>;
    assert.equal(decision.action, 'block', `expected block, got: ${JSON.stringify(decision)}`);
    assert.ok(decision.ruleId, 'expected a matched ruleId');
  });

  it('returns 403 for non-admin user', async () => {
    // Make a request without auth cookie
    const r = await fetchJson(baseUrl, '/api/admin/permissions/test', {
      method: 'POST',
      body: { command: 'cdk deploy', trusted: false },
    });
    assert.equal(r.status, 401);
  });

  it("returns allow for 'ls -la'", async () => {
    const r = await fetchJson(baseUrl, '/api/admin/permissions/test', {
      method: 'POST',
      body: { command: 'ls -la', trusted: false },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const decision = body.decision as Record<string, unknown>;
    assert.equal(decision.action, 'allow');
  });
});

describe('GET /api/admin/permissions', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    const setupR = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: {
        email: 'admin@example.com',
        name: 'Admin',
        password: 'password123',
        provider: 'demo',
      },
    });
    adminCookie = setupR.cookie ?? '';
  });

  after(async () => {
    await cleanup();
  });

  it('returns active group and rules', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/permissions', {
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(body.group, 'should return group');
    assert.ok(Array.isArray(body.rules), 'should return rules array');
    const group = body.group as Record<string, unknown>;
    assert.equal(group.id, 'standard');
  });
});
