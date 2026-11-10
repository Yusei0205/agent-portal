/**
 * Orbit view of a session's agents: the main agent in the centre, the agents it started around it, and the agents those
 * started further out. Running agents glow and pulse and show what they are doing; a badge counts each agent's tool calls.
 *
 * Select an agent by clicking it or with the arrow keys. Scroll or pinch to zoom, drag to pan, double-click an agent to zoom
 * to it, and + / - / 0 on the keyboard to zoom in, out and fit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { orbitLayout, neighbourInDirection, nervePath, ORBIT_MAIN } from '../../lib/agent-orbit.js';
import { badgeCount, agentLabels, increasedTools } from '../../lib/agent-activity.js';

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const ARROWS = { ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 } };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function statusClass(status) {
  if (status === 'running' || status === 'pending') return 'is-running';
  if (status === 'failed' || status === 'stopped') return 'is-failed';
  return 'is-done';
}

/** True when the person asked their system for less motion; the signals along the links are drawn only when it is false. */
function useReducedMotion() {
  const query = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null);
  const [reduced, setReduced] = useState(() => Boolean(query()?.matches));
  useEffect(() => {
    const m = query();
    if (!m) return undefined;
    const on = () => setReduced(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/**
 * @param {{ agents: Array<object>, rootName?: string, rootStatus?: string,
 *   activity: { main: object, byId: Map<string, object> }, selectedId: string | null, onSelect: (id: string) => void }} props
 */
export function AgentOrbit({ agents, rootName = 'Main agent', rootStatus = 'running', activity, selectedId, onSelect }) {
  const layout = useMemo(() => orbitLayout(agents), [agents]);
  const box = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const reduced = useReducedMotion();
  const touched = useRef(false); // once the person pans or zooms, stop re-fitting for them
  const drag = useRef(null);
  const moved = useRef(false);

  // Fit what is actually there (the agents and their names), not the outermost ring: a wide panel then shows it larger.
  const bounds = useMemo(() => ({
    halfW: Math.max(...layout.nodes.map((n) => Math.abs(n.x))) + 95,
    halfH: Math.max(...layout.nodes.map((n) => Math.abs(n.y))) + 75,
  }), [layout]);
  const fit = useCallback((w = size.w, h = size.h) => {
    if (!w || !h) return;
    const k = clamp(Math.min(w / (2 * bounds.halfW), h / (2 * bounds.halfH)), MIN_ZOOM, 1.15);
    setView({ x: w / 2, y: h / 2, k });
  }, [size.w, size.h, bounds]);

  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => { const r = el.getBoundingClientRect(); setSize({ w: r.width, h: r.height }); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit when the size or the number of rings changes, until the person takes over.
  useEffect(() => { if (!touched.current) fit(); }, [fit]);

  const zoomAt = useCallback((factor, cx, cy) => {
    touched.current = true;
    setView((v) => {
      const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM);
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  }, []);

  // Wheel needs a non-passive listener so the page does not scroll while zooming.
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const zoomBy = (factor) => zoomAt(factor, size.w / 2, size.h / 2);
  const zoomTo = (node) => {
    touched.current = true;
    setView({ k: 1.6, x: size.w / 2 - node.x * 1.6, y: size.h / 2 - node.y * 1.6 });
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    moved.current = false;
    // The pointer is captured only once it starts to drag: capturing on press would send the click that follows to this
    // box instead of the agent that was pressed.
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!moved.current && Math.abs(dx) + Math.abs(dy) > 4) {
      moved.current = true;
      touched.current = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    if (moved.current) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = () => { drag.current = null; };

  const pick = (id) => { if (!moved.current) onSelect(id); };

  const onKeyDown = (e) => {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.25); return; }
    if (e.key === '-') { e.preventDefault(); zoomBy(0.8); return; }
    if (e.key === '0') { e.preventDefault(); touched.current = false; fit(); return; }
    const dir = ARROWS[e.key];
    if (!dir) return;
    e.preventDefault();
    const next = neighbourInDirection(layout.nodes, selectedId, dir);
    if (next) onSelect(next);
  };

  const rowOf = Object.fromEntries(agents.map((a) => [a.id, a]));
  const labels = useMemo(() => agentLabels(agents), [agents]);
  const nodeInfo = (n) => {
    if (n.isMain) {
      const act = activity.main;
      return { name: rootName, status: rootStatus, current: rootStatus === 'running' ? act.current : '', tools: act.tools, r: 30 };
    }
    const a = rowOf[n.id];
    const act = activity.byId.get(n.id) ?? { tools: 0, current: '' };
    const live = a.status === 'running' || a.status === 'pending';
    return { name: labels.get(a.id) ?? a.name, status: a.status, current: live ? act.current || a.description || '' : '', tools: act.tools, r: 22 };
  };
  const at = Object.fromEntries(layout.nodes.map((n) => [n.id, n]));

  // An agent "fires" (its node ripples) each time it makes another tool call.
  const counts = useMemo(() => {
    const m = { [ORBIT_MAIN]: activity.main.tools };
    for (const [id, a] of activity.byId) m[id] = a.tools;
    return m;
  }, [activity]);
  const lastCounts = useRef(null);
  const [fired, setFired] = useState({});
  useEffect(() => {
    const ids = increasedTools(lastCounts.current, counts);
    lastCounts.current = counts;
    if (!ids.length) return;
    const stamp = Date.now();
    setFired((f) => ({ ...f, ...Object.fromEntries(ids.map((id) => [id, stamp])) }));
    setTimeout(() => setFired((f) => { const n = { ...f }; for (const id of ids) if (n[id] === stamp) delete n[id]; return n; }), 1400);
  }, [counts]);

  return (
    <div className="orbit" ref={box} tabIndex={0} role="application" aria-label="Agents orbit view. Arrow keys move between agents."
      onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <svg className="orbit-svg" width={size.w} height={size.h} role="group" aria-label="Agents">
        <defs>
          <radialGradient id="orbit-halo" r="50%">
            <stop offset="0%" stopColor="#5b8cff" stopOpacity="0.55" />
            <stop offset="60%" stopColor="#3a5fcf" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#3a5fcf" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <circle className="orbit-halo" r="150" fill="url(#orbit-halo)" />
          {layout.rings.map((r) => <circle key={r} className="orbit-ring" r={r} fill="none" />)}
          {layout.edges.map((e, i) => {
            const a = at[e.from];
            const b = at[e.to];
            const status = rowOf[e.to]?.status;
            const live = status === 'running' || status === 'pending';
            const failed = status === 'failed' || status === 'stopped';
            const { d, length } = nervePath(a, b, i % 2 ? 1 : -1);
            const dur = Math.min(3.4, Math.max(1.3, length / 100));
            return (
              <g key={`${e.from}>${e.to}`} className={`orbit-nerve${live ? ' is-live' : ''}${failed ? ' is-failed' : ''}`}>
                <path className="orbit-nerve-glow" d={d} fill="none" />
                <path className="orbit-nerve-line" d={d} fill="none" />
                {/* Bright signals run out along the fibre to an agent that is working. */}
                {!reduced && live && [0, 1].map((k) => (
                  <circle key={k} className="orbit-signal" r="3.2">
                    <animateMotion path={d} dur={`${dur}s`} begin={`${(k * dur) / 2}s`} repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.8;1" dur={`${dur}s`} begin={`${(k * dur) / 2}s`} repeatCount="indefinite" />
                  </circle>
                ))}
                {/* A finished agent's fibre still carries a faint, slow pulse back toward the centre, now and then. */}
                {!reduced && !live && !failed && (
                  <circle className="orbit-signal is-ambient" r="2.4">
                    <animateMotion path={d} dur="9s" keyPoints="1;0;0" keyTimes="0;0.28;1" calcMode="linear" begin={`${(i * 1.7) % 6}s`} repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0;0.8;0.8;0;0" keyTimes="0;0.04;0.24;0.28;1" dur="9s" begin={`${(i * 1.7) % 6}s`} repeatCount="indefinite" />
                  </circle>
                )}
              </g>
            );
          })}
          {layout.nodes.map((n) => {
            const info = nodeInfo(n);
            const id = n.isMain ? ORBIT_MAIN : n.id;
            const cls = statusClass(info.status);
            const running = cls === 'is-running';
            return (
              <g key={id} className={`orbit-node ${cls}${id === selectedId ? ' is-selected' : ''}`} transform={`translate(${n.x} ${n.y})`}
                role="button" aria-label={`${info.name}, ${info.status}`} aria-pressed={id === selectedId}
                onClick={() => pick(id)} onDoubleClick={() => zoomTo(n)}>
                {running && <circle className="orbit-pulse" r={info.r + 10} />}
                {running && <circle className="orbit-pulse orbit-pulse-2" r={info.r + 10} />}
                {fired[id] && <circle key={fired[id]} className="orbit-fire" r={info.r + 4} />}
                <circle className="orbit-dash" r={info.r + 8} fill="none" />
                <circle className="orbit-core" r={info.r} />
                <circle className="orbit-dot" r={info.r / 3} />
                {id === selectedId && <circle className="orbit-select" r={info.r + 14} fill="none" />}
                {info.tools > 0 && (
                  <g className="orbit-badge" transform={`translate(${info.r * 0.85} ${-info.r * 0.85})`}>
                    <circle r="11" />
                    <text textAnchor="middle" dy="3.5">{badgeCount(info.tools)}</text>
                  </g>
                )}
                <text className="orbit-name" textAnchor="middle" y={info.r + 24}>{clip(info.name, 24)}</text>
                {info.current && <text className="orbit-current" textAnchor="middle" y={info.r + 40}>{clip(info.current, 30)}</text>}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="orbit-zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>−</button>
        <span aria-live="polite">{Math.round(view.k * 100)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
        <button type="button" aria-label="Fit to view" onClick={() => { touched.current = false; fit(); }}>⤢</button>
      </div>
    </div>
  );
}
