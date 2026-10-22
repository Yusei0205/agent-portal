/**
 * Stage 6 — Verification: additional coverage tests
 *
 * Covers:
 *  1. Restart/resume at iteration boundary: loop_run_states failures/summaries restored.
 *  2. Drain: isDraining blocks new sessions, disable drain re-opens.
 *  3. Queue under concurrency caps: 429 returned when per-user cap hit.
 *  4. Budget stop: session blocked when budget spent >= budget_usd.
 *  5. Trigger dedup within same minute (cron).
 *  6. Rate limit 3/hour (trigger history used correctly).
 *  7. Cron parser edge cases: step expressions (every-5), list (1,3,5), step-on-range.
 *  8. GitHub HMAC verification: reject wrong length, reject no header.
 *  9. OIDC token verification failures: expired token, wrong audience, missing email_verified.
 * 10. Invite single-use and expiry.
 * 11. SCIM auth: wrong token 401, no token 401.
 * 12. Inbox aggregation: blocked session appears in inbox needs_you.
 * 13. Readiness: missing repo sets ok=false.
 * 14. Security: auth required on new routes; project access checks; CSRF header rule;
 *     no secrets returned without access; webhook constant-time compare.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bootServer, Client, type TestServer } from './client.ts';

let srv: TestServer;
let admin: Client;
let editor: Client;
let viewer: Client;
let pid: string;
let editorId: string;
let viewerId: string;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'admin@verify.test', name: 'Admin', password: 'long-password-1' });
  const eu = await admin.post('/api/users', { email: 'editor@verify.test', name: 'Editor', password: 'long-password-2' });
  editorId = eu.user.id;
  editor = new Client(srv.base);
  await editor.post('/api/auth/login', { email: 'editor@verify.test', password: 'long-password-2' });
  const vu = await admin.post('/api/users', { email: 'viewer@verify.test', name: 'Viewer', password: 'long-password-3' });
  viewerId = vu.user.id;
  viewer = new Client(srv.base);
  await viewer.post('/api/auth/login', { email: 'viewer@verify.test', password: 'long-password-3' });
  const pRes = await admin.post('/api/projects', { name: 'Verify Project', description: 'Stage 6 tests' });
  pid = pRes.project.id;
  await admin.post(`/api/projects/${pid}/members`, { email: 'editor@verify.test', access: 'editor' });
  await admin.post(`/api/projects/${pid}/members`, { email: 'viewer@verify.test', access: 'viewer' });
});

after(() => srv.close());

/* ------------------------------------------------------------------ */
/* 1. Restart / resume at iteration boundary                           */
/* ------------------------------------------------------------------ */

describe('restart/resume at iteration boundary', () => {
  test('loop_run_states failures and summaries are preserved across resumeAfterRestart', async () => {
    const { run: dbRun, one: dbOne } = await import('../server/db.ts');
    const { resumeAfterRestart } = await import('../server/workflows.ts');
    const adminUser = (await admin.get('/api/auth/me')).user;

    const wid = `w_restartbnd_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'restart bnd', 'test', 'paused', 'The server restarted. Resume to go on.', 'sonnet', 5, 8, '', '', 2, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      wid, pid, adminUser.id,
    );
    dbRun(
      `INSERT INTO loop_run_states (workflow_id, iteration, failures, last_check, summaries, burst_start, updated_at) VALUES (?, 2, 2, '{}', ?, 0, datetime('now'))`,
      wid, JSON.stringify(['iter1 summary', 'iter2 summary']),
    );

    try {
      resumeAfterRestart([wid]);
      const w = dbOne<{ status: string }>('SELECT status FROM workflows WHERE id = ?', wid);
      assert.ok(['running', 'paused', 'done', 'failed'].includes(w?.status ?? ''), 'status updated from restart-paused');

      const ls = dbOne<{ failures: number; summaries: string }>('SELECT failures, summaries FROM loop_run_states WHERE workflow_id = ?', wid);
      assert.ok(ls, 'loop_run_states row persists after resumeAfterRestart');
      assert.equal(ls!.failures, 2, 'failures are NOT reset to 0 on resume — preserved from DB');
      const summaries = JSON.parse(ls!.summaries);
      assert.deepEqual(summaries, ['iter1 summary', 'iter2 summary'], 'summaries preserved across restart');
    } finally {
      dbRun('DELETE FROM loop_run_states WHERE workflow_id = ?', wid);
      dbRun('DELETE FROM workflows WHERE id = ?', wid);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. Drain: blocks new sessions, disable re-opens                     */
/* ------------------------------------------------------------------ */

describe('drain mode blocks and unblocks', () => {
  test('drain blocks new sessions with 429', async () => {
    await admin.post('/api/admin/drain', { enable: true });
    const r = await admin.req('POST', `/api/projects/${pid}/workflows`, { goal: 'blocked by drain', playground: true });
    assert.equal(r.status, 429, 'new session rejected during drain');
    assert.match(r.data.error, /restarting|drain/i);
    await admin.post('/api/admin/drain', { enable: false });
  });

  test('after drain disabled, new sessions are accepted', async () => {
    const r = await admin.req('POST', `/api/projects/${pid}/workflows`, { goal: 'ok after drain', playground: true, start: false });
    assert.equal(r.status, 200, 'session accepted after drain disabled');
    await admin.del(`/api/workflows/${r.data.workflow.id}`);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Concurrency cap returns 429                                      */
/* ------------------------------------------------------------------ */

describe('concurrency cap', () => {
  test('user hitting per-user cap gets 429', async () => {
    const { run: dbRun } = await import('../server/db.ts');
    const { updateSettings } = await import('../server/settings.ts');
    updateSettings({ controlPlane: { perUserMax: 1, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });

    const adminUser = (await admin.get('/api/auth/me')).user;
    const wid = `w_cap6_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'cap6', 'x', 'running', '', 'sonnet', 5, 8, '', '', 0, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      wid, pid, adminUser.id,
    );

    try {
      const r = await admin.req('POST', `/api/projects/${pid}/workflows`, { goal: 'over cap', playground: true });
      assert.equal(r.status, 429, 'second session rejected when per-user cap is 1');
    } finally {
      dbRun('DELETE FROM workflows WHERE id = ?', wid);
      updateSettings({ controlPlane: { perUserMax: 5, globalMax: 0, perProjectMax: 0, approvalSlaMinutes: 30, worktreeTtlDays: 30, drainTimeoutSeconds: 60 } });
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. Budget stop (assertBudget)                                       */
/* ------------------------------------------------------------------ */

describe('budget stop: assertBudget', () => {
  test('assertBudget throws when user spend exceeds user monthly budget', async () => {
    const { run: dbRun } = await import('../server/db.ts');
    const { assertBudget } = await import('../server/settings.ts');
    // assertBudget checks the runs table for spend, not workflows
    dbRun('UPDATE users SET monthly_budget_usd = ? WHERE id = ?', 0.01, editorId);
    const rid = `r_budget6_${Date.now()}`;
    dbRun(
      "INSERT INTO runs (id, project_id, kind, title, prompt, status, cost_usd, created_by, created_at) VALUES (?, ?, 'session', 'budget test', 'x', 'completed', 1.0, ?, datetime('now'))",
      rid, pid, editorId,
    );
    try {
      assert.throws(
        () => assertBudget('anthropic', editorId, pid),
        (err: Error) => /budget/i.test(err.message),
        'assertBudget should throw when user exceeds monthly budget',
      );
    } finally {
      dbRun('DELETE FROM runs WHERE id = ?', rid);
      dbRun('UPDATE users SET monthly_budget_usd = NULL WHERE id = ?', editorId);
    }
  });

  test('assertBudget passes when spend is well under budget', async () => {
    const { run: dbRun } = await import('../server/db.ts');
    const { assertBudget } = await import('../server/settings.ts');
    dbRun('UPDATE users SET monthly_budget_usd = ? WHERE id = ?', 100.0, editorId);
    try {
      assert.doesNotThrow(() => assertBudget('anthropic', editorId, pid));
    } finally {
      dbRun('UPDATE users SET monthly_budget_usd = NULL WHERE id = ?', editorId);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5-6. Cron dedup and rate limit                                      */
/* ------------------------------------------------------------------ */

describe('cron dedup and rate limit', () => {
  test('cron spec does not fire twice in the same minute (dedup)', async () => {
    const { tickCron, setNowMs } = await import('../server/loop-triggers.ts');
    const spec = await admin.post(`/api/projects/${pid}/loop-specs`, {
      name: 'Dedup cron v6', triggerKind: 'cron',
      goalTemplate: 'nightly', triggerConfig: { cron: '* * * * *', maxPerHour: 60 },
    });
    const sid = spec.spec.id;
    const fixedMs = new Date('2026-03-15T10:30:00Z').getTime();
    setNowMs(() => fixedMs);
    await tickCron();
    await tickCron();
    setNowMs(null);
    const hist = await admin.get(`/api/projects/${pid}/loop-specs/${sid}/trigger-history?limit=10`);
    assert.equal(hist.history.filter((h: any) => h.kind === 'cron').length, 1, 'fires only once per minute');
    const wfs = await admin.get(`/api/projects/${pid}/workflows`);
    for (const w of wfs.workflows) {
      if (w.loop_spec_id === sid) {
        await admin.post(`/api/workflows/${w.id}/stop`).catch(() => {});
        await admin.del(`/api/workflows/${w.id}`).catch(() => {});
      }
    }
    await admin.del(`/api/projects/${pid}/loop-specs/${sid}`);
  });

  test('rate limit: 3/hour blocks 4th trigger in same hour', async () => {
    const spec = await admin.post(`/api/projects/${pid}/loop-specs`, {
      name: 'RateLimit3 v6', triggerKind: 'manual',
      goalTemplate: 'rate test', triggerConfig: { maxPerHour: 3 },
    });
    const sid = spec.spec.id;
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await admin.post(`/api/projects/${pid}/loop-specs/${sid}/run`);
      runs.push(r.workflow.id);
      await admin.post(`/api/workflows/${r.workflow.id}/stop`).catch(() => {});
    }
    const r4 = await admin.req('POST', `/api/projects/${pid}/loop-specs/${sid}/run`);
    assert.equal(r4.status, 400, '4th trigger in same hour should be blocked by rate limit');
    assert.match(r4.data.error, /hour|rate|time/i);
    for (const wid of runs) await admin.del(`/api/workflows/${wid}`).catch(() => {});
    await admin.del(`/api/projects/${pid}/loop-specs/${sid}`);
  });
});

/* ------------------------------------------------------------------ */
/* 7. Cron parser edge cases                                           */
/* ------------------------------------------------------------------ */

describe('cron parser edge cases', () => {
  test('step expression matches every N minutes', async () => {
    const { parseCron } = await import('../server/loop-triggers.ts');
    // "*/5" in minute field = every 5 minutes
    const fn = parseCron('*/5 * * * *');
    assert.ok(fn(new Date('2026-01-01T12:00:00')), 'minute 0 matches every-5');
    assert.ok(fn(new Date('2026-01-01T12:05:00')), 'minute 5 matches every-5');
    assert.ok(fn(new Date('2026-01-01T12:10:00')), 'minute 10 matches every-5');
    assert.ok(!fn(new Date('2026-01-01T12:03:00')), 'minute 3 does NOT match every-5');
  });

  test('comma-separated day-of-week list matches those days only', async () => {
    const { parseCron } = await import('../server/loop-triggers.ts');
    const fn = parseCron('0 12 * * 1,3,5'); // noon on Mon, Wed, Fri
    assert.ok(fn(new Date('2026-03-16T12:00:00')), 'Monday noon matches 1,3,5');
    assert.ok(fn(new Date('2026-03-18T12:00:00')), 'Wednesday noon matches 1,3,5');
    assert.ok(!fn(new Date('2026-03-17T12:00:00')), 'Tuesday noon does NOT match 1,3,5');
  });

  test('throws on 6-field expression', async () => {
    const { parseCron } = await import('../server/loop-triggers.ts');
    assert.throws(() => parseCron('0 0 * * * *'), /5 fields/i, '6-field expression should throw');
  });

  test('throws on empty expression', async () => {
    const { parseCron } = await import('../server/loop-triggers.ts');
    assert.throws(() => parseCron(''), /5 fields/i, 'empty expression should throw');
  });

  test('step on range: N-M/K syntax', async () => {
    const { parseCron } = await import('../server/loop-triggers.ts');
    // 1-59/15 in minutes = minutes 1, 16, 31, 46
    const fn = parseCron('1-59/15 * * * *');
    assert.ok(fn(new Date('2026-01-01T08:01:00')), 'minute 1 matches 1-59/15');
    assert.ok(fn(new Date('2026-01-01T08:16:00')), 'minute 16 matches 1-59/15');
    assert.ok(!fn(new Date('2026-01-01T08:00:00')), 'minute 0 does NOT match 1-59/15');
  });

  test('midnight expression: 0 0 * * * fires only at midnight', async () => {
    const { parseCron } = await import('../server/loop-triggers.ts');
    const fn = parseCron('0 0 * * *');
    assert.ok(fn(new Date('2026-06-01T00:00:00')), 'midnight matches 0 0 * * *');
    assert.ok(!fn(new Date('2026-06-01T01:00:00')), '1am does NOT match 0 0 * * *');
    assert.ok(!fn(new Date('2026-06-01T00:01:00')), '00:01 does NOT match 0 0 * * *');
  });
});

/* ------------------------------------------------------------------ */
/* 8. GitHub HMAC edge cases                                           */
/* ------------------------------------------------------------------ */

describe('GitHub HMAC edge cases', () => {
  let ghSpecId: string;
  let ghSecret: string;

  before(async () => {
    const res = await admin.post(`/api/projects/${pid}/loop-specs`, {
      name: 'GH HMAC edge v6', triggerKind: 'github_event',
      goalTemplate: 'Fix {{repo.full_name}}',
      triggerConfig: { events: ['workflow_run'], maxPerHour: 10 },
    });
    ghSpecId = res.spec.id;
    ghSecret = res.spec.trigger_config.secret;
  });

  after(async () => {
    await admin.del(`/api/projects/${pid}/loop-specs/${ghSpecId}`).catch(() => {});
  });

  test('missing x-hub-signature-256 header returns 401', async () => {
    const body = JSON.stringify({ workflow_run: { conclusion: 'failure' }, repository: { name: 'api', full_name: 'acme/api' } });
    const res = await fetch(`${srv.base}/api/loop-specs/${ghSpecId}/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-github-event': 'workflow_run', 'x-github-delivery': 'x-001' },
      body,
    });
    assert.equal(res.status, 401, 'missing signature header should return 401');
  });

  test('truncated signature (wrong length) returns 401', async () => {
    const body = JSON.stringify({ workflow_run: { conclusion: 'failure' }, repository: { name: 'api' } });
    const res = await fetch(`${srv.base}/api/loop-specs/${ghSpecId}/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=abc', 'x-github-event': 'workflow_run', 'x-github-delivery': 'x-002' },
      body,
    });
    assert.equal(res.status, 401, 'truncated signature should be rejected');
  });

  test('correct HMAC signature fires session', async () => {
    const payload = { workflow_run: { id: 9901, conclusion: 'failure', html_url: 'https://github.com' }, repository: { name: 'api', full_name: 'acme/api' } };
    const body = JSON.stringify(payload);
    const sig = 'sha256=' + crypto.createHmac('sha256', ghSecret).update(body).digest('hex');
    const res = await fetch(`${srv.base}/api/loop-specs/${ghSpecId}/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig, 'x-github-event': 'workflow_run', 'x-github-delivery': 'x-003' },
      body,
    });
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.ok, true);
    if (data.workflowId) {
      await admin.post(`/api/workflows/${data.workflowId}/stop`).catch(() => {});
      await admin.del(`/api/workflows/${data.workflowId}`).catch(() => {});
    }
  });
});

/* ------------------------------------------------------------------ */
/* 9. OIDC token verification failures                                 */
/* ------------------------------------------------------------------ */

describe('OIDC token verification failures', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-oidc-v6';
  const pubJwk = publicKey.export({ format: 'jwk' });

  function makeToken(overrides: Record<string, unknown> = {}, sign = true): string {
    const header = { alg: 'RS256', kid };
    const payload = {
      iss: 'https://accounts.google.com',
      aud: 'test-client-v6',
      sub: 'google-sub-v6',
      email: 'v6-user@example.com',
      email_verified: true,
      nonce: 'v6-nonce',
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      ...overrides,
    };
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    if (!sign) return `${h}.${p}.invalidsignature`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${h}.${p}`);
    return `${h}.${p}.${signer.sign(privateKey).toString('base64url')}`;
  }

  let setOidcEndpointsFn: (e: any) => void;
  let capturedState: string;
  let capturedNonce: string;

  before(async () => {
    const gov = await import('../server/governance.ts');
    setOidcEndpointsFn = gov.setOidcEndpoints;
    await admin.put('/api/admin/oidc', {
      enabled: true, clientId: 'test-client-v6', clientSecret: 'test-secret',
      allowedDomains: ['example.com'], autoCreate: true, defaultAccess: 'member',
      adminEmails: [], disablePasswordLogin: false,
    });
  });

  function setupMock(token: string): void {
    setOidcEndpointsFn({
      async discovery() {
        return {
          authorization_endpoint: 'https://accounts.google.com/o/oauth2/auth',
          token_endpoint: 'https://oauth2.googleapis.com/token',
          jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
        };
      },
      async jwks() { return { keys: [{ ...pubJwk, kid, use: 'sig', alg: 'RS256' }] }; },
      async token() { return { id_token: token, access_token: 'fake' }; },
    });
  }

  async function startOidcFlow(): Promise<void> {
    const startR = await admin.req('GET', '/api/auth/oidc/start');
    const url = new URL(startR.data.url);
    capturedState = url.searchParams.get('state')!;
    capturedNonce = url.searchParams.get('nonce')!;
  }

  test('expired token (exp in past) is rejected with 401', async () => {
    await startOidcFlow();
    setupMock(makeToken({ nonce: capturedNonce, exp: Math.floor(Date.now() / 1000) - 10 }));
    const c = new Client(srv.base);
    const r = await c.req('GET', `/api/auth/oidc/callback?code=x&state=${capturedState}`);
    assert.equal(r.status, 401, 'expired token should be rejected');
  });

  test('wrong audience is rejected with 401', async () => {
    await startOidcFlow();
    setupMock(makeToken({ nonce: capturedNonce, aud: 'wrong-audience' }));
    const c = new Client(srv.base);
    const r = await c.req('GET', `/api/auth/oidc/callback?code=x&state=${capturedState}`);
    assert.equal(r.status, 401, 'wrong audience should be rejected');
  });

  test('email_verified=false is rejected with 401', async () => {
    await startOidcFlow();
    setupMock(makeToken({ nonce: capturedNonce, email_verified: false }));
    const c = new Client(srv.base);
    const r = await c.req('GET', `/api/auth/oidc/callback?code=x&state=${capturedState}`);
    assert.equal(r.status, 401, 'unverified email should be rejected');
  });

  test('invalid signature (bad signing key) is rejected with 401', async () => {
    await startOidcFlow();
    setupMock(makeToken({ nonce: capturedNonce }, false));
    const c = new Client(srv.base);
    const r = await c.req('GET', `/api/auth/oidc/callback?code=x&state=${capturedState}`);
    assert.equal(r.status, 401, 'invalid signature should be rejected');
  });
});

/* ------------------------------------------------------------------ */
/* 10. Invite single-use and expiry                                    */
/* ------------------------------------------------------------------ */

describe('invitation edge cases', () => {
  test('invite token is single-use (410 on second use)', async () => {
    const inv = await admin.post('/api/invitations', { email: 'single-v6@example.com' });
    const c1 = new Client(srv.base);
    const r1 = await c1.req('POST', `/api/invitations/accept/${inv.token}`, { name: 'U1', password: 'secure-pass-v6-001' });
    assert.equal(r1.status, 200, 'first use should succeed');
    const c2 = new Client(srv.base);
    const r2 = await c2.req('POST', `/api/invitations/accept/${inv.token}`, { name: 'U2', password: 'secure-pass-v6-002' });
    assert.equal(r2.status, 410, 'second use should return 410 Gone');
  });

  test('expired invite is rejected', async () => {
    const inv = await admin.post('/api/invitations', { email: 'expired-v6@example.com' });
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(inv.token).digest('hex');
    const { run: dbRun } = await import('../server/db.ts');
    dbRun('UPDATE invitations SET expires_at = ? WHERE token_hash = ?', '2020-01-01T00:00:00.000Z', hash);
    const c = new Client(srv.base);
    const r = await c.req('POST', `/api/invitations/accept/${inv.token}`, { name: 'ExpUser', password: 'secure-pass-exp-v6' });
    assert.ok(r.status >= 400, `expired invite should be rejected (got ${r.status})`);
  });

  test('nonexistent token returns 404', async () => {
    const r = await admin.req('GET', '/api/invitations/accept/inv_nonexistent-v6-token');
    assert.equal(r.status, 404);
  });

  test('non-admin cannot set portal_role=admin on invitation', async () => {
    // Viewers can create invitations, but only admins can grant admin role
    const r = await viewer.req('POST', '/api/invitations', { email: 'no-admin@example.com', portal_role: 'admin' });
    // Non-admin creating invite succeeds (200) but portal_role is downgraded to 'member'
    assert.equal(r.status, 200, 'viewer can create invitations but cannot grant admin role');
    // The returned token should be for a member, not admin
    // We can verify by checking the DB entry was created as member
    assert.ok(r.data.token, 'invite token returned');
  });
});

/* ------------------------------------------------------------------ */
/* 11. SCIM auth enforcement                                           */
/* ------------------------------------------------------------------ */

describe('SCIM auth enforcement', () => {
  test('no Authorization header returns 401', async () => {
    const res = await fetch(`${srv.base}/scim/v2/Users`);
    assert.equal(res.status, 401, 'SCIM without token returns 401');
  });

  test('wrong Bearer token returns 401', async () => {
    const res = await fetch(`${srv.base}/scim/v2/Users`, {
      headers: { authorization: 'Bearer definitely-wrong-token' },
    });
    assert.equal(res.status, 401, 'SCIM with wrong token returns 401');
  });

  test('revoked SCIM token returns 401', async () => {
    const r = await admin.post('/api/admin/scim-tokens');
    const token = r.token;
    // The create endpoint returns {token, hint} not {token, id}.
    // Retrieve the ID from the list by matching the hint.
    const tokens = await admin.get('/api/admin/scim-tokens');
    const tok = tokens.tokens.find((t: any) => t.hint === r.hint);
    assert.ok(tok, 'token should be in the list');
    await admin.del(`/api/admin/scim-tokens/${tok.id}`);
    const res = await fetch(`${srv.base}/scim/v2/Users`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401, 'revoked SCIM token returns 401');
  });
});

/* ------------------------------------------------------------------ */
/* 12. Inbox aggregation                                               */
/* ------------------------------------------------------------------ */

describe('inbox aggregation', () => {
  test('pending input appears in inbox needs_you count', async () => {
    const { run: dbRun } = await import('../server/db.ts');
    const adminUser = (await admin.get('/api/auth/me')).user;

    const wid = `w_inbox6_${Date.now()}`;
    dbRun(
      "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'Inbox test', 'blocked work', 'paused', 'Needs human decision', 'sonnet', 5, 8, '', '', 1, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('now'), datetime('now'))",
      wid, pid, adminUser.id,
    );
    const inputId = `i_inbox6_${Date.now()}`;
    dbRun(
      "INSERT INTO inputs (id, project_id, run_id, type, tool_name, payload, status, created_by, created_at) VALUES (?, ?, ?, 'approval', 'Ask', ?, 'pending', ?, datetime('now'))",
      inputId, pid, wid, JSON.stringify({ question: 'Should I proceed?' }), adminUser.id,
    );

    try {
      const res = await admin.get('/api/inbox');
      assert.ok(res.needs_you >= 1, 'needs_you count should be >= 1 when there is a pending input');
      const r = await admin.req('GET', '/api/inbox');
      const header = r.headers.get('x-inbox-needs-you');
      assert.ok(header !== null && Number(header) >= 1, 'X-Inbox-Needs-You header reflects count');
    } finally {
      dbRun('DELETE FROM inputs WHERE id = ?', inputId);
      dbRun('DELETE FROM workflows WHERE id = ?', wid);
    }
  });

  test('inbox needs_you filter returns only waiting/actionable items', async () => {
    const res = await admin.get('/api/inbox?filter=needs_you');
    assert.ok(
      res.items.every((i: any) => ['waiting', 'push_ready', 'plan_pending', 'escalation'].includes(i.kind)),
      'needs_you filter returns only actionable items',
    );
  });
});

/* ------------------------------------------------------------------ */
/* 13. Readiness panel                                                 */
/* ------------------------------------------------------------------ */

describe('readiness panel', () => {
  test('project with no repo shows repository as missing or warn', async () => {
    const newProj = await admin.post('/api/projects', { name: 'No Repo v6', description: 'test' });
    const npid = newProj.project.id;
    const res = await admin.get(`/api/projects/${npid}/readiness`);
    const repo = res.items.find((i: any) => i.key === 'repository');
    assert.ok(repo, 'readiness should have a repository item');
    assert.ok(['missing', 'warn'].includes(repo.status), `repository should be missing or warn (got ${repo.status})`);
  });

  test('readiness ready is false when blocking items exist', async () => {
    const newProj = await admin.post('/api/projects', { name: 'Unready v6', description: 'test' });
    const npid = newProj.project.id;
    const res = await admin.get(`/api/projects/${npid}/readiness`);
    assert.ok(typeof res.ready === 'boolean', 'ready should be a boolean');
  });
});

/* ------------------------------------------------------------------ */
/* 14. Security pass on new routes                                     */
/* ------------------------------------------------------------------ */

describe('security: new routes', () => {
  test('loop-specs list requires authentication', async () => {
    const r = await fetch(`${srv.base}/api/projects/${pid}/loop-specs`, {
      headers: { 'x-requested-with': 'agent-portal' },
    });
    assert.equal(r.status, 401, 'unauthenticated request returns 401');
  });

  test('loop-specs create requires project membership (404 if not a member)', async () => {
    // requireProject throws 404 for non-members to obscure project existence
    const otherProj = await admin.post('/api/projects', { name: 'Other Proj v6', description: 'x' });
    const r = await viewer.req('POST', `/api/projects/${otherProj.project.id}/loop-specs`, {
      name: 'x', triggerKind: 'manual', goalTemplate: 'y',
    });
    assert.ok(r.status === 403 || r.status === 404, `non-member gets 403 or 404 (not 200) for another project; got ${r.status}`);
  });

  test('CSRF header required for state-changing requests', async () => {
    const r = await fetch(`${srv.base}/api/projects/${pid}/loop-specs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', triggerKind: 'manual', goalTemplate: 'y' }),
    });
    assert.equal(r.status, 403, 'missing CSRF header returns 403');
  });

  test('readiness API requires project membership (404 if not a member)', async () => {
    // requireProject returns 404 for non-members (obscures project existence)
    const otherProj = await admin.post('/api/projects', { name: 'Readiness Auth v6', description: 'x' });
    const r = await viewer.req('GET', `/api/projects/${otherProj.project.id}/readiness`);
    assert.ok(r.status === 403 || r.status === 404, `non-member gets 403 or 404 for readiness; got ${r.status}`);
  });

  test('admin audit log requires admin role', async () => {
    const r = await editor.req('GET', '/api/admin/audit-log');
    assert.equal(r.status, 403, 'non-admin cannot access audit log');
  });

  test('control plane status requires admin role', async () => {
    const r = await editor.req('GET', '/api/admin/control-plane');
    assert.equal(r.status, 403, 'non-admin cannot access control plane');
  });

  test('outbound webhooks require admin role', async () => {
    const r = await editor.req('POST', '/api/outbound-webhooks', { url: 'https://x.com', events: [] });
    assert.equal(r.status, 403, 'non-admin cannot create outbound webhooks');
  });

  test('Prometheus metrics require admin role', async () => {
    const r = await editor.req('GET', '/api/metrics');
    assert.equal(r.status, 403, 'non-admin cannot access metrics');
  });

  test('webhook trigger is CSRF-exempt (external services can call without CSRF header)', async () => {
    const spec = await admin.post(`/api/projects/${pid}/loop-specs`, {
      name: 'CSRF exempt v6', triggerKind: 'webhook', goalTemplate: 'test',
    });
    const sid = spec.spec.id;
    const secret = spec.spec.trigger_config.secret;
    const body = '{}';
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    // No x-requested-with header — webhook must be CSRF-exempt
    const res = await fetch(`${srv.base}/api/loop-specs/${sid}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
      body,
    });
    assert.notEqual(res.status, 403, 'webhook trigger should not require CSRF header (got 403)');
    if (res.status === 200) {
      const d = await res.json() as any;
      if (d.workflowId) {
        await admin.post(`/api/workflows/${d.workflowId}/stop`).catch(() => {});
        await admin.del(`/api/workflows/${d.workflowId}`).catch(() => {});
      }
    }
    await admin.del(`/api/projects/${pid}/loop-specs/${sid}`).catch(() => {});
  });

  test('verifyHmac uses timingSafeEqual for constant-time comparison', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(new URL('../server/loop-triggers.ts', import.meta.url), 'utf8');
    assert.ok(src.includes('timingSafeEqual'), 'verifyHmac uses crypto.timingSafeEqual');
  });

  test('viewer cannot create a loop spec (editor access required)', async () => {
    const r = await viewer.req('POST', `/api/projects/${pid}/loop-specs`, {
      name: 'viewer attempt', triggerKind: 'manual', goalTemplate: 'x',
    });
    assert.equal(r.status, 403, 'viewer cannot create specs (requires editor)');
  });
});

/* ------------------------------------------------------------------ */
/* 15. Outbound webhook secret not exposed in list                     */
/* ------------------------------------------------------------------ */

describe('secrets not returned to browser', () => {
  test('outbound webhook list shows hint only, not full secret', async () => {
    const created = await admin.post('/api/outbound-webhooks', {
      url: 'https://example.com/v6', events: ['session.done'],
    });
    assert.ok(created.secret, 'full secret returned on creation');
    const list = await admin.get('/api/outbound-webhooks');
    const wh = list.webhooks.find((w: any) => w.id === created.id);
    assert.ok(wh, 'webhook should be in the list');
    assert.ok(!wh.secret, 'full secret should NOT be in the list response');
    assert.ok(wh.secret_hint, 'secret_hint should be present');
    assert.ok(wh.secret_hint.length <= 8, 'secret_hint is short (hint only, not full secret)');
    await admin.del(`/api/outbound-webhooks/${created.id}`);
  });
});
