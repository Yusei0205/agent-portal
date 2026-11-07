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
let externalAuth;
let refreshReply;
const fixtureJwt = claims => 'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture';
const fixtureAuth = () => ({ auth_mode: 'chatgpt', tokens: {
  access_token: fixtureJwt({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }),
  refresh_token: 'fake-secret-never-display', account_id: 'fixture-chatgpt-account', id_token: fixtureJwt({ email: 'codex@example.test' }),
} });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (!msg.method) {
    if (msg.id === 900 && approvalReply) { const reply = approvalReply; approvalReply = null; reply(msg.result); }
    if (msg.id === 901 && refreshReply) { const reply = refreshReply; refreshReply = null; reply(msg.result); }
    return;
  }
  const { method, id, params = {} } = msg;
  if (method === 'thread/start' || method === 'thread/resume') threadSetup = params;
  const reply = result => send({ id, result });
  if (method === 'initialize') { initialized = true; reply({ userAgent: 'fixture' }); return; }
  if (method === 'initialized') return;
  if (!initialized) { send({ id, error: { code: -1, message: 'Not initialized' } }); return; }
  if (method === 'account/read') {
    if (params.refreshToken && fs.existsSync(authFile)) {
      const auth = fixtureAuth(); auth.tokens.refresh_token += '-rotated'; fs.writeFileSync(authFile, JSON.stringify(auth));
    }
    reply({ account: fs.existsSync(authFile) || externalAuth ? { type: 'chatgpt', email: 'codex@example.test', planType: 'plus' } : null });
  } else if (method === 'account/login/start') {
    if (params.type === 'chatgptAuthTokens') { externalAuth = params; reply({ type: 'chatgptAuthTokens' }); return; }
    reply({ type: 'chatgptDeviceCode', loginId: 'login-fixture', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-1234' });
    setTimeout(() => {
      fs.writeFileSync(authFile, JSON.stringify(fixtureAuth()));
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
    if (!params.input?.[0]?.text?.includes('EARLY_USAGE')) notify('turn/started', { threadId: thread, turn: { id: scope.turnId } });
    const prompt = params.input?.[0]?.text || '';
    if (prompt.includes('COLLAB_AGENTS')) {
      const item = { id: 'spawn-1', type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: thread, receiverThreadIds: ['child-1'], prompt: 'Review API changes', status: 'completed', agentsStates: { 'child-1': { status: 'running' } } };
      notify('item/completed', { ...scope, item });
      notify('item/completed', { ...scope, item: { ...item, id: 'wait-1', tool: 'wait', agentsStates: { 'child-1': { status: 'completed', message: 'Reviewed API' } } } });
      notify('turn/completed', { threadId: thread, turn: { id: scope.turnId, status: 'completed' } }); return;
    }
    if (prompt.includes('REQUEST_AUTH_REFRESH')) {
      refreshReply = tokens => {
        notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta: tokens?.chatgptAccountId === externalAuth?.chatgptAccountId ? 'Renewed account' : 'Renewal failed' });
        notify('turn/completed', { threadId: thread, turn: { id: scope.turnId, status: 'completed' } });
      };
      send({ id: 901, method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized', previousAccountId: externalAuth?.chatgptAccountId } }); return;
    }
    if (prompt.includes('EXTERNAL_AUTH')) {
      notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta: JSON.stringify({ external: Boolean(externalAuth), account: externalAuth?.chatgptAccountId, authOnDisk: fs.existsSync(authFile) }) });
      notify('turn/completed', { threadId: thread, turn: { id: scope.turnId, status: 'completed' } }); return;
    }
    if (prompt.includes('EXIT_PROCESS')) { process.exit(7); }
    if (prompt.includes('HANG_FOREVER')) return;
    if (prompt.includes('MCP_FAILURE')) {
      notify('item/completed', { ...scope, item: { id: 'mcp-failure', type: 'mcpToolCall', tool: 'create_pull_request', status: 'failed', error: { message: 'user rejected MCP tool call' } } });
      notify('turn/completed', { threadId: thread, turn: { id: scope.turnId, status: 'completed' } }); return;
    }
    if (prompt.includes('REQUEST_PORTAL_PR')) {
      void (async () => {
        if (threadSetup.config.mcp_servers.portal_pr.tools?.create_pull_request?.approval_mode !== 'approve') {
          notify('item/completed', { ...scope, item: { id: 'pr-denied', type: 'mcpToolCall', tool: 'create_pull_request', status: 'failed', error: { message: 'user rejected MCP tool call' } } });
          notify('turn/completed', { threadId: thread, turn: { id: scope.turnId, status: 'completed' } }); return;
        }
        const url = threadSetup.config.mcp_servers.portal_pr.url;
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_pull_request', arguments: { repo: 'shop', base: 'main_v3' } } }) });
        const result = await response.json();
        notify('item/agentMessage/delta', { ...scope, itemId: 'answer', delta: result.result.content[0].text });
        notify('turn/completed', { threadId: thread, turn: { id: scope.turnId, status: 'completed' } });
      })().catch(() => process.exit(8));
      return;
    }
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
    notify('thread/tokenUsage/updated', { ...scope, tokenUsage: { ...(prompt.includes('TOTAL_ONLY') ? {} : { last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5 } }), total: { inputTokens: 140, outputTokens: 28, cachedInputTokens: 5 } } });
    notify('turn/completed', { threadId: thread, turn: { id: scope.turnId, status: 'completed' } });
  } else send({ id, error: { code: -32601, message: 'Unknown method ' + method } });
});
