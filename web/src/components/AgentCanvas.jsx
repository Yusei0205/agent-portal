import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LAYOUT, initials, layoutTree, liveNode, shapeKey } from '../lib/graphLayout.js';
import { nowLine } from '../lib/tree.js';
import { cx, hueFor, money, tokens } from '../lib/util.js';
import { AgentGraph } from './AgentGraph.jsx';
import { Icon } from './Icon.jsx';
import { Segmented } from './ui.jsx';

const STATUS_TEXT = { running: 'working', done: 'done', failed: 'failed', stopped: 'stopped', waiting: 'waiting for you' };
const R = 28; // bubble radius
const CAPTION = 64; // label, "now" line and stats under a bubble
const VIEW_KEY = 'portal.agentView';

function readView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'canvas' || v === 'list') return v;
  } catch {
    /* storage may be blocked */
  }
  return typeof window !== 'undefined' && window.innerWidth < 600 ? 'list' : 'canvas';
}

/**
 * The agents of one run: a live canvas of bubbles (main agent on top, the subagents it starts below it), or the
 * nested list. Clicking an agent selects it; "Follow live" keeps the agent that is acting right now selected.
 */
export function AgentView({ tree, selected, onSelect, live }) {
  const [view, setView] = useState(readView);
  const [follow, setFollow] = useState(Boolean(live));
  const [expanded, setExpanded] = useState(false);
  const chooseView = (v) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* not essential */
    }
  };
  // Follow live: select whichever agent acted last while the run works.
  const target = follow && live ? liveNode(tree.nodes)?.id : null;
  useEffect(() => {
    if (target && target !== selected) onSelect(target);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e) => e.key === 'Escape' && setExpanded(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expanded]);
  const pick = (id) => {
    setFollow(false);
    onSelect(id);
  };
  const working = [...tree.nodes.values()].filter((n) => n.status === 'running').length;
  return (
    <section className={cx('agraph ac', expanded && 'is-expanded')} aria-label="Agents">
      <div className="agraph-head ac-head">
        <h2>Agents</h2>
        <span className="muted small">
          {tree.root.totals.subagents} subagent{tree.root.totals.subagents === 1 ? '' : 's'}
          {working ? ` · ${working} working now` : ''}
        </span>
        <span className="ac-tools">
          {live ? (
            <button type="button" className={cx('btn btn-sm', follow ? 'btn-primary' : 'btn-default')} aria-pressed={follow} onClick={() => setFollow((f) => !f)} title="Keep the agent that is acting right now selected">
              <span className={cx('live-dot', !follow && 'is-off')} aria-hidden="true" /> Follow live
            </button>
          ) : null}
          <Segmented size="sm" value={view} onChange={chooseView} label="Agents view" options={[{ value: 'canvas', label: 'Canvas' }, { value: 'list', label: 'List' }]} />
          <button type="button" className="icon-btn" onClick={() => setExpanded((x) => !x)} aria-pressed={expanded} aria-label={expanded ? 'Leave full screen' : 'Full screen'} title={expanded ? 'Leave full screen (Esc)' : 'Full screen'}>
            <Icon name={expanded ? 'x' : 'external'} size={15} />
          </button>
        </span>
      </div>
      {view === 'canvas' ? <AgentCanvas tree={tree} selected={selected} onSelect={pick} expanded={expanded} /> : <AgentGraph tree={tree} selected={selected} onSelect={pick} bare />}
    </section>
  );
}

function AgentCanvas({ tree, selected, onSelect, expanded }) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  const key = shapeKey(tree.root, collapsed);
  // Positions depend on the shape only, so bubbles stay put while statuses and counts change.
  const L = useMemo(() => layoutTree(tree.root, { collapsed }), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const viewport = useRef(null);
  const refs = useRef(new Map());
  const [zoom, setZoom] = useState(1);
  const userZoomed = useRef(false);

  const fit = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const z = Math.min(1, (el.clientWidth - 8) / L.width);
    setZoom(Math.max(0.45, Math.round(z * 100) / 100));
  }, [L.width]);
  // Fit when the tree grows wider than the view, unless someone zoomed by hand.
  useLayoutEffect(() => {
    if (!userZoomed.current) fit();
  }, [fit, expanded]);
  const zoomBy = (d) => {
    userZoomed.current = true;
    setZoom((z) => Math.min(1.6, Math.max(0.4, Math.round((z + d) * 100) / 100)));
  };

  // Keep the selected bubble in view.
  useEffect(() => {
    const el = viewport.current;
    const p = L.pos.get(selected);
    if (!el || !p) return;
    const x = p.x * zoom;
    const y = p.y * zoom;
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 40) el.scrollTo({ left: x - el.clientWidth / 2, behavior: 'smooth' });
    if (y < el.scrollTop + 20 || y > el.scrollTop + el.clientHeight - 80) el.scrollTo({ top: y - el.clientHeight / 3, behavior: 'smooth' });
  }, [selected, L, zoom]);

  // Drag the background to pan; Ctrl/Cmd + wheel zooms.
  const drag = useRef(null);
  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const el = viewport.current;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const el = viewport.current;
    el.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
    el.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const endDrag = () => {
    drag.current = null;
  };
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 0.1 : -0.1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Arrow keys move between agents: up to the parent, down to the first child, left/right to siblings.
  const onKey = (e, id) => {
    const parentId = L.parent.get(id);
    const siblings = parentId ? L.edges.filter((x) => x.from === parentId).map((x) => x.to) : [id];
    const i = siblings.indexOf(id);
    const next = {
      ArrowUp: parentId,
      ArrowDown: L.edges.find((x) => x.from === id)?.to,
      ArrowLeft: siblings[i - 1],
      ArrowRight: siblings[i + 1],
    }[e.key];
    if (!next) return;
    e.preventDefault();
    refs.current.get(next)?.focus();
    onSelect(next);
  };

  const toggle = (id) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const nodes = [...L.pos.keys()].map((id) => tree.nodes.get(id)).filter(Boolean);
  return (
    <div className="ac-wrap">
      <div className="ac-zoom" role="group" aria-label="Zoom">
        <button type="button" className="icon-btn" onClick={() => zoomBy(-0.15)} aria-label="Zoom out">
          −
        </button>
        <button
          type="button"
          className="btn btn-sm btn-default"
          onClick={() => {
            userZoomed.current = false;
            fit();
          }}
        >
          Fit
        </button>
        <button type="button" className="icon-btn" onClick={() => zoomBy(0.15)} aria-label="Zoom in">
          +
        </button>
      </div>
      <div className="ac-viewport" ref={viewport} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <div className="ac-stage" style={{ width: L.width * zoom, height: L.height * zoom }}>
          <div className="ac-plane" style={{ width: L.width, height: L.height, transform: `scale(${zoom})` }}>
            <svg className="ac-edges" width={L.width} height={L.height} aria-hidden="true">
              {L.edges.map(({ from, to }) => {
                const a = L.pos.get(from);
                const b = L.pos.get(to);
                const child = tree.nodes.get(to);
                const y1 = a.y + R + CAPTION;
                const y2 = b.y - R - 6;
                const mid = (y1 + y2) / 2;
                return <path key={`${from}>${to}`} className={cx('ac-edge', child && `ac-edge-${child.status}`)} d={`M ${a.x} ${y1} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${y2}`} />;
              })}
            </svg>
            {nodes.map((n) => {
              const p = L.pos.get(n.id);
              const hue = n.kind === 'main' ? null : hueFor(n.label);
              const line = nowLine(n);
              const isCollapsed = collapsed.has(n.id);
              const hidden = isCollapsed ? countBelow(n) : 0;
              return (
                <div key={n.id} className="ac-slot" style={{ left: p.x - LAYOUT.colW / 2, top: p.y - R, width: LAYOUT.colW, ...(hue !== null ? { '--role-h': hue } : null) }}>
                  <button
                    type="button"
                    ref={(el) => (el ? refs.current.set(n.id, el) : refs.current.delete(n.id))}
                    className={cx('ac-bubble', `ac-${n.status}`, n.kind === 'main' && 'ac-main', selected === n.id && 'is-selected')}
                    onClick={() => onSelect(n.id)}
                    onKeyDown={(e) => onKey(e, n.id)}
                    aria-pressed={selected === n.id}
                    aria-label={`${n.kind === 'main' ? 'Main agent' : n.label}, ${STATUS_TEXT[n.status] ?? n.status}, ${n.toolCount} tools${line ? `. ${line}` : ''}`}
                    title={line || undefined}
                  >
                    <span className="ac-orb" aria-hidden="true">
                      <span className="ac-initials">{n.kind === 'main' ? <Icon name="runs" size={20} /> : initials(n.label)}</span>
                      {n.status === 'done' ? <span className="ac-mark"><Icon name="check" size={11} /></span> : n.status === 'failed' ? <span className="ac-mark"><Icon name="x" size={11} /></span> : n.status === 'waiting' ? <span className="ac-mark">?</span> : null}
                    </span>
                    <span className="ac-label">{n.kind === 'main' ? 'Main agent' : n.label}</span>
                    <span className="ac-now">{n.status === 'running' ? line || 'working…' : STATUS_TEXT[n.status] ?? n.status}</span>
                    <span className="ac-stats">
                      {n.toolCount} tool{n.toolCount === 1 ? '' : 's'} · {tokens(n.inputTokens + n.outputTokens)}
                      {n.cost ? ` · ≈${money(n.cost)}` : ''}
                    </span>
                  </button>
                  {n.children.length && n.status !== 'running' ? (
                    <button type="button" className="ac-fold" onClick={() => toggle(n.id)} aria-expanded={!isCollapsed} aria-label={isCollapsed ? `Show ${hidden} agents under ${n.label}` : `Hide the agents under ${n.label}`}>
                      {isCollapsed ? `+${hidden}` : '−'}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function countBelow(n) {
  return n.children.reduce((sum, c) => sum + 1 + countBelow(c), 0);
}
