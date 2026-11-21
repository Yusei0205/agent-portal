/**
 * Loop sessions: after a run ends, the session either starts the next run or stops with the reason (workflows/loop.ts).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup, createTestServer, fetchJson } from './fixtures.ts';
import { one } from '../server/db.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { afterRun, readLoopState, newLoopState } from '../server/workflows/loop.ts';

describe('loop sessions', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  const ids: string[] = [];

  async function loopSession(rules: Record<string, unknown> = {}, maxIterations = 8): Promise<string> {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST', body: { goal: 'Fix the bug', engine: 'demo', start: false, maxIterations, loop: { stopRules: rules } }, cookie,
    });
    const id = String(((r.body as Record<string, unknown>).workflow as Record<string, unknown> | undefined)?.id ?? (r.body as Record<string, unknown>).id ?? '');
    assert.ok(id, `workflow not created: ${r.status} ${JSON.stringify(r.body)}`);
    ids.push(id);
    return id;
  }

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST', body: { email: `admin-lp-${Date.now()}@test.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `Loop-${Date.now()}` }, cookie });
    projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
  });

  after(async () => { await cleanup(); });

  it('a session created with loop has its state; an ordinary one has none', async () => {
    const id = await loopSession({ maxConsecutiveFailures: 3 });
    const w = (await getSessionsRepository().getWorkflowById(id))!;
    assert.equal(readLoopState(w)?.rules.maxConsecutiveFailures, 3);
    assert.equal(readLoopState({ loop_state: '' }), null);
    assert.ok(newLoopState({}).includes('"enabled":true'));
  });

  it('stops as done when the agent reports done, and records the iteration', async () => {
    const id = await loopSession();
    const repo = getSessionsRepository();
    await repo.updateWorkflow(id, { status: 'done', iteration_count: 1 });
    const d = await afterRun(id, { result: 'fixed it\nWORKFLOW_STATUS {"state":"done","summary":"bug fixed"}', failed: false });
    assert.equal(d?.action, 'stop');
    const w = (await repo.getWorkflowById(id))!;
    assert.equal(w.status, 'done');
    assert.equal(readLoopState(w)?.progress[0]?.summary, 'bug fixed');
  });

  it('stops as blocked with what the agent needs', async () => {
    const id = await loopSession();
    const repo = getSessionsRepository();
    await repo.updateWorkflow(id, { status: 'done', iteration_count: 1 });
    await afterRun(id, { result: 'WORKFLOW_STATUS {"state":"blocked","summary":"stuck","needs":"the staging password"}', failed: false });
    const w = (await repo.getWorkflowById(id))!;
    assert.equal(w.status, 'blocked');
    assert.match(w.stop_reason, /staging password/);
  });

  it('stops as failed after maxConsecutiveFailures failed runs in a row', async () => {
    const id = await loopSession({ maxConsecutiveFailures: 2 });
    const repo = getSessionsRepository();
    await repo.updateWorkflow(id, { status: 'failed' });
    const first = await afterRun(id, { result: 'boom', failed: true });
    // The first failure goes on to a new attempt; make the session startable-but-idle again for the second.
    assert.equal(first?.action, 'continue');
    await new Promise((r) => setTimeout(r, 300));
    await repo.updateWorkflow(id, { status: 'failed' });
    const second = await afterRun(id, { result: 'boom again', failed: true });
    assert.equal(second?.action, 'stop');
    const w = (await repo.getWorkflowById(id))!;
    assert.equal(w.status, 'failed');
    assert.match(w.stop_reason, /failed in a row/);
  });

  it('stops as paused when the last iterations report the same thing', async () => {
    const id = await loopSession({ stagnationWindow: 2 });
    const repo = getSessionsRepository();
    for (let i = 1; i <= 2; i++) {
      await repo.updateWorkflow(id, { status: 'done', iteration_count: i });
      const d = await afterRun(id, { result: 'WORKFLOW_STATUS {"state":"continue","summary":"no change in the tests"}', failed: false });
      if (i === 2) assert.equal(d?.action, 'stop');
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal((await repo.getWorkflowById(id))!.status, 'paused');
  });

  it('goes on by starting the next run', async () => {
    const id = await loopSession();
    const repo = getSessionsRepository();
    await repo.updateWorkflow(id, { status: 'done', iteration_count: 1 });
    const d = await afterRun(id, { result: 'WORKFLOW_STATUS {"state":"continue","summary":"half way","next":"the rest"}', failed: false });
    assert.equal(d?.action, 'continue');
    const run = one<{ n: number }>('SELECT COUNT(*) AS n FROM p6_runs WHERE workflow_id = ?', id);
    assert.ok((run?.n ?? 0) >= 1, 'the next run should exist');
  });
});
