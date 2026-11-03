/**
 * Settings page shell with tabs.
 *
 * All users can view Settings; only admins can make changes.
 * Non-admins see a banner and disabled/read-only controls on new tabs.
 * Existing tabs (Provider, Tools, Budget, etc.) rely on the server 403 guard.
 *
 * New tabs (F8):
 *   Models   — Claude model list editor (one "model id | label" per line)
 *   Sessions — Idle-stop minutes + terminal enable toggle
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api.js';
import Providers from './Providers.jsx';
import Secrets from './Secrets.jsx';
import AppearanceTab from './Appearance.jsx';
import { PageHeader, SectionHead } from '../../components/PageHeader.jsx';

const TABS = [
  { id: 'provider',    label: 'Portal AI provider' },
  { id: 'tools',       label: 'Tools' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'budget',      label: 'Budget' },
  { id: 'codereview',  label: 'Code review' },
  { id: 'sessions',    label: 'Sessions' },
  { id: 'delegation',  label: 'Delegated sessions' },
  { id: 'github',      label: 'GitHub' },
  { id: 'appearance',  label: 'Appearance' },
];

function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} minutes ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} hours ago`;
  return `${Math.floor(secs / 86400)} days ago`;
}

export default function Settings({ user }) {
  const [tab, setTab] = useState('provider');
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isAdmin = Boolean(user?.is_admin);

  useEffect(() => {
    api.get('/api/settings')
      .then((s) => { setSettings(s); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  if (loading) return <div className="page"><div className="spinner" aria-label="Loading settings…" /></div>;
  if (error) return <div className="page"><p className="error-note">{error}</p></div>;

  return (
    <div className="page">
      <PageHeader title="Settings" description="Portal-wide settings: AI provider, appearance and storage." />

      {/* Read-only banner for non-admins */}
      {!isAdmin && (
        <div
          role="note"
          aria-label="Read-only settings"
          style={{
            background: 'var(--warn-wash)',
            border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)',
            borderRadius: 'var(--radius)',
            padding: '10px 14px',
            marginBottom: 16,
            fontSize: '0.84rem',
            color: 'var(--warn)',
          }}
        >
          <strong>Only admins can change these settings.</strong>
          {settings?.lastChangedAt && (
            <span style={{ marginLeft: 8, color: 'var(--ink-2)' }}>
              Last changed {timeAgo(settings.lastChangedAt)}
              {settings.lastChangedBy ? ` by ${settings.lastChangedBy}` : ''}.
            </span>
          )}
        </div>
      )}

      {/* Last-changed info for admins */}
      {isAdmin && settings?.lastChangedAt && (
        <p className="muted" style={{ fontSize: '0.82rem', marginBottom: 12 }}>
          Last changed {timeAgo(settings.lastChangedAt)}
          {settings.lastChangedBy ? ` by ${settings.lastChangedBy}` : ''}.
        </p>
      )}

      <div className="tab-bar" role="tablist" aria-label="Settings sections">
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
          <>
            <p className="muted" style={{ fontSize: '0.84rem', marginBottom: 16 }}>
              This is the portal's own AI account, used by code reviews, branch scans, Knowledge
              Ask and test generation. It is also the fallback for sessions when a user has no
              sign-in under <a href="#/credentials">Credentials</a>.
            </p>
            <Providers
              settings={settings}
              isAdmin={isAdmin}
              onSaved={(updated) => setSettings(updated)}
            />
          </>
        )}
        {tab === 'tools' && <Secrets />}
        {tab === 'permissions' && <PermissionsTab />}
        {tab === 'budget' && (
          <BudgetTab
            settings={settings}
            isAdmin={isAdmin}
            onSaved={(updated) => setSettings(updated)}
          />
        )}
        {tab === 'codereview' && <CodeReviewTab user={user} />}
        {tab === 'sessions' && (
          <SessionsTab isAdmin={isAdmin} />
        )}
        {tab === 'delegation' && (
          <DelegationTab isAdmin={isAdmin} />
        )}
        {tab === 'appearance' && (
          <AppearanceTab isAdmin={isAdmin} />
        )}
        {tab === 'github' && (
          <GitHubSettingsTab
            settings={settings}
            isAdmin={isAdmin}
            onSaved={(updated) => setSettings(updated)}
          />
        )}
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
    </section>
  );
}

// ── Budget tab ────────────────────────────────────────────────────────────────

function BudgetTab({ settings, isAdmin, onSaved }) {
  const [budget, setBudget] = useState(
    settings?.monthlyBudget != null ? String(settings.monthlyBudget) : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!isAdmin) return;
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
              disabled={!isAdmin}
            />
          </div>
          <p className="field-hint">Leave blank to allow unlimited spending.</p>
        </div>
        {error && <p className="error-note" role="alert">{error}</p>}
        {saved && <p className="success-note" role="status">Budget saved.</p>}
        {isAdmin ? (
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save budget'}
          </button>
        ) : (
          <p className="muted" style={{ fontSize: '0.84rem' }}>
            Admin access is required to change the budget.
          </p>
        )}
      </form>
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

function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* fallback */ }
  };
  return (
    <button type="button" className="btn btn-sm" onClick={copy} aria-label={label ?? 'Copy to clipboard'}>
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
}

function CrossAccountPolicyHelper() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get('/api/settings/bedrock-cross-account-policy');
      setData(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  if (!data && !loading && !error) {
    return (
      <button type="button" className="btn btn-sm" onClick={load}>
        Show cross-account policies
      </button>
    );
  }

  if (loading) return <div className="spinner" style={{ width: 18, height: 18 }} aria-label="Loading policies…" />;
  if (error) return <p className="error-note" role="alert">{error}</p>;

  const trustJson = JSON.stringify(data.trustPolicy, null, 2);
  const permsJson = JSON.stringify(data.permissionsPolicy, null, 2);

  return (
    <div style={{ marginTop: 12 }}>
      {data.isPrincipalPlaceholder && (
        <div
          role="note"
          style={{
            background: 'var(--warn-wash)', border: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)',
            borderRadius: 'var(--radius)', padding: '8px 12px',
            fontSize: '0.84rem', marginBottom: 12, color: 'var(--warn)',
          }}
        >
          <strong>Note:</strong> {data.hint ?? 'Set the PORTAL_ROLE_ARN environment variable to the IAM role ARN running this portal.'}
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <strong style={{ fontSize: '0.88rem' }}>Trust policy (paste into the cross-account role's trust policy)</strong>
          <CopyButton text={trustJson} label="Copy trust policy JSON" />
        </div>
        <pre style={{
          background: 'var(--canvas)', border: '1px solid var(--line)',
          borderRadius: 'var(--radius)', padding: '10px 12px',
          fontSize: '0.78rem', fontFamily: 'var(--mono)',
          overflowX: 'auto', margin: 0, maxHeight: 200,
        }}>{trustJson}</pre>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <strong style={{ fontSize: '0.88rem' }}>Permissions policy (attach to the cross-account role)</strong>
          <CopyButton text={permsJson} label="Copy permissions policy JSON" />
        </div>
        <pre style={{
          background: 'var(--canvas)', border: '1px solid var(--line)',
          borderRadius: 'var(--radius)', padding: '10px 12px',
          fontSize: '0.78rem', fontFamily: 'var(--mono)',
          overflowX: 'auto', margin: 0, maxHeight: 200,
        }}>{permsJson}</pre>
      </div>
    </div>
  );
}

function ScanAllowlistEditor() {
  const [users, setUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/api/scans/allowlist').catch(() => ({ users: [] })),
      api.get('/api/users').catch(() => ({ users: [] })),
    ]).then(([allowRes, usersRes]) => {
      setUsers(allowRes.users || []);
      setAllUsers(usersRes.users || []);
      setLoading(false);
    }).catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      await api.put('/api/scans/allowlist', { users });
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = (userId) => {
    setUsers((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
    setSaved(false);
  };

  if (loading) return <div className="spinner" style={{ width: 18, height: 18 }} aria-label="Loading allowlist…" />;
  if (error) return <p className="error-note" role="alert">{error}</p>;

  return (
    <form onSubmit={save} noValidate>
      <p className="muted" style={{ fontSize: '0.84rem', marginBottom: 10 }}>
        Only these users can start branch scans. Admins can always run scans. PR reviews are unaffected.
      </p>
      {allUsers.length === 0 ? (
        <p className="muted" style={{ fontSize: '0.84rem' }}>No users found. Use the Users tab to manage portal users.</p>
      ) : (
        <div role="group" aria-label="Full scan allowlist">
          {allUsers.map((u) => (
            <label key={u.id} className="choice" style={{ marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={users.includes(u.id)}
                onChange={() => toggle(u.id)}
                aria-label={`Allow ${u.name || u.email} to run branch scans`}
              />
              <span>
                {u.name || u.email}
                {u.is_admin ? <span className="badge badge-info" style={{ marginLeft: 6 }}>admin</span> : null}
              </span>
            </label>
          ))}
        </div>
      )}
      {error && <p className="error-note" role="alert" style={{ marginTop: 8 }}>{error}</p>}
      {saved && <p role="status" style={{ color: 'var(--ok)', fontSize: '0.84rem', marginTop: 6 }}>✓ Allowlist saved.</p>}
      <button type="submit" className="btn btn-primary" disabled={saving} style={{ marginTop: 10 }}>
        {saving ? 'Saving…' : 'Save allowlist'}
      </button>
    </form>
  );
}

function CodeReviewTab({ user }) {
  const isAdmin = user?.is_admin;
  const [threshold, setThreshold] = useState('high');
  const [rateCard, setRateCard] = useState({ inputUsd: 3, outputUsd: 15, cacheWriteUsd: 3.75, cacheReadUsd: 0.30 });
  const [prCommentMode, setPrCommentMode] = useState('manual');
  // LiteLLM
  const [liteLLMUrl, setLiteLLMUrl] = useState('');
  const [liteLLMKey, setLiteLLMKey] = useState('');
  const [liteLLMModel, setLiteLLMModel] = useState('');
  const [liteLLMHasKey, setLiteLLMHasKey] = useState(false);
  // Provider from settings
  const [provider, setProvider] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/api/settings/review'),
      api.get('/api/settings'),
    ]).then(([r, s]) => {
      setThreshold(r.mergeThreshold ?? 'high');
      if (r.rateCard) setRateCard(r.rateCard);
      setPrCommentMode(r.prCommentMode ?? 'manual');
      const prov = s.provider?.mode ?? '';
      setProvider(prov);
      if (s.litellm) {
        setLiteLLMUrl(s.litellm.baseUrl ?? '');
        setLiteLLMModel(s.litellm.model ?? '');
        setLiteLLMHasKey(Boolean(s.litellm.hasKey));
      }
      setLoading(false);
    }).catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const r = await api.put('/api/settings/review', {
        mergeThreshold: threshold,
        rateCard,
        prCommentMode,
      });
      setThreshold(r.mergeThreshold ?? threshold);
      if (r.rateCard) setRateCard(r.rateCard);
      setPrCommentMode(r.prCommentMode ?? prCommentMode);
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
        Configure merge gate, PR comment behaviour, and provider settings for code reviews.
      </p>

      <form onSubmit={save} className="stack-lg" style={{ maxWidth: 560, marginTop: 16 }} noValidate>

        {/* PR comment mode */}
        <div>
          <h3 style={{ marginBottom: 8 }}>PR comment mode</h3>
          <p className="muted" style={{ marginBottom: 10, fontSize: '0.84rem' }}>
            Controls when review findings are posted as PR comments.
          </p>
          <div role="group" aria-label="PR comment mode options">
            {[
              { value: 'manual',    label: 'Manual',    description: 'You decide when to post findings — click "Post to GitHub/CodeCommit" on the review page.' },
              { value: 'automatic', label: 'Automatic', description: 'Findings are posted automatically when a review completes, once per PR revision. Skipped if the PR moved during review.' },
            ].map((opt) => (
              <label
                key={opt.value}
                className={`choice${prCommentMode === opt.value ? ' is-checked' : ''}`}
                style={{ cursor: isAdmin ? 'pointer' : 'default', marginBottom: 6 }}
              >
                <input
                  type="radio"
                  name="prCommentMode"
                  value={opt.value}
                  checked={prCommentMode === opt.value}
                  onChange={() => isAdmin && setPrCommentMode(opt.value)}
                  disabled={!isAdmin}
                  aria-describedby={`prcm-desc-${opt.value}`}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{opt.label}</div>
                  <div id={`prcm-desc-${opt.value}`} className="muted" style={{ fontSize: '0.82rem', marginTop: 2 }}>
                    {opt.description}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* LiteLLM gateway */}
        <div>
          <h3 style={{ marginBottom: 8 }}>LiteLLM gateway (optional)</h3>
          <div
            role="note"
            style={{
              background: 'var(--warn-wash)', border: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)',
              borderRadius: 'var(--radius)', padding: '8px 12px',
              fontSize: '0.82rem', marginBottom: 12, color: 'var(--warn)',
            }}
          >
            <strong>Security note:</strong> When a LiteLLM gateway is configured, the gateway operator can read the code being reviewed. Only connect to a gateway you trust.
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <div className="field">
              <label htmlFor="litellm-url">Gateway URL</label>
              <input
                id="litellm-url"
                type="url"
                value={liteLLMUrl}
                onChange={(e) => isAdmin && setLiteLLMUrl(e.target.value)}
                disabled={!isAdmin}
                placeholder="https://my-litellm.example.com"
                aria-describedby="litellm-url-hint"
              />
              <p className="field-hint" id="litellm-url-hint">OpenAI-compatible endpoint. Leave blank to disable.</p>
            </div>
            <div className="field">
              <label htmlFor="litellm-model">Model</label>
              <input
                id="litellm-model"
                type="text"
                value={liteLLMModel}
                onChange={(e) => isAdmin && setLiteLLMModel(e.target.value)}
                disabled={!isAdmin}
                placeholder="gpt-4o"
              />
            </div>
            <div className="field">
              <label htmlFor="litellm-key">API key {liteLLMHasKey ? <span className="muted">(saved — enter to replace)</span> : null}</label>
              <input
                id="litellm-key"
                type="password"
                value={liteLLMKey}
                onChange={(e) => isAdmin && setLiteLLMKey(e.target.value)}
                disabled={!isAdmin}
                placeholder={liteLLMHasKey ? '••••••••' : 'Optional'}
                autoComplete="new-password"
              />
            </div>
          </div>
        </div>

        {/* Cross-account Bedrock helper */}
        {(provider === 'bedrock' || provider === '') && isAdmin && (
          <div>
            <h3 style={{ marginBottom: 8 }}>Cross-account Bedrock (assumed role)</h3>
            <p className="muted" style={{ fontSize: '0.84rem', marginBottom: 10 }}>
              When the portal runs in one AWS account and Bedrock is in another, create an IAM role in the Bedrock account using these policies.
            </p>
            <CrossAccountPolicyHelper />
          </div>
        )}

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

      {/* Full-scan allowlist — only shown to admins */}
      {isAdmin && (
        <div style={{ marginTop: 32, maxWidth: 560 }}>
          <h3 style={{ marginBottom: 4 }}>Full-scan allowlist</h3>
          <ScanAllowlistEditor />
        </div>
      )}
    </section>
  );
}

// ── Sessions tab (F8) — idle-stop + terminal toggle ───────────────────────────

function SessionsTab({ isAdmin }) {
  const [idleMinutes, setIdleMinutes] = useState('');
  const [termEnabled, setTermEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [idleSaving, setIdleSaving] = useState(false);
  const [idleSaved, setIdleSaved] = useState(false);
  const [idleError, setIdleError] = useState(null);
  const [termSaving, setTermSaving] = useState(false);
  const [termSaved, setTermSaved] = useState(false);
  const [termError, setTermError] = useState(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [idleR, termR] = await Promise.all([
        api.get('/api/admin/session/idle-timeout').catch(() => ({ minutes: 30 })),
        api.get('/api/admin/terminal/settings').catch(() => ({ enabled: true })),
      ]);
      setIdleMinutes(String(idleR.minutes ?? 30));
      setTermEnabled(Boolean(termR.enabled ?? true));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const saveIdleTimeout = async (e) => {
    e.preventDefault();
    setIdleSaving(true);
    setIdleError(null);
    setIdleSaved(false);
    try {
      const minutes = parseInt(idleMinutes, 10);
      if (isNaN(minutes) || minutes < 5 || minutes > 240) {
        setIdleError('Idle timeout must be between 5 and 240 minutes');
        return;
      }
      await api.put('/api/admin/session/idle-timeout', { minutes });
      setIdleSaved(true);
    } catch (err) {
      setIdleError(err.message);
    } finally {
      setIdleSaving(false);
    }
  };

  const saveTerminal = async (enabled) => {
    setTermSaving(true);
    setTermError(null);
    setTermSaved(false);
    try {
      await api.put('/api/admin/terminal/settings', { enabled });
      setTermEnabled(enabled);
      setTermSaved(true);
    } catch (err) {
      setTermError(err.message);
    } finally {
      setTermSaving(false);
    }
  };

  if (loading) return <div className="spinner" aria-label="Loading session settings…" />;
  if (error) return (
    <div>
      <p className="error-note" role="alert">{error}</p>
      <button type="button" className="btn" onClick={loadSettings} style={{ marginTop: 8 }}>
        Retry
      </button>
    </div>
  );

  return (
    <section aria-label="Session settings">
      <h2>Session settings</h2>

      {/* Idle timeout */}
      <div style={{ marginBottom: 28 }}>
        <h3 style={{ marginBottom: 8 }}>Idle stop</h3>
        <p className="muted" style={{ fontSize: '0.84rem', marginBottom: 12 }}>
          A session with no activity for this many minutes is automatically stopped.
          Sending a message resumes it from where it left off.
        </p>
        <form
          onSubmit={saveIdleTimeout}
          noValidate
          style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}
        >
          <div className="field" style={{ maxWidth: 200 }}>
            <label htmlFor="idle-minutes">Idle timeout (minutes)</label>
            <input
              id="idle-minutes"
              type="number"
              min="5"
              max="240"
              value={idleMinutes}
              onChange={(e) => { setIdleMinutes(e.target.value); setIdleSaved(false); }}
              disabled={!isAdmin}
              aria-describedby="idle-minutes-hint"
            />
            <p className="field-hint" id="idle-minutes-hint">Range: 5–240 minutes. Default: 30.</p>
          </div>
          {isAdmin && (
            <button
              type="submit"
              className="btn btn-primary"
              disabled={idleSaving}
              style={{ marginBottom: 22 }}
            >
              {idleSaving ? 'Saving…' : 'Save'}
            </button>
          )}
          {idleSaved && (
            <span style={{ color: 'var(--ok)', fontSize: '0.84rem', marginBottom: 22 }} role="status">
              ✓ Saved
            </span>
          )}
        </form>
        {idleError && <p className="error-note" role="alert" style={{ marginTop: 4 }}>{idleError}</p>}
      </div>

      {/* Terminal toggle */}
      <div>
        <h3 style={{ marginBottom: 8 }}>Terminal access</h3>
        <p className="muted" style={{ fontSize: '0.84rem', marginBottom: 12 }}>
          Enable or disable the integrated terminal for all sessions.
          Users with active terminal sessions keep their connections when you disable this;
          new terminal connections are blocked.
        </p>
        <label
          className={`choice${isAdmin ? '' : ''}`}
          style={{ cursor: isAdmin ? 'pointer' : 'default', maxWidth: 480 }}
        >
          <input
            type="checkbox"
            checked={termEnabled}
            onChange={(e) => isAdmin && saveTerminal(e.target.checked)}
            disabled={!isAdmin || termSaving}
            aria-describedby="term-toggle-hint"
          />
          <span>
            <strong>Enable terminal</strong>{' '}
            <span className="muted">
              {termEnabled ? 'Terminal is currently enabled.' : 'Terminal is currently disabled.'}
            </span>
          </span>
        </label>
        {termSaved && (
          <p role="status" style={{ color: 'var(--ok)', fontSize: '0.84rem', marginTop: 6 }}>
            ✓ Terminal setting saved.
          </p>
        )}
        {termError && (
          <p className="error-note" role="alert" style={{ marginTop: 6 }}>{termError}</p>
        )}
      </div>
    </section>
  );
}

// ── GitHub settings tab ───────────────────────────────────────────────────────

function GitHubSettingsTab({ settings, isAdmin, onSaved }) {
  const [clientId, setClientId] = useState(settings?.github?.oauthClientId ?? '');
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState(null);
  const [saved,    setSaved]    = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!isAdmin) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api.put('/api/settings', {
        githubOauthClientId: clientId.trim() || null,
      });
      onSaved?.(updated);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="GitHub settings">
      <h2>GitHub OAuth App</h2>
      <p className="muted" style={{ fontSize: '0.84rem', marginBottom: 16 }}>
        Configure a GitHub OAuth App to enable the device-code sign-in flow for Git connections.
        Without this, users can only connect to GitHub via a Personal Access Token.
      </p>

      <div style={{
        background: 'var(--canvas)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        padding: '12px 14px',
        fontSize: '0.84rem',
        marginBottom: 16,
        lineHeight: 1.6,
      }}>
        <strong>How to set up a GitHub OAuth App:</strong>
        <ol style={{ margin: '8px 0 0 16px' }}>
          <li>
            Go to{' '}
            <a href="https://github.com/settings/developers" target="_blank" rel="noopener noreferrer">
              GitHub → Settings → Developer settings → OAuth Apps
            </a>
            {' '}and click <strong>New OAuth App</strong>.
          </li>
          <li>Set the <strong>Homepage URL</strong> to your portal URL.</li>
          <li>
            The Authorization callback URL can be any valid URL — this app uses the{' '}
            <a href="https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow" target="_blank" rel="noopener noreferrer">
              device flow
            </a>
            {' '}which does not redirect.
          </li>
          <li>After creating the app, open its settings and enable <strong>Device Flow</strong>.</li>
          <li>Copy the <strong>Client ID</strong> (not the client secret) and paste it below.</li>
        </ol>
      </div>

      <form onSubmit={submit} className="stack" style={{ maxWidth: 440 }} noValidate>
        <div className="field">
          <label htmlFor="gh-oauth-client-id">
            GitHub OAuth App Client ID
            {settings?.github?.oauthClientId && (
              <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>(configured)</span>
            )}
          </label>
          <input
            id="gh-oauth-client-id"
            type="text"
            value={clientId}
            onChange={(e) => { setClientId(e.target.value); setSaved(false); }}
            placeholder="Ov23li…"
            disabled={!isAdmin}
            aria-describedby="gh-client-id-hint"
            autoComplete="off"
          />
          <p className="field-hint" id="gh-client-id-hint">
            Starts with <code>Ov23li</code>. Leave blank to disable device-flow sign-in.
          </p>
        </div>

        {error && <p className="error-note" role="alert">{error}</p>}
        {saved && (
          <p role="status" style={{ color: 'var(--ok)', fontSize: '0.84rem' }}>
            ✓ GitHub settings saved.
          </p>
        )}

        {isAdmin ? (
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy}
            style={{ width: 'fit-content' }}
          >
            {busy ? 'Saving…' : 'Save GitHub settings'}
          </button>
        ) : (
          <p className="muted" style={{ fontSize: '0.84rem' }}>
            Admin access is required to change GitHub settings.
          </p>
        )}
      </form>
    </section>
  );
}

// ── Delegation tab (F7) ───────────────────────────────────────────────────────

function DelegationTab({ isAdmin }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // form state
  const [enabled, setEnabled] = useState(true);
  const [maxParent, setMaxParent] = useState('3');
  const [maxUser, setMaxUser] = useState('5');
  const [idleStop, setIdleStop] = useState('15');
  const [allowNested, setAllowNested] = useState(false);
  const [nudge, setNudge] = useState('4');

  useEffect(() => {
    api.get('/api/admin/delegation')
      .then((s) => {
        setSettings(s);
        setEnabled(s.enabled);
        setMaxParent(String(s.maxRunningPerParent));
        setMaxUser(String(s.maxRunningPerUser));
        setIdleStop(String(s.idleStopMinutes));
        setAllowNested(s.allowNested);
        setNudge(String(s.nudgeThreshold));
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
      const updated = await api.put('/api/admin/delegation', {
        enabled,
        maxRunningPerParent: Number(maxParent),
        maxRunningPerUser: Number(maxUser),
        idleStopMinutes: Number(idleStop),
        allowNested,
        nudgeThreshold: Number(nudge),
      });
      setSettings(updated);
      setSaved(true);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="spinner" aria-label="Loading delegation settings…" />;
  if (error) return <p className="error-note" role="alert">{error}</p>;

  return (
    <section aria-label="Delegated sessions settings">
      <h2>Delegated sessions</h2>
      <p className="muted" style={{ marginBottom: 16, fontSize: '0.84rem' }}>
        Control whether sessions can delegate tasks to child sessions. Limits prevent runaway
        delegation chains and control concurrent resource use.
      </p>

      <form onSubmit={save} className="stack-lg" style={{ maxWidth: 480 }} noValidate>

        {/* Enable/disable */}
        <div>
          <label className="choice" style={{ cursor: isAdmin ? 'pointer' : 'default' }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => isAdmin && setEnabled(e.target.checked)}
              disabled={!isAdmin}
              aria-describedby="del-enabled-hint"
            />
            <span>
              <strong>Enable delegation</strong>
              <span className="muted" style={{ marginLeft: 6 }}>
                Allow sessions and agents to delegate tasks to child sessions.
              </span>
            </span>
          </label>
          <p className="field-hint" id="del-enabled-hint" style={{ marginTop: 4 }}>
            Turning this off removes the delegate tool from new agent turns and disables the Delegate button.
            Running child sessions are not affected.
          </p>
        </div>

        {/* Max running per parent */}
        <div className="field" style={{ maxWidth: 280 }}>
          <label htmlFor="del-max-parent">Max running child sessions per parent (0 = unlimited)</label>
          <input
            id="del-max-parent"
            type="number"
            min="0"
            max="10"
            value={maxParent}
            onChange={(e) => { setMaxParent(e.target.value); setSaved(false); }}
            disabled={!isAdmin}
            aria-describedby="del-max-parent-hint"
          />
          <p className="field-hint" id="del-max-parent-hint">Range: 0–10</p>
        </div>

        {/* Max running per user */}
        <div className="field" style={{ maxWidth: 280 }}>
          <label htmlFor="del-max-user">Max running delegated sessions per user (0 = unlimited)</label>
          <input
            id="del-max-user"
            type="number"
            min="0"
            max="20"
            value={maxUser}
            onChange={(e) => { setMaxUser(e.target.value); setSaved(false); }}
            disabled={!isAdmin}
            aria-describedby="del-max-user-hint"
          />
          <p className="field-hint" id="del-max-user-hint">Range: 0–20</p>
        </div>

        {/* Idle stop minutes */}
        <div className="field" style={{ maxWidth: 280 }}>
          <label htmlFor="del-idle">Idle stop for finished children (minutes)</label>
          <input
            id="del-idle"
            type="number"
            min="1"
            max="240"
            value={idleStop}
            onChange={(e) => { setIdleStop(e.target.value); setSaved(false); }}
            disabled={!isAdmin}
            aria-describedby="del-idle-hint"
          />
          <p className="field-hint" id="del-idle-hint">
            Finished child sessions are cleaned up after this many minutes. Range: 1–240.
          </p>
        </div>

        {/* Allow nested */}
        <div>
          <label className="choice" style={{ cursor: isAdmin ? 'pointer' : 'default' }}>
            <input
              type="checkbox"
              checked={allowNested}
              onChange={(e) => isAdmin && setAllowNested(e.target.checked)}
              disabled={!isAdmin}
            />
            <span>
              <strong>Allow nested delegation</strong>
              <span className="muted" style={{ marginLeft: 6 }}>
                Child sessions may themselves delegate to grandchild sessions.
              </span>
            </span>
          </label>
        </div>

        {/* Subagent nudge threshold */}
        <div className="field" style={{ maxWidth: 280 }}>
          <label htmlFor="del-nudge">Subagent nudge threshold (0 = off)</label>
          <input
            id="del-nudge"
            type="number"
            min="0"
            max="20"
            value={nudge}
            onChange={(e) => { setNudge(e.target.value); setSaved(false); }}
            disabled={!isAdmin}
            aria-describedby="del-nudge-hint"
          />
          <p className="field-hint" id="del-nudge-hint">
            When this many in-process subagents are running simultaneously, the lead agent
            is reminded once per turn to delegate heavy work. 0 = disabled. Range: 0–20.
          </p>
        </div>

        {saveError && <p className="error-note" role="alert">{saveError}</p>}
        {saved && (
          <p role="status" style={{ color: 'var(--ok)', fontSize: '0.84rem' }}>
            ✓ Delegation settings saved.
          </p>
        )}

        {isAdmin ? (
          <button type="submit" className="btn btn-primary" disabled={saving} style={{ width: 'fit-content' }}>
            {saving ? 'Saving…' : 'Save delegation settings'}
          </button>
        ) : (
          <p className="muted" style={{ fontSize: '0.84rem' }}>
            Admin access is required to change delegation settings.
          </p>
        )}
      </form>
    </section>
  );
}
