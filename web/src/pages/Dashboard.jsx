/**
 * Dashboard page â€” portal-wide operations overview.
 *
 * Panels:
 *  1. Greeting header + controls (period, project, refresh, animation toggle)
 *  2. 4 KPI stat cards
 *  3. Agent Network graph (SVG radial)
 *  4. Active Session vertical timeline (sidebar)
 *  5. Recent Sessions list
 *  6. Agent Performance sortable table + drill-down modal
 *
 * Live updates: subscribes to the global SSE stream, debounced refetch on
 * "dashboard.changed" events.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../lib/api.js';
import { subscribeGlobal } from '../lib/events.js';
import { href } from '../lib/router.js';
import { Icon } from '../components/Icon.jsx';
import { formatRelative, formatCost } from '../lib/util.js';

// â”€â”€ Format helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function fmt(n) {
  if (n === null || n === undefined) return 'â€”';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtPct(n) {
  if (n === null || n === undefined) return 'â€”';
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function fmtMs(ms) {
  if (!ms) return 'â€”';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtTokens(n) {
  if (n === null || n === undefined) return 'â€”';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function greeting(name) {
  const h = new Date().getHours();
  const salutation = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = (name || '').split(/[\s@]/)[0] || 'there';
  return `${salutation}, ${first}`;
}

// â”€â”€ Animation hook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Persisted animation preference.
 * Default: ON, unless OS has prefers-reduced-motion: reduce.
 */
function useAnimations() {
  const [on, setOn] = useState(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    try {
      const v = localStorage.getItem('dash-anim');
      if (v !== null) return v === '1';
    } catch { /* private mode */ }
    return !reduced;
  });

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      try { localStorage.setItem('dash-anim', next ? '1' : '0'); } catch { /* */ }
      return next;
    });
  }, []);

  return { animated: on, toggleAnimated: toggle };
}

// â”€â”€ CountUpNumber â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Isolated so re-renders from rAF don't bubble up to parent.

function CountUpNumber({ value, enabled }) {
  const [displayed, setDisplayed] = useState(enabled ? 0 : (value ?? 0));
  const rafRef = useRef(null);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    if (!enabled || value === null || value === undefined) {
      setDisplayed(value ?? 0);
      return;
    }
    // fix 6: skip count-up entirely if the tab is already hidden
    if (document.hidden) {
      setDisplayed(value ?? 0);
      return;
    }
    const duration = 750;
    const start = performance.now();
    const run = (now) => {
      // fix 6: cancel and jump to final value if tab becomes hidden mid-animation
      if (document.hidden) {
        setDisplayed(value ?? 0);
        return;
      }
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - (1 - t) ** 3; // ease-out cubic
      setDisplayed(Math.round((value ?? 0) * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(run);
    };
    rafRef.current = requestAnimationFrame(run);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, enabled]);

  return displayed;
}

// â”€â”€ AnimToggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function AnimToggle({ animated, onToggle }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={animated}
      aria-label={`Animations ${animated ? 'on' : 'off'}`}
      className={`db-anim-toggle${animated ? ' is-on' : ''}`}
      onClick={onToggle}
    >
      <span className="db-anim-toggle-track" aria-hidden="true">
        <span className="db-anim-toggle-thumb" />
      </span>
      <span>Animations</span>
    </button>
  );
}

// â”€â”€ StatCard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function StatCard({ icon, iconColor, label, value, rawValue, sub, deltaValue, deltaLabel, deltaDir, animated, style: cardStyle }) {
  return (
    <article
      className="kpi-card db-kpi-card"
      aria-label={label}
      style={cardStyle}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div className="kpi-label">{label}</div>
        <div className="kpi-icon-tile" style={iconColor ? { background: `color-mix(in srgb, ${iconColor} 15%, transparent)`, color: iconColor } : {}}>
          <Icon name={icon} size={16} aria-hidden="true" />
        </div>
      </div>
      <div className="kpi-value stat-value">
        {value !== null && value !== undefined
          ? (animated && typeof rawValue === 'number' && isFinite(rawValue)
            ? <CountUpNumber value={rawValue} enabled={animated} />
            : value)
          : 'â€”'}
      </div>
      {sub && <div style={{ fontSize: '0.78rem', color: 'var(--ink-3)' }}>{sub}</div>}
      {deltaLabel !== undefined && (
        <div className={`kpi-delta${deltaDir === 'up' ? ' ok' : deltaDir === 'down' ? ' warn' : ' muted'}`}>
          {deltaDir === 'up' && <Icon name="chevronRight" size={12} style={{ transform: 'rotate(-90deg)' }} aria-hidden="true" />}
          {deltaDir === 'down' && <Icon name="chevronRight" size={12} style={{ transform: 'rotate(90deg)' }} aria-hidden="true" />}
          <span>{deltaLabel}</span>
        </div>
      )}
    </article>
  );
}

// â”€â”€ Agent Network â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const NODE_R = 26;
const MAX_GRAPH_NODES = 12;

function computeNetworkLayout(nodes, edges) {
  if (nodes.length === 0) return {};
  const degree = {};
  for (const n of nodes) degree[n.id] = 0;
  for (const e of edges) {
    if (e.source in degree) degree[e.source] += (e.count || 1);
    if (e.target in degree) degree[e.target] += (e.count || 1);
  }
  const sorted = [...nodes].sort((a, b) => (degree[b.id] || 0) - (degree[a.id] || 0));
  const cx = 280, cy = 140;
  const positions = {};
  if (sorted.length === 1) {
    positions[sorted[0].id] = { x: cx, y: cy };
    return positions;
  }
  positions[sorted[0].id] = { x: cx, y: cy };
  const ring = sorted.slice(1);
  const r = ring.length <= 4 ? 110 : ring.length <= 7 ? 130 : 148;
  ring.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / ring.length - Math.PI / 2;
    positions[n.id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });
  return positions;
}

function edgeTrim(sx, sy, tx, ty, r) {
  const dx = tx - sx, dy = ty - sy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len, uy = dy / len;
  return { x1: sx + ux * r, y1: sy + uy * r, x2: tx - ux * r, y2: ty - uy * r };
}

function AgentNetworkPanel({ nodes: rawNodes, edges, onNodeClick, animated }) {
  const nodes = rawNodes.slice(0, MAX_GRAPH_NODES);
  const nodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const validEdges = useMemo(
    () => edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target),
    [edges, nodeIds],
  );
  const positions = useMemo(() => computeNetworkLayout(nodes, validEdges), [nodes, validEdges]);

  if (nodes.length === 0) {
    return (
      <section className="panel db-network" aria-label="Agent Network">
        <h2 className="db-panel-title">
          <Icon name="agents" size={16} aria-hidden="true" />
          Agent Network
        </h2>
        <div className="empty-state db-empty-center">
          <Icon name="agents" size={36} style={{ color: 'var(--ink-3)' }} />
          <p className="muted">No agents have run yet.</p>
        </div>
      </section>
    );
  }

  const maxEdgeCount = Math.max(...validEdges.map((e) => e.count || 1), 1);

  return (
    <section className="panel db-network" aria-label="Agent Network">
      <h2 className="db-panel-title">
        <Icon name="agents" size={16} aria-hidden="true" />
        Agent Network
        {rawNodes.length > MAX_GRAPH_NODES && (
          <span className="muted" style={{ fontSize: '0.76rem', fontWeight: 400, marginLeft: 6 }}>
            (top {MAX_GRAPH_NODES} of {rawNodes.length})
          </span>
        )}
      </h2>
      <svg
        viewBox="0 0 560 280"
        width="100%"
        className="db-network-svg"
        role="img"
        aria-label={`Agent network graph with ${nodes.length} agent${nodes.length !== 1 ? 's' : ''} and ${validEdges.length} delegation${validEdges.length !== 1 ? 's' : ''}`}
      >
        <title>Agent delegation network</title>
        <desc>
          {`${nodes.length} agents connected by ${validEdges.length} delegation edges. See Agent Performance table below for full data.`}
        </desc>
        <defs>
          <marker id="db-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <polygon points="0 0,8 3,0 6" fill="var(--ink-3)" opacity="0.6" />
          </marker>
          <marker id="db-arrow-run" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <polygon points="0 0,8 3,0 6" fill="var(--ok)" opacity="0.8" />
          </marker>
        </defs>

        {/* Edges */}
        {validEdges.map((e) => {
          const sp = positions[e.source], tp = positions[e.target];
          if (!sp || !tp) return null;
          const { x1, y1, x2, y2 } = edgeTrim(sp.x, sp.y, tp.x, tp.y, NODE_R);
          const isRunning = nodes.find((n) => n.id === e.source)?.running || nodes.find((n) => n.id === e.target)?.running;
          const strokeW = 1 + Math.round(((e.count || 1) / maxEdgeCount) * 2);
          return (
            <line
              key={`${e.source}-${e.target}`}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={isRunning ? 'var(--ok)' : 'var(--ink-3)'}
              strokeWidth={strokeW}
              strokeOpacity={isRunning ? 0.7 : 0.4}
              markerEnd={isRunning ? 'url(#db-arrow-run)' : 'url(#db-arrow)'}
              className={isRunning ? 'db-edge-running' : ''}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const pos = positions[node.id];
          if (!pos) return null;
          const isRunning = node.running;
          const successPct = node.successRate != null ? Math.round(node.successRate * 100) : null;
          const shortLabel = node.label.length > 11 ? node.label.slice(0, 10) + 'â€¦' : node.label;

          return (
            <g
              key={node.id}
              transform={`translate(${pos.x},${pos.y})`}
              style={{ cursor: 'pointer' }}
              role="button"
              tabIndex={0}
              aria-label={`${node.label}, ${node.runs} runs, ${successPct !== null ? `${successPct}% success` : 'no data'}${isRunning ? ', currently running' : ''}`}
              onClick={() => onNodeClick(node.id)}
              onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onNodeClick(node.id); } }}
            >
              {/* Glow ring for running nodes */}
              {isRunning && (
                <circle
                  r={NODE_R + 8}
                  fill="none"
                  stroke="var(--ok)"
                  strokeWidth={2}
                  strokeOpacity={0.4}
                  className="db-node-glow"
                />
              )}
              {/* Node body */}
              <circle
                r={NODE_R}
                fill={isRunning ? 'var(--ok-wash)' : 'var(--panel)'}
                stroke={isRunning ? 'var(--ok)' : 'var(--line)'}
                strokeWidth={isRunning ? 2 : 1.5}
              />
              {/* Run count inside circle */}
              <text
                textAnchor="middle"
                dominantBaseline="central"
                y={-3}
                fontSize={13}
                fontWeight={700}
                fill={isRunning ? 'var(--ok)' : 'var(--ink)'}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {fmt(node.runs)}
              </text>
              {/* Success rate sub-label inside circle */}
              {successPct !== null && (
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  y={9}
                  fontSize={9}
                  fill={isRunning ? 'var(--ok)' : 'var(--ink-3)'}
                >
                  {successPct}%
                </text>
              )}
              {/* Agent name below circle */}
              <text
                textAnchor="middle"
                y={NODE_R + 14}
                fontSize={11}
                fill="var(--ink-2)"
                fontWeight={500}
              >
                {shortLabel}
              </text>
              {/* Running indicator dot */}
              {isRunning && (
                <circle
                  r={5}
                  cx={NODE_R - 4}
                  cy={-(NODE_R - 4)}
                  fill="var(--ok)"
                  className="db-node-running-dot"
                />
              )}
            </g>
          );
        })}
      </svg>
    </section>
  );
}

// â”€â”€ Recent Sessions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// fix 3: done â†’ success pill; cover all real run/session statuses
function statusPillClass(status) {
  if (status === 'running')                          return 'pill pill-running';
  if (status === 'done' || status === 'completed')   return 'pill pill-completed';
  if (status === 'failed')                           return 'pill pill-failed';
  if (status === 'pending')                          return 'pill pill-pending';
  if (status === 'queued')                           return 'pill pill-queued';
  if (status === 'blocked')                          return 'pill pill-pending';   // warn-yellow attention
  if (status === 'cancelled')                        return 'pill pill-cancelled';
  return 'pill pill-stopped'; // paused, stopped, unknown
}

function statusLabel(status) {
  const labels = {
    running: 'Running', completed: 'Done', done: 'Done',
    failed: 'Failed', pending: 'Pending', queued: 'Queued',
    stopped: 'Stopped', paused: 'Paused', blocked: 'Blocked',
    cancelled: 'Cancelled',
  };
  return labels[status] || status;
}

function RecentSessionsPanel({ sessions }) {
  if (!sessions || sessions.length === 0) {
    return (
      <section className="panel db-recent" aria-label="Recent Sessions">
        <div className="db-panel-header">
          <h2 className="db-panel-title">
            <Icon name="clock" size={16} aria-hidden="true" />
            Recent Sessions
          </h2>
        </div>
        <div className="empty-state db-empty-center">
          <Icon name="terminal" size={36} style={{ color: 'var(--ink-3)' }} />
          <p className="muted">No sessions yet.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel db-recent" aria-label="Recent Sessions">
      <div className="db-panel-header">
        <h2 className="db-panel-title">
          <Icon name="clock" size={16} aria-hidden="true" />
          Recent Sessions
        </h2>
        <a href="#/projects" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }}>
          View all
        </a>
      </div>
      <ul className="db-session-list" role="list">
        {sessions.map((s) => {
          const title = s.title || `Session ${s.id.slice(0, 8)}`;
          const agents = [s.agent, ...(s.childAgents || [])].filter(Boolean);
          return (
            <li key={s.id} className="db-session-item">
              <div className="db-session-status" aria-hidden="true">
                <span className={`dot dot-${
                  s.status === 'running'   ? 'running' :
                  s.status === 'done'      ? 'done' :
                  s.status === 'failed'    ? 'failed' :
                  s.status === 'pending'   ? 'pending' :
                  s.status === 'blocked'   ? 'blocked' :
                  s.status === 'paused'    ? 'paused' :
                  s.status === 'cancelled' ? 'stopped' :
                  'stopped'
                }`} />
              </div>
              <div className="db-session-body">
                <a
                  href={href(s.projectId, 'sessions', s.id)}
                  className="db-session-title"
                  title={title}
                >
                  {title.length > 55 ? title.slice(0, 54) + 'â€¦' : title}
                </a>
                <div className="db-session-meta">
                  {agents.length > 0 && (
                    <span className="db-session-agents" aria-label={`Agent chain: ${agents.join(' â†’ ')}`}>
                      {agents.slice(0, 3).join(' â†’ ')}{agents.length > 3 ? ' +' + (agents.length - 3) : ''}
                    </span>
                  )}
                  {s.projectName && (
                    <span className="muted" style={{ fontSize: '0.76rem' }}>{s.projectName}</span>
                  )}
                </div>
              </div>
              <div className="db-session-right">
                <span className={statusPillClass(s.status)}>
                  <span className="pill-dot" aria-hidden="true" />
                  <span>{statusLabel(s.status)}</span>
                </span>
                <span className="muted" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                  {formatRelative(s.updatedAt)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// â”€â”€ Active Session â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ActiveSessionPanel({ activeSession }) {
  if (!activeSession) {
    return (
      <aside className="panel db-active" aria-label="Active Session">
        <h2 className="db-panel-title">
          <Icon name="play" size={16} aria-hidden="true" />
          Active Session
        </h2>
        <div className="empty-state db-empty-center" style={{ padding: '28px 16px' }}>
          <Icon name="clock" size={32} style={{ color: 'var(--ink-3)' }} />
          <p className="muted" style={{ fontSize: '0.84rem' }}>No session running right now.</p>
        </div>
      </aside>
    );
  }

  const { id, projectId, title, agent, steps = [] } = activeSession;

  return (
    <aside className="panel db-active" aria-label="Active Session">
      <div className="db-panel-header">
        <h2 className="db-panel-title" style={{ flex: 1 }}>
          <Icon name="play" size={16} aria-hidden="true" />
          Active Session
        </h2>
        <a href={href(projectId, 'sessions', id)} className="btn btn-sm" aria-label="View session details">
          <Icon name="external" size={12} aria-hidden="true" />
          Details
        </a>
      </div>
      {title && (
        <p className="muted db-active-title" title={title}>
          {title.length > 50 ? title.slice(0, 49) + 'â€¦' : title}
        </p>
      )}
      {agent && (
        <div style={{ fontSize: '0.76rem', color: 'var(--ink-3)', marginBottom: 8 }}>
          <Icon name="agents" size={11} aria-hidden="true" style={{ marginRight: 3 }} />
          {agent}
        </div>
      )}
      {steps.length === 0 ? (
        <p className="muted" style={{ fontSize: '0.82rem' }}>Startingâ€¦</p>
      ) : (
        <ol className="db-timeline" aria-label="Session steps">
          {steps.map((step, i) => {
            const isCompleted = step.status === 'done' || step.status === 'completed';
            const isActive    = step.status === 'running' || step.status === 'in-progress';
            // fix 3: distinct states for failed/cancelled/blocked
            const isFailed    = step.status === 'failed' || step.status === 'cancelled';
            const isBlocked   = step.status === 'blocked';
            const isPaused    = step.status === 'paused';
            return (
              <li
                key={step.id || i}
                className={`db-step${isCompleted ? ' db-step-done' : isActive ? ' db-step-active' : isFailed ? ' db-step-failed' : isBlocked ? ' db-step-blocked' : isPaused ? ' db-step-paused' : ' db-step-pending'}`}
                aria-current={isActive ? 'step' : undefined}
              >
                <div className="db-step-marker" aria-hidden="true">
                  {isCompleted && <Icon name="check" size={11} />}
                  {isActive && <span className="db-step-spin" />}
                  {isFailed && <Icon name="x" size={11} />}
                  {isBlocked && <Icon name="warning" size={11} />}
                </div>
                <div className="db-step-body">
                  <span className="db-step-label">{step.label}</span>
                  {step.agent && step.agent !== agent && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--ink-3)', display: 'block' }}>
                      {step.agent}
                    </span>
                  )}
                  {isActive && step.startedAt && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--ink-3)' }}>
                      {formatRelative(step.startedAt)}
                    </span>
                  )}
                  {isFailed && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--danger)', display: 'block' }}>
                      {step.status === 'cancelled' ? 'Cancelled' : 'Failed'}
                    </span>
                  )}
                  {isBlocked && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--warn)', display: 'block' }}>
                      Blocked
                    </span>
                  )}
                  {isPaused && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--ink-3)', display: 'block' }}>
                      Paused
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

// â”€â”€ Agent Drill-down Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// fix 4: accepts optional agentStats (node stats) to show at the top of the modal
function DrillModal({ agent, agentStats, runs, loading, error, onClose }) {
  // Trap focus inside modal on mount
  const modalRef = useRef(null);
  useEffect(() => {
    const el = modalRef.current?.querySelector('button, [tabindex="0"]');
    el?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Runs for ${agent}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={modalRef} className="modal modal-wide db-drill-modal">
        <div className="modal-header">
          <h2 id="drill-title">
            <Icon name="agents" size={16} aria-hidden="true" style={{ marginRight: 6 }} />
            {agent}
            <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>â€” recent runs</span>
          </h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* fix 4: node stats banner when opened from the network graph */}
        {agentStats && (
          <div style={{ padding: '10px 0 12px', borderBottom: '1px solid var(--line-2)', marginBottom: 12 }}>
            <dl className="db-node-stats">
              <div><dt>Total runs</dt><dd>{fmt(agentStats.runs)}</dd></div>
              <div><dt>Success rate</dt><dd>{fmtPct(agentStats.successRate)}</dd></div>
              <div><dt>Avg duration</dt><dd>{fmtMs(agentStats.avgDurationMs)}</dd></div>
              <div>
                <dt>Status</dt>
                <dd>
                  {agentStats.running
                    ? <span className="pill pill-running"><span className="pill-dot" aria-hidden="true" />Running</span>
                    : <span className="pill pill-stopped"><span className="pill-dot" aria-hidden="true" />Idle</span>}
                </dd>
              </div>
            </dl>
          </div>
        )}

        {loading && (
          <div className="spinner-wrap">
            <div className="spinner" aria-label="Loading runsâ€¦" />
          </div>
        )}
        {error && <p className="error-note" role="alert">{error}</p>}
        {!loading && !error && runs?.length === 0 && (
          <p className="muted" style={{ padding: '16px 0', textAlign: 'center' }}>No runs found for this period.</p>
        )}
        {!loading && !error && runs?.length > 0 && (
          <div className="table-wrap">
            <table className="data-table" aria-label={`Runs for ${agent}`}>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Tool calls</th>
                  <th scope="col">Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.workflowId ? (
                        <a href={href(r.projectId, 'sessions', r.workflowId)} title={r.title}>
                          {r.title || r.id.slice(0, 8)}
                        </a>
                      ) : (r.title || r.id.slice(0, 8))}
                    </td>
                    <td>
                      <span className={statusPillClass(r.status)}>
                        <span className="pill-dot" aria-hidden="true" />
                        {statusLabel(r.status)}
                      </span>
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMs(r.durationMs)}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.costUsd != null ? formatCost(r.costUsd) : 'â€”'}</td>
                    {/* fix 2: tokens is {input, output}; display total with tooltip for split */}
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {r.tokens != null
                        ? <span title={`In: ${fmtTokens(r.tokens.input)} / Out: ${fmtTokens(r.tokens.output)}`}>
                            {fmtTokens((r.tokens.input ?? 0) + (r.tokens.output ?? 0))}
                          </span>
                        : 'â€”'}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.toolCalls ?? 'â€”'}</td>
                    <td className="muted" style={{ fontSize: '0.79rem', whiteSpace: 'nowrap' }}>
                      {formatRelative(r.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// â”€â”€ Agent Performance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const PERF_COLS = [
  { key: 'agent',          label: 'Agent',       numeric: false },
  { key: 'runs',           label: 'Runs',        numeric: true  },
  { key: 'successRate',    label: 'Success %',   numeric: true  },
  { key: 'p50DurationMs',  label: 'p50',         numeric: true  },
  { key: 'p95DurationMs',  label: 'p95',         numeric: true  },
  { key: 'avgDurationMs',  label: 'Avg dur.',    numeric: true  },
  // fix 1: costUsd is the TOTAL; _avgCost = costUsd / runs for per-run average
  { key: '_avgCost',       label: 'Avg cost',    numeric: true  },
  { key: '_totalCost',     label: 'Total cost',  numeric: true  },
  { key: '_totalTokens',   label: 'Tokens',      numeric: true  },
  { key: 'toolCalls',      label: 'Tool calls',  numeric: true  },
  { key: 'toolErrors',     label: 'Errors',      numeric: true  },
  { key: 'lastRunAt',      label: 'Last run',    numeric: false },
];

function sortRows(rows, col, dir) {
  return [...rows].sort((a, b) => {
    let av = a[col], bv = b[col];
    if (av === null || av === undefined) av = dir === 'asc' ? Infinity : -Infinity;
    if (bv === null || bv === undefined) bv = dir === 'asc' ? Infinity : -Infinity;
    if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return dir === 'asc' ? av - bv : bv - av;
  });
}

function SortTh({ col, label, sortCol, sortDir, onSort, numeric }) {
  const active = sortCol === col;
  return (
    <th
      scope="col"
      style={{ textAlign: numeric ? 'right' : 'left', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(col)}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        {label}
        {active && (
          <Icon
            name="chevronDown"
            size={11}
            style={{ transform: sortDir === 'asc' ? 'rotate(180deg)' : 'none' }}
            aria-hidden="true"
          />
        )}
      </span>
    </th>
  );
}

// fix 4: onDrill is lifted to Dashboard so network nodes and table rows share the same modal
function AgentPerformancePanel({ agents: rawAgents, onDrill }) {
  const [sortCol, setSortCol] = useState('runs');
  const [sortDir, setSortDir] = useState('desc');

  // fix 1: costUsd IS the total cost; derive per-run average and keep total correct
  const agents = useMemo(() => {
    return (rawAgents || []).map((a) => ({
      ...a,
      _totalCost: a.costUsd || 0,
      _avgCost: (a.runs || 0) > 0 ? (a.costUsd || 0) / a.runs : 0,
      _totalTokens: (a.inputTokens || 0) + (a.outputTokens || 0),
    }));
  }, [rawAgents]);

  const sorted = useMemo(() => sortRows(agents, sortCol, sortDir), [agents, sortCol, sortDir]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(col); setSortDir('desc'); }
  };

  const thProps = { sortCol, sortDir, onSort: toggleSort };

  if (!rawAgents || rawAgents.length === 0) {
    return (
      <section className="panel db-perf" aria-label="Agent Performance">
        <h2 className="db-panel-title">
          <Icon name="chart" size={16} aria-hidden="true" />
          Agent Performance
        </h2>
        <div className="empty-state db-empty-center">
          <Icon name="chart" size={36} style={{ color: 'var(--ink-3)' }} />
          <p className="muted">No agent data for this period.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel db-perf" aria-label="Agent Performance">
      <h2 className="db-panel-title">
        <Icon name="chart" size={16} aria-hidden="true" />
        Agent Performance
      </h2>
      <p className="sr-only">Sortable table. Click column header to sort. Click a row to see recent runs.</p>
      <div className="table-wrap">
        <table className="data-table db-perf-table" aria-label="Agent performance metrics">
          <thead>
            <tr>
              {PERF_COLS.map((c) => (
                <SortTh key={c.key} col={c.key} label={c.label} numeric={c.numeric} {...thProps} />
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={row.agent}
                className="db-perf-row"
                style={{ cursor: 'pointer' }}
                role="button"
                tabIndex={0}
                aria-label={`View runs for ${row.agent}`}
                onClick={() => onDrill(row.agent)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDrill(row.agent); } }}
              >
                <td style={{ fontWeight: 580 }}>{row.agent}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(row.runs)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ color: row.successRate >= 0.9 ? 'var(--ok)' : row.successRate >= 0.7 ? 'var(--warn)' : row.successRate != null ? 'var(--danger)' : 'inherit' }}>
                    {fmtPct(row.successRate)}
                  </span>
                </td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(row.p50DurationMs)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(row.p95DurationMs)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(row.avgDurationMs)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row._avgCost > 0 ? formatCost(row._avgCost) : 'â€”'}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row._totalCost > 0 ? formatCost(row._totalCost) : 'â€”'}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(row._totalTokens)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.toolCalls ?? 'â€”'}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ color: row.toolErrors > 0 ? 'var(--danger)' : 'inherit' }}>
                    {row.toolErrors ?? 'â€”'}
                  </span>
                </td>
                <td className="muted" style={{ fontSize: '0.79rem', whiteSpace: 'nowrap' }}>
                  {formatRelative(row.lastRunAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// â”€â”€ Dashboard (main export) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function Dashboard({ user, projects }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState('today');
  const [projectFilter, setProjectFilter] = useState('');
  const { animated, toggleAnimated } = useAnimations();
  const debounceRef = useRef(null);
  // fix 6: ref for toggling db-paused when tab is hidden
  const rootRef = useRef(null);
  // fix 4: drill state lifted so network nodes and table rows share the same DrillModal
  const [drillAgent, setDrillAgent] = useState(null);
  const [drillAgentStats, setDrillAgentStats] = useState(null);
  const [drillRuns, setDrillRuns] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ period });
      if (projectFilter) qs.set('projectId', projectFilter);
      const r = await api.get(`/api/dashboard?${qs}`);
      setData(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [period, projectFilter]);

  useEffect(() => { load(); }, [load]);

  // SSE debounced live-reload
  useEffect(() => {
    const unsub = subscribeGlobal((event) => {
      if (event?.type === 'dashboard.changed') {
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(load, 500);
      }
    });
    return () => { unsub(); clearTimeout(debounceRef.current); };
  }, [load]);

  // fix 4: open the shared drill-down modal; agentStats comes from a network-node click
  const openDrill = useCallback(async (agentName, agentStats = null) => {
    setDrillAgent(agentName);
    setDrillAgentStats(agentStats);
    setDrillLoading(true);
    setDrillError(null);
    setDrillRuns(null);
    try {
      const qs = new URLSearchParams({ period });
      if (projectFilter) qs.set('projectId', projectFilter);
      const r = await api.get(`/api/dashboard/agents/${encodeURIComponent(agentName)}/runs?${qs}`);
      setDrillRuns(r.runs || []);
    } catch (e) {
      setDrillError(e.message);
    } finally {
      setDrillLoading(false);
    }
  }, [period, projectFilter]);

  const closeDrill = useCallback(() => {
    setDrillAgent(null);
    setDrillAgentStats(null);
    setDrillRuns(null);
    setDrillLoading(false);
    setDrillError(null);
  }, []);

  // fix 6: toggle db-paused class to pause CSS animations while the tab is hidden
  useEffect(() => {
    const handleVisibility = () => {
      if (!rootRef.current) return;
      if (document.hidden) {
        rootRef.current.classList.add('db-paused');
      } else {
        rootRef.current.classList.remove('db-paused');
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const greetText = greeting(user?.name || user?.email);
  const sub = data ? `${data.summary?.activeAgents ?? 0} agents active Â· Updated ${formatRelative(data.generatedAt)}` : 'Loadingâ€¦';

  // Derived KPI values
  const summary = data?.summary ?? {};
  const network = data?.network ?? { nodes: [], edges: [] };
  const agents = data?.agents ?? [];
  const recentSessions = data?.recentSessions ?? [];
  const activeSession = data?.activeSession ?? null;

  const completedDelta = summary.completedYesterday != null
    ? summary.completedToday - summary.completedYesterday
    : null;
  const srDelta = summary.successRatePrev != null
    ? (summary.successRate - summary.successRatePrev) * 100
    : null;

  // fix 4: clicking a node opens the same drill-down as a table row (with node stats at top)
  const handleNodeClick = useCallback((nodeId) => {
    const node = network.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    openDrill(node.label || node.id, {
      runs: node.runs,
      successRate: node.successRate,
      avgDurationMs: node.avgDurationMs,
      running: node.running,
    });
  }, [network.nodes, openDrill]);

  return (
    <div
      ref={rootRef}
      className={`page wide db-root${animated ? ' db-anim' : ''}`}
      aria-label="Dashboard"
    >
      {/* â”€â”€ Header â”€â”€ */}
      <section className="db-header" aria-label="Dashboard header">
        <div>
          <h1 className="db-greeting">{greetText}</h1>
          <p className="muted" style={{ fontSize: '0.84rem', marginTop: 2 }}>{sub}</p>
        </div>
        <div className="db-controls" role="group" aria-label="Dashboard controls">
          {/* Period selector */}
          <div role="group" aria-label="Time period">
            {[
              { value: 'today', label: 'Today'   },
              { value: '7d',   label: '7 days'   },
              { value: '30d',  label: '30 days'  },
            ].map((p) => (
              <button
                key={p.value}
                type="button"
                className={`btn btn-sm${period === p.value ? ' btn-primary' : ''}`}
                onClick={() => setPeriod(p.value)}
                aria-pressed={period === p.value}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Project filter */}
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            aria-label="Filter by project"
            style={{ width: 'auto' }}
          >
            <option value="">All projects</option>
            {(projects || []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          {/* Refresh */}
          <button
            type="button"
            className="btn btn-sm"
            onClick={load}
            aria-label="Refresh dashboard"
            disabled={loading}
          >
            <Icon name="refresh" size={13} aria-hidden="true" style={loading ? { animation: 'spin 0.7s linear infinite' } : {}} />
          </button>

          {/* Animation toggle */}
          <AnimToggle animated={animated} onToggle={toggleAnimated} />
        </div>
      </section>

      {/* â”€â”€ Error â”€â”€ */}
      {error && (
        <p className="error-note" role="alert">
          {error} â€”{' '}
          <button type="button" className="btn-link" onClick={load}>Retry</button>
        </p>
      )}

      {/* â”€â”€ KPI cards â”€â”€ */}
      <div className="db-kpis" aria-label="Summary statistics">
        {loading && !data ? (
          <>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="kpi-card db-kpi-card" style={{ animationDelay: `${i * 0.05}s` }}>
                <div className="skeleton skeleton-text" style={{ width: '60%', marginBottom: 8 }} />
                <div className="skeleton" style={{ height: '1.75rem', width: '40%', marginBottom: 8 }} />
                <div className="skeleton skeleton-text" style={{ width: '50%' }} />
              </div>
            ))}
          </>
        ) : (
          <>
            <StatCard
              icon="agents"
              iconColor="var(--accent)"
              label="Total Agents"
              rawValue={summary.totalAgents}
              value={fmt(summary.totalAgents)}
              sub={`${summary.activeAgents ?? 0} active now`}
              animated={animated}
            />
            <StatCard
              icon="terminal"
              iconColor="var(--info)"
              label="Running Sessions"
              rawValue={summary.runningSessions}
              value={fmt(summary.runningSessions)}
              sub={`${summary.queuedSessions ?? 0} queued`}
              animated={animated}
            />
            <StatCard
              icon="check"
              iconColor="var(--ok)"
              label="Completed Today"
              rawValue={summary.completedToday}
              value={fmt(summary.completedToday)}
              deltaValue={completedDelta != null ? Math.abs(completedDelta) : undefined}
              deltaLabel={completedDelta != null
                ? `${completedDelta >= 0 ? '+' : ''}${completedDelta} vs yesterday`
                : undefined}
              deltaDir={completedDelta == null ? undefined : completedDelta >= 0 ? 'up' : 'down'}
              animated={animated}
            />
            <StatCard
              icon="chart"
              iconColor={summary.successRate >= 0.9 ? 'var(--ok)' : 'var(--warn)'}
              label="Success Rate"
              value={fmtPct(summary.successRate)}
              deltaLabel={srDelta != null
                ? `${srDelta >= 0 ? '+' : ''}${srDelta.toFixed(1)} pts vs prev period`
                : undefined}
              deltaDir={srDelta == null ? undefined : srDelta >= 0 ? 'up' : 'down'}
              animated={animated}
            />
          </>
        )}
      </div>

      {/* â”€â”€ Main grid: Network | Active Session â”€â”€ */}
      <div className="db-main-grid">
        {loading && !data ? (
          <>
            <div className="panel db-network">
              <div className="skeleton" style={{ height: 280 }} />
            </div>
            <div className="panel db-active">
              <div className="skeleton skeleton-text db-skeleton-title" />
              <div className="skeleton" style={{ height: 200, marginTop: 12 }} />
            </div>
          </>
        ) : (
          <>
            <AgentNetworkPanel
              nodes={network.nodes}
              edges={network.edges}
              onNodeClick={handleNodeClick}
              animated={animated}
            />
            <ActiveSessionPanel activeSession={activeSession} />
          </>
        )}
      </div>

      {/* â”€â”€ Bottom grid: Recent Sessions | Agent Performance â”€â”€ */}
      <div className="db-bottom-grid">
        {loading && !data ? (
          <>
            <div className="panel db-recent">
              <div className="skeleton skeleton-text db-skeleton-title" />
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton skeleton-row" style={{ marginTop: 8 }} />
              ))}
            </div>
            <div className="panel db-perf">
              <div className="skeleton skeleton-text db-skeleton-title" />
              <div className="skeleton skeleton-row" style={{ marginTop: 8 }} />
              <div className="skeleton skeleton-row" style={{ marginTop: 4 }} />
              <div className="skeleton skeleton-row" style={{ marginTop: 4 }} />
            </div>
          </>
        ) : (
          <>
            <RecentSessionsPanel sessions={recentSessions} />
            <AgentPerformancePanel
              agents={agents}
              onDrill={openDrill}
            />
          </>
        )}
      </div>

      {/* â”€â”€ fix 4: shared drill-down modal used by both network-node clicks and table row clicks â”€â”€ */}
      {drillAgent && (
        <DrillModal
          agent={drillAgent}
          agentStats={drillAgentStats}
          runs={drillRuns}
          loading={drillLoading}
          error={drillError}
          onClose={closeDrill}
        />
      )}
    </div>
  );
}

export default Dashboard;
