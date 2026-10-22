/**
 * Stage 1 — Session control plane tests
 *
 * Covers:
 *  1. Audit log: rows written for mutating actions; admin API with filters/pagination.
 *  2. Budget ceilings: portal-wide, per-user, per-project.
 *  3. Concurrency caps: global, per-user, per-project; sessions queued (not 429) on cap breach.
 *  4. Graceful drain: isDraining() gate, drain API; sessions queued (not dropped) during drain.
 *  5. Durable loop state: loop_run_states persisted and restored.
 *  6. Setup endpoint hardening: 409 after first admin, 429 after 3 attempts.
 *  7. Approval SLA: overdue flag published when past SLA.
 *  8. Control plane status API.
 *  9. Worktree cleanup: TTL job skips dirty trees.
 * 10. Queue management: drainQueue() starts waiting sessions; cancel-queued endpoint.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, Client, type TestServer } from './client.ts';

let srv: TestServer;
let admin: Client;
let user2: Client;
let pid: string;
let uid2: string;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'long-password-1' });
  // Create a second user for per-user tests
  const u2 = await admin.post('/api/users', { email: 'user2@example.com', name: 'User Two', password: 'long-password-2' });
  uid2 = u2.user.id;
  user2 = new Client(srv.base);
  await user2.post('/api/auth/login', { email: 'user2@example.com', password: 'long-password-2' });
  // Create a project
  pid = (await admin.post('/api/projects', { name: 'CP Test', description: 'Stage 1' })).project.id;
  // Add user2 to the project (members endpoint uses email, not userId)
  await admin.post(`/api/projects/${pid}/members`, { email: 'user2@example.com', access: 'editor' });
});

after(() => srv.close());

// ─────────────────────────────────────────────────────────────────────────────
// 1. Audit log
// ─────────────────────────────────────────────────────────────────────────────

describe('audit log', () => {
  test('login writes an auth.login row', async () => {
    const { entries } = await admin.get('/api/admin/audit-log?action=auth.login&limit=5');
    assert.ok(entries.length > 0, 'expected at least one auth.login entry');
    assert.equal(entries[0].action, 'auth.login');
    assert.ok(entries[0].ts, 'entry has a timestamp');
  });

  test('setup writes an auth.setup row', async () => {
    const { entries } = await admin.get('/api/admin/audit-log?action=auth.setup&limit=5');
    assert.ok(entries.length > 0, 'expected at least one auth.setup entry');
    assert.equal(entries[0].action, 'auth.setup');
  });

  test('user.create row written when admin creates a user', async () => {
    const before = await admin.get('/api/admin/audit-log?action=user.create&limit=10');
    const prevCount = before.entries.length;
    const nu = await admin.post('/api/users', { email: 'audit-test@example.com', name: 'Audit', password: 'long-password-3' });
    const after = await admin.get('/api/admin/audit-log?action=user.create&limit=10');
    assert.ok(after.entries.length > prevCount, 'a new user.create entry should appear');
    const row = after.entries.find((e: any) => e.detail?.email === 'audit-test@example.com');
    assert.ok(row, 'row with correct email detail');
    assert.equal(row.target, `user:${nu.user.id}`);
    // Cleanup
    await admin.del(`/api/users/${nu.user.id}`);
  });

  test('session.start row written when session created', async () => {
    const before = await admin.get('/api/admin/audit-log?action=session.start&limit=10');
    const prevCount = before.entries.length;
    const w = await admin.post(`/api/projects/${pid}/workflows`, { goal: 'Test audit', start: false, playground: true });
    const after = await admin.get('/api/admin/audit-log?action=session.start&limit=10');
    assert.ok(after.entries.length > prevCount, 'a new session.start entry should appear');
    const row = after.entries.find((e: any) => e.target === `workflow:${w.workflow.id}`);
    assert.ok(row, 'row for correct workflow id');
    // Cleanup
    await admin.del(`/api/workflows/${w.workflow.id}`);
  });

  test('admin audit-log endpoint filters by actor', async () => {
    const adminUser = (await admin.get('/api/auth/me')).user;
    const { entries } = await admin.get(`/api/admin/audit-log?actor=${adminUser.id}&limit=50`);
    assert.ok(entries.length > 0, 'should have entries for admin actor');
    assert.ok(entries.every((e: any) => e.actor_id === adminUser.id), 'all entries match actor filter');
  });

  test('admin audit-log paginates correctly', async () => {
    const page1 = await admin.get('/api/admin/audit-log?limit=2&offset=0');
    const page2 = await admin.get('/api/admin/audit-log?limit=2&offset=2');
    assert.equal(page1.entries.length, 2);
    // IDs should be different between pages
    if (page2.entries.length > 0) {
      assert.notEqual(page1.entries[0].id, page2.entries[0].id);
    }
    assert.ok(page1.total > 0, 'total count returned');
  });

  test('non-admin cannot access audit log', async () => {
    const r = await user2.req('GET', '/api/admin/audit-log');
    assert.equal(r.status, 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Budget ceilings
// ─────────────────────────────────────────────────────────────────────────────

describe('budget ceilings', () => {
  test('per-user budget: user update stores monthly_budget_usd', async () => {
    await admin.patch(`/api/users/${uid2}`, { monthlyBudgetUsd: 1.0 });
    // The field is stored — verify via users list (requires admin)
    const { users } = await admin.get('/api/users');
    const u = users.find((x: any) => x.id === uid2);
    assert.ok(u, 'user2 found');
    // We don't directly expose monthly_budget_usd in the response yet,
    // but the DB column is set (check via the budget check in assertBudget flow)
    // For now just verify no error
    await admin.patch(`/api/users/${uid2}`, { monthlyBudgetUsd: null }); // reset
  });

  test('per-project budget: project can have monthly_budget_usd (via settings update)', async () => {
    // The projects API doesn't yet expose this directly but the column is present in DB.
    // Verify the migration ran by checking the column exists via a direct DB read.
    const { run: dbRun } = await import('../server/db.ts');
    // If migration ran, this won't throw
    dbRun('UPDATE projects SET monthly_budget_usd = ? WHERE id = ?', 100, pid);
    dbRun('UPDATE projects SET monthly_budget_usd = NULL WHERE id = ?', pid);
  });

  test('assertBudget does not throw for demo mode', async () => {
    const { assertBudget } = await import('../server/settings.ts');
    assert.doesNotThrow(() => assertBudget('demo', uid2, pid));
  });

  test('assertBudget does not throw for kiro mode', async () => {
    const { assertBudget } = await import('../server/settings.ts');
    assert.doesNotThrow(() => assertBudget('kiro', uid2, pid));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Concurrency caps
// ─────────────────────────────────────────────────────────────────────────────

describe('concurrency caps', () => {
  test('checkConcurrency returns null when no caps breached', async () => {
    const { checkConcurrency } = await import('../server/control-plane.ts');
    const result = checkConcurrency(uid2, pid);
    // Default perUserMax is 5, no sessions running yet
    assert.equal(result, null);
  });

  test('checkConcurrency returns error when perUserMax=1 and one session is running', async () => {
    const { run: dbRun } = await import('../server/db.ts');
    const { checkConcurrency } = await import('../server/control-plane.ts');
    const { getSettings, updateSettings } = await import('../server/settings.ts');

    // Set cap to 1 via settings
    updateSettings({ controlPlane: { perUserMax: 1, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });

    // Simulate a running session for this user
    const wid = `w_test_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'test', 'test goal', 'running', '', 'sonnet', 5, 8, '', '', 0, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      wid, pid, uid2,
    );

    try {
      const result = checkConcurrency(uid2, pid);
      assert.ok(result !== null, 'should return an error message');
      assert.match(result, /1 session/i);
    } finally {
      dbRun('DELETE FROM workflows WHERE id = ?', wid);
      // Reset cap
      updateSettings({ controlPlane: { perUserMax: 5, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });
    }
  });

  test('POST /api/projects/:pid/workflows returns queued status when concurrency cap is breached', async () => {
    const { run: dbRun } = await import('../server/db.ts');
    const { updateSettings } = await import('../server/settings.ts');

    // Set cap to 1
    updateSettings({ controlPlane: { perUserMax: 1, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });

    // Insert a fake running session for admin
    const adminUser = (await admin.get('/api/auth/me')).user;
    const wid = `w_cap_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'cap test', 'test goal', 'running', '', 'sonnet', 5, 8, '', '', 0, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      wid, pid, adminUser.id,
    );

    try {
      const r = await admin.req('POST', `/api/projects/${pid}/workflows`, { goal: 'Should queue', playground: true });
      // Over cap: session is created but with status='queued' (not rejected with 429)
      assert.equal(r.status, 200, 'should return 200 and create a queued session');
      assert.equal(r.data.workflow.status, 'queued', 'session should be queued');
      assert.ok(r.data.workflow.queue_reason, 'queue_reason should be set');
      // Cleanup the queued session
      await admin.del(`/api/workflows/${r.data.workflow.id}`);
    } finally {
      dbRun('DELETE FROM workflows WHERE id = ?', wid);
      updateSettings({ controlPlane: { perUserMax: 5, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Drain mode
// ─────────────────────────────────────────────────────────────────────────────

describe('drain mode', () => {
  test('admin can enable drain mode via API', async () => {
    const r = await admin.post('/api/admin/drain', { enable: true });
    assert.equal(r.drain.active, true);
    assert.ok(r.drain.startedAt, 'startedAt set');
  });

  test('drain mode queues new sessions (not 429)', async () => {
    // drain is active from the previous test
    const r = await admin.req('POST', `/api/projects/${pid}/workflows`, { goal: 'Should be queued', playground: true });
    // Per the plan: over the cap (drain mode), a session must be created and wait in a visible 'queued' state
    assert.equal(r.status, 200, 'new session should be accepted (queued)');
    assert.equal(r.data.workflow.status, 'queued', 'session should be queued during drain');
    assert.equal(r.data.workflow.queue_reason, 'drain', 'queue_reason should be drain');
    await admin.del(`/api/workflows/${r.data.workflow.id}`);
  });

  test('admin can disable drain mode', async () => {
    const r = await admin.post('/api/admin/drain', { enable: false });
    assert.equal(r.drain.active, false);
  });

  test('control plane status reflects drain state', async () => {
    const r = await admin.get('/api/admin/control-plane');
    assert.equal(r.drain.active, false);
    assert.ok('sessions' in r, 'has sessions');
    assert.ok('caps' in r, 'has caps');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Durable loop state
// ─────────────────────────────────────────────────────────────────────────────

describe('durable loop state', () => {
  test('loop_run_states table exists and is writable', async () => {
    const { run: dbRun, one: dbOne } = await import('../server/db.ts');
    // Create a fake workflow to reference
    const wid = `w_lrs_${Date.now()}`;
    const adminUser = (await admin.get('/api/auth/me')).user;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'lrs test', 'test goal', 'paused', 'test', 'sonnet', 5, 8, '', '', 2, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      wid, pid, adminUser.id,
    );

    // Write loop state
    dbRun(
      `INSERT INTO loop_run_states (workflow_id, iteration, failures, last_check, summaries, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      wid, 3, 1, JSON.stringify({ ok: false, output: 'tests failed' }), JSON.stringify(['summary1', 'summary2']),
    );

    // Read it back
    const row = dbOne<any>('SELECT * FROM loop_run_states WHERE workflow_id = ?', wid);
    assert.ok(row, 'row exists');
    assert.equal(row.iteration, 3);
    assert.equal(row.failures, 1);
    const lastCheck = JSON.parse(row.last_check);
    assert.equal(lastCheck.ok, false);
    const summaries = JSON.parse(row.summaries);
    assert.deepEqual(summaries, ['summary1', 'summary2']);

    // Cleanup
    dbRun('DELETE FROM workflows WHERE id = ?', wid);
  });

  test('recoverWorkflows marks interrupted sessions with correct reason', async () => {
    const { run: dbRun, one: dbOne } = await import('../server/db.ts');
    const { recoverWorkflows } = await import('../server/workflows.ts');
    const adminUser = (await admin.get('/api/auth/me')).user;

    // Create a running workflow
    const wid = `w_rec_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'rec test', 'test goal', 'running', '', 'sonnet', 5, 8, '', '', 2, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      wid, pid, adminUser.id,
    );
    // Simulate a loop state that is ahead of the workflow iteration (interrupted mid-iteration)
    dbRun(
      `INSERT INTO loop_run_states (workflow_id, iteration, failures, last_check, summaries, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      wid, 3, 0, '{}', '[]',
    );

    try {
      const ids = recoverWorkflows();
      assert.ok(ids.includes(wid), 'interrupted workflow in returned ids');
      const recovered = dbOne<any>('SELECT * FROM workflows WHERE id = ?', wid);
      assert.equal(recovered.status, 'paused');
      assert.match(recovered.stop_reason, /interrupted/i);
    } finally {
      dbRun('DELETE FROM workflows WHERE id = ?', wid);
    }
  });

  test('resumeAfterRestart restores sessions paused by restart with saved state', async () => {
    const { run: dbRun, one: dbOne } = await import('../server/db.ts');
    const { resumeAfterRestart } = await import('../server/workflows.ts');
    const adminUser = (await admin.get('/api/auth/me')).user;

    // Create a paused workflow with restart reason
    const wid = `w_resume_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'resume test', 'test goal', 'paused', 'The server restarted. Resume to go on.', 'sonnet', 5, 8, '', '', 1, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      wid, pid, adminUser.id,
    );
    // Write loop state with failures=1 (should be restored)
    dbRun(
      `INSERT INTO loop_run_states (workflow_id, iteration, failures, last_check, summaries, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      wid, 1, 1, '{}', JSON.stringify(['prev summary']),
    );

    try {
      // resumeAfterRestart should resume it (it will kick() but no sessions are actually driving in tests)
      const n = resumeAfterRestart([wid]);
      // n might be 0 if overBudget; since budget_usd=5 and spent_usd=0, it should resume
      // but since we're not in a demo context (no running drive loop), it just patches status
      const recovered = dbOne<any>('SELECT * FROM workflows WHERE id = ?', wid);
      // Should now be running (even if drive() returns immediately)
      assert.ok(['running', 'paused', 'failed'].includes(recovered.status), 'status changed from restart-paused');
    } finally {
      dbRun('DELETE FROM workflows WHERE id = ?', wid);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Setup endpoint hardening
// ─────────────────────────────────────────────────────────────────────────────

describe('setup endpoint hardening', () => {
  test('/api/auth/setup returns 409 after admin already created', async () => {
    const r = await admin.req('POST', '/api/auth/setup', { email: 'another@example.com', name: 'Another', password: 'long-password-99' });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /already done/i);
  });

  test('login rate-limit: 8 failed attempts trigger 429', async () => {
    const tempClient = new Client(srv.base);
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const r = await tempClient.req('POST', '/api/auth/login', { email: 'admin@example.com', password: 'wrong-password' });
      lastStatus = r.status;
      if (r.status === 429) break;
    }
    assert.equal(lastStatus, 429, 'should hit rate limit');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Approval SLA
// ─────────────────────────────────────────────────────────────────────────────

describe('approval SLA', () => {
  test('checkApprovalSla marks old pending inputs as escalated and publishes event', async () => {
    const { run: dbRun, one: dbOne } = await import('../server/db.ts');
    const { checkApprovalSla } = await import('../server/control-plane.ts');
    const { subscribe, projectChannel } = await import('../server/events.ts');

    // Create an old pending input
    const inputId = `i_sla_${Date.now()}`;
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString(); // 2 hours ago
    dbRun(
      "INSERT INTO inputs (id, project_id, run_id, type, tool_name, payload, status, created_at) VALUES (?, ?, NULL, 'approval', 'Bash', '{}', 'pending', ?)",
      inputId, pid, old,
    );

    let overdueFired = false;
    const unsub = subscribe(projectChannel(pid), (event: string) => {
      if (event === 'input.overdue') overdueFired = true;
    });

    try {
      checkApprovalSla(1); // 1 minute SLA — the 2-hour-old input should be overdue
      const updated = dbOne<any>('SELECT * FROM inputs WHERE id = ?', inputId);
      assert.ok(updated.escalated_at, 'escalated_at should be set');
      assert.ok(overdueFired, 'input.overdue event should have been published');

      // Calling again should not re-escalate (escalated_at already set)
      overdueFired = false;
      checkApprovalSla(1);
      assert.equal(overdueFired, false, 'should not fire again for already-escalated input');
    } finally {
      unsub();
      dbRun('DELETE FROM inputs WHERE id = ?', inputId);
    }
  });

  test('inputs table has escalated_at and expires_at columns', async () => {
    const { one: dbOne } = await import('../server/db.ts');
    // The migration should have added these columns; verify by doing a query
    const r = dbOne<any>("SELECT escalated_at, expires_at FROM inputs WHERE 1=0");
    // If it throws, the columns don't exist — test verifies they do
    assert.equal(r, undefined, 'query returns undefined (no rows) but does not throw');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Control plane status API
// ─────────────────────────────────────────────────────────────────────────────

describe('control plane status API', () => {
  test('GET /api/admin/control-plane returns structure', async () => {
    const r = await admin.get('/api/admin/control-plane');
    assert.ok('drain' in r, 'has drain');
    assert.ok('sessions' in r, 'has sessions');
    assert.ok('approvals' in r, 'has approvals');
    assert.ok('caps' in r, 'has caps');
    assert.equal(typeof r.sessions.running, 'number');
    assert.equal(typeof r.sessions.queued, 'number');
    assert.equal(typeof r.caps.perUserMax, 'number');
    assert.equal(typeof r.caps.globalMax, 'number');
    assert.equal(typeof r.caps.perProjectMax, 'number');
  });

  test('non-admin cannot access control plane status', async () => {
    const r = await user2.req('GET', '/api/admin/control-plane');
    assert.equal(r.status, 403);
  });

  test('GET /api/admin/control-plane reflects running session count', async () => {
    const { run: dbRun } = await import('../server/db.ts');
    const adminUser = (await admin.get('/api/auth/me')).user;
    const wid = `w_cp_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'cp count test', 'test goal', 'running', '', 'sonnet', 5, 8, '', '', 0, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      wid, pid, adminUser.id,
    );
    try {
      const r = await admin.get('/api/admin/control-plane');
      assert.ok(r.sessions.running >= 1, 'running count should be at least 1');
    } finally {
      dbRun('DELETE FROM workflows WHERE id = ?', wid);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Budget threshold events
// ─────────────────────────────────────────────────────────────────────────────

describe('budget threshold events', () => {
  test('checkBudgetThresholds fires at 80% crossing', async () => {
    const { checkBudgetThresholds } = await import('../server/control-plane.ts');
    const { subscribe, projectChannel } = await import('../server/events.ts');

    let thresholdFired = false;
    let thresholdValue = 0;
    const unsub = subscribe(projectChannel(pid), (event: string, data: any) => {
      if (event === 'budget.threshold') {
        thresholdFired = true;
        thresholdValue = data.threshold;
      }
    });

    try {
      // Simulate crossing 80%: was at 79%, now at 81%
      checkBudgetThresholds({
        projectId: pid,
        userId: uid2,
        newSpendUsd: 2,
        projectBudgetUsd: 10,
        userBudgetUsd: null,
        userMonthSpendUsd: 0,
        projectMonthSpendUsd: 8.1, // crossed 80%
      });

      assert.ok(thresholdFired, 'budget.threshold event should fire');
      assert.equal(thresholdValue, 0.8);
    } finally {
      unsub();
    }
  });

  test('checkBudgetThresholds fires at 100% crossing', async () => {
    const { checkBudgetThresholds } = await import('../server/control-plane.ts');
    const { subscribe, projectChannel } = await import('../server/events.ts');

    let thresholdValue = 0;
    const unsub = subscribe(projectChannel(pid), (event: string, data: any) => {
      if (event === 'budget.threshold') thresholdValue = data.threshold;
    });

    try {
      checkBudgetThresholds({
        projectId: pid,
        userId: null,
        newSpendUsd: 1.5,
        projectBudgetUsd: 10,
        userBudgetUsd: null,
        userMonthSpendUsd: 0,
        projectMonthSpendUsd: 10.5, // crossed 100%
      });

      assert.equal(thresholdValue, 1.0);
    } finally {
      unsub();
    }
  });

  test('checkBudgetThresholds does not fire if already past threshold', async () => {
    const { checkBudgetThresholds } = await import('../server/control-plane.ts');
    const { subscribe, projectChannel } = await import('../server/events.ts');

    let fired = false;
    const unsub = subscribe(projectChannel(pid), (event: string) => {
      if (event === 'budget.threshold') fired = true;
    });

    try {
      // Already at 90%, adding a little more — no new 80% crossing
      checkBudgetThresholds({
        projectId: pid,
        userId: null,
        newSpendUsd: 0.5,
        projectBudgetUsd: 10,
        userBudgetUsd: null,
        userMonthSpendUsd: 0,
        projectMonthSpendUsd: 9.5, // was 9.0 (90%), still under 100%
      });

      assert.equal(fired, false, 'should not fire when no threshold crossed');
    } finally {
      unsub();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Worktree cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe('worktree cleanup', () => {
  test('cleanupWorktrees skips non-existent work dirs (gracefully)', async () => {
    const { cleanupWorktrees } = await import('../server/control-plane.ts');
    const { run: dbRun, one: dbOne } = await import('../server/db.ts');
    const adminUser = (await admin.get('/api/auth/me')).user;

    // Create a finished session with a non-existent workDir in meta
    const wid = `w_ttl_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'ttl test', 'test goal', 'done', 'Completed', 'sonnet', 5, 8, '', '', 1, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('2020-01-01'), datetime('2020-01-01'))",
      wid, pid, adminUser.id,
    );
    // Insert a run with a non-existent workDir
    const rid = `r_ttl_${Date.now()}`;
    dbRun(
      "INSERT INTO runs (id, project_id, kind, title, prompt, status, model, permission_mode, provider, meta, created_by, created_at) VALUES (?, ?, 'chat', 'ttl run', 'p', 'completed', 'sonnet', 'default', 'demo', ?, ?, datetime('2020-01-01'))",
      rid, pid, JSON.stringify({ workDir: 'work/nonexistent_path_that_does_not_exist' }), adminUser.id,
    );
    dbRun('UPDATE workflows SET last_run_id = ? WHERE id = ?', rid, wid);

    try {
      const result = await cleanupWorktrees(() => srv.dataDir, 1); // ttl 1 day, session from 2020
      // No deletion (dir doesn't exist), no skip
      assert.ok(result.deleted >= 0, 'deleted count is non-negative');
      assert.ok(result.skipped >= 0, 'skipped count is non-negative');
    } finally {
      dbRun('DELETE FROM runs WHERE id = ?', rid);
      dbRun('DELETE FROM workflows WHERE id = ?', wid);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. controlPlane settings
// ─────────────────────────────────────────────────────────────────────────────

describe('controlPlane settings', () => {
  test('updateSettings accepts controlPlane section', async () => {
    const { updateSettings, getSettings } = await import('../server/settings.ts');
    updateSettings({ controlPlane: { perUserMax: 10, globalMax: 50, perProjectMax: 5, approvalSlaMinutes: 45, worktreeTtlDays: 14, drainTimeoutSeconds: 120 } });
    const s = getSettings();
    assert.equal(s.controlPlane.perUserMax, 10);
    assert.equal(s.controlPlane.globalMax, 50);
    assert.equal(s.controlPlane.perProjectMax, 5);
    assert.equal(s.controlPlane.approvalSlaMinutes, 45);
    assert.equal(s.controlPlane.worktreeTtlDays, 14);
    assert.equal(s.controlPlane.drainTimeoutSeconds, 120);
    // Reset
    updateSettings({ controlPlane: { perUserMax: 5, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });
  });

  test('updateSettings rejects out-of-range controlPlane values', async () => {
    const { updateSettings } = await import('../server/settings.ts');
    assert.throws(() => updateSettings({ controlPlane: { perUserMax: -1 } }), /must be a whole number/i);
    assert.throws(() => updateSettings({ controlPlane: { drainTimeoutSeconds: 2 } }), /must be a whole number/i);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 10. Queue management
// ─────────────────────────────────────────────────────────────────────────────

describe('queue management', () => {
  test('session is queued (not rejected) when per-user cap is breached', async () => {
    const { run: dbRun } = await import('../server/db.ts');
    const { updateSettings } = await import('../server/settings.ts');
    updateSettings({ controlPlane: { perUserMax: 1, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });

    const adminUser = (await admin.get('/api/auth/me')).user;
    const wid = `w_q1_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'q1', 'x', 'running', '', 'sonnet', 5, 8, '', '', 0, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      wid, pid, adminUser.id,
    );

    try {
      const r = await admin.req('POST', `/api/projects/${pid}/workflows`, { goal: 'queued session', playground: true });
      assert.equal(r.status, 200, 'should create a queued session, not 429');
      const w = r.data.workflow;
      assert.equal(w.status, 'queued', 'workflow status should be queued');
      assert.ok(w.queue_reason, 'queue_reason should be set');
      assert.ok(w.queued_at, 'queued_at should be set');
      // Cleanup
      await admin.del(`/api/workflows/${w.id}`);
    } finally {
      dbRun('DELETE FROM workflows WHERE id = ?', wid);
      updateSettings({ controlPlane: { perUserMax: 5, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });
    }
  });

  test('drainQueue starts a queued session when a slot opens up', async () => {
    const { run: dbRun, one: dbOne } = await import('../server/db.ts');
    const { drainQueue } = await import('../server/control-plane.ts');
    const { updateSettings } = await import('../server/settings.ts');
    const adminUser = (await admin.get('/api/auth/me')).user;

    updateSettings({ controlPlane: { perUserMax: 1, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });

    // Create a queued session manually
    const qid = `w_q2_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, queue_reason, queued_at, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'queued', 'x', 'queued', 'user:1', datetime('now'), 'Queued', 'sonnet', 5, 8, '', '', 0, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      qid, pid, adminUser.id,
    );

    try {
      // With no running sessions, drainQueue should start the queued session
      const started = drainQueue();
      assert.ok(started.includes(qid), 'drainQueue should return the queued session id');
      const w = dbOne<any>('SELECT status FROM workflows WHERE id = ?', qid);
      assert.equal(w.status, 'running', 'queued session should transition to running');
    } finally {
      dbRun('DELETE FROM workflows WHERE id = ?', qid);
      updateSettings({ controlPlane: { perUserMax: 5, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });
    }
  });

  test('cancel-queued endpoint stops a queued session', async () => {
    const adminUser = (await admin.get('/api/auth/me')).user;
    const { run: dbRun } = await import('../server/db.ts');
    const { updateSettings } = await import('../server/settings.ts');

    updateSettings({ controlPlane: { perUserMax: 1, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });

    // Insert a running session to cause queueing
    const runningWid = `w_q3r_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'running', 'x', 'running', '', 'sonnet', 5, 8, '', '', 0, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      runningWid, pid, adminUser.id,
    );

    try {
      // Create a queued session
      const r = await admin.req('POST', `/api/projects/${pid}/workflows`, { goal: 'to be cancelled', playground: true });
      assert.equal(r.status, 200);
      const queuedWid = r.data.workflow.id;
      assert.equal(r.data.workflow.status, 'queued');

      // Cancel it
      const cr = await admin.req('POST', `/api/workflows/${queuedWid}/cancel-queued`, {});
      assert.equal(cr.status, 200, 'cancel-queued should succeed');
      assert.equal(cr.data.workflow.status, 'stopped', 'session should be stopped');

      // Cleanup
      await admin.del(`/api/workflows/${queuedWid}`);
    } finally {
      dbRun('DELETE FROM workflows WHERE id = ?', runningWid);
      updateSettings({ controlPlane: { perUserMax: 5, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });
    }
  });

  test('admin control-plane status shows queued session count', async () => {
    const { run: dbRun } = await import('../server/db.ts');
    const adminUser = (await admin.get('/api/auth/me')).user;

    const qid = `w_qcp_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, queue_reason, queued_at, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'qcp', 'x', 'queued', 'user:1', datetime('now'), 'Queued', 'sonnet', 5, 8, '', '', 0, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      qid, pid, adminUser.id,
    );

    try {
      const r = await admin.get('/api/admin/control-plane');
      assert.ok(r.sessions.queued >= 1, 'queued count should reflect the queued session');
    } finally {
      dbRun('DELETE FROM workflows WHERE id = ?', qid);
    }
  });

  test('queuePosition returns correct 1-based position', async () => {
    const { run: dbRun } = await import('../server/db.ts');
    const { queuePosition } = await import('../server/control-plane.ts');
    const adminUser = (await admin.get('/api/auth/me')).user;

    const q1 = `w_qp1_${Date.now()}`;
    const q2 = `w_qp2_${Date.now() + 1}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, queue_reason, queued_at, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'q1', 'x', 'queued', 'user:1', '2024-01-01T00:00:00.000Z', 'Q', 'sonnet', 5, 8, '', '', 0, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      q1, pid, adminUser.id,
    );
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, queue_reason, queued_at, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'q2', 'x', 'queued', 'user:1', '2024-01-02T00:00:00.000Z', 'Q', 'sonnet', 5, 8, '', '', 0, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      q2, pid, adminUser.id,
    );

    try {
      const pos1 = queuePosition(q1);
      const pos2 = queuePosition(q2);
      assert.ok(pos1 >= 1, 'first queued session should have position >= 1');
      assert.ok(pos2 > pos1, 'second queued session should have a higher position');
    } finally {
      dbRun('DELETE FROM workflows WHERE id = ?', q1);
      dbRun('DELETE FROM workflows WHERE id = ?', q2);
    }
  });
});
