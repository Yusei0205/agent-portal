/**
 * Branch list for a repository (feeds the branch dropdowns, e.g. New code review).
 *
 *   - parseLsRemoteHeads / orderBranches
 *   - GET /api/projects/:id/repos/:repoId/branches asks the remote (a real local git repository stands in
 *     for the host), puts the default branch first, caches briefly, and answers with an error text,
 *     not a failure, when the remote cannot be reached.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { parseLsRemoteHeads, orderBranches, _clearBranchListCache } from '../server/repos.ts';

describe('parseLsRemoteHeads / orderBranches', () => {
  it('reads branch names and ignores everything else', () => {
    const out = [
      'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\trefs/heads/main',
      'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678\trefs/heads/feature/RLP-12-fix',
      'c1b2c3d4e5f60718293a4b5c6d7e8f9012345678\trefs/tags/v1',
      'warning: something',
      '',
    ].join('\n');
    assert.deepEqual(parseLsRemoteHeads(out), ['main', 'feature/RLP-12-fix']);
  });

  it('puts the default branch first and sorts the rest', () => {
    assert.deepEqual(orderBranches(['zeta', 'main', 'alpha'], 'main'), ['main', 'alpha', 'zeta']);
  });

  it('does not invent a default branch the remote does not have', () => {
    assert.deepEqual(orderBranches(['b', 'a'], 'main'), ['a', 'b']);
    assert.deepEqual(orderBranches(['b', 'a'], null), ['a', 'b']);
  });
});

describe('GET /api/projects/:id/repos/:repoId/branches', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let remoteDir: string;
  let remoteUrl: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });

  before(async () => {
    // A small repository with three branches stands in for the git host.
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-branches-'));
    git(remoteDir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(remoteDir, 'a.txt'), 'a');
    git(remoteDir, 'add', '.');
    git(remoteDir, 'commit', '-q', '-m', 'init');
    git(remoteDir, 'branch', 'feature/RLP-1-first');
    git(remoteDir, 'branch', 'bugfix/RLP-2-second');
    remoteUrl = pathToFileURL(remoteDir).href;

    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: 'branch-admin@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    const login = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'branch-admin@example.com', password: 'password1234' },
    });
    cookie = login.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Branch Project' }, cookie });
    projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
  });

  after(async () => {
    await cleanup();
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  async function addRepo(name: string, url: string, defaultBranch: string): Promise<string> {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name, url, provider: 'git', defaultBranch },
      cookie,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return ((r.body as Record<string, unknown>).repo as Record<string, unknown>).id as string;
  }

  it('lists the remote branches, default first', async () => {
    _clearBranchListCache();
    const id = await addRepo('with-branches', remoteUrl, 'main');
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/${id}/branches`, { cookie });
    assert.equal(r.status, 200);
    const b = r.body as { branches: string[]; defaultBranch: string; source: string };
    assert.equal(b.source, 'remote');
    assert.equal(b.defaultBranch, 'main');
    assert.deepEqual(b.branches, ['main', 'bugfix/RLP-2-second', 'feature/RLP-1-first']);
  });

  it('serves a repeat call from the cache, and ?refresh=1 asks the remote again', async () => {
    _clearBranchListCache();
    const id = await addRepo('cached', remoteUrl, 'main');
    const url = `/api/projects/${projectId}/repos/${id}/branches`;
    const first = await fetchJson(baseUrl, url, { cookie });
    git(remoteDir, 'branch', 'feature/RLP-3-late');
    const second = await fetchJson(baseUrl, url, { cookie });
    assert.deepEqual((second.body as { branches: string[] }).branches, (first.body as { branches: string[] }).branches);
    const third = await fetchJson(baseUrl, `${url}?refresh=1`, { cookie });
    assert.ok((third.body as { branches: string[] }).branches.includes('feature/RLP-3-late'));
  });

  it('answers 200 with an error text when the remote cannot be reached', async () => {
    _clearBranchListCache();
    const id = await addRepo('unreachable', pathToFileURL(path.join(remoteDir, 'does-not-exist')).href, 'main');
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/${id}/branches`, { cookie });
    assert.equal(r.status, 200);
    const b = r.body as { branches: string[]; source: string; error?: string };
    assert.equal(b.source, 'none');
    assert.deepEqual(b.branches, []);
    assert.ok(b.error && b.error.length > 0);
  });

  it('is not available to people outside the project', async () => {
    const id = await addRepo('private', remoteUrl, 'main');
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/${id}/branches`, {});
    assert.equal(r.status, 401);
  });
});
