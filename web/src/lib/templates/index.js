/**
 * Template registry.
 *
 * Built-in templates are sourced exclusively from shared/themes/*.json
 * (the single source of truth shared with the server).
 * Custom / server-side templates are registered at runtime via registerTemplate().
 */
import aethrixNightJson from '../../../../shared/themes/aethrix-night.json';
import classicTealJson  from '../../../../shared/themes/classic-teal.json';

// ── Font family name → full CSS stack ────────────────────────────────────────
// Covers every name in the server validator allow-list.
// "Bundled" means the woff2 files are included via @fontsource-variable in main.jsx.
const FONT_STACKS = {
  'Space Grotesk':  "'Space Grotesk Variable','Space Grotesk',system-ui,sans-serif",
  'Inter':          "'Inter Variable','Inter',system-ui,sans-serif",
  'JetBrains Mono': "'JetBrains Mono Variable','JetBrains Mono','SF Mono',Consolas,monospace",
  'system-ui':      "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
  'ui-monospace':   "ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace",
};

/** Names of fonts whose woff2 files are bundled in the app. */
export const BUNDLED_FONT_NAMES = new Set([
  'Space Grotesk',
  'Inter',
  'JetBrains Mono',
]);

function resolveFontStack(name) {
  if (!name) return name;
  // Already a full CSS stack (contains commas or quotes)
  if (name.includes(',') || name.includes("'")) return name;
  return FONT_STACKS[name] || name;
}

/**
 * Convert a server / JSON-file format template to the normalised browser format.
 *
 * - Maps short font family names to full CSS stacks.
 * - Converts numeric radius values (bare px) to "Npx" strings.
 * - Maps radius.lg to both --radius-lg and --radius-xl for consistent resolution.
 * - Ensures every mode has a --link fallback if absent.
 *
 * @param {object} raw - Template in server validator format
 * @returns {object}   Normalised template ready for applyTemplate()
 */
export function normaliseTemplate(raw) {
  if (!raw) return raw;
  const out = { ...raw };

  // Fonts: short names → full CSS stacks
  if (raw.fonts) {
    out.fonts = {
      display: resolveFontStack(raw.fonts.display),
      body:    resolveFontStack(raw.fonts.body),
      mono:    resolveFontStack(raw.fonts.mono),
    };
  }

  // Radius: numeric → "Npx"
  if (raw.radius) {
    out.radius = {};
    for (const [k, v] of Object.entries(raw.radius)) {
      out.radius[k] = typeof v === 'number' ? `${v}px` : v;
    }
  }

  // Modes: ensure every mode has a `link` token
  if (raw.modes) {
    out.modes = {};
    for (const [mode, tokens] of Object.entries(raw.modes)) {
      const t = { ...tokens };
      // Fall back to accent (readable on panel) when the template predates --link
      if (!t.link) {
        t.link = t.accent || t['accent-ink'];
      }
      out.modes[mode] = t;
    }
  }

  return out;
}

// ── Registry ──────────────────────────────────────────────────────────────────

/** @type {Map<string, object>} */
const registry = new Map();

/**
 * Register a template. Normalises automatically.
 * Passing a server-format template (numeric radius, short font names) is safe.
 * @param {object} tmpl
 */
export function registerTemplate(tmpl) {
  if (!tmpl?.id) return;
  registry.set(tmpl.id, normaliseTemplate(tmpl));
}

/** Get all registered templates. */
export function getTemplates() {
  return [...registry.values()];
}

/** Get a template by id (falls back to aethrix-night). */
export function getTemplate(id) {
  return registry.get(id) || registry.get('aethrix-night');
}

// Register built-ins (from canonical shared/themes/*.json)
registerTemplate(aethrixNightJson);
registerTemplate(classicTealJson);
