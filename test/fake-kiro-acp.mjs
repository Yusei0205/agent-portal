// A stand-in for `kiro-cli acp` that speaks just enough ACP for the portal, and logs what it saw.
// The log (JSON lines) goes to FAKE_KIRO_LOG so the test process can assert on it.
import fs from 'node:fs';
import path from 'node:path';

const log = (entry) => {
  if (process.env.FAKE_KIRO_LOG) fs.appendFileSync(process.env.FAKE_KIRO_LOG, JSON.stringify(entry) + '\n');
};

const args = process.argv.slice(2);
const agent = args[args.indexOf('--agent') + 1];
const profileFile = path.join(process.cwd(), '.kiro', 'agents', `${agent}.json`);
const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
log({
  event: 'start',
  args,
  cwd: process.cwd(),
  profile,
  env: {
    KIRO_API_KEY: process.env.KIRO_API_KEY ?? null,
    PORTAL_SECRET_KEY: process.env.PORTAL_SECRET_KEY ?? null,
    PORTAL_SHOULD_NOT_LEAK: process.env.PORTAL_SHOULD_NOT_LEAK ?? null,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? null,
  },
});

const MODELS = {
  currentModelId: 'auto',
  availableModels: [
    { modelId: 'auto', name: 'auto' },
    { modelId: 'claude-opus-5.5', name: 'claude-opus-5.5' },
    { modelId: 'claude-sonnet-5.5', name: 'claude-sonnet-5.5' },
    { modelId: 'claude-sonnet-5', name: 'claude-sonnet-5' },
    { modelId: 'claude-haiku-4.5', name: 'claude-haiku-4.5' },
  ],
};

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
let reqId = 0;
const pendingReq = new Map();
const askPermission = (sessionId, toolCall) =>
  new Promise((resolve) => {
    const id = `perm-${++reqId}`;
    pendingReq.set(id, resolve);
    send({ id, method: 'session/request_permission', params: { sessionId, toolCall, options: [
      { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'No', kind: 'reject_once' },
    ] } });
  });

async function toolCall(sessionId, id, kiroName, kind, rawInput, needsPermission) {
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: id, title: `${kiroName} call`, kind, rawInput, _meta: { kiro: { toolName: kiroName } } });
  let decision = 'allow_once';
  if (needsPermission) {
    const r = await askPermission(sessionId, { toolCallId: id, title: `${kiroName} call`, rawInput });
    decision = r.outcome?.optionId ?? r.outcome?.outcome;
    log({ event: 'permission', tool: kiroName, rawInput, decision });
  }
  const ok = decision === 'allow_once';
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', rawOutput: { items: [{ Text: ok ? `${kiroName} ok` : 'rejected' }] } });
}

async function runPrompt(sessionId, text) {
  const chunk = (t) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
  if (!profile.tools.length) {
    chunk('O');
    chunk('K');
  } else if (text.includes('[mcp]')) {
    // An integration tool that would change something; the portal must refuse it for a read-only integration.
    const server = Object.keys(profile.mcpServers)[0];
    await toolCall(sessionId, 't-mcp', `@${server}/create_issue`, 'other', { summary: 'x' }, true);
    send({ method: '_kiro.dev/mcp/server_init_failure', params: { sessionId, serverName: 'broken', error: 'could not connect\nmore' } });
    chunk('Tried.');
  } else if (text.includes('[delegate]') && profile.tools.includes('subagent')) {
    // What kiro-cli 2.33 does when the main agent delegates (seen with a live probe): a "subagent" crew call that asks
    // first, then a separate session per stage, announced by subagent/list_update, whose tools ask for themselves.
    const work = /(work\/r_[A-Za-z0-9_-]+)/.exec(text)?.[1] ?? 'work/unknown';
    const role = profile.toolsSettings.subagent.availableAgents[0];
    const roleProfile = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.kiro', 'agents', `${role}.json`), 'utf8'));
    log({ event: 'role-profile', role, roleProfile });
    chunk('Delegating.');
    const crew = { task: 'Write the notes', mode: 'blocking', stages: [{ name: 'write_notes', role, prompt_template: 'Write notes.md' }] };
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't-crew', title: 'Spawning agent crew', rawInput: crew, _meta: { kiro: { toolName: 'subagent' } } });
    const ok = await askPermission(sessionId, { toolCallId: 't-crew', title: 'Spawning agent crew', rawInput: crew });
    log({ event: 'permission', tool: 'subagent', decision: ok.outcome?.optionId });
    const sub = { sessionId: 'kiro-sub-1', sessionName: 'write_notes', agentName: role, initialQuery: 'Write notes.md', status: { type: 'working' }, role };
    send({ method: '_kiro.dev/subagent/list_update', params: { subagents: [sub], pendingStages: [] } });
    update('kiro-sub-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Writing the notes.' } });
    await toolCall('kiro-sub-1', 't-sub-out', 'write', 'edit', { command: 'create', path: path.resolve(process.cwd(), '..', 'escape.txt'), content: 'x' }, true);
    await toolCall('kiro-sub-1', 't-sub-in', 'write', 'edit', { command: 'create', path: path.join(process.cwd(), work, 'notes.md'), content: '# notes' }, true);
    update('kiro-sub-1', { sessionUpdate: 'tool_call', toolCallId: 't-sum', title: 'Summarizing', rawInput: { taskDescription: 'Write notes.md', taskResult: 'Wrote notes.md.' }, _meta: { kiro: { toolName: 'summary' } } });
    update('kiro-sub-1', { sessionUpdate: 'tool_call_update', toolCallId: 't-sum', status: 'completed' });
    send({ method: '_kiro.dev/metadata', params: { sessionId: 'kiro-sub-1', meteringUsage: [{ value: 0.05, unit: 'credit' }] } });
    send({ method: '_kiro.dev/subagent/list_update', params: { subagents: [{ ...sub, status: { type: 'terminated' } }], pendingStages: [] } });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't-crew', status: 'completed', rawOutput: { items: [{ Text: 'crew done' }] } });
    chunk('All done.');
  } else {
    const work = /(work\/r_[A-Za-z0-9_-]+)/.exec(text)?.[1] ?? 'work/unknown';
    chunk('Working on it.');
    await toolCall(sessionId, 't-read', 'read', 'read', { operations: [{ mode: 'Line', path: path.join(process.cwd(), 'CLAUDE.md') }] }, false);
    const outside = path.resolve(process.cwd(), '..', 'outside.txt');
    await toolCall(sessionId, 't-out', 'write', 'edit', { command: 'create', path: outside, content: 'x' }, true);
    await toolCall(sessionId, 't-in', 'write', 'edit', { command: 'create', path: path.join(process.cwd(), work, 'notes.md'), content: '# notes' }, true);
    await toolCall(sessionId, 't-sh', 'shell', 'execute', { command: 'npm test' }, true);
    chunk('Done');
    chunk(' here.');
  }
  send({ method: '_kiro.dev/metadata', params: { sessionId, contextUsagePercentage: 3, meteringUsage: [{ value: 0.125, unit: 'credit' }, { value: 0.075, unit: 'credit' }] } });
  return { stopReason: 'end_turn' };
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (!m.method && pendingReq.has(m.id)) {
      pendingReq.get(m.id)(m.result ?? {});
      pendingReq.delete(m.id);
      continue;
    }
    log({ event: 'rpc', method: m.method, params: m.params });
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'fake-kiro', version: '0' } } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'kiro-sess-1', modes: { currentModeId: agent }, models: MODELS } });
    else if (m.method === 'session/load') {
      // History replay that the portal must ignore.
      update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD HISTORY' } });
      send({ id: m.id, result: { modes: { currentModeId: agent }, models: MODELS } });
    } else if (m.method === 'session/set_model') send({ id: m.id, result: {} });
    else if (m.method === 'session/prompt') {
      const text = m.params.prompt.map((p) => p.text).join('\n');
      runPrompt(m.params.sessionId, text).then((result) => send({ id: m.id, result }));
    } else if (m.method === 'session/cancel') {
      /* notification */
    } else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'not supported' } });
  }
});
process.stdin.on('end', () => process.exit(0));
