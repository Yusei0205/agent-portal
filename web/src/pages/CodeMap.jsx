import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { PanZoom } from '../components/PanZoom.jsx';
import { mindmapLayout } from '../lib/mindmapLayout.js';
import { GraphExcludes } from './hub/GraphExcludes.jsx';

const KIND_LABEL = { function: 'Function', class: 'Class', file: 'File', other: 'Item', external: 'External' };

/** One colour per community, spread around the colour wheel so neighbours differ. */
const hue = (c) => (Number(c) * 47) % 360;
const fill = (c) => `hsl(${hue(c)} 62% 46%)`;
const radius = (d) => 7 + Math.min(14, Math.sqrt(d) * 2.2);
const shortLabel = (l) => (l.length > 20 ? `${l.slice(0, 19)}…` : l);
const where = (n) => (n.f ? `${n.f}${n.n ? `:${n.n}` : ''}` : '');

function NodeRow({ n, onPick, active }) {
  return (
    <button type="button" className={`cm-row${active ? ' is-active' : ''}`} onClick={() => onPick(n.i)}>
      <span className="cm-dot" style={{ background: fill(n.c) }} aria-hidden="true" />
      <span className="cm-row-main">
        <span className="cm-row-name">{n.l}</span>
        <span className="cm-row-meta">{KIND_LABEL[n.k] ?? 'Item'}{where(n) ? ` · ${where(n)}` : ''}</span>
      </span>
    </button>
  );
}

/** `a/b/Thing.tsx` -> `Thing.tsx`: the folder is in the tooltip and the side panel, the card has room for the name only. */
const baseName = (l) => String(l).replace(/^.*[\\/]/, '');

/** Line icons (24 x 24), one per kind of item. */
const KIND_ICON = {
  function: 'M9 4c-2 0-3 1-3 3v2c0 1.2-1 2.2-2 3 1 .8 2 1.8 2 3v2c0 2 1 3 3 3M15 4c2 0 3 1 3 3v2c0 1.2 1 2.2 2 3-1 .8-2 1.8-2 3v2c0 2-1 3-3 3',
  class: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  other: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
};
const iconFor = (k) => KIND_ICON[k] ?? KIND_ICON.other;

function KindIcon({ kind, size, x = 0, y = 0, color }) {
  return (
    <g transform={`translate(${x - size / 2},${y - size / 2}) scale(${size / 24})`} aria-hidden="true">
      <path d={iconFor(kind)} fill="none" stroke={color} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

/** A smooth S-shaped connector that leaves and arrives horizontally (`h`) or vertically (`v`). */
function curve(sx, sy, ex, ey, dir) {
  if (dir === 'v') {
    const d = (ey - sy) * 0.55;
    return `M${sx},${sy} C${sx},${sy + d} ${ex},${ey - d} ${ex},${ey}`;
  }
  const d = (ex - sx) * 0.55;
  return `M${sx},${sy} C${sx + d},${sy} ${ex - d},${ey} ${ex},${ey}`;
}

/** How many main neighbours the map can show at most; the side list has every one. */
const SHOW_MAX = 36;
const SHOW_STEPS = [12, 24, SHOW_MAX];
const reduceMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

/**
 * The neighbourhood of one item as a mind map: the item in a glowing card, its main neighbours as pill cards on either side,
 * and each one's own neighbours as small squares fanning out beyond it. Click anything to move there.
 */
function GraphView({ data, onPick, wide, onToggleWide }) {
  const [hover, setHover] = useState(null); // an item id
  const [show, setShow] = useState(SHOW_STEPS[0]);
  const [names, setNames] = useState('main');
  const center = useMemo(() => data.nodes.find((n) => n.i === data.centerId), [data]);
  const allMains = useMemo(() => data.nodes.filter((n) => n.i !== data.centerId), [data]);
  const mains = useMemo(() => allMains.slice(0, show), [allMains, show]);
  const kidsOf = (id) => data.children?.[id]?.nodes ?? [];

  const lay = useMemo(() => mindmapLayout(
    mains.map((n) => ({ id: n.i, w: Math.max(112, Math.min(190, shortLabel(baseName(n.l)).length * 6.8 + 62)), kids: kidsOf(n.i).length })),
  ), [mains, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const { width: W, height: H, center: C } = lay;
  // A tall map (many neighbours) opens on the middle card at a readable size; the rest is drawn above and below and a drag away.
  const tall = H > W * 0.78;
  const viewH = tall ? Math.round(W * 0.78) : H;
  const viewTop = tall ? Math.round(C.y - viewH / 2) : 0;

  // Which way each main neighbour is used: the centre uses it (out), or it uses the centre (in).
  const direction = useMemo(() => {
    const d = new Map();
    for (const l of data.links) {
      if (l.s === data.centerId) d.set(l.t, 'out');
      else if (l.t === data.centerId && !d.has(l.s)) d.set(l.s, 'in');
    }
    return d;
  }, [data]);

  // What is lit while something is hovered: the centre, that main neighbour, and its small squares.
  const focusMain = useMemo(() => {
    if (!hover) return null;
    if (lay.mains.has(hover)) return hover;
    for (const [mid, list] of Object.entries(data.children ?? {})) if (list.nodes.some((k) => k.i === hover)) return mid;
    return null;
  }, [hover, lay, data]);
  const motion = useMemo(() => !reduceMotion(), []);
  const hue1 = (c) => hue(c);

  return (
    <div className="cm-graph">
      <div className="cm-toolbar" role="group" aria-label="Graph options">
        <span className="cm-legend" aria-label="Legend">
          {['function', 'class', 'file'].map((k) => (
            <span key={k}>
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d={iconFor(k)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg> {KIND_LABEL[k]}
            </span>
          ))}
          <span className="cm-legend-note">Colour = group · the dot moves from the caller to what it uses</span>
        </span>
        <span className="cm-controls">
          {allMains.length > SHOW_STEPS[0] && (
            <span className="cm-seg" role="radiogroup" aria-label="How many neighbours">
              <span className="cm-seg-title">Show</span>
              {[...new Set(SHOW_STEPS.map((n) => Math.min(n, allMains.length)))].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={Math.min(show, allMains.length) === n} className={`cm-seg-btn${Math.min(show, allMains.length) === n ? ' is-on' : ''}`} onClick={() => setShow(n)}>{n}</button>
              ))}
              <span className="cm-seg-title cm-seg-after">of {allMains.length}</span>
            </span>
          )}
          <span className="cm-seg" role="radiogroup" aria-label="Names">
            <span className="cm-seg-title">Names</span>
            {[['main', 'Main'], ['all', 'All']].map(([id, text]) => (
              <button key={id} type="button" role="radio" aria-checked={names === id} className={`cm-seg-btn${names === id ? ' is-on' : ''}`} onClick={() => setNames(id)}>{text}</button>
            ))}
          </span>
          <button type="button" className="cm-seg-btn cm-wide-btn" aria-pressed={wide} onClick={onToggleWide} title="Hide the list to give the graph the full width">{wide ? 'Show list' : 'Wide view'}</button>
        </span>
      </div>

      <PanZoom height="660px" label="Code graph" className="cm-stage">
        <svg viewBox={`0 ${viewTop} ${W} ${viewH}`} style={{ width: '100%', height: tall ? 'auto' : '636px', overflow: 'visible' }} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Code graph" className="cm-svg">
          <defs>
            <linearGradient id="cm-ring" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#22d3ee" />
              <stop offset="55%" stopColor="#6d8bff" />
              <stop offset="100%" stopColor="#c084fc" />
            </linearGradient>
            <linearGradient id="cm-glass" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1b2748" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#0d1530" stopOpacity="0.95" />
            </linearGradient>
            <radialGradient id="cm-core-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
            </radialGradient>
          </defs>

          <circle cx={C.x} cy={C.y} r={Math.min(W, H) * 0.46} className="cm-orbit" />
          <circle cx={C.x} cy={C.y} r={Math.min(W, H) * 0.3} className="cm-orbit cm-orbit-inner" />

          {mains.map((n) => {
            const p = lay.mains.get(n.i);
            if (!p) return null;
            const col = `hsl(${hue1(n.c)} 92% 64%)`;
            const half = C.size / 2;
            const lit = !focusMain || focusMain === n.i;
            let sx; let sy; let ex; let ey; let dir = 'h';
            if (p.side === 'right' || p.side === 'left') {
              const sgn = p.side === 'right' ? 1 : -1;
              sx = C.x + sgn * half; sy = C.y + Math.max(-half * 0.55, Math.min(half * 0.55, (p.y - C.y) * 0.25));
              ex = p.x - sgn * p.w / 2; ey = p.y;
            } else {
              dir = 'v';
              const sgn = p.side === 'bottom' ? 1 : -1;
              sx = C.x; sy = C.y + sgn * half; ex = p.x; ey = p.y - sgn * p.h / 2;
            }
            const d = curve(sx, sy, ex, ey, dir);
            const way = direction.get(n.i) ?? 'out';
            const pathId = `cmp-${n.i.replace(/[^A-Za-z0-9_-]/g, '_')}`;
            return (
              <g key={`e-${n.i}`} className={`cm-link${lit ? '' : ' is-dim'}${focusMain === n.i ? ' is-hot' : ''}`} style={{ color: col }}>
                <path id={pathId} d={d} className="cm-line" fill="none" />
                <circle cx={sx} cy={sy} r="3.4" className="cm-end" />
                {motion && (
                  <circle r="3.2" className="cm-travel">
                    <animateMotion dur="3.4s" repeatCount="indefinite" calcMode="linear" keyPoints={way === 'out' ? '0;1' : '1;0'} keyTimes="0;1"><mpath href={`#${pathId}`} /></animateMotion>
                  </circle>
                )}
                {(kidsOf(n.i)).map((k, j) => {
                  const kp = lay.kids.get(n.i)?.[j];
                  if (!kp) return null;
                  let a; let b; let kdir = 'h';
                  if (p.side === 'right') { a = [p.x + p.w / 2, p.y]; b = [kp.x - kp.size / 2, kp.y]; }
                  else if (p.side === 'left') { a = [p.x - p.w / 2, p.y]; b = [kp.x + kp.size / 2, kp.y]; }
                  else if (p.side === 'top') { kdir = 'v'; a = [p.x, p.y - p.h / 2]; b = [kp.x, kp.y + kp.size / 2]; }
                  else { kdir = 'v'; a = [p.x, p.y + p.h / 2]; b = [kp.x, kp.y - kp.size / 2]; }
                  return <path key={k.i} d={curve(a[0], a[1], b[0], b[1], kdir)} className="cm-line cm-line-kid" fill="none" />;
                })}
                <circle cx={p.side === 'right' ? p.x + p.w / 2 : p.side === 'left' ? p.x - p.w / 2 : p.x} cy={p.side === 'top' ? p.y - p.h / 2 : p.side === 'bottom' ? p.y + p.h / 2 : p.y} r="3.4" className="cm-end" />
              </g>
            );
          })}

          {mains.map((n) => {
            const p = lay.mains.get(n.i);
            if (!p) return null;
            const col = `hsl(${hue1(n.c)} 92% 64%)`;
            const lit = !focusMain || focusMain === n.i;
            const kids = kidsOf(n.i);
            const spots = lay.kids.get(n.i) ?? [];
            const label = shortLabel(baseName(n.l));
            return (
              <g key={`n-${n.i}`} className={`cm-cluster${lit ? '' : ' is-dim'}`}>
                <g transform={`translate(${p.x},${p.y})`} className={`cm-pill${hover === n.i ? ' is-hover' : ''}`} style={{ '--glow': col }}
                  tabIndex={0} role="button" aria-label={`${n.l}, ${KIND_LABEL[n.k] ?? 'item'}${where(n) ? `, ${where(n)}` : ''}`}
                  onClick={() => onPick(n.i)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(n.i); } }}
                  onMouseEnter={() => setHover(n.i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(n.i)} onBlur={() => setHover(null)}>
                  <title>{`${n.l}\n${KIND_LABEL[n.k] ?? 'Item'}${where(n) ? ` · ${where(n)}` : ''}`}</title>
                  <rect x={-p.w / 2} y={-p.h / 2} width={p.w} height={p.h} rx={p.h / 2} className="cm-pill-bg" />
                  <rect x={-p.w / 2} y={-p.h / 2} width={p.w} height={p.h} rx={p.h / 2} className="cm-pill-ring" stroke={col} />
                  <KindIcon kind={n.k} size={19} x={-p.w / 2 + 25} color={col} />
                  <text x={-p.w / 2 + 43} y="4.6" className="cm-pill-text">{label}</text>
                </g>
                {kids.map((k, j) => {
                  const kp = spots[j];
                  if (!kp) return null;
                  const kc = `hsl(${hue1(k.c)} 85% 66%)`;
                  const showName = names === 'all' || hover === k.i;
                  const anchor = kp.side === 'left' ? 'end' : kp.side === 'right' ? 'start' : 'middle';
                  const tx = kp.side === 'left' ? -kp.size / 2 - 7 : kp.side === 'right' ? kp.size / 2 + 7 : 0;
                  const ty = kp.side === 'top' ? -kp.size / 2 - 8 : kp.side === 'bottom' ? kp.size / 2 + 15 : 4;
                  return (
                    <g key={k.i} transform={`translate(${kp.x},${kp.y})`} className={`cm-kid${hover === k.i ? ' is-hover' : ''}`} style={{ '--glow': kc }}
                      tabIndex={0} role="button" aria-label={`${k.l}, ${KIND_LABEL[k.k] ?? 'item'}${where(k) ? `, ${where(k)}` : ''}`}
                      onClick={() => onPick(k.i)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(k.i); } }}
                      onMouseEnter={() => setHover(k.i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(k.i)} onBlur={() => setHover(null)}>
                      <title>{`${k.l}\n${KIND_LABEL[k.k] ?? 'Item'}${where(k) ? ` · ${where(k)}` : ''}`}</title>
                      <rect x={-kp.size / 2} y={-kp.size / 2} width={kp.size} height={kp.size} rx="8" className="cm-kid-bg" />
                      <KindIcon kind={k.k} size={14} color={kc} />
                      {showName && <text x={tx} y={ty} textAnchor={anchor} className="cm-kid-text">{shortLabel(baseName(k.l))}</text>}
                    </g>
                  );
                })}
                {(data.children?.[n.i]?.more ?? 0) > 0 && spots.length > 0 && (() => {
                  const last = spots[spots.length - 1];
                  // Under the last small square of the fan (above it for the item on top).
                  const mx = last.x;
                  const my = last.side === 'top' ? last.y - last.size / 2 - 6 : last.y + last.size / 2 + 14;
                  return <text x={mx} y={my} textAnchor="middle" className="cm-more">{`+${data.children[n.i].more}`}</text>;
                })()}
              </g>
            );
          })}

          <g transform={`translate(${C.x},${C.y})`} className="cm-core" tabIndex={0} role="img" aria-label={`${center?.l ?? ''}, the item shown`}>
            <title>{`${center?.l ?? ''}\n${KIND_LABEL[center?.k] ?? 'Item'}${center ? ` · ${where(center)}` : ''}`}</title>
            <circle r={C.size * 0.95} fill="url(#cm-core-glow)" className="cm-core-aura" />
            <rect x={-C.size / 2} y={-C.size / 2} width={C.size} height={C.size} rx="30" className="cm-core-bg" />
            <rect x={-C.size / 2} y={-C.size / 2} width={C.size} height={C.size} rx="30" className="cm-core-ring" />
            <KindIcon kind={center?.k} size={40} y={-16} color="#7dd3fc" />
            <text y="36" textAnchor="middle" className="cm-core-text">{shortLabel(baseName(center?.l ?? ''))}</text>
          </g>
        </svg>
      </PanZoom>
    </div>
  );
}

function RepoMap({ projectId, repo, branch }) {
  const base = `/api/projects/${projectId}/code-map/${repo.id}`;
  const branchQs = branch ? `branch=${encodeURIComponent(branch)}` : '';
  const [overview, setOverview] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [trail, setTrail] = useState([]); // ids visited, the last one is shown
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const [wide, setWide] = useState(false);
  const current = trail[trail.length - 1] ?? null;

  useEffect(() => {
    let live = true;
    setOverview(null); setResults(null); setTrail([]); setGraph(null); setQuery(''); setError(null);
    api.get(`${base}/overview${branchQs ? `?${branchQs}` : ''}`).then((r) => { if (live) setOverview(r); }).catch((e) => { if (live) setError(e.message || 'Could not load the code map'); });
    return () => { live = false; };
  }, [base, branchQs]);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults(null); return undefined; }
    const id = ++seq.current;
    const t = setTimeout(() => {
      api.get(`${base}/search?q=${encodeURIComponent(q)}${branchQs ? `&${branchQs}` : ''}`)
        .then((r) => { if (seq.current === id) setResults(r.results ?? []); })
        .catch((e) => { if (seq.current === id) setError(e.message || 'Search failed'); });
    }, 220);
    return () => clearTimeout(t);
  }, [query, base, branchQs]);

  useEffect(() => {
    if (!current) { setGraph(null); return undefined; }
    let live = true;
    setBusy(true);
    api.get(`${base}/node?id=${encodeURIComponent(current)}${branchQs ? `&${branchQs}` : ''}`)
      .then((r) => { if (live) { setGraph(r); setError(null); } })
      .catch((e) => { if (live) setError(e.message || 'Could not load that item'); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [current, base, branchQs]);

  const pick = (id) => {
    setQuery('');
    setTrail((t) => (t[t.length - 1] === id ? t : [...t, id].slice(-30)));
  };
  const center = graph?.nodes.find((n) => n.i === graph.centerId);
  const links = useMemo(() => {
    if (!graph) return { out: [], in: [] };
    const by = new Map(graph.nodes.map((n) => [n.i, n]));
    const out = []; const inn = [];
    for (const l of graph.links) {
      if (l.s === graph.centerId && by.has(l.t)) out.push({ n: by.get(l.t), r: l.r });
      else if (l.t === graph.centerId && by.has(l.s)) inn.push({ n: by.get(l.s), r: l.r });
    }
    return { out, in: inn };
  }, [graph]);

  if (error && !overview) return <p className="error-msg" role="alert">{error}</p>;
  if (!overview) return <p className="muted">Loading the code map…</p>;

  return (
    <div className="cm">
      <p className="field-hint">
        {branch ? <><strong>{branch}</strong>: </> : null}{overview.meta.nodes.toLocaleString()} items and {overview.meta.links.toLocaleString()} links, built {new Date(overview.meta.builtAt).toLocaleString()}
        {overview.meta.truncated ? '. This repository is large: only its best-connected items are kept.' : '.'}
      </p>
      <div className="cm-search">
        <Icon name="search" size={15} />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a function, class or file…" aria-label="Search the code map" />
      </div>
      {error && <p className="error-msg" role="alert">{error}</p>}

      <div className={`cm-body${wide ? ' is-wide' : ''}`}>
        <div className="cm-side" aria-live="polite">
          {query.trim() ? (
            results == null ? <p className="muted">Searching…</p>
              : results.length === 0 ? <p className="muted">Nothing matches “{query.trim()}”.</p>
                : results.map((n) => <NodeRow key={n.i} n={n} onPick={pick} active={n.i === current} />)
          ) : current && graph ? (
            <>
              <div className="cm-detail">
                <div className="cm-detail-head">
                  <span className="cm-dot" style={{ background: fill(center?.c ?? 0) }} aria-hidden="true" />
                  <strong>{center?.l}</strong>
                </div>
                <p className="cm-row-meta">{KIND_LABEL[center?.k] ?? 'Item'}{center ? ` · ${where(center)}` : ''}</p>
                {center && overview.meta.communities[String(center.c)] && <p className="cm-row-meta">Group: {overview.meta.communities[String(center.c)]}</p>}
                <div className="cm-actions">
                  <button type="button" className="btn btn-sm btn-ghost" disabled={trail.length < 2} onClick={() => setTrail((t) => t.slice(0, -1))}>Back</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setTrail([]); setGraph(null); }}>Overview</button>
                </div>
              </div>
              {[['Uses', links.out], ['Used by', links.in]].map(([title, list]) => list.length > 0 && (
                <div key={title} className="cm-group">
                  <h4>{title} <span className="muted">({list.length})</span></h4>
                  {list.map((x, i) => (
                    <div key={`${x.n.i}${i}`}>
                      <NodeRow n={x.n} onPick={pick} />
                      <span className="cm-rel">{x.r.replace(/_/g, ' ')}</span>
                    </div>
                  ))}
                </div>
              ))}
              {graph.more > 0 && <p className="field-hint">{graph.more} more connections are not drawn. Pick a neighbour to follow them.</p>}
            </>
          ) : (
            <>
              <h4>Best connected</h4>
              {overview.top.map((n) => <NodeRow key={n.i} n={n} onPick={pick} />)}
              <h4>Groups</h4>
              {overview.communities.map((c) => (
                <div key={c.id} className="cm-community">
                  <div className="cm-detail-head"><span className="cm-dot" style={{ background: fill(c.id) }} aria-hidden="true" /><strong>{c.name}</strong><span className="muted"> {c.size} items</span></div>
                  {c.top.map((n) => <NodeRow key={n.i} n={n} onPick={pick} />)}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="cm-canvas">
          {current && graph ? (
            <div className={busy ? 'cm-busy' : ''}><GraphView data={graph} onPick={pick} wide={wide} onToggleWide={() => setWide((w) => !w)} /></div>
          ) : (
            <div className="empty-state"><p>Search for a function, class or file, or pick one from the list, to see what it uses and what uses it.</p></div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Code map: a searchable, visual graph of each repository's code, per branch (built from the Repositories page).
 *
 * @param {{ projectId: string }} props
 */
export function CodeMap({ projectId }) {
  const [repos, setRepos] = useState(null);
  const [error, setError] = useState(null);
  const [repoId, setRepoId] = useState('');
  const [branchPick, setBranchPick] = useState(''); // '' = the first branch that has a map (the default branch when it has one)

  useEffect(() => {
    let live = true;
    api.get(`/api/projects/${projectId}/code-map`)
      .then((r) => {
        if (!live) return;
        setRepos(r.repos ?? []);
        setRepoId((cur) => cur || (r.repos ?? []).find((x) => x.hasMap)?.id || (r.repos ?? [])[0]?.id || '');
      })
      .catch((e) => { if (live) setError(e.message || 'Failed to load the code map'); });
    return () => { live = false; };
  }, [projectId]);

  if (error) return <p className="error-msg" role="alert">{error}</p>;
  if (!repos) return <p className="muted">Loading…</p>;
  if (repos.length === 0) {
    return <div className="empty-state"><p>This project has no repositories yet. <a href={`#/p/${projectId}/workspaces/repositories`}>Add repositories</a> to get a code map.</p></div>;
  }
  const repo = repos.find((r) => r.id === repoId) ?? repos[0];
  // The branches of this repository that have a map. A map from before branches were told apart counts as the default branch's.
  const mapBranches = (repo.branches ?? []).filter((b) => b.hasMap).map((b) => b.branch);
  const branch = mapBranches.includes(branchPick) ? branchPick : (mapBranches.includes(repo.defaultBranch) ? repo.defaultBranch : (mapBranches[0] ?? ''));
  const hasMap = mapBranches.length > 0 || repo.hasMap;

  return (
    <div className="stack">
      <div className="field cm-pick">
        <label htmlFor="cm-repo">Repository</label>
        <select id="cm-repo" value={repo.id} onChange={(e) => { setRepoId(e.target.value); setBranchPick(''); }}>
          {repos.map((r) => <option key={r.id} value={r.id}>{r.name}{r.hasMap || (r.branches ?? []).some((b) => b.hasMap) ? '' : ' (no map yet)'}</option>)}
        </select>
        {mapBranches.length > 0 && (
          <>
            <label htmlFor="cm-branch" style={{ marginLeft: '1em' }}>Branch</label>
            <select id="cm-branch" value={branch} onChange={(e) => setBranchPick(e.target.value)}>
              {mapBranches.map((b) => <option key={b} value={b}>{b}{b === repo.defaultBranch ? ' (default)' : ''}</option>)}
            </select>
            <span className="muted small">
              {mapBranches.length === 1 ? 'Only this branch has a map. ' : ''}
              <a href={`#/p/${projectId}/workspaces/repositories`}>Build another branch</a>
            </span>
          </>
        )}
      </div>
      <GraphExcludes key={`gx-${repo.id}`} projectId={projectId} repoId={repo.id} repoName={repo.name} branch={mapBranches.length ? branch : ''} />
      {hasMap ? <RepoMap key={`${repo.id}@${branch}`} projectId={projectId} repo={repo} branch={mapBranches.length ? branch : ''} /> : (
        <div className="empty-state">
          <p><strong>No code map yet for {repo.name}.</strong></p>
          <p className="muted">Open <a href={`#/p/${projectId}/workspaces/repositories`}>Workspaces › Repositories</a> and press <strong>Build graph</strong> on {repo.name}. You can build a graph for any branch there; the map appears here when it is ready.</p>
        </div>
      )}
    </div>
  );
}

export default CodeMap;
