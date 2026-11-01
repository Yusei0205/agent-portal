/**
 * Windows env-var handling for kiro-cli invocations.
 *
 * Regression guard for the Windows "error: home directory not found" bug:
 *
 *   kiro-cli is bundled with Bun, which calls the Windows SHGetKnownFolderPath
 *   API during runtime initialisation.  When USERPROFILE is set to a temp dir
 *   that doesn't match the OS-registered user profile, Bun aborts before
 *   tui.js even runs.  Setting only HOME (leaving USERPROFILE unchanged) is
 *   sufficient because kiro-cli's tui.js reads HOME before USERPROFILE.
 *
 * Coverage:
 *   _buildKiroListChildEnv — unit tests (no spawn):
 *     - HOME set to tmpHome when tmpHome is provided
 *     - USERPROFILE never changed (critical Windows guard)
 *     - IDC sentinel keys stripped from child env (including IDC_START_URL_KEY)
 *     - HOME not set when tmpHome is null (api_key path)
 *     - Caller-supplied env vars merged in
 *     - KIRO_TEST_DB_PATH set when kiroTestDbPath is provided
 *     - KIRO_TEST_DB_PATH absent when kiroTestDbPath is null/omitted
 *
 *   runKiro (via fake-kiro home-env-check scenario) — integration:
 *     - HOME is set in child process to materialised home dir
 *     - USERPROFILE in child process is the portal process's real value
 *       (not overridden to the materialised home dir)
 *
 *   runKiro (via fake-kiro kiro-test-db-check scenario) — integration:
 *     - KIRO_TEST_DB_PATH is set in child process for IDC credential
 *     - Temp auth DB is cleaned up after run completes
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { _buildKiroListChildEnv } from '../server/models.ts';
import { IDC_TOKEN_KEY, IDC_REGION_KEY, IDC_EXPIRY_KEY, IDC_START_URL_KEY, IDC_REFRESH_TOKEN_KEY, IDC_CLIENT_ID_KEY, IDC_CLIENT_SECRET_KEY, IDC_CLIENT_SECRET_EXPIRES_AT_KEY } from '../server/credentials.ts';
import { createTestDb, cleanup } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { insert } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { setConfig } from '../server/config.ts';
import type { Config } from '../server/config.ts';
import { runKiro } from '../server/agent/kiro.ts';
import { loadRunPermissions } from '../server/guardrails.ts';
import type { RunContext, AgentRun } from '../server/agent/types.ts';
import { materialiseForRun, getRunHomeDir, cleanupRunHome } from '../server/user-config.ts';
import { encrypt, decrypt } from '../server/secrets.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_KIRO = path.join(__dirname, 'fake-kiro.mjs');

// ── _buildKiroListChildEnv — unit tests ───────────────────────────────────────

describe('_buildKiroListChildEnv — Windows env-var invariants', () => {
  const FAKE_REAL_HOME = process.platform === 'win32'
    ? (process.env.USERPROFILE ?? 'C:\\Users\\TestUser')
    : (process.env.HOME ?? '/home/testuser');

  const FAKE_REAL_UP = 'C:\\Users\\RealWindowsUser';

  it('sets HOME to tmpHome when tmpHome is provided', () => {
    const tmpHome = path.join(os.tmpdir(), `kiro-test-home-${Date.now()}`);
    const result = _buildKiroListChildEnv({}, tmpHome, { HOME: FAKE_REAL_HOME });
    assert.equal(result.HOME, tmpHome, 'HOME must be set to tmpHome');
  });

  it('does not change USERPROFILE when tmpHome is provided (critical Windows guard)', () => {
    // On Windows, setting USERPROFILE to a temp dir causes Bun to crash with
    // "error: home directory not found". This test enforces the invariant that
    // _buildKiroListChildEnv NEVER overrides USERPROFILE.
    const tmpHome = path.join(os.tmpdir(), `kiro-test-home-${Date.now()}`);
    const baseEnv: NodeJS.ProcessEnv = {
      USERPROFILE: FAKE_REAL_UP,
      HOME: FAKE_REAL_HOME,
    };
    const result = _buildKiroListChildEnv({}, tmpHome, baseEnv);

    assert.equal(result.HOME, tmpHome, 'HOME must be set to tmpHome');
    assert.equal(
      result.USERPROFILE,
      FAKE_REAL_UP,
      'USERPROFILE must never be changed to tmpHome — changing it breaks Bun on Windows',
    );
  });

  it('leaves HOME at base value when tmpHome is null (api_key path)', () => {
    const baseEnv: NodeJS.ProcessEnv = { HOME: FAKE_REAL_HOME, USERPROFILE: FAKE_REAL_UP };
    const result = _buildKiroListChildEnv({ KIRO_API_KEY: 'some-key' }, null, baseEnv);
    assert.equal(result.HOME, FAKE_REAL_HOME, 'HOME must remain unchanged when no tmpHome');
    assert.equal(result.USERPROFILE, FAKE_REAL_UP, 'USERPROFILE must remain unchanged when no tmpHome');
  });

  it('strips IDC_TOKEN_KEY from child env', () => {
    const tmpHome = path.join(os.tmpdir(), `kiro-test-home-${Date.now()}`);
    const env: Record<string, string> = {
      [IDC_TOKEN_KEY]: 'fake-idc-token',
      [IDC_REGION_KEY]: 'us-east-1',
      [IDC_EXPIRY_KEY]: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const result = _buildKiroListChildEnv(env, tmpHome, {});
    assert.ok(!(IDC_TOKEN_KEY in result), 'IDC_TOKEN_KEY must not appear in child env');
    assert.ok(!(IDC_REGION_KEY in result), 'IDC_REGION_KEY must not appear in child env');
    assert.ok(!(IDC_EXPIRY_KEY in result), 'IDC_EXPIRY_KEY must not appear in child env');
  });

  it('strips IDC sentinel keys even when tmpHome is null', () => {
    const env: Record<string, string> = {
      [IDC_TOKEN_KEY]: 'some-token',
      [IDC_REGION_KEY]: 'eu-west-1',
      [IDC_EXPIRY_KEY]: new Date().toISOString(),
    };
    const result = _buildKiroListChildEnv(env, null, {});
    assert.ok(!(IDC_TOKEN_KEY in result), 'IDC_TOKEN_KEY must always be stripped');
  });

  it('merges caller env vars into child env', () => {
    const result = _buildKiroListChildEnv({ KIRO_API_KEY: 'my-key' }, null, {});
    assert.equal(result.KIRO_API_KEY, 'my-key', 'caller env vars must be present in child env');
  });

  it('caller env vars override base env vars', () => {
    const result = _buildKiroListChildEnv(
      { HOME: '/override-home' },
      null,
      { HOME: '/base-home' },
    );
    assert.equal(result.HOME, '/override-home', 'caller env vars take priority over baseEnv');
  });

  it('tmpHome overrides any HOME in caller env when tmpHome is set', () => {
    // tmpHome wins even if env also contains HOME
    const tmpHome = path.join(os.tmpdir(), `kiro-test-home-${Date.now()}`);
    const result = _buildKiroListChildEnv(
      { HOME: '/env-home' },
      tmpHome,
      { HOME: '/base-home' },
    );
    assert.equal(result.HOME, tmpHome, 'tmpHome must override both baseEnv.HOME and env.HOME');
  });

  it('sets KIRO_TEST_DB_PATH when kiroTestDbPath is provided', () => {
    const dbPath = path.join(os.tmpdir(), 'test-auth.sqlite3');
    const result = _buildKiroListChildEnv({}, null, {}, dbPath);
    assert.equal(result.KIRO_TEST_DB_PATH, dbPath, 'KIRO_TEST_DB_PATH must be set from kiroTestDbPath');
  });

  it('does not set KIRO_TEST_DB_PATH when kiroTestDbPath is omitted', () => {
    const result = _buildKiroListChildEnv({}, null, {});
    assert.ok(!('KIRO_TEST_DB_PATH' in result), 'KIRO_TEST_DB_PATH must not appear when not provided');
  });

  it('does not set KIRO_TEST_DB_PATH when kiroTestDbPath is null', () => {
    const result = _buildKiroListChildEnv({}, null, {}, null);
    assert.ok(!('KIRO_TEST_DB_PATH' in result), 'KIRO_TEST_DB_PATH must not appear when null');
  });

  it('strips IDC_START_URL_KEY from child env', () => {
    const env: Record<string, string> = {
      [IDC_TOKEN_KEY]: 'some-token',
      [IDC_REGION_KEY]: 'us-east-1',
      [IDC_EXPIRY_KEY]: new Date().toISOString(),
      '_PORTAL_IDC_START_URL': 'https://example.awsapps.com/start',
    };
    const result = _buildKiroListChildEnv(env, null, {});
    assert.ok(!('_PORTAL_IDC_START_URL' in result), 'IDC_START_URL_KEY must be stripped from child env');
  });

  it('strips new IDC registration sentinel keys (refresh token, clientId, clientSecret, expiresAt)', () => {
    const env: Record<string, string> = {
      [IDC_TOKEN_KEY]: 'fake-token',
      [IDC_REGION_KEY]: 'us-east-1',
      [IDC_EXPIRY_KEY]: new Date().toISOString(),
      [IDC_REFRESH_TOKEN_KEY]: 'fake-refresh-token',
      [IDC_CLIENT_ID_KEY]: 'fake-client-id',
      [IDC_CLIENT_SECRET_KEY]: 'fake-client-secret',
      [IDC_CLIENT_SECRET_EXPIRES_AT_KEY]: '9999999999',
    };
    const result = _buildKiroListChildEnv(env, null, {});
    assert.ok(!(IDC_REFRESH_TOKEN_KEY in result), 'IDC_REFRESH_TOKEN_KEY must be stripped');
    assert.ok(!(IDC_CLIENT_ID_KEY in result), 'IDC_CLIENT_ID_KEY must be stripped');
    assert.ok(!(IDC_CLIENT_SECRET_KEY in result), 'IDC_CLIENT_SECRET_KEY must be stripped');
    assert.ok(!(IDC_CLIENT_SECRET_EXPIRES_AT_KEY in result), 'IDC_CLIENT_SECRET_EXPIRES_AT_KEY must be stripped');
    assert.ok(!(IDC_TOKEN_KEY in result), 'IDC_TOKEN_KEY must still be stripped');
  });
});

// ── runKiro — home dir env-var integration ────────────────────────────────────

interface TestRunData {
  workDir: string;
  runId: string;
  workflowId: string;
  projectId: string;
  cfg: Config;
}

function makeKiroTestRun(): TestRunData {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-kiroenv-test-'));
  const cfg: Config = {
    root: process.cwd(),
    port: 0,
    host: '127.0.0.1',
    dataDir,
    webDir: path.join(process.cwd(), 'dist', 'web'),
    secretKey: 'b'.repeat(64),
    cookieSecure: 'false',
    demoSpeed: 0,
    maxUploadBytes: 50 * 1024 * 1024,
    trustProxy: false,
    awsRegion: 'us-east-1',
    deployTarget: null,
  };
  setConfig(cfg);

  const workDir = path.join(dataDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });

  const db = getDb();
  const projectId = `proj-${generateId()}`;
  const workflowId = `wf-${generateId()}`;
  const runId = `run-${generateId()}`;
  const userId = `user-${generateId()}`;

  db.prepare('INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, `test-${Date.now()}@example.com`, 'Test', 'x', 1, now());

  db.prepare(
    'INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
  ).run(projectId, 'Test Project', `test-kiroenv-${Date.now()}`, now());

  db.prepare(
    `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', ?, ?, ?)`,
  ).run(workflowId, projectId, 'Test goal', userId, now(), now());

  db.prepare(
    `INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`,
  ).run(runId, workflowId, now());

  const fakeKey = encrypt('sk-ant-test-fake', cfg.secretKey);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('provider.mode', 'anthropic');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('anthropic.key.enc', fakeKey);

  return { workDir, runId, workflowId, projectId, cfg };
}

describe('runKiro — materialised home dir env vars (Windows guard)', () => {
  let t: TestRunData;
  const savedFake = process.env.PORTAL_KIRO_FAKE;
  const savedScenario = process.env.PORTAL_FAKE_KIRO_SCENARIO;

  before(() => {
    createTestDb();

    t = makeKiroTestRun();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'home-env-check';
  });

  after(async () => {
    if (savedFake !== undefined) {
      process.env.PORTAL_KIRO_FAKE = savedFake;
    } else {
      delete process.env.PORTAL_KIRO_FAKE;
    }
    if (savedScenario !== undefined) {
      process.env.PORTAL_FAKE_KIRO_SCENARIO = savedScenario;
    } else {
      delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    }
    await cleanupRunHome(t.runId);
    await cleanup();
  });

  it('HOME is set to materialised home dir; USERPROFILE is not changed to it', async () => {
    // Materialise the home dir for this run (same path runner.ts takes)
    await materialiseForRun(t.workflowId, t.runId, t.workDir);
    const homeDir = getRunHomeDir(t.runId);
    assert.ok(homeDir, 'materialiseForRun must register a home dir');

    const permissions = await loadRunPermissions(t.projectId);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

    const agentRun: AgentRun = {
      runId: t.runId,
      workflowId: t.workflowId,
      projectId: t.projectId,
      goal: 'test',
      kind: null,
      engine: 'kiro',
      trusted: false,
      dataDir: t.cfg.dataDir,
      workDir: t.workDir,
      repoIds: [],
      leadAgent: null,
      permissions,
      credentialId: null,
      credentialOwnerId: null,
      model: null,
    };

    const abort = new AbortController();
    const ctx: RunContext = {
      run: agentRun,
      emit: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set<string>(),
      signal: abort.signal,
    };

    await runKiro(ctx);

    // The fake-kiro home-env-check scenario writes:
    //   HOME=<value>\nUSERPROFILE=<value>\n
    // runKiro emits each non-empty line as an assistant-text event.
    const textEvents = events
      .filter((e) => e.type === 'assistant-text')
      .map((e) => String(e.payload.text ?? '').trim());

    const homeLine = textEvents.find((t) => t.startsWith('HOME='));
    const upLine = textEvents.find((t) => t.startsWith('USERPROFILE='));

    assert.ok(homeLine, `Expected a HOME= line in output; got: ${JSON.stringify(textEvents)}`);
    assert.ok(upLine, `Expected a USERPROFILE= line in output; got: ${JSON.stringify(textEvents)}`);

    const emittedHome = homeLine!.slice('HOME='.length);
    const emittedUp = upLine!.slice('USERPROFILE='.length);

    // HOME must point to the materialised home dir
    assert.equal(emittedHome, homeDir,
      `HOME in child process should be the materialised dir (${homeDir}), got: ${emittedHome}`);

    // USERPROFILE must NOT be the materialised home dir.
    // On Windows this is the key invariant: setting USERPROFILE to a temp dir
    // crashes Bun with "error: home directory not found".
    assert.notEqual(
      emittedUp,
      homeDir,
      'USERPROFILE must NOT be set to the materialised home dir — that crashes kiro-cli on Windows',
    );

    // USERPROFILE must equal the portal process's own USERPROFILE (unchanged)
    const expectedUp = process.env.USERPROFILE ?? 'not-set';
    assert.equal(emittedUp, expectedUp,
      `USERPROFILE in child process should be the portal process value (${expectedUp}), got: ${emittedUp}`);
  });
});

// ── runKiro — KIRO_TEST_DB_PATH injection for IDC credentials ─────────────────

describe('runKiro — KIRO_TEST_DB_PATH injected for identity_center credential', () => {
  let t: TestRunData;
  let credId: string;
  const savedFake = process.env.PORTAL_KIRO_FAKE;
  const savedScenario = process.env.PORTAL_FAKE_KIRO_SCENARIO;

  before(async () => {
    createTestDb();

    t = makeKiroTestRun();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-test-db-check';

    // Create an identity_center credential for the workflow owner
    const db = getDb();
    const userId = db.prepare(
      'SELECT created_by FROM p6_workflows WHERE id = ?',
    ).get(t.workflowId) as { created_by: string } | undefined;
    const ownerId = userId?.created_by ?? '';
    credId = `cred-${generateId()}`;
    const tokenEnc = encrypt('fake-idc-access-token-for-test', t.cfg.secretKey);
    db.prepare(
      `INSERT INTO engine_credentials
         (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'Test IDC', 'identity_center', ?, ?, 1, 'test', ?, ?)`,
    ).run(
      credId,
      ownerId,
      tokenEnc,
      JSON.stringify({
        startUrl: 'https://d-example.awsapps.com/start',
        region: 'us-east-1',
        tokenExpiry: new Date(Date.now() + 28_800_000).toISOString(),
        signedInAt: now(),
        clientId: 'test-idc-client-id',
        clientSecretExpiresAt: 9999999999,
        selectedProfileArn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/test-profile',
        selectedProfileName: 'KiroProfile-us-east-1',
      }),
      now(),
      now(),
    );
    // Update workflow to reference this credential
    db.prepare(
      'UPDATE p6_workflows SET credential_id = ? WHERE id = ?',
    ).run(credId, t.workflowId);
  });

  after(async () => {
    if (savedFake !== undefined) {
      process.env.PORTAL_KIRO_FAKE = savedFake;
    } else {
      delete process.env.PORTAL_KIRO_FAKE;
    }
    if (savedScenario !== undefined) {
      process.env.PORTAL_FAKE_KIRO_SCENARIO = savedScenario;
    } else {
      delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    }
    await cleanupRunHome(t.runId);
    await cleanup();
  });

  it('KIRO_TEST_DB_PATH is set in child process for IDC credential; file exists and is cleaned up', async () => {
    await materialiseForRun(t.workflowId, t.runId, t.workDir);

    const db = getDb();
    const wf = db.prepare('SELECT created_by FROM p6_workflows WHERE id = ?').get(t.workflowId) as { created_by: string } | undefined;
    const ownerId = wf?.created_by ?? '';

    const permissions = await loadRunPermissions(t.projectId);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

    const agentRun: AgentRun = {
      runId: t.runId,
      workflowId: t.workflowId,
      projectId: t.projectId,
      goal: 'test',
      kind: null,
      engine: 'kiro',
      trusted: false,
      dataDir: t.cfg.dataDir,
      workDir: t.workDir,
      repoIds: [],
      leadAgent: null,
      permissions,
      credentialId: credId,
      credentialOwnerId: ownerId,
      model: null,
    };

    const abort = new AbortController();
    const ctx: RunContext = {
      run: agentRun,
      emit: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set<string>(),
      signal: abort.signal,
    };

    await runKiro(ctx);

    const textEvents = events
      .filter((e) => e.type === 'assistant-text')
      .map((e) => String(e.payload.text ?? '').trim());

    const dbLine = textEvents.find((l) => l.startsWith('KIRO_TEST_DB_PATH='));
    assert.ok(dbLine, `Expected a KIRO_TEST_DB_PATH= line; got: ${JSON.stringify(textEvents)}`);

    const emittedPath = dbLine!.slice('KIRO_TEST_DB_PATH='.length);
    assert.notEqual(emittedPath, 'not-set', 'KIRO_TEST_DB_PATH must be set for IDC credential');
    assert.ok(emittedPath.length > 0, 'KIRO_TEST_DB_PATH must be a non-empty path');

    // After run, the temp DB must have been cleaned up.
    let stillExists = false;
    try {
      await fsp.access(emittedPath);
      stillExists = true;
    } catch {
      stillExists = false;
    }
    assert.ok(!stillExists, `Temp auth DB at ${emittedPath} must be deleted after run`);
  });
});

// ── checkKiroIdcHookSupport — unit tests ──────────────────────────────────────

import { checkKiroIdcHookSupport, _clearIdcHookCheckCache } from '../server/kiro-idc-check.ts';
import { _setMaterialiseKiroAuthDbOverride } from '../server/kiro-idc.ts';

describe('checkKiroIdcHookSupport — hook honoured', () => {
  const savedFake = process.env.PORTAL_KIRO_FAKE;
  const savedScenario = process.env.PORTAL_FAKE_KIRO_SCENARIO;
  const savedVer = process.env.PORTAL_FAKE_KIRO_VERSION;

  before(() => {
    _clearIdcHookCheckCache();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    // No idc-hook-ignored scenario → default whoami honoured path
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    process.env.PORTAL_FAKE_KIRO_VERSION = '2.37.0-test-honoured';
  });

  after(() => {
    _clearIdcHookCheckCache();
    if (savedFake !== undefined) process.env.PORTAL_KIRO_FAKE = savedFake; else delete process.env.PORTAL_KIRO_FAKE;
    if (savedScenario !== undefined) process.env.PORTAL_FAKE_KIRO_SCENARIO = savedScenario; else delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    if (savedVer !== undefined) process.env.PORTAL_FAKE_KIRO_VERSION = savedVer; else delete process.env.PORTAL_FAKE_KIRO_VERSION;
  });

  it('returns supported:true when fake honours KIRO_TEST_DB_PATH', async () => {
    const result = await checkKiroIdcHookSupport();
    assert.ok(result.supported === true, `Expected supported:true, got: ${JSON.stringify(result)}`);
    assert.equal(result.version, '2.37.0-test-honoured');
    assert.equal(result.error, undefined, 'should not have an error when check succeeds');
  });
});

describe('checkKiroIdcHookSupport — hook ignored', () => {
  const savedFake = process.env.PORTAL_KIRO_FAKE;
  const savedScenario = process.env.PORTAL_FAKE_KIRO_SCENARIO;
  const savedVer = process.env.PORTAL_FAKE_KIRO_VERSION;

  before(() => {
    _clearIdcHookCheckCache();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'idc-hook-ignored';
    process.env.PORTAL_FAKE_KIRO_VERSION = '2.36.0-test-ignored';
  });

  after(() => {
    _clearIdcHookCheckCache();
    if (savedFake !== undefined) process.env.PORTAL_KIRO_FAKE = savedFake; else delete process.env.PORTAL_KIRO_FAKE;
    if (savedScenario !== undefined) process.env.PORTAL_FAKE_KIRO_SCENARIO = savedScenario; else delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    if (savedVer !== undefined) process.env.PORTAL_FAKE_KIRO_VERSION = savedVer; else delete process.env.PORTAL_FAKE_KIRO_VERSION;
  });

  it('returns supported:false when fake ignores KIRO_TEST_DB_PATH', async () => {
    const result = await checkKiroIdcHookSupport();
    assert.ok(result.supported === false, `Expected supported:false, got: ${JSON.stringify(result)}`);
    assert.equal(result.version, '2.36.0-test-ignored');
  });
});

describe('checkKiroIdcHookSupport — caches by version', () => {
  const savedFake = process.env.PORTAL_KIRO_FAKE;
  const savedScenario = process.env.PORTAL_FAKE_KIRO_SCENARIO;
  const savedVer = process.env.PORTAL_FAKE_KIRO_VERSION;

  before(() => {
    _clearIdcHookCheckCache();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    // Start with honoured scenario
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    process.env.PORTAL_FAKE_KIRO_VERSION = '2.37.0-test-cache';
  });

  after(() => {
    _clearIdcHookCheckCache();
    if (savedFake !== undefined) process.env.PORTAL_KIRO_FAKE = savedFake; else delete process.env.PORTAL_KIRO_FAKE;
    if (savedScenario !== undefined) process.env.PORTAL_FAKE_KIRO_SCENARIO = savedScenario; else delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    if (savedVer !== undefined) process.env.PORTAL_FAKE_KIRO_VERSION = savedVer; else delete process.env.PORTAL_FAKE_KIRO_VERSION;
  });

  it('returns cached result on second call (same version)', async () => {
    const first = await checkKiroIdcHookSupport();
    assert.ok(first.supported, 'first call: should be supported');

    // Switch to ignored scenario — but since cache is populated, result must not change
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'idc-hook-ignored';
    const second = await checkKiroIdcHookSupport();
    assert.ok(second.supported === true, 'second call: cached result must still be true despite scenario change');
    assert.ok(first === second, 'second call must return the exact same cached object');
  });

  it('re-runs check after cache clear and picks up new scenario', async () => {
    // scenario is still 'idc-hook-ignored' from previous test
    _clearIdcHookCheckCache();
    const fresh = await checkKiroIdcHookSupport();
    assert.ok(fresh.supported === false, `After cache clear, should reflect idc-hook-ignored (supported:false), got: ${JSON.stringify(fresh)}`);
  });
});

// ── runKiro — materialisation failure → run fails ─────────────────────────────

describe('runKiro — IDC materialisation failure → run throws user-actionable error', () => {
  let t: TestRunData;
  let credId: string;
  const savedFake = process.env.PORTAL_KIRO_FAKE;
  const savedScenario = process.env.PORTAL_FAKE_KIRO_SCENARIO;
  const savedVer = process.env.PORTAL_FAKE_KIRO_VERSION;

  before(async () => {
    createTestDb();

    _clearIdcHookCheckCache();
    t = makeKiroTestRun();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    // Default scenario → hook honoured
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    process.env.PORTAL_FAKE_KIRO_VERSION = '2.37.0-test-matfail';

    const db = getDb();
    const wf = db.prepare('SELECT created_by FROM p6_workflows WHERE id = ?').get(t.workflowId) as { created_by: string } | undefined;
    const ownerId = wf?.created_by ?? '';
    credId = `cred-${generateId()}`;
    const tokenEnc = encrypt('fake-idc-token', t.cfg.secretKey);
    db.prepare(
      `INSERT INTO engine_credentials
         (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'Test IDC', 'identity_center', ?, ?, 1, 'test', ?, ?)`,
    ).run(
      credId, ownerId, tokenEnc,
      JSON.stringify({ startUrl: 'https://d-example.awsapps.com/start', region: 'us-east-1', tokenExpiry: new Date(Date.now() + 28_800_000).toISOString(), clientId: 'test-idc-client-id', clientSecretExpiresAt: 9999999999, selectedProfileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/matfail', selectedProfileName: 'KiroProfile' }),
      now(), now(),
    );
    db.prepare('UPDATE p6_workflows SET credential_id = ? WHERE id = ?').run(credId, t.workflowId);

    // Inject override that makes materialisation throw
    _setMaterialiseKiroAuthDbOverride(async () => { throw new Error('simulated temp dir full'); });
  });

  after(async () => {
    _setMaterialiseKiroAuthDbOverride(null);
    _clearIdcHookCheckCache();
    if (savedFake !== undefined) process.env.PORTAL_KIRO_FAKE = savedFake; else delete process.env.PORTAL_KIRO_FAKE;
    if (savedScenario !== undefined) process.env.PORTAL_FAKE_KIRO_SCENARIO = savedScenario; else delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    if (savedVer !== undefined) process.env.PORTAL_FAKE_KIRO_VERSION = savedVer; else delete process.env.PORTAL_FAKE_KIRO_VERSION;
    await cleanupRunHome(t.runId);
    await cleanup();
  });

  it('throws a clear user-actionable error when materialisation fails', async () => {
    await materialiseForRun(t.workflowId, t.runId, t.workDir);
    const db = getDb();
    const wf = db.prepare('SELECT created_by FROM p6_workflows WHERE id = ?').get(t.workflowId) as { created_by: string } | undefined;
    const ownerId = wf?.created_by ?? '';

    const permissions = await loadRunPermissions(t.projectId);
    const agentRun: AgentRun = {
      runId: t.runId, workflowId: t.workflowId, projectId: t.projectId,
      goal: 'test', kind: null, engine: 'kiro', trusted: false,
      dataDir: t.cfg.dataDir, workDir: t.workDir, repoIds: [],
      leadAgent: null, permissions, credentialId: credId, credentialOwnerId: ownerId, model: null,
    };
    const abort = new AbortController();
    const ctx: RunContext = {
      run: agentRun, emit: () => {}, awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set<string>(), signal: abort.signal,
    };

    let threw = false;
    let errMsg = '';
    try {
      await runKiro(ctx);
    } catch (e) {
      threw = true;
      errMsg = String((e as Error).message ?? '');
    }
    assert.ok(threw, 'runKiro must throw when materialisation fails');
    assert.ok(
      errMsg.toLowerCase().includes('authentication database') || errMsg.toLowerCase().includes('temp'),
      `Error message should mention the auth database or temp dir: "${errMsg}"`,
    );
    // Must NOT say "non-fatal" or continue silently
    assert.ok(
      !errMsg.toLowerCase().includes('non-fatal'),
      `Error message must not say "non-fatal": "${errMsg}"`,
    );
  });
});

// ── runKiro — hook ignored → refused ─────────────────────────────────────────

describe('runKiro — IDC hook ignored → run refused with API-key suggestion', () => {
  let t: TestRunData;
  let credId: string;
  const savedFake = process.env.PORTAL_KIRO_FAKE;
  const savedScenario = process.env.PORTAL_FAKE_KIRO_SCENARIO;
  const savedVer = process.env.PORTAL_FAKE_KIRO_VERSION;

  before(async () => {
    createTestDb();

    _clearIdcHookCheckCache();
    t = makeKiroTestRun();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'idc-hook-ignored';
    process.env.PORTAL_FAKE_KIRO_VERSION = '2.36.0-test-ignored-run';

    const db = getDb();
    const wf = db.prepare('SELECT created_by FROM p6_workflows WHERE id = ?').get(t.workflowId) as { created_by: string } | undefined;
    const ownerId = wf?.created_by ?? '';
    credId = `cred-${generateId()}`;
    const tokenEnc = encrypt('fake-idc-token', t.cfg.secretKey);
    db.prepare(
      `INSERT INTO engine_credentials
         (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'Test IDC Ignored', 'identity_center', ?, ?, 1, 'test', ?, ?)`,
    ).run(
      credId, ownerId, tokenEnc,
      JSON.stringify({ startUrl: 'https://d-example.awsapps.com/start', region: 'us-east-1', tokenExpiry: new Date(Date.now() + 28_800_000).toISOString(), clientId: 'test-idc-client-ignored', clientSecretExpiresAt: 9999999999, selectedProfileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ignored', selectedProfileName: 'KiroProfile' }),
      now(), now(),
    );
    db.prepare('UPDATE p6_workflows SET credential_id = ? WHERE id = ?').run(credId, t.workflowId);
  });

  after(async () => {
    _clearIdcHookCheckCache();
    if (savedFake !== undefined) process.env.PORTAL_KIRO_FAKE = savedFake; else delete process.env.PORTAL_KIRO_FAKE;
    if (savedScenario !== undefined) process.env.PORTAL_FAKE_KIRO_SCENARIO = savedScenario; else delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    if (savedVer !== undefined) process.env.PORTAL_FAKE_KIRO_VERSION = savedVer; else delete process.env.PORTAL_FAKE_KIRO_VERSION;
    await cleanupRunHome(t.runId);
    await cleanup();
  });

  it('throws with message telling user to use an API key credential', async () => {
    await materialiseForRun(t.workflowId, t.runId, t.workDir);
    const db = getDb();
    const wf = db.prepare('SELECT created_by FROM p6_workflows WHERE id = ?').get(t.workflowId) as { created_by: string } | undefined;
    const ownerId = wf?.created_by ?? '';

    const permissions = await loadRunPermissions(t.projectId);
    const agentRun: AgentRun = {
      runId: t.runId, workflowId: t.workflowId, projectId: t.projectId,
      goal: 'test', kind: null, engine: 'kiro', trusted: false,
      dataDir: t.cfg.dataDir, workDir: t.workDir, repoIds: [],
      leadAgent: null, permissions, credentialId: credId, credentialOwnerId: ownerId, model: null,
    };
    const abort = new AbortController();
    const ctx: RunContext = {
      run: agentRun, emit: () => {}, awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set<string>(), signal: abort.signal,
    };

    let threw = false;
    let errMsg = '';
    try {
      await runKiro(ctx);
    } catch (e) {
      threw = true;
      errMsg = String((e as Error).message ?? '');
    }
    assert.ok(threw, 'runKiro must throw when hook is not honoured');
    assert.ok(
      errMsg.toLowerCase().includes('api key') || errMsg.toLowerCase().includes('api_key'),
      `Error must suggest using an API key credential: "${errMsg}"`,
    );
    // Must not leak machine account details
    assert.ok(
      !errMsg.includes('machine@example.com'),
      `Error must not expose machine account details: "${errMsg}"`,
    );
  });
});

// ── checkKiroIdcHookSupport — unrelated failure is inconclusive ───────────────

describe('checkKiroIdcHookSupport — unrelated failure → supported:false with error', () => {
  const savedFake = process.env.PORTAL_KIRO_FAKE;
  const savedScenario = process.env.PORTAL_FAKE_KIRO_SCENARIO;
  const savedVer = process.env.PORTAL_FAKE_KIRO_VERSION;

  before(() => {
    _clearIdcHookCheckCache();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'whoami-unrelated-error';
    process.env.PORTAL_FAKE_KIRO_VERSION = '2.37.0-test-unrelated-err';
  });

  after(() => {
    _clearIdcHookCheckCache();
    if (savedFake !== undefined) process.env.PORTAL_KIRO_FAKE = savedFake; else delete process.env.PORTAL_KIRO_FAKE;
    if (savedScenario !== undefined) process.env.PORTAL_FAKE_KIRO_SCENARIO = savedScenario; else delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    if (savedVer !== undefined) process.env.PORTAL_FAKE_KIRO_VERSION = savedVer; else delete process.env.PORTAL_FAKE_KIRO_VERSION;
  });

  it('returns supported:false with an error when whoami exits with an unrelated failure', async () => {
    const result = await checkKiroIdcHookSupport();
    assert.ok(result.supported === false, `Expected supported:false, got: ${JSON.stringify(result)}`);
    assert.ok(
      typeof result.error === 'string' && result.error.length > 0,
      `Expected a non-empty error string, got: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.error!.includes('inconclusive'),
      `Error message should say 'inconclusive': "${result.error}"`,
    );
    assert.ok(
      result.error!.includes('exit'),
      `Error message should include the exit code: "${result.error}"`,
    );
    assert.ok(
      result.error!.includes('home directory not found'),
      `Error message should include sanitised stderr tail: "${result.error}"`,
    );
  });

  it('does not expose emails in the inconclusive error message', async () => {
    const result = await checkKiroIdcHookSupport();
    assert.ok(
      !/@/.test(result.error ?? ''),
      `Error must not contain email-like patterns: "${result.error}"`,
    );
  });
});

// ── checkKiroIdcHookSupport — inconclusive results are not cached ─────────────

describe('checkKiroIdcHookSupport — inconclusive result is not cached', () => {
  const savedFake = process.env.PORTAL_KIRO_FAKE;
  const savedScenario = process.env.PORTAL_FAKE_KIRO_SCENARIO;
  const savedVer = process.env.PORTAL_FAKE_KIRO_VERSION;

  before(() => {
    _clearIdcHookCheckCache();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'whoami-unrelated-error';
    process.env.PORTAL_FAKE_KIRO_VERSION = '2.37.0-test-no-cache';
  });

  after(() => {
    _clearIdcHookCheckCache();
    if (savedFake !== undefined) process.env.PORTAL_KIRO_FAKE = savedFake; else delete process.env.PORTAL_KIRO_FAKE;
    if (savedScenario !== undefined) process.env.PORTAL_FAKE_KIRO_SCENARIO = savedScenario; else delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    if (savedVer !== undefined) process.env.PORTAL_FAKE_KIRO_VERSION = savedVer; else delete process.env.PORTAL_FAKE_KIRO_VERSION;
  });

  it('does not cache an inconclusive (error) result — second call re-runs the check', async () => {
    const first = await checkKiroIdcHookSupport();
    assert.ok(first.error, `first call must be inconclusive (have error): ${JSON.stringify(first)}`);
    assert.ok(first.supported === false, 'first call must be supported:false');

    // Switch to a honoured scenario — if the result had been cached, this would not take effect.
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;

    const second = await checkKiroIdcHookSupport();
    assert.ok(
      second.supported === true,
      `second call should reflect the new scenario (supported:true) because the error was not cached; got: ${JSON.stringify(second)}`,
    );
    assert.ok(!second.error, `second call must not have an error: ${JSON.stringify(second)}`);

    // Now the definitive result IS cached
    const third = await checkKiroIdcHookSupport();
    assert.ok(third === second, 'third call must return the same cached object as the second (definitive) result');
  });
});

// ── runKiro — IDC token write-back after kiro-cli refreshes the token ─────────

describe('runKiro — IDC token write-back when kiro-cli refreshes access_token', () => {
  let t: TestRunData;
  let credId: string;
  const savedFake = process.env.PORTAL_KIRO_FAKE;
  const savedScenario = process.env.PORTAL_FAKE_KIRO_SCENARIO;
  const savedVer = process.env.PORTAL_FAKE_KIRO_VERSION;

  before(async () => {
    createTestDb();

    _clearIdcHookCheckCache();
    t = makeKiroTestRun();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-test-db-writeback';
    process.env.PORTAL_FAKE_KIRO_VERSION = '2.37.0-test-writeback';

    const db = getDb();
    const wf = db.prepare(
      'SELECT created_by FROM p6_workflows WHERE id = ?',
    ).get(t.workflowId) as { created_by: string } | undefined;
    const ownerId = wf?.created_by ?? '';
    credId = `cred-${generateId()}`;
    const tokenEnc = encrypt('original-idc-access-token', t.cfg.secretKey);
    const refreshEnc = encrypt('original-refresh-token', t.cfg.secretKey);
    const secretEnc = encrypt('mock-client-secret', t.cfg.secretKey);
    db.prepare(
      `INSERT INTO engine_credentials
         (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'Test IDC Writeback', 'identity_center', ?, ?, 1, 'test', ?, ?)`,
    ).run(
      credId, ownerId, tokenEnc,
      JSON.stringify({
        startUrl: 'https://d-example.awsapps.com/start',
        region: 'us-east-1',
        tokenExpiry: new Date(Date.now() + 28_800_000).toISOString(),
        signedInAt: now(),
        clientId: 'mock-client-id',
        clientSecretEnc: secretEnc,
        clientSecretExpiresAt: 9999999999,
        refreshTokenEnc: refreshEnc,
        selectedProfileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/writeback',
        selectedProfileName: 'KiroProfile-writeback',
      }),
      now(), now(),
    );
    db.prepare(
      'UPDATE p6_workflows SET credential_id = ? WHERE id = ?',
    ).run(credId, t.workflowId);
  });

  after(async () => {
    _clearIdcHookCheckCache();
    if (savedFake !== undefined) process.env.PORTAL_KIRO_FAKE = savedFake; else delete process.env.PORTAL_KIRO_FAKE;
    if (savedScenario !== undefined) process.env.PORTAL_FAKE_KIRO_SCENARIO = savedScenario; else delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    if (savedVer !== undefined) process.env.PORTAL_FAKE_KIRO_VERSION = savedVer; else delete process.env.PORTAL_FAKE_KIRO_VERSION;
    await cleanupRunHome(t.runId);
    await cleanup();
  });

  it('credential secret_enc is updated when kiro-cli writes a new token to the temp DB', async () => {
    await materialiseForRun(t.workflowId, t.runId, t.workDir);

    const db = getDb();
    const wf = db.prepare('SELECT created_by FROM p6_workflows WHERE id = ?').get(t.workflowId) as { created_by: string } | undefined;
    const ownerId = wf?.created_by ?? '';

    const permissions = await loadRunPermissions(t.projectId);
    const agentRun: AgentRun = {
      runId: t.runId, workflowId: t.workflowId, projectId: t.projectId,
      goal: 'test writeback', kind: null, engine: 'kiro', trusted: false,
      dataDir: t.cfg.dataDir, workDir: t.workDir, repoIds: [],
      leadAgent: null, permissions, credentialId: credId, credentialOwnerId: ownerId, model: null,
    };
    const abort = new AbortController();
    const ctx: RunContext = {
      run: agentRun, emit: () => {}, awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set<string>(), signal: abort.signal,
    };

    await runKiro(ctx);

    // The fake kiro wrote 'refreshed-access-token-by-kiro-run' to the temp DB.
    // The portal should have read it back and updated the credential.
    const updatedRow = db.prepare(
      'SELECT secret_enc, extra_config FROM engine_credentials WHERE id = ?',
    ).get(credId) as { secret_enc: string; extra_config: string } | undefined;
    assert.ok(updatedRow, 'credential row must still exist');

    const newToken = decrypt(updatedRow!.secret_enc, t.cfg.secretKey);
    assert.equal(newToken, 'refreshed-access-token-by-kiro-run',
      'credential secret_enc must be updated to the new access token written by kiro-cli');

    const extra = JSON.parse(updatedRow!.extra_config) as Record<string, unknown>;
    // Refresh token should also be updated
    if (extra.refreshTokenEnc) {
      const newRefresh = decrypt(String(extra.refreshTokenEnc), t.cfg.secretKey);
      assert.equal(newRefresh, 'refreshed-refresh-token-by-kiro-run',
        'refresh token must be updated when kiro-cli writes a new one');
    }
  });
});
