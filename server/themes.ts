/**
 * Themes module — look-and-feel templates for the portal.
 *
 * Routes:
 *   GET  /api/theme                         — public; active template + ETag/304
 *   GET  /api/admin/themes                  — list built-ins + custom (admin)
 *   GET  /api/admin/themes/:id              — full template (admin)
 *   POST /api/admin/themes                  — create custom (browser auth)
 *   PUT  /api/admin/themes/:id              — update custom (browser auth)
 *   DELETE /api/admin/themes/:id            — delete custom (browser auth)
 *   POST /api/admin/themes/:id/activate     — set active (browser auth)
 *   POST /api/admin/themes/:id/duplicate    — custom copy (browser auth)
 *   GET  /api/admin/themes/:id/export       — JSON download (admin)
 *   POST /api/admin/themes/import           — validate + create (browser auth)
 *   POST /api/admin/themes/validate         — validate only, no save (admin)
 */

import { createHash } from 'node:crypto';
import { router, sendJson, requireAuth, requireCookieAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getDb } from './db.ts';
import { getSetting, setSetting, getSettings } from './settings.ts';
import { getThemesRepository } from './repositories/themes.ts';
import { appendAudit } from './audit.ts';
import { emitGlobal } from './events.ts';
import { generateId, now, notFound, badRequest, forbidden } from './util.ts';
import { callTextModel } from './testing/model-provider.ts';
import aethrixNightJson from '../shared/themes/aethrix-night.json' with { type: 'json' };
import classicTealJson from '../shared/themes/classic-teal.json' with { type: 'json' };
import cloviJson from '../shared/themes/clovi.json' with { type: 'json' };
import nebulaJson from '../shared/themes/nebula.json' with { type: 'json' };
import auroraGlassJson from '../shared/themes/aurora-glass.json' with { type: 'json' };
import cyberHudJson from '../shared/themes/cyber-hud.json' with { type: 'json' };
import twilightJson from '../shared/themes/twilight.json' with { type: 'json' };
import terminalJson from '../shared/themes/terminal.json' with { type: 'json' };
import kiroIdeJson from '../shared/themes/kiro-ide.json' with { type: 'json' };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

type TokenSet = Record<string, string>;
type MotionKind = 'full' | 'reduced' | 'none';

export interface ThemeTemplate {
  id: string;
  name: string;
  version: number;
  description?: string;
  brand: {
    productName: string;
    tagline?: string;
    logoSvg?: string;
    faviconSvg?: string;
  };
  modes: {
    dark?: TokenSet;
    light?: TokenSet;
  };
  fonts: {
    display: string;
    body: string;
    mono: string;
  };
  effects: {
    glow: boolean;
    gridBackground: boolean;
    gradientAccents: boolean;
    motion: MotionKind;
  };
  radius: {
    sm: number;
    md: number;
    lg: number;
  };
}

// ── Token allow-list ──────────────────────────────────────────────────────────

export const ALLOWED_TOKEN_NAMES = new Set([
  'canvas', 'panel', 'panel-2', 'raised', 'rail',
  'line', 'line-2',
  'ink', 'ink-2', 'ink-3',
  'accent', 'accent-2', 'accent-3', 'accent-ink', 'accent-wash',
  'link',
  'ok', 'ok-wash',
  'warn', 'warn-wash',
  'danger', 'danger-wash',
  'info', 'info-wash',
  'focus', 'glow', 'code-bg', 'shadow',
]);

const SHADOW_TOKENS = new Set(['shadow', 'glow']);

// ── Font allow-list ───────────────────────────────────────────────────────────

export const FONT_ALLOW_LIST: string[] = [
  // Display
  'Space Grotesk', 'Outfit', 'DM Sans', 'Plus Jakarta Sans', 'Raleway',
  'Exo 2', 'Orbitron', 'Nunito', 'Urbanist', 'Quicksand',
  // Body
  'Inter', 'Source Sans 3', 'Noto Sans', 'Lato', 'Roboto', 'Geist Sans',
  // Mono
  'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Cascadia Code',
  // System stacks
  'system-ui', 'ui-sans-serif', 'ui-monospace', 'ui-serif',
  'serif', 'sans-serif', 'monospace', '-apple-system',
];

const FONT_ALLOW_SET = new Set(FONT_ALLOW_LIST);

/**
 * Full CSS font-family stacks for each allowed font name.
 * Used by the /api/admin/themes/fonts endpoint so the editor can apply
 * live previews without needing the client-side bundle.
 */
const FONT_STACKS: Record<string, string> = {
  'Space Grotesk':  "'Space Grotesk Variable','Space Grotesk',system-ui,sans-serif",
  'Quicksand':      "'Quicksand Variable','Quicksand',system-ui,sans-serif",
  'Outfit':         "'Outfit Variable','Outfit',system-ui,sans-serif",
  'DM Sans':        "'DM Sans Variable','DM Sans',system-ui,sans-serif",
  'Plus Jakarta Sans': "'Plus Jakarta Sans Variable','Plus Jakarta Sans',system-ui,sans-serif",
  'Raleway':        "'Raleway Variable','Raleway',system-ui,sans-serif",
  'Exo 2':          "'Exo 2 Variable','Exo 2',system-ui,sans-serif",
  'Orbitron':       "'Orbitron',system-ui,sans-serif",
  'Nunito':         "'Nunito Variable','Nunito',system-ui,sans-serif",
  'Urbanist':       "'Urbanist Variable','Urbanist',system-ui,sans-serif",
  'Inter':          "'Inter Variable','Inter',system-ui,sans-serif",
  'Geist Sans':     "'Geist Sans',system-ui,sans-serif",
  'Source Sans 3':  "'Source Sans 3 Variable','Source Sans 3',system-ui,sans-serif",
  'Noto Sans':      "'Noto Sans',system-ui,sans-serif",
  'Lato':           "'Lato',system-ui,sans-serif",
  'Roboto':         "'Roboto',system-ui,sans-serif",
  'JetBrains Mono': "'JetBrains Mono Variable','JetBrains Mono','SF Mono',Consolas,monospace",
  'Fira Code':      "'Fira Code Variable','Fira Code',Consolas,monospace",
  'Source Code Pro':"'Source Code Pro Variable','Source Code Pro',Consolas,monospace",
  'Cascadia Code':  "'Cascadia Code',Consolas,monospace",
  'system-ui':      "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
  'ui-sans-serif':  "ui-sans-serif,system-ui,sans-serif",
  'ui-monospace':   "ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace",
  'ui-serif':       "ui-serif,Georgia,serif",
  'serif':          "Georgia,'Times New Roman',serif",
  'sans-serif':     "Arial,Helvetica,sans-serif",
  'monospace':      "Consolas,'Courier New',monospace",
  '-apple-system':  "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
};

/** Names whose woff2 files are bundled in the web app via @fontsource. */
const BUNDLED_FONT_NAMES = new Set([
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

// ── Colour validation ─────────────────────────────────────────────────────────

const HEX3_RE = /^#[0-9a-fA-F]{3}$/;
const HEX6_RE = /^#[0-9a-fA-F]{6}$/;
const HEX8_RE = /^#[0-9a-fA-F]{8}$/;
const RGB_RE = /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/;
const RGBA_RE = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:\d+\.?\d*|\.\d+)\s*\)$/;
const HSL_RE = /^hsl\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*\)$/;
const HSLA_RE = /^hsla\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*,\s*(?:\d+\.?\d*|\.\d+)\s*\)$/;

/** CSS injection guard — reject these patterns in any value. */
function hasCssInjection(val: string): boolean {
  if (/[;<>{}\\]/.test(val)) return true;
  if (/url\s*\(/i.test(val)) return true;
  if (/expression\s*\(/i.test(val)) return true;
  if (/javascript:/i.test(val)) return true;
  if (/\/\*/.test(val)) return true;
  return false;
}

/** Validate a colour value (non-shadow token). */
export function isSafeColor(val: string): boolean {
  if (hasCssInjection(val)) return false;
  return (
    HEX3_RE.test(val) ||
    HEX6_RE.test(val) ||
    HEX8_RE.test(val) ||
    RGB_RE.test(val) ||
    RGBA_RE.test(val) ||
    HSL_RE.test(val) ||
    HSLA_RE.test(val)
  );
}

/** Split box-shadow layers on top-level commas (not inside parens). */
function splitShadowLayers(val: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of val) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      if (current.trim()) layers.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) layers.push(current.trim());
  return layers;
}

/**
 * Validate a box-shadow / glow value.
 * Grammar: none | <shadow-layer> (',' <shadow-layer>)*
 * shadow-layer: [inset] <length> <length> [<length> [<length>]] <color>
 */
export function isSafeShadowOrGlow(val: string): boolean {
  const trimmed = val.trim();
  if (trimmed === 'none') return true;
  if (hasCssInjection(trimmed)) return false;

  // Restrict allowed characters: digits, spaces, commas, dots, #, %, letters, hyphens, parens
  if (!/^[\s\d,.#%a-zA-Z\-()+]*$/.test(trimmed)) return false;

  const LENGTH = `(?:-?(?:\\d+\\.?\\d*|\\.\\d+)(?:px|em|rem|%)?|0)`;
  const COLOR = `(?:#[0-9a-fA-F]{3,8}|rgba?\\([\\d.,\\s]+\\)|hsla?\\([\\d.,%\\s]+\\))`;
  const LAYER_RE = new RegExp(
    `^(?:inset\\s+)?${LENGTH}\\s+${LENGTH}(?:\\s+${LENGTH})?(?:\\s+${LENGTH})?\\s+${COLOR}$`,
  );

  const layers = splitShadowLayers(trimmed);
  if (layers.length === 0) return false;
  return layers.every((l) => LAYER_RE.test(l));
}

// ── SVG sanitisation ──────────────────────────────────────────────────────────

/**
 * Sanitise an SVG string without a DOM.
 * Strips: <script>, on* attributes, <foreignObject>, external href/xlink:href,
 * javascript: URLs, <style> blocks containing @import or url(.
 */
export function sanitizeSvg(input: string): string {
  let s = input;

  // Remove <script> elements (greedy on the inner content is intentional)
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<script[^>]*?\/\s*>/gi, '');
  // Edge-case: unclosed <script> tag
  s = s.replace(/<script[^>]*>/gi, '');

  // Remove <foreignObject> elements
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '');
  s = s.replace(/<foreignObject[^>]*?\/\s*>/gi, '');

  // Remove all on* event handler attributes
  s = s.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');

  // Process href and xlink:href — only allow #fragment refs
  s = s.replace(
    /(\s(?:xlink:)?href\s*=\s*)("([^"]*?)"|'([^']*?)')/gi,
    (_m, prefix: string, _quoted: string, dq: string | undefined, sq: string | undefined) => {
      const val = dq ?? sq ?? '';
      if (val.startsWith('#')) return `${prefix}"${val}"`;
      return '';
    },
  );

  // Remove javascript: in src
  s = s.replace(/\ssrc\s*=\s*(?:"[^"]*javascript:[^"]*"|'[^']*javascript:[^']*')/gi, '');

  // Remove <style> blocks that contain @import or url(
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, (match) => {
    if (/@import|url\s*\(/i.test(match)) return '';
    return match;
  });

  return s;
}

// ── Template validator ────────────────────────────────────────────────────────

const TOP_LEVEL_KEYS = new Set(['id', 'name', 'version', 'description', 'brand', 'modes', 'fonts', 'effects', 'radius']);
const BRAND_KEYS = new Set(['productName', 'tagline', 'logoSvg', 'faviconSvg']);
const MODES_KEYS = new Set(['dark', 'light']);
const FONTS_KEYS = new Set(['display', 'body', 'mono']);
const EFFECTS_KEYS = new Set(['glow', 'gridBackground', 'gradientAccents', 'motion']);
const RADIUS_KEYS = new Set(['sm', 'md', 'lg']);
const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$|^[a-z0-9]{1,2}$/;
const VALID_ID_RE = /^[a-z0-9-]{3,40}$/;

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>, path: string, errors: ValidationError[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push({ path: `${path}.${key}`, message: `Unknown key "${key}"` });
    }
  }
}

/**
 * Validate a template object. Returns { ok, errors }.
 * Strict: unknown keys are rejected, not silently dropped.
 */
export function validateTemplate(raw: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ path: '', message: 'Template must be a JSON object' }] };
  }

  const t = raw as Record<string, unknown>;

  unknownKeys(t, TOP_LEVEL_KEYS, 'template', errors);

  // id
  if (typeof t.id !== 'string') {
    errors.push({ path: 'id', message: 'id must be a string' });
  } else {
    if (!VALID_ID_RE.test(t.id)) {
      errors.push({ path: 'id', message: 'id must be 3–40 characters, only lowercase letters, digits and hyphens' });
    }
  }

  // name
  if (typeof t.name !== 'string' || t.name.length === 0) {
    errors.push({ path: 'name', message: 'name is required' });
  } else if (t.name.length > 60) {
    errors.push({ path: 'name', message: 'name must be ≤ 60 characters' });
  }

  // version
  if (typeof t.version !== 'number' || !Number.isFinite(t.version)) {
    errors.push({ path: 'version', message: 'version must be a number' });
  }

  // description (optional)
  if (t.description !== undefined) {
    if (typeof t.description !== 'string') {
      errors.push({ path: 'description', message: 'description must be a string' });
    } else if (t.description.length > 300) {
      errors.push({ path: 'description', message: 'description must be ≤ 300 characters' });
    }
  }

  // brand
  if (t.brand === undefined || t.brand === null || typeof t.brand !== 'object' || Array.isArray(t.brand)) {
    errors.push({ path: 'brand', message: 'brand is required and must be an object' });
  } else {
    const brand = t.brand as Record<string, unknown>;
    unknownKeys(brand, BRAND_KEYS, 'brand', errors);

    if (typeof brand.productName !== 'string' || brand.productName.length === 0) {
      errors.push({ path: 'brand.productName', message: 'brand.productName is required' });
    } else if (brand.productName.length > 40) {
      errors.push({ path: 'brand.productName', message: 'brand.productName must be ≤ 40 characters' });
    }

    if (brand.tagline !== undefined) {
      if (typeof brand.tagline !== 'string') {
        errors.push({ path: 'brand.tagline', message: 'brand.tagline must be a string' });
      } else if (brand.tagline.length > 80) {
        errors.push({ path: 'brand.tagline', message: 'brand.tagline must be ≤ 80 characters' });
      }
    }

    if (brand.logoSvg !== undefined) {
      if (typeof brand.logoSvg !== 'string') {
        errors.push({ path: 'brand.logoSvg', message: 'brand.logoSvg must be a string' });
      } else if (Buffer.byteLength(brand.logoSvg, 'utf8') > 20 * 1024) {
        errors.push({ path: 'brand.logoSvg', message: 'brand.logoSvg must be ≤ 20 KB' });
      }
    }

    if (brand.faviconSvg !== undefined) {
      if (typeof brand.faviconSvg !== 'string') {
        errors.push({ path: 'brand.faviconSvg', message: 'brand.faviconSvg must be a string' });
      } else if (Buffer.byteLength(brand.faviconSvg, 'utf8') > 10 * 1024) {
        errors.push({ path: 'brand.faviconSvg', message: 'brand.faviconSvg must be ≤ 10 KB' });
      }
    }
  }

  // modes
  if (t.modes === undefined || t.modes === null || typeof t.modes !== 'object' || Array.isArray(t.modes)) {
    errors.push({ path: 'modes', message: 'modes is required and must be an object' });
  } else {
    const modes = t.modes as Record<string, unknown>;
    unknownKeys(modes, MODES_KEYS, 'modes', errors);

    if (modes.dark === undefined && modes.light === undefined) {
      errors.push({ path: 'modes', message: 'modes must have at least one of: dark, light' });
    }

    for (const mode of ['dark', 'light'] as const) {
      if (modes[mode] === undefined) continue;
      if (typeof modes[mode] !== 'object' || modes[mode] === null || Array.isArray(modes[mode])) {
        errors.push({ path: `modes.${mode}`, message: `modes.${mode} must be an object` });
        continue;
      }
      const tokenSet = modes[mode] as Record<string, unknown>;
      for (const [tokenName, tokenVal] of Object.entries(tokenSet)) {
        if (!ALLOWED_TOKEN_NAMES.has(tokenName)) {
          errors.push({ path: `modes.${mode}.${tokenName}`, message: `Unknown token "${tokenName}"` });
          continue;
        }
        if (typeof tokenVal !== 'string') {
          errors.push({ path: `modes.${mode}.${tokenName}`, message: 'Token value must be a string' });
          continue;
        }
        const isSafe = SHADOW_TOKENS.has(tokenName)
          ? isSafeShadowOrGlow(tokenVal)
          : isSafeColor(tokenVal);
        if (!isSafe) {
          errors.push({
            path: `modes.${mode}.${tokenName}`,
            message: `Invalid colour value "${tokenVal}" — only #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl(), hsla() are allowed`,
          });
        }
      }
    }
  }

  // fonts
  if (t.fonts === undefined || t.fonts === null || typeof t.fonts !== 'object' || Array.isArray(t.fonts)) {
    errors.push({ path: 'fonts', message: 'fonts is required and must be an object' });
  } else {
    const fonts = t.fonts as Record<string, unknown>;
    unknownKeys(fonts, FONTS_KEYS, 'fonts', errors);

    for (const role of ['display', 'body', 'mono'] as const) {
      if (typeof fonts[role] !== 'string') {
        errors.push({ path: `fonts.${role}`, message: `fonts.${role} is required` });
      } else if (!FONT_ALLOW_SET.has(fonts[role] as string)) {
        errors.push({
          path: `fonts.${role}`,
          message: `fonts.${role} "${fonts[role]}" is not in the allowed font list`,
        });
      }
    }
  }

  // effects
  if (t.effects === undefined || t.effects === null || typeof t.effects !== 'object' || Array.isArray(t.effects)) {
    errors.push({ path: 'effects', message: 'effects is required and must be an object' });
  } else {
    const effects = t.effects as Record<string, unknown>;
    unknownKeys(effects, EFFECTS_KEYS, 'effects', errors);

    for (const flag of ['glow', 'gridBackground', 'gradientAccents'] as const) {
      if (typeof effects[flag] !== 'boolean') {
        errors.push({ path: `effects.${flag}`, message: `effects.${flag} must be a boolean` });
      }
    }
    if (!['full', 'reduced', 'none'].includes(effects.motion as string)) {
      errors.push({ path: 'effects.motion', message: 'effects.motion must be "full", "reduced" or "none"' });
    }
  }

  // radius
  if (t.radius === undefined || t.radius === null || typeof t.radius !== 'object' || Array.isArray(t.radius)) {
    errors.push({ path: 'radius', message: 'radius is required and must be an object' });
  } else {
    const radius = t.radius as Record<string, unknown>;
    unknownKeys(radius, RADIUS_KEYS, 'radius', errors);

    for (const key of ['sm', 'md', 'lg'] as const) {
      const val = radius[key];
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        errors.push({ path: `radius.${key}`, message: `radius.${key} must be a number` });
      } else if (val < 0 || val > 24) {
        errors.push({ path: `radius.${key}`, message: `radius.${key} must be 0–24` });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Built-in templates ────────────────────────────────────────────────────────

export const AETHRIX_NIGHT: ThemeTemplate = aethrixNightJson as unknown as ThemeTemplate;
export const CLASSIC_TEAL: ThemeTemplate = classicTealJson as unknown as ThemeTemplate;
export const CLOVI: ThemeTemplate = cloviJson as unknown as ThemeTemplate;
export const NEBULA: ThemeTemplate = nebulaJson as unknown as ThemeTemplate;
export const AURORA_GLASS: ThemeTemplate = auroraGlassJson as unknown as ThemeTemplate;
export const CYBER_HUD: ThemeTemplate = cyberHudJson as unknown as ThemeTemplate;
export const TWILIGHT: ThemeTemplate = twilightJson as unknown as ThemeTemplate;
export const TERMINAL: ThemeTemplate = terminalJson as unknown as ThemeTemplate;
export const KIRO_IDE: ThemeTemplate = kiroIdeJson as unknown as ThemeTemplate;
export const BUILTIN_THEMES: ReadonlyMap<string, ThemeTemplate> = new Map([
  [AETHRIX_NIGHT.id, AETHRIX_NIGHT],
  [CLASSIC_TEAL.id, CLASSIC_TEAL],
  [CLOVI.id, CLOVI],
  [NEBULA.id, NEBULA],
  [AURORA_GLASS.id, AURORA_GLASS],
  [CYBER_HUD.id, CYBER_HUD],
  [TWILIGHT.id, TWILIGHT],
  [TERMINAL.id, TERMINAL],
  [KIRO_IDE.id, KIRO_IDE],
]);

const BUILTIN_ETAGS: ReadonlyMap<string, string> = new Map(
  Array.from(BUILTIN_THEMES.entries()).map(([id, tmpl]) => [
    id,
    `"builtin-${id}-${createHash('sha256').update(JSON.stringify(tmpl)).digest('hex').slice(0, 16)}"`,
  ]),
);

// ── Active theme helpers ──────────────────────────────────────────────────────

const DEFAULT_THEME_ID = 'aethrix-night';

export function getActiveThemeId(): string {
  try {
    const raw = getSetting(getDb(), 'theme.active');
    if (!raw) return DEFAULT_THEME_ID;
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/**
 * Resolve the active template. Falls back to aethrix-night if the active id is
 * missing or its stored JSON is invalid.
 */
export async function resolveActiveTemplate(): Promise<{ template: ThemeTemplate; etag: string; updatedAt: string | null }> {
  const activeId = getActiveThemeId();

  // Check built-ins first — but prefer an admin override if one exists
  const builtin = BUILTIN_THEMES.get(activeId);
  if (builtin) {
    const overrideRow = await getThemesRepository().getOverrideById(activeId);
    if (overrideRow) {
      try {
        const template = JSON.parse(overrideRow.template_json) as ThemeTemplate;
        const updatedAt = overrideRow.updated_at;
        const etag = `"builtin-override-${activeId}-${createHash('sha256').update(overrideRow.template_json).digest('hex').slice(0, 16)}"`;
        return { template, etag, updatedAt };
      } catch {
        // Corrupt override — fall through to shipped built-in
      }
    }
    return {
      template: builtin,
      etag: BUILTIN_ETAGS.get(activeId) ?? `"builtin-${activeId}"`,
      updatedAt: null,
    };
  }

  // Check custom DB themes
  const row = await getThemesRepository().getCustomById(activeId);
  if (row) {
    try {
      const template = JSON.parse(row.template_json) as ThemeTemplate;
      const updatedAt = row.updated_at;
      const etag = `"${activeId}-${createHash('sha256').update(row.template_json).digest('hex').slice(0, 16)}"`;
      return { template, etag, updatedAt };
    } catch {
      // Fall through to default
    }
  }

  // Fallback to aethrix-night
  const fallback = AETHRIX_NIGHT;
  return {
    template: fallback,
    etag: BUILTIN_ETAGS.get(DEFAULT_THEME_ID) ?? `"builtin-${DEFAULT_THEME_ID}"`,
    updatedAt: null,
  };
}

// ── Route helpers ─────────────────────────────────────────────────────────────

function requireAdmin(req: PortalRequest, res: PortalResponse): boolean {
  if (!req.user?.is_admin) {
    sendJson(res, 403, { error: 'Admin access required' });
    return false;
  }
  return true;
}

// ── Generate-endpoint helpers ─────────────────────────────────────────────────

/** Parse hex colour (#rgb / #rrggbb / #rrggbbaa) to [r,g,b] 0–1 range. */
function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace('#', '');
  if (h.length === 6) {
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  if (h.length === 3) {
    return [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255, parseInt(h[2] + h[2], 16) / 255];
  }
  return null;
}

function srgbLinear(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(rgb: [number, number, number]): number {
  return 0.2126 * srgbLinear(rgb[0]) + 0.7152 * srgbLinear(rgb[1]) + 0.0722 * srgbLinear(rgb[2]);
}

function wcagContrast(fg: string, bg: string): number {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  if (!f || !b) return 21;
  return (Math.max(luminance(f), luminance(b)) + 0.05) / (Math.min(luminance(f), luminance(b)) + 0.05);
}

function adjustColorContrast(fg: string, bg: string, minRatio: number): string {
  if (wcagContrast(fg, bg) >= minRatio) return fg;
  const fRgb = hexToRgb(fg);
  if (!fRgb) return fg;
  const toHex = (rgb: [number, number, number]) =>
    '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');
  for (const target of [[1, 1, 1], [0, 0, 0]] as [number, number, number][]) {
    for (let step = 1; step <= 20; step++) {
      const t = step / 20;
      const bl: [number, number, number] = [
        fRgb[0] + t * (target[0] - fRgb[0]),
        fRgb[1] + t * (target[1] - fRgb[1]),
        fRgb[2] + t * (target[2] - fRgb[2]),
      ];
      if (wcagContrast(toHex(bl), bg) >= minRatio) return toHex(bl);
    }
  }
  return fg;
}

function autoFixTheme(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['id', 'name', 'version', 'description', 'brand', 'modes', 'fonts', 'effects', 'radius']) {
    if (key in raw) out[key] = raw[key];
  }
  if (out.radius && typeof out.radius === 'object' && !Array.isArray(out.radius)) {
    const r = out.radius as Record<string, unknown>;
    const fixedR: Record<string, unknown> = {};
    for (const k of ['sm', 'md', 'lg']) {
      const v = r[k];
      fixedR[k] = typeof v === 'number' ? Math.max(0, Math.min(24, Math.round(v))) : v;
    }
    out.radius = fixedR;
  }
  if (out.fonts && typeof out.fonts === 'object' && !Array.isArray(out.fonts)) {
    const f = out.fonts as Record<string, unknown>;
    out.fonts = {
      display: typeof f.display === 'string' && FONT_ALLOW_SET.has(f.display) ? f.display : 'Inter',
      body:    typeof f.body    === 'string' && FONT_ALLOW_SET.has(f.body)    ? f.body    : 'Inter',
      mono:    typeof f.mono    === 'string' && FONT_ALLOW_SET.has(f.mono)    ? f.mono    : 'JetBrains Mono',
    };
  }
  if (out.modes && typeof out.modes === 'object' && !Array.isArray(out.modes)) {
    const modes = out.modes as Record<string, unknown>;
    const fixedModes: Record<string, unknown> = {};
    for (const modeKey of ['dark', 'light'] as const) {
      if (!(modeKey in modes)) continue;
      const fallback = (AETHRIX_NIGHT.modes[modeKey] ?? AETHRIX_NIGHT.modes.dark) as Record<string, string>;
      const raw2 = modes[modeKey];
      const tokens: Record<string, unknown> = (typeof raw2 === 'object' && raw2 !== null && !Array.isArray(raw2))
        ? (raw2 as Record<string, unknown>) : {};
      const fixed: Record<string, string> = {};
      for (const tokenName of ALLOWED_TOKEN_NAMES) {
        const val = tokens[tokenName];
        fixed[tokenName] = typeof val === 'string' && val.trim().length > 0 ? val : (fallback[tokenName] || '');
      }
      fixedModes[modeKey] = fixed;
    }
    if (!fixedModes.dark && !fixedModes.light) fixedModes.dark = { ...AETHRIX_NIGHT.modes.dark };
    out.modes = fixedModes;
  }
  return out;
}

function fixContrastPairs(theme: ThemeTemplate): string[] {
  const warnings: string[] = [];
  const PAIRS = [
    { fg: 'ink',        bg: 'canvas', label: 'ink on canvas' },
    { fg: 'ink',        bg: 'panel',  label: 'ink on panel' },
    { fg: 'accent-ink', bg: 'accent', label: 'accent-ink on accent' },
  ];
  for (const [modeName, tokens] of Object.entries(theme.modes) as [string, Record<string, string>][]) {
    if (!tokens) continue;
    for (const { fg, bg, label } of PAIRS) {
      const fgColor = tokens[fg];
      const bgColor = tokens[bg];
      if (!fgColor || !bgColor) continue;
      const ratio = wcagContrast(fgColor, bgColor);
      if (ratio < 4.5) {
        const fixed = adjustColorContrast(fgColor, bgColor, 4.5);
        if (fixed !== fgColor) {
          tokens[fg] = fixed;
          warnings.push(`${modeName} mode: ${label} contrast was ${ratio.toFixed(2)}:1, adjusted ${fg} from ${fgColor} to ${fixed}.`);
        }
      }
    }
  }
  return warnings;
}

function extractJson(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* continue */ }
  const fenced = t.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch { /* continue */ } }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last > first) { try { return JSON.parse(t.slice(first, last + 1)); } catch { /* continue */ } }
  return null;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerThemeRoutes(): void {

  // ── Public: GET /api/theme ────────────────────────────────────────────────
  router.get('/api/theme', async (req: PortalRequest, res: PortalResponse) => {
    const { template, etag, updatedAt } = await resolveActiveTemplate();

    const ifNoneMatch = String(req.headers?.['if-none-match'] ?? '');
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=30, must-revalidate' });
      res.end();
      return;
    }

    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
    if (updatedAt) res.setHeader('Last-Modified', new Date(updatedAt).toUTCString());

    sendJson(res, 200, { template, etag });
  });

  // ── Admin: GET /api/admin/themes ──────────────────────────────────────────
  router.get('/api/admin/themes', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const activeId = getActiveThemeId();
    const customRows = await getThemesRepository().listCustom();

    const builtins = await Promise.all(Array.from(BUILTIN_THEMES.values()).map(async (t) => {
      const hasOverride = await getThemesRepository().hasOverride(t.id);
      return {
        id: t.id,
        name: t.name,
        builtIn: true,
        overridden: hasOverride,
        active: t.id === activeId,
        updatedAt: null,
        updatedBy: null,
      };
    }));

    const customs = customRows.map((r) => ({
      id: r.id,
      name: r.name,
      builtIn: false,
      overridden: false,
      active: r.id === activeId,
      updatedAt: r.updated_at || null,
      updatedBy: r.updated_by || null,
    }));

    sendJson(res, 200, { themes: [...builtins, ...customs] });
  }));

  // ── Admin: POST /api/admin/themes/generate — AI-powered theme creation ───
  router.post('/api/admin/themes/generate', requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const body = req.body as Record<string, unknown>;

    // Validate description
    if (!body || typeof body.description !== 'string' || (body.description as string).trim().length === 0) {
      sendJson(res, 400, { error: 'description is required' });
      return;
    }
    const description = (body.description as string).trim();
    if (description.length > 1000) {
      sendJson(res, 400, { error: 'description must be ≤ 1000 characters' });
      return;
    }

    // Validate referenceImages
    const rawImages = body.referenceImages;
    if (rawImages !== undefined && !Array.isArray(rawImages)) {
      sendJson(res, 400, { error: 'referenceImages must be an array' });
      return;
    }
    if (Array.isArray(rawImages) && rawImages.length > 4) {
      sendJson(res, 400, { error: 'Maximum 4 reference images allowed' });
      return;
    }

    const warnings: string[] = [];
    const processedImages: Array<{ data: Buffer; mimeType: string; filename: string }> = [];
    const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];

    if (Array.isArray(rawImages)) {
      for (let i = 0; i < rawImages.length; i++) {
        const img = rawImages[i] as Record<string, unknown>;
        const imgName = typeof img.name === 'string' ? img.name : `image-${i + 1}`;
        const dataUrl = img.dataUrl;
        if (typeof dataUrl !== 'string') {
          sendJson(res, 400, { error: `Image "${imgName}": dataUrl must be a string` });
          return;
        }
        const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
        if (!m) {
          sendJson(res, 400, { error: `Image "${imgName}": invalid data URL format` });
          return;
        }
        const mimeType = m[1].toLowerCase();
        if (!ALLOWED_MIME.includes(mimeType)) {
          sendJson(res, 400, { error: `Image "${imgName}": unsupported type "${mimeType}". Allowed: PNG, JPEG, WebP, GIF, SVG` });
          return;
        }
        let data: Buffer;
        try { data = Buffer.from(m[2], 'base64'); } catch {
          sendJson(res, 400, { error: `Image "${imgName}": invalid base64 data` });
          return;
        }
        if (data.length > 5 * 1024 * 1024) {
          sendJson(res, 400, { error: `Image "${imgName}" exceeds 5 MB limit (${(data.length / 1024 / 1024).toFixed(1)} MB)` });
          return;
        }
        if (mimeType === 'image/svg+xml') {
          warnings.push(`SVG image "${imgName}" was skipped — SVG cannot be used as a visual reference for the AI model.`);
          continue;
        }
        processedImages.push({ data, mimeType, filename: imgName });
      }
    }

    // Detect Kiro CLI path (images not forwarded to model)
    const settings = getSettings();
    if (settings.provider.mode === 'kiro' && processedImages.length > 0) {
      warnings.push(
        'Reference images were not sent to the model because the Kiro CLI provider can\'t read them; the theme is based on your description.',
      );
    }

    // Audit log
    const db = getDb();
    appendAudit(db, req.user!.id, 'theme.generate', `user:${req.user!.id}`, {
      descriptionLength: description.length,
      imageCount: processedImages.length,
    }, req.ip);

    // Build prompt
    const tokenDocs: Record<string, string> = {
      canvas:         'Main page/app background',
      panel:          'Card, sidebar, dialog background',
      'panel-2':      'Secondary/nested card background',
      raised:         'Floating element background (tooltip, popover)',
      rail:           'Navigation rail/sidebar background',
      line:           'Primary border/separator colour',
      'line-2':       'Secondary/subtle border colour',
      ink:            'Primary text (WCAG AA ≥ 4.5:1 on panel and canvas)',
      'ink-2':        'Secondary/muted text colour',
      'ink-3':        'Tertiary/placeholder text colour',
      accent:         'Primary brand/interactive colour',
      'accent-2':     'Secondary accent colour',
      'accent-3':     'Tertiary accent colour',
      'accent-ink':   'Text on accent backgrounds (WCAG AA ≥ 4.5:1 on accent)',
      link:           'Hyperlink colour (WCAG AA ≥ 4.5:1 on panel)',
      'accent-wash':  'Translucent accent bg, use rgba() with alpha 0.05–0.2',
      ok:             'Success state colour',
      'ok-wash':      'Translucent success bg rgba() alpha 0.05–0.15',
      warn:           'Warning state colour',
      'warn-wash':    'Translucent warning bg',
      danger:         'Error/danger state colour',
      'danger-wash':  'Translucent danger bg',
      info:           'Informational state colour',
      'info-wash':    'Translucent info bg',
      focus:          'Keyboard focus ring colour',
      glow:           'Box-shadow glow, e.g. "0 0 16px rgba(108,92,255,.4)"',
      'code-bg':      'Code block background colour',
      shadow:         'Default box shadow, e.g. "0 2px 8px rgba(0,0,0,.5)"',
    };

    const tokenList = Array.from(ALLOWED_TOKEN_NAMES)
      .map((t) => `  "${t}": ${tokenDocs[t] || t}`).join('\n');

    const systemPrompt =
      `You are an expert UI/UX theme designer for developer tools. Generate a complete portal theme.\n\n` +
      `OUTPUT: Only raw JSON — no markdown fences, no explanations.\n\n` +
      `SCHEMA (all fields required unless marked optional):\n` +
      `{\n` +
      `  "id": "lowercase-slug-3-40-chars",\n` +
      `  "name": "Human-readable name ≤ 60 chars",\n` +
      `  "version": 1,\n` +
      `  "description": "(optional) ≤ 300 chars",\n` +
      `  "brand": { "productName": "≤ 40 chars" },\n` +
      `  "modes": {\n` +
      `    "dark":  { /* ALL tokens listed below */ },\n` +
      `    "light": { /* ALL tokens listed below */ }\n` +
      `  },\n` +
      `  "fonts": { "display": "name", "body": "name", "mono": "name" },\n` +
      `  "effects": { "glow": bool, "gridBackground": bool, "gradientAccents": bool, "motion": "full"|"reduced"|"none" },\n` +
      `  "radius": { "sm": 0-24, "md": 0-24, "lg": 0-24 }\n` +
      `}\n\n` +
      `REQUIRED TOKENS in each mode (ALL must appear):\n${tokenList}\n\n` +
      `ALLOWED FONT NAMES (exact strings only): ${FONT_ALLOW_LIST.join(', ')}\n\n` +
      `COLOUR RULES:\n` +
      `- Regular colour tokens: #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl(), hsla()\n` +
      `- NO oklch, NO color(), NO named colours (red/blue/etc), NO url()\n` +
      `- shadow + glow tokens: box-shadow syntax only — e.g. "0 2px 8px rgba(0,0,0,.5)"\n` +
      `- Wash tokens: rgba() with alpha 0.05–0.2\n\n` +
      `WCAG AA REQUIREMENTS (contrast ratio ≥ 4.5:1):\n` +
      `- ink on canvas\n- ink on panel\n- accent-ink on accent\n- link on panel`;

    const userPrompt =
      `Generate a complete theme with both dark and light modes based on this description:\n\n` +
      `<description>\n${description}\n</description>\n\n` +
      `Return only JSON.`;

    // Call model (≈3 min timeout)
    let responseText: string;
    try {
      const timeoutMs = 3 * 60 * 1000;
      let _raceTimer: ReturnType<typeof setTimeout> | undefined;
      const raceTimeout = new Promise<never>((_, reject) => {
        _raceTimer = setTimeout(() => reject(new Error('Theme generation timed out (3 minutes). Try again.')), timeoutMs);
      });
      try {
        responseText = await Promise.race([
          callTextModel(systemPrompt, userPrompt, {
            maxTokens: 8192,
            createdBy: req.user!.id,
            images: processedImages,
          }),
          raceTimeout,
        ]);
      } finally {
        if (_raceTimer !== undefined) clearTimeout(_raceTimer);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('No AI provider') || msg.includes('demo') ||
        msg.includes('not configured') || msg.includes('Not configured') ||
        msg.includes('No model') || msg.includes('not signed in') ||
        msg.includes('timed out')
      ) {
        sendJson(res, 503, { error: msg });
        return;
      }
      throw err;
    }

    let parsed = extractJson(responseText);
    let validResult = parsed
      ? validateTemplate(parsed)
      : { ok: false as const, errors: [{ path: '', message: 'Model returned no parseable JSON' }] };

    // Retry once on validation failure
    if (!validResult.ok && parsed !== null) {
      const errorList = validResult.errors.map((e) => `- ${e.path}: ${e.message}`).join('\n');
      const retryPrompt =
        `${userPrompt}\n\nThe previous response had these validation errors:\n${errorList}\n\n` +
        `Fix all errors and return only the corrected JSON.`;
      try {
        const retryText = await callTextModel(systemPrompt, retryPrompt, {
          maxTokens: 8192,
          createdBy: req.user!.id,
          images: processedImages,
        });
        const retried = extractJson(retryText);
        if (retried) {
          parsed = retried;
          validResult = validateTemplate(parsed);
        }
      } catch { /* use original error */ }
    }

    // Auto-fix: drop unknown keys, clamp radius, fix fonts, fill missing tokens
    if (!validResult.ok && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsed = autoFixTheme(parsed as Record<string, unknown>);
      validResult = validateTemplate(parsed);
    }

    if (!validResult.ok) {
      sendJson(res, 422, { error: 'Generated theme failed validation', errors: validResult.errors });
      return;
    }

    const theme = parsed as ThemeTemplate;

    // Force a fresh id: slugify name + random suffix, never a built-in id, unique against existing
    const slugBase = theme.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28) || 'ai-theme';
    let newId: string;
    let attempts = 0;
    do {
      const suffix = Math.random().toString(36).slice(2, 7);
      newId = `${slugBase}-${suffix}`;
      attempts++;
    } while (
      attempts < 20 &&
      (BUILTIN_THEMES.has(newId) || !!(await getThemesRepository().getCustomById(newId)))
    );
    theme.id = newId;

    // Clamp name to 60 chars
    theme.name = theme.name.slice(0, 60);

    // Sanitize SVG logos if present
    if (theme.brand.logoSvg) theme.brand.logoSvg = sanitizeSvg(theme.brand.logoSvg);
    if (theme.brand.faviconSvg) theme.brand.faviconSvg = sanitizeSvg(theme.brand.faviconSvg);

    // Contrast check and auto-fix
    const contrastWarnings = fixContrastPairs(theme);
    warnings.push(...contrastWarnings);

    sendJson(res, 200, { ok: true, theme, warnings });
  }));

  // ── Admin: GET /api/admin/themes/validate (must come before :id route) ────
  router.post('/api/admin/themes/validate', requireAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;
    const body = req.body;
    const result = validateTemplate(body);
    sendJson(res, 200, result);
  }));

  // ── Admin: POST /api/admin/themes/import ─────────────────────────────────
  router.post('/api/admin/themes/import', requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    let parsed: unknown = req.body;

    // If body is a string, try parsing it as JSON
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { throw badRequest('Invalid JSON'); }
    }

    const result = validateTemplate(parsed);
    if (!result.ok) {
      sendJson(res, 422, { error: 'Template validation failed', errors: result.errors });
      return;
    }

    const template = parsed as ThemeTemplate;

    // Check for built-in id collision
    if (BUILTIN_THEMES.has(template.id)) {
      throw badRequest(`Cannot import with built-in id "${template.id}"`);
    }

    // Sanitise SVGs if present
    if (template.brand.logoSvg) {
      template.brand.logoSvg = sanitizeSvg(template.brand.logoSvg);
    }
    if (template.brand.faviconSvg) {
      template.brand.faviconSvg = sanitizeSvg(template.brand.faviconSvg);
    }

    const db = getDb();
    const existing = await getThemesRepository().getCustomById(template.id);
    const ts = now();

    if (existing) {
      await getThemesRepository().update(template.id, {
        name: template.name,
        template_json: JSON.stringify(template),
        updated_at: ts,
        updated_by: req.user!.id,
      });
    } else {
      await getThemesRepository().create({
        id: template.id,
        name: template.name,
        template_json: JSON.stringify(template),
        builtin_override: 0,
        created_by: req.user!.id,
        updated_by: req.user!.id,
        created_at: ts,
        updated_at: ts,
      });
    }

    appendAudit(db, req.user!.id, 'theme.import', `theme:${template.id}`, { name: template.name }, req.ip);
    sendJson(res, 201, { ok: true, id: template.id, theme: template });
  }));

  // ── Admin: POST /api/admin/themes ─────────────────────────────────────────
  router.post('/api/admin/themes', requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const body = req.body;
    const result = validateTemplate(body);
    if (!result.ok) {
      sendJson(res, 422, { error: 'Template validation failed', errors: result.errors });
      return;
    }

    const template = body as ThemeTemplate;

    if (BUILTIN_THEMES.has(template.id)) {
      throw badRequest(`Cannot create a custom template with the built-in id "${template.id}"`);
    }

    const existing = await getThemesRepository().getCustomById(template.id);
    if (existing) {
      throw badRequest(`A template with id "${template.id}" already exists`);
    }

    // Sanitise SVGs
    if (template.brand.logoSvg) {
      template.brand.logoSvg = sanitizeSvg(template.brand.logoSvg);
    }
    if (template.brand.faviconSvg) {
      template.brand.faviconSvg = sanitizeSvg(template.brand.faviconSvg);
    }

    const db = getDb();
    const ts = now();
    await getThemesRepository().create({
      id: template.id,
      name: template.name,
      template_json: JSON.stringify(template),
      builtin_override: 0,
      created_by: req.user!.id,
      updated_by: req.user!.id,
      created_at: ts,
      updated_at: ts,
    });

    appendAudit(db, req.user!.id, 'theme.create', `theme:${template.id}`, { name: template.name }, req.ip);
    sendJson(res, 201, { ok: true, id: template.id, theme: template });
  }));

  // ── Admin: GET /api/admin/themes/fonts ───────────────────────────────────
  router.get('/api/admin/themes/fonts', requireAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;
    sendJson(res, 200, {
      fonts: FONT_ALLOW_LIST.map((name) => ({
        name,
        bundled: BUNDLED_FONT_NAMES.has(name),
        stack: FONT_STACKS[name] || name,
      })),
    });
  }));

  // ── Admin: GET /api/admin/themes/:id ─────────────────────────────────────
  router.get('/api/admin/themes/:id', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    // Check built-ins
    const builtin = BUILTIN_THEMES.get(id);
    if (builtin) {
      const overrideRow = await getThemesRepository().getOverrideById(id);
      let template: ThemeTemplate = builtin;
      if (overrideRow) {
        try { template = JSON.parse(overrideRow.template_json) as ThemeTemplate; } catch { template = builtin; }
      }
      sendJson(res, 200, {
        id: builtin.id,
        name: template.name,
        builtIn: true,
        overridden: !!overrideRow,
        active: getActiveThemeId() === id,
        updatedAt: overrideRow ? overrideRow.updated_at : null,
        updatedBy: overrideRow ? overrideRow.updated_by : null,
        template,
        defaults: builtin,
      });
      return;
    }

    const row = await getThemesRepository().getCustomById(id);
    if (!row) throw notFound('Theme not found');

    let template: unknown;
    try { template = JSON.parse(row.template_json); } catch { template = null; }

    sendJson(res, 200, {
      id: row.id,
      name: row.name,
      builtIn: false,
      active: getActiveThemeId() === id,
      updatedAt: row.updated_at || null,
      updatedBy: row.updated_by || null,
      template,
    });
  }));

  // ── Admin: PUT /api/admin/themes/:id ─────────────────────────────────────
  router.put('/api/admin/themes/:id', requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    const body = req.body;

    // id in body must match path id
    if (!body || typeof (body as Record<string, unknown>).id !== 'string' || (body as Record<string, unknown>).id !== id) {
      sendJson(res, 400, { error: 'Template id in body must match the path id' });
      return;
    }

    const result = validateTemplate(body);
    if (!result.ok) {
      sendJson(res, 422, { error: 'Template validation failed', errors: result.errors });
      return;
    }

    const template = body as ThemeTemplate;

    // Sanitise SVGs
    if (template.brand.logoSvg) {
      template.brand.logoSvg = sanitizeSvg(template.brand.logoSvg);
    }
    if (template.brand.faviconSvg) {
      template.brand.faviconSvg = sanitizeSvg(template.brand.faviconSvg);
    }

    const db = getDb();
    const ts = now();

    if (BUILTIN_THEMES.has(id)) {
      // Store or update the built-in override
      const existingOverride = await getThemesRepository().getOverrideById(id);
      if (existingOverride) {
        await getThemesRepository().update(id, {
          name: template.name,
          template_json: JSON.stringify(template),
          updated_at: ts,
          updated_by: req.user!.id,
        });
      } else {
        await getThemesRepository().create({
          id,
          name: template.name,
          template_json: JSON.stringify(template),
          builtin_override: 1,
          created_by: req.user!.id,
          updated_by: req.user!.id,
          created_at: ts,
          updated_at: ts,
        });
      }
      appendAudit(db, req.user!.id, 'theme.update', `theme:${id}`, { name: template.name, builtinOverride: true }, req.ip);
      if (getActiveThemeId() === id) {
        const { etag } = await resolveActiveTemplate();
        emitGlobal({ type: 'theme.changed', etag });
      }
      sendJson(res, 200, { ok: true, id, theme: template });
      return;
    }

    const existing = await getThemesRepository().getCustomById(id);
    if (!existing) throw notFound('Theme not found');

    await getThemesRepository().update(id, {
      name: template.name,
      template_json: JSON.stringify(template),
      updated_at: ts,
      updated_by: req.user!.id,
    });

    appendAudit(db, req.user!.id, 'theme.update', `theme:${id}`, { name: template.name }, req.ip);

    // Emit event so open clients can refresh if this is the active theme
    if (getActiveThemeId() === id) {
      const { etag } = await resolveActiveTemplate();
      emitGlobal({ type: 'theme.changed', etag });
    }

    sendJson(res, 200, { ok: true, id, theme: template });
  }));

  // ── Admin: DELETE /api/admin/themes/:id/override — reset built-in to shipped default ──
  router.delete('/api/admin/themes/:id/override', requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    if (!BUILTIN_THEMES.has(id)) {
      throw notFound('Not a built-in theme');
    }

    const existing = await getThemesRepository().getOverrideById(id);
    if (!existing) {
      throw notFound('No override exists for this theme');
    }

    const db = getDb();
    await getThemesRepository().delete(id);
    appendAudit(db, req.user!.id, 'theme.reset', `theme:${id}`, {}, req.ip);

    if (getActiveThemeId() === id) {
      const { etag } = await resolveActiveTemplate();
      emitGlobal({ type: 'theme.changed', etag });
    }

    sendJson(res, 200, { ok: true });
  }));

  // ── Admin: DELETE /api/admin/themes/:id ───────────────────────────────────
  router.delete('/api/admin/themes/:id', requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    if (BUILTIN_THEMES.has(id)) {
      throw forbidden('Built-in templates cannot be deleted');
    }

    const existing = await getThemesRepository().getCustomById(id);
    if (!existing) throw notFound('Theme not found');

    if (getActiveThemeId() === id) {
      throw badRequest('Cannot delete the active template. Activate another template first.');
    }

    const db = getDb();
    await getThemesRepository().delete(id);
    appendAudit(db, req.user!.id, 'theme.delete', `theme:${id}`, {}, req.ip);
    sendJson(res, 200, { ok: true });
  }));

  // ── Admin: POST /api/admin/themes/:id/activate ────────────────────────────
  router.post('/api/admin/themes/:id/activate', requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    // Verify theme exists (built-in or custom)
    const isBuiltin = BUILTIN_THEMES.has(id);
    if (!isBuiltin) {
      const existing = await getThemesRepository().getCustomById(id);
      if (!existing) throw notFound('Theme not found');
    }

    const db = getDb();
    await setSetting(db, 'theme.active', JSON.stringify(id));
    appendAudit(db, req.user!.id, 'theme.activate', `theme:${id}`, {}, req.ip);
    const { etag } = await resolveActiveTemplate();
    emitGlobal({ type: 'theme.changed', etag });

    sendJson(res, 200, { ok: true, activeId: id });
  }));

  // ── Admin: POST /api/admin/themes/:id/duplicate ───────────────────────────
  router.post('/api/admin/themes/:id/duplicate', requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    let sourceTemplate: ThemeTemplate;
    const builtin = BUILTIN_THEMES.get(id);
    if (builtin) {
      const overrideRow = await getThemesRepository().getOverrideById(id);
      if (overrideRow) {
        try { sourceTemplate = JSON.parse(overrideRow.template_json) as ThemeTemplate; } catch { sourceTemplate = { ...builtin }; }
      } else {
        sourceTemplate = { ...builtin };
      }
    } else {
      const row = await getThemesRepository().getCustomById(id);
      if (!row) throw notFound('Theme not found');
      try {
        sourceTemplate = JSON.parse(row.template_json) as ThemeTemplate;
      } catch {
        throw badRequest('Source template data is invalid');
      }
    }

    // Generate a new id
    const baseId = `${id}-copy`;
    let newId = baseId;
    let suffix = 1;
    while (BUILTIN_THEMES.has(newId) || await getThemesRepository().getCustomById(newId)) {
      newId = `${baseId}-${suffix++}`;
    }

    const copy: ThemeTemplate = {
      ...sourceTemplate,
      id: newId,
      name: `${sourceTemplate.name} (copy)`,
      version: sourceTemplate.version,
    };

    const db = getDb();
    const ts = now();
    await getThemesRepository().create({
      id: copy.id,
      name: copy.name,
      template_json: JSON.stringify(copy),
      builtin_override: 0,
      created_by: req.user!.id,
      updated_by: req.user!.id,
      created_at: ts,
      updated_at: ts,
    });

    appendAudit(db, req.user!.id, 'theme.duplicate', `theme:${newId}`, { sourceId: id }, req.ip);
    sendJson(res, 201, { ok: true, id: newId, theme: copy });
  }));

  // ── Admin: GET /api/admin/themes/:id/export ───────────────────────────────
  router.get('/api/admin/themes/:id/export', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    let template: ThemeTemplate;
    const builtin = BUILTIN_THEMES.get(id);
    if (builtin) {
      const overrideRow = await getThemesRepository().getOverrideById(id);
      if (overrideRow) {
        try { template = JSON.parse(overrideRow.template_json) as ThemeTemplate; } catch { template = builtin; }
      } else {
        template = builtin;
      }
    } else {
      const row = await getThemesRepository().getCustomById(id);
      if (!row) throw notFound('Theme not found');
      try {
        template = JSON.parse(row.template_json) as ThemeTemplate;
      } catch {
        throw badRequest('Template data is invalid');
      }
    }

    const json = JSON.stringify(template, null, 2);
    const filename = `theme-${id}.json`;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }));
}
