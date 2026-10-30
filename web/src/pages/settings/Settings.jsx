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
  { id: 'codereview',  label: 'Code review' },
];

export default function Settings({ user }) {
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
        {tab === 'codereview' && <CodeReviewTab user={user} />}
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


// ── Code Review settings tab ──────────────────────────────────────────────────

const MERGE_THRESHOLDS = [
  { value: 'critical', label: 'No gate — nothing blocks merge', description: 'Any finding severity is acceptable — nothing blocks merge.' },
  { value: 'high',     label: 'High or lower (default)', description: 'High is the worst finding you can still merge. Critical findings block the merge.' },
  { value: 'medium',   label: 'Medium or lower', description: 'Medium is the worst finding you can still merge. Critical and High findings block the merge.' },
  { value: 'low',      label: 'Low or lower', description: 'Low is the worst finding you can still merge. Critical, High, and Medium findings block the merge.' },
  { value: 'info',     label: 'Info only', description: 'Info is the worst finding you can still merge. Only informational findings can pass through.' },
  { value: 'none',     label: 'Zero findings required', description: 'No findings at all — even Info blocks the merge.' },
];

function CodeReviewTab({ user }) {
  const isAdmin = user?.is_admin;
  const [threshold, setThreshold] = useState('high');
  const [rateCard, setRateCard] = useState({ inputUsd: 3, outputUsd: 15, cacheWriteUsd: 3.75, cacheReadUsd: 0.30 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get('/api/settings/review')
      .then((r) => {
        setThreshold(r.mergeThreshold ?? 'high');
        if (r.rateCard) setRateCard(r.rateCard);
        setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const r = await api.put('/api/settings/review', { mergeThreshold: threshold, rateCard });
      setThreshold(r.mergeThreshold ?? threshold);
      if (r.rateCard) setRateCard(r.rateCard);
      setSaved(true);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="spinner" aria-label="Loading code review settings…" />;
  if (error)   return <p className="error-note" role="alert">{error}</p>;

  const currentThreshold = MERGE_THRESHOLDS.find((t) => t.value === threshold) ?? MERGE_THRESHOLDS[1];

  return (
    <section aria-label="Code review settings">
      <h2>Code review</h2>
      <p className="muted">
        Configure the merge gate and token cost rates used for code reviews.
      </p>

      <form onSubmit={save} className="stack-lg" style={{ maxWidth: 560, marginTop: 16 }} noValidate>
        {/* Merge threshold */}
        <div>
          <h3 style={{ marginBottom: 10 }}>Merge threshold</h3>
          <p className="muted" style={{ marginBottom: 12, fontSize: '0.84rem' }}>
            The worst finding severity that is still allowed to merge. Reviews with a finding worse than this threshold will be blocked.
          </p>
          <div role="group" aria-label="Merge threshold options">
            {MERGE_THRESHOLDS.map((opt) => (
              <label
                key={opt.value}
                className={`choice${threshold === opt.value ? ' is-checked' : ''}`}
                style={{ cursor: isAdmin ? 'pointer' : 'default' }}
              >
                <input
                  type="radio"
                  name="mergeThreshold"
                  value={opt.value}
                  checked={threshold === opt.value}
                  onChange={() => isAdmin && setThreshold(opt.value)}
                  disabled={!isAdmin}
                  aria-describedby={`threshold-desc-${opt.value}`}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{opt.label}</div>
                  <div
                    id={`threshold-desc-${opt.value}`}
                    className="muted"
                    style={{ fontSize: '0.82rem', marginTop: 2 }}
                  >
                    {opt.description}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Rate card */}
        <div>
          <h3 style={{ marginBottom: 8 }}>Token rate card</h3>
          <p className="muted" style={{ marginBottom: 12, fontSize: '0.84rem' }}>
            USD per 1 million tokens. Used to estimate costs. These are estimates — always label as such.
          </p>
          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
            aria-label="Token rates"
          >
            {[
              { key: 'inputUsd',      label: 'Input (uncached)',  id: 'rc-input' },
              { key: 'outputUsd',     label: 'Output',            id: 'rc-output' },
              { key: 'cacheWriteUsd', label: 'Cache write',       id: 'rc-write' },
              { key: 'cacheReadUsd',  label: 'Cache read',        id: 'rc-read' },
            ].map(({ key, label, id }) => (
              <div className="field" key={key}>
                <label htmlFor={id}>{label} ($/1M)</label>
                <div className="input-prefix">
                  <span>$</span>
                  <input
                    id={id}
                    type="number"
                    min="0"
                    step="0.01"
                    value={rateCard[key] ?? ''}
                    onChange={(e) => isAdmin && setRateCard((rc) => ({ ...rc, [key]: Number(e.target.value) }))}
                    disabled={!isAdmin}
                    style={{ paddingLeft: '1.8rem' }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {saveError && <p className="error-note" role="alert">{saveError}</p>}
        {saved && (
          <p
            role="status"
            style={{
              color: 'var(--ok)', background: 'var(--ok-wash)',
              border: '1px solid color-mix(in srgb, var(--ok) 30%, transparent)',
              borderRadius: 'var(--radius)', padding: '8px 12px', fontSize: '0.84rem',
            }}
          >
            Code review settings saved.
          </p>
        )}

        {isAdmin ? (
          <button type="submit" className="btn btn-primary" disabled={saving} style={{ width: 'fit-content' }}>
            {saving ? 'Saving…' : 'Save code review settings'}
          </button>
        ) : (
          <p className="muted" style={{ fontSize: '0.84rem' }}>
            Admin access is required to change these settings.
          </p>
        )}
      </form>
    </section>
  );
}
