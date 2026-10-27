/**
 * Settings page shell with tabs:
 *   Provider — model provider configuration
 *   Tools    — optional tool packs
 *   Permissions — portal-wide command permission rules
 *   Users    — user management
 *   Budget   — monthly budget cap
 */

import { useState, useEffect } from 'react';
import { api } from '../../lib/api.js';
import Providers from './Providers.jsx';
import Secrets from './Secrets.jsx';
import UsersPage from './Users.jsx';

const TABS = [
  { id: 'provider',    label: 'Provider' },
  { id: 'tools',       label: 'Tools' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'users',       label: 'Users' },
  { id: 'budget',      label: 'Budget' },
  { id: 'tokens',      label: 'API tokens' },
];

export default function Settings() {
  const [tab, setTab] = useState('provider');
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/api/settings')
      .then((s) => { setSettings(s); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  if (loading) return <div className="page"><div className="spinner" aria-label="Loading settings…" /></div>;
  if (error) return <div className="page"><p className="error-note">{error}</p></div>;

  return (
    <div className="page">
      <h1>Settings</h1>

      <div className="tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            className={`tab-btn${tab === t.id ? ' is-active' : ''}`}
            aria-selected={tab === t.id}
            aria-controls={`tab-panel-${t.id}`}
            id={`tab-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`tab-panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        className="tab-panel"
      >
        {tab === 'provider' && (
          <Providers
            settings={settings}
            onSaved={(updated) => setSettings(updated)}
          />
        )}
        {tab === 'tools' && <Secrets />}
        {tab === 'permissions' && <PermissionsTab />}
        {tab === 'users' && <UsersPage />}
        {tab === 'budget' && (
          <BudgetTab
            settings={settings}
            onSaved={(updated) => setSettings(updated)}
          />
        )}
        {tab === 'tokens' && <ApiTokensSettingsTab />}
      </div>
    </div>
  );
}

// ── Permissions tab placeholder ───────────────────────────────────────────────

function PermissionsTab() {
  return (
    <section aria-label="Permissions">
      <h2>Portal-wide permissions</h2>
      <p className="muted">
        Configure which shell commands agents may run, ask for, or are always blocked.
        These rules apply to all projects unless a project overrides them.
      </p>
      <p className="muted">
        Visit <a href="#/admin">Admin › Permissions</a> to manage permission rule groups.
      </p>
    </section>
  );
}

// ── Budget tab ────────────────────────────────────────────────────────────────

function BudgetTab({ settings, onSaved }) {
  const [budget, setBudget] = useState(
    settings?.monthlyBudget != null ? String(settings.monthlyBudget) : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const monthlyBudget = budget.trim() ? Number(budget) : null;
      if (budget.trim() && isNaN(monthlyBudget)) {
        setError('Budget must be a number');
        return;
      }
      const updated = await api.put('/api/settings', { monthlyBudget });
      onSaved?.(updated);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Budget settings">
      <h2>Monthly budget</h2>
      <p className="muted">
        Set a portal-wide monthly spend cap in USD. New runs are blocked once the cap is reached.
        Leave blank for no limit. Demo and Kiro CLI runs are free and do not count toward the cap.
      </p>
      <form onSubmit={submit} className="stack" style={{ maxWidth: 400 }}>
        <div className="field">
          <label htmlFor="budget-cap">Monthly cap (USD)</label>
          <div className="input-prefix">
            <span>$</span>
            <input
              id="budget-cap"
              type="number"
              min="0"
              step="1"
              value={budget}
              onChange={(e) => { setBudget(e.target.value); setSaved(false); }}
              placeholder="No limit"
              style={{ paddingLeft: '1.8rem' }}
            />
          </div>
          <p className="field-hint">Leave blank to allow unlimited spending.</p>
        </div>
        {error && <p className="error-note" role="alert">{error}</p>}
        {saved && <p className="success-note" role="status">Budget saved.</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save budget'}
        </button>
      </form>
    </section>
  );
}


// ── API tokens tab ────────────────────────────────────────────────────────────

function ApiTokensSettingsTab() {
  return (
    <section aria-label="API tokens">
      <h2>API tokens</h2>
      <p className="muted">
        Personal access tokens let scripts and CI pipelines call the portal API as you.
        Manage your tokens below, or visit <a href="#/admin">Admin › API tokens</a> for the full view.
      </p>
      <a href="#/admin" className="btn">Go to Admin › API tokens</a>
    </section>
  );
}