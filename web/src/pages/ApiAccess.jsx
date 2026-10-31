import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatDate, formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';

// ── Scope definitions ─────────────────────────────────────────────────────────

const SCOPES = [
  {
    id: 'read',
    label: 'Read',
    description: 'List sessions, get transcripts, list and get reviews.',
    alwaysOn: true,
  },
  {
    id: 'write',
    label: 'Write',
    description: 'Start, prompt and stop sessions; edit configuration.',
    alwaysOn: false,
  },
  {
    id: 'review',
    label: 'Review',
    description: 'Start code reviews and branch scans, post PR comments.',
    alwaysOn: false,
  },
  {
    id: 'merge',
    label: 'Merge',
    description: 'Merge pull requests via the portal.',
    alwaysOn: false,
  },
];

const EXPIRY_OPTIONS = [
  { value: 30,  label: '30 days' },
  { value: 90,  label: '90 days (default)' },
  { value: 365, label: '1 year' },
];

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyButton({ text, label, className }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* fallback */ }
  };
  return (
    <button
      type="button"
      className={className ?? 'btn btn-sm'}
      onClick={copy}
      aria-label={label ?? 'Copy to clipboard'}
    >
      <Icon name="copy" size={13} />
      {copied ? ' Copied!' : ' Copy'}
    </button>
  );
}

// ── New token modal ───────────────────────────────────────────────────────────

function NewTokenModal({ projects, onClose, onCreated }) {
  const [name, setName]         = useState('');
  const [scopes, setScopes]     = useState(['read']);
  const [projectId, setProjectId] = useState('');
  const [expiryDays, setExpiryDays] = useState(90);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState(null);

  // Close on Escape from anywhere on the page
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleScope = (id) => {
    if (id === 'read') return; // always on
    setScopes((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      const expiresAt = new Date(Date.now() + expiryDays * 86_400_000).toISOString();
      const body = {
        name: name.trim(),
        scopes,
        ...(projectId ? { projectId } : {}),
        expiresAt,
      };
      const r = await api.post('/api/api-tokens', body);
      onCreated(r.token, r.info);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Create API token">
      <div className="modal">
        <div className="modal-header">
          <h2>New API token</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="stack">
            <div className="field">
              <label htmlFor="tok-name">Name</label>
              <input
                id="tok-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. CI pipeline"
                autoFocus
              />
            </div>

            {/* Scopes */}
            <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
              <legend style={{ fontWeight: 600, fontSize: '0.88rem', marginBottom: 6 }}>Scopes</legend>
              {SCOPES.map((s) => (
                <label
                  key={s.id}
                  className={`choice${scopes.includes(s.id) ? ' is-checked' : ''}`}
                  style={{ marginBottom: 4, cursor: s.alwaysOn ? 'default' : 'pointer' }}
                  aria-label={`${s.label} scope: ${s.description}`}
                >
                  <input
                    type="checkbox"
                    name="tok-scope"
                    value={s.id}
                    checked={scopes.includes(s.id)}
                    onChange={() => toggleScope(s.id)}
                    disabled={s.alwaysOn}
                    aria-describedby={`scope-desc-${s.id}`}
                  />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {s.label}
                      {s.alwaysOn && <span className="badge badge-neutral" style={{ fontWeight: 400 }}>always on</span>}
                    </div>
                    <div id={`scope-desc-${s.id}`} className="muted" style={{ fontSize: '0.82rem', marginTop: 1 }}>
                      {s.description}
                    </div>
                  </div>
                </label>
              ))}
            </fieldset>

            {/* Expiry */}
            <div className="field">
              <label htmlFor="tok-expiry">Expiry</label>
              <select
                id="tok-expiry"
                value={expiryDays}
                onChange={(e) => setExpiryDays(Number(e.target.value))}
              >
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {projects && projects.length > 0 && (
              <div className="field">
                <label htmlFor="tok-project">Restrict to project (optional)</label>
                <select id="tok-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">— all projects —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}

            {error && <p className="error-note" role="alert">{error}</p>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Creating…' : 'Create token'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Token revealed modal ──────────────────────────────────────────────────────

function TokenRevealModal({ token, onClose }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback — select the text
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Token created">
      <div className="modal">
        <div className="modal-header">
          <h2>Token created</h2>
        </div>
        <div className="stack">
          <div
            className="card"
            style={{ background: 'var(--ok-wash)', border: '1px solid var(--ok)', display: 'flex', gap: 10, alignItems: 'center' }}
          >
            <Icon name="warning" size={16} style={{ flexShrink: 0, color: 'var(--warn)' }} />
            <span className="small"><strong>Save this — it won't be shown again.</strong></span>
          </div>
          <div
            className="card"
            style={{ fontFamily: 'var(--mono)', fontSize: '0.85rem', wordBreak: 'break-all' }}
            aria-label="API token value"
          >
            {token}
          </div>
          <div>
            <button type="button" className="btn btn-primary" onClick={copy}>
              <Icon name="copy" size={14} />
              {copied ? 'Copied!' : 'Copy token'}
            </button>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done — I've saved the token
          </button>
        </div>
      </div>
    </div>
  );
}

// ── MCP section ───────────────────────────────────────────────────────────────

const SCOPE_GROUPS = ['read', 'write', 'review', 'merge'];

function McpSection({ mcpInfo }) {
  if (!mcpInfo) return null;

  const { url, transport, tools, clientConfigExample, tokenStats } = mcpInfo;
  const configSnippet = JSON.stringify(clientConfigExample, null, 2);
  const baseUrl = window.location.origin;
  const fullUrl = `${baseUrl}${url}`;

  // Group tools by scope
  const byScope = {};
  for (const scope of SCOPE_GROUPS) byScope[scope] = [];
  for (const t of (tools || [])) {
    if (byScope[t.scope]) byScope[t.scope].push(t);
  }

  return (
    <section
      aria-label="Connect an AI agent (MCP)"
      style={{
        marginTop: 32,
        paddingTop: 20,
        borderTop: '1px solid var(--line)',
      }}
    >
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>Connect an AI agent (MCP)</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Connect MCP-compatible AI agents (e.g. Claude Code, Kiro) to this portal using a personal access token.
      </p>

      {/* Stats row */}
      {tokenStats && (
        <div
          role="region"
          aria-label="Token statistics"
          style={{
            display: 'flex', gap: 24, flexWrap: 'wrap',
            background: 'var(--canvas)', border: '1px solid var(--line)',
            borderRadius: 'var(--radius)', padding: '12px 16px', marginBottom: 20,
          }}
        >
          {[
            { label: 'Active tokens (of 10)', value: `${tokenStats.active} / 10` },
            { label: 'With write scope', value: tokenStats.withWrite },
            { label: 'With merge scope', value: tokenStats.withMerge },
            { label: 'Never used', value: tokenStats.neverUsed },
          ].map(({ label, value }) => (
            <div key={label}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
              <div className="muted" style={{ fontSize: 12 }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* MCP endpoint */}
      <div className="field" style={{ marginBottom: 16 }}>
        <label>MCP endpoint</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code
            style={{
              flex: 1, padding: '6px 10px',
              background: 'var(--canvas)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius)', fontFamily: 'var(--mono)', fontSize: '0.88rem',
              wordBreak: 'break-all',
            }}
            aria-label="MCP endpoint URL"
          >
            {fullUrl}
          </code>
          <CopyButton text={fullUrl} label="Copy MCP endpoint URL" />
        </div>
        <p className="field-hint">Transport: {transport}</p>
      </div>

      {/* Client config snippet */}
      <div className="field" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <label style={{ marginBottom: 0 }}>Client configuration snippet</label>
          <CopyButton text={configSnippet} label="Copy client config snippet" />
        </div>
        <pre
          style={{
            background: 'var(--canvas)', border: '1px solid var(--line)',
            borderRadius: 'var(--radius)', padding: '10px 12px',
            fontFamily: 'var(--mono)', fontSize: '0.8rem',
            overflowX: 'auto', margin: 0,
          }}
          aria-label="MCP client configuration example"
        >
          {configSnippet}
        </pre>
        <p className="field-hint">Replace <code>&lt;your-token&gt;</code> with a personal access token from the table above.</p>
      </div>

      {/* Tool list */}
      <div>
        <h3 style={{ fontSize: 15, marginBottom: 10 }}>Available tools by scope</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {SCOPE_GROUPS.map((scope) => (
            <div
              key={scope}
              style={{
                background: 'var(--canvas)', border: '1px solid var(--line)',
                borderRadius: 'var(--radius)', padding: '10px 12px',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: '0.88rem', marginBottom: 6, textTransform: 'capitalize' }}>
                {scope}
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {(byScope[scope] || []).map((t) => (
                  <li key={t.name} title={t.description} style={{ fontSize: '0.8rem', marginBottom: 3 }}>
                    <code style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{t.name}</code>
                    <span className="muted" style={{ display: 'block', fontSize: '0.75rem' }}>{t.description}</span>
                  </li>
                ))}
                {(byScope[scope] || []).length === 0 && (
                  <li className="muted" style={{ fontSize: '0.8rem' }}>No tools</li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── REST section ──────────────────────────────────────────────────────────────

function RestSection() {
  const baseUrl = window.location.origin;
  const curlExample = `curl -H "Authorization: Bearer <your-token>" \\
  -H "x-requested-with: agent-portal" \\
  ${baseUrl}/api/projects`;

  return (
    <section
      aria-label="REST API"
      style={{
        marginTop: 32,
        paddingTop: 20,
        borderTop: '1px solid var(--line)',
      }}
    >
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>REST API</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Use the portal REST API from scripts, CI pipelines, or any HTTP client.
      </p>

      <div className="field" style={{ marginBottom: 12 }}>
        <label>Base URL</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code
            style={{
              flex: 1, padding: '6px 10px',
              background: 'var(--canvas)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius)', fontFamily: 'var(--mono)', fontSize: '0.88rem',
            }}
            aria-label="REST API base URL"
          >
            {baseUrl}/api
          </code>
          <CopyButton text={`${baseUrl}/api`} label="Copy API base URL" />
        </div>
      </div>

      <div className="field">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <label style={{ marginBottom: 0 }}>Example request</label>
          <CopyButton text={curlExample} label="Copy curl example" />
        </div>
        <pre
          style={{
            background: 'var(--canvas)', border: '1px solid var(--line)',
            borderRadius: 'var(--radius)', padding: '10px 12px',
            fontFamily: 'var(--mono)', fontSize: '0.8rem',
            overflowX: 'auto', margin: 0,
          }}
          aria-label="REST API curl example"
        >
          {curlExample}
        </pre>
        <p className="field-hint">All mutating requests also require the <code>x-requested-with: agent-portal</code> header.</p>
      </div>
    </section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ApiAccess() {
  const [tokens, setTokens]       = useState([]);
  const [projects, setProjects]   = useState([]);
  const [mcpInfo, setMcpInfo]     = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [showNew, setShowNew]     = useState(false);
  const [revealToken, setRevealToken] = useState(null); // raw token string
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tokRes, projRes, mcpRes] = await Promise.all([
        api.get('/api/api-tokens'),
        api.get('/api/projects').catch(() => ({ projects: [] })),
        api.get('/api/mcp/info').catch(() => null),
      ]);
      setTokens(tokRes.tokens || []);
      setProjects(projRes.projects || []);
      setMcpInfo(mcpRes);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreated = (rawToken, info) => {
    setShowNew(false);
    setRevealToken(rawToken);
    setTokens((prev) => [info, ...prev]);
  };

  const revokeToken = async (tok) => {
    if (!await requestConfirm(`Revoke token "${tok.name}"? This cannot be undone.`, 'Revoke', 'danger')) return;
    try {
      await api.delete(`/api/api-tokens/${tok.id}`);
      setTokens((prev) => prev.map((t) => (t.id === tok.id ? { ...t, active: false, revoked_at: new Date().toISOString() } : t)));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? id;

  const scopeLabel = (tok) => {
    const scopes = tok.scopes || [];
    if (scopes.includes('merge')) return 'read + write + review + merge';
    if (scopes.includes('review')) return 'read + write + review';
    if (scopes.includes('write')) return 'read + write';
    return 'read';
  };

  return (
    <div className="page">
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      <div className="page-head">
        <h1>API access</h1>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
            <Icon name="plus" size={14} />
            New token
          </button>
        </div>
      </div>
      <p className="muted">Personal API tokens for automating portal access. Tokens act as you.</p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error-note" role="alert">{error}</p>}

      {!loading && !error && tokens.length === 0 && (
        <div className="card">
          <p className="muted">No tokens yet. Create one to access the portal API.</p>
        </div>
      )}

      {!loading && tokens.length > 0 && (
        <table className="data-table" aria-label="API tokens">
          <thead>
            <tr>
              <th>Name</th>
              <th>Scopes</th>
              <th>Project</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((tok) => (
              <tr key={tok.id} style={{ opacity: tok.active ? 1 : 0.5 }}>
                <td>
                  {tok.name}
                  {!tok.active && (
                    <span className="badge badge-neutral" style={{ marginLeft: 6 }}>
                      {tok.revoked_at ? 'revoked' : 'expired'}
                    </span>
                  )}
                </td>
                <td>
                  <span className="muted" style={{ fontSize: '0.82rem' }}>{scopeLabel(tok)}</span>
                </td>
                <td className="muted">{tok.project_id ? projectName(tok.project_id) : '—'}</td>
                <td className="muted">{formatRelative(tok.created_at)}</td>
                <td className="muted">{tok.last_used_at ? formatRelative(tok.last_used_at) : '—'}</td>
                <td className="muted">{formatDate(tok.expires_at)}</td>
                <td>
                  {tok.active && (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => revokeToken(tok)}
                      aria-label={`Revoke ${tok.name}`}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* MCP section */}
      <McpSection mcpInfo={mcpInfo} />

      {/* REST section */}
      <RestSection />

      {showNew && (
        <NewTokenModal
          projects={projects}
          onClose={() => setShowNew(false)}
          onCreated={handleCreated}
        />
      )}

      {revealToken && (
        <TokenRevealModal
          token={revealToken}
          onClose={() => setRevealToken(null)}
        />
      )}
    </div>
  );
}

export default ApiAccess;
