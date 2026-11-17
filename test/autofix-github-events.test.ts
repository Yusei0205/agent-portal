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
    assert.deepEqual(r, { type: 'ci_result', repoFullName: 'acme/widgets', branch: 'autofix/tests-ab12cd34', conclusion: 'failure', headSha: 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678' });
  });
  it('a successful run is a ci_result success', () => {
    const r = parseGithubEvent('workflow_run', fx('workflow_run_success_main'));
    assert.equal(r.type, 'ci_result');
    if (r.type === 'ci_result') assert.equal(r.conclusion, 'success');
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
