/**
 * Dashboard page — portal-wide operations overview.
 *
 * Panels:
 *  1. Greeting header + controls (period, project, refresh, animation toggle)
 *  2. 4 KPI stat cards
 *  3. Needs attention (inbox, idle sessions about to close, failed sessions)
 *  4. Runs per day chart
 *  5. Agent Network graph (SVG radial)
 *  6. Active Session vertical timeline (sidebar)
 *  7. Recent Sessions list
 *  8. Agent Performance sortable table + drill-down modal (columns the deployment does not record are left out)
 *
 * Live updates: subscribes to the global SSE stream, debounced refetch on
 * "dashboard.changed" events.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { AnimatePresence, LayoutGroup, m, useReducedMotion } from 'motion/react';
import { api } from '../lib/api.js';
import { subscribeGlobal } from '../lib/events.js';
import { href } from '../lib/router.js';
import { Icon } from '../components/Icon.jsx';
import { AiCore } from '../components/AiCore.jsx';
import { sparkPath } from '../lib/sparkline.js';
import { CostPanel } from '../components/CostPanel.jsx';
import { DashboardDetails } from '../components/DashboardDetails.jsx';
import { MissionControl } from '../components/MissionControl.jsx';
import { usePageState } from '../lib/page-context.js';
import { useActiveTemplate } from '../lib/theme.js';
import { AttentionPanel, RunsTrendPanel } from '../components/DashboardInsights.jsx';
import { formatRelative, formatUsage } from '../lib/util.js';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';

// ── Format helpers ────────────────────────────────────────────────────────────

function fmt(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtPct(n) {
  if (n === null || n === undefined) return '—';
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function fmtMs(ms) {
  if (!ms) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtTokens(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** What "today" means: the rollups are kept per UTC day, so it starts at UTC midnight, which is some other hour for the viewer. */
export function dayStartLabel(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return undefined;
  return `Since ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} your time (UTC midnight)`;
}

function greeting(name) {
  const h = new Date().getHours();
  const salutation = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = (name || '').split(/[\s@]/)[0] || 'there';
  return `${salutation}, ${first}`;
}

// ── Animation hook ────────────────────────────────────────────────────────────

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

// ── CountUpNumber ─────────────────────────────────────────────────────────────
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

// ── AnimToggle ────────────────────────────────────────────────────────────────

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

// ── StatCard ──────────────────────────────────────────────────────────────────

/** A small trend line under a card, from real daily numbers. Nothing is drawn for fewer than two days. */
function Sparkline({ values, color, label }) {
  const p = sparkPath(values);
  if (!p || p.max === 0) return null; // no runs in the whole period: a flat line says nothing
  return (
    <svg className="kpi-spark" viewBox="0 0 160 28" preserveAspectRatio="none" role="img" aria-label={label} style={color ? { '--spark': color } : undefined}>
      <path className="kpi-spark-area" d={p.area} />
      <path className="kpi-spark-line" d={p.line} pathLength="1" />
      <circle className="kpi-spark-dot" cx={p.last[0]} cy={p.last[1]} r="2.2" />
    </svg>
  );
}

function StatCard({ metric, selected, icon, iconColor, label, value, rawValue, sub, deltaValue, deltaLabel, deltaDir, animated, trend, trendLabel, onExplore, style: cardStyle }) {
  return (
    <article
      className={`kpi-card db-kpi-card${selected ? ' is-selected' : ''}`}
      aria-label={label}
      style={cardStyle}
      data-metric={metric}
    >
      <div className="db-kpi-identity">
        <div className="kpi-label">{label}</div>
      <div className="kpi-value stat-value">
        {value !== null && value !== undefined
          ? (animated && typeof rawValue === 'number' && isFinite(rawValue)
            ? <CountUpNumber value={rawValue} enabled={animated} />
            : value)
          : '—'}
      </div>
      </div>
      {/* A non-painted projection source lets the drawer animate from the card
          without moving or fading the card's actual title and value. */}
      <m.div className="db-kpi-identity db-kpi-motion-source" aria-hidden="true" layoutId={animated ? `metric-${metric}` : undefined} initial={false} transition={{ type: 'spring', stiffness: 420, damping: 38 }}>
        <div className="kpi-label">{label}</div>
        <div className="kpi-value stat-value">{value ?? '—'}</div>
      </m.div>
      <div className="kpi-icon-tile" style={iconColor ? { background: `color-mix(in srgb, ${iconColor} 15%, transparent)`, color: iconColor } : {}}>
        <Icon name={icon} size={16} aria-hidden="true" />
      </div>
      <div className="db-kpi-support">
      {sub && <div style={{ fontSize: '0.78rem', color: 'var(--ink-3)' }}>{sub}</div>}
      {deltaLabel !== undefined && (
        <div className={`kpi-delta${deltaDir === 'up' ? ' ok' : deltaDir === 'down' ? ' warn' : ' muted'}`}>
          {deltaDir === 'up' && <Icon name="chevronRight" size={12} style={{ transform: 'rotate(-90deg)' }} aria-hidden="true" />}
          {deltaDir === 'down' && <Icon name="chevronRight" size={12} style={{ transform: 'rotate(90deg)' }} aria-hidden="true" />}
          <span>{deltaLabel}</span>
        </div>
      )}
      {trend && <Sparkline values={trend} color={iconColor} label={trendLabel} />}
      </div>
      {onExplore && <button type="button" className="db-card-action" aria-label={`Explore ${label}`} aria-haspopup="dialog" aria-expanded={Boolean(selected)} onClick={onExplore}>View details <Icon name="chevronRight" size={13} aria-hidden="true" /></button>}
    </article>
  );
}

// ── Agent Network ─────────────────────────────────────────────────────────────

const MAX_GRAPH_NODES = 12;
// Card width (px) must match the CSS `.db-agent-card { width: }` value so the
// delegation-connector SVG aligns with the children flex row.
const AGENT_CARD_W   = 164;
const AGENT_CARD_GAP = 12;

/**
 * Compact agent card.
 *
 * NOTE: `role="button"` is set explicitly (redundant on <button> but required
 * for the smoke-test attribute selector `[role="button"][aria-label^="…"]`).
 *
 * `.db-node-glow` is kept on the running-state ring so the smoke test that
 * verifies "no animation when toggle is off" can query its animationName.
 */
function AgentCard({ node, animated, onClick }) {
  const successPct = node.successRate != null ? Math.round(node.successRate * 100) : null;
  const ariaLabel = [
    node.label,
    node.running ? 'running' : 'idle',
    `${node.runs} run${node.runs !== 1 ? 's' : ''}`,
    successPct !== null ? `${successPct}% success` : null,
  ].filter(Boolean).join(', ');

  return (
    <button
      type="button"
      role="button"
      className={`db-agent-card${node.running ? ' is-running' : ''}`}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {/* Pulsing glow ring — only rendered for running nodes.
          .db-node-glow is queried by smoke tests for animation verification. */}
      {node.running && (
        <span className="db-card-glow db-node-glow" aria-hidden="true" />
      )}
      <div className="db-card-avatar" aria-hidden="true">
        <Icon name="agents" size={18} />
      </div>
      <div className="db-card-body">
        <span className="db-card-name" title={node.label}>
          {node.label.length > 16 ? node.label.slice(0, 15) + '\u2026' : node.label}
        </span>
        <span className={`db-card-status${node.running ? ' is-running' : ''}`}>
          <span
            className={`dot dot-${node.running ? 'running' : 'stopped'}`}
            aria-hidden="true"
          />
          {node.running ? 'Running' : 'Idle'}
        </span>
        <div className="db-card-stats">
          <span>{fmt(node.runs)} run{node.runs !== 1 ? 's' : ''}</span>
          {successPct !== null && (
            <span style={{
              color: successPct >= 90 ? 'var(--ok)' : successPct >= 70 ? 'var(--warn)' : 'var(--danger)',
            }}>
              {successPct}%
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

/**
 * SVG tree-connector drawn between the lead card and the children row.
 * The SVG width matches the children flex row exactly (same card width + gap
 * arithmetic), so `margin: 0 auto` aligns both correctly.
 */
function DelegationConnector({ childNodes, animated }) {
  const n = childNodes.length;
  if (n === 0) return null;
  const totalW  = n * AGENT_CARD_W + (n - 1) * AGENT_CARD_GAP;
  const midX    = totalW / 2;
  const H       = 28;
  const busY    = 13;
  const childXs = childNodes.map((_, i) => i * (AGENT_CARD_W + AGENT_CARD_GAP) + AGENT_CARD_W / 2);

  return (
    <svg
      aria-hidden="true"
      width={totalW}
      height={H}
      style={{ display: 'block', margin: '0 auto' }}
    >
      {/* Vertical drop from lead centre */}
      <line x1={midX} y1={0} x2={midX} y2={busY}
        stroke="var(--line)" strokeWidth={1.5} strokeOpacity={0.5} />
      {/* Horizontal bus spanning first-to-last child */}
      {n > 1 && (
        <line x1={childXs[0]} y1={busY} x2={childXs[n - 1]} y2={busY}
          stroke="var(--line)" strokeWidth={1.5} strokeOpacity={0.5} />
      )}
      {/* Vertical drops to each child — animated dash when child is running */}
      {childXs.map((x, i) => {
        const isRunning = childNodes[i]?.running;
        return (
          <line
            key={i}
            x1={x} y1={busY} x2={x} y2={H}
            stroke={isRunning ? 'var(--ok)' : 'var(--line)'}
            strokeWidth={isRunning ? 2 : 1.5}
            strokeOpacity={isRunning ? 0.75 : 0.5}
            className={isRunning && animated ? 'db-edge-running' : undefined}
          />
        );
      })}
    </svg>
  );
}

function AgentNetworkPanel({ nodes: rawNodes, edges, onNodeClick, animated }) {
  // All hooks before any early return
  const nodes = useMemo(() => rawNodes.slice(0, MAX_GRAPH_NODES), [rawNodes]);
  const nodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const validEdges = useMemo(
    () => edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target),
    [edges, nodeIds],
  );

  // Determine delegation hierarchy: lead (most outgoing edges) + direct children
  const { leadNode, childNodes, orphanNodes } = useMemo(() => {
    if (validEdges.length === 0) return { leadNode: null, childNodes: [], orphanNodes: nodes };
    const outDeg = {};
    for (const n of nodes) outDeg[n.id] = 0;
    for (const e of validEdges) { outDeg[e.source] = (outDeg[e.source] || 0) + 1; }
    const sorted = [...nodes].sort((a, b) => (outDeg[b.id] || 0) - (outDeg[a.id] || 0));
    const lead = sorted[0];
    const childIds = new Set(
      validEdges.filter((e) => e.source === lead.id).map((e) => e.target),
    );
    return {
      leadNode: lead,
      childNodes: nodes.filter((n) => childIds.has(n.id)),
      orphanNodes: nodes.filter((n) => n.id !== lead.id && !childIds.has(n.id)),
    };
  }, [nodes, validEdges]);

  const hasDelegation = leadNode !== null && childNodes.length > 0;
  // Use tree layout only when children fit in one row without wrapping (≤ 8)
  const useTree = hasDelegation && childNodes.length <= 8;

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

      <div className="db-agent-net">
        {useTree ? (
          /* Tree layout: lead card on top, connector SVG, children row below */
          <>
            <div className="db-agent-net-lead-row">
              <AgentCard
                node={leadNode}
                animated={animated}
                onClick={() => onNodeClick(leadNode.id)}
              />
            </div>
            <DelegationConnector childNodes={childNodes} animated={animated} />
            <div className="db-agent-net-children-row">
              {childNodes.map((node) => (
                <AgentCard
                  key={node.id}
                  node={node}
                  animated={animated}
                  onClick={() => onNodeClick(node.id)}
                />
              ))}
            </div>
            {orphanNodes.length > 0 && (
              <div className="db-agent-card-grid" style={{ marginTop: 12 }}>
                {orphanNodes.map((node) => (
                  <AgentCard
                    key={node.id}
                    node={node}
                    animated={animated}
                    onClick={() => onNodeClick(node.id)}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          /* Flat grid layout — no delegation or > 8 children */
          <>
            {leadNode && (
              <div className="db-agent-net-lead-row" style={{ marginBottom: 12 }}>
                <AgentCard
                  node={leadNode}
                  animated={animated}
                  onClick={() => onNodeClick(leadNode.id)}
                />
              </div>
            )}
            <div className="db-agent-card-grid">
              {[...childNodes, ...orphanNodes].map((node) => (
                <AgentCard
                  key={node.id}
                  node={node}
                  animated={animated}
                  onClick={() => onNodeClick(node.id)}
                />
              ))}
            </div>
          </>
        )}

        {/* Single-agent hint */}
        {nodes.length === 1 && (
          <p className="db-agent-net-hint">
            Delegated agents appear here when the lead agent hands off work.
          </p>
        )}

        {/* Legend */}
        {nodes.length > 1 && (
          <div className="db-net-legend-bar" aria-hidden="true">
            <span className="db-net-legend-item">
              <span className="dot dot-running" style={{ width: 8, height: 8, flexShrink: 0 }} />
              Running
            </span>
            <span className="db-net-legend-item">
              <span className="dot dot-stopped" style={{ width: 8, height: 8, flexShrink: 0 }} />
              Idle
            </span>
            {hasDelegation && (
              <span className="db-net-legend-item">
                <svg aria-hidden="true" width={20} height={8} style={{ flexShrink: 0 }}>
                  <line x1={0} y1={4} x2={14} y2={4}
                    stroke="var(--ink-3)" strokeWidth={1.5} strokeOpacity={0.6} />
                  <polygon points="12,1 16,4 12,7" fill="var(--ink-3)" opacity={0.6} />
                </svg>
                Delegation
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ── Recent Sessions ───────────────────────────────────────────────────────────

// fix 3: done → success pill; cover all real run/session statuses
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
                  {title.length > 55 ? title.slice(0, 54) + '…' : title}
                </a>
                <div className="db-session-meta">
                  {agents.length > 0 && (
                    <span className="db-session-agents" aria-label={`Agent chain: ${agents.join(' → ')}`}>
                      {agents.slice(0, 3).join(' → ')}{agents.length > 3 ? ' +' + (agents.length - 3) : ''}
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

// Recorded agent history, shared by the network and performance table.
function DrillModal({ agent, agentStats, runs, loading, error, onClose }) {
  // Trap focus inside modal on mount
  const modalRef = useRef(null);
  const overlayDismiss = useOverlayDismiss(onClose);
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
      onMouseDown={overlayDismiss.onMouseDown}
      onClick={overlayDismiss.onClick}
    >
      <div ref={modalRef} className="modal modal-wide db-drill-modal">
        <div className="modal-header">
          <h2 id="drill-title">
            <Icon name="agents" size={16} aria-hidden="true" style={{ marginRight: 6 }} />
            {agent}
            <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>— recent runs</span>
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
            <div className="spinner" aria-label="Loading runs…" />
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
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatUsage(r.costUsd, r.credits)}</td>
                    {/* fix 2: tokens is {input, output}; display total with tooltip for split */}
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {r.tokens != null
                        ? <span title={`In: ${fmtTokens(r.tokens.input)} / Out: ${fmtTokens(r.tokens.output)}`}>
                            {fmtTokens((r.tokens.input ?? 0) + (r.tokens.output ?? 0))}
                          </span>
                        : '—'}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.toolCalls ?? '—'}</td>
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

// ── Agent Performance ─────────────────────────────────────────────────────────

const PERF_COLS = [
  { key: 'agent',          label: 'Agent',       numeric: false },
  { key: 'runs',           label: 'Runs',        numeric: true  },
  { key: 'successRate',    label: 'Success %',   numeric: true  },
  { key: 'p50DurationMs',  label: 'p50',         numeric: true  },
  { key: 'p95DurationMs',  label: 'p95',         numeric: true  },
  { key: 'avgDurationMs',  label: 'Avg dur.',    numeric: true  },
  // fix 1: costUsd is the TOTAL; _avgCost = costUsd / runs for per-run average
  { key: '_avgCost',       label: 'Avg usage',   numeric: true  },
  { key: '_totalCost',     label: 'Total usage', numeric: true  },
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
      // Kiro bills in credits, not dollars: kept apart and shown as credits
      _totalCredits: a.credits || 0,
      _avgCredits: (a.runs || 0) > 0 ? (a.credits || 0) / a.runs : 0,
      _totalTokens: (a.inputTokens || 0) + (a.outputTokens || 0),
    }));
  }, [rawAgents]);

  const sorted = useMemo(() => sortRows(agents, sortCol, sortDir), [agents, sortCol, sortDir]);

  // A deployment that does not record a number sends null (percentiles) or a flat 0 (tool calls): a column of "0 errors" or "—" would
  // read as a result, so those columns are left out and a line says so.
  const left = useMemo(() => {
    const noCalls = agents.every((a) => !a.toolCalls);
    return {
      p50DurationMs: agents.every((a) => a.p50DurationMs == null),
      p95DurationMs: agents.every((a) => a.p95DurationMs == null),
      toolCalls: noCalls,
      toolErrors: noCalls,
      // Runs that report no usage (Kiro) add up to 0 tokens: that is "not reported", not "none used".
      _totalTokens: agents.every((a) => !a._totalTokens),
    };
  }, [agents]);
  const cols = PERF_COLS.filter((c) => !left[c.key]);
  const leftOut = PERF_COLS.filter((c) => left[c.key]).map((c) => c.label);

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
              {cols.map((c) => (
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
                {!left.p50DurationMs && <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(row.p50DurationMs)}</td>}
                {!left.p95DurationMs && <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(row.p95DurationMs)}</td>}
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMs(row.avgDurationMs)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatUsage(row._avgCost, row._avgCredits)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatUsage(row._totalCost, row._totalCredits)}</td>
                {!left._totalTokens && <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(row._totalTokens)}</td>}
                {!left.toolCalls && <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.toolCalls ?? '—'}</td>}
                {!left.toolErrors && (
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: row.toolErrors > 0 ? 'var(--danger)' : 'inherit' }}>
                      {row.toolErrors ?? '—'}
                    </span>
                  </td>
                )}
                <td className="muted" style={{ fontSize: '0.79rem', whiteSpace: 'nowrap' }}>
                  {formatRelative(row.lastRunAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {leftOut.length > 0 && (
        <p className="muted db-perf-note">Not recorded here, so not shown: {leftOut.join(', ')}.</p>
      )}
    </section>
  );
}

// ── Dashboard (main export) ───────────────────────────────────────────────────

export function Dashboard({ user, projects }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [period, setPeriod] = usePageState('dashboard-period', 'today', (value) => ['today', '7d', '30d'].includes(value));
  const [detailMetric, setDetailMetric] = useState(null);
  // An old /p/:id/insights link redirects here and leaves the project to preselect.
  const [projectFilter, setProjectFilter] = usePageState('dashboard-project', '', (value) => typeof value === 'string');
  useEffect(() => {
    try {
      const p = sessionStorage.getItem('dash-project');
      sessionStorage.removeItem('dash-project');
      if (p) setProjectFilter(p);
    } catch { /* Storage is optional. */ }
  }, []);
  useEffect(() => {
    if (Array.isArray(projects) && projectFilter && !projects.some((project) => project.id === projectFilter)) setProjectFilter('');
  }, [projects, projectFilter]);
  const { animated: animationsOn, toggleAnimated } = useAnimations();
  const reducedMotion = useReducedMotion();
  const template = useActiveTemplate();
  const animated = animationsOn && !reducedMotion && !['none', 'reduced'].includes(template?.effects?.motion);
  const pendingAgent = useRef(null);
  const debounceRef = useRef(null);
  // fix 6: ref for toggling db-paused when tab is hidden
  const rootRef = useRef(null);
  // fix 4: drill state lifted so network nodes and table rows share the same DrillModal
  const [drillAgent, setDrillAgent] = useState(null);
  const [drillAgentStats, setDrillAgentStats] = useState(null);
  const [drillRuns, setDrillRuns] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState(null);
  const dashboardRequest = useRef(0);
  const agentRequest = useRef(0);

  const load = useCallback(async () => {
    const request = ++dashboardRequest.current;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ period });
      if (projectFilter) qs.set('projectId', projectFilter);
      const r = await api.get(`/api/dashboard?${qs}`);
      if (request === dashboardRequest.current) setData(r);
    } catch (e) {
      if (request === dashboardRequest.current) setError(e.message);
    } finally {
      if (request === dashboardRequest.current) setLoading(false);
    }
  }, [period, projectFilter]);

  useEffect(() => {
    load();
    return () => { dashboardRequest.current++; agentRequest.current++; };
  }, [load]);

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
  const openDrill = useCallback(async (agentName, agentStats = null, runPeriod = period) => {
    const request = ++agentRequest.current;
    setDrillAgent(agentName);
    setDrillAgentStats(agentStats);
    setDrillLoading(true);
    setDrillError(null);
    setDrillRuns(null);
    try {
      const qs = new URLSearchParams({ period: runPeriod });
      if (projectFilter) qs.set('projectId', projectFilter);
      const r = await api.get(`/api/dashboard/agents/${encodeURIComponent(agentName)}/runs?${qs}`);
      if (request === agentRequest.current) setDrillRuns(r.runs || []);
    } catch (e) {
      if (request === agentRequest.current) setDrillError(e.message);
    } finally {
      if (request === agentRequest.current) setDrillLoading(false);
    }
  }, [period, projectFilter]);

  const closeDrill = useCallback(() => {
    agentRequest.current++;
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
  const sub = data ? `${data.summary?.activeAgents ?? 0} agents active · Updated ${formatRelative(data.generatedAt)}` : 'Loading…';

  // Derived KPI values
  const summary = data?.summary ?? {};
  const network = data?.network ?? { nodes: [], edges: [] };
  const agents = data?.agents ?? [];
  const recentSessions = data?.recentSessions ?? [];
  const activeSession = data?.activeSession ?? null;

  // The rate is out of the runs that ended on their own; "no finished runs" is not 0%.
  const endedOnTheirOwn = (summary.finishedRuns ?? 0) - (summary.stoppedRuns ?? 0);
  const rateKnown = endedOnTheirOwn > 0;

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

  // The core shows what the portal is doing: agents running, or a failed load; otherwise it idles.
  const coreState = error ? 'failed' : (summary.runningSessions ?? 0) > 0 ? 'running' : 'idle';
  // Daily numbers for the sparklines under two of the cards.
  const dailyDone = (data?.daily ?? []).map((d) => d.done);
  const dailyRate = (data?.daily ?? []).map((d) => (d.done + d.failed > 0 ? d.done / (d.done + d.failed) : null));

  return (
    <LayoutGroup id="dashboard-metrics">
    <div
      ref={rootRef}
      className={`page wide db-root${animated ? ' db-anim' : ''}${loading && data ? ' db-updating' : ''}`}
      aria-label="Dashboard"
    >
      {/* ── Header ── */}
      <section className="db-header" aria-label="Dashboard header">
        <div className="db-header-core">
          <AiCore state={coreState} active={summary.runningSessions ?? 0} size={84} animated={animated} />
          <div>
            <span className="db-eyebrow">Operations overview</span>
            <h1 className="db-greeting">{greetText}</h1>
            <p className="muted" style={{ fontSize: '0.84rem', marginTop: 2 }}>{sub}</p>
          </div>
        </div>
        <div className="db-controls" role="group" aria-label="Dashboard controls">
          <a className="btn btn-primary db-open-sessions" href={projectFilter ? href(projectFilter, 'sessions') : '#/projects'}>
            <Icon name="terminal" size={14} aria-hidden="true" />
            {projectFilter ? 'Open sessions' : 'Choose project'}
          </a>
          {/* Period selector */}
          <div className="db-period-selector" role="group" aria-label="Time period" style={{ '--period-index': ['today', '7d', '30d'].indexOf(period) }}>
            <span className="db-period-highlight" aria-hidden="true" />
            {[
              { value: 'today', label: 'Today'   },
              { value: '7d',   label: '7 days'   },
              { value: '30d',  label: '30 days'  },
            ].map((p) => (
              <button
                key={p.value}
                type="button"
                className="btn btn-sm db-period-button"
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
          {loading && data && <span className="db-update-status" role="status">Updating results…</span>}
        </div>
      </section>

      {/* ── Error ── */}
      {error && (
        <p className="error-note" role="alert">
          {error} —{' '}
          <button type="button" className="btn-link" onClick={load}>Retry</button>
        </p>
      )}

      {/* ── KPI cards ── */}
      <AttentionPanel
        idleClosing={data?.idleClosing}
        recentSessions={recentSessions}
        projectFilter={projectFilter}
        refreshKey={data?.generatedAt}
      />
      {/* Live work leads the overview; metrics remain available immediately below. */}
      <div className="db-main-grid">
        {loading && !data ? <><div className="panel db-active"><div className="skeleton" style={{ height: 280 }} /></div><div className="panel db-network"><div className="skeleton" style={{ height: 280 }} /></div></> : <>
          <MissionControl activeSession={activeSession} recentSessions={recentSessions} projectId={projectFilter} animated={animated} />
          {data && <RunsTrendPanel daily={data.daily} period={period} onPeriodChange={setPeriod} />}
        </>}
      </div>

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
              metric="agents"
              selected={detailMetric === 'agents'}
              onExplore={() => setDetailMetric('agents')}
              rawValue={summary.totalAgents}
              value={fmt(summary.totalAgents)}
              sub={`${summary.activeAgents ?? 0} active now`}
              animated={animated}
            />
            <StatCard
              icon="terminal"
              iconColor="var(--info)"
              label="Running Sessions"
              metric="running"
              selected={detailMetric === 'running'}
              onExplore={() => setDetailMetric('running')}
              rawValue={summary.runningSessions}
              value={fmt(summary.runningSessions)}
              sub={`${summary.queuedSessions ?? 0} queued`}
              animated={animated}
            />
            <StatCard
              icon="check"
              iconColor="var(--ok)"
              label="Runs Completed Today"
              metric="completed"
              selected={detailMetric === 'completed'}
              onExplore={() => setDetailMetric('completed')}
              rawValue={summary.completedToday}
              value={fmt(summary.completedToday)}
              sub={dayStartLabel(summary.dayStartUtc)}
              trend={dailyDone}
              trendLabel="Runs completed per day"
              deltaValue={completedDelta != null ? Math.abs(completedDelta) : undefined}
              deltaLabel={completedDelta === 0 ? 'No change vs yesterday' : completedDelta != null
                ? `${completedDelta >= 0 ? '+' : ''}${completedDelta} vs yesterday`
                : undefined}
              deltaDir={!completedDelta ? undefined : completedDelta > 0 ? 'up' : 'down'}
              animated={animated}
            />
            <StatCard
              icon="chart"
              iconColor={rateKnown && summary.successRate >= 0.9 ? 'var(--ok)' : 'var(--warn)'}
              label="Success Rate"
              metric="success"
              selected={detailMetric === 'success'}
              onExplore={() => setDetailMetric('success')}
              value={rateKnown ? fmtPct(summary.successRate) : null}
              sub={rateKnown
                ? `${summary.failedRuns ?? 0} failed${summary.stoppedRuns ? ` · ${summary.stoppedRuns} stopped by you (not counted)` : ''}`
                : (summary.stoppedRuns ? `${summary.stoppedRuns} stopped by you, none finished on their own` : 'No finished runs in this period')}
              deltaLabel={rateKnown && srDelta != null
                ? `${srDelta >= 0 ? '+' : ''}${srDelta.toFixed(1)} pts vs prev period`
                : undefined}
              deltaDir={!rateKnown || srDelta == null ? undefined : srDelta >= 0 ? 'up' : 'down'}
              trend={dailyRate}
              trendLabel="Success rate per day"
              animated={animated}
            />
          </>
        )}
      </div>

      <CostPanel period={period} projectId={projectFilter} user={user} refreshKey={data?.generatedAt} />

      <details className="db-network-disclosure">
        <summary><Icon name="agents" size={16} aria-hidden="true" /> Agent network <span>Explore agent activity and collaboration</span></summary>
        <AgentNetworkPanel
          nodes={network.nodes}
          edges={network.edges}
          onNodeClick={handleNodeClick}
          animated={animated}
        />
      </details>

      {/* ── Bottom grid: Recent Sessions | Agent Performance ── */}
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

      {/* ── fix 4: shared drill-down modal used by both network-node clicks and table row clicks ── */}
      <AnimatePresence onExitComplete={() => {
        const next = pendingAgent.current;
        if (next) { pendingAgent.current = null; openDrill(next.agent, null, next.period); }
      }}>
        {detailMetric && <DashboardDetails
          key={detailMetric}
          metric={detailMetric}
          value={detailMetric === 'agents' ? fmt(summary.totalAgents) : detailMetric === 'running' ? fmt(summary.runningSessions) : detailMetric === 'completed' ? fmt(summary.completedToday) : rateKnown ? fmtPct(summary.successRate) : '—'}
          animated={animated}
          data={data} period={period} projectId={projectFilter} projects={projects}
          onClose={() => setDetailMetric(null)}
          onAgent={(agent, runPeriod) => { pendingAgent.current = { agent, period: runPeriod }; setDetailMetric(null); }}
        />}
      </AnimatePresence>
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
    </LayoutGroup>
  );
}

export default Dashboard;
