import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWorkflowRun } from '../server/pipelines/events.ts';

const fx = (n: string): Record<string, any> => JSON.parse(readFileSync(new URL(`./fixtures/github/${n}.json`, import.meta.url), 'utf8'));

describe('parseWorkflowRun', () => {
  it('maps requested to queued', () => {
    const e = parseWorkflowRun('workflow_run', fx('workflow_run_requested'))!;
    assert.equal(e.status, 'queued');
    assert.equal(e.repoFullName, 'acme/widgets');
    assert.equal(e.runId, 9200001);
    assert.equal(e.runAttempt, 1);
    assert.equal(e.runNumber, 42);
    assert.equal(e.workflowId, 5500001);
    assert.equal(e.workflowName, 'Deploy portal');
    assert.equal(e.branch, 'main');
    assert.equal(e.actor, 'octocat');
    assert.equal(e.event, 'push');
    assert.equal(e.htmlUrl, 'https://github.com/acme/widgets/actions/runs/9200001');
    assert.equal(e.startedAt, '2026-11-20T10:00:00Z');
    assert.equal(e.completedAt, null);
  });
  it('maps in_progress', () => {
    assert.equal(parseWorkflowRun('workflow_run', fx('workflow_run_in_progress'))!.status, 'in_progress');
  });
  it('maps timed_out and sets completedAt', () => {
    const e = parseWorkflowRun('workflow_run', fx('workflow_run_timed_out'))!;
    assert.equal(e.status, 'timed_out');
    assert.equal(e.completedAt, '2026-11-20T10:05:00Z');
  });
  it('maps every conclusion', () => {
    const base = fx('workflow_run_timed_out');
    const want: Record<string, string> = { success: 'success', failure: 'failure', timed_out: 'timed_out', cancelled: 'cancelled', skipped: 'skipped', neutral: 'other', action_required: 'other', stale: 'other', startup_failure: 'other' };
    for (const [c, s] of Object.entries(want)) {
      base.workflow_run.conclusion = c;
      assert.equal(parseWorkflowRun('workflow_run', base)!.status, s, c);
    }
    base.workflow_run.conclusion = null;
    assert.equal(parseWorkflowRun('workflow_run', base)!.status, 'other');
  });
  it('falls back to actor.login / sender and created_at', () => {
    const p = fx('workflow_run_requested');
    delete p.workflow_run.triggering_actor;
    delete p.workflow_run.run_started_at;
    p.workflow_run.actor = { login: 'bob' };
    const e = parseWorkflowRun('workflow_run', p)!;
    assert.equal(e.actor, 'bob');
    assert.equal(e.startedAt, '2026-11-20T09:59:50Z');
    delete p.workflow_run.actor;
    assert.equal(parseWorkflowRun('workflow_run', p)!.actor, '');
  });
  it('blanks a non-github html_url', () => {
    for (const u of ['https://evil.example/x', 'http://github.com/a', 'https://github.com.evil.example/x', 5]) {
      const p = fx('workflow_run_requested');
      p.workflow_run.html_url = u;
      assert.equal(parseWorkflowRun('workflow_run', p)!.htmlUrl, '');
    }
  });
  it('returns null for malformed input', () => {
    assert.equal(parseWorkflowRun('push', fx('workflow_run_requested')), null);
    assert.equal(parseWorkflowRun('workflow_run', null), null);
    assert.equal(parseWorkflowRun('workflow_run', 'x'), null);
    // existing fixtures carry no workflow_id / run_number
    assert.equal(parseWorkflowRun('workflow_run', fx('workflow_run_failed_main')), null);
    for (const k of ['id', 'workflow_id', 'run_number']) {
      for (const bad of [undefined, 0, -1, 1.5, '12', null]) {
        const p = fx('workflow_run_requested');
        if (bad === undefined) delete p.workflow_run[k]; else p.workflow_run[k] = bad;
        assert.equal(parseWorkflowRun('workflow_run', p), null, `${k}=${String(bad)}`);
      }
    }
    for (const bad of ['', 'noslash', 'a/b/c', '/b', 'a/', 'a b/c', 5]) {
      const p = fx('workflow_run_requested');
      p.repository.full_name = bad;
      assert.equal(parseWorkflowRun('workflow_run', p), null, String(bad));
    }
    const p = fx('workflow_run_requested');
    p.action = 'bogus';
    assert.equal(parseWorkflowRun('workflow_run', p), null);
  });
  it('defaults run_attempt to 1 when absent and rejects a bad one', () => {
    const p = fx('workflow_run_requested');
    delete p.workflow_run.run_attempt;
    assert.equal(parseWorkflowRun('workflow_run', p)!.runAttempt, 1);
    p.workflow_run.run_attempt = 0;
    assert.equal(parseWorkflowRun('workflow_run', p), null);
  });
  it('bounds and cleans untrusted strings', () => {
    const p = fx('workflow_run_requested');
    p.workflow_run.name = `De\u0000ploy\n${'x'.repeat(300)}`;
    p.workflow_run.head_branch = 'b'.repeat(500);
    const e = parseWorkflowRun('workflow_run', p)!;
    assert.ok(e.workflowName.length <= 200);
    assert.ok(!/[\u0000-\u001f]/.test(e.workflowName));
    assert.ok(e.workflowName.startsWith('Deploy'));
    assert.equal(e.branch.length, 200);
  });
  it('rejects an empty branch', () => {
    const p = fx('workflow_run_requested');
    p.workflow_run.head_branch = '';
    assert.equal(parseWorkflowRun('workflow_run', p), null);
  });
});
