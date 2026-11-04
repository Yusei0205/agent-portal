/**
 * Template registry.
 *
 * Built-in templates are sourced exclusively from shared/themes/*.json
 * (the single source of truth shared with the server).
 * Custom / server-side templates are registered at runtime via registerTemplate().
 */
import aethrixNightJson from '../../../../shared/themes/aethrix-night.json';
import classicTealJson  from '../../../../shared/themes/classic-teal.json';
import cloviJson        from '../../../../shared/themes/clovi.json';
import nebulaJson       from '../../../../shared/themes/nebula.json';
import auroraGlassJson  from '../../../../shared/themes/aurora-glass.json';
import cyberHudJson     from '../../../../shared/themes/cyber-hud.json';
import twilightJson     from '../../../../shared/themes/twilight.json';
import terminalJson     from '../../../../shared/themes/terminal.json';
import kiroIdeJson      from '../../../../shared/themes/kiro-ide.json';
import graphiteJson     from '../../../../shared/themes/graphite.json';

// ── Font family name → full CSS stack ────────────────────────────────────────
// Covers every name in the server validator allow-list.
// "Bundled" means the woff2 files are included via @fontsource-variable in main.jsx.
const FONT_STACKS = {
  'Space Grotesk':     "'Space Grotesk Variable','Space Grotesk',system-ui,sans-serif",
  'Quicksand':         "'Quicksand Variable','Quicksand',system-ui,sans-serif",
  'Inter':             "'Inter Variable','Inter',system-ui,sans-serif",
  'Geist Sans':        "'Geist Sans',system-ui,sans-serif",
  'JetBrains Mono':    "'JetBrains Mono Variable','JetBrains Mono','SF Mono',Consolas,monospace",
  'Outfit':            "'Outfit Variable','Outfit',system-ui,sans-serif",
  'Plus Jakarta Sans': "'Plus Jakarta Sans Variable','Plus Jakarta Sans',system-ui,sans-serif",
  'Orbitron':          "'Orbitron',system-ui,sans-serif",
  'Exo 2':             "'Exo 2 Variable','Exo 2',system-ui,sans-serif",
  'system-ui':         "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
  'ui-monospace':      "ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace",
  'ui-sans-serif':     "ui-sans-serif,system-ui,sans-serif",
  'ui-serif':          "ui-serif,Georgia,serif",
  'serif':             "Georgia,'Times New Roman',serif",
  'sans-serif':        "Arial,Helvetica,sans-serif",
  'monospace':         "Consolas,'Courier New',monospace",
  '-apple-system':     "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
};

/** Names of fonts whose woff2 files are bundled in the app. */
export const BUNDLED_FONT_NAMES = new Set([
  'Space Grotesk',
  'Inter',
  'JetBrains Mono',
  'Quicksand',
  'Geist Sans',
  'Outfit',
  'Plus Jakarta Sans',
  'Orbitron',
  'Exo 2',
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

/**
 * Remove a template from the registry by id.
 * No-op if the id is not registered.
 * @param {string} id
 */
export function unregisterTemplate(id) {
  registry.delete(id);
}

// Register built-ins (from canonical shared/themes/*.json)
registerTemplate(aethrixNightJson);
registerTemplate(classicTealJson);
registerTemplate(cloviJson);
registerTemplate(nebulaJson);
registerTemplate(auroraGlassJson);
registerTemplate(cyberHudJson);
registerTemplate(twilightJson);
registerTemplate(terminalJson);
registerTemplate(kiroIdeJson);
registerTemplate(graphiteJson);
