/**
 * What each agent in a session is doing, worked out from the run's events.
 *
 * Claude Code labels the text and tool calls of a sub-agent with its name (`payload.agent`); events without a label are the
 * main agent's. Codex and Kiro only report that an agent started or finished, so their agents have no transcript of their own.
 *
 * For every agent this gives the number of tool calls it made, what it is doing right now, and its transcript lines.
 * Pure, so it can be tested without a browser.
 */

export const MAIN_AGENT = 'main';
const LINES_MAX = 200;
const CURRENT_MAX = 90;

function clip(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function parseInput(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { const v = JSON.parse(raw); if (v && typeof v === 'object') return v; } catch { /* plain text */ }
  }
  return {};
}

/** "Running cd rhb…", "Read src/app.ts": what a tool call is, in a few words. */
export function describeTool(toolName, toolInput) {
  const name = String(toolName || 'Tool').replace(/^mcp__[^_]+__/, '');
  const input = parseInput(toolInput);
  const command = input.command ?? input.cmd;
  if (typeof command === 'string' && command) return `Running ${clip(command, CURRENT_MAX)}`;
  const target = input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description;
  if (typeof target === 'string' && target) return `${name} ${clip(target, CURRENT_MAX)}`;
  return name;
}

/**
 * @param {Array<{ type?: string, payload?: Record<string, any> }>} events the run's events, oldest first
 * @param {Array<{ id: string, name: string, status: string }>} agents rows from the agents endpoint
 * @returns {{ main: Activity, byId: Map<string, Activity> }}
 *   Activity = { tools: number, current: string, lines: Array<{ kind: 'text' | 'tool', text: string }> }
 */
export function summarizeActivity(events, agents) {
  const blank = () => ({ tools: 0, current: '', lines: [] });
  const main = blank();
  const byId = new Map((agents || []).map((a) => [a.id, blank()]));

  // An event names its agent, not its row, so a name finds the agent: a running one first, else the latest with that name.
  const rowFor = (name) => {
    const named = (agents || []).filter((a) => a.name === name);
    if (!named.length) return null;
    return named.findLast((a) => a.status === 'running' || a.status === 'pending') ?? named[named.length - 1];
  };

  const lastKind = new Map();
  for (const ev of events || []) {
    const p = ev?.payload ?? {};
    if (ev.type !== 'assistant-text' && ev.type !== 'tool-start') continue;
    const row = typeof p.agent === 'string' && p.agent ? rowFor(p.agent) : null;
    // A label that matches no agent is still not the main agent's.
    if (typeof p.agent === 'string' && p.agent && !row) continue;
    const owner = row ? byId.get(row.id) : main;
    const key = row ? row.id : MAIN_AGENT;

    if (ev.type === 'tool-start') {
      const text = describeTool(p.toolName, p.toolInput);
      owner.tools++;
      owner.current = text;
      owner.lines.push({ kind: 'tool', text });
      lastKind.set(key, 'tool');
    } else {
      const text = String(p.text ?? '');
      if (!text.trim()) continue;
      // Streamed chunks of one message are one line.
      if (p.stream === true && lastKind.get(key) === 'text' && owner.lines.length) owner.lines[owner.lines.length - 1].text += text;
      else owner.lines.push({ kind: 'text', text });
      owner.current = clip(owner.lines[owner.lines.length - 1].text, CURRENT_MAX);
      lastKind.set(key, 'text');
    }
    if (owner.lines.length > LINES_MAX) owner.lines.splice(0, owner.lines.length - LINES_MAX);
  }
  return { main, byId };
}

/**
 * What to call each agent on screen. Kiro names every sub-agent after its type ("general-task-execution"), so three of them
 * look identical; agents that share a name are numbered in the order they started. A lone agent keeps its plain name.
 * @returns {Map<string, string>} agent id -> label
 */
export function agentLabels(agents) {
  const list = agents || [];
  const total = new Map();
  for (const a of list) total.set(a.name, (total.get(a.name) || 0) + 1);
  const seen = new Map();
  const out = new Map();
  const order = [...list].sort((x, y) => String(x.startedAt || '').localeCompare(String(y.startedAt || '')));
  for (const a of order) {
    const n = (seen.get(a.name) || 0) + 1;
    seen.set(a.name, n);
    out.set(a.id, total.get(a.name) > 1 ? `${a.name} #${n}` : a.name);
  }
  return out;
}

/** "99+" past 99, so a badge stays small. */
export function badgeCount(n) {
  return n > 99 ? '99+' : String(Math.max(0, n | 0));
}
