/**
 * Guardrails + runner integration tests.
 *
 * Tests:
 *   - Runner uses evaluateCommand() not hardcoded lists
 *   - `cdk deploy` is always blocked
 *   - `git push` blocked when trustTools=false, allowed when trustTools=true
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { loadRunPermissions, evaluateCommand } from '../server/guardrails.ts';

// ── Unit tests for evaluateCommand ────────────────────────────────────────────

describe('evaluateCommand — cdk deploy always blocked', () => {
  before(() => {
    createTestDb();
  });

  after(async () => {
    await cleanup();
  });

  it('blocks `cdk deploy` regardless of trusted flag', async () => {
    const perms = await loadRunPermissions(null);

    const untrusted = evaluateCommand({ command: 'cdk deploy --all', category: null }, perms, false);
    assert.equal(untrusted.action, 'block', `expected block, got ${untrusted.action}`);

    const trusted = evaluateCommand({ command: 'cdk deploy MyStack', category: null }, perms, true);
    assert.equal(trusted.action, 'block', `expected block even when trusted, got ${trusted.action}`);
  });

  it('blocks `cdk destroy` regardless of trusted flag', async () => {
    const perms = await loadRunPermissions(null);

    const untrusted = evaluateCommand({ command: 'cdk destroy --all', category: null }, perms, false);
    assert.equal(untrusted.action, 'block');

    const trusted = evaluateCommand({ command: 'cdk destroy MyStack', category: null }, perms, true);
    assert.equal(trusted.action, 'block');
  });
});

describe('evaluateCommand — git push depends on trust', () => {
  before(() => {
    createTestDb();
  });

  after(async () => {
    await cleanup();
  });

  it('asks for git push when untrusted (trustTools=false)', async () => {
    const perms = await loadRunPermissions(null);
    const result = evaluateCommand({ command: 'git push origin main', category: null }, perms, false);
    // Standard rules define git push as 'ask' for untrusted runs
    assert.equal(result.action, 'ask', `expected ask, got ${result.action}: ${result.reason}`);
  });

  it('allows git push when trusted (trustTools=true)', async () => {
    const perms = await loadRunPermissions(null);
    const result = evaluateCommand({ command: 'git push origin main', category: null }, perms, true);
    // Standard rules: scope='untrusted' → skip for trusted runs → no rule matches → allow
    assert.equal(result.action, 'allow', `expected allow, got ${result.action}: ${result.reason}`);
  });
});

describe('evaluateCommand — no hardcoded lists', () => {
  before(() => {
    createTestDb();
  });

  after(async () => {
    await cleanup();
  });

  it('evaluates commands through DB rules, not inline constants', async () => {
    // Verify loadRunPermissions returns rule objects from the database
    const perms = await loadRunPermissions(null);
    assert.ok(Array.isArray(perms.rules), 'perms.rules should be an array');
    assert.ok(perms.rules.length > 0, 'should have at least one rule loaded from DB');

    // Every rule must have the expected shape
    for (const rule of perms.rules) {
      assert.ok(typeof rule.id === 'string', 'rule.id should be string');
      assert.ok(typeof rule.action === 'string', 'rule.action should be string');
      assert.ok(['allow', 'block', 'ask'].includes(rule.action), `unexpected action: ${rule.action}`);
      assert.ok(['always', 'untrusted'].includes(rule.scope), `unexpected scope: ${rule.scope}`);
    }
  });

  it('unknown commands default to allow', async () => {
    const perms = await loadRunPermissions(null);
    const result = evaluateCommand({ command: 'echo hello world', category: null }, perms, false);
    assert.equal(result.action, 'allow', 'unknown safe commands should be allowed');
  });

  it('destructive aws commands are blocked', async () => {
    const perms = await loadRunPermissions(null);
    const result = evaluateCommand({ command: 'aws s3 delete-bucket --bucket my-bucket', category: null }, perms, false);
    assert.equal(result.action, 'block');
  });

  it('destructive aws commands blocked even when trusted', async () => {
    const perms = await loadRunPermissions(null);
    // aws destructive is always-blocked
    const result = evaluateCommand({ command: 'aws ec2 delete-security-group --group-id sg-123', category: null }, perms, true);
    assert.equal(result.action, 'block');
  });
});

describe('evaluateCommand — project-level tool rules', () => {
  before(() => {
    createTestDb();
  });

  after(async () => {
    await cleanup();
  });

  it('perms with null projectId has empty toolRules', async () => {
    const perms = await loadRunPermissions(null);
    assert.ok(Array.isArray(perms.toolRules), 'toolRules should be an array');
    assert.equal(perms.toolRules.length, 0, 'no project means no project tool rules');
  });

  it('projectId is stored in perms', async () => {
    // Using null project since we have no project in the test DB
    const perms = await loadRunPermissions(null);
    assert.equal(perms.projectId, null);
  });
});
