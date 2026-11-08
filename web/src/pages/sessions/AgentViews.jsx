/**
 * The list-style views of a session's agents: a Tree (who started whom, with what each is doing) and a Timeline (when each
 * one ran). Both select an agent the same way the orbit does.
 */
import { useEffect, useMemo, useState } from 'react';
import { ORBIT_MAIN } from '../../lib/agent-orbit.js';
import { badgeCount } from '../../lib/agent-activity.js';

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
              <strong>{agent.name}</strong>
              <span className="agent-tree-now">{live(agent.status) ? act.current || agent.description || '' : STATUS_TEXT[agent.status] || agent.status}</span>
              {act.tools > 0 && <span className="agent-tree-count" title="Tool calls">{badgeCount(act.tools)}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One bar per agent on a shared time axis; a running agent's bar grows to now. */
export function AgentTimeline({ agents, selectedId, onSelect }) {
  const anyLive = agents.some((a) => live(a.status));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyLive) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyLive]);

  const spans = agents.map((a) => {
    const start = a.startedAt ? new Date(a.startedAt).getTime() : a.finishedAt ? new Date(a.finishedAt).getTime() : null;
    const end = a.finishedAt ? new Date(a.finishedAt).getTime() : live(a.status) ? now : start;
    return { agent: a, start, end };
  }).filter((s) => s.start != null);
  if (!spans.length) return <p className="agent-detail-hint">No timing recorded yet.</p>;

  const t0 = Math.min(...spans.map((s) => s.start));
  const t1 = Math.max(now > t0 && anyLive ? now : t0, ...spans.map((s) => s.end));
  const total = Math.max(1, t1 - t0);
  const seconds = Math.round(total / 1000);
  return (
    <div className="agent-timeline" aria-label="Agents on a timeline">
      <div className="agent-timeline-axis"><span>0s</span><span>{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</span></div>
      {spans.map(({ agent, start, end }) => {
        const left = ((start - t0) / total) * 100;
        const width = Math.max(1.5, ((end - start) / total) * 100);
        return (
          <button key={agent.id} type="button" className={`agent-timeline-row${selectedId === agent.id ? ' is-selected' : ''}`} aria-pressed={selectedId === agent.id} onClick={() => onSelect(agent.id)}>
            <span className="agent-timeline-name">{agent.name}</span>
            <span className="agent-timeline-track">
              <span className={`agent-timeline-bar ${dotClass(agent.status)}`} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
