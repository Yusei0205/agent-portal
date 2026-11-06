import { it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { createRunnerTerminal, terminalGitEnv } from '../server/agent/runner-terminal.ts';
import { signTerminalGrant, verifyTerminalGrant, terminalPublicKey } from '../server/agent/runner-terminal-auth.ts';

const payload = { workflowId: 'workflow-fixture', origin: 'https://portal.example', snapshot: { putUrl: 'https://fixture.s3.amazonaws.com/workspace' } };
const secret = randomBytes(32).toString('hex');
const repo = (name: string, token: string) => ({ name, url: `https://github.com/team/${name}.git`, env: {
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'http.https://github.com/.extraHeader', GIT_CONFIG_VALUE_1: `Authorization: Basic ${token}`,
} });
const signed = (repos?: ReturnType<typeof repo>[]) => ({ ...payload, ...(repos ? { repos } : {}), grant: signTerminalGrant(secret, { ...payload, repos, actor: 'fixture-user', engine: 'codex' }) });
const verifyGrant = async (body: Record<string, unknown>) => verifyTerminalGrant(body, terminalPublicKey(secret), 'codex');
async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('Terminal event timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function client(url: string, ticket: string, origin = payload.origin) {
  const ws = new WebSocket(url, { origin }); const messages: any[] = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  ws.on('error', () => {});
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'start', ticket, cols: 120, rows: 40 }));
  return { ws, messages };
}

it('binds one-use terminal tickets, tolerates proxy origins, and carries input, resize and bounded UTF-8 output', async () => {
  let spawned = 0, saved = 0;
  let data: (s: string) => void = () => {};
  let exit: (e: { exitCode: number }) => void = () => {};
  const sizes: number[][] = [];
  const clients: WebSocket[] = [];
  const terminal = createRunnerTerminal({ engine: 'codex', verifyGrant, prepare: async () => process.cwd(), save: async () => { saved++; }, loadPty: async () => ({
    spawn: (_file, _args, options) => {
      spawned++; assert.equal(options.cols, 120); assert.equal(options.env.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(options.env.PORTAL_SECRET_KEY, undefined);
      assert.equal(options.env.GIT_CONFIG_VALUE_2, 'Authorization: Basic shell-fixture');
      return { write: s => data('output:' + s), resize: (cols, rows) => sizes.push([cols, rows]),
        kill: () => exit({ exitCode: 0 }), onData: cb => { data = cb; }, onExit: cb => { exit = cb; } };
    },
  }) });
  const server = http.createServer(); terminal.attach(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;
  try {
    const authorization = signed([repo('first', 'shell-fixture')]);
    const issued = await terminal.issue(authorization);
    await assert.rejects(terminal.issue(authorization), /already been used/);
    const bad = await client(url, 'not-a-terminal-ticket', 'https://other.example');
    clients.push(bad.ws);
    const [badCode] = await once(bad.ws, 'close'); assert.equal(badCode, 1008); assert.equal(spawned, 0);
    const good = await client(url, String(issued.ticket), 'http://proxy.internal');
    clients.push(good.ws);
    await until(() => good.messages.some(m => m.type === 'ready'));
    assert.equal(terminal.busy(), true);
    good.ws.send(JSON.stringify({ type: 'input', data: Buffer.from('hello \u4e16\u754c').toString('base64') }));
    good.ws.send(JSON.stringify({ type: 'resize', cols: 9999, rows: 9999 }));
    await until(() => sizes.length === 1 && good.messages.some(m => m.type === 'output'));
    assert.deepEqual(sizes[0], [500, 200]);
    assert.equal(Buffer.from(good.messages.find(m => m.type === 'output').data, 'base64').toString(), 'output:hello \u4e16\u754c');
    data('\u4e16'.repeat(30_000));
    await until(() => good.messages.filter(m => m.type === 'output').slice(1).reduce((n, m) => n + Buffer.from(m.data, 'base64').length, 0) === 90_000);
    assert.equal(Buffer.concat(good.messages.filter(m => m.type === 'output').slice(1).map(m => Buffer.from(m.data, 'base64'))).toString(), '\u4e16'.repeat(30_000));
    assert.ok(good.messages.every(m => Buffer.byteLength(JSON.stringify(m)) < 32_768));
    const replay = await client(url, String(issued.ticket)); const [replayCode] = await once(replay.ws, 'close');
    clients.push(replay.ws);
    assert.equal(replayCode, 1008); assert.equal(spawned, 1);
    await assert.rejects(terminal.issue({ ...signed(), workflowId: 'another-workflow' }), /another session/);
    good.ws.close(); await once(good.ws, 'close');
    await until(() => saved === 1 && !terminal.busy());
  } finally { for (const ws of clients) ws.terminate(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('opens a real isolated shell over WebSocket and saves after the process closes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-terminal-test-')); let saved = false;
  const terminal = createRunnerTerminal({ engine: 'codex', verifyGrant, prepare: async () => root, save: async () => { saved = true; } });
  const server = http.createServer(); terminal.attach(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let ws: WebSocket | undefined;
  try {
    const issued = await terminal.issue(signed());
    const connected = await client(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`, String(issued.ticket));
    ws = connected.ws;
    await until(() => connected.messages.some(m => m.type === 'ready'));
    ws.send(JSON.stringify({ type: 'input', data: Buffer.from(process.platform === 'win32'
      ? "Write-Output ('terminal-' + 'smoke')\r\n" : "printf 'terminal-%s\\n' 'smoke'\n").toString('base64') }));
    await until(() => connected.messages.filter(m => m.type === 'output').map(m => Buffer.from(m.data, 'base64').toString()).join('').includes('terminal-smoke'), 20_000);
    ws.close(); await once(ws, 'close'); await until(() => saved && !terminal.busy());
  } finally {
    ws?.terminate(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('portal-terminal-test-')) await fs.rm(root, { recursive: true, force: true });
  }
});

it('requires a portal signature and binds the grant to engine, workspace, origin and expiry', async () => {
  const body = signed(), key = terminalPublicKey(secret);
  assert.match(verifyTerminalGrant(body, key, 'codex').nonce, /^[a-f0-9]{64}$/);
  assert.throws(() => verifyTerminalGrant(body, terminalPublicKey(randomBytes(32).toString('hex')), 'codex'), /signature/);
  assert.throws(() => verifyTerminalGrant(body, key, 'kiro'), /mismatched/);
  assert.throws(() => verifyTerminalGrant({ ...body, origin: 'https://other.example' }, key, 'codex'), /mismatched/);
  assert.throws(() => verifyTerminalGrant({ ...body, snapshot: { putUrl: 'https://other.s3.amazonaws.com/object' } }, key, 'codex'), /mismatched/);
  const repos = [repo('first', 'fixture-secret')];
  const withGit = { ...payload, repos, grant: signTerminalGrant(secret, { ...payload, repos, actor: 'fixture-user', engine: 'codex' }) };
  assert.doesNotThrow(() => verifyTerminalGrant(withGit, key, 'codex'));
  assert.equal(Buffer.from(withGit.grant.split('.')[0], 'base64url').toString().includes('fixture-secret'), false);
  assert.throws(() => verifyTerminalGrant({ ...withGit, repos: [repo('first', 'changed-secret')] }, key, 'codex'), /mismatched/);
  assert.throws(() => verifyTerminalGrant({ ...body, repos }, key, 'codex'), /mismatched/);
  const realNow = Date.now;
  try { Date.now = () => realNow() + 61_000; assert.throws(() => verifyTerminalGrant(body, key, 'codex'), /Expired/); }
  finally { Date.now = realNow; }
  const terminal = createRunnerTerminal({ engine: 'codex', prepare: async () => { throw new Error('Must not start'); }, save: async () => {} });
  await assert.rejects(terminal.issue(payload), /Signed terminal grant required/);
});

it('authenticates each attached repository separately without writing credentials to Git config', async () => {
  const env = terminalGitEnv([repo('first', 'first-secret'), repo('second', 'second-secret')]);
  const config = (url: string) => spawnSync('git', ['config', '--get-urlmatch', 'http.extraHeader', url], {
    encoding: 'utf8', env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull }, windowsHide: true,
  }).stdout.trim();
  assert.equal(config('https://github.com/team/first.git'), 'Authorization: Basic first-secret');
  assert.equal(config('https://github.com/team/first'), 'Authorization: Basic first-secret');
  assert.equal(config('https://github.com/team/second.git'), 'Authorization: Basic second-secret');
  for (const url of ['https://github.com/team/unattached.git', 'https://other.example/team/first.git', 'http://github.com/team/first.git', 'https://github.com/team/first-extra.git']) assert.equal(config(url), '');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  const foreign = terminalGitEnv([{ ...repo('first', 'must-not-leak'), url: 'https://foreign.example/team/first.git' }]);
  assert.equal(Object.values(foreign).some(v => v.includes('must-not-leak')), false);
  assert.throws(() => terminalGitEnv([{ ...repo('first', 'fixture'), url: 'https://user:password@github.com/team/first.git' }]), /Invalid/);
});
