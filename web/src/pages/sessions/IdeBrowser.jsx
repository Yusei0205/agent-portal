/**
 * Browser panel — shows last screenshot / URL from the agent's browser tool.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { formatDate } from '../../lib/util.js';

/**
 * @param {{ workflowId: string }} props
 */
export function IdeBrowser({ workflowId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/api/workflows/${workflowId}/browser`);
      setData(res);
    } catch (e) {
      if (e.status === 404) {
        setData(null);
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}><div className="spinner" aria-label="Loading browser state…" /></div>;
  }

  if (error) {
    return (
      <div className="error-note" style={{ margin: 8 }} role="alert">
        {error}
        <button type="button" className="btn btn-sm btn-ghost" onClick={load} style={{ marginLeft: 6 }}>Retry</button>
      </div>
    );
  }

  if (!data?.url && !data?.screenshotBase64) {
    return (
      <div className="ws-placeholder" style={{ padding: '24px 12px' }}>
        <Icon name="browser" size={28} />
        <p style={{ fontSize: '0.84rem' }}>No browser activity yet</p>
        <p style={{ fontSize: '0.77rem', opacity: 0.7 }}>The agent's browser tool will appear here</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {data.url && (
        <div className="ide-browser-url" title={data.url}>
          <a href={data.url} target="_blank" rel="noopener noreferrer"
             style={{ color: 'var(--accent)', textDecoration: 'none' }}>
            {data.url}
          </a>
          {data.recordedAt && (
            <span style={{ marginLeft: 8, opacity: 0.6 }}>{formatDate(data.recordedAt)}</span>
          )}
        </div>
      )}
      {data.screenshotBase64 ? (
        <div className="ide-browser-screenshot">
          <img
            src={`data:image/png;base64,${data.screenshotBase64}`}
            alt="Browser screenshot"
          />
        </div>
      ) : (
        <div className="ws-placeholder" style={{ flex: 1, padding: 16 }}>
          <Icon name="browser" size={24} />
          <p style={{ fontSize: '0.82rem' }}>No screenshot available</p>
        </div>
      )}
      <div style={{ padding: '4px 8px', borderTop: '1px solid var(--line)', flexShrink: 0 }}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={load} aria-label="Refresh browser panel">
          <Icon name="refresh" size={13} />
          Refresh
        </button>
      </div>
    </div>
  );
}
