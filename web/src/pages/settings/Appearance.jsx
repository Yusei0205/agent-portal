/**
 * Settings › Appearance — template management + inline editor.
 *
 * Backend contract:
 *   GET    /api/admin/themes                → { themes: [{id,name,builtIn,active,overridden,updatedAt}] }
 *   GET    /api/admin/themes/:id            → { template, builtin, overridden, defaults? }
 *   POST   /api/admin/themes/:id/activate   → { ok, activeId }
 *   POST   /api/admin/themes/:id/duplicate  → { ok, id, theme }
 *   PUT    /api/admin/themes/:id            → { ok, theme }  (works for built-ins — stores override)
 *   DELETE /api/admin/themes/:id/override   → { ok }          (resets built-in to shipped default)
 *   GET    /api/admin/themes/:id/export     → template JSON download
 *   POST   /api/admin/themes/import         → { ok, id, theme }
 *   POST   /api/admin/themes/validate       → { ok, errors: [{path,message}] }
 *   POST   /api/admin/themes/generate       → { ok, theme }  (AI-generated theme)
 *   DELETE /api/admin/themes/:id            → { ok }
 *   GET    /api/admin/themes/fonts          → { fonts: [{name,bundled,stack}] }
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import {
  getTemplates,
  getTemplate,
  getActiveTemplateId,
  registerTemplate,
  unregisterTemplate,
  normaliseTemplate,
  setActiveTemplate,
  applyTemplate,
} from '../../lib/theme.js';

// IDs of templates that are always built-in (shipped with the app).
// Used to distinguish real built-ins from server-orphaned registry entries.
const BUILTIN_IDS = new Set([
  'aethrix-night', 'classic-teal', 'clovi', 'nebula', 'aurora-glass',
  'cyber-hud', 'twilight', 'terminal', 'kiro-ide',
]);
import { useToast, ToastShelf } from '../../components/Toast.jsx';
import { useConfirm, ConfirmDialog } from '../../components/ConfirmDialog.jsx';

// ── WCAG contrast helper ─────────────────────────────────────────────────────

function parseColor(c) {
  if (!c) return null;
  c = c.trim();
  if (c.startsWith('#')) {
    const hex = c.slice(1);
    if (hex.length === 3) {
      const [r, g, b] = hex.split('').map(x => parseInt(x + x, 16) / 255);
      return [r, g, b];
    }
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255,
      ];
    }
  }
  const m = c.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
  return null;
}

function srgbToLinear(v) {
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(c1, c2) {
  try {
    const p1 = parseColor(c1);
    const p2 = parseColor(c2);
    if (!p1 || !p2) return 21;
    const l1 = relativeLuminance(p1);
    const l2 = relativeLuminance(p2);
    const lighter = Math.max(l1, l2);
    const darker  = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  } catch {
    return 21;
  }
}

function ContrastBadge({ fg, bg, label }) {
  const ratio = contrastRatio(fg, bg);
  const pass  = ratio >= 4.5;
  return (
    <span
      className={`badge ${pass ? 'badge-ok' : 'badge-warn'}`}
      title={`${label}: ${ratio.toFixed(1)}:1`}
    >
      {ratio.toFixed(1)}:1 {pass ? '✓' : '⚠'}
    </span>
  );
}

// ── Debounce ─────────────────────────────────────────────────────────────────

function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

// ── Template preview pane ────────────────────────────────────────────────────

const TOKEN_GROUPS = {
  Surfaces: ['canvas', 'rail', 'panel', 'panel-2', 'raised'],
  Text:     ['ink', 'ink-2', 'ink-3', 'code-bg'],
  Accent:   ['accent', 'accent-2', 'accent-3', 'accent-ink', 'link', 'accent-wash'],
  Status:   ['ok', 'ok-wash', 'warn', 'warn-wash', 'danger', 'danger-wash', 'info', 'info-wash'],
  Effects:  ['focus', 'glow', 'line', 'line-2', 'shadow'],
};

function PreviewPane({ draft }) {
  const darkVars   = draft.modes?.dark   || {};
  const lightVars  = draft.modes?.light  || {};
  const radius     = draft.radius || {};
  const fonts      = draft.fonts  || {};

  const sharedStyle = {
    '--radius-sm': radius.sm || '4px',
    '--radius-md': radius.md || '8px',
    '--radius-lg': radius.lg || '10px',
    '--radius-xl': radius.lg || '10px',
    '--font-display': fonts.display || 'inherit',
    '--font-body':    fonts.body    || 'inherit',
    '--font':         fonts.body    || 'inherit',
    '--mono':         fonts.mono    || 'inherit',
  };

  const buildModeStyle = (tokens) => {
    const style = { ...sharedStyle };
    for (const [k, v] of Object.entries(tokens)) {
      style[`--${k}`] = v;
    }
    return style;
  };

  const modes = Object.keys(draft.modes || {});
  const pairs = modes.length >= 2
    ? [['Light', buildModeStyle(lightVars), 'light'], ['Dark', buildModeStyle(darkVars), 'dark']]
    : [[modes[0] === 'dark' ? 'Dark' : 'Light', buildModeStyle(draft.modes?.[modes[0]] || {}), modes[0]]];

  return (
    <div className="editor-preview-wrap">
      <div className="editor-preview-label">Live preview (scoped — app unchanged until Save)</div>
      <div className="editor-preview-row">
        {pairs.map(([label, modeStyle, modeKey]) => (
          <div
            key={modeKey}
            className="editor-preview-pane"
            data-mode={modeKey}
            style={{
              ...modeStyle,
              background: modeStyle['--canvas'] || modeStyle['--panel'] || 'transparent',
              color: modeStyle['--ink'] || 'inherit',
              fontFamily: modeStyle['--font-body'] || 'inherit',
            }}
          >
            <div className="editor-preview-mode-label">{label}</div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <div className="rail-link is-active" style={{ flex: 1, pointerEvents: 'none', background: 'var(--panel)', boxShadow: 'inset 3px 0 0 var(--accent)', borderRadius: 'var(--radius)' }}>
                <span style={{ fontSize: '0.8rem' }}>Active nav item</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" style={{ pointerEvents: 'none', fontFamily: 'inherit', background: 'var(--accent)', color: 'var(--accent-ink)', borderColor: 'var(--accent)' }}>Primary</button>
              <button className="btn" style={{ pointerEvents: 'none', fontFamily: 'inherit', background: 'var(--panel)', color: 'var(--ink)', borderColor: 'var(--line)' }}>Default</button>
              <button className="btn" style={{ pointerEvents: 'none', fontFamily: 'inherit', background: 'var(--danger)', color: 'var(--danger-ink, #fff)', borderColor: 'var(--danger)' }}>Danger</button>
            </div>

            <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)', padding: '10px 12px', marginBottom: 10 }}>
              <div style={{ fontWeight: 640, fontSize: '0.9rem', color: 'var(--ink)' }}>Card title</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--ink-3)', marginTop: 3 }}>Supporting text on panel background</div>
              <div style={{ marginTop: 6 }}>
                <a href="#" onClick={(e) => e.preventDefault()} style={{ color: 'var(--link)', fontSize: '0.8rem' }}>Link colour</a>
              </div>
            </div>

            <div className="kpi-card" style={{ pointerEvents: 'none', marginBottom: 10, background: 'var(--panel)', border: '1px solid var(--line)' }}>
              <div className="kpi-label">METRIC</div>
              <div className="kpi-value">42</div>
            </div>

            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
              <span className="pill pill-completed">Completed</span>
              <span className="pill pill-running">Running</span>
              <span className="pill pill-failed">Failed</span>
              <span className="pill pill-pending">Pending</span>
            </div>

            <div style={{ marginBottom: 10 }}>
              <input
                type="text"
                defaultValue="Sample input"
                style={{ width: '100%', pointerEvents: 'none', font: 'inherit', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', color: 'var(--ink)', padding: '5px 9px' }}
              />
            </div>

            <table className="data-table" style={{ marginBottom: 10, background: 'var(--panel)' }}>
              <thead>
                <tr><th>Name</th><th>Status</th></tr>
              </thead>
              <tbody>
                <tr><td>Row one</td><td><span className="pill pill-completed">Done</span></td></tr>
              </tbody>
            </table>

            <div className="stepper" style={{ pointerEvents: 'none' }}>
              {['Plan', 'Build', 'Deploy'].map((s, i) => (
                <div key={s} className={`stepper-step ${i === 0 ? 'stepper-done' : i === 1 ? 'stepper-current' : ''}`}>
                  <div className="stepper-dot" />
                  <div className="stepper-label">{s}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Colour field ─────────────────────────────────────────────────────────────

/**
 * @param {{
 *   token:        string,
 *   value:        string,
 *   onChange:     (token: string, value: string) => void,
 *   error?:       string,
 *   defaultValue?: string,   // the shipped/default value for diff highlight
 *   onRevert?:    (token: string, defaultValue: string) => void,
 * }} props
 */
function ColourField({ token, value, onChange, error, defaultValue, onRevert }) {
  const isGradientOrShadow = value && (
    value.includes('linear-gradient') || value.includes('box-shadow') ||
    value.includes('0 ') || value === 'none'
  );
  const isChanged = defaultValue !== undefined && defaultValue !== null && value !== defaultValue;

  return (
    <div className="editor-colour-field" data-has-error={!!error}>
      <label className="editor-token-label" title={`--${token}`}>
        {token}
        {isChanged && (
          <span
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--accent)',
              marginLeft: 5,
              verticalAlign: 'middle',
            }}
            title={`Changed from default: ${defaultValue}`}
            aria-label="Modified"
          />
        )}
      </label>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        {!isGradientOrShadow && (
          <input
            type="color"
            value={value && value.startsWith('#') && (value.length === 4 || value.length === 7) ? value : '#888888'}
            onChange={(e) => onChange(token, e.target.value)}
            style={{ width: 32, height: 28, padding: 2, border: '1px solid var(--line)', borderRadius: 4, cursor: 'pointer' }}
            aria-label={`Colour picker for ${token}`}
          />
        )}
        <input
          type="text"
          value={value || ''}
          onChange={(e) => onChange(token, e.target.value)}
          className="editor-token-input"
          aria-label={`${token} value`}
          aria-invalid={!!error}
          aria-describedby={error ? `err-${token}` : undefined}
          placeholder="#000000 or rgba(…)"
          spellCheck={false}
        />
        {isChanged && onRevert && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onRevert(token, defaultValue)}
            title={`Revert to default: ${defaultValue}`}
            aria-label={`Revert ${token} to default value`}
            style={{ padding: '2px 6px', fontSize: '0.75rem', flexShrink: 0 }}
          >
            ↩
          </button>
        )}
      </div>
      {error && <span id={`err-${token}`} className="field-error" role="alert">{error}</span>}
    </div>
  );
}

// ── Template editor ──────────────────────────────────────────────────────────

/**
 * @param {{
 *   templateId: string,
 *   onSave:     (saved: object, andActivate: boolean) => void,
 *   onCancel:   () => void,
 * }} props
 */
function TemplateEditor({ templateId, onSave, onCancel }) {
  const [draft,             setDraft]             = useState(null);
  const [isBuiltIn,         setIsBuiltIn]         = useState(false);
  const [defaults,          setDefaults]          = useState(null); // shipped defaults for diff
  const [loading,           setLoading]           = useState(true);
  const [loadError,         setLoadError]         = useState(null);
  const [saveError,         setSaveError]         = useState(null);
  const [busy,              setBusy]              = useState(false);
  const [fonts,             setFonts]             = useState([]);
  const [validationErrors,  setValidationErrors]  = useState({});
  const [activeMode,        setActiveMode]        = useState('dark');
  const { toast, toasts, removeToast } = useToast();
  const debouncedDraft = useDebounce(draft, 800);

  // Load template + fonts list
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    Promise.all([
      api.get(`/api/admin/themes/${templateId}`).catch(() => getTemplate(templateId)),
      api.get('/api/admin/themes/fonts').catch(() => ({ fonts: [] })),
    ]).then(([resp, fontsData]) => {
      if (!mounted) return;
      // resp may be a full server response { template, builtin, overridden, defaults }
      // or just the template object (fallback from registry)
      const templateData = resp?.template || resp;
      const builtIn      = resp?.builtIn ?? resp?.builtin ?? false;
      const defs         = resp?.defaults ?? null;
      const fontsList    = fontsData.fonts || [];

      // Build a reverse map: CSS font stack → short font name.
      // The registry stores templates in browser format (full CSS stacks) after normaliseTemplate().
      // When a template comes from the registry (e.g. _isNew AI-generated), we need to convert
      // it back to server format so validate / PUT / POST receive what the server expects.
      const stackToName = {};
      for (const f of fontsList) {
        if (f.stack) stackToName[f.stack] = f.name;
      }

      /**
       * Convert a template to server format (short font names, numeric radius).
       * Safe to call on templates already in server format — no-op for those fields.
       */
      function toServerFmt(tmpl) {
        if (!tmpl) return tmpl;
        const out = { ...tmpl };
        if (tmpl.fonts) {
          out.fonts = {
            display: stackToName[tmpl.fonts.display] ?? tmpl.fonts.display,
            body:    stackToName[tmpl.fonts.body]    ?? tmpl.fonts.body,
            mono:    stackToName[tmpl.fonts.mono]    ?? tmpl.fonts.mono,
          };
        }
        if (tmpl.radius) {
          out.radius = {};
          for (const [k, v] of Object.entries(tmpl.radius)) {
            // Server format: numeric.  Browser format: "Npx" string.
            out.radius[k] = typeof v === 'string' ? (parseInt(v, 10) || 0) : v;
          }
        }
        return out;
      }

      // Store draft in server format so validate / save payloads need no conversion.
      setDraft(toServerFmt(templateData));
      setIsBuiltIn(builtIn);
      setDefaults(defs ? toServerFmt(defs) : null);
      setFonts(fontsList);
      setActiveMode(Object.keys(templateData.modes || {})[0] || 'dark');
      setLoading(false);
    }).catch((err) => {
      if (!mounted) return;
      setLoadError(err.message || 'Failed to load template');
      setLoading(false);
    });
    return () => { mounted = false; };
  }, [templateId]);

  // Live validation (debounced)
  // Strip the internal _isNew marker before posting — the server validator rejects unknown keys.
  useEffect(() => {
    if (!debouncedDraft) return;
    // eslint-disable-next-line no-unused-vars
    const { _isNew: _flag, ...validatePayload } = debouncedDraft;
    api.post('/api/admin/themes/validate', validatePayload)
      .then((res) => {
        if (res.errors?.length) {
          const map = {};
          for (const e of res.errors) map[e.path] = e.message;
          setValidationErrors(map);
        } else {
          setValidationErrors({});
        }
      })
      .catch(() => { /* server not ready — skip validation */ });
  }, [debouncedDraft]);

  const updateModeToken = (mode, token, value) => {
    setDraft((d) => ({
      ...d,
      modes: { ...d.modes, [mode]: { ...d.modes[mode], [token]: value } },
    }));
  };

  const revertModeToken = (mode, token, defaultValue) => {
    updateModeToken(mode, token, defaultValue);
  };

  const updateFont = (key, value) => {
    setDraft((d) => ({ ...d, fonts: { ...d.fonts, [key]: value } }));
  };

  const updateRadius = (key, value) => {
    // Store as a number (server format). The range input always yields a numeric string.
    const num = Math.max(0, Math.min(24, parseInt(value, 10) || 0));
    setDraft((d) => ({ ...d, radius: { ...d.radius, [key]: num } }));
  };

  const updateEffect = (key, value) => {
    setDraft((d) => ({ ...d, effects: { ...d.effects, [key]: value } }));
  };

  const updateBrand = (key, value) => {
    setDraft((d) => ({ ...d, brand: { ...d.brand, [key]: value } }));
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024) { toast('SVG must be ≤ 20 KB', 'error'); return; }
    const text = await file.text();
    if (!text.trim().startsWith('<svg')) { toast('File must be a valid SVG', 'error'); return; }
    updateBrand('logoSvg', text);
    e.target.value = '';
  };

  const handleSave = async (andActivate = false) => {
    if (!draft) return;
    setBusy(true);
    setSaveError(null);
    try {
      const isNew = draft._isNew;
      // Strip internal UI-only marker before sending — the server validator rejects unknown keys.
      // eslint-disable-next-line no-unused-vars
      const { _isNew: _uiFlag, ...serverPayload } = draft;
      let result;
      if (isNew) {
        result = await api.post('/api/admin/themes', serverPayload);
      } else {
        result = await api.put(`/api/admin/themes/${draft.id}`, serverPayload);
      }
      const saved      = result.theme || result;
      const normalised = normaliseTemplate(saved);
      registerTemplate(normalised);

      const wasActive = saved.id === getActiveTemplateId();

      if (andActivate) {
        await api.post(`/api/admin/themes/${saved.id}/activate`, {});
        // setActiveTemplate updates localStorage + applies + dispatches portal-theme-changed
        setActiveTemplate(saved.id);
        toast('Template saved and activated', 'ok');
      } else if (wasActive) {
        // Already active — re-apply so Rail/header pick up new brand immediately
        applyTemplate(getTemplate(saved.id));
        document.dispatchEvent(new CustomEvent('portal-theme-changed', { detail: { templateId: saved.id } }));
        toast('Template saved', 'ok');
      } else {
        toast('Template saved', 'ok');
      }
      onSave(saved, andActivate);
    } catch (err) {
      setSaveError(err.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="spinner-wrap"><div className="spinner" /></div>;
  }
  if (loadError) {
    return <div className="error-note" role="alert">{loadError}</div>;
  }
  if (!draft) return null;

  const modes = Object.keys(draft.modes || {});
  const modeTokens    = draft.modes?.[activeMode]    || {};
  const defaultTokens = defaults?.modes?.[activeMode] || {};

  const contrastPairs = [
    { fg: 'ink',       bg: 'panel',  label: 'ink on panel' },
    { fg: 'ink-2',     bg: 'panel',  label: 'ink-2 on panel' },
    { fg: 'accent-ink',bg: 'accent', label: 'accent-ink on accent' },
    { fg: 'link',      bg: 'panel',  label: 'link on panel' },
  ];

  return (
    <div className="editor-shell">
      <ToastShelf toasts={toasts} onRemove={removeToast} />

      {/* Built-in note banner */}
      {isBuiltIn && (
        <div
          role="note"
          style={{
            background: 'var(--info-wash)',
            border: '1px solid color-mix(in srgb, var(--info) 30%, transparent)',
            borderRadius: 'var(--radius)',
            padding: '8px 14px',
            fontSize: '0.84rem',
            color: 'var(--info)',
            marginBottom: 12,
          }}
        >
          You&apos;re editing a built-in theme. Your changes override the default; use
          <strong style={{ margin: '0 4px' }}>Reset to default</strong> on the theme card to undo.
          Tokens with a <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', verticalAlign: 'middle', margin: '0 3px' }} /> dot differ from the shipped default.
        </div>
      )}

      <div className="editor-main">
        {/* Left: settings panels */}
        <div className="editor-settings">
          <h3 style={{ marginBottom: 14 }}>Editing: {draft.name}</h3>

          {/* Brand */}
          <details className="editor-section" open>
            <summary className="editor-section-title">Brand</summary>
            <div className="editor-section-body">
              {isBuiltIn && (
                <div className="field" style={{ marginBottom: 10 }}>
                  <label htmlFor="brand-id">Theme ID</label>
                  <input
                    id="brand-id"
                    type="text"
                    value={draft.id || ''}
                    readOnly
                    disabled
                    style={{ opacity: 0.6, cursor: 'not-allowed' }}
                    aria-describedby="brand-id-note"
                  />
                  <span id="brand-id-note" style={{ fontSize: '0.78rem', color: 'var(--ink-3)', marginTop: 3 }}>
                    Built-in theme IDs cannot be changed.
                  </span>
                </div>
              )}
              <div className="field" style={{ marginBottom: 10 }}>
                <label htmlFor="brand-name">Product name</label>
                <input
                  id="brand-name"
                  type="text"
                  value={draft.brand?.productName || ''}
                  onChange={(e) => updateBrand('productName', e.target.value)}
                  maxLength={80}
                  aria-invalid={!!validationErrors['brand.productName']}
                />
                {validationErrors['brand.productName'] && (
                  <span className="field-error" role="alert">{validationErrors['brand.productName']}</span>
                )}
              </div>
              <div className="field" style={{ marginBottom: 10 }}>
                <label htmlFor="brand-tagline">Tagline</label>
                <input
                  id="brand-tagline"
                  type="text"
                  value={draft.brand?.tagline || ''}
                  onChange={(e) => updateBrand('tagline', e.target.value)}
                  maxLength={120}
                />
              </div>
              <div className="field" style={{ marginBottom: 10 }}>
                <label>Logo SVG (≤ 20 KB)</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => document.getElementById('logo-upload').click()}
                  >
                    Upload SVG…
                  </button>
                  <input
                    id="logo-upload"
                    type="file"
                    accept=".svg,image/svg+xml"
                    style={{ display: 'none' }}
                    onChange={handleLogoUpload}
                  />
                  {draft.brand?.logoSvg && (
                    <img
                      src={`data:image/svg+xml,${encodeURIComponent(draft.brand.logoSvg)}`}
                      width={32}
                      height={32}
                      alt="Logo preview"
                      style={{ border: '1px solid var(--line)', borderRadius: 4 }}
                    />
                  )}
                  {draft.brand?.logoSvg && (
                    <button type="button" className="btn btn-sm" onClick={() => updateBrand('logoSvg', null)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          </details>

          {/* Fonts */}
          <details className="editor-section" open>
            <summary className="editor-section-title">Fonts</summary>
            <div className="editor-section-body">
              {[
                { key: 'display', label: 'Display (headings)' },
                { key: 'body',    label: 'Body' },
                { key: 'mono',    label: 'Monospace' },
              ].map(({ key, label }) => (
                <div key={key} className="field" style={{ marginBottom: 10 }}>
                  <label htmlFor={`font-${key}`}>{label}</label>
                  {fonts.length > 0 ? (
                    <select
                      id={`font-${key}`}
                      value={draft.fonts?.[key] || ''}
                      onChange={(e) => updateFont(key, e.target.value)}
                    >
                      {/* If the draft's font value isn't in the server list (e.g. an old
                          template with an unrecognised name), render it as a disabled option
                          so the select doesn't show blank. The server will report it as an
                          error when the user actually tries to save. */}
                      {draft.fonts?.[key] && !fonts.some((f) => f.name === draft.fonts[key]) && (
                        <option value={draft.fonts[key]}>{draft.fonts[key]}</option>
                      )}
                      {fonts.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.name}{f.bundled ? ' (bundled)' : ' (system fallback)'}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`font-${key}`}
                      type="text"
                      value={draft.fonts?.[key] || ''}
                      onChange={(e) => updateFont(key, e.target.value)}
                      placeholder="CSS font-family stack"
                    />
                  )}
                  {validationErrors[`fonts.${key}`] && (
                    <span className="field-error" role="alert">{validationErrors[`fonts.${key}`]}</span>
                  )}
                </div>
              ))}
            </div>
          </details>

          {/* Radius */}
          <details className="editor-section" open>
            <summary className="editor-section-title">Radius</summary>
            <div className="editor-section-body">
              {[
                { key: 'sm', label: 'Small' },
                { key: 'md', label: 'Medium' },
                { key: 'lg', label: 'Large' },
              ].map(({ key, label }) => {
                const raw = draft.radius?.[key] || '0px';
                const num = parseInt(raw, 10) || 0;
                return (
                  <div key={key} style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--ink-2)', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{label}</span>
                      <span style={{ fontFamily: 'var(--mono)', color: 'var(--ink-3)' }}>{num}px</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={24}
                      value={num}
                      onChange={(e) => updateRadius(key, e.target.value)}
                      style={{ width: '100%' }}
                      aria-label={`${label} radius`}
                      aria-valuetext={`${num}px`}
                    />
                    {validationErrors[`radius.${key}`] && (
                      <span className="field-error" role="alert">{validationErrors[`radius.${key}`]}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </details>

          {/* Effects */}
          <details className="editor-section" open>
            <summary className="editor-section-title">Effects</summary>
            <div className="editor-section-body">
              {[
                { key: 'glow',            label: 'Glow on cards and elements' },
                { key: 'gridBackground',  label: 'Dot grid background' },
                { key: 'gradientAccents', label: 'Gradient accent buttons' },
              ].map(({ key, label }) => (
                <label key={key} className="choice" style={{ marginBottom: 6 }}>
                  <input
                    type="checkbox"
                    checked={draft.effects?.[key] || false}
                    onChange={(e) => updateEffect(key, e.target.checked)}
                  />
                  <span style={{ fontSize: '0.84rem' }}>{label}</span>
                </label>
              ))}
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="motion-select">Motion</label>
                <select
                  id="motion-select"
                  value={draft.effects?.motion || 'full'}
                  onChange={(e) => updateEffect('motion', e.target.value)}
                >
                  <option value="full">Full</option>
                  <option value="reduced">Reduced</option>
                  <option value="none">None</option>
                </select>
              </div>
            </div>
          </details>

          {/* Colour tokens — mode tabs */}
          {modes.length > 1 && (
            <div style={{ marginBottom: 10 }}>
              <div className="tab-bar" style={{ marginBottom: 0 }}>
                {modes.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`tab-btn${activeMode === m ? ' is-active' : ''}`}
                    onClick={() => setActiveMode(m)}
                  >
                    {m.charAt(0).toUpperCase() + m.slice(1)} mode
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Contrast badges */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {contrastPairs.map(({ fg, bg, label }) => (
              <ContrastBadge
                key={label}
                fg={modeTokens[fg]}
                bg={modeTokens[bg]}
                label={label}
              />
            ))}
          </div>

          {/* Token colour inputs per group */}
          {Object.entries(TOKEN_GROUPS).map(([groupName, tokens]) => (
            <details key={groupName} className="editor-section">
              <summary className="editor-section-title">{groupName}</summary>
              <div className="editor-section-body">
                {tokens.map((token) => (
                  <ColourField
                    key={token}
                    token={token}
                    value={modeTokens[token] || ''}
                    onChange={(t, v) => updateModeToken(activeMode, t, v)}
                    error={validationErrors[`modes.${activeMode}.${token}`]}
                    defaultValue={isBuiltIn && defaults ? defaultTokens[token] : undefined}
                    onRevert={isBuiltIn && defaults ? (t, dv) => revertModeToken(activeMode, t, dv) : undefined}
                  />
                ))}
              </div>
            </details>
          ))}

          {saveError && (
            <div className="error-note" role="alert" style={{ marginTop: 12 }}>{saveError}</div>
          )}

          <div className="modal-footer" style={{ padding: '16px 0 0', borderTop: '1px solid var(--line)', justifyContent: 'flex-start', gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => handleSave(false)}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => handleSave(true)}
              style={{ background: 'var(--ok)', borderColor: 'var(--ok)' }}
            >
              {busy ? 'Saving…' : 'Save and activate'}
            </button>
            <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          </div>
        </div>

        {/* Right: live preview */}
        <div className="editor-preview-container">
          {/* Normalise to browser format (CSS font stacks, "Npx" radius) for the preview pane */}
          <PreviewPane draft={normaliseTemplate(draft)} />
        </div>
      </div>
    </div>
  );
}

// ── Template preview card ────────────────────────────────────────────────────

/**
 * @param {{
 *   tmpl:        object,
 *   meta:        object,
 *   isActive:    boolean,
 *   isAdmin:     boolean,
 *   onActivate?: () => void,
 *   onDuplicate?: () => void,
 *   onExport:    () => void,
 *   onDelete?:   () => void,
 *   onEdit?:     () => void,
 *   onReset?:    () => void,
 * }} props
 */
function TemplateCard({ tmpl, meta, isActive, isAdmin, onActivate, onDuplicate, onExport, onDelete, onEdit, onReset }) {
  const dark  = tmpl?.modes?.dark  || {};
  const light = tmpl?.modes?.light || {};

  const swatches = [
    dark.canvas  || light.canvas  || '#12161e',
    dark.accent  || light.accent  || '#3fb3b0',
    dark['accent-2'] || light['accent-2'] || '#22d3ee',
    dark.ok      || light.ok      || '#22c55e',
    dark.danger  || light.danger  || '#ef4444',
  ];

  return (
    <div
      className={`template-card${isActive ? ' template-card-active' : ''}`}
      role="article"
      aria-label={`${tmpl.name} template${isActive ? ' (active)' : ''}`}
    >
      <div className="template-swatches" aria-hidden="true">
        {swatches.map((c, i) => (
          <span key={i} className="template-swatch" style={{ background: c }} />
        ))}
      </div>
      <div className="template-card-body">
        <div className="template-card-header">
          <span className="template-name">{tmpl.name}</span>
          {isActive && <span className="badge badge-ok">Active</span>}
          {meta?.builtIn && <span className="badge badge-neutral">Built-in</span>}
          {meta?.overridden && <span className="badge badge-warn">Modified</span>}
        </div>
        {tmpl.description && (
          <p className="template-desc muted small">{tmpl.description}</p>
        )}
        {tmpl.fonts?.display && (
          <p className="template-font muted small" style={{ fontFamily: tmpl.fonts.display }}>
            Aa — {tmpl.fonts.display.split(',')[0].replace(/'/g, '')}
          </p>
        )}
      </div>
      <div className="template-actions">
        {!isActive && isAdmin && (
          <button type="button" className="btn btn-primary btn-sm" onClick={onActivate}>
            Activate
          </button>
        )}
        {isAdmin && (
          <button type="button" className="btn btn-sm" onClick={onDuplicate}>
            Duplicate
          </button>
        )}
        {/* Edit: available for both custom and built-in themes */}
        {isAdmin && onEdit && (
          <button type="button" className="btn btn-sm" data-testid={`edit-${tmpl.id}`} onClick={onEdit}>
            Edit
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={onExport}>
          Export
        </button>
        {/* Reset to default: only for overridden built-ins */}
        {isAdmin && meta?.builtIn && meta?.overridden && onReset && (
          <button type="button" className="btn btn-sm btn-danger" onClick={onReset}>
            Reset to default
          </button>
        )}
        {/* Delete: only for custom (non built-in) themes that are not active */}
        {isAdmin && !meta?.builtIn && !isActive && (
          <button type="button" className="btn btn-sm btn-danger" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ── Import button ────────────────────────────────────────────────────────────

function ImportButton({ onImported, toast }) {
  const ref = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      try {
        const result = await api.post('/api/admin/themes/import', data);
        const imported = result.theme || result;
        registerTemplate(imported);
        onImported(imported);
        toast(`Imported "${imported.name}"`, 'ok');
      } catch {
        if (data.id) {
          registerTemplate(data);
          onImported(data);
          toast(`Imported "${data.name}" (local only)`, 'info');
        }
      }
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'error');
    }
    e.target.value = '';
  };

  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={handleFile}
        aria-label="Import template JSON"
      />
      <button type="button" className="btn btn-sm" onClick={() => ref.current?.click()}>
        Import…
      </button>
    </>
  );
}

// ── Generate Theme Modal ─────────────────────────────────────────────────────

/**
 * Modal dialog for AI-assisted theme generation.
 * Accepts a text description and optional reference images.
 *
 * @param {{
 *   onGenerated: (theme: object) => void,
 *   onClose:     () => void,
 * }} props
 */
function GenerateThemeModal({ onGenerated, onClose }) {
  const [description, setDescription] = useState('');
  const [images,      setImages]      = useState([]); // [{ name, dataUrl }]
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState(null);
  const [dragOver,    setDragOver]    = useState(false);
  const dropRef                       = useRef(null);

  // Accept image files from file input or drop
  const addImageFiles = useCallback(async (files) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
    const filtered = Array.from(files).filter(f => allowed.includes(f.type)).slice(0, 4);
    const reads = await Promise.all(
      filtered.map(f =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve({ name: f.name, dataUrl: ev.target.result });
          reader.readAsDataURL(f);
        }),
      ),
    );
    setImages(prev => {
      const combined = [...prev, ...reads];
      return combined.slice(0, 4); // max 4 images
    });
  }, []);

  const handleFileInput = (e) => {
    if (e.target.files?.length) addImageFiles(e.target.files);
    e.target.value = '';
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) addImageFiles(e.dataTransfer.files);
  };

  const removeImage = (index) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  const handleGenerate = async (e) => {
    e.preventDefault();
    if (!description.trim()) { setError('Please describe the theme you want.'); return; }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        description: description.trim(),
        referenceImages: images.map(img => ({ name: img.name, dataUrl: img.dataUrl })),
      };
      const result = await api.post('/api/admin/themes/generate', payload);
      const generated = result.theme || result;
      registerTemplate(normaliseTemplate({ ...generated, _isNew: true }));
      onGenerated(generated, result.warnings || []);
    } catch (err) {
      setError(err.message || 'Generation failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="generate-modal-title"
        style={{ maxWidth: 520, width: '100%' }}
      >
        <div className="modal-header">
          <h2 id="generate-modal-title" style={{ fontSize: '1rem', fontWeight: 700 }}>
            Generate theme with AI
          </h2>
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleGenerate} noValidate>
          <div className="modal-body" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="field">
              <label htmlFor="gen-description" style={{ fontWeight: 600, fontSize: '0.875rem' }}>
                Describe your theme
              </label>
              <textarea
                id="gen-description"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Dark cyberpunk theme with neon green accents, monospace fonts, and subtle grid background. Inspired by retro terminal aesthetics."
                style={{ resize: 'vertical', width: '100%', fontFamily: 'inherit' }}
                maxLength={1000}
                required
                aria-required="true"
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--ink-3)', marginTop: 2 }}>
                {description.length}/1000 — be descriptive: mention colours, mood, fonts, and effects.
              </span>
            </div>

            {/* Drop zone for reference images */}
            <div className="field">
              <label style={{ fontWeight: 600, fontSize: '0.875rem', display: 'block', marginBottom: 6 }}>
                Reference images <span style={{ fontWeight: 400, color: 'var(--ink-3)' }}>(optional, up to 4)</span>
              </label>
              <div
                ref={dropRef}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => document.getElementById('gen-image-input').click()}
                role="button"
                tabIndex={0}
                aria-label="Drop or click to add reference images"
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('gen-image-input').click(); } }}
                style={{
                  border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--line)'}`,
                  borderRadius: 'var(--radius-md)',
                  padding: '20px 16px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: dragOver ? 'var(--accent-wash)' : 'var(--panel)',
                  transition: 'border-color 0.15s, background 0.15s',
                  color: 'var(--ink-3)',
                  fontSize: '0.84rem',
                }}
              >
                {images.length === 0 ? (
                  <>Drag &amp; drop images here, or click to browse<br /><span style={{ fontSize: '0.75rem' }}>PNG, JPG, WebP, GIF, SVG · up to 4 files</span></>
                ) : (
                  <span style={{ color: 'var(--ink-2)' }}>Add more images ({images.length}/4)</span>
                )}
              </div>
              <input
                id="gen-image-input"
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={handleFileInput}
                aria-label="Upload reference images"
              />

              {images.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  {images.map((img, i) => (
                    <div
                      key={i}
                      style={{ position: 'relative', display: 'inline-block' }}
                    >
                      <img
                        src={img.dataUrl}
                        alt={img.name}
                        title={img.name}
                        style={{
                          width: 72,
                          height: 72,
                          objectFit: 'cover',
                          borderRadius: 'var(--radius)',
                          border: '1px solid var(--line)',
                          display: 'block',
                        }}
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${img.name}`}
                        onClick={(e) => { e.stopPropagation(); removeImage(i); }}
                        style={{
                          position: 'absolute',
                          top: -6,
                          right: -6,
                          width: 18,
                          height: 18,
                          borderRadius: '50%',
                          background: 'var(--danger)',
                          color: '#fff',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: 10,
                          lineHeight: '18px',
                          textAlign: 'center',
                          padding: 0,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <div className="error-note" role="alert">{error}</div>
            )}

            {busy && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--ink-2)', fontSize: '0.875rem' }}>
                <div className="spinner" style={{ width: 18, height: 18 }} />
                Generating theme… this may take a moment.
              </div>
            )}
          </div>

          <div className="modal-footer" style={{ padding: '12px 20px', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !description.trim()}
            >
              {busy ? 'Generating…' : 'Generate theme'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main Appearance component ────────────────────────────────────────────────

export default function AppearanceTab({ isAdmin }) {
  const [serverThemes,  setServerThemes]  = useState(null);
  const [serverError,   setServerError]   = useState(null);
  const [busy,          setBusy]          = useState('');
  const [localActive,   setLocalActive]   = useState(getActiveTemplateId);
  const [editingId,     setEditingId]     = useState(null); // id of template being edited
  const [generateOpen,  setGenerateOpen]  = useState(false);

  const { toast, toasts, removeToast }   = useToast();
  const { confirmState, requestConfirm } = useConfirm();

  // Load server theme list
  const loadServerThemes = useCallback(async () => {
    try {
      const data = await api.get('/api/admin/themes');
      setServerThemes(data.themes || []);
      setServerError(null);
    } catch (err) {
      if (err.message?.includes('404') || err.status === 404) {
        setServerThemes([]);
      } else {
        setServerError(err.message || 'Could not load themes from server');
      }
    }
  }, []);

  useEffect(() => { loadServerThemes(); }, [loadServerThemes]);

  // Merge registry + server meta.
  // Rules:
  //  1. Never show unsaved _isNew drafts in the grid (they open directly in the editor).
  //  2. When the server list has loaded (non-null), it is authoritative: only show
  //     templates that the server knows about OR that are real built-ins.
  //     This prevents a just-deleted custom theme from lingering in the grid.
  //  3. Built-in badge is only set when the server explicitly says builtIn=true,
  //     or (fallback while server list is loading) when the ID is in BUILTIN_IDS.
  const allTemplates = (() => {
    const local  = getTemplates();
    const server = serverThemes ?? [];
    return local
      .filter((t) => {
        if (t._isNew) return false; // never show unsaved drafts
        if (serverThemes !== null) {
          // Server list is loaded — only show what the server knows about
          return server.some((m) => m.id === t.id) || BUILTIN_IDS.has(t.id);
        }
        return true; // still loading — show everything as fallback
      })
      .map((t) => {
        const meta    = server.find((m) => m.id === t.id);
        const builtIn = meta ? meta.builtIn : BUILTIN_IDS.has(t.id);
        return { tmpl: t, meta: meta ?? { id: t.id, name: t.name, builtIn } };
      });
  })();

  // ── Activate ───────────────────────────────────────────────────────────
  const activate = async (id) => {
    setBusy(id);
    try {
      await api.post(`/api/admin/themes/${id}/activate`, {});
      // Fetch full template so the local registry has the latest brand/override
      try {
        const resp = await api.get(`/api/admin/themes/${id}`);
        const templateData = resp?.template || resp;
        registerTemplate(normaliseTemplate(templateData));
      } catch { /* fallback to cached local version */ }
      setLocalActive(id);
      setActiveTemplate(id);
      toast(`"${getTemplate(id)?.name || id}" is now active`, 'ok');
      await loadServerThemes();
    } catch (err) {
      toast(`Activation failed: ${err.message || 'server error'}`, 'error');
    } finally {
      setBusy('');
    }
  };

  // ── Duplicate ──────────────────────────────────────────────────────────
  const duplicate = async (id) => {
    setBusy(`dup-${id}`);
    try {
      const result = await api.post(`/api/admin/themes/${id}/duplicate`, {});
      const duped  = result.theme || result;
      registerTemplate(duped);
      await loadServerThemes();
      toast(`Duplicated as "${duped.name}"`, 'ok');
    } catch (err) {
      toast(`Duplicate failed: ${err.message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  // ── Export ─────────────────────────────────────────────────────────────
  const exportTemplate = (id) => {
    const tmpl = getTemplate(id);
    if (!tmpl) return;
    const json = JSON.stringify(tmpl, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Delete ─────────────────────────────────────────────────────────────
  const deleteTemplate = async (id) => {
    const name = getTemplate(id)?.name || id;
    const yes  = await requestConfirm(
      `Delete template "${name}"? This cannot be undone.`,
      'Delete',
      'danger',
    );
    if (!yes) return;
    setBusy(`del-${id}`);
    try {
      await api.delete(`/api/admin/themes/${id}`);
      // Remove from local registry immediately so the grid updates at once.
      // Don't remove built-ins — they are always re-registered at startup.
      if (!BUILTIN_IDS.has(id)) {
        unregisterTemplate(id);
      }
      await loadServerThemes();
      toast(`Deleted "${name}"`, 'ok');
    } catch (err) {
      toast(`Delete failed: ${err.message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  // ── Reset built-in to default ──────────────────────────────────────────
  const resetToDefault = async (id) => {
    const name = getTemplate(id)?.name || id;
    const yes  = await requestConfirm(
      `Reset "${name}" to its built-in defaults? Your customizations will be lost.`,
      'Reset to default',
      'danger',
    );
    if (!yes) return;
    setBusy(`reset-${id}`);
    try {
      await api.delete(`/api/admin/themes/${id}/override`);
      // Fetch the reset template and refresh registry
      try {
        const resp = await api.get(`/api/admin/themes/${id}`);
        const templateData = resp?.template || resp;
        registerTemplate(normaliseTemplate(templateData));
      } catch { /* ignore fetch error — registry may be stale until reload */ }
      await loadServerThemes();
      // Re-apply immediately if this is the active theme
      if (id === getActiveTemplateId()) {
        applyTemplate(getTemplate(id));
        document.dispatchEvent(new CustomEvent('portal-theme-changed', { detail: { templateId: id } }));
      }
      toast(`"${name}" reset to defaults`, 'ok');
    } catch (err) {
      if (err.status === 404 || err.message?.includes('404')) {
        toast(`"${name}" has no custom overrides to reset.`, 'info');
      } else {
        toast(`Reset failed: ${err.message}`, 'error');
      }
    } finally {
      setBusy('');
    }
  };

  // ── Edit (built-ins edit directly; custom themes also edit directly) ────
  const editTheme = (id) => {
    setEditingId(id);
  };

  const handleImported = () => {
    loadServerThemes();
  };

  const handleEditorSave = (saved, andActivate) => {
    setEditingId(null);
    loadServerThemes();
    if (andActivate) setLocalActive(saved.id);
  };

  // ── AI Generate ────────────────────────────────────────────────────────
  const handleGenerated = (theme, warnings = []) => {
    setGenerateOpen(false);
    // Register as a new unsaved draft (_isNew: true) so the editor's Save → POST creates it
    const draft = { ...theme, _isNew: true };
    registerTemplate(normaliseTemplate(draft));
    setEditingId(theme.id);
    if (warnings.length > 0) {
      warnings.forEach((w) => toast(w, 'info'));
    }
  };

  // ── Editor view ─────────────────────────────────────────────────────────
  if (editingId) {
    return (
      <>
        <ToastShelf toasts={toasts} onRemove={removeToast} />
        <TemplateEditor
          templateId={editingId}
          onSave={handleEditorSave}
          onCancel={() => {
            // If the user cancels editing an unsaved AI-generated draft,
            // remove it from the registry so it doesn't linger in the grid.
            const tmpl = getTemplate(editingId);
            if (tmpl?._isNew) unregisterTemplate(editingId);
            setEditingId(null);
          }}
        />
      </>
    );
  }

  const activeTmpl = getTemplate(localActive);
  const modes      = Object.keys(activeTmpl?.modes ?? {});
  const singleMode = modes.length === 1;

  if (!isAdmin) {
    return (
      <section aria-label="Appearance (read-only)">
        <h2>Appearance</h2>
        <p className="muted">Only admins can change the portal theme. The active template is shown below.</p>
        {activeTmpl && (
          <div style={{ maxWidth: 340, marginTop: 16 }}>
            <TemplateCard
              tmpl={activeTmpl}
              meta={{ builtIn: true }}
              isActive
              isAdmin={false}
              onExport={() => exportTemplate(localActive)}
            />
          </div>
        )}
      </section>
    );
  }

  return (
    <section aria-label="Appearance settings">
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      <ConfirmDialog state={confirmState} />

      {/* AI generate theme modal */}
      {generateOpen && (
        <GenerateThemeModal
          onGenerated={handleGenerated}
          onClose={() => setGenerateOpen(false)}
        />
      )}

      <h2>Appearance</h2>
      <p className="muted" style={{ marginBottom: 20 }}>
        Choose a template to apply its colours, fonts, and effects across the entire portal.
        Changes take effect immediately without a page reload.
      </p>

      {serverError && (
        <div className="error-note" role="alert" style={{ marginBottom: 16 }}>
          {serverError} — showing local templates only.
        </div>
      )}

      {singleMode && (
        <div
          role="note"
          style={{
            background: 'var(--info-wash)',
            border: '1px solid color-mix(in srgb, var(--info) 30%, transparent)',
            borderRadius: 'var(--radius)',
            padding: '8px 12px',
            fontSize: '0.84rem',
            color: 'var(--info)',
            marginBottom: 16,
          }}
        >
          The active template has only one mode ({modes[0]}). The Light/Dark toggle is hidden.
        </div>
      )}

      <div className="row" style={{ gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <ImportButton onImported={handleImported} toast={toast} />
        {isAdmin && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => setGenerateOpen(true)}
            id="generate-theme-btn"
          >
            ✦ Generate with AI…
          </button>
        )}
      </div>

      <div className="template-grid">
        {allTemplates.map(({ tmpl, meta }) => (
          <TemplateCard
            key={tmpl.id}
            tmpl={tmpl}
            meta={meta}
            isActive={tmpl.id === localActive}
            isAdmin={isAdmin}
            onActivate={() => activate(tmpl.id)}
            onDuplicate={() => duplicate(tmpl.id)}
            onExport={() => exportTemplate(tmpl.id)}
            onDelete={!meta?.builtIn ? () => deleteTemplate(tmpl.id) : undefined}
            onEdit={isAdmin ? () => editTheme(tmpl.id) : undefined}
            onReset={isAdmin && meta?.builtIn ? () => resetToDefault(tmpl.id) : undefined}
          />
        ))}
      </div>

      {allTemplates.length === 0 && !serverError && (
        <p className="muted">No templates found. Import a JSON template to get started.</p>
      )}
    </section>
  );
}
