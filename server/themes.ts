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
import { all, one, run, getDb } from './db.ts';
import type { Row } from './db.ts';
import { getSetting, setSetting } from './settings.ts';
import { appendAudit } from './audit.ts';
import { emitGlobal } from './events.ts';
import { generateId, now, notFound, badRequest, forbidden } from './util.ts';
import aethrixNightJson from '../shared/themes/aethrix-night.json' with { type: 'json' };
import classicTealJson from '../shared/themes/classic-teal.json' with { type: 'json' };

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
  'Exo 2', 'Orbitron', 'Nunito', 'Urbanist',
  // Body
  'Inter', 'Source Sans 3', 'Noto Sans', 'Lato', 'Roboto',
  // Mono
  'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Cascadia Code',
  // System stacks
  'system-ui', 'ui-sans-serif', 'ui-monospace', 'ui-serif',
  'serif', 'sans-serif', 'monospace', '-apple-system',
];

const FONT_ALLOW_SET = new Set(FONT_ALLOW_LIST);

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
export const BUILTIN_THEMES: ReadonlyMap<string, ThemeTemplate> = new Map([
  [AETHRIX_NIGHT.id, AETHRIX_NIGHT],
  [CLASSIC_TEAL.id, CLASSIC_TEAL],
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
export function resolveActiveTemplate(): { template: ThemeTemplate; etag: string; updatedAt: string | null } {
  const activeId = getActiveThemeId();

  // Check built-ins first
  const builtin = BUILTIN_THEMES.get(activeId);
  if (builtin) {
    return {
      template: builtin,
      etag: BUILTIN_ETAGS.get(activeId) ?? `"builtin-${activeId}"`,
      updatedAt: null,
    };
  }

  // Check custom DB themes
  const row = one<Row>('SELECT template_json, updated_at FROM themes WHERE id = ?', activeId);
  if (row) {
    try {
      const template = JSON.parse(String(row.template_json)) as ThemeTemplate;
      const updatedAt = String(row.updated_at);
      const etag = `"${activeId}-${createHash('sha256').update(String(row.template_json)).digest('hex').slice(0, 16)}"`;
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

// ── Route registration ────────────────────────────────────────────────────────

export function registerThemeRoutes(): void {

  // ── Public: GET /api/theme ────────────────────────────────────────────────
  router.get('/api/theme', (req: PortalRequest, res: PortalResponse) => {
    const { template, etag, updatedAt } = resolveActiveTemplate();

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
  router.get('/api/admin/themes', requireAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const activeId = getActiveThemeId();
    const customRows = all<Row>('SELECT id, name, updated_at, updated_by FROM themes ORDER BY updated_at DESC');

    const builtins = Array.from(BUILTIN_THEMES.values()).map((t) => ({
      id: t.id,
      name: t.name,
      builtIn: true,
      active: t.id === activeId,
      updatedAt: null,
      updatedBy: null,
    }));

    const customs = customRows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      builtIn: false,
      active: String(r.id) === activeId,
      updatedAt: r.updated_at ? String(r.updated_at) : null,
      updatedBy: r.updated_by ? String(r.updated_by) : null,
    }));

    sendJson(res, 200, { themes: [...builtins, ...customs] });
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
    const existing = one<Row>('SELECT id FROM themes WHERE id = ?', template.id);
    const ts = now();

    if (existing) {
      // Update existing
      run(
        'UPDATE themes SET name = ?, template_json = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        template.name,
        JSON.stringify(template),
        ts,
        req.user!.id,
        template.id,
      );
    } else {
      run(
        'INSERT INTO themes (id, name, template_json, created_by, updated_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        template.id,
        template.name,
        JSON.stringify(template),
        req.user!.id,
        req.user!.id,
        ts,
        ts,
      );
    }

    appendAudit(db, req.user!.id, 'theme.import', `theme:${template.id}`, { name: template.name }, req.ip);
    sendJson(res, 201, { ok: true, id: template.id, theme: template });
  }));

  // ── Admin: POST /api/admin/themes ─────────────────────────────────────────
  router.post('/api/admin/themes', requireCookieAuth((req: PortalRequest, res: PortalResponse) => {
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

    const existing = one<Row>('SELECT id FROM themes WHERE id = ?', template.id);
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
    run(
      'INSERT INTO themes (id, name, template_json, created_by, updated_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      template.id,
      template.name,
      JSON.stringify(template),
      req.user!.id,
      req.user!.id,
      ts,
      ts,
    );

    appendAudit(db, req.user!.id, 'theme.create', `theme:${template.id}`, { name: template.name }, req.ip);
    sendJson(res, 201, { ok: true, id: template.id, theme: template });
  }));

  // ── Admin: GET /api/admin/themes/fonts ───────────────────────────────────
  router.get('/api/admin/themes/fonts', requireAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;
    sendJson(res, 200, {
      fonts: FONT_ALLOW_LIST,
      bundled: ['Space Grotesk', 'Inter', 'JetBrains Mono'],
    });
  }));

  // ── Admin: GET /api/admin/themes/:id ─────────────────────────────────────
  router.get('/api/admin/themes/:id', requireAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    // Check built-ins
    const builtin = BUILTIN_THEMES.get(id);
    if (builtin) {
      sendJson(res, 200, {
        id: builtin.id,
        name: builtin.name,
        builtIn: true,
        active: getActiveThemeId() === id,
        updatedAt: null,
        updatedBy: null,
        template: builtin,
      });
      return;
    }

    const row = one<Row>('SELECT * FROM themes WHERE id = ?', id);
    if (!row) throw notFound('Theme not found');

    let template: unknown;
    try { template = JSON.parse(String(row.template_json)); } catch { template = null; }

    sendJson(res, 200, {
      id: String(row.id),
      name: String(row.name),
      builtIn: false,
      active: getActiveThemeId() === id,
      updatedAt: row.updated_at ? String(row.updated_at) : null,
      updatedBy: row.updated_by ? String(row.updated_by) : null,
      template,
    });
  }));

  // ── Admin: PUT /api/admin/themes/:id ─────────────────────────────────────
  router.put('/api/admin/themes/:id', requireCookieAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    if (BUILTIN_THEMES.has(id)) {
      throw forbidden('Built-in templates cannot be edited. Use duplicate to create a copy.');
    }

    const existing = one<Row>('SELECT id FROM themes WHERE id = ?', id);
    if (!existing) throw notFound('Theme not found');

    const body = req.body;
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
    run(
      'UPDATE themes SET name = ?, template_json = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      template.name,
      JSON.stringify(template),
      ts,
      req.user!.id,
      id,
    );

    appendAudit(db, req.user!.id, 'theme.update', `theme:${id}`, { name: template.name }, req.ip);

    // Emit event so open clients can refresh if this is the active theme
    if (getActiveThemeId() === id) {
      const { etag } = resolveActiveTemplate();
      emitGlobal({ type: 'theme.changed', etag });
    }

    sendJson(res, 200, { ok: true, id, theme: template });
  }));

  // ── Admin: DELETE /api/admin/themes/:id ───────────────────────────────────
  router.delete('/api/admin/themes/:id', requireCookieAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    if (BUILTIN_THEMES.has(id)) {
      throw forbidden('Built-in templates cannot be deleted');
    }

    const existing = one<Row>('SELECT id FROM themes WHERE id = ?', id);
    if (!existing) throw notFound('Theme not found');

    if (getActiveThemeId() === id) {
      throw badRequest('Cannot delete the active template. Activate another template first.');
    }

    const db = getDb();
    run('DELETE FROM themes WHERE id = ?', id);
    appendAudit(db, req.user!.id, 'theme.delete', `theme:${id}`, {}, req.ip);
    sendJson(res, 200, { ok: true });
  }));

  // ── Admin: POST /api/admin/themes/:id/activate ────────────────────────────
  router.post('/api/admin/themes/:id/activate', requireCookieAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    // Verify theme exists (built-in or custom)
    const isBuiltin = BUILTIN_THEMES.has(id);
    if (!isBuiltin) {
      const existing = one<Row>('SELECT id FROM themes WHERE id = ?', id);
      if (!existing) throw notFound('Theme not found');
    }

    const db = getDb();
    setSetting(db, 'theme.active', JSON.stringify(id));
    appendAudit(db, req.user!.id, 'theme.activate', `theme:${id}`, {}, req.ip);
    const { etag } = resolveActiveTemplate();
    emitGlobal({ type: 'theme.changed', etag });

    sendJson(res, 200, { ok: true, activeId: id });
  }));

  // ── Admin: POST /api/admin/themes/:id/duplicate ───────────────────────────
  router.post('/api/admin/themes/:id/duplicate', requireCookieAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    let sourceTemplate: ThemeTemplate;
    const builtin = BUILTIN_THEMES.get(id);
    if (builtin) {
      sourceTemplate = { ...builtin };
    } else {
      const row = one<Row>('SELECT template_json FROM themes WHERE id = ?', id);
      if (!row) throw notFound('Theme not found');
      try {
        sourceTemplate = JSON.parse(String(row.template_json)) as ThemeTemplate;
      } catch {
        throw badRequest('Source template data is invalid');
      }
    }

    // Generate a new id
    const baseId = `${id}-copy`;
    let newId = baseId;
    let suffix = 1;
    while (BUILTIN_THEMES.has(newId) || one<Row>('SELECT id FROM themes WHERE id = ?', newId)) {
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
    run(
      'INSERT INTO themes (id, name, template_json, created_by, updated_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      copy.id,
      copy.name,
      JSON.stringify(copy),
      req.user!.id,
      req.user!.id,
      ts,
      ts,
    );

    appendAudit(db, req.user!.id, 'theme.duplicate', `theme:${newId}`, { sourceId: id }, req.ip);
    sendJson(res, 201, { ok: true, id: newId, theme: copy });
  }));

  // ── Admin: GET /api/admin/themes/:id/export ───────────────────────────────
  router.get('/api/admin/themes/:id/export', requireAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const { id } = req.params;

    let template: ThemeTemplate;
    const builtin = BUILTIN_THEMES.get(id);
    if (builtin) {
      template = builtin;
    } else {
      const row = one<Row>('SELECT template_json FROM themes WHERE id = ?', id);
      if (!row) throw notFound('Theme not found');
      try {
        template = JSON.parse(String(row.template_json)) as ThemeTemplate;
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
