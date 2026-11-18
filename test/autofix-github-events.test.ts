import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseGithubEvent, classifyKind } from '../server/autofix/github-events.ts';

const fx = (n: string): unknown => JSON.parse(fs.readFileSync(new URL(`./fixtures/github/${n}.json`, import.meta.url), 'utf8'));

describe('parseGithubEvent', () => {
  it('a failed workflow_run on main is a finding classified by workflow name', () => {
    const r = parseGithubEvent('workflow_run', fx('workflow_run_failed_main'));
    assert.equal(r.type, 'finding');
    if (r.type !== 'finding') return;
    assert.equal(r.candidate.kind, 'lint');
    assert.equal(r.candidate.repoFullName, 'acme/widgets');
    assert.equal(r.candidate.branch, 'main');
    assert.equal(r.candidate.runId, 9100001);
    assert.equal(r.candidate.source, 'ci_failed');
  });
  it('a failed run on an autofix/ branch is a ci_result, never a finding', () => {
    const r = parseGithubEvent('workflow_run', fx('workflow_run_failed_autofix'));
    assert.deepEqual(r, { type: 'ci_result', repoFullName: 'acme/widgets', branch: 'autofix/tests-ab12cd34', conclusion: 'failure', headSha: 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      workflowName: 'CI / tests', runId: 9100002 });
  });
  it('a successful run is a ci_result success', () => {
    const r = parseGithubEvent('workflow_run', fx('workflow_run_success_main'));
    assert.equal(r.type, 'ci_result');
    if (r.type === 'ci_result') assert.equal(r.conclusion, 'success');
  });
  it('a run of a fork (head repository differs) is never a ci_result', () => {
    for (const n of ['workflow_run_failed_autofix', 'workflow_run_success_main']) {
      const p = fx(n) as { workflow_run: Record<string, unknown> };
      p.workflow_run.head_repository = { full_name: 'mallory/widgets' };
      assert.deepEqual(parseGithubEvent('workflow_run', p), { type: 'ignore' }, n);
      delete p.workflow_run.head_repository;
      assert.deepEqual(parseGithubEvent('workflow_run', p), { type: 'ignore' }, `${n} without head_repository`);
    }
  });
  it('a failing run of a fork on a branch named main is ignored (never a finding); a same-repository failure still is one', () => {
    const p = fx('workflow_run_failed_main') as { workflow_run: Record<string, unknown> };
    assert.equal(parseGithubEvent('workflow_run', p).type, 'finding', 'own repository');
    p.workflow_run.head_repository = { full_name: 'mallory/widgets' };
    assert.deepEqual(parseGithubEvent('workflow_run', p), { type: 'ignore' }, 'fork');
    p.workflow_run.head_repository = { full_name: 'ACME/Widgets' };
    assert.equal(parseGithubEvent('workflow_run', p).type, 'finding', 'the name is compared without case');
    delete p.workflow_run.head_repository;
    assert.deepEqual(parseGithubEvent('workflow_run', p), { type: 'ignore' }, 'no head_repository: ignored (fail closed)');
  });
  it('a merged pull_request closing is pr_closed', () => {
    assert.deepEqual(parseGithubEvent('pull_request', fx('pull_request_merged')),
      { type: 'pr_closed', repoFullName: 'acme/widgets', branch: 'autofix/lint-9f8e7d6c', merged: true, prNumber: 42 });
  });
  it('ping, cancelled runs, check_suite and junk are ignored', () => {
    assert.deepEqual(parseGithubEvent('ping', fx('ping')), { type: 'ignore' });
    assert.deepEqual(parseGithubEvent('workflow_run', fx('workflow_run_cancelled')), { type: 'ignore' });
    assert.deepEqual(parseGithubEvent('check_suite', fx('check_suite_failed')), { type: 'ignore' });
    assert.deepEqual(parseGithubEvent('workflow_run', null), { type: 'ignore' });
    assert.deepEqual(parseGithubEvent('workflow_run', { action: 'requested' }), { type: 'ignore' });
  });
});

describe('classifyKind', () => {
  it('follows the order lint, types, build, tests, other', () => {
    assert.equal(classifyKind('ESLint'), 'lint');
    assert.equal(classifyKind('tsc check'), 'types');
    assert.equal(classifyKind('Build'), 'build');
    assert.equal(classifyKind('unit tests'), 'tests');
    assert.equal(classifyKind('deploy'), 'other');
    assert.equal(classifyKind('lint and test'), 'lint');
  });
});
