/**
 * Long cloud runs: the reason a time-limited run gives, repositories cloned before the run's clock starts, and which
 * runs go to the job runtime.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { setSetting } from '../server/settings.ts';
import { describeRunFailure } from '../server/review-lifecycle.ts';
import { hostLimitMinutes, hostLimitStopReason, hostLimitMessage } from '../server/agent/host-limit.ts';
import { reposAreReady, ensureReposPrepared, type RepoPrepState } from '../server/agent/repo-prep.ts';
import { registerBackgroundJob, runInBackground } from '../server/background-jobs.ts';
import { _setJobRuntimeInvoker } from '../server/job-runtime.ts';

function makeWorkflow(trust: number, repoIds = '[]'): string {
  const db = getDb();
  const projectId = `proj-${generateId()}`;
  const id = `wf-${generateId()}`;
  db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(projectId, 'P', `p-${projectId.slice(0, 8)}`, now());
  db.prepare(
    `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
     VALUES (?, ?, 'g', 'pending', 'kiro', ?, ?, ?, ?)`,
  ).run(id, projectId, trust, repoIds, now(), now());
  return id;
}

describe('the reason a generated document, diagram or presentation did not finish', () => {
  it('names the time limit that stopped it', () => {
    assert.match(describeRunFailure({ stop_reason: 'time limit reached (14 minutes)' }), /^Generation stopped: time limit reached \(14 minutes\)/);
  });
  it('gives the run error when there is no stop reason, and a plain line when there is neither', () => {
    assert.equal(describeRunFailure({ stop_reason: '', error: 'AgentCore kiro-run error: x' }), 'Generation failed: AgentCore kiro-run error: x');
    assert.equal(describeRunFailure(null), 'Generation failed');
  });
});

describe('the portal time limit message', () => {
  it('counts minutes and says how to go on', () => {
    assert.equal(hostLimitMinutes(14 * 60_000), 14);
    assert.equal(hostLimitStopReason(14 * 60_000), 'time limit reached (14 minutes)');
    assert.match(hostLimitMessage(14 * 60_000), /at most 14 minutes\. Send another message to continue/);
  });
});

describe('repositories ready before a run', () => {
  const ok = (names: string[], extra: Partial<RepoPrepState> = {}): RepoPrepState => ({
    state: 'done', at: now(), message: '', items: names.map((name) => ({ name, state: 'done' as const, text: 'Ready' })), ...extra,
  });

  it('is ready only when every repository is done and nothing is wrong', () => {
    assert.equal(reposAreReady(ok(['a', 'b']), ['a', 'b']), true);
    assert.equal(reposAreReady(ok(['a']), ['a', 'b']), false, 'one repository was never prepared');
    assert.equal(reposAreReady(null, ['a']), false);
    assert.equal(reposAreReady({ ...ok(['a']), state: 'failed' }, ['a']), false);
    assert.equal(reposAreReady(ok(['a'], { problem: { kind: 'aws-keys', fix: 'aws', text: 't' } }), ['a']), false);
  });

  describe('ensureReposPrepared', () => {
    const saved = process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN;
    before(() => {
      createTestDb();
      process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/kiro-x';
    });
    after(async () => {
      if (saved === undefined) delete process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN; else process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = saved;
      await cleanup();
    });

    it('does nothing, and says nothing, when the repositories are already there', async () => {
      const workflowId = makeWorkflow(1, '["r1"]');
      await setSetting(getDb(), `repoprep.${workflowId}`, JSON.stringify(ok(['repo-a'])));
      const said: string[] = [];
      const problem = await ensureReposPrepared(workflowId, ['repo-a'], (t) => said.push(t));
      assert.equal(problem, null);
      assert.deepEqual(said, []);
    });

    it('passes on the problem a refused sign-in left, so the run is not started', async () => {
      const workflowId = makeWorkflow(1, '["r1"]');
      const problem = { kind: 'aws-keys' as const, fix: 'aws' as const, text: 'Update the keys in Workspaces → AWS' };
      // A preparation still "running" that then ends failed with a problem, as the runner reports it.
      await setSetting(getDb(), `repoprep.${workflowId}`, JSON.stringify({ state: 'running', at: now(), message: '' }));
      setTimeout(() => {
        void setSetting(getDb(), `repoprep.${workflowId}`, JSON.stringify({
          state: 'failed', at: now(), message: 'x', problem, items: [{ name: 'repo-a', state: 'failed', text: 'x' }],
        }));
      }, 100);
      const said: string[] = [];
      const got = await ensureReposPrepared(workflowId, ['repo-a'], (t) => said.push(t));
      assert.deepEqual(got, problem);
      assert.ok(said.some((t) => /Waiting for the repositories/.test(t)));
    });
  });
});

describe('which agent runs go to the job runtime', () => {
  const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/agentPortalJobRunner-abc';
  const KEYS = ['PORTAL_ORIGIN_SECRET', 'PORTAL_JOB_RUNTIME_ARN', 'PORTAL_JOB_RUNTIME_JOBS', 'PORTAL_JOB_RUNNER', 'AWS_LAMBDA_FUNCTION_NAME'] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const started: string[] = [];
  registerBackgroundJob('execute-run', async () => { /* the real job is not needed here */ });

  before(() => { createTestDb(); });
  after(async () => { await cleanup(); });
  afterEach(() => {
    started.length = 0;
    _setJobRuntimeInvoker(null);
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  function configure(): void {
    process.env.PORTAL_ORIGIN_SECRET = 's';
    process.env.PORTAL_JOB_RUNTIME_ARN = ARN;
    process.env.PORTAL_JOB_RUNTIME_JOBS = '+execute-run';
    delete process.env.PORTAL_JOB_RUNNER;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    _setJobRuntimeInvoker(async (_arn, _sid, payload) => { started.push(String(payload.job)); });
  }

  it('a trusted session (no approvals needed) runs there', async () => {
    configure();
    await runInBackground('execute-run', { runId: 'r1', workflowId: makeWorkflow(1) });
    assert.deepEqual(started, ['execute-run']);
  });

  it('a session that may ask for an approval stays where the person can answer', async () => {
    configure();
    await runInBackground('execute-run', { runId: 'r2', workflowId: makeWorkflow(0) });
    assert.deepEqual(started, []);
  });
});
