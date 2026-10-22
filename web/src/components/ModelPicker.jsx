import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useAsync.js';

const TIERS = [
  { value: 'haiku', label: 'Haiku (fast, cheapest)' },
  { value: 'sonnet', label: 'Sonnet (balanced)' },
  { value: 'opus', label: 'Opus (deepest)' },
];
const OTHER = '__other__';

/**
 * Choose a model: one of the three tiers (which Settings maps to model IDs), any model the provider offers, or a
 * model ID typed in. `value` is a tier name or a full model ID.
 *
 * When `projectId` is provided the model list is fetched from /api/models?projectId=... so the
 * list reflects the project's own provider rather than the Settings provider.
 *
 * A "Reload list" button is always shown: next to "Available models" when the list loaded
 * successfully, or in the error banner when it did not. It adds ?refresh=1 so the server
 * bypasses its 5-minute cache. The button is keyboard-accessible and announces its result
 * to screen readers via an aria-live region.
 */
export function ModelPicker({ id, value, onChange, className = 'input', projectId, engine }) {
  // Bump to force a cache-busting reload (?refresh=1). loadGen > 0 means the user
  // has pressed "Reload list" at least once.
  const [loadGen, setLoadGen] = useState(0);

  // Build the URL: prefer projectId-scoped endpoint when available.
  // With an engine picked for the run, list what that engine offers.
  const baseUrl = projectId
    ? `/api/models?projectId=${encodeURIComponent(projectId)}${engine ? `&engine=${encodeURIComponent(engine)}` : ''}`
    : '/api/models';
  const list = useLoad(
    () => api.get(loadGen > 0 ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}refresh=1` : baseUrl),
    [loadGen, projectId, engine],
  );

  const [reloading, setReloading] = useState(false);
  const [reloadAnnouncement, setReloadAnnouncement] = useState('');

  const models = list.data?.models || [];
  const currentError = list.data?.error || '';

  const isTier = TIERS.some((t) => t.value === value);
  const listed = models.some((m) => m.id === value);
  const known = isTier || listed;
  // Only the person choosing "Another model ID…" turns the text box on. (Deciding it from `value` on the first
  // render, before the model list had loaded, stuck a saved model such as claude-opus-5.5 on "Another model ID…"
  // with an empty box.)
  const [custom, setCustom] = useState(false);
  // A saved ID the list does not offer (or a list that failed to load) is shown in the box, so it is never hidden.
  const showText = custom || (!known && Boolean(value) && !list.loading);

  async function handleReload() {
    setReloading(true);
    setReloadAnnouncement('');
    try {
      // Bump loadGen: useLoad will re-fetch with ?refresh=1
      setLoadGen((g) => g + 1);
      // Also do a direct call to capture the result for the announcement text,
      // since we cannot easily await the useLoad re-fetch.
      const refreshUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}refresh=1`;
      const fresh = await api.get(refreshUrl);
      const count = (fresh.models || []).length;
      setReloadAnnouncement(
        fresh.error
          ? 'Could not load models. Try again after signing in.'
          : count === 0
          ? 'Reloaded — no models returned.'
          : `Reloaded — ${count} model${count !== 1 ? 's' : ''} loaded.`,
      );
    } catch {
      setReloadAnnouncement('Reload failed. Check your connection and try again.');
    } finally {
      setReloading(false);
    }
  }

  const reloadButton = (
    <button
      type="button"
      className="btn btn-sm"
      onClick={handleReload}
      disabled={reloading || list.loading}
      aria-busy={reloading || list.loading}
      aria-label={reloading ? 'Reloading model list…' : 'Reload model list'}
    >
      {reloading ? 'Reloading…' : 'Reload list'}
    </button>
  );

  return (
    <div className="stack" style={{ gap: 6 }}>
      {/* Live region — announces reload result to screen readers without moving focus */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="visually-hidden"
      >
        {reloadAnnouncement}
      </span>

      <select
        id={id}
        className={className}
        value={showText ? OTHER : value}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setCustom(true);
          } else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        {/* While the list loads, keep a saved exact ID selectable so the select does not fall back to the first tier. */}
        {!known && value && list.loading ? <option value={value}>{value}</option> : null}
        <optgroup label="Standard">
          {TIERS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </optgroup>
        {models.length ? (
          <optgroup label="Available models">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}
              </option>
            ))}
          </optgroup>
        ) : null}
        <option value={OTHER}>Another model ID…</option>
      </select>

      {showText ? (
        <input
          className="input mono"
          aria-label="Model ID"
          value={known ? '' : value}
          placeholder={engine === 'kiro' ? 'e.g. claude-sonnet-4.5' : 'e.g. us.anthropic.claude-sonnet-4-5-20250929-v1:0'}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      ) : null}

      {/* Error state: show error message + Reload list button */}
      {currentError ? (
        <div className="stack" style={{ gap: 4 }}>
          <p className="muted small" role="alert">
            {currentError}
            {showText ? ' Paste a model ID above.' : ''}
          </p>
          <div>{reloadButton}</div>
        </div>
      ) : (
        /* No error: show Reload list button (and inline announcement) always */
        !list.loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {reloadButton}
            {reloadAnnouncement ? (
              <span className="muted small" aria-hidden="true">
                {reloadAnnouncement}
              </span>
            ) : null}
          </div>
        ) : null
      )}
    </div>
  );
}
