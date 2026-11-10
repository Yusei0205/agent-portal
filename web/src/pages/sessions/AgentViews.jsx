/**
 * The list-style views of a session's agents: a Tree (who started whom, with what each is doing) and a Timeline (when each
 * one ran, and for how long). Both select an agent the same way the orbit does.
 */
import { useEffect, useMemo, useState } from 'react';
import { ORBIT_MAIN } from '../../lib/agent-orbit.js';
import { badgeCount, agentLabels } from '../../lib/agent-activity.js';
import { formatDuration, timelineBursts, barBox, scaleTicks } from '../../lib/agent-timeline.js';

const STATUS_TEXT = { running: 'Running', pending: 'Starting', done: 'Done', failed: 'Failed', stopped: 'Stopped', paused: 'Paused' };
const live = (s) => s === 'running' || s === 'pending';
const dotClass = (s) => (live(s) ? 'is-running' : s === 'failed' || s === 'stopped' ? 'is-failed' : 'is-done');

/** Agents as parent → children rows, depth first; an unknown or looping parent hangs the agent off the main agent. */
function treeRows(agents) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const kids = new Map([[ORBIT_MAIN, []]]);
  for (const a of agents) kids.set(a.id, []);
  for (const a of agents) {
    let p = a.parentId && a.parentId !== a.id && byId.has(a.parentId) ? a.parentId : ORBIT_MAIN;
    for (let cur = p, seen = new Set([a.id]); cur !== ORBIT_MAIN; cur = byId.get(cur).parentId && byId.has(byId.get(cur).parentId) ? byId.get(cur).parentId : ORBIT_MAIN) {
      if (seen.has(cur)) { p = ORBIT_MAIN; break; }
      seen.add(cur);
    }
    kids.get(p).push(a.id);
  }
  const rows = [];
  const walk = (id, depth) => { for (const k of kids.get(id)) { rows.push({ agent: byId.get(k), depth }); walk(k, depth + 1); } };
  walk(ORBIT_MAIN, 0);
  return rows;
}

export function AgentTreeList({ agents, activity, rootName, rootStatus, selectedId, onSelect }) {
  const rows = useMemo(() => treeRows(agents), [agents]);
  const labels = useMemo(() => agentLabels(agents), [agents]);
  const main = activity.main;
  return (
    <ul className="agent-tree" aria-label="Agents as a tree">
      <li>
        <button type="button" className={`agent-tree-row${selectedId === ORBIT_MAIN ? ' is-selected' : ''}`} aria-pressed={selectedId === ORBIT_MAIN} onClick={() => onSelect(ORBIT_MAIN)}>
          <span className={`agent-tree-dot ${dotClass(rootStatus)}`} aria-hidden="true" />
          <strong>{rootName}</strong>
          <span className="agent-tree-now">{live(rootStatus) ? main.current : STATUS_TEXT[rootStatus] || ''}</span>
          {main.tools > 0 && <span className="agent-tree-count" title="Tool calls">{badgeCount(main.tools)}</span>}
        </button>
      </li>
      {rows.map(({ agent, depth }) => {
        const act = activity.byId.get(agent.id) ?? { tools: 0, current: '' };
        return (
          <li key={agent.id} style={{ paddingLeft: depth * 18 }}>
            <button type="button" className={`agent-tree-row${selectedId === agent.id ? ' is-selected' : ''}`} aria-pressed={selectedId === agent.id} onClick={() => onSelect(agent.id)}>
              <span className={`agent-tree-dot ${dotClass(agent.status)}`} aria-hidden="true" />
              <strong>{labels.get(agent.id) ?? agent.name}</strong>
              <span className="agent-tree-now">{live(agent.status) ? act.current || agent.description || '' : STATUS_TEXT[agent.status] || agent.status}</span>
              {act.tools > 0 && <span className="agent-tree-count" title="Tool calls">{badgeCount(act.tools)}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** "Nov 8, 19:33" in the person's own time zone. */
const clock = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const clockSeconds = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Agents on a time axis, in bursts. A session can span days, and on one axis an agent that ran for four minutes is a sliver,
 * so each burst of activity (agents that ran within ten minutes of each other) has its own scale, and a pause between bursts
 * is one line saying how long it was. Every bar says how long the agent ran; a running agent's bar grows to now.
 */
export function AgentTimeline({ agents, selectedId, onSelect }) {
  const labels = useMemo(() => agentLabels(agents), [agents]);
  const anyLive = agents.some((a) => live(a.status));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyLive) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyLive]);

  const spans = useMemo(() => agents.map((a) => {
    const start = a.startedAt ? new Date(a.startedAt).getTime() : a.finishedAt ? new Date(a.finishedAt).getTime() : null;
    const end = a.finishedAt ? new Date(a.finishedAt).getTime() : live(a.status) ? now : start;
    return { agent: a, start, end };
  }).filter((s) => s.start != null), [agents, now]);
  const bursts = useMemo(() => timelineBursts(spans), [spans]);
  if (!spans.length) return <p className="agent-detail-hint">No timing recorded yet.</p>;

  return (
    <div className="agent-timeline" aria-label="Agents on a timeline">
      {bursts.map((burst, i) => (
        <section key={burst.start} className="agent-timeline-burst" aria-label={`Agents that ran from ${clock(burst.start)}`}>
          {burst.pauseBefore > 0 && <div className="agent-timeline-pause">{formatDuration(burst.pauseBefore)} later</div>}
          <header className="agent-timeline-head">
            <strong>{clock(burst.start)}</strong>
            <span>
              {burst.items.length} {burst.items.length === 1 ? 'agent' : 'agents'} · ran {formatDuration(burst.end - burst.start)}
              {bursts.length > 1 ? ` · ${i + 1} of ${bursts.length}` : ''}
            </span>
          </header>
          <div className="agent-timeline-axis" aria-hidden="true">
            {scaleTicks(burst.total).map((label, k) => <span key={k}>{label}</span>)}
          </div>
          {burst.items.map((span) => {
            const { agent, start, end } = span;
            const { left, width } = barBox(span, burst);
            // The runner's own measurement of the time it worked wins over the gap between its first and last event.
            const took = live(agent.status) ? end - start : Number.isFinite(agent.durationMs) && agent.durationMs > 0 ? agent.durationMs : end - start;
            const tip = `${labels.get(agent.id) ?? agent.name}: ${clockSeconds(start)} to ${live(agent.status) ? 'now' : clockSeconds(end)} (${formatDuration(took)})`;
            return (
              <button key={agent.id} type="button" title={tip} className={`agent-timeline-row${selectedId === agent.id ? ' is-selected' : ''}`} aria-pressed={selectedId === agent.id} onClick={() => onSelect(agent.id)}>
                <span className="agent-timeline-name">{labels.get(agent.id) ?? agent.name}</span>
                <span className="agent-timeline-track">
                  <span className={`agent-timeline-bar ${dotClass(agent.status)}`} style={{ left: `${left}%`, width: `${width}%` }} />
                </span>
                <span className={`agent-timeline-took ${dotClass(agent.status)}`}>{formatDuration(took)}{live(agent.status) ? '…' : ''}</span>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}
