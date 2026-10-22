/**
 * CodeCommit pull requests: address parsing, opening a pull request, reusing an open one, error mapping, and the
 * session status line's "base". AWS SDK calls go through setCodeCommitClientFactory; no network.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, type TestServer } from './client.ts';

type AnyCmd = { constructor: { name: string }; input?: any };

let srv: TestServer;
let cc: typeof import('../server/codecommit.ts');
let guard: typeof import('../server/guardrails.ts');

before(async () => {
  srv = await bootServer();
  cc = await import('../server/codecommit.ts');
  guard = await import('../server/guardrails.ts');
});
after(() => srv.close());

const fake = (handler: (cmd: AnyCmd) => Promise<any>, seen: { region?: string; creds?: any } = {}) =>
  cc.setCodeCommitClientFactory((region, creds) => {
    seen.region = region;
    seen.creds = creds;
    return { send: handler } as any;
  });

describe('codeCommitTarget', () => {
  test('HTTPS address gives name and region', () => {
    assert.deepEqual(cc.codeCommitTarget('https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/rhb.lad.adminportal.frontend'), {
      repositoryName: 'rhb.lad.adminportal.frontend',
      region: 'ap-southeast-1',
    });
  });
  test('codecommit://profile@repo gives name and profile', () => {
    assert.deepEqual(cc.codeCommitTarget('codecommit://474189600089_Admin@rhb.backend.shared'), {
      repositoryName: 'rhb.backend.shared',
      region: undefined,
      profile: '474189600089_Admin',
    });
  });
  test('codecommit::region://repo gives region', () => {
    assert.equal(cc.codeCommitTarget('codecommit::us-east-1://my-repo')?.region, 'us-east-1');
  });
  test('other addresses are not CodeCommit', () => {
    assert.equal(cc.codeCommitTarget('https://github.com/a/b'), null);
  });
});

describe('openCodeCommitPullRequest', () => {
  const input = { title: 'RLP-1: fix', description: 'body', source: 'fix/rlp-1', destination: 'dev-sg' };

  test('creates a pull request from the branch into the base and returns the console address', async () => {
    let created: any = null;
    fake(async (cmd) => {
      if (cmd.constructor.name === 'ListPullRequestsCommand') return { pullRequestIds: [] };
      if (cmd.constructor.name === 'CreatePullRequestCommand') {
        created = cmd.input;
        return { pullRequest: { pullRequestId: '42' } };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    const pr = await cc.openCodeCommitPullRequest('ap-southeast-1', { profile: 'p' }, 'rhb.backend.shared', input);
    assert.deepEqual(created.targets, [{ repositoryName: 'rhb.backend.shared', sourceReference: 'refs/heads/fix/rlp-1', destinationReference: 'refs/heads/dev-sg' }]);
    assert.equal(created.title, 'RLP-1: fix');
    assert.equal(pr.number, 42);
    assert.equal(pr.existing, false);
    assert.match(pr.url, /ap-southeast-1\.console\.aws\.amazon\.com\/codesuite\/codecommit\/repositories\/rhb\.backend\.shared\/pull-requests\/42\/details/);
  });

  test('returns the open pull request between the same branches instead of a duplicate', async () => {
    let creates = 0;
    fake(async (cmd) => {
      const n = cmd.constructor.name;
      if (n === 'ListPullRequestsCommand') return { pullRequestIds: ['7', '9'] };
      if (n === 'GetPullRequestCommand') {
        const other = cmd.input.pullRequestId === '7';
        return {
          pullRequest: {
            pullRequestTargets: [
              { repositoryName: 'repo', sourceReference: other ? 'refs/heads/other' : 'refs/heads/fix/rlp-1', destinationReference: 'refs/heads/dev-sg' },
            ],
          },
        };
      }
      if (n === 'CreatePullRequestCommand') creates++;
      return {};
    });
    const pr = await cc.openCodeCommitPullRequest('ap-southeast-1', {}, 'repo', input);
    assert.equal(pr.number, 9);
    assert.equal(pr.existing, true);
    assert.equal(creates, 0);
  });

  test('still creates when listing pull requests is not allowed', async () => {
    fake(async (cmd) => {
      if (cmd.constructor.name === 'ListPullRequestsCommand') throw Object.assign(new Error('no'), { name: 'AccessDeniedException' });
      return { pullRequest: { pullRequestId: '3' } };
    });
    assert.equal((await cc.openCodeCommitPullRequest('ap-southeast-1', {}, 'repo', input)).number, 3);
  });

  test('access denied on create explains the missing permission', async () => {
    fake(async (cmd) => {
      if (cmd.constructor.name === 'ListPullRequestsCommand') return { pullRequestIds: [] };
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    });
    await assert.rejects(cc.openCodeCommitPullRequest('ap-southeast-1', {}, 'repo', input), /codecommit:CreatePullRequest/);
  });

  test('a missing branch is named', async () => {
    fake(async (cmd) => {
      if (cmd.constructor.name === 'ListPullRequestsCommand') return { pullRequestIds: [] };
      throw Object.assign(new Error('x'), { name: 'ReferenceDoesNotExistException' });
    });
    await assert.rejects(cc.openCodeCommitPullRequest('ap-southeast-1', {}, 'repo', input), /"fix\/rlp-1" or "dev-sg"/);
  });
});

describe('listing and reading CodeCommit pull requests (code review)', () => {
  const target = (id: string, src: string, dst: string, repo = 'repo') => ({
    pullRequest: { title: `PR ${id}`, pullRequestTargets: [{ repositoryName: repo, sourceReference: `refs/heads/${src}`, destinationReference: `refs/heads/${dst}`, sourceCommit: `sha${id}` }] },
  });

  test('open pull requests come back newest first with branches and commit', async () => {
    fake(async (cmd) => {
      if (cmd.constructor.name === 'ListPullRequestsCommand') return { pullRequestIds: ['3', '12'] };
      if (cmd.constructor.name === 'GetPullRequestCommand') return target(cmd.input.pullRequestId, `fix/${cmd.input.pullRequestId}`, 'dev-sg');
      throw new Error(cmd.constructor.name);
    });
    const pulls = await cc.listCodeCommitPullRequests('ap-southeast-1', {}, 'repo');
    assert.deepEqual(pulls, [
      { number: 12, title: 'PR 12', head: 'fix/12', base: 'dev-sg', sha: 'sha12' },
      { number: 3, title: 'PR 3', head: 'fix/3', base: 'dev-sg', sha: 'sha3' },
    ]);
  });

  test('one pull request by number', async () => {
    fake(async () => target('42', 'fix/rlp-2683', 'dev-sg'));
    const p = await cc.getCodeCommitPullRequest('ap-southeast-1', {}, 'repo', 42);
    assert.equal(p.head, 'fix/rlp-2683');
    assert.equal(p.base, 'dev-sg');
  });

  test('a pull request of another repository or a missing one is refused', async () => {
    fake(async () => target('5', 'a', 'b', 'other-repo'));
    await assert.rejects(cc.getCodeCommitPullRequest('ap-southeast-1', {}, 'repo', 5), /not for repo/);
    fake(async () => {
      throw Object.assign(new Error('x'), { name: 'PullRequestDoesNotExistException' });
    });
    await assert.rejects(cc.getCodeCommitPullRequest('ap-southeast-1', {}, 'repo', 9), /no pull request #9/);
  });

  test('missing read permission names it', async () => {
    fake(async () => {
      throw Object.assign(new Error('x'), { name: 'AccessDeniedException' });
    });
    await assert.rejects(cc.listCodeCommitPullRequests('ap-southeast-1', {}, 'repo'), /codecommit:ListPullRequests/);
  });
});

describe('status line push base', () => {
  test('base is read when given and left out otherwise', () => {
    assert.deepEqual(guard.parseStatus('WORKFLOW_STATUS {"state":"done","summary":"s","push":{"message":"Fix","pr":true,"base":"dev-sg"}}')?.push, {
      message: 'Fix',
      pr: true,
      base: 'dev-sg',
    });
    assert.deepEqual(guard.parseStatus('WORKFLOW_STATUS {"state":"done","summary":"s","push":{"message":"Fix","pr":true}}')?.push, { message: 'Fix', pr: true });
  });
});
