import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { AiChoicePicker } from './AiChoicePicker.jsx';
import { unsavedPresets } from '../lib/doc-type-presets.js';

const TYPES = [
  { id: 'overview', label: 'System overview', hint: 'what the system does and its parts' },
  { id: 'architecture', label: 'Architecture', hint: 'components, data flow, diagrams' },
  { id: 'api', label: 'API reference', hint: 'endpoints and their inputs and outputs' },
  { id: 'runbook', label: 'Runbook', hint: 'how to run, deploy and fix it' },
];

/**
 * "Build from repositories": choose the project's repositories and the kinds of document, and the portal writes them from the code
 * (POST /api/projects/:id/knowledge/build). Each document lands in Knowledge when it is ready and stays current on Rebuild.
 */
export function BuildKnowledgeDialog({ projectId, onClose, onStarted }) {
  const [repos, setRepos] = useState(null);
  const [repoIds, setRepoIds] = useState([]);
  const [types, setTypes] = useState(TYPES.map((t) => t.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ai, setAi] = useState({});
  // The project's own document types (Create › New document › + New type…), offered next to the built-in ones.
  const [customTypes, setCustomTypes] = useState([]);
  useEffect(() => {
    let live = true;
    api.get(`/api/projects/${projectId}/doc-types`).then((r) => { if (live) setCustomTypes(r.custom || []); }).catch(() => {});
    return () => { live = false; };
  }, [projectId]);

  useEffect(() => {
    let live = true;
    api.get(`/api/projects/${projectId}/repos`).then((r) => {
      if (!live) return;
      const list = r.repos || [];
      setRepos(list);
      setRepoIds(list.filter((x) => !x.status || x.status === 'ready').map((x) => x.id));
    }).catch((e) => { if (live) { setRepos([]); setError(e.message); } });
    return () => { live = false; };
  }, [projectId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const toggle = (set, id) => set((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !repoIds.length || !types.length) return;
    setBusy(true);
    setError(null);
    try {
      // Suggested types that are ticked become the project's own types first, then they are built like any other.
      const chosen = [];
      for (const t of types) {
        if (!t.startsWith('preset:')) { chosen.push(t); continue; }
        const preset = unsavedPresets(customTypes).find((p) => `preset:${p.key}` === t);
        if (!preset) continue;
        const saved = await api.post(`/api/projects/${projectId}/doc-types`, { label: preset.label, guide: preset.guide });
        chosen.push(`custom:${saved.type.id}`);
      }
      const r = await api.post(`/api/projects/${projectId}/knowledge/build`, { repoIds, types: chosen, ...ai });
      onStarted(r.docs || []);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not start');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="build-knowledge-title">
      <div className="modal">
        <div className="modal-header">
          <h2 id="build-knowledge-title">Build knowledge from repositories</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close" disabled={busy}>✕</button>
        </div>
        <form onSubmit={submit} className="stack">
          <p className="muted" style={{ margin: 0 }}>
            An agent reads the code and writes each document. They appear here when ready (usually a few minutes) and are used by Search,
            Ask and Kyu straight away. Use <strong>Rebuild</strong> on a document after the code changes.
          </p>
          {repos === null ? <p className="muted">Loading repositories…</p> : repos.length === 0 ? (
            <p className="muted">
              This project has no repositories yet. Add one under <a href={`#/p/${projectId}/workspaces/repositories`}>Workspaces › Repositories</a> first.
            </p>
          ) : (
            <fieldset className="context-picker" disabled={busy}>
              <legend>Repositories to read</legend>
              {repos.map((r) => (
                <label key={r.id} className="context-item">
                  <input type="checkbox" checked={repoIds.includes(r.id)} onChange={() => toggle(setRepoIds, r.id)} />
                  <span>{r.name}</span>
                  {r.status && r.status !== 'ready' && <span className="muted small">({r.status})</span>}
                </label>
              ))}
            </fieldset>
          )}
          <fieldset className="context-picker" disabled={busy}>
            <legend>Documents to write</legend>
            {TYPES.map((t) => (
              <label key={t.id} className="context-item">
                <input type="checkbox" checked={types.includes(t.id)} onChange={() => toggle(setTypes, t.id)} />
                <span>{t.label}</span> <span className="muted small">{t.hint}</span>
              </label>
            ))}
            {customTypes.map((t) => (
              <label key={t.id} className="context-item">
                <input type="checkbox" checked={types.includes(`custom:${t.id}`)} onChange={() => toggle(setTypes, `custom:${t.id}`)} />
                <span>{t.label}</span> <span className="muted small" title={t.guide}>this project's type</span>
              </label>
            ))}
            {unsavedPresets(customTypes).length > 0 && <p className="muted small" style={{ margin: '4px 0 0' }}>Suggested for developers (saved to the project when used):</p>}
            {unsavedPresets(customTypes).map((p) => (
              <label key={p.key} className="context-item">
                <input type="checkbox" checked={types.includes(`preset:${p.key}`)} onChange={() => toggle(setTypes, `preset:${p.key}`)} />
                <span>{p.label}</span> <span className="muted small" title={p.guide}>suggested</span>
              </label>
            ))}
            <p className="muted small" style={{ margin: 0 }}>
              Need another kind? Add it in Create › Documents › New document › <strong>+ New type…</strong>
            </p>
          </fieldset>
          <div className="field">
            <AiChoicePicker onChange={setAi} disabled={busy} idPrefix="kb-ai" />
            <p className="field-hint">Every document is written on this sign-in and model (one agent run each).</p>
          </div>
          {error && <p className="error-note" role="alert">{error}</p>}
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !repoIds.length || !types.length}>
              {busy ? 'Starting…' : `Write ${types.length} document${types.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
