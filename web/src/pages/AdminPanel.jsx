/**
 * Admin panel — Users, Audit Log, API Tokens, Control Plane.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import UsersPage from './settings/Users.jsx';

// ── Audit log tab ─────────────────────────────────────────────────────────────

function AuditLogTab() {
  const [entries, setEntries] = useState([]);
  // total is an exact integer on SQLite; null on DynamoDB (no cheap full-count).
  const [total, setTotal] = useState(/** @type {number | null} */ (null));
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  // Cursor-based pagination — works on both SQLite and DynamoDB.
  // cursor: the cursor sent with the current page request (null = first page).
  // cursorStack: cursors for each previous page (pop to go back).
  // nextCursor: cursor returned by the latest response, used for the next page.
  const [cursor, setCursor] = useState(/** @type {string | null} */ (null));
  const [cursorStack, setCursorStack] = useState(/** @type {(string | null)[]} */ ([]));
  const [nextCursor, setNextCursor] = useState(/** @type {string | null} */ (null));
  const limit = 50;

  // 1-based page number derived from how many cursors we've pushed onto the stack.
  const page = cursorStack.length + 1;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set('cursor', cursor);
      if (actorId) params.set('actorId', actorId);
      if (action) params.set('action', action);
      const r = await api.get(`/api/admin/audit-log?${params}`);
      setEntries(r.entries || []);
      // Preserve null for DynamoDB; use the integer for SQLite.
      setTotal(typeof r.total === 'number' ? r.total : null);
      setHasMore(Boolean(r.hasMore));
      setNextCursor(r.nextCursor ?? null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [actorId, action, cursor]);

  useEffect(() => { load(); }, [load]);

  // Changing a filter resets to the first page.
  const handleActorChange = (e) => {
    setActorId(e.target.value);
    setCursor(null);
    setCursorStack([]);
    setNextCursor(null);
  };

  const handleActionChange = (e) => {
    setAction(e.target.value);
    setCursor(null);
    setCursorStack([]);
    setNextCursor(null);
  };

  const handleNext = () => {
    if (!nextCursor) return;
    setCursorStack((prev) => [...prev, cursor]);
    setCursor(nextCursor);
  };

  const handlePrev = () => {
    if (cursorStack.length === 0) return;
    const prevCursor = cursorStack[cursorStack.length - 1] ?? null;
    setCursorStack((prev) => prev.slice(0, -1));
    setCursor(prevCursor);
  };

  const totalPages = total !== null ? Math.ceil(total / limit) || 1 : null;

  return (
    <div>
      <div style={{ display: 'flex', gap: '.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={actorId}
          onChange={handleActorChange}
          placeholder="Filter by actor ID…"
          style={{ flex: 1, minWidth: 160 }}
        />
        <input
          type="text"
          value={action}
          onChange={handleActionChange}
          placeholder="Filter by action…"
          style={{ flex: 1, minWidth: 160 }}
        />
        <button type="button" className="btn" onClick={load} aria-label="Refresh">
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {loading && <div className="spinner" aria-label="Loading audit log…" />}
      {error && <p className="error-note" role="alert">{error}</p>}

      {!loading && entries.length === 0 && (
        <p className="muted">No audit log entries found.</p>
      )}

      {!loading && entries.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%', fontSize: '.875rem' }}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{e.ts ? formatRelative(e.ts) : '—'}</td>
                  {/* Fall back: actor_name → actor_email → actor_id → "System" (null actor = system event) */}
                  <td>{e.actor_name || e.actor_email || e.actor_id || 'System'}</td>
                  <td><code style={{ fontSize: '.8rem' }}>{e.action}</code></td>
                  <td className="muted" style={{ fontSize: '.8rem' }}>{e.target || '—'}</td>
                  <td className="muted" style={{ fontSize: '.8rem' }}>{e.ip || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination — cursor-based on both backends */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '.75rem' }}>
            {/* aria-live announces page changes to screen readers */}
            <span
              className="muted"
              style={{ fontSize: '.875rem' }}
              aria-live="polite"
              aria-atomic="true"
            >
              {total !== null
                ? `${total} ${total === 1 ? 'entry' : 'entries'} · page ${page} of ${totalPages}`
                : `Page ${page}`}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handlePrev}
              disabled={cursorStack.length === 0 || loading}
              aria-label="Previous page"
            >
              ← Prev
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleNext}
              disabled={!hasMore || loading}
              aria-label="Next page"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── API tokens tab ────────────────────────────────────────────────────────────

function ApiTokensTab({ isAdmin }) {
  const [tokens, setTokens] = useState([]);
  const [allTokens, setAllTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', scope: 'read' });
  const [createError, setCreateError] = useState(null);
  const [newToken, setNewToken] = useState(null);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get('/api/api-tokens');
      setTokens(r.tokens || []);
      if (isAdmin) {
        const ra = await api.get('/api/admin/api-tokens');
        setAllTokens(ra.tokens || []);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { load(); }, [load]);

  const createToken = async (e) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const r = await api.post('/api/api-tokens', createForm);
      setNewToken(r.token);
      setShowCreate(false);
      setCreateForm({ name: '', scope: 'read' });
      await load();
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const revokeToken = async (id) => {
    if (!await requestConfirm('Revoke this token?', 'Revoke', 'danger')) return;
    try {
      await api.delete(`/api/api-tokens/${id}`);
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  if (loading) return <div className="spinner" aria-label="Loading tokens…" />;
  if (error) return <p className="error-note" role="alert">{error}</p>;

  return (
    <div>
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      {newToken && (
        <div className="card" style={{ padding: '1rem', marginBottom: '1rem', background: 'var(--ok-wash)', border: '1px solid var(--ok)' }}>
          <p style={{ margin: '0 0 .5rem', fontWeight: 600 }}>Token created — copy it now, it won't be shown again.</p>
          <code style={{ wordBreak: 'break-all', fontSize: '.9rem' }}>{newToken}</code>
          <br /><br />
          <button type="button" className="btn btn-sm" onClick={() => setNewToken(null)}>Dismiss</button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
        <button type="button" className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
          <Icon name="plus" size={14} /> New token
        </button>
      </div>

      {showCreate && (
        <div className="card" style={{ padding: '1rem', marginBottom: '1rem' }}>
          <h3 style={{ marginTop: 0 }}>Create API token</h3>
          <form onSubmit={createToken} className="stack">
            <div className="field">
              <label htmlFor="tok-name">Name</label>
              <input
                id="tok-name"
                type="text"
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="CI pipeline, local dev, …"
                required maxLength={80}
              />
            </div>
            <div className="field">
              <label htmlFor="tok-scope">Scope</label>
              <select id="tok-scope" value={createForm.scope} onChange={(e) => setCreateForm((f) => ({ ...f, scope: e.target.value }))}>
                <option value="read">Read only</option>
                <option value="write">Read + write</option>
              </select>
            </div>
            {createError && <p className="error-note" role="alert">{createError}</p>}
            <div style={{ display: 'flex', gap: '.5rem' }}>
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? 'Creating…' : 'Create token'}
              </button>
              <button type="button" className="btn" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <h3 style={{ fontSize: '1rem' }}>My tokens</h3>
      {tokens.length === 0 ? (
        <p className="muted">No tokens yet.</p>
      ) : (
        <table className="data-table" style={{ width: '100%', fontSize: '.875rem' }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Scope</th>
              <th>Expires</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} style={{ opacity: t.active ? 1 : 0.5 }}>
                <td>{t.name}</td>
                <td><code>{t.prefix}…</code></td>
                <td>{t.scope}</td>
                <td className="muted">{t.expires_at ? new Date(t.expires_at).toLocaleDateString() : '—'}</td>
                <td className="muted">{t.last_used_at ? formatRelative(t.last_used_at) : 'Never'}</td>
                <td>{t.revoked_at ? <span className="badge badge-error">Revoked</span> : <span className="badge badge-success">Active</span>}</td>
                <td>
                  {!t.revoked_at && (
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => revokeToken(t.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {isAdmin && allTokens.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', marginTop: '1.5rem' }}>All tokens (admin view)</h3>
          <table className="data-table" style={{ width: '100%', fontSize: '.875rem' }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>User</th>
                <th>Scope</th>
                <th>Last used</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {allTokens.map((t) => (
                <tr key={t.id} style={{ opacity: t.active ? 1 : 0.5 }}>
                  <td>{t.name}</td>
                  <td className="muted" style={{ fontSize: '.8rem' }}>{t.user_name || t.user_email}</td>
                  <td>{t.scope}</td>
                  <td className="muted">{t.last_used_at ? formatRelative(t.last_used_at) : 'Never'}</td>
                  <td>{t.revoked_at ? <span className="badge badge-error">Revoked</span> : <span className="badge badge-success">Active</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ── Control plane tab ─────────────────────────────────────────────────────────

function ControlPlaneTab() {
  const [cp, setCp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [capsForm, setCapsForm] = useState({ globalMax: 0, perUserMax: 5, perProjectMax: 0 });
  const [saving, setSaving] = useState(false);
  const [draining, setDraining] = useState(false);
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get('/api/admin/control-plane');
      setCp(r);
      setCapsForm({
        globalMax: r.caps?.globalMax ?? 0,
        perUserMax: r.caps?.perUserMax ?? 5,
        perProjectMax: r.caps?.perProjectMax ?? 0,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleDrain = async () => {
    setDraining(true);
    try {
      await api.post('/api/admin/drain', { enable: !cp?.drain?.active });
      await load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setDraining(false);
    }
  };

  const saveCaps = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/api/admin/caps', {
        globalMax: Number(capsForm.globalMax),
        perUserMax: Number(capsForm.perUserMax),
        perProjectMax: Number(capsForm.perProjectMax),
      });
      await load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="spinner" aria-label="Loading control plane…" />;
  if (error) return <p className="error-note" role="alert">{error}</p>;

  return (
    <div className="stack" style={{ maxWidth: 600 }}>
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      {/* Status */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
        <div className="card" style={{ padding: '1rem', textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{cp?.sessions?.running ?? 0}</div>
          <div className="muted" style={{ fontSize: '.85rem' }}>Running</div>
        </div>
        <div className="card" style={{ padding: '1rem', textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{cp?.sessions?.queued ?? 0}</div>
          <div className="muted" style={{ fontSize: '.85rem' }}>Queued</div>
        </div>
        <div className="card" style={{ padding: '1rem', textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{cp?.approvals?.pending ?? 0}</div>
          <div className="muted" style={{ fontSize: '.85rem' }}>Awaiting approval</div>
        </div>
      </div>

      {/* Drain mode */}
      <div className="card" style={{ padding: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Drain mode</div>
            <div className="muted" style={{ fontSize: '.85rem' }}>
              {cp?.drain?.active
                ? `Active since ${new Date(cp.drain.startedAt).toLocaleTimeString()} — no new sessions will start.`
                : 'Inactive — new sessions are accepted normally.'}
            </div>
          </div>
          <button
            type="button"
            className={`btn${cp?.drain?.active ? ' btn-danger' : ''}`}
            onClick={toggleDrain}
            disabled={draining}
          >
            {cp?.drain?.active ? 'Stop drain' : 'Start drain'}
          </button>
        </div>
      </div>

      {/* Concurrency caps */}
      <div className="card" style={{ padding: '1rem' }}>
        <h3 style={{ margin: '0 0 1rem', fontSize: '1rem' }}>Concurrency limits</h3>
        <form onSubmit={saveCaps} className="stack">
          {[
            { key: 'globalMax', label: 'Global max sessions', hint: '0 = no limit' },
            { key: 'perUserMax', label: 'Per-user max sessions', hint: '0 = no limit' },
            { key: 'perProjectMax', label: 'Per-project max sessions', hint: '0 = no limit' },
          ].map(({ key, label, hint }) => (
            <div className="field" key={key}>
              <label htmlFor={`cap-${key}`}>{label}</label>
              <input
                id={`cap-${key}`}
                type="number"
                min="0"
                value={capsForm[key]}
                onChange={(e) => setCapsForm((f) => ({ ...f, [key]: e.target.value }))}
              />
              <p className="field-hint">{hint}</p>
            </div>
          ))}
          <button type="submit" className="btn btn-primary" disabled={saving} style={{ alignSelf: 'flex-start' }}>
            {saving ? 'Saving…' : 'Save limits'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Admin panel ───────────────────────────────────────────────────────────────

const ADMIN_TABS = [
  { id: 'users', label: 'Users' },
  { id: 'audit', label: 'Audit log' },
  { id: 'tokens', label: 'API tokens' },
  { id: 'controlplane', label: 'Control plane' },
];

export function AdminPanel({ user }) {
  const [tab, setTab] = useState('users');

  if (!user?.is_admin) {
    return (
      <div className="page">
        <h1>Users</h1>
        <p className="error-note">Admin access required.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Users</h1>

      <div className="tab-bar" role="tablist" aria-label="Admin sections">
        {ADMIN_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            className={`tab-btn${tab === t.id ? ' is-active' : ''}`}
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="tab-panel" style={{ paddingTop: '1rem' }}>
        {tab === 'users' && <UsersPage />}
        {tab === 'audit' && <AuditLogTab />}
        {tab === 'tokens' && <ApiTokensTab isAdmin={Boolean(user.is_admin)} />}
        {tab === 'controlplane' && <ControlPlaneTab />}
      </div>
    </div>
  );
}

export default AdminPanel;
