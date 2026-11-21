import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * What a generated document may read: the project's repositories and the documents uploaded under Knowledge.
 * Reports { repoIds, docIds } through onChange. Files attached to the request itself are chosen separately
 * (the attachments picker), and the summary line says how much the agent will have.
 */
export function CreateContextPicker({ projectId, onChange, disabled = false, attachmentCount = 0 }) {
  const [repos, setRepos] = useState(null);
  const [docs, setDocs] = useState(null);
  const [repoIds, setRepoIds] = useState([]);
  const [docIds, setDocIds] = useState([]);

  useEffect(() => {
    let live = true;
    api.get(`/api/projects/${projectId}/repos`).then((r) => { if (live) setRepos(r.repos || []); }).catch(() => { if (live) setRepos([]); });
    api.get(`/api/projects/${projectId}/knowledge`).then((r) => { if (live) setDocs((r.docs || []).filter((d) => d.status === 'ready')); }).catch(() => { if (live) setDocs([]); });
    return () => { live = false; };
  }, [projectId]);

  useEffect(() => { onChange?.({ repoIds, docIds }); }, [repoIds, docIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (set, id) => set((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  if (repos === null || docs === null) return null;

  const total = repoIds.length + docIds.length + attachmentCount;
  return (
    <fieldset className="context-picker" disabled={disabled}>
      <legend>What the agent reads</legend>
      {repos.length === 0 && docs.length === 0 && (
        <p className="field-hint">
          This project has no repositories or uploaded documents yet. Add repositories under Workspaces, or upload files
          under Knowledge, to give the agent something to write from. You can also attach files below.
        </p>
      )}
      {repos.length > 0 && (
        <div className="context-group">
          <span className="context-group-title">Repositories <span className="muted small">(read-only copies of the code)</span></span>
          {repos.map((r) => (
            <label key={r.id} className="context-item">
              <input type="checkbox" checked={repoIds.includes(r.id)} onChange={() => toggle(setRepoIds, r.id)} />
              <span>{r.name}</span>
              {r.status && r.status !== 'ready' && <span className="muted small" title={r.last_error || ''}>({r.status}: the portal could not reach it, so the agent may not either)</span>}
            </label>
          ))}
        </div>
      )}
      {docs.length > 0 && (
        <div className="context-group">
          <span className="context-group-title">Project documents <span className="muted small">(from Knowledge)</span></span>
          {docs.map((d) => (
            <label key={d.id} className="context-item">
              <input type="checkbox" checked={docIds.includes(d.id)} onChange={() => toggle(setDocIds, d.id)} />
              <span>{d.original_name || d.name}</span>
            </label>
          ))}
        </div>
      )}
      <p className="field-hint">
        {total === 0
          ? 'Nothing is chosen, so the agent has nothing to read. Pick at least one source, or attach files.'
          : `The agent will read ${repoIds.length} repositor${repoIds.length === 1 ? 'y' : 'ies'}, ${docIds.length} project document${docIds.length === 1 ? '' : 's'} and ${attachmentCount} attached file${attachmentCount === 1 ? '' : 's'}.`}
      </p>
    </fieldset>
  );
}

export default CreateContextPicker;
