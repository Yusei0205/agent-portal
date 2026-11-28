/**
 * Shapes a session's events for the conversation: runs of tool calls become one collapsible "Tool Activity" group, and the
 * agent's task-list updates (TodoWrite and the like) become plan cards. Everything else passes through untouched.
 *
 * Input: events in time order with tool calls already paired (a `tool-start` event carrying its `tool-end` as `_end`).
 */
import { latestTodos } from './execution-summary.js';

/** Calls at least this many in a row make a group; a lone call stays a plain row. */
const MIN_GROUP = 2;

/** A plan event's task list, or null when the event is not a task-list update. */
export function planOf(event) {
  return event?.type === 'tool-start' ? latestTodos([event]) : null;
}

/**
 * @returns {Array<object>} the events, where a run of tool calls is replaced by
 *   { type: 'tool-group', id, calls: [tool-start events], created_at }
 *   and a task-list update by { ...event, _plan: { items, done, total } }.
 */
export function groupToolRuns(events) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= MIN_GROUP) out.push({ type: 'tool-group', id: `group:${run[0].id ?? out.length}`, created_at: run[0].created_at, calls: run });
    else out.push(...run);
    run = [];
  };
  for (const e of events) {
    const plan = planOf(e);
    if (plan) { flush(); out.push({ ...e, _plan: plan }); continue; }
    if (e.type === 'tool-start') { run.push(e); continue; }
    flush();
    out.push(e);
  }
  flush();
  return out;
}

/** The id of the last plan card in a list produced by groupToolRuns, or null. */
export function lastPlanId(grouped) {
  for (let i = grouped.length - 1; i >= 0; i--) if (grouped[i]._plan) return grouped[i].id ?? null;
  return null;
}

/** Totals for a group header: how many calls, how many failed or still running, and the time from first start to last end. */
export function groupStats(calls) {
  let failed = 0;
  let running = 0;
  let first = Infinity;
  let last = -Infinity;
  const names = new Map();
  for (const c of calls) {
    const t = Date.parse(c.created_at);
    if (Number.isFinite(t)) first = Math.min(first, t);
    if (!c._end) running += 1;
    else if (c._end.payload?.status === 'failed') failed += 1;
    const end = c._end ? Date.parse(c._end.created_at) : t;
    if (Number.isFinite(end)) last = Math.max(last, end);
    const name = c.payload?.toolName || c.payload?.tool || c.payload?.name || 'Tool';
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  return {
    total: calls.length,
    failed,
    running,
    durationMs: Number.isFinite(first) && Number.isFinite(last) && running === 0 ? Math.max(0, last - first) : null,
    names: [...names.entries()].map(([name, count]) => ({ name, count })),
  };
}
