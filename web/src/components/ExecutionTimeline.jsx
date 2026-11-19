import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import { formatDuration } from '../lib/agent-timeline.js';

const labels = { running: 'Running', pending: 'Starting', blocked: 'Needs a decision', paused: 'Paused', done: 'Completed', failed: 'Failed', stopped: 'Stopped' };
const live = (status) => ['running', 'pending'].includes(status);
const time = (value) => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; };
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Recorded agent lifetimes, not a claim that the agent used compute throughout. */
export function ExecutionTimeline({ root, agents = [], onSelect }) {
  const [now, setNow] = useState(Date.now);
  const running = agents.some((agent) => live(agent.status));
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [running]);
  const { rows, start, total, ticks } = useMemo(() => {
    const items = [root, ...agents.slice(0, 7)].map((agent) => {
      const began = time(agent.startedAt);
      const finished = time(agent.finishedAt);
      return { agent, began, end: began == null ? null : finished != null && finished >= began ? finished : live(agent.status) ? Math.max(began, now) : null };
    });
    const known = items.filter((item) => item.began != null);
    const first = known.length ? Math.min(...known.map((item) => item.began)) : now;
    const last = known.length ? Math.max(...known.map((item) => item.end ?? item.began)) : now;
    const duration = Math.max(1000, last - first);
    return { rows: items, start: first, total: duration, ticks: known.length ? Array.from({length: 5}, (_, index) => first + duration * index / 4) : [] };
  }, [root, agents, now]);
  const current = Math.min(100, Math.max(0, (now - start) / total * 100));
  return <section className="execution-timeline" aria-label="Agent execution timeline">
    <div className="execution-heading"><span><Icon name="activity" size={14} />Execution timeline</span><span>Recorded lifetimes · local time</span></div>
    <div className="execution-axis"><span>Agents</span><div>{ticks.map((tick, index) => <time key={index} dateTime={new Date(tick).toISOString()}>{clock(tick)}</time>)}{!ticks.length && <span>Waiting for recorded timing</span>}</div><span>Status</span></div>
    <div className="execution-rows" aria-label="Session agents">{rows.map(({agent, began, end}, index) => {
      const left = began == null ? 0 : Math.min(97, Math.max(0, (began - start) / total * 100));
      const width = end == null ? 0 : Math.min(100 - left, Math.max(3, (end - began) / total * 100));
      const state = labels[agent.status] || agent.status || 'Unknown';
      return <button type="button" key={agent.id} className={`execution-row mc-agent execution-${agent.status}${live(agent.status) ? ' is-running' : ''}`} onClick={(event) => onSelect(agent.id, event.currentTarget)} aria-label={`Inspect ${agent.name}`}>
        <span className="execution-agent"><span className="mc-agent-icon"><Icon name={index === 0 ? 'workflow' : 'agents'} size={16} /></span><span><strong>{agent.name}</strong><small>{index === 0 ? 'Session lead' : 'Delegated agent'}</small></span></span>
        <span className="execution-track" aria-hidden="true">
          {ticks.length > 0 && running && <span className="execution-now" style={{left: `${current}%`}} />}
          {began == null ? <span className="execution-unknown">Timing not recorded</span> : end == null ? <span className="execution-marker" style={{left: `${left}%`}} title="Start recorded; end unavailable" /> : <span className="execution-span" style={{left: `${left}%`, width: `${width}%`}}><span>{formatDuration(end - began)}</span></span>}
        </span>
        <span className="execution-status"><i />{state}<Icon name="chevronRight" size={12} /></span>
      </button>;
    })}</div>
    <div className="execution-legend"><span><i className="execution-live-dot" />Running</span><span><i className="execution-done-dot" />Completed</span><span><i className="execution-wait-dot" />Needs attention</span>{agents.length > 7 && <span>+{agents.length - 7} more in inspector</span>}</div>
    <p className="execution-note">Bars show recorded start/end spans, including waits. Select an agent to inspect its tools and outputs.</p>
  </section>;
}
