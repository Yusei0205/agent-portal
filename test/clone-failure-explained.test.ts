import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainCloneFailure } from '../server/agent/repo-prep.ts';

const CC = 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/rhb.backend.shared';
const refused = "Could not clone rhb.backend.shared (git exited with code 128): fatal: unable to access '" + CC + "/': The requested URL returned error: 403";

test('a refused CodeCommit clone says the AWS keys need updating', () => {
  const p = explainCloneFailure(refused, [CC]);
  assert.equal(p?.kind, 'aws-keys');
  assert.equal(p?.fix, 'aws');
  assert.match(p!.text, /Workspaces → AWS/);
});

test('a refused clone on another host points at the repository sign-in', () => {
  const p = explainCloneFailure('fatal: Authentication failed for https://github.com/x/y.git', ['https://github.com/x/y.git']);
  assert.equal(p?.kind, 'git-access');
  assert.match(p!.text, /Workspaces → Repositories/);
});

test('other failures keep their own message', () => {
  assert.equal(explainCloneFailure('fatal: repository not found (404)', [CC]), null);
  assert.equal(explainCloneFailure('git exited with code 128, no space left on device', [CC]), null);
});
