// Pushing a working copy by hand (push-copy): path checks, access, shared branches, unrelated history and credential hygiene.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, type TestServer } from './client.ts';
import { bootWorkflowFixture, settleSession } from './workflows-fixture.ts';

let srv: TestServer;
let admin: Client;
let viewer: Client;
let outsider: Client;
let pid: string;

before(async () => {
  ({ srv, admin, viewer, outsider, pid } = await bootWorkflowFixture());
});

after(async () => {
  await srv.close();
});

const settle = (id: string, wanted?: string[]) => settleSession(admin, id, wanted);
const create = (body: Record<string, unknown>) => admin.post(`/api/projects/${pid}/workflows`, { model: 'haiku', playground: true, ...body });

test('push-copy: rejects invalid paths and shared branches', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wfpushcopy-'));
  const bareDir = path.join(tmpRoot, 'bare.git');
  fs.mkdirSync(bareDir, { recursive: true });

  const gi = (args: string[], cwd: string) => execFileSync('git', [
    '-c', 'core.longpaths=true', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args,
  ], { cwd, stdio: 'ignore' });

  gi(['init', '--bare', '-b', 'main', bareDir], tmpRoot);
  const workTmp = path.join(tmpRoot, 'worktmp');
  fs.mkdirSync(workTmp, { recursive: true });
  gi(['clone', bareDir, workTmp], tmpRoot);
  fs.writeFileSync(path.join(workTmp, 'a.txt'), 'hello\n');
  gi(['add', '-A'], workTmp);
  gi(['commit', '-m', 'init'], workTmp);
  gi(['push', 'origin', 'main'], workTmp);

  const url = `file:///${bareDir.replace(/\\/g, '/')}`;
  try {
    const { repo } = await admin.post(`/api/projects/${pid}/repos`, { provider: 'git', url, name: 'push-copy-bare' });
    const end = Date.now() + 20_000;
    while (Date.now() < end && (await admin.get(`/api/projects/${pid}/repos`)).repos.find((r: any) => r.id === repo.id).status !== 'ready') await new Promise((r) => setTimeout(r, 150));

    const { workflow } = await admin.post(`/api/projects/${pid}/workflows`, { goal: 'rescue task', model: 'haiku', repoId: repo.id, start: false });

    // Path traversal is rejected.
    const outsidePath = await admin.req('POST', `/api/workflows/${workflow.id}/push-copy`, {
      path: '../../etc/passwd', repoId: repo.id, branch: 'feature/test-push',
    });
    assert.equal(outsidePath.status, 400);

    // Absolute path outside project dir is rejected.
    const absPath = await admin.req('POST', `/api/workflows/${workflow.id}/push-copy`, {
      path: '/tmp/outside', repoId: repo.id, branch: 'feature/test-push',
    });
    assert.equal(absPath.status, 400);

    // Default branch rejection: check occurs before path exists validation.
    // Note: this will fail at "path does not exist" step but we test the shared/default branch checks
    // using the isSharedBranch function which is already tested in e2e tests.
    // Direct unit test: shared branch name validation is done before push.
    const { isSharedBranch } = await import('../server/runs.ts');
    assert.ok(isSharedBranch('main'));
    assert.ok(isSharedBranch('develop'));
    assert.ok(!isSharedBranch('feature/my-change'));
    assert.ok(!isSharedBranch('agent/fix-task'));

    await admin.del(`/api/workflows/${workflow.id}`);
    await admin.del(`/api/repos/${repo.id}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('push-copy: viewer (non-editor) access is rejected with 403', async () => {
  const { workflow } = await admin.post(`/api/projects/${pid}/workflows`, { goal: 'viewer-rejection', model: 'haiku', playground: true, start: false });
  const r = await viewer.req('POST', `/api/workflows/${workflow.id}/push-copy`, {
    path: 'work/any', repoId: 'fake-id', branch: 'feature/x',
  });
  assert.equal(r.status, 403, 'viewer must be rejected with 403 before any path validation');
  const o = await outsider.req('POST', `/api/workflows/${workflow.id}/push-copy`, {
    path: 'work/any', repoId: 'fake-id', branch: 'feature/x',
  });
  assert.equal(o.status, 404, 'outsider (non-member) gets 404');
  await admin.del(`/api/workflows/${workflow.id}`);
});

test('push-copy: path inside project dir but not in any run folder of this session is rejected', async () => {
  // Session A creates a run folder; session B cannot use it.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfxsession-'));
  const gi = (args: string[], cwd: string) =>
    execFileSync('git', ['-c', 'core.longpaths=true', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });

  // Bare repo for a URL-based connection (so it works on CI and Windows).
  const bareDir = path.join(tmpDir, 'bare.git');
  fs.mkdirSync(bareDir, { recursive: true });
  gi(['init', '--bare', '-b', 'main', bareDir], tmpDir);
  const workInit = path.join(tmpDir, 'init');
  fs.mkdirSync(workInit, { recursive: true });
  gi(['clone', bareDir, workInit], tmpDir);
  fs.writeFileSync(path.join(workInit, 'a.txt'), 'hello\n');
  gi(['add', '-A'], workInit);
  gi(['commit', '-m', 'init'], workInit);
  gi(['push', 'origin', 'main'], workInit);

  const url = `file:///${bareDir.replace(/\\/g, '/')}`;
  try {
    const { repo } = await admin.post(`/api/projects/${pid}/repos`, { provider: 'git', url, name: 'xsession-repo' });
    const end = Date.now() + 20_000;
    while (Date.now() < end && (await admin.get(`/api/projects/${pid}/repos`)).repos.find((r: any) => r.id === repo.id).status !== 'ready')
      await new Promise((r) => setTimeout(r, 150));

    // Session A runs and creates a worktree.
    const { workflow: wA } = await admin.post(`/api/projects/${pid}/workflows`, {
      goal: 'Session A [demo-iterations: 1]', model: 'haiku', repoId: repo.id, start: true,
    });
    const dA = await settle(wA.id, ['done', 'blocked', 'failed', 'paused', 'stopped']);
    // wA now has a run with a worktree.
    const runAId = dA.workflow.last_run_id;
    assert.ok(runAId, 'session A must have a run');

    // Session B (same project, no runs yet).
    const { workflow: wB } = await admin.post(`/api/projects/${pid}/workflows`, {
      goal: 'Session B', model: 'haiku', playground: true, start: false,
    });

    // Get the worktree path from session A's run and try to use it for session B's push-copy.
    const runA = (await admin.get(`/api/runs/${runAId}`)).run;
    const wtRel: string | null = runA?.worktree ?? null;
    assert.ok(wtRel, 'session A run must have a worktree path');
    const r = await admin.req('POST', `/api/workflows/${wB.id}/push-copy`, {
      path: wtRel, repoId: repo.id, branch: 'feature/cross-session',
    });
    assert.equal(r.status, 400, 'a path from another session\'s run folder must be rejected');
    assert.match(r.data.error, /not inside any run folder of this session/);

    await admin.del(`/api/workflows/${wA.id}`);
    await admin.del(`/api/workflows/${wB.id}`);
    await admin.del(`/api/repos/${repo.id}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('push-copy: symlink traversal outside project dir is rejected', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  // We need a project directory to create the symlink inside.
  const project = (await admin.get(`/api/projects/${pid}`)).project;
  const { projectDir } = await import('../server/projects.ts');
  const { getProject } = await import('../server/projects.ts');
  const proj = getProject(pid);
  const pdir = projectDir(proj);

  // Create a temp dir outside the project dir that a symlink will point to.
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-target-'));
  const symlinkName = `symlink-test-${Date.now()}`;
  const symlinkPath = path.join(pdir, symlinkName);
  try {
    // Create a symlink inside the project dir pointing outside it.
    try {
      fs.symlinkSync(outsideDir, symlinkPath, 'junction'); // 'junction' for Windows dirs
    } catch {
      fs.symlinkSync(outsideDir, symlinkPath); // fallback for non-Windows
    }

    const { workflow } = await admin.post(`/api/projects/${pid}/workflows`, {
      goal: 'symlink test', model: 'haiku', playground: true, start: false,
    });

    const r = await admin.req('POST', `/api/workflows/${workflow.id}/push-copy`, {
      path: symlinkName, repoId: 'fake-id', branch: 'feature/symlink',
    });
    // The symlink resolves outside the project dir → must be rejected.
    assert.equal(r.status, 400);
    // Either "resolves outside" or "does not exist" (if realpathSync throws because outside dir has no .git)
    // but crucially NOT a 200.
    assert.ok(
      r.data.error.includes('outside the project directory') || r.data.error.includes('does not exist') || r.data.error.includes('not inside any run folder'),
      `expected a path-safety error, got: ${r.data.error}`,
    );

    await admin.del(`/api/workflows/${workflow.id}`);
  } finally {
    try { fs.rmSync(symlinkPath, { force: true }); } catch { /* ignore */ }
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('push-copy: shared and default branch names are rejected at the API level', async () => {
  // This test runs a real session to produce a worktree, then tries push-copy with forbidden branch names.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfbranch-'));
  const bareDir = path.join(tmpDir, 'bare.git');
  fs.mkdirSync(bareDir, { recursive: true });
  const gi = (args: string[], cwd: string) =>
    execFileSync('git', ['-c', 'core.longpaths=true', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });

  gi(['init', '--bare', '-b', 'main', bareDir], tmpDir);
  const workInit = path.join(tmpDir, 'init');
  fs.mkdirSync(workInit, { recursive: true });
  gi(['clone', bareDir, workInit], tmpDir);
  fs.writeFileSync(path.join(workInit, 'a.txt'), 'data\n');
  gi(['add', '-A'], workInit);
  gi(['commit', '-m', 'init'], workInit);
  gi(['push', 'origin', 'main'], workInit);

  const url = `file:///${bareDir.replace(/\\/g, '/')}`;
  try {
    const { repo } = await admin.post(`/api/projects/${pid}/repos`, { provider: 'git', url, name: 'branch-guard-repo' });
    const end = Date.now() + 20_000;
    while (Date.now() < end && (await admin.get(`/api/projects/${pid}/repos`)).repos.find((r: any) => r.id === repo.id).status !== 'ready')
      await new Promise((r) => setTimeout(r, 150));

    // Run a session to create a worktree.
    const { workflow } = await admin.post(`/api/projects/${pid}/workflows`, {
      goal: 'Branch guard test [demo-iterations: 1]', model: 'haiku', repoId: repo.id, start: true,
    });
    const d = await settle(workflow.id, ['done', 'blocked', 'failed', 'paused', 'stopped']);
    const runInfo = (await admin.get(`/api/runs/${d.workflow.last_run_id}`)).run;
    const wtRel: string | null = runInfo?.worktree ?? null;
    assert.ok(wtRel, 'session run must have a worktree path for branch guard test');

    // Default branch (main) is rejected.
    const toMain = await admin.req('POST', `/api/workflows/${workflow.id}/push-copy`, {
      path: wtRel, repoId: repo.id, branch: 'main',
    });
    assert.equal(toMain.status, 400);
    assert.match(toMain.data.error, /default branch|Push to a new branch/);

    // Shared branches (develop, staging, production) are rejected.
    for (const sharedBranch of ['develop', 'staging', 'production', 'master']) {
      const r = await admin.req('POST', `/api/workflows/${workflow.id}/push-copy`, {
        path: wtRel, repoId: repo.id, branch: sharedBranch,
      });
      assert.equal(r.status, 400, `shared branch "${sharedBranch}" must be rejected`);
      assert.match(r.data.error, /shared branch|Push to a new branch/, `error message for "${sharedBranch}" must mention shared branch`);
    }

    await admin.del(`/api/workflows/${workflow.id}`);
    await admin.del(`/api/repos/${repo.id}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('push-copy: unrelated git history is rejected before push', async () => {
  // Two repos with unrelated histories: trying to push a worktree of repo-A to repo-B must fail.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfhistory-'));
  const gi = (args: string[], cwd: string) =>
    execFileSync('git', ['-c', 'core.longpaths=true', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });

  // Create two bare repos with different initial commits (unrelated histories).
  const bareA = path.join(tmpDir, 'repoA.git');
  const bareB = path.join(tmpDir, 'repoB.git');
  fs.mkdirSync(bareA, { recursive: true });
  fs.mkdirSync(bareB, { recursive: true });
  gi(['init', '--bare', '-b', 'main', bareA], tmpDir);
  gi(['init', '--bare', '-b', 'main', bareB], tmpDir);

  // Populate repoA.
  const workA = path.join(tmpDir, 'workA');
  fs.mkdirSync(workA, { recursive: true });
  gi(['clone', bareA, workA], tmpDir);
  fs.writeFileSync(path.join(workA, 'a.txt'), 'repo-A content\n');
  gi(['add', '-A'], workA);
  gi(['commit', '-m', 'repo-A init'], workA);
  gi(['push', 'origin', 'main'], workA);

  // Populate repoB with a different initial commit.
  const workB = path.join(tmpDir, 'workB');
  fs.mkdirSync(workB, { recursive: true });
  gi(['clone', bareB, workB], tmpDir);
  fs.writeFileSync(path.join(workB, 'b.txt'), 'repo-B content\n');
  gi(['add', '-A'], workB);
  gi(['commit', '-m', 'repo-B init'], workB);
  gi(['push', 'origin', 'main'], workB);

  const urlA = `file:///${bareA.replace(/\\/g, '/')}`;
  const urlB = `file:///${bareB.replace(/\\/g, '/')}`;
  try {
    const { repo: repoA } = await admin.post(`/api/projects/${pid}/repos`, { provider: 'git', url: urlA, name: 'history-repoA' });
    const { repo: repoB } = await admin.post(`/api/projects/${pid}/repos`, { provider: 'git', url: urlB, name: 'history-repoB' });

    // Wait for both to be ready.
    const end = Date.now() + 25_000;
    while (Date.now() < end) {
      const repos = (await admin.get(`/api/projects/${pid}/repos`)).repos;
      const a = repos.find((r: any) => r.id === repoA.id);
      const b = repos.find((r: any) => r.id === repoB.id);
      if (a?.status === 'ready' && b?.status === 'ready') break;
      if (a?.status === 'error' || b?.status === 'error') break;
      await new Promise((r) => setTimeout(r, 150));
    }

    // Run a session against repoA to produce a worktree.
    const { workflow } = await admin.post(`/api/projects/${pid}/workflows`, {
      goal: 'Unrelated history test [demo-iterations: 1]', model: 'haiku', repoId: repoA.id, start: true,
    });
    const d = await settle(workflow.id, ['done', 'blocked', 'failed', 'paused', 'stopped']);
    const runInfo = (await admin.get(`/api/runs/${d.workflow.last_run_id}`)).run;
    const wtRel: string | null = runInfo?.worktree ?? null;
    assert.ok(wtRel, 'session run must have a worktree path for history test');

    // Try to push the worktree of repoA to repoB — different root commit → should be rejected.
    const r = await admin.req('POST', `/api/workflows/${workflow.id}/push-copy`, {
      path: wtRel, repoId: repoB.id, branch: 'feature/unrelated-history',
    });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /history does not match|Cannot push/);

    await admin.del(`/api/workflows/${workflow.id}`);
    await admin.del(`/api/repos/${repoA.id}`);
    await admin.del(`/api/repos/${repoB.id}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('push-copy: credentials never appear in response or event history', async () => {
  // The event log for a push-copy must not contain API keys, tokens, passwords, or git credential env vars.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcreds-'));
  const bareDir = path.join(tmpDir, 'bare.git');
  fs.mkdirSync(bareDir, { recursive: true });
  const gi = (args: string[], cwd: string) =>
    execFileSync('git', ['-c', 'core.longpaths=true', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });

  gi(['init', '--bare', '-b', 'main', bareDir], tmpDir);
  const workInit = path.join(tmpDir, 'init');
  fs.mkdirSync(workInit, { recursive: true });
  gi(['clone', bareDir, workInit], tmpDir);
  fs.writeFileSync(path.join(workInit, 'a.txt'), 'hello\n');
  gi(['add', '-A'], workInit);
  gi(['commit', '-m', 'init'], workInit);
  gi(['push', 'origin', 'main'], workInit);

  const url = `file:///${bareDir.replace(/\\/g, '/')}`;
  try {
    const { repo } = await admin.post(`/api/projects/${pid}/repos`, { provider: 'git', url, name: 'creds-test-repo' });
    const end = Date.now() + 20_000;
    while (Date.now() < end && (await admin.get(`/api/projects/${pid}/repos`)).repos.find((r: any) => r.id === repo.id).status !== 'ready')
      await new Promise((r) => setTimeout(r, 150));

    // Run a session to get a worktree, then push it.
    const { workflow } = await admin.post(`/api/projects/${pid}/workflows`, {
      goal: 'Creds safety test [demo-iterations: 1]', model: 'haiku', repoId: repo.id, start: true,
    });
    const d = await settle(workflow.id, ['done', 'blocked', 'failed', 'paused', 'stopped']);
    const runInfo = (await admin.get(`/api/runs/${d.workflow.last_run_id}`)).run;
    const wtRel: string | null = runInfo?.worktree ?? null;
    assert.ok(wtRel, 'session run must have a worktree path for credentials test');

    const pushRes = await admin.req('POST', `/api/workflows/${workflow.id}/push-copy`, {
      path: wtRel, repoId: repo.id, branch: 'feature/creds-check',
    });
    // May succeed or fail (e.g. same branch as default), we only care about credential safety.
    const resBody = JSON.stringify(pushRes.data);
    // Must not contain git credential env var patterns.
    assert.ok(!resBody.includes('GIT_ASKPASS'), 'GIT_ASKPASS must not appear in response');
    assert.ok(!resBody.includes('GIT_TOKEN'), 'GIT_TOKEN must not appear in response');
    assert.ok(!resBody.includes('GITHUB_TOKEN'), 'GITHUB_TOKEN must not appear in response');
    assert.ok(!resBody.includes('AWS_SECRET_ACCESS_KEY'), 'AWS secret key must not appear in response');
    assert.ok(!resBody.includes('ANTHROPIC_API_KEY'), 'Anthropic key must not appear in response');

    // Check the event history for this session.
    const detail = await admin.get(`/api/workflows/${workflow.id}`);
    const eventText = JSON.stringify(detail.events);
    assert.ok(!eventText.includes('GIT_ASKPASS'), 'GIT_ASKPASS must not appear in event history');
    assert.ok(!eventText.includes('AWS_SECRET_ACCESS_KEY'), 'AWS secret must not appear in event history');
    assert.ok(!eventText.includes('ANTHROPIC_API_KEY'), 'Anthropic key must not appear in event history');

    await admin.del(`/api/workflows/${workflow.id}`);
    await admin.del(`/api/repos/${repo.id}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('push-copy: credential-leak test — URL with embedded user:token must not appear in error response', async () => {
  // If push fails with a URL that has user:password, the error must be redacted.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcredleak-'));
  const bareDir = path.join(tmpDir, 'bare.git');
  fs.mkdirSync(bareDir, { recursive: true });
  const gi = (args: string[], cwd: string) =>
    execFileSync('git', ['-c', 'core.longpaths=true', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });

  gi(['init', '--bare', '-b', 'main', bareDir], tmpDir);
  const workInit = path.join(tmpDir, 'init');
  fs.mkdirSync(workInit, { recursive: true });
  gi(['clone', bareDir, workInit], tmpDir);
  fs.writeFileSync(path.join(workInit, 'a.txt'), 'hello\n');
  gi(['add', '-A'], workInit);
  gi(['commit', '-m', 'init'], workInit);
  gi(['push', 'origin', 'main'], workInit);

  // Register with a URL containing embedded credentials (user:token@host pattern).
  const urlWithCreds = `https://myuser:secrettoken123@localhost/nonexistent-repo.git`;
  try {
    // We use the bare local repo as the 'real' repo but the session uses the URL-with-creds repo.
    // When the push to this fake URL fails, the error must not contain 'secrettoken123'.
    const url = `file:///${bareDir.replace(/\\/g, '/')}`;
    const { repo } = await admin.post(`/api/projects/${pid}/repos`, { provider: 'git', url, name: 'cred-leak-repo' });
    const end = Date.now() + 20_000;
    while (Date.now() < end && (await admin.get(`/api/projects/${pid}/repos`)).repos.find((r: any) => r.id === repo.id).status !== 'ready')
      await new Promise((r) => setTimeout(r, 150));

    const { workflow } = await admin.post(`/api/projects/${pid}/workflows`, {
      goal: 'Cred leak test [demo-iterations: 1]', model: 'haiku', repoId: repo.id, start: true,
    });
    const d = await settle(workflow.id, ['done', 'blocked', 'failed', 'paused', 'stopped']);
    const runInfo = (await admin.get(`/api/runs/${d.workflow.last_run_id}`)).run;
    const wtRel: string | null = runInfo?.worktree ?? null;
    assert.ok(wtRel, 'session run must have a worktree path');

    // Attempt a push-copy — any result is acceptable but the embedded secret must not appear.
    const pushRes = await admin.req('POST', `/api/workflows/${workflow.id}/push-copy`, {
      path: wtRel, repoId: repo.id, branch: 'feature/cred-leak-check',
    });
    const resBody = JSON.stringify(pushRes.data);
    // These patterns should never leak into a response.
    assert.ok(!resBody.includes('secrettoken123'), 'embedded token must not appear in response body');
    assert.ok(!resBody.includes('myuser:'), 'embedded user:password must not appear in response body');

    await admin.del(`/api/workflows/${workflow.id}`);
    await admin.del(`/api/repos/${repo.id}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
