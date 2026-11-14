import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { PanZoom } from '../components/PanZoom.jsx';
import { radialLayout } from '../lib/forceLayout.js';
import { GraphExcludes } from './hub/GraphExcludes.jsx';

const KIND_LABEL = { function: 'Function', class: 'Class', file: 'File', other: 'Item', external: 'External' };

/** One colour per community, spread around the colour wheel so neighbours differ. */
const hue = (c) => (Number(c) * 47) % 360;
const fill = (c) => `hsl(${hue(c)} 62% 46%)`;
const radius = (d) => 7 + Math.min(14, Math.sqrt(d) * 2.2);
const shortLabel = (l) => (l.length > 24 ? `${l.slice(0, 23)}…` : l);
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

const EDGE_COLOR = { calls: '#5eead4', indirect_call: '#5eead4', imports: '#a78bfa', imports_from: '#a78bfa', dynamic_import: '#a78bfa', re_exports: '#a78bfa', references: '#fbbf24' };
const edgeColor = (r) => EDGE_COLOR[r] ?? '#7c8aa5';
/** `a/b/Thing.tsx` -> `Thing.tsx`: the folder is in the tooltip and the side panel, the label has room for the name only. */
const baseName = (l) => String(l).replace(/^.*[\\/]/, '');
const nodeRadius = (d, scale) => (10 + Math.min(11, Math.sqrt(d) * 1.7)) * scale;

/** A point and the direction of travel on a quadratic curve, for the arrowhead. */
function along(a, c, b, t) {
  const x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x;
  const y = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y;
  const dx = 2 * (1 - t) * (c.x - a.x) + 2 * t * (b.x - c.x);
  const dy = 2 * (1 - t) * (c.y - a.y) + 2 * t * (b.y - c.y);
  const len = Math.hypot(dx, dy) || 1;
  return { x, y, ux: dx / len, uy: dy / len };
}

const LABEL_MODES = [['key', 'Key items'], ['all', 'All'], ['none', 'None']];

/** The neighbourhood of one item, drawn as a graph of glowing spheres. Click an item to move to it. */
function GraphView({ data, onPick }) {
  const [hover, setHover] = useState(null);
  const [labels, setLabels] = useState('key');
  const { pos: layout, width: W, height: H } = useMemo(
    () => radialLayout(data.nodes.map((n) => ({ id: n.i, c: n.c, d: n.d })), data.centerId),
    [data],
  );
  // The drawing grows with the number of items; sizes grow with it so items look the same size on screen.
  const scale = Math.max(1, W / 1000);
  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.i, n])), [data]);
  const groups = useMemo(() => [...new Set(data.nodes.map((n) => n.c))], [data]);
  const near = useMemo(() => {
    if (!hover) return null;
    const s = new Set([hover]);
    for (const l of data.links) { if (l.s === hover) s.add(l.t); if (l.t === hover) s.add(l.s); }
    return s;
  }, [hover, data]);
  const key = useMemo(() => {
    const top = [...data.nodes].sort((a, b) => (b.d ?? 0) - (a.d ?? 0)).slice(0, data.nodes.length <= 16 ? 16 : 12).map((n) => n.i);
    return new Set([data.centerId, ...top]);
  }, [data]);
  const showLabel = (id) => labels === 'all' || (labels === 'key' && (key.has(id) || (near && near.has(id)))) || (labels === 'none' && hover === id);

  return (
    <div className="cm-graph">
      <div className="cm-toolbar" role="group" aria-label="Graph options">
        <span className="cm-legend" aria-label="Legend">
          <span><i className="cm-lg cm-lg-fn" /> Function</span>
          <span><i className="cm-lg cm-lg-cls" /> Class</span>
          <span><i className="cm-lg cm-lg-file" /> File</span>
          <span className="cm-legend-note">Colour = group</span>
        </span>
        <span className="cm-seg" role="radiogroup" aria-label="Labels">
          <span className="cm-seg-title">Labels</span>
          {LABEL_MODES.map(([id, text]) => (
            <button key={id} type="button" role="radio" aria-checked={labels === id} className={`cm-seg-btn${labels === id ? ' is-on' : ''}`} onClick={() => setLabels(id)}>{text}</button>
          ))}
        </span>
      </div>
      <PanZoom height="660px" label="Code graph" className="cm-stage">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="Code graph" className="cm-svg">
          <defs>
            {groups.map((c) => (
              <radialGradient key={c} id={`cmg-${c}`} cx="34%" cy="28%" r="78%">
                <stop offset="0%" stopColor={`hsl(${hue(c)} 95% 82%)`} />
                <stop offset="42%" stopColor={`hsl(${hue(c)} 82% 58%)`} />
                <stop offset="100%" stopColor={`hsl(${hue(c)} 72% 26%)`} />
              </radialGradient>
            ))}
            <radialGradient id="cm-spec" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#fff" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
          </defs>

          {data.links.map((l, i) => {
            const a = layout.get(l.s); const b = layout.get(l.t);
            if (!a || !b) return null;
            const hot = hover && (l.s === hover || l.t === hover);
            const dim = hover && !hot;
            // Curve towards the middle so edges between neighbours do not cut across the other items.
            const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
            const c = { x: mx + (W / 2 - mx) * 0.22, y: my + (H / 2 - my) * 0.22 };
            const rb = nodeRadius(byId.get(l.t)?.d ?? 1, scale) + 3 * scale;
            const end = along(a, c, b, 1);
            const stop = { x: b.x - end.ux * rb, y: b.y - end.uy * rb };
            const tip = along(a, c, stop, 1);
            const col = edgeColor(l.r);
            const s = (hot ? 7 : 5) * scale;
            return (
              <g key={`${l.s}>${l.t}>${i}`} className={`cm-edge${hot ? ' is-hot' : ''}${dim ? ' is-dim' : ''}`} style={{ color: col }}>
                <path d={`M${a.x},${a.y} Q${c.x},${c.y} ${stop.x},${stop.y}`} fill="none" stroke="currentColor" strokeWidth={(hot ? 2.4 : 1.3) * scale} strokeLinecap="round" />
                <path d={`M${stop.x},${stop.y} l${-tip.ux * s * 1.6 - tip.uy * s},${-tip.uy * s * 1.6 + tip.ux * s} l${tip.uy * s * 2},${-tip.ux * s * 2} z`} fill="currentColor" />
                <title>{l.r.replace(/_/g, ' ')}</title>
              </g>
            );
          })}

          {data.nodes.map((n) => {
            const p = layout.get(n.i);
            if (!p) return null;
            const isCenter = n.i === data.centerId;
            const dim = near && !near.has(n.i);
            const r = nodeRadius(n.d, scale) * (isCenter ? 1.5 : 1);
            const h = hue(n.c);
            const labelOn = showLabel(n.i);
            const fs = (isCenter ? 15 : 12.5) * scale;
            return (
              <g key={n.i} transform={`translate(${p.x},${p.y})`} className={`cm-node${isCenter ? ' is-center' : ''}${dim ? ' is-dim' : ''}${hover === n.i ? ' is-hover' : ''}`}
                style={{ '--glow': `hsl(${h} 95% 62%)` }}
                tabIndex={0} role="button" aria-label={`${n.l}, ${KIND_LABEL[n.k] ?? 'item'}${where(n) ? `, ${where(n)}` : ''}`}
                onClick={() => onPick(n.i)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(n.i); } }}
                onMouseEnter={() => setHover(n.i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(n.i)} onBlur={() => setHover(null)}>
                <title>{`${n.l}\n${KIND_LABEL[n.k] ?? 'Item'}${where(n) ? ` · ${where(n)}` : ''}`}</title>
                {isCenter && <circle r={r * 1.55} className="cm-halo" />}
                <ellipse cx={r * 0.12} cy={r * 1.02} rx={r * 0.95} ry={r * 0.26} className="cm-ground" />
                {n.k === 'file'
                  ? <rect x={-r * 1.05} y={-r * 0.78} width={r * 2.1} height={r * 1.56} rx={r * 0.32} fill={`url(#cmg-${n.c})`} className="cm-shape" />
                  : n.k === 'class'
                    ? <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={r * 0.42} fill={`url(#cmg-${n.c})`} className="cm-shape" />
                    : <circle r={r} fill={`url(#cmg-${n.c})`} className="cm-shape" />}
                <ellipse cx={-r * 0.3} cy={-r * 0.42} rx={r * 0.46} ry={r * 0.28} fill="url(#cm-spec)" className="cm-spec" />
                {labelOn && <text y={r + fs + 4 * scale} textAnchor="middle" className="cm-label" style={{ fontSize: fs }}>{shortLabel(baseName(n.l))}</text>}
              </g>
            );
          })}
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

      <div className="cm-body">
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
            <div className={busy ? 'cm-busy' : ''}><GraphView data={graph} onPick={pick} /></div>
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
