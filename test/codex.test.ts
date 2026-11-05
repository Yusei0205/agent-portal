import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { CodexClient } from '../server/codex-client.ts';
import { CodexRuntimeError, resolveCodexCommand } from '../server/codex-command.ts';
import { codexHome, codexEnv, openUserCodex, setCodexClientFactoryForTests } from '../server/codex-auth.ts';
import { approveCodexRequest, runCodex } from '../server/agent/codex.ts';
import type { RunContext } from '../server/agent/types.ts';
import { config } from '../server/config.ts';
import { insert, one, migrateCodexEngine } from '../server/db.ts';
import { DatabaseSync } from 'node:sqlite';
import { getEngineModels } from '../server/models.ts';
import { now, generateId } from '../server/util.ts';

describe('Codex integration', () => {
  let baseUrl: string, cookie: string, userId: string, projectId: string;
  let fakeFactory: NonNullable<Parameters<typeof setCodexClientFactoryForTests>[0]>;
  before(async () => {
    ({ baseUrl } = await createTestServer());
    const setup = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: {
      email: 'codex-admin@example.test', password: 'password1234', name: 'Admin', provider: 'demo',
    } });
    assert.equal(setup.status, 200);
    cookie = setup.cookie!;
    userId = one<{ id: string }>('SELECT id FROM users WHERE email = ?', 'codex-admin@example.test')!.id;
    const project = await fetchJson(baseUrl, '/api/projects', { method: 'POST', cookie, body: { name: 'Codex project' } });
    projectId = (project.body as any).project.id;
    fakeFactory = async (home, env, cwd) => {
      const client = new CodexClient(spawn(process.execPath, [path.resolve('test/fake-codex.mjs')], {
        cwd, env: { ...env, CODEX_HOME: home }, stdio: 'pipe', windowsHide: true,
      }));
      await client.request('initialize', { clientInfo: { name: 'test', version: '1' } });
      return client;
    };
    setCodexClientFactoryForTests(fakeFactory);
  });
  after(async () => {
    await fetchJson(baseUrl, '/api/codex/login/cancel', { method: 'POST', body: {}, cookie });
    setCodexClientFactoryForTests(null);
    await cleanup();
  });

  async function makeContext(goal = 'Test goal', session: string | null = null): Promise<RunContext & { events: any[] }> {
    const workflowId = generateId(), runId = generateId(), workDir = path.join(config.dataDir, 'work', runId);
    await fs.mkdir(workDir, { recursive: true });
    insert('p6_workflows', { id: workflowId, project_id: projectId, goal, engine: 'codex', status: 'running', repo_ids: '[]', created_at: now(), updated_at: now(), created_by: userId });
    insert('p6_runs', { id: runId, workflow_id: workflowId, status: 'running', created_at: now() });
    const events: any[] = [];
    return {
      events,
      run: { runId, workflowId, projectId, goal, kind: null, engine: 'codex', trusted: false,
        dataDir: config.dataDir, workDir, repoIds: [], leadAgent: null, credentialId: null,
        credentialOwnerId: userId, model: null, engineSessionId: session,
        permissions: { rules: [], toolRules: [], projectId } },
      emit: (type, payload) => events.push({ type, payload }),
      awaitInput: async () => ({ decision: 'allow', remember: false, message: '' }),
      allowed: new Set(), signal: null,
    };
  }

  it('isolates users and excludes ambient provider secrets', () => {
    assert.notEqual(codexHome(userId), codexHome('../another-user'));
    assert.equal(path.dirname(codexHome('../another-user')), path.join(config.dataDir, 'codex'));
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'do-not-pass';
    try { assert.equal(codexEnv().OPENAI_API_KEY, undefined); assert.equal(codexEnv().PORTAL_SECRET_KEY, undefined); }
    finally { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; }
  });

  it('finds the Windows desktop CLI when a server has an old PATH', async () => {
    if (process.platform !== 'win32') return;
    const local = path.join(config.dataDir, 'fake-local-appdata');
    const executable = path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, 'fixture');
    assert.equal(resolveCodexCommand({ LOCALAPPDATA: local, PATH: '' }, 'win32', '').command, executable);
  });

  it('launches a JS entry point directly, without a Windows command shell', async () => {
    const previous = process.env.PORTAL_CODEX_BIN;
    process.env.PORTAL_CODEX_BIN = path.resolve('test/fake-codex.mjs');
    const home = path.join(config.dataDir, 'launcher-smoke');
    await fs.mkdir(home);
    let client: CodexClient | undefined;
    try {
      client = await CodexClient.start(home, codexEnv());
      assert.equal((await client.request('account/read')).account, null);
    } finally {
      client?.close();
      if (previous === undefined) delete process.env.PORTAL_CODEX_BIN; else process.env.PORTAL_CODEX_BIN = previous;
    }
  });

  it('reports missing binaries and failed processes accurately, and never as a generic HTTP 500', async () => {
    for (const code of ['codex_not_installed', 'codex_process_exited']) {
      setCodexClientFactoryForTests(async () => { throw new CodexRuntimeError(code, 'Actionable startup error'); });
      try {
        const status = await fetchJson(baseUrl, '/api/codex/status', { cookie });
        assert.equal((status.body as any).code, code);
        assert.equal((status.body as any).installed, code === 'codex_not_installed' ? false : null);
        const login = await fetchJson(baseUrl, '/api/codex/login', { method: 'POST', cookie, body: {} });
        assert.equal(login.status, 503);
        assert.equal((login.body as any).error, 'Actionable startup error');
      } finally { setCodexClientFactoryForTests(fakeFactory); }
    }
  });

  it('rejects an invalid executable override and translates unexpected startup failures safely', async () => {
    assert.throws(() => resolveCodexCommand({}, process.platform, path.join(config.dataDir, 'missing-codex')), (error: unknown) =>
      error instanceof CodexRuntimeError && error.code === 'codex_not_installed');
    setCodexClientFactoryForTests(async () => { throw new Error('internal-secret-must-not-be-returned'); });
    try {
      const result = await fetchJson(baseUrl, '/api/codex/login', { method: 'POST', cookie, body: {} });
      assert.equal(result.status, 502);
      assert.match((result.body as any).error, /could not initialize/);
      assert.equal(JSON.stringify(result.body).includes('internal-secret'), false);
    } finally { setCodexClientFactoryForTests(fakeFactory); }
  });

  it('explains the unsupported Lambda runtime and blocks sign-in instead of losing credentials', async () => {
    const previous = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'fixture-portal';
    try {
      const status = (await fetchJson(baseUrl, '/api/codex/status', { cookie })).body as any;
      assert.equal(status.supported, false);
      assert.equal(status.canImportHostLogin, false);
      assert.equal(status.installed, null);
      assert.equal(status.code, 'codex_worker_required');
      assert.equal((await fetchJson(baseUrl, '/api/codex/login', { method: 'POST', cookie, body: {} })).status, 503);
      assert.equal((await fetchJson(baseUrl, '/api/codex/import-host-login', { method: 'POST', cookie, body: {} })).status, 409);
    } finally {
      if (previous === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME; else process.env.AWS_LAMBDA_FUNCTION_NAME = previous;
    }
  });

  it('migrates existing workflows without losing foreign keys, children, or indexes', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("PRAGMA foreign_keys = ON; CREATE TABLE p6_workflows (id TEXT PRIMARY KEY, engine TEXT CHECK(engine IN ('claude-code','kiro','demo'))); CREATE TABLE children (parent TEXT REFERENCES p6_workflows(id)); CREATE INDEX workflow_engine ON p6_workflows(engine); INSERT INTO p6_workflows VALUES ('old','kiro'); INSERT INTO children VALUES ('old'); BEGIN;");
      migrateCodexEngine(db);
      db.exec("COMMIT; INSERT INTO p6_workflows VALUES ('new','codex');");
      assert.equal((db.prepare('SELECT count(*) AS n FROM children').get() as any).n, 1);
      assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'workflow_engine'").get() as any).n, 1);
      assert.throws(() => db.exec("INSERT INTO p6_workflows VALUES ('bad','invalid')"), /CHECK/);
      assert.throws(() => db.exec("DELETE FROM p6_workflows WHERE id = 'old'"), /FOREIGN KEY/);
      assert.equal((db.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
    } finally { db.close(); }
  });

  it('requires authentication for credentials endpoints', async () => {
    assert.equal((await fetchJson(baseUrl, '/api/codex/status')).status, 401);
    const token = await fetchJson(baseUrl, '/api/api-tokens', { method: 'POST', cookie, body: { name: 'test', scopes: ['read', 'write'] } });
    assert.equal(token.status, 201);
    const value = (token.body as any).token;
    const r = await fetchJson(baseUrl, '/api/codex/status', { headers: { Authorization: 'Bearer ' + value } });
    assert.equal(r.status, 403);
  });

  it('fails without sign-in instead of falling back to a portal provider', async () => {
    await assert.rejects(runCodex(await makeContext()), /Sign in to Codex/);
  });

  it('completes device sign-in, exposes no tokens, and lists account models', async () => {
    const login = await fetchJson(baseUrl, '/api/codex/login', { method: 'POST', body: {}, cookie });
    assert.equal(login.status, 200);
    assert.equal((login.body as any).userCode, 'TEST-1234');
    let status: any;
    for (let i = 0; i < 40; i++) {
      status = (await fetchJson(baseUrl, '/api/codex/status', { cookie })).body;
      if (status.signedIn) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.signedIn, true);
    assert.equal(JSON.stringify(status).includes('fake-secret-never-display'), false);
    const other = await openUserCodex('other-user');
    try { assert.equal((await other.request('account/read')).account, null); } finally { other.close(); }
    const models = await getEngineModels('codex', userId, null, false);
    assert.equal(models.models[0].id, 'fixture-model');
    assert.equal(models.source, 'codex');
  });

  it('only lets admins explicitly import the host sign-in, without returning its secrets', async () => {
    const user = await fetchJson(baseUrl, '/api/users', { method: 'POST', cookie, body: {
      email: 'codex-member@example.test', password: 'password1234', name: 'Member', isAdmin: false,
    } });
    assert.equal(user.status, 201);
    const login = await fetchJson(baseUrl, '/api/auth/login', { method: 'POST', body: {
      email: 'codex-member@example.test', password: 'password1234',
    } });
    assert.equal((await fetchJson(baseUrl, '/api/codex/import-host-login', { method: 'POST', body: {}, cookie: login.cookie })).status, 403);
    assert.equal(((await fetchJson(baseUrl, '/api/codex/status', { cookie: login.cookie })).body as any).signedIn, false);
    const source = path.join(config.dataDir, 'fake-host-codex');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'fake-host-token' } }));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = source;
    try {
      const result = await fetchJson(baseUrl, '/api/codex/import-host-login', { method: 'POST', body: {}, cookie });
      assert.equal(result.status, 200);
      assert.equal(JSON.stringify(result.body).includes('fake-host-token'), false);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    }
  });

  it('creates and switches sessions with the Codex engine', async () => {
    const created = await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows', { method: 'POST', cookie, body: { engine: 'codex', goal: '' } });
    assert.equal(created.status, 201);
    const wid = (created.body as any).workflow.id;
    const switchResult = await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows/' + wid + '/engine', { method: 'POST', cookie, body: { engine: 'demo' } });
    assert.equal(switchResult.status, 200);
    assert.equal((await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows/' + wid + '/engine', { method: 'POST', cookie, body: { engine: 'codex' } })).status, 200);
  });

  it('streams text once, persists resume identity, and records token usage', async () => {
    const ctx = await makeContext();
    assert.equal(await runCodex(ctx), 'Hello from Codex');
    assert.equal(ctx.events.filter(e => e.type === 'assistant-text').map(e => e.payload.text).join(''), 'Hello from Codex');
    assert.ok(ctx.events.filter(e => e.type === 'assistant-text').every(e => e.payload.stream === true), 'native deltas must be concatenated without inserted newlines');
    assert.equal(ctx.events.filter(e => e.type === 'tool-start').length, 1);
    const workflow = one<any>('SELECT * FROM p6_workflows WHERE id = ?', ctx.run.workflowId);
    assert.equal(workflow.engine_session_id, 'thread-fixture');
    assert.equal(workflow.engine_session_engine, 'codex');
    const run = one<any>('SELECT * FROM p6_runs WHERE id = ?', ctx.run.runId);
    assert.equal(run.input_tokens, 100);
    assert.equal(run.output_tokens, 20);
    assert.equal(await runCodex(await makeContext('Continue', workflow.engine_session_id)), 'Hello from Codex');
  });

  it('propagates failed turns and process exits', async () => {
    await assert.rejects(runCodex(await makeContext('FAIL_TURN')), /Usage limit exceeded/);
    await assert.rejects(runCodex(await makeContext('EXIT_PROCESS')), /app-server exited/);
  });

  it('cancels an active turn without marking it complete', async () => {
    const ctx = await makeContext('HANG_FOREVER');
    const ctrl = new AbortController();
    ctx.signal = ctrl.signal;
    const pending = runCodex(ctx);
    const timer = setTimeout(() => ctrl.abort(), 200);
    try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
    assert.equal(ctx.events.some(e => e.type === 'run-complete'), false);
  });

  it('denies outside-workspace patches, unsafe move targets, and unknown requests', async () => {
    const ctx = await makeContext();
    for (const changes of [
      [{ path: '../outside.txt' }],
      [{ path: 'safe.txt', kind: { type: 'update', move_path: '../outside.txt' } }],
      [{ path: '.claude/settings.json' }],
    ]) {
      assert.deepEqual(await approveCodexRequest(ctx, 'item/fileChange/requestApproval', { itemId: 'patch' }, new Map([['patch', { changes }]])), { decision: 'decline' });
    }
    assert.deepEqual(await approveCodexRequest(ctx, 'item/fileChange/requestApproval', { itemId: 'missing' }, new Map()), { decision: 'decline' });
    await assert.rejects(approveCodexRequest(ctx, 'item/permissions/requestApproval', {}, new Map()), /Unsupported/);
  });

  it('routes native approvals through portal policy and honors denial', async () => {
    const ctx = await makeContext();
    let asked = false;
    ctx.awaitInput = async () => { asked = true; return { decision: 'deny', remember: false, message: '' }; };
    assert.deepEqual(await approveCodexRequest(ctx, 'item/commandExecution/requestApproval', { command: 'echo safe' }, new Map()), { decision: 'decline' });
    assert.equal(asked, true);
    asked = false;
    ctx.run.permissions.rules = [{ id: 'block', group_id: 'test', sort_order: 0, action: 'block', category: 'bash', pattern: '', scope: 'always', reason: 'Blocked', name: 'Block', created_at: now(), updated_at: now() }];
    assert.deepEqual(await approveCodexRequest(ctx, 'item/commandExecution/requestApproval', { command: 'echo safe' }, new Map()), { decision: 'decline' });
    assert.equal(asked, false);
  });

  it('logs out only the signed-in user', async () => {
    assert.equal((await fetchJson(baseUrl, '/api/codex/logout', { method: 'POST', cookie, body: {} })).status, 200);
    assert.equal(((await fetchJson(baseUrl, '/api/codex/status', { cookie })).body as any).signedIn, false);
  });
});
