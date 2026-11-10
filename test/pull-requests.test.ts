/**
 * Pull request creation on GitHub and CodeCommit. No network and no AWS: fetch and the CodeCommit client are stand-ins.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPullRequest, PullRequestError, _setPullRequestClients, type CodeCommitLike,
} from '../server/pull-requests.ts';
import type { Repository } from '../server/repos.ts';

function repo(over: Partial<Repository> = {}): Repository {
  return {
    id: 'r1', project_id: 'p1', name: 'shop', url: 'https://github.com/acme/shop', provider: 'github', status: 'ready',
    default_branch: 'main', identity: null, last_synced_at: null, last_error: null, created_at: '', connection_id: 'c1', ...over,
  };
}
const ccRepo = () => repo({ url: 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/shop-cc', provider: 'codecommit', name: 'shop-cc' });

interface Call { url: string; method: string; body: any; auth: string | null }
function fakeFetch(replies: Array<{ status: number; json?: unknown; text?: string }>, calls: Call[]): typeof fetch {
  let i = 0;
  return (async (url: any, init: any) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null, auth: init?.headers?.Authorization ?? null });
    const r = replies[Math.min(i++, replies.length - 1)];
    const text = r.text ?? JSON.stringify(r.json ?? {});
    return new Response(text, { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const ghCreds = async () => ({ kind: 'github' as const, token: 'tok-github-123' });
const ccCreds = async () => ({ kind: 'codecommit' as const, region: 'ap-southeast-1', accessKeyId: 'AKIAEXAMPLE0000000A', secretAccessKey: 'secret' });

function awsError(name: string, message = 'nope'): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/** A CodeCommit client stand-in: `handler` receives the command name and its input. */
function fakeCc(handler: (name: string, input: any) => unknown, sent: Array<{ name: string; input: any }> = []): CodeCommitLike {
  return {
    async send(cmd: any) {
      const name = cmd.constructor.name;
      sent.push({ name, input: cmd.input });
      const out = handler(name, cmd.input);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

afterEach(() => _setPullRequestClients());

describe('createPullRequest on GitHub', () => {
  let calls: Call[];
  beforeEach(() => { calls = []; });

  it('creates a pull request with the token and returns number and url', async () => {
    _setPullRequestClients({
      credentials: ghCreds,
      fetch: fakeFetch([{ status: 201, json: { number: 7, html_url: 'https://github.com/acme/shop/pull/7' } }], calls),
    });
    const pr = await createPullRequest({ repo: repo(), base: 'main', head: 'portal/RLP-1-fix', title: 'RLP-1: Fix it', body: 'Body' });
    assert.deepEqual(pr, { number: 7, url: 'https://github.com/acme/shop/pull/7', existing: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.github.com/repos/acme/shop/pulls');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].auth, 'Bearer tok-github-123');
    assert.deepEqual(calls[0].body, { title: 'RLP-1: Fix it', body: 'Body', head: 'portal/RLP-1-fix', base: 'main' });
  });

  it('reuses the open pull request when GitHub says one already exists (422)', async () => {
    _setPullRequestClients({
      credentials: ghCreds,
      fetch: fakeFetch([
        { status: 422, json: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:portal/x.' }] } },
        { status: 200, json: [{ number: 5, html_url: 'https://github.com/acme/shop/pull/5' }] },
      ], calls),
    });
    const pr = await createPullRequest({ repo: repo(), base: 'main', head: 'portal/x', title: 't', body: 'b' });
    assert.deepEqual(pr, { number: 5, url: 'https://github.com/acme/shop/pull/5', existing: true });
    assert.equal(calls[1].method, 'GET');
    assert.match(calls[1].url, /pulls\?state=open&head=acme%3Aportal%2Fx/);
  });

  for (const status of [401, 403, 404]) {
    it(`maps ${status} to no-permission`, async () => {
      _setPullRequestClients({ credentials: ghCreds, fetch: fakeFetch([{ status, json: { message: 'x' } }], calls) });
      await assert.rejects(
        createPullRequest({ repo: repo(), base: 'main', head: 'h', title: 't', body: 'b' }),
        (e: any) => e instanceof PullRequestError && e.code === 'no-permission' && /GitHub token needs repo write access/.test(e.message) && !/tok-github/.test(e.message),
      );
    });
  }

  it('is no-permission when the repository has no token', async () => {
    _setPullRequestClients({ credentials: async () => null, fetch: fakeFetch([], calls) });
    await assert.rejects(
      createPullRequest({ repo: repo(), base: 'main', head: 'h', title: 't', body: 'b' }),
      (e: any) => e.code === 'no-permission',
    );
    assert.equal(calls.length, 0);
  });

  it('maps another 422 to failed with the host message', async () => {
    _setPullRequestClients({
      credentials: ghCreds,
      fetch: fakeFetch([{ status: 422, json: { message: 'Validation Failed', errors: [{ message: 'No commits between main and h' }] } }], calls),
    });
    await assert.rejects(
      createPullRequest({ repo: repo(), base: 'main', head: 'h', title: 't', body: 'b' }),
      (e: any) => e.code === 'failed' && /No commits between/.test(e.message),
    );
  });

  it('cuts the title at 120 characters and scrubs secrets from the body', async () => {
    _setPullRequestClients({
      credentials: ghCreds,
      fetch: fakeFetch([{ status: 201, json: { number: 1, html_url: 'u' } }], calls),
    });
    const ghp = 'ghp_' + 'a'.repeat(36);
    await createPullRequest({
      repo: repo(), base: 'main', head: 'h', title: 'T'.repeat(300),
      body: `token ${ghp}\nkey AKIAABCDEFGHIJKLMNOP\nurl https://user:pw123@example.com/x\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\nok text`,
    });
    const sent = calls[0].body;
    assert.equal(Array.from(sent.title).length, 120);
    assert.ok(!sent.body.includes(ghp));
    assert.ok(!sent.body.includes('AKIAABCDEFGHIJKLMNOP'));
    assert.ok(!sent.body.includes('pw123'));
    assert.ok(!sent.body.includes('abcdefghijklmnopqrstuvwxyz'));
    assert.ok(sent.body.includes('ok text'));
  });

  it('cuts the body at 60,000 characters', async () => {
    _setPullRequestClients({ credentials: ghCreds, fetch: fakeFetch([{ status: 201, json: { number: 1, html_url: 'u' } }], calls) });
    await createPullRequest({ repo: repo(), base: 'main', head: 'h', title: 't', body: 'x'.repeat(100_000) });
    assert.equal(Array.from(calls[0].body.body as string).length, 60_000);
  });
});

describe('createPullRequest on CodeCommit', () => {
  it('creates a pull request and returns its console url', async () => {
    const sent: Array<{ name: string; input: any }> = [];
    _setPullRequestClients({
      credentials: ccCreds,
      codecommit: () => fakeCc((name) => (name === 'CreatePullRequestCommand' ? { pullRequest: { pullRequestId: '42' } } : {}), sent),
    });
    const pr = await createPullRequest({ repo: ccRepo(), base: 'main', head: 'portal/x', title: 'RLP-2: T', body: 'B' });
    assert.equal(pr.number, 42);
    assert.equal(pr.existing, false);
    assert.match(pr.url, /ap-southeast-1\.console\.aws\.amazon\.com\/codesuite\/codecommit\/repositories\/shop-cc\/pull-requests\/42/);
    assert.equal(sent[0].name, 'CreatePullRequestCommand');
    assert.deepEqual(sent[0].input.targets, [{ repositoryName: 'shop-cc', sourceReference: 'portal/x', destinationReference: 'main' }]);
    assert.equal(sent[0].input.title, 'RLP-2: T');
  });

  it('reuses the open pull request with the same source and destination', async () => {
    const sent: Array<{ name: string; input: any }> = [];
    _setPullRequestClients({
      credentials: ccCreds,
      codecommit: () => fakeCc((name, input) => {
        if (name === 'CreatePullRequestCommand') return awsError('PullRequestAlreadyExistsException');
        if (name === 'ListPullRequestsCommand') return { pullRequestIds: ['9', '11'] };
        if (name === 'GetPullRequestCommand') {
          const other = input.pullRequestId === '9';
          return { pullRequest: { pullRequestTargets: [{ sourceReference: other ? 'refs/heads/other' : 'refs/heads/portal/x', destinationReference: 'refs/heads/main' }] } };
        }
        return {};
      }, sent),
    });
    const pr = await createPullRequest({ repo: ccRepo(), base: 'main', head: 'portal/x', title: 't', body: 'b' });
    assert.equal(pr.number, 11);
    assert.equal(pr.existing, true);
    const list = sent.find((s) => s.name === 'ListPullRequestsCommand')!;
    assert.equal(list.input.repositoryName, 'shop-cc');
    assert.equal(list.input.pullRequestStatus, 'OPEN');
  });

  it('maps access denied to no-permission', async () => {
    _setPullRequestClients({
      credentials: ccCreds,
      codecommit: () => fakeCc(() => awsError('AccessDeniedException', 'not authorized to perform codecommit:CreatePullRequest')),
    });
    await assert.rejects(
      createPullRequest({ repo: ccRepo(), base: 'main', head: 'h', title: 't', body: 'b' }),
      (e: any) => e instanceof PullRequestError && e.code === 'no-permission' && /CreatePullRequest/.test(e.message),
    );
  });

  it('maps other errors to failed', async () => {
    _setPullRequestClients({
      credentials: ccCreds,
      codecommit: () => fakeCc(() => awsError('ReferenceDoesNotExistException', 'branch missing')),
    });
    await assert.rejects(
      createPullRequest({ repo: ccRepo(), base: 'main', head: 'h', title: 't', body: 'b' }),
      (e: any) => e.code === 'failed' && /branch missing/.test(e.message),
    );
  });

  it('is no-permission when no AWS credentials are found', async () => {
    _setPullRequestClients({ credentials: async () => null });
    await assert.rejects(
      createPullRequest({ repo: ccRepo(), base: 'main', head: 'h', title: 't', body: 'b' }),
      (e: any) => e.code === 'no-permission',
    );
  });

  it('scrubs secrets and keeps the description within the CodeCommit limit', async () => {
    const sent: Array<{ name: string; input: any }> = [];
    _setPullRequestClients({
      credentials: ccCreds,
      codecommit: () => fakeCc(() => ({ pullRequest: { pullRequestId: '1' } }), sent),
    });
    await createPullRequest({
      repo: ccRepo(), base: 'main', head: 'h', title: 't',
      body: 'AKIAABCDEFGHIJKLMNOP\n' + 'y'.repeat(20_000),
    });
    const d = sent[0].input.description as string;
    assert.ok(!d.includes('AKIAABCDEFGHIJKLMNOP'));
    assert.ok(Array.from(d).length <= 10_000);
  });
});

describe('createPullRequest on other hosts', () => {
  it('refuses Bitbucket and plain git with unsupported', async () => {
    for (const r of [
      repo({ url: 'https://bitbucket.org/acme/shop', provider: 'bitbucket' }),
      repo({ url: 'https://git.example.com/acme/shop.git', provider: 'git' }),
    ]) {
      await assert.rejects(
        createPullRequest({ repo: r, base: 'main', head: 'h', title: 't', body: 'b' }),
        (e: any) => e instanceof PullRequestError && e.code === 'unsupported',
      );
    }
  });
});
