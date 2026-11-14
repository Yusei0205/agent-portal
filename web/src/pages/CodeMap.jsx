import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { PanZoom } from '../components/PanZoom.jsx';
import { forceLayout } from '../lib/forceLayout.js';
import { GraphExcludes } from './hub/GraphExcludes.jsx';

const W = 900;
const H = 560;
const KIND_LABEL = { function: 'Function', class: 'Class', file: 'File', other: 'Item', external: 'External' };

/** One colour per community, spread around the colour wheel so neighbours differ. */
const hue = (c) => (Number(c) * 47) % 360;
const fill = (c) => `hsl(${hue(c)} 62% 46%)`;
const radius = (d) => 7 + Math.min(14, Math.sqrt(d) * 2.2);
const shortLabel = (l) => (l.length > 26 ? `${l.slice(0, 25)}…` : l);
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

/** The neighbourhood of one item, drawn as a graph. Click an item to move to it. */
function GraphView({ data, onPick }) {
  const [hover, setHover] = useState(null);
  const layout = useMemo(() => forceLayout(data.nodes.map((n) => ({ id: n.i })), data.links, data.centerId, { width: W, height: H }), [data]);
  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.i, n])), [data]);
  const near = useMemo(() => {
    if (!hover) return null;
    const s = new Set([hover]);
    for (const l of data.links) { if (l.s === hover) s.add(l.t); if (l.t === hover) s.add(l.s); }
    return s;
  }, [hover, data]);
  return (
    <PanZoom height="560px" label="Code graph">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="Code graph" className="cm-svg">
        <defs>
          <marker id="cm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className="cm-arrow" />
          </marker>
        </defs>
        {data.links.map((l, i) => {
          const a = layout.get(l.s); const b = layout.get(l.t);
          if (!a || !b) return null;
          const dim = near && !(l.s === hover || l.t === hover);
          const rb = radius(byId.get(l.t)?.d ?? 1) + 2;
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const ex = b.x - ((b.x - a.x) / len) * rb;
          const ey = b.y - ((b.y - a.y) / len) * rb;
          return <line key={`${l.s}>${l.t}>${i}`} x1={a.x} y1={a.y} x2={ex} y2={ey} className={`cm-edge${dim ? ' is-dim' : ''}`} markerEnd="url(#cm-arrow)"><title>{l.r.replace(/_/g, ' ')}</title></line>;
        })}
        {data.nodes.map((n) => {
          const p = layout.get(n.i);
          if (!p) return null;
          const isCenter = n.i === data.centerId;
          const dim = near && !near.has(n.i);
          const r = radius(n.d);
          return (
            <g key={n.i} transform={`translate(${p.x},${p.y})`} className={`cm-node${isCenter ? ' is-center' : ''}${dim ? ' is-dim' : ''}`}
              tabIndex={0} role="button" aria-label={`${n.l}, ${KIND_LABEL[n.k] ?? 'item'}${where(n) ? `, ${where(n)}` : ''}`}
              onClick={() => onPick(n.i)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(n.i); } }}
              onMouseEnter={() => setHover(n.i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(n.i)} onBlur={() => setHover(null)}>
              <title>{`${n.l}\n${KIND_LABEL[n.k] ?? 'Item'}${where(n) ? ` · ${where(n)}` : ''}`}</title>
              {n.k === 'file'
                ? <rect x={-r} y={-r * 0.75} width={r * 2} height={r * 1.5} rx="3" fill={fill(n.c)} className="cm-shape" />
                : n.k === 'class'
                  ? <rect x={-r} y={-r} width={r * 2} height={r * 2} rx="5" fill={fill(n.c)} className="cm-shape" />
                  : <circle r={r} fill={fill(n.c)} className="cm-shape" />}
              <text y={r + 13} textAnchor="middle" className="cm-label">{shortLabel(n.l)}</text>
            </g>
          );
        })}
      </svg>
    </PanZoom>
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
