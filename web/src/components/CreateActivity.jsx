import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { ArtifactCard } from './ArtifactCard.jsx';
import { subscribeProject } from '../lib/events.js';

const CreationPreview = lazy(() => import('./CreationPreview.jsx').then((mod) => ({ default: mod.CreationPreview })));

/**
 * What Create is generating right now, across diagrams, documents and decks, and what finished lately.
 * Each row links to the run behind it (the session transcript), so you can watch the agent work or see why it failed.
 * Polls every few seconds while something is generating.
 */

const KINDS = {
  diagram: { label: 'Diagram', path: 'diagrams', key: 'diagrams' },
  document: { label: 'Document', path: 'generated-docs', key: 'docs' },
  deck: { label: 'Deck', path: 'presentations', key: 'presentations' },
};

const RECENT_MS = 15 * 60_000;

// Diagrams and decks record when a run started (their updated time); documents do not, so a running document is
// timed from when this page first saw it running.
function started(item, kind, seen) {
  if (kind === 'document' && item.status === 'generating') return seen.get(item.id) ?? Date.now();
  return Date.parse(item.updated_at || item.created_at || '') || Date.now();
}

function describe(kind, item, docTypes) {
  if (kind === 'diagram') return [item.kind_label, item.style_label].filter(Boolean).join(' · ');
  if (kind === 'document') {
    const t = docTypes.find((x) => x.id === item.doc_type)?.label || item.doc_type;
    const s = item.sources || {};
    const parts = [t];
    if (s.repoIds?.length) parts.push(`${s.repoIds.length} repositor${s.repoIds.length === 1 ? 'y' : 'ies'}`);
    if (s.docIds?.length) parts.push(`${s.docIds.length} project document${s.docIds.length === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }
  return [item.slide_count ? `${item.slide_count} slides` : null, item.topic || item.source_kind].filter(Boolean).join(' · ');
}

function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function CreateActivity({ projectId }) {
  const [items, setItems] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [preview, setPreview] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const request = useRef(0);
  const seen = useRef(new Map());

  const load = useCallback(async () => {
    const version = ++request.current;
    const results = await Promise.all(Object.entries(KINDS).map(async ([kind, k]) => {
      try {
        const r = await api.get(`/api/projects/${projectId}/${k.path}`);
        const list = r[k.key] || r.items || [];
        return { kind, rows: list.map((it) => ({ kind, item: it, docTypes: r.doc_types || [] })) };
      } catch { return { kind, rows: null }; }
    }));
    if (request.current !== version) return;
    setLoadError(results.some((result) => result.rows === null));
    const flat = results.flatMap((result) => result.rows || []);
    const running = new Set();
    for (const x of flat) {
      if (x.kind === 'document' && x.item.status === 'generating') {
        running.add(x.item.id);
        if (!seen.current.has(x.item.id)) seen.current.set(x.item.id, Date.now());
      }
    }
    for (const id of [...seen.current.keys()]) if (!running.has(id)) seen.current.delete(id);
    setItems((previous) => results.flatMap((result) => result.rows ?? previous.filter((row) => row.kind === result.kind)));
  }, [projectId]);

  useEffect(() => {
    load();
    let timer;
    const unsubscribe = subscribeProject(projectId, (event) => {
      if (/diagram|document|presentation|output-files|workflow|run\./.test(event.type || '')) {
        clearTimeout(timer); timer = setTimeout(load, 300);
      }
    });
    return () => { request.current++; clearTimeout(timer); unsubscribe(); };
  }, [load, projectId]);

  const generating = items.filter((x) => x.item.status === 'generating');
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); load(); }, generating.length ? 3000 : 5000);
    return () => clearInterval(t);
  }, [load, generating.length]);

  const recent = items
    .filter((x) => x.item.status !== 'generating' && ['failed', 'error', 'ready'].includes(x.item.status)
      && now - Date.parse(x.item.updated_at || x.item.latest_version?.created_at || x.item.created_at || '') < RECENT_MS && (x.item.workflow_id || x.item.pending_workflow_id))
    .sort((a, b) => started(b.item, b.kind, seen.current) - started(a.item, a.kind, seen.current))
    .slice(0, 4);
  const rows = [...generating.sort((a, b) => started(b.item, b.kind, seen.current) - started(a.item, a.kind, seen.current)), ...recent];
  if (!rows.length && !loadError) return null;

  return (
    <section className="create-activity" aria-label="Generation activity">
      <h2 className="create-activity-title">
        {generating.length ? `Generating now (${generating.length})` : 'Recent'}
      </h2>
      {loadError && <p className="muted" role="status">Some generation activity could not be refreshed. <button className="btn-link" type="button" onClick={load}>Retry</button></p>}
      <ul className="create-activity-list">
        {rows.map(({ kind, item, docTypes }) => {
          const running = item.status === 'generating';
          const failed = item.status === 'failed' || item.status === 'error';
          const wf = item.workflow_id || item.pending_workflow_id;
          const base = `/api/projects/${encodeURIComponent(projectId)}/${KINDS[kind].path}/${encodeURIComponent(item.id)}`;
          const downloadable = !running && !failed && (kind === 'document' ? Boolean(item.latest_version_id) : kind === 'deck' ? Boolean(item.pptx_path) : item.version > 0);
          const downloadUrl = kind === 'diagram' ? `${base}/versions/${item.version}/download` : `${base}/download${kind === 'document' ? '?format=docx' : ''}`;
          const canPreview = !running && !failed && (kind === 'deck' ? Array.isArray(item.preview_json) && item.preview_json.length > 0 : downloadable);
          return (
            <li key={`${kind}-${item.id}`}>
              <ArtifactCard artifactId={`${projectId}:${kind}:${item.id}:${item.latest_version_id || item.version || item.updated_at}`} title={item.title || item.name} kind={KINDS[kind].label} state={running ? 'generating' : failed ? 'failed' : 'ready'} updatedAt={item.updated_at || item.created_at} detail={`${describe(kind, item, docTypes)}${running ? ` · running for ${clock(now - started(item, kind, seen.current))}` : ''}`} error={item.error}>
              {canPreview && <button type="button" className="btn btn-sm btn-primary" onClick={() => setPreview({ kind, item })} aria-label={`Preview ${item.title || item.name}`}>Preview</button>}
              {downloadable && <a className="btn btn-sm" href={downloadUrl} download>Download {kind === 'document' ? 'Word' : kind === 'deck' ? 'PPTX' : 'diagram'}</a>}
              {wf && (
                <a className="btn btn-sm" href={`#/p/${projectId}/sessions/${wf}`}>
                  {running ? 'Watch live' : 'View run'}
                </a>
              )}
              {!running && !failed && <a className="btn btn-sm btn-ghost" href={`#/p/${encodeURIComponent(projectId)}/vault`}>Browse Vault</a>}
              </ArtifactCard>
            </li>
          );
        })}
      </ul>
      {preview && <Suspense fallback={<p role="status">Loading preview…</p>}><CreationPreview key={`${preview.kind}:${preview.item.id}`} projectId={projectId} kind={preview.kind} item={preview.item} onClose={() => setPreview(null)} /></Suspense>}
    </section>
  );
}

export default CreateActivity;
