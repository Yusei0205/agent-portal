/**
 * Unified theme management.
 *
 * Replaces the old dual mechanism (theme-init.js sets data-theme=hud|standard +
 * data-fx, while this file set data-theme=dark|light from a different key).
 *
 * New contract:
 *   - data-template="aethrix-night" | "classic-teal" | custom id
 *   - data-mode="dark" | "light"
 *   - data-theme="dark" | "light"   ← backward-compat alias (set together with data-mode)
 *   - data-fx-glow, data-fx-grid, data-fx-gradient, data-fx-motion
 *   - CSS vars set via element.style.setProperty on :root
 *
 * localStorage keys:
 *   portal-template-id  — active template id (default: aethrix-night)
 *   portal-mode         — user mode choice: dark | light | system (default: system)
 *   portal-theme-etag   — ETag from last /api/theme fetch
 *   portal-theme-cached — JSON of last /api/theme payload
 */

import { useState, useEffect } from 'react';
import { registerTemplate, getTemplate, getTemplates, normaliseTemplate, unregisterTemplate } from './templates/index.js';

export { registerTemplate, getTemplate, getTemplates, normaliseTemplate, unregisterTemplate };

const LS_TEMPLATE = 'portal-template-id';
const LS_MODE     = 'portal-mode';
const LS_ETAG     = 'portal-theme-etag';
const LS_CACHED   = 'portal-theme-cached';

// ── Storage helpers (safe in private mode) ───────────────────────────────────

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, val); } catch { /* private mode */ }
}

// ── Public getters / setters ─────────────────────────────────────────────────

/** @returns {string} */
export function getActiveTemplateId() {
  return lsGet(LS_TEMPLATE) || 'aethrix-night';
}

/**
 * Persist and apply a template by id.
 * @param {string} id
 */
export function setActiveTemplate(id) {
  lsSet(LS_TEMPLATE, id);
  const tmpl = getTemplate(id);
  applyTemplate(tmpl);
  document.dispatchEvent(new CustomEvent('portal-theme-changed', { detail: { templateId: id } }));
}

/** @returns {'dark' | 'light' | 'system'} */
export function getMode() {
  const v = lsGet(LS_MODE);
  if (v === 'dark' || v === 'light' || v === 'system') return v;
  return 'system';
}

/**
 * Persist and apply user mode choice.
 * @param {'dark' | 'light' | 'system'} mode
 */
export function setMode(mode) {
  const val = ['dark', 'light', 'system'].includes(mode) ? mode : 'system';
  lsSet(LS_MODE, val);
  const tmpl = getTemplate(getActiveTemplateId());
  _applyMode(val, tmpl);
  document.dispatchEvent(new CustomEvent('portal-theme-changed', { detail: { mode: val } }));
}

// Backward-compat aliases (used by AppHeader, etc.)
export const getTheme = getMode;
export function setTheme(mode) { setMode(mode); }

// ── Apply ─────────────────────────────────────────────────────────────────────

/**
 * Apply the active template from localStorage (called from main.jsx before React renders).
 */
export function applyTheme() {
  const id   = getActiveTemplateId();
  const tmpl = getTemplate(id);
  applyTemplate(tmpl);
}

/**
 * Apply a template object (sets CSS vars + data attributes on <html>).
 * @param {object} tmpl
 */
export function applyTemplate(tmpl) {
  if (!tmpl) return;
  _applyTemplateAttrs(tmpl);
  _applyMode(getMode(), tmpl);
}

function _applyTemplateAttrs(tmpl) {
  const root = document.documentElement;

  root.setAttribute('data-template', tmpl.id);

  // Fonts
  if (tmpl.fonts) {
    const { display, body, mono } = tmpl.fonts;
    if (display) root.style.setProperty('--font-display', display);
    if (body)    root.style.setProperty('--font-body',    body);
    if (mono)    root.style.setProperty('--mono',          mono);
    if (body)    root.style.setProperty('--font',          body); // legacy alias
  }

  // Radius
  if (tmpl.radius) {
    const { sm, md, lg } = tmpl.radius;
    if (sm) root.style.setProperty('--radius-sm', sm);
    if (md) root.style.setProperty('--radius-md', md);
    if (lg) {
      // Set both --radius-xl (used by cards/modals) and --radius-lg (used by panels/items)
      // so they stay in sync regardless of the base.css alias chain.
      root.style.setProperty('--radius-xl', lg);
      root.style.setProperty('--radius-lg', lg);
    }
  }

  // Effects
  const fx = tmpl.effects || {};
  root.setAttribute('data-fx-glow',     fx.glow            ? 'true' : 'false');
  root.setAttribute('data-fx-grid',     fx.gridBackground  ? 'true' : 'false');
  root.setAttribute('data-fx-gradient', fx.gradientAccents ? 'true' : 'false');
  root.setAttribute('data-fx-motion',   fx.motion ?? 'full');

  // One-mode template: expose which mode it has
  const modes = Object.keys(tmpl.modes || {});
  if (modes.length === 1) {
    root.setAttribute('data-template-single-mode', modes[0]);
  } else {
    root.removeAttribute('data-template-single-mode');
  }
}

function _applyMode(mode, tmpl) {
  const root  = document.documentElement;
  const modes = tmpl.modes || {};

  // Resolve effective mode
  let effective = mode;
  if (mode === 'system') {
    try {
      effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      effective = 'dark';
    }
  }

  // Fall back to first available mode if template lacks the requested one
  if (!modes[effective]) {
    effective = Object.keys(modes)[0] || 'dark';
  }

  const tokens = modes[effective] || {};
  for (const [k, v] of Object.entries(tokens)) {
    root.style.setProperty(`--${k}`, v);
  }

  // Set both data-mode (new) and data-theme (backward compat for existing CSS)
  root.setAttribute('data-mode',  effective);
  root.setAttribute('data-theme', effective);
}

// ── Server theme fetch ───────────────────────────────────────────────────────

/**
 * Fetch GET /api/theme, apply if changed, cache in localStorage.
 * Fails gracefully (never throws).
 */
export async function fetchAndApplyTheme() {
  try {
    const etag    = lsGet(LS_ETAG) || '';
    const headers = etag ? { 'If-None-Match': etag } : {};
    const res     = await fetch('/api/theme', { headers });

    if (res.status === 304 || res.status === 404) return; // unchanged or not implemented yet
    if (!res.ok) return;

    const data = await res.json();
    if (!data?.template) return;

    const newEtag = res.headers.get('ETag') || '';
    lsSet(LS_ETAG, newEtag);
    lsSet(LS_CACHED, JSON.stringify(data.template));
    lsSet(LS_TEMPLATE, data.template.id);

    // Normalise server format before registering (converts numeric radius, short font names)
    const normalised = normaliseTemplate(data.template);

    // Register custom/server template if not in built-in registry
    const existing = getTemplate(data.template.id);
    if (!existing || existing.id !== data.template.id) {
      registerTemplate(normalised);
    } else {
      // Refresh to pick up any server changes
      registerTemplate(normalised);
    }
    applyTemplate(getTemplate(data.template.id));
    document.dispatchEvent(new CustomEvent('portal-theme-changed', { detail: { source: 'server' } }));
  } catch {
    // Network error → keep current template
  }
}

// ── React hook ───────────────────────────────────────────────────────────────

/**
 * React hook that returns the active template and re-renders whenever
 * 'portal-theme-changed' fires (e.g. after activating, editing, or receiving
 * a theme.changed SSE from another tab).
 *
 * Usage:
 *   const tmpl = useActiveTemplate();
 *   const name = tmpl?.brand?.productName || 'Agent Portal';
 */
export function useActiveTemplate() {
  const [tmpl, setTmpl] = useState(() => getTemplate(getActiveTemplateId()));

  useEffect(() => {
    const onChanged = () => {
      setTmpl(getTemplate(getActiveTemplateId()));
    };
    document.addEventListener('portal-theme-changed', onChanged);
    return () => document.removeEventListener('portal-theme-changed', onChanged);
  }, []);

  return tmpl;
}
