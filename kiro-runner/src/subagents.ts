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
  _meta?: { kiro?: { kind?: string; agentSubtaskId?: string; toolName?: string } };
}

const INVOKE_TOOLS = new Set(['invoke_sub_agent', 'subagent', 'use_subagent']);
/** A lead agent that fans work out calls a differently named tool ("Spawning agent crew"); it is a hand-off all the same. */
const HANDOFF_TITLE = /\b(crew|sub-?agents?)\b/i;
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
  /** Every sub-agent started this turn, kept after it finishes so a late frame still finds its name. */
  const names = new Map<string, string>();
  /** The tool calls that started sub-agents: those are the calling agent's own, not the sub-agent's work. */
  const invocations = new Set<string>();
  /** Tool calls that hand work to a crew without naming the agents: when one ends, the agents it started are done. */
  const groupCalls = new Set<string>();

  function begin(id: string, name: string, task: string, toolCallId: string | null): SubagentEvent {
    open.set(id, { id, name, startedAt: now(), toolCallId, lastText: '' });
    names.set(id, name);
    return { type: 'subagent-started', id, name, ...(task ? { description: task } : {}) };
  }

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
        const isInvoke = kiro?.kind === 'agent-subtask' || INVOKE_TOOLS.has(title) || HANDOFF_TITLE.test(title) || kiro?.toolName === 'subagent';
        if (isInvoke && subtaskId && !open.has(subtaskId)) {
          const input = inputOf(update.rawInput);
          const name = clip(String(input.name ?? input.agent ?? 'sub-agent'), NAME_MAX) || 'sub-agent';
          const task = clip(String(input.explanation || input.prompt || input.task || ''), DESCRIPTION_MAX);
          if (update.toolCallId) invocations.add(update.toolCallId);
          out.push(begin(subtaskId, name, task, update.toolCallId ?? null));
          return out;
        }
        if (isInvoke && !subtaskId && update.toolCallId) {
          invocations.add(update.toolCallId);
          groupCalls.add(update.toolCallId);
          // Kiro's crew call lists its agents as `stages` (name, role, prompt): each one is a sub-agent.
          const stages = inputOf(update.rawInput).stages;
          (Array.isArray(stages) ? stages : []).forEach((raw: unknown, i: number) => {
            const stage = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
            const id = `${update.toolCallId}#${i + 1}`;
            if (names.has(id)) return;
            const name = clip(String(stage.name ?? stage.role ?? 'sub-agent'), NAME_MAX) || 'sub-agent';
            const task = clip(String(stage.prompt_template ?? stage.prompt ?? stage.task ?? stage.role ?? ''), DESCRIPTION_MAX);
            out.push(begin(id, name, task, null));
          });
          return out;
        }
        // A frame tagged with a sub-agent nothing announced (a crew names none): it is a sub-agent all the same.
        if (subtaskId && !names.has(subtaskId)) out.push(begin(subtaskId, 'sub-agent', '', null));
        return out;
      }

      // The same, for a sub-agent whose first frame is a message.
      if (subtaskId && !names.has(subtaskId)) out.push(begin(subtaskId, 'sub-agent', '', null));

      if (update.sessionUpdate === 'agent_message_chunk' && subtaskId) {
        const o = open.get(subtaskId);
        if (o) o.lastText = (o.lastText + textOf(update.content)).slice(-SUMMARY_MAX * 2);
        return out;
      }

      if (update.sessionUpdate === 'tool_call_update' && update.toolCallId) {
        const final = update.status === 'completed' || update.status === 'failed';
        const o = [...open.values()].find((s) => s.toolCallId === update.toolCallId);
        if (o && final) out.push(finish(o, update.status === 'completed', textOf(update.content), update.status));
        if (final && groupCalls.has(update.toolCallId)) {
          groupCalls.delete(update.toolCallId);
          for (const s of [...open.values()]) out.push(finish(s, update.status === 'completed', ''));
        }
      }
      return out;
    },

    /**
     * Which sub-agent a frame belongs to, so its messages and tool calls can be shown as that agent's own. Kiro tags a
     * sub-agent's frames with its `agentSubtaskId`; the call that started the sub-agent is the caller's, not the sub-agent's.
     * Returns null for the main agent's own frames and for a tag nothing was started under.
     */
    ownerOf(update: Frame): { id: string; name: string } | null {
      const id = update._meta?.kiro?.agentSubtaskId;
      if (typeof id !== 'string' || !id) return null;
      if (update.sessionUpdate === 'tool_call' && update.toolCallId && invocations.has(update.toolCallId)) return null;
      const name = names.get(id);
      return name ? { id, name } : null;
    },

    /** The turn is over: every sub-agent still open is done (or failed when the turn did not go well). */
    finishOpen(ok = true): SubagentEvent[] {
      return [...open.values()].map((o) => finish(o, ok, ''));
    },

    get openCount(): number { return open.size; },
  };
}
