/**
 * Kiro sub-agents → portal sub-agent events.
 *
 * When Kiro's agent hands work to another agent it calls its `invoke_sub_agent` tool (older builds: `subagent`,
 * `use_subagent`). Over ACP that arrives as a `session/update` `tool_call` tagged `_meta.kiro.kind = "agent-subtask"`
 * with an `agentSubtaskId`; the child's own frames (text, tool calls) carry the same `agentSubtaskId`.
 *
 * This turns those frames into the `subagent-started` / `subagent-finished` / `subagent-failed` events the portal
 * already understands (the Claude and Codex runners send the same ones), so the session's agents graph can draw Kiro's
 * agents too. It is pure so it can be tested without kiro-cli.
 *
 * Kiro does not document how a subtask ends, so a subtask is finished by whichever comes first: a later
 * `tool_call_update` of the invoking tool call with a final status, or `finishOpen()` at the end of the turn, which
 * keeps a node from staying "running" forever.
 */

export interface SubagentEvent {
  type: 'subagent-started' | 'subagent-finished' | 'subagent-failed';
  id: string;
  name: string;
  description?: string;
  summary?: string;
  status?: string;
  parentId?: string;
  durationMs?: number;
}

interface Open {
  id: string;
  name: string;
  startedAt: number;
  /** The invoking tool call, so its completion can be matched. */
  toolCallId: string | null;
  /** What the child said last: the result when Kiro gives none of its own. */
  lastText: string;
}

interface Frame {
  sessionUpdate?: string;
  toolCallId?: string;
  title?: string;
  name?: string;
  status?: string;
  rawInput?: unknown;
  content?: unknown;
  _meta?: { kiro?: { kind?: string; agentSubtaskId?: string } };
}

const INVOKE_TOOLS = new Set(['invoke_sub_agent', 'subagent', 'use_subagent']);
const DESCRIPTION_MAX = 300;
const SUMMARY_MAX = 1000;
const NAME_MAX = 64;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function textOf(content: unknown): string {
  const list = Array.isArray(content) ? content : content ? [content] : [];
  return list.flatMap((c: unknown) => {
    if (typeof c !== 'object' || !c) return [];
    const item = c as Record<string, unknown>;
    const inner = item.type === 'content' && item.content ? (item.content as Record<string, unknown>) : item;
    return inner.type === 'text' ? [String(inner.text ?? '')] : [];
  }).join('');
}

function inputOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try { const v = JSON.parse(raw); if (v && typeof v === 'object') return v as Record<string, unknown>; } catch { /* not JSON */ }
  }
  return {};
}

export function createSubagentTracker(now: () => number = Date.now) {
  const open = new Map<string, Open>();

  function finish(o: Open, ok: boolean, summary: string, status?: string): SubagentEvent {
    open.delete(o.id);
    const text = clip(summary || o.lastText, SUMMARY_MAX);
    return {
      type: ok ? 'subagent-finished' : 'subagent-failed',
      id: o.id,
      name: o.name,
      ...(text ? { summary: text } : {}),
      ...(status ? { status } : {}),
      durationMs: Math.max(0, now() - o.startedAt),
    };
  }

  return {
    /** Events for one ACP `session/update` payload (usually none). */
    onUpdate(update: Frame): SubagentEvent[] {
      const kiro = update._meta?.kiro;
      const subtaskId = typeof kiro?.agentSubtaskId === 'string' ? kiro.agentSubtaskId : '';
      const out: SubagentEvent[] = [];

      if (update.sessionUpdate === 'tool_call') {
        const title = String(update.title ?? update.name ?? '');
        const isInvoke = kiro?.kind === 'agent-subtask' || INVOKE_TOOLS.has(title);
        if (isInvoke && subtaskId && !open.has(subtaskId)) {
          const input = inputOf(update.rawInput);
          const name = clip(String(input.name ?? input.agent ?? 'sub-agent'), NAME_MAX) || 'sub-agent';
          const task = clip(String(input.explanation || input.prompt || input.task || ''), DESCRIPTION_MAX);
          open.set(subtaskId, { id: subtaskId, name, startedAt: now(), toolCallId: update.toolCallId ?? null, lastText: '' });
          out.push({ type: 'subagent-started', id: subtaskId, name, ...(task ? { description: task } : {}) });
        }
        return out;
      }

      if (update.sessionUpdate === 'agent_message_chunk' && subtaskId) {
        const o = open.get(subtaskId);
        if (o) o.lastText = (o.lastText + textOf(update.content)).slice(-SUMMARY_MAX * 2);
        return out;
      }

      if (update.sessionUpdate === 'tool_call_update' && update.toolCallId) {
        const o = [...open.values()].find((s) => s.toolCallId === update.toolCallId);
        if (o && (update.status === 'completed' || update.status === 'failed')) {
          out.push(finish(o, update.status === 'completed', textOf(update.content), update.status));
        }
      }
      return out;
    },

    /** The turn is over: every sub-agent still open is done (or failed when the turn did not go well). */
    finishOpen(ok = true): SubagentEvent[] {
      return [...open.values()].map((o) => finish(o, ok, ''));
    },

    get openCount(): number { return open.size; },
  };
}
