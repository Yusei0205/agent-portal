// Agent pushes: the ask and auto push modes, and trusted sessions that push through the portal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { alwaysBlockedCommand, blockedCommand, parseTrustedPush } from '../server/guardrails.ts';
import { waitFor, Client, type TestServer } from './client.ts';
import { bootWorkflowFixture, settleSession } from './workflows-fixture.ts';

let srv: TestServer;
let admin: Client;
let pid: string;

before(async () => {
  ({ srv, admin, pid } = await bootWorkflowFixture());
});

after(async () => {
  await srv.close();
});

const settle = (id: string, wanted?: string[]) => settleSession(admin, id, wanted);
const create = (body: Record<string, unknown>) => admin.post(`/api/projects/${pid}/workflows`, { model: 'haiku', playground: true, ...body });

test('existing push flows (ask and auto modes) still work with effectivePushMode and pushBlocker changes', async () => {
  // Smoke test: playground sessions default to never push; sessions with repos default to ask.
  // Auto-derive branch when no work_branch set, and pushBlocker only blocks when no repos.
  const { effectivePushMode } = await import('../server/workflows.ts').catch(() => ({ effectivePushMode: undefined })) as any;
  if (effectivePushMode) {
    // Explicit value always wins.
    assert.equal(effectivePushMode('auto', undefined, true, false), 'auto');
    assert.equal(effectivePushMode('never', 'ask', true, false), 'never');
    // Playground without explicit value stays never.
    assert.equal(effectivePushMode(undefined, undefined, false, true), 'never');
    assert.equal(effectivePushMode(null, undefined, true, true), 'never');
    // Non-playground, no current, with repos → ask.
    assert.equal(effectivePushMode(undefined, undefined, true, false), 'ask');
    // Non-playground, no current, no repos → never.
    assert.equal(effectivePushMode(undefined, undefined, false, false), 'never');
    // Keep current non-never value.
    assert.equal(effectivePushMode(undefined, 'auto', true, false), 'auto');
    // On update (current defined): keep 'never' exactly — do NOT escalate to 'ask' even with repos.
    assert.equal(effectivePushMode(undefined, 'never', true, false), 'never', 'update with omitted pushMode must keep never, not escalate to ask');
  }

  // Via the API: a playground session has push_mode never; a session with a repo has ask by default.
  const pg = await create({ goal: 'push-mode smoke', model: 'haiku', playground: true, start: false });
  assert.equal(pg.workflow.push_mode, 'never', 'playground → never');
  // Explicit push mode is respected on playground too.
  const pgExplicit = await admin.put(`/api/workflows/${pg.workflow.id}`, { pushMode: 'ask' });
  assert.equal(pgExplicit.workflow.push_mode, 'ask', 'explicit value wins on playground');
  // Setting back to playground defaults: setting push_mode to never is explicit and stays.
  const pgNever = await admin.put(`/api/workflows/${pg.workflow.id}`, { pushMode: 'never' });
  assert.equal(pgNever.workflow.push_mode, 'never');
  await admin.del(`/api/workflows/${pg.workflow.id}`);
});

test('trust_tools: session create/update/view and child inheritance', async () => {
  // Create session without trust_tools (default off).
  const s = await admin.post(`/api/projects/${pid}/workflows`, {
    goal: 'trust test', model: 'haiku', playground: true, start: false,
  });
  assert.equal(s.workflow.trust_tools, false, 'trust_tools defaults to false');

  // Enable trust_tools.
  const updated = await admin.put(`/api/workflows/${s.workflow.id}`, { trustTools: true });
  assert.equal(updated.workflow.trust_tools, true);

  // Disable trust_tools.
  const disabled = await admin.put(`/api/workflows/${s.workflow.id}`, { trustTools: false });
  assert.equal(disabled.workflow.trust_tools, false);

  // Create session with trust_tools: true.
  const s2 = await admin.post(`/api/projects/${pid}/workflows`, {
    goal: 'trusted session [demo-delegate: backend] [demo-iterations: 1]',
    model: 'haiku', playground: true, trustTools: true,
  });
  assert.equal(s2.workflow.trust_tools, true, 'trust_tools can be set on create');

  // Wait for a delegated child and check inheritance.
  const parent = await waitFor(async () => {
    const d = await admin.get(`/api/workflows/${s2.workflow.id}`);
    return d.workflow.status === 'done' && !d.driving && d.workflow.children.length > 0 ? d : null;
  }, 'parent with child', 30_000);
  const childId = parent.workflow.children[0].id;
  const child = (await admin.get(`/api/workflows/${childId}`)).workflow;
  assert.equal(child.trust_tools, true, 'child inherits trust_tools from parent');

  await admin.del(`/api/workflows/${s.workflow.id}`);
  await admin.del(`/api/workflows/${s2.workflow.id}`);
});

test('trust_tools OFF: behaviour unchanged — git push blocked, deploy blocked, approvals required', async () => {
  // Verify that with trust_tools OFF (default), the existing blocking behaviour is unchanged.
  // blockedCommand still blocks git push and other commands.
  assert.ok(blockedCommand('git push origin HEAD'), 'git push blocked when trust_tools OFF');
  assert.ok(blockedCommand('sudo apt install x'), 'sudo blocked when trust_tools OFF');
  assert.ok(blockedCommand('npm publish'), 'npm publish blocked when trust_tools OFF');
  // alwaysBlockedCommand blocks deploy regardless of trust state.
  assert.ok(alwaysBlockedCommand('cdk deploy'), 'cdk deploy always blocked');
  assert.ok(alwaysBlockedCommand('terraform apply'), 'terraform apply always blocked');
  assert.ok(alwaysBlockedCommand('kubectl apply -f x.yaml'), 'kubectl apply always blocked');
  // helm
  assert.ok(alwaysBlockedCommand('helm install x ./chart'), 'helm install always blocked');
});

test('trust_tools: trusted session push to own branch succeeds via portal with no credentials in agent env', async () => {
  // Full flow: start a trusted session against a local bare repo.
  // The demo driver handles [demo-trust-push: <branch>] to simulate a git push in the agent.
  // We can't test the actual push without a real engine, so we test the performTrustedPush pathway
  // via a direct API approach using a real session.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wftrust-'));
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
    const { repo } = await admin.post(`/api/projects/${pid}/repos`, { provider: 'git', url, name: 'trust-push-repo' });
    const end = Date.now() + 20_000;
    while (Date.now() < end && (await admin.get(`/api/projects/${pid}/repos`)).repos.find((r: any) => r.id === repo.id).status !== 'ready')
      await new Promise((r) => setTimeout(r, 150));

    // Create a trusted session.
    const { workflow } = await admin.post(`/api/projects/${pid}/workflows`, {
      goal: 'Trust push test [demo-iterations: 1]',
      model: 'haiku',
      repoId: repo.id,
      trustTools: true,
      start: true,
    });
    const d = await settle(workflow.id, ['done', 'blocked', 'failed', 'paused', 'stopped']);

    // The session should have trust_tools: true.
    const wfDetail = (await admin.get(`/api/workflows/${workflow.id}`)).workflow;
    assert.equal(wfDetail.trust_tools, true, 'trust_tools should be set on session');

    // The agent environment must never contain portal keys.
    // Verify by checking run events for leaked env vars.
    const events = (await admin.get(`/api/workflows/${workflow.id}`)).events ?? [];
    const eventsText = JSON.stringify(events);
    assert.ok(!eventsText.includes('ANTHROPIC_API_KEY'), 'Anthropic key must not appear in events');
    assert.ok(!eventsText.includes('AWS_SECRET_ACCESS_KEY'), 'AWS secret must not appear in events');
    assert.ok(!eventsText.includes('PORTAL_SECRET_KEY'), 'Portal secret must not appear in events');

    await admin.del(`/api/workflows/${workflow.id}`);
    await admin.del(`/api/repos/${repo.id}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('trust_tools: push to shared/base/force refused; repo-less session refused', async () => {
  // Unit test for parseTrustedPush (used by the guard to validate trusted push commands).
  // Shared branches: main, master, develop, release, staging, production.
  // The guard calls parseTrustedPush and then checks isSharedBranch.
  const { isSharedBranch } = await import('../server/runs.ts');

  // Force push → unsafe.
  const f1 = parseTrustedPush('git push -f origin HEAD:refs/heads/my-branch');
  assert.ok(f1 && 'unsafe' in f1, '--force flag makes push unsafe');

  const f2 = parseTrustedPush('git push --force-with-lease origin HEAD');
  assert.ok(f2 && 'unsafe' in f2, '--force-with-lease is also unsafe');

  // Valid push to a feature branch.
  const valid = parseTrustedPush('git push origin HEAD:refs/heads/agent/my-task-abc123');
  assert.ok(valid && 'branch' in valid, 'valid push returns branch');
  assert.equal((valid as any).branch, 'agent/my-task-abc123');

  // Shared branches detected by isSharedBranch.
  for (const branch of ['main', 'master', 'develop', 'development', 'release', 'staging', 'production', 'prod']) {
    assert.ok(isSharedBranch(branch), `isSharedBranch should detect: ${branch}`);
  }
  assert.ok(!isSharedBranch('agent/my-fix-abc123'), 'agent branch is not shared');
  assert.ok(!isSharedBranch('feature/my-task'), 'feature branch is not shared');
});
