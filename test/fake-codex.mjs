// Protocol fixture: exercises the real stdio transport without model calls or real credentials.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const home = process.env.CODEX_HOME;
const authFile = path.join(home, 'auth.json');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
let initialized = false;
let thread = 'thread-fixture';
let approvalReply;
let threadSetup;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (!msg.method) { if (msg.id === 900 && approvalReply) { const reply = approvalReply; approvalReply = null; reply(msg.result); } return; }
  const { method, id, params = {} } = msg;
  if (method === 'thread/start' || method === 'thread/resume') threadSetup = params;
  const reply = result => send({ id, result });
  if (method === 'initialize') { initialized = true; reply({ userAgent: 'fixture' }); return; }
  if (method === 'initialized') return;
  if (!initialized) { send({ id, error: { code: -1, message: 'Not initialized' } }); return; }
  if (method === 'account/read') {
    reply({ account: fs.existsSync(authFile) ? { type: 'chatgpt', email: 'codex@example.test', planType: 'plus' } : null });
  } else if (method === 'account/login/start') {
    reply({ type: 'chatgptDeviceCode', loginId: 'login-fixture', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-1234' });
    setTimeout(() => {
      fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'fake-secret-never-display' } }));
      notify('account/login/completed', { loginId: 'login-fixture', success: true });
    }, 50);
  } else if (method === 'account/logout') {
    fs.rmSync(authFile, { force: true }); reply({});
  } else if (method === 'model/list') {
    reply({ data: [{ model: 'fixture-model', displayName: 'Fixture model', isDefault: true }], nextCursor: null });
  } else if (method === 'thread/start' || method === 'thread/resume') {
    if (method === 'thread/resume') thread = params.threadId;
    reply({ thread: { id: thread }, model: params.model || 'fixture-model' });
    notify('thread/tokenUsage/updated', { threadId: thread, turnId: 'previous-turn', tokenUsage: { last: { inputTokens: 10, outputTokens: 3 }, total: { inputTokens: 40, outputTokens: 8 } } });
  } else if (method === 'turn/start') {
    const scope = { threadId: thread, turnId: 'turn-fixture' };
    reply({ turn: { id: scope.turnId, status: 'inProgress' } });
    notify('turn/started', { threadId: thread, turn: { id: scope.turnId } });
    const prompt = params.input?.[0]?.text || '';
    if (prompt.includes('EXIT_PROCESS')) { process.exit(7); }
    if (prompt.includes('HANG_FOREVER')) return;
    if (prompt.includes('ASK_PERMISSION')) {
      notify('item/started', { ...scope, item: { id: 'approval-command', type: 'commandExecution', command: 'echo changed', cwd: process.cwd() } });
      approvalReply = result => {
        notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta: result?.decision === 'accept' ? 'Approved action' : 'Declined action' });
        notify('turn/completed', { threadId: thread, turn: { id: scope.turnId, status: 'completed' } });
      };
      send({ id: 900, method: 'item/commandExecution/requestApproval', params: { ...scope, itemId: 'approval-command', command: 'echo changed' } });
      return;
    }
    if (prompt.includes('ECHO_TOKEN')) {
      notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta: process.env.ACCESS_TOKEN || 'no-token' });
      notify('turn/completed', { threadId: thread, turn: { id: scope.turnId, status: 'completed' } });
      return;
    }
    if (prompt.includes('ECHO_SETUP')) {
      notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta: JSON.stringify({ instructions: threadSetup.developerInstructions, config: threadSetup.config }) });
      notify('turn/completed', { threadId: thread, turn: { id: scope.turnId, status: 'completed' } });
      return;
    }
    if (prompt.includes('FAIL_TURN')) {
      notify('turn/completed', { threadId: thread, turn: { id: scope.turnId, status: 'failed', error: { message: 'Usage limit exceeded' } } }); return;
    }
    notify('item/started', { ...scope, item: { id: 'cmd1', type: 'commandExecution', command: 'git status', cwd: process.cwd() } });
    notify('item/completed', { ...scope, item: { id: 'cmd1', type: 'commandExecution', command: 'git status', status: 'completed', aggregatedOutput: 'clean' } });
    notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta: 'Hello ' });
    notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta: 'from Codex' });
    notify('item/completed', { ...scope, item: { id: 'answer', type: 'agentMessage', text: 'Hello from Codex' } });
    notify('thread/tokenUsage/updated', { ...scope, tokenUsage: { last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5 }, total: { inputTokens: 140, outputTokens: 28, cachedInputTokens: 5 } } });
    notify('turn/completed', { threadId: thread, turn: { id: scope.turnId, status: 'completed' } });
  } else send({ id, error: { code: -32601, message: 'Unknown method ' + method } });
});
