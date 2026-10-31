/**
 * Source Control panel — git status and diff viewer.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';

const STATUS_LABELS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', '?': 'Untracked' };

function DiffView({ diff }) {
  if (!diff) return null;
  const lines = diff.split('\n');
  return (
    <div className="ide-diff-view" aria-label="File diff">
      {lines.map((line, i) => {
        let cls = '';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
        else if (line.startsWith('@@')) cls = 'hunk';
        return (
          <div key={i} className={`ide-diff-line${cls ? ' ' + cls : ''}`}>
            {line || '\u00A0'}
          </div>
        );
      })}
    </div>
  );
}

/**
 * @param {{ workflowId: string }} props
 */
export function IdeSourceControl({ workflowId }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [diff, setDiff] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get(`/api/workflows/${workflowId}/ide/git/status`);
      setStatus(data);
    } catch (e) {
      if (e.status === 404) {
        setStatus({ repos: [] });
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => { load(); }, [load]);

  const openDiff = async (repo, file) => {
    setSelectedFile(`${repo}:${file.path}`);
    setDiff(null);
    setDiffLoading(true);
    try {
      const data = await api.get(
        `/api/workflows/${workflowId}/ide/git/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(file.path)}`,
      );
      setDiff(data.diff ?? '(binary or no diff)');
    } catch (e) {
      setDiff(`Error: ${e.message}`);
    } finally {
      setDiffLoading(false);
    }
  };

  if (loading) {
    return <div style={{ padding: '16px', textAlign: 'center' }}><div className="spinner" aria-label="Loading git status…" /></div>;
  }

  if (error) {
    return (
      <div className="error-note" style={{ margin: 8 }} role="alert">
        {error}
        <button type="button" className="btn btn-sm btn-ghost" onClick={load} style={{ marginLeft: 6 }}>Retry</button>
      </div>
    );
  }

  const repos = status?.repos ?? [];
  const totalFiles = repos.reduce((n, r) => n + (r.files?.length ?? 0), 0);

  if (repos.length === 0) {
    return (
      <div className="ws-placeholder" style={{ padding: '24px 12px' }}>
        <Icon name="git-branch" size={28} />
        <p style={{ fontSize: '0.84rem' }}>No git repos found</p>
      </div>
    );
  }

  const showingDiff = selectedFile && !diffLoading;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* File list */}
      <div style={{ flex: showingDiff ? '0 0 200px' : '1', overflow: 'auto', borderBottom: showingDiff ? '1px solid var(--line)' : 'none' }}>
        <div style={{ padding: '4px 10px', fontSize: '0.75rem', color: 'var(--ink-3)' }}>
          {totalFiles} change{totalFiles !== 1 ? 's' : ''}
          <button type="button" className="btn-icon" title="Refresh" aria-label="Refresh git status" style={{ marginLeft: 6, width: 20, height: 20 }} onClick={load}>
            <Icon name="refresh" size={12} />
          </button>
        </div>
        {repos.map((repo) => (
          <div key={repo.name}>
            <div style={{ padding: '3px 10px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Icon name="git-branch" size={11} />
              {repo.name}
              {repo.branch && <span style={{ fontWeight: 400, textTransform: 'none' }}> ({repo.branch})</span>}
            </div>
            {(repo.files || []).map((file) => (
              <div
                key={file.path}
                className="ide-sc-file"
                role="button"
                tabIndex={0}
                aria-label={`${STATUS_LABELS[file.status] ?? file.status}: ${file.path}`}
                aria-pressed={selectedFile === `${repo.name}:${file.path}`}
                onClick={() => openDiff(repo.name, file)}
                onKeyDown={(e) => { if (e.key === 'Enter') openDiff(repo.name, file); }}
              >
                <span className={`ide-sc-status ${file.status}`} aria-hidden="true">{file.status}</span>
                <span style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: '0.79rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={file.path}>
                  {file.path}
                </span>
              </div>
            ))}
            {(repo.files?.length ?? 0) === 0 && (
              <div style={{ padding: '3px 20px', fontSize: '0.78rem', color: 'var(--ink-3)' }}>No changes</div>
            )}
          </div>
        ))}
      </div>

      {/* Diff view */}
      {selectedFile && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '4px 10px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.77rem', color: 'var(--ink-3)', flexShrink: 0 }}>
            <Icon name="git-diff" size={12} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--mono)' }}>
              {selectedFile.split(':').slice(1).join(':')}
            </span>
            <button type="button" className="btn-icon" style={{ width: 20, height: 20 }} aria-label="Close diff" onClick={() => setSelectedFile(null)}>
              <Icon name="x" size={11} />
            </button>
          </div>
          {diffLoading
            ? <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}><div className="spinner" aria-label="Loading diff…" /></div>
            : <DiffView diff={diff} />}
        </div>
      )}
    </div>
  );
}
