import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one, insert } from '../server/db.ts';
import { generateId } from '../server/util.ts';
import { encrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';
import { runCursor, cursorArgs } from '../server/agent/cursor.ts';
import { parseCursorModels, listCursorModels } from '../server/cursor-models.ts';
import { quoteWindowsArg } from '../server/cursor-cmd.ts';
import { migrateCursorEngine } from '../server/db.ts';
import { protectedConfigReason, protectedCommandReason } from '../server/agent/guard.ts';
import { isDeniedVar } from '../server/agent/env-scrub.ts';
import { engineOfProvider } from '../server/repositories/stats.ts';
import type { AgentRun, RunContext } from '../server/agent/types.ts';

const FAKE = path.resolve('test/fake-cursor.mjs');

describe('cursorArgs', () => {
  it('always trusts the workspace and streams json; --force only for a trusted session', () => {
    const a = cursorArgs({ trusted: false, model: null, resumeId: null });
    assert.deepEqual(a, ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust']);
    assert.ok(cursorArgs({ trusted: true, model: null, resumeId: null }).includes('--force'));
  });
  it('passes a valid model and resume id, and refuses ones that could carry a flag or shell text', () => {
    assert.deepEqual(cursorArgs({ trusted: false, model: 'composer-2.5', resumeId: 'abc-123-def-456' }).slice(-4), ['--model', 'composer-2.5', '--resume', 'abc-123-def-456']);
    assert.throws(() => cursorArgs({ trusted: false, model: '--force', resumeId: null }), /Invalid Cursor model/);
    assert.throws(() => cursorArgs({ trusted: false, model: 'a b', resumeId: null }), /Invalid Cursor model/);
    assert.throws(() => cursorArgs({ trusted: false, model: null, resumeId: '--api-key=x' }), /Invalid Cursor session/);
  });
  it('quotes arguments for a Windows .cmd shim', () => {
    assert.equal(quoteWindowsArg('a"b%c^d\ne'), '"a""b%%c^^d e"');
  });
});

describe('cursor models', () => {
  it('parses the CLI table, dropping colour codes, zero-width characters and the default marker', () => {
    const m = parseCursorModels('\u001b[1mAvailable models\u001b[0m\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\ngrok-4.7-low-fast - Grok 4.7  Low Fast​​\nnot a model line\n');
    assert.deepEqual(m, [{ id: 'auto', label: 'Auto', default: true }, { id: 'composer-2.5', label: 'Composer 2.5' }, { id: 'grok-4.7-low-fast', label: 'Grok 4.7  Low Fast' }]);
  });
  it('reads the default marker the real CLI prints: (current, default)', () => {
    const out = ['Available models', '', 'auto - Auto (current, default)', 'gpt-5.2 - GPT-5.2', ''].join(String.fromCharCode(10));
    assert.deepEqual(parseCursorModels(out), [{ id: 'auto', label: 'Auto', default: true }, { id: 'gpt-5.2', label: 'GPT-5.2' }]);
  });
  it('lists models through the CLI', async () => {
    process.env.PORTAL_CURSOR_FAKE = FAKE;
    try { assert.equal((await listCursorModels(null)).models.length, 3); } finally { delete process.env.PORTAL_CURSOR_FAKE; }
  });
});

describe('cursor safety rules', () => {
  it('protects Cursor files that run commands or widen permissions, but not rules', () => {
    for (const f of ['.cursor/mcp.json', '.cursor/cli.json', '.cursor/cli-config.json', '.cursor/hooks.json', '.cursor/hooks/x.sh']) assert.ok(protectedConfigReason(f), f);
    assert.equal(protectedConfigReason('.cursor/rules/style.mdc'), null);
    assert.ok(protectedCommandReason('echo {} > .cursor/mcp.json'));
    assert.equal(protectedCommandReason('cat .cursor/rules/style.mdc'), null);
  });
  it('keeps the API key out of the agent shell and files usage under its own engine', () => {
    assert.ok(isDeniedVar('CURSOR_API_KEY'));
    assert.equal(engineOfProvider('cursor'), 'cursor');
  });
});

describe('migrateCursorEngine', () => {
  const db = (): DatabaseSync => {
    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE p6_workflows (id TEXT, engine TEXT NOT NULL CHECK(engine IN ('claude-code','kiro','codex','demo')));
      CREATE TABLE engine_credentials (id TEXT, engine TEXT NOT NULL CHECK(engine IN ('kiro','claude-code')));
      CREATE TABLE user_config_state (id TEXT, folder TEXT NOT NULL CHECK(folder IN ('kiro','claude','codex','aws')));
      CREATE TABLE team_config_versions (id TEXT, folder TEXT NOT NULL CHECK(folder IN ('kiro','claude','codex','aws')));
      INSERT INTO p6_workflows VALUES ('w','kiro');`);
    return d;
  };
  it('widens every constraint, keeps rows, and is safe to run twice', () => {
    const d = db();
    assert.throws(() => d.exec("INSERT INTO p6_workflows VALUES ('x','cursor')"));
    migrateCursorEngine(d);
    migrateCursorEngine(d);
    d.exec("INSERT INTO p6_workflows VALUES ('x','cursor'); INSERT INTO engine_credentials VALUES ('c','cursor'); INSERT INTO user_config_state VALUES ('u','cursor'); INSERT INTO team_config_versions VALUES ('t','cursor')");
    assert.equal((d.prepare('SELECT COUNT(*) n FROM p6_workflows').get() as { n: number }).n, 2);
    assert.throws(() => d.exec("INSERT INTO p6_workflows VALUES ('y','other')"));
  });
});

describe('runCursor (fake CLI)', () => {
  let baseUrl: string; let cookie: string; let projectId: string; let userId: string;
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const makeWorkflow = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body: { goal: 'start', engine: 'cursor', ...extra }, cookie });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return ((r.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
  };
  const ctxFor = (workflowId: string, goal: string, over: Partial<AgentRun> = {}, signal: AbortSignal | null = null): RunContext => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-test-'));
    const run = { runId: generateId(), workflowId, projectId, goal, kind: null, engine: 'cursor', trusted: false, dataDir: workDir, workDir, repoIds: [],
      leadAgent: null, permissions: { rules: [] }, credentialId: null, credentialOwnerId: userId, model: null, engineSessionId: null, ...over } as unknown as AgentRun;
    return { run, emit: (type, payload) => emitted.push({ type, payload: payload as Record<string, unknown> }), awaitInput: async () => ({ decision: 'deny', remember: false, message: '' }), allowed: new Set(), signal };
  };

  before(async () => {
    process.env.PORTAL_CURSOR_FAKE = FAKE;
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: 'cur@example.com', name: 'A', password: 'password1234', provider: 'demo' } });
    cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Cursor project' }, cookie });
    projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    userId = String(one<{ id: string }>("SELECT id FROM users WHERE email = 'cur@example.com'")!.id);
  });
  after(async () => { delete process.env.PORTAL_CURSOR_FAKE; await cleanup(); });
  beforeEach(() => { emitted.length = 0; });

  it('creates a Cursor session, runs a turn, streams events once, saves the session id and records usage', async () => {
    const wid = await makeWorkflow();
    const ctx = ctxFor(wid, 'do it');
    const text = await runCursor(ctx);
    assert.equal(text, 'Working on it.Done.');
    assert.deepEqual(emitted.filter((e) => e.type === 'tool-start').map((e) => e.payload.toolName), ['Read']);
    const said = emitted.filter((e) => e.type === 'assistant-text').map((e) => e.payload.text).join('');
    assert.equal(said, 'Working on it.\n\nDone.'); // streamed deltas once, a paragraph break after the tool call
    assert.equal(emitted.at(-1)!.type, 'run-complete');
    const w = one<Record<string, unknown>>('SELECT engine_session_id, engine_session_engine FROM p6_workflows WHERE id = ?', wid)!;
    assert.equal(w.engine_session_id, 'fake-session-0001');
    assert.equal(w.engine_session_engine, 'cursor');
    const usage = one<Record<string, unknown>>("SELECT input_tokens, output_tokens, cost_usd FROM budget_usage WHERE workflow_id = ? AND provider = 'cursor'", wid);
    assert.deepEqual([usage?.input_tokens, usage?.output_tokens, usage?.cost_usd], [100, 25, 0]);
  });

  it('resumes the saved session and passes --force only when trusted', async () => {
    const wid = await makeWorkflow();
    const text = await runCursor(ctxFor(wid, 'ECHO_ARGS', { engineSessionId: 'abc-resume-0002', trusted: true, model: 'composer-2.5' }));
    const args = JSON.parse(text.replace('Working on it.', '')) as string[];
    assert.ok(args.includes('--force') && args.includes('--trust'));
    assert.equal(args[args.indexOf('--resume') + 1], 'abc-resume-0002');
    assert.equal(args[args.indexOf('--model') + 1], 'composer-2.5');
    assert.ok(!args.some((a) => a.includes('ECHO_ARGS')), 'the prompt must not be on the command line');
  });

  it('gives the CLI the stored API key', async () => {
    const credId = generateId();
    insert('engine_credentials', { id: credId, user_id: userId, engine: 'cursor', name: 'k', mode: 'api_key', secret_enc: encrypt('crsr_test_key_123', config.secretKey), is_default: 1, last4: '_123' });
    const wid = await makeWorkflow();
    assert.match(await runCursor(ctxFor(wid, 'ECHO_KEY', { credentialId: credId })), /key=crsr_test_key_123/);
  });

  it('shows a rejected command as a blocked tool call', async () => {
    const wid = await makeWorkflow();
    await runCursor(ctxFor(wid, 'REJECT please'));
    const blocked = emitted.filter((e) => e.type === 'tool-blocked');
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].payload.toolName, 'Bash');
  });

  it('reports a failed CLI with its stderr, and a stream that ends with no result', async () => {
    const wid = await makeWorkflow();
    await assert.rejects(runCursor(ctxFor(wid, 'FAIL')), /exited with code 1\. Error: model unavailable/);
    await assert.rejects(runCursor(ctxFor(wid, 'NO_RESULT')), /ended without a result/);
  });

  it('stops the CLI when the run is cancelled', async () => {
    const wid = await makeWorkflow();
    const ctl = new AbortController();
    const p = runCursor(ctxFor(wid, 'HANG', {}, ctl.signal));
    setTimeout(() => ctl.abort(), 600);
    await assert.rejects(p, (e: Error) => e.name === 'AbortError');
  });

  it('needs a session owner', async () => {
    await assert.rejects(runCursor(ctxFor('w', 'x', { credentialOwnerId: null })), /session owner/);
  });
});
