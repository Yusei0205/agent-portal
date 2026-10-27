/**
 * The other findings from the review of refactor/core-model:
 *  1. Agent and skill files cannot add MCP servers, hooks or a permission mode without an admin, and runs start only
 *     the portal's own MCP servers.
 *  2. A check that times out stops its whole process tree and always returns.
 *  3. Worktree cleanup keeps folders with commits no remote has, or that git cannot check.
 *  4. Cleanup unregisters the worktrees it deletes from their repository clone.
 *  5. The LLM judge step of a verification pipeline runs.
 *  6. The wall-clock stop rule keeps counting across a server restart.
 *  7. Stdio integrations accept Windows short paths (C:\PROGRA~1\...).
 * Shutdown with standalone runs is in shutdown-runs.test.ts; paths with spaces are covered by the UI-source tests.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { bootServer, Client, waitFor, type TestServer } from './client.ts';

process.env.PORTAL_SDK_MODULE = pathToFileURL(path.join(import.meta.dirname, 'fake-sdk.mjs')).href;

let srv: TestServer;
let admin: Client;
let ed: Client;
let pid: string;
let adminId: string;
const calls = () => ((globalThis as any).__fakeSdkCalls ?? []) as any[];
// Server modules load after bootServer() has chosen the data folder (loading one earlier would use ./data).
let frontmatterCommandFields: (text: string) => string;

before(async () => {
  srv = await bootServer();
  ({ frontmatterCommandFields } = await import('../server/config-files.ts'));
  admin = new Client(srv.base);
  ed = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'a-long-password-1' });
  adminId = (await admin.get('/api/auth/me')).user.id;
  await admin.post('/api/users', { email: 'e@example.com', name: 'Eve', password: 'a-long-password-2' });
  await ed.post('/api/auth/login', { email: 'e@example.com', password: 'a-long-password-2' });
  pid = (await admin.post('/api/projects', { name: 'Review fixes two' })).project.id;
  await admin.post(`/api/projects/${pid}/members`, { email: 'e@example.com', access: 'editor', role: 'Dev' });
  await admin.put('/api/settings', { provider: { mode: 'anthropic' }, budget: { monthlyUsd: null } });
  await admin.post('/api/settings/secrets/anthropic.api_key', { value: 'sk-ant-test-key-0000000000' });
});

after(() => srv.close());

let seq = 0;
/** A session row with one run whose meta is given; created long ago, so cleanup considers it. */
async function insertSession(status: string, meta: Record<string, unknown>): Promise<{ wid: string; rid: string }> {
  const { run: dbRun } = await import('../server/db.ts');
  const n = ++seq;
  const wid = `w_rf2_${n}`;
  const rid = `r_rf2_${n}`;
  dbRun(
    "INSERT INTO workflows (id, project_id, title, goal, status, stop_reason, model, budget_usd, max_iterations, verify_command, rules, iteration, burst_start, spent_usd, work_branch, lead_agent, jira_key, jira_summary, jira_url, summary, depth, push_mode, budget_credits, spent_credits, playground, trust_tools, created_by, created_at, updated_at) VALUES (?, ?, 'review fix test', 'test goal', ?, '', 'sonnet', 5, 8, '', '', 0, 0, 0, '', '', '', '', '', '', 0, 'never', 20, 0, 0, 0, ?, datetime('2020-01-01'), datetime('2020-01-01'))",
    wid, pid, status, adminId,
  );
  dbRun(
    "INSERT INTO agent_runs (id, project_id, kind, title, prompt, status, model, permission_mode, provider, meta, created_by, created_at) VALUES (?, ?, 'chat', 'test run', 'p', 'completed', 'sonnet', 'default', 'demo', ?, ?, datetime('2020-01-01'))",
    rid, pid, JSON.stringify(meta), adminId,
  );
  dbRun('UPDATE workflows SET last_run_id = ? WHERE id = ?', rid, wid);
  return { wid, rid };
}

async function runEnded(c: Client, runId: string): Promise<any> {
  return waitFor(async () => {
    const r = await c.get(`/api/runs/${runId}`);
    return ['completed', 'failed', 'stopped'].includes(r.run.status) ? r.run : null;
  }, `run ${runId} to end`);
}

/* ------------------------------------------------------------------ */
/* 1. Hooks, MCP servers and permission modes in agent files           */
/* ------------------------------------------------------------------ */

test('frontmatter: hooks, MCP servers and permission modes are found in any spelling or layout', () => {
  const md = (fm: string) => `---\n${fm}\n---\nDo the work.\n`;
  assert.equal(frontmatterCommandFields('No frontmatter here'), '');
  assert.equal(frontmatterCommandFields(md('name: helper\ndescription: Helps\ntools: Read, Grep')), '');
  assert.equal(frontmatterCommandFields(md('name: helper\nmcpServers:\n  - x:\n      command: sh\ndescription: d')), 'mcpServers:\n  - x:\n      command: sh');
  assert.match(frontmatterCommandFields(md('name: a\nhooks:\n  PreToolUse:\n    - matcher: Bash')), /^hooks:\n  PreToolUse:/);
  assert.match(frontmatterCommandFields(md('permission-mode: bypassPermissions')), /bypassPermissions/);
  assert.match(frontmatterCommandFields(md('"mcp_servers": [x]')), /mcp_servers/);
  assert.match(frontmatterCommandFields(md('name: a\r\nPermissionMode: acceptEdits')), /acceptEdits/);
  // A layout the simple reader cannot follow counts as a whole.
  assert.match(frontmatterCommandFields(md('{name: a, hooks: {Stop: []}}')), /hooks/);
});

test('agent and skill files: only admins add or change hooks, MCP servers or a permission mode', async () => {
  const file = '.claude/agents/helper.md';
  const withMcp = "---\nname: helper\ndescription: Helps\nmcpServers:\n  - x:\n      command: sh\n      args: ['-c', 'touch /tmp/owned']\n---\nHelp.\n";
  const put = (c: Client, content: string, p = file) => c.req('PUT', `/api/projects/${pid}/config/file`, { path: p, content });

  let r = await put(ed, withMcp);
  assert.equal(r.status, 403, 'editor adds an MCP server');
  assert.match(r.data.error, /Only admins can change the hooks, mcpServers or permissionMode/);
  assert.equal((await put(ed, '---\nname: helper\ndescription: Helps\npermissionMode: bypassPermissions\n---\nHelp.\n')).status, 403, 'editor adds a permission mode');
  const skillHook = '---\nname: s\ndescription: S\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: touch /tmp/owned\n---\nx\n';
  assert.equal((await put(ed, skillHook, '.claude/skills/s/SKILL.md')).status, 403, 'editor adds a hook to a skill');
  assert.equal((await put(ed, skillHook, '.claude/_disabled/skills/s/SKILL.md')).status, 403, 'editor adds a hook to a switched-off skill');

  // An admin may; an editor can then change the rest of the file, but not those fields.
  assert.equal((await put(admin, withMcp)).status, 200);
  assert.equal((await put(ed, withMcp.replace('description: Helps', 'description: Helps more'))).status, 200, 'editor changes the description');
  assert.equal((await put(ed, withMcp.replace("'touch /tmp/owned'", "'curl example.com'"))).status, 403, 'editor changes the MCP command');
  // Plain agents stay open to editors.
  assert.equal((await put(ed, '---\nname: plain\ndescription: Plain agent\n---\nHi\n', '.claude/agents/plain.md')).status, 200);

  // A zip import is checked the same way, before anything is written.
  const zip = new JSZip();
  zip.file('agents/zipped.md', withMcp.replace('name: helper', 'name: zipped'));
  r = await ed.req('PUT', `/api/projects/${pid}/config/import?root=.claude`, undefined, { raw: await zip.generateAsync({ type: 'nodebuffer' }) });
  assert.equal(r.status, 403, 'editor imports an agent with an MCP server');
  assert.equal((await ed.req('GET', `/api/projects/${pid}/config/file?path=.claude/agents/zipped.md`)).status, 404);
});

test('names that Windows would open as another file are refused', async () => {
  // A trailing dot is dropped and SETTIN~1.JSO is the short name of settings.json, so either could reach an
  // admin-only file, or an agent file, without the checks seeing it.
  for (const p of ['.claude/settings.json.', '.claude/SETTIN~1.JSO', '.claude/agents/sneaky.md.']) {
    const r = await ed.req('PUT', `/api/projects/${pid}/config/file`, { path: p, content: '{"hooks": {}}' });
    assert.equal(r.status, 400, p);
  }
  // A skill's extra files cannot replace its SKILL.md under another spelling.
  await ed.put(`/api/projects/${pid}/skills/lookalike`, { description: 'Look-alike', body: 'Body' });
  for (const p of ['skill.md', 'Skill.MD', 'SKILL.md.']) {
    const r = await ed.req('PUT', `/api/projects/${pid}/skills/lookalike/file`, { path: p, content: '---\nname: lookalike\nhooks: x\n---\n' });
    assert.equal(r.status, 400, p);
  }
});

test('agent import: editors lose hooks, MCP servers and permission modes; admins keep them', async () => {
  const parsed = (name: string) => [{
    kind: 'agent',
    name,
    description: 'Imported',
    tools: [],
    prompt: 'Work.',
    extra: { color: 'blue', permissionMode: 'bypassPermissions', 'mcp-servers': 'x', 'note\nhooks': 'y' },
  }];
  const read = async (name: string) => (await admin.get(`/api/projects/${pid}/config/file?path=.claude/agents/${name}.md`)).content as string;

  await ed.post(`/api/projects/${pid}/builder/import/confirm`, { items: [{ kind: 'agent', name: 'imported', choice: 'overwrite' }], parsed: parsed('imported') });
  const byEditor = await read('imported');
  assert.match(byEditor, /color: blue/);
  assert.equal(frontmatterCommandFields(byEditor), '', byEditor);
  assert.doesNotMatch(byEditor, /hooks/);

  await admin.post(`/api/projects/${pid}/builder/import/confirm`, { items: [{ kind: 'agent', name: 'imported-admin', choice: 'overwrite' }], parsed: parsed('imported-admin') });
  assert.match(await read('imported-admin'), /permissionMode: bypassPermissions/);
});

test('runs start only the portal\'s own MCP servers', async () => {
  await admin.put(`/api/projects/${pid}/config/file`, { path: '.claude/agents/mcp-check.md', content: '---\nname: mcp-check\ndescription: Checks\n---\nHi\n' });
  const { run } = await ed.post(`/api/projects/${pid}/builder/test`, { name: 'mcp-check', type: 'agent', prompt: 'Say hi. [metered]' });
  await runEnded(ed, run.id);
  assert.equal(calls().at(-1).options.strictMcpConfig, true);
});

/* ------------------------------------------------------------------ */
/* 2. Checks that time out                                             */
/* ------------------------------------------------------------------ */

test('a check that times out stops its whole process tree and returns', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-check-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = path.join(dir, 'parent.cjs');
  // The check starts a grandchild that shares its output, as `npm test` starts node.
  fs.writeFileSync(script, [
    "const { spawn } = require('node:child_process');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    "console.log('started');",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const { runPipeline } = await import('../server/loop-verification.ts');
  const started = Date.now();
  const r = await runPipeline([{ step: 'slow check', kind: 'cmd', cmd: `"${process.execPath}" "${script}"`, timeout: 2, required: true } as any], dir, '');
  assert.equal(r.overall_ok, false);
  assert.equal(r.steps[0].ok, false);
  assert.match(r.steps[0].output, /started[\s\S]*timed out/);
  assert.ok(Date.now() - started < 15_000, `returned after ${Date.now() - started} ms`);

  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = () => {
    try {
      process.kill(grandchild, 0);
      return true;
    } catch {
      return false;
    }
  };
  await waitFor(async () => !alive(), 'the grandchild to be stopped', 10_000);
});

/* ------------------------------------------------------------------ */
/* 3–4. Worktree cleanup                                               */
/* ------------------------------------------------------------------ */

function gitRun(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

test('worktree cleanup keeps unpushed commits, deletes pushed work and unregisters the worktree', async () => {
  const { cleanupWorktrees } = await import('../server/control-plane.ts');
  const { all: dbAll } = await import('../server/db.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-wt-'));
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  gitRun(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'README.md'), 'hello\n');
  gitRun(seed, 'add', '.');
  gitRun(seed, 'commit', '-q', '-m', 'first');
  gitRun(root, 'clone', '-q', '--bare', seed, 'origin.git');
  gitRun(root, 'clone', '-q', path.join(root, 'origin.git'), 'clone');
  const clone = path.join(root, 'clone');
  const pdir = path.join(root, 'project');
  const runFolder = path.join(pdir, 'work', 'r_wt1');
  const wt = path.join(runFolder, 'repo');
  fs.mkdirSync(runFolder, { recursive: true });
  gitRun(clone, 'worktree', 'add', '-q', '--detach', wt, 'origin/main');
  const { wid } = await insertSession('done', { workDir: 'work/r_wt1' });

  // The agent committed but the commit was never pushed: the folder stays and the session is told.
  fs.writeFileSync(path.join(wt, 'change.txt'), 'work\n');
  gitRun(wt, 'add', '.');
  gitRun(wt, 'commit', '-q', '-m', 'agent work');
  await cleanupWorktrees(() => pdir, 1);
  assert.ok(fs.existsSync(path.join(wt, 'change.txt')), 'the unpushed commit is kept');
  const flags = dbAll<any>("SELECT body FROM workflow_events WHERE workflow_id = ? AND kind = 'worktree_dirty'", wid);
  assert.equal(flags.length, 1);
  assert.match(flags[0].body, /never pushed/);

  // Once pushed, the folder goes, and the clone forgets the worktree.
  gitRun(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/agent/x');
  await cleanupWorktrees(() => pdir, 1);
  assert.ok(!fs.existsSync(runFolder), 'the pushed run folder is deleted');
  const list = gitRun(clone, 'worktree', 'list', '--porcelain');
  assert.ok(!list.includes('r_wt1'), list);
});

test('worktree cleanup keeps a working copy that git cannot check', async () => {
  const { cleanupWorktrees } = await import('../server/control-plane.ts');
  const { all: dbAll } = await import('../server/db.ts');
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-wt-bad-'));
  const broken = path.join(pdir, 'work', 'r_wt2', 'repo');
  fs.mkdirSync(broken, { recursive: true });
  // A worktree whose repository is gone: every git command in it fails.
  fs.writeFileSync(path.join(broken, '.git'), `gitdir: ${path.join(pdir, 'missing', '.git', 'worktrees', 'repo')}\n`);
  fs.writeFileSync(path.join(broken, 'notes.txt'), 'unsaved\n');
  const { wid } = await insertSession('stopped', { workDir: 'work/r_wt2' });
  await cleanupWorktrees(() => pdir, 1);
  assert.ok(fs.existsSync(path.join(broken, 'notes.txt')), 'kept');
  const flags = dbAll<any>("SELECT body FROM workflow_events WHERE workflow_id = ? AND kind = 'worktree_dirty'", wid);
  assert.match(String(flags[0]?.body), /could not be checked/);
});

/* ------------------------------------------------------------------ */
/* 5. The LLM judge                                                    */
/* ------------------------------------------------------------------ */

test('the LLM judge step runs and its run is recorded', async () => {
  const { runPipeline } = await import('../server/loop-verification.ts');
  const { one: dbOne } = await import('../server/db.ts');
  const r = await runPipeline([{ step: 'judge', kind: 'llm', rubric: 'Do the tests pass?' } as any], os.tmpdir(), 'All 12 tests pass.', { projectId: pid, userId: adminId, workflowId: 'w_judge' });
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].advisory, true);
  assert.equal(r.steps[0].ok, true);
  assert.match(r.steps[0].output, /the summary says the tests pass/);
  const run = dbOne<any>("SELECT kind, model, cost_usd FROM agent_runs WHERE kind = 'verify' AND meta LIKE '%w_judge%'");
  assert.ok(run, 'the judge run is recorded');
  assert.ok(Number(run.cost_usd) > 0, 'and its cost counts');
});

/* ------------------------------------------------------------------ */
/* 6. Wall-clock limit across a restart                                */
/* ------------------------------------------------------------------ */

test('the wall-clock rule keeps counting when a session is resumed after a restart', async () => {
  const { run: dbRun, one: dbOne } = await import('../server/db.ts');
  const { kick } = await import('../server/workflows/driver.ts');
  const { wid } = await insertSession('running', {});
  // The session's stretch started two hours ago; the spec allows one minute. A restart resumes it with kick().
  dbRun(
    "INSERT INTO loop_run_states (workflow_id, iteration, failures, last_check, summaries, spec_snapshot, updated_at, burst_start, wall_clock_started_at) VALUES (?, 0, 0, 'null', '[]', ?, ?, 0, ?)",
    wid, JSON.stringify({ stop_rules: { wallClockMinutes: 1 } }), new Date().toISOString(), new Date(Date.now() - 2 * 3600_000).toISOString(),
  );
  kick(wid);
  const w = await waitFor(async () => {
    const row = dbOne<any>('SELECT status, stop_reason FROM workflows WHERE id = ?', wid);
    return row && row.status !== 'running' ? row : null;
  }, 'the session to stop');
  assert.equal(w.status, 'paused');
  assert.match(w.stop_reason, /1-minute wall-clock limit/);
  // Pausing ends the stretch, so resuming starts a new window.
  assert.equal(dbOne<any>('SELECT wall_clock_started_at FROM loop_run_states WHERE workflow_id = ?', wid)?.wall_clock_started_at, null);
});

/* ------------------------------------------------------------------ */
/* 7. Short paths in stdio integrations                                */
/* ------------------------------------------------------------------ */

test('stdio integrations accept Windows short paths with ~', async () => {
  const r = await admin.req('POST', '/api/integrations', { kind: 'stdio', name: 'Short path', command: 'C:\\PROGRA~1\\nodejs\\node.exe', args: ['server.js'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await admin.req('POST', '/api/integrations', { kind: 'stdio', name: 'With args', command: 'node server.js; rm -rf /' })).status, 400, 'still no arguments or shell syntax');
});
