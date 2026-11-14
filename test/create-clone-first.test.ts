import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeDocPrompt } from '../server/generated-doc-text.ts';
import { runnerRepoFolder } from '../server/agent/runner-repo-specs.ts';
import { prepareReposBeforeRun } from '../server/agent/repo-prep.ts';

test('the prompt names the folder the runner clones into', () => {
  assert.equal(runnerRepoFolder('Payments API'), 'Payments_API');
  const goal = composeDocPrompt({ type: 'overview', title: 'T', audience: '', repos: [{ name: 'Payments API', slug: runnerRepoFolder('Payments API'), branch: 'main' }], knowledge: false, decisions: false, diagrams: [] });
  assert.match(goal, /repos\/Payments_API\//);
});

test('the description is added to the prompt only when given', () => {
  const base = { type: 'overview' as const, title: 'T', audience: '', repos: [], knowledge: false, decisions: false, diagrams: [] };
  assert.match(composeDocPrompt({ ...base, description: 'Focus on billing' }), /Context from the requester[^\n]*\nFocus on billing/);
  assert.doesNotMatch(composeDocPrompt(base), /Context from the requester/);
});

test('nothing to prepare for an unknown workflow', async () => {
  assert.equal(await prepareReposBeforeRun('w_missing').catch(() => null), null);
});
