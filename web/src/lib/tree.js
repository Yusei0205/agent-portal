// Turns the flat run event log into a tree: main agent → subagents, each with its own timeline.
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

export function tierOf(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  return 'sonnet';
}

export function estimate(prices, model, u) {
  if (!prices || !u) return 0;
  let p = prices[tierOf(model)];
  if (!p) return 0;
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  if (p.longThreshold && p.long && prompt > p.longThreshold) p = { ...p, ...p.long };
  return ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output + (u.cache_read_input_tokens || 0) * p.cacheRead + (u.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
}

function newNode(id, extra) {
  return {
    id,
    label: 'Main agent',
    kind: 'main',
    status: 'running',
    children: [],
    items: [],
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    toolCount: 0,
    seenMessages: new Set(),
    ...extra,
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  return content == null ? '' : JSON.stringify(content);
}

export function buildTree(events, { prices, runStatus } = {}) {
  const root = newNode('main');
  const nodes = new Map([['main', root]]);
  const tools = new Map();
  const inputs = new Map();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  const nodeFor = (parent) => {
    if (!parent) return root;
    let n = nodes.get(parent);
    if (!n) {
      // Messages from a subagent whose launch we did not see (for example on a resumed run).
      n = newNode(parent, { label: 'Subagent', kind: 'subagent' });
      nodes.set(parent, n);
      root.children.push(n);
    }
    return n;
  };

  for (const e of ordered) {
    const d = e.data || {};
    if (e.type === 'system:init') {
      root.meta = d;
      root.model = d.model || root.model;
      root.items.push({ kind: 'system', seq: e.seq, text: `Session started${d.model ? ` on ${d.model}` : ''}`, data: d });
      // Claude reports the state of each integration's MCP server when the session starts.
      for (const s of Array.isArray(d.mcp_servers) ? d.mcp_servers : []) {
        if (s?.status && s.status !== 'connected') root.items.push({ kind: 'system', seq: e.seq, text: `Integration ${s.name} is ${s.status}: its tools are not available in this run.` });
      }
      continue;
    }
    if (e.type === 'system:mcp_failed') {
      root.items.push({ kind: 'system', seq: e.seq, text: `Integration ${d.server} could not start: ${String(d.error || '').split('\n')[0].slice(0, 200)}` });
      continue;
    }
    if (e.type === 'assistant') {
      const node = nodeFor(e.parent);
      const msg = d.message || {};
      if (msg.model) node.model = msg.model;
      const mid = msg.id || d.uuid || e.seq;
      if (msg.usage && !node.seenMessages.has(mid)) {
        node.seenMessages.add(mid);
        node.inputTokens += (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0);
        node.outputTokens += msg.usage.output_tokens || 0;
        node.cost += estimate(prices, msg.model || node.model, msg.usage);
      }
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type === 'text' && b.text?.trim()) node.items.push({ kind: 'text', seq: e.seq, text: b.text });
        else if (b.type === 'thinking' && b.thinking) node.items.push({ kind: 'thinking', seq: e.seq, text: b.thinking });
        else if (b.type === 'tool_use') {
          node.toolCount++;
          const item = { kind: 'tool', seq: e.seq, id: b.id, name: b.name, input: b.input || {}, status: 'running', result: null, isError: false };
          tools.set(b.id, item);
          node.items.push(item);
          if (SUBAGENT_TOOLS.has(b.name)) {
            const existing = nodes.get(b.id);
            const child = existing || newNode(b.id, { kind: 'subagent' });
            Object.assign(child, {
              label: b.input?.subagent_type || 'Subagent',
              description: b.input?.description || '',
              prompt: b.input?.prompt || '',
              parentId: node.id,
              startedSeq: e.seq,
            });
            if (!existing) {
              nodes.set(b.id, child);
              node.children.push(child);
            } else if (!node.children.includes(child)) {
              root.children = root.children.filter((c) => c !== child);
              node.children.push(child);
            }
            item.childId = b.id;
          }
        }
      }
      continue;
    }
    if (e.type === 'user') {
      const content = d.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== 'tool_result') continue;
        const item = tools.get(b.tool_use_id);
        if (item) {
          item.status = b.is_error ? 'failed' : 'done';
          item.isError = Boolean(b.is_error);
          item.result = textOf(b.content);
          item.endSeq = e.seq;
        }
        const child = nodes.get(b.tool_use_id);
        if (child) {
          child.status = b.is_error ? 'failed' : 'done';
          child.resultText = textOf(b.content);
          child.endedSeq = e.seq;
        }
      }
      continue;
    }
    if (e.type === 'portal:input') {
      const item = { kind: 'input', seq: e.seq, inputId: d.inputId, inputType: d.inputType, toolName: d.toolName, payload: d.payload, answered: null };
      inputs.set(d.inputId, item);
      root.items.push(item);
      continue;
    }
    if (e.type === 'portal:input_answered') {
      const item = inputs.get(d.inputId);
      if (item) item.answered = { response: d.response, by: d.by };
      continue;
    }
    if (e.type.startsWith('hook:')) {
      root.items.push({ kind: 'hook', seq: e.seq, text: `${e.type.slice(5)}${d.agent_type ? `: ${d.agent_type}` : ''}`, data: d });
      continue;
    }
    if (e.type.startsWith('result')) {
      root.result = d;
      root.status = d.subtype === 'success' && !d.is_error ? 'done' : 'failed';
      root.items.push({ kind: 'result', seq: e.seq, data: d });
      continue;
    }
    root.items.push({ kind: 'system', seq: e.seq, text: e.type, data: d });
  }

  const ended = ['completed', 'failed', 'stopped'].includes(runStatus);
  if (runStatus === 'waiting') root.status = 'waiting';
  else if (runStatus === 'stopped') root.status = 'stopped';
  else if (runStatus === 'failed') root.status = 'failed';
  else if (runStatus === 'completed') root.status = 'done';
  for (const n of nodes.values()) {
    if (ended && n.status === 'running') n.status = runStatus === 'completed' ? 'done' : 'stopped';
    for (const it of n.items) if (it.kind === 'tool' && ended && it.status === 'running') it.status = 'stopped';
    delete n.seenMessages;
  }
  const all = [...nodes.values()];
  root.totals = {
    cost: all.reduce((a, n) => a + n.cost, 0),
    inputTokens: all.reduce((a, n) => a + n.inputTokens, 0),
    outputTokens: all.reduce((a, n) => a + n.outputTokens, 0),
    tools: all.reduce((a, n) => a + n.toolCount, 0),
    subagents: all.length - 1,
  };
  return { root, nodes };
}

/** Short one-line description of a tool call for the timeline. */
export function toolSummary(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'Read':
      return i.file_path + (i.offset ? ` (from line ${i.offset})` : '');
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return i.file_path;
    case 'Grep':
      return `“${i.pattern}”${i.path ? ` in ${i.path}` : ''}`;
    case 'Glob':
      return i.pattern;
    case 'Bash':
      return i.command;
    case 'Agent':
    case 'Task':
      return `${i.subagent_type || 'subagent'}: ${i.description || ''}`;
    case 'Skill':
      return i.skill || i.command || '';
    case 'AskUserQuestion':
      return (i.questions || []).map((q) => q.header || q.question).join(', ');
    case 'WebFetch':
      return i.url;
    case 'WebSearch':
      return i.query;
    case 'TodoWrite':
      return `${(i.todos || []).length} items`;
    default:
      return Object.values(i).filter((v) => typeof v === 'string').join(' ').slice(0, 120);
  }
}

/** One line about what this agent is doing right now (or did last). */
export function nowLine(node) {
  for (let i = node.items.length - 1; i >= 0; i--) {
    const it = node.items[i];
    if (it.kind === 'tool' && it.status === 'running' && !it.childId) return `${it.name}: ${toolSummary(it.name, it.input)}`;
  }
  if (node.status === 'running') {
    const open = node.children.filter((c) => c.status === 'running');
    if (open.length) return `waiting for ${open.map((c) => c.label).join(', ')}`;
  }
  for (let i = node.items.length - 1; i >= 0; i--) {
    const it = node.items[i];
    if (it.kind === 'text') return it.text.replace(/\s+/g, ' ').trim().slice(0, 90);
    if (it.kind === 'tool' && !it.childId) return `${it.name}: ${toolSummary(it.name, it.input)}`;
  }
  return node.description || '';
}
