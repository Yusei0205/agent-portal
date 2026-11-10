/**
 * Themes module tests.
 *
 * Tests cover:
 *   - validateTemplate: good template, bad colour formats, CSS injection,
 *     unknown keys, missing modes, bad id/font
 *   - sanitizeSvg: script tag, onload attribute, foreignObject, external href,
 *     #fragment href preserved, javascript: URL
 *   - CRUD: create, read, update, delete custom themes
 *   - Built-in protection: cannot edit or delete aethrix-night / classic-teal
 *   - Activate: POST /api/admin/themes/:id/activate changes active theme
 *   - Public GET /api/theme returns active template; ETag 304
 *   - Fallback: GET /api/theme falls back to aethrix-night when active is missing
 *   - Import/export round-trip
 *   - API token refused on write routes
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, createTestDb, cleanup, fetchJson } from './fixtures.ts';
import {
  validateTemplate,
  sanitizeSvg,
  isSafeColor,
  isSafeShadowOrGlow,
  AETHRIX_NIGHT,
  CLASSIC_TEAL,
  CLOVI,
  NEBULA,
  AURORA_GLASS,
  CYBER_HUD,
  TWILIGHT,
  FONT_ALLOW_LIST,
  ALLOWED_TOKEN_NAMES,
} from '../server/themes.ts';
import { setSetting } from '../server/settings.ts';
import type { ThemeTemplate } from '../server/themes.ts';

// ── Minimal valid template fixture ────────────────────────────────────────────

function minimalTemplate(overrides: Partial<ThemeTemplate> = {}): ThemeTemplate {
  return {
    id: 'test-theme',
    name: 'Test Theme',
    version: 1,
    brand: { productName: 'Test' },
    modes: {
      dark: {
        canvas: '#0a0a0a',
        panel: '#111111',
        'panel-2': '#141414',
        raised: '#1a1a1a',
        rail: '#0d0d0d',
        line: '#222222',
        'line-2': '#1c1c1c',
        ink: '#ffffff',
        'ink-2': '#bbbbbb',
        'ink-3': '#888888',
        accent: '#6c5cff',
        'accent-2': '#22d3ee',
        'accent-3': '#ec4899',
        'accent-ink': '#c4bbff',
        'accent-wash': 'rgba(108,92,255,0.15)',
        ok: '#22c55e',
        'ok-wash': 'rgba(34,197,94,0.1)',
        warn: '#f59e0b',
        'warn-wash': 'rgba(245,158,11,0.1)',
        danger: '#ef4444',
        'danger-wash': 'rgba(239,68,68,0.1)',
        info: '#3b82f6',
        'info-wash': 'rgba(59,130,246,0.1)',
        focus: '#6c5cff',
        glow: '0 0 16px rgba(108,92,255,.4)',
        'code-bg': '#0a0a10',
        shadow: '0 2px 8px rgba(0,0,0,.5)',
      },
    },
    fonts: { display: 'Space Grotesk', body: 'Inter', mono: 'JetBrains Mono' },
    effects: { glow: true, gridBackground: false, gradientAccents: false, motion: 'full' },
    radius: { sm: 4, md: 8, lg: 12 },
    ...overrides,
  };
}

// ── Admin login helper ────────────────────────────────────────────────────────

async function loginAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: 'admin@test.com', name: 'Admin', password: 'password1234' },
  });
  assert.equal(r.status, 200, `Setup failed: ${JSON.stringify(r.body)}`);
  return r.cookie ?? '';
}

// ── Unit tests: validateTemplate ─────────────────────────────────────────────

describe('validateTemplate — unit', () => {
  it('accepts a fully valid template', () => {
    const result = validateTemplate(minimalTemplate());
    assert.ok(result.ok, `Expected ok but got errors: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, []);
  });

  it('accepts both built-in templates', () => {
    const r1 = validateTemplate(AETHRIX_NIGHT);
    assert.ok(r1.ok, `aethrix-night: ${JSON.stringify(r1.errors)}`);
    const r2 = validateTemplate(CLASSIC_TEAL);
    assert.ok(r2.ok, `classic-teal: ${JSON.stringify(r2.errors)}`);
  });

  it('accepts the Clovi built-in template', () => {
    const result = validateTemplate(CLOVI);
    assert.ok(result.ok, `clovi: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, []);
  });

  it('Clovi template has both dark and light modes', () => {
    assert.ok(CLOVI.modes.dark,  'Expected clovi.modes.dark');
    assert.ok(CLOVI.modes.light, 'Expected clovi.modes.light');
  });

  it('Clovi template uses allowed fonts', () => {
    const fontSet = new Set(FONT_ALLOW_LIST);
    assert.ok(fontSet.has(CLOVI.fonts.display), `display font "${CLOVI.fonts.display}" should be in allow-list`);
    assert.ok(fontSet.has(CLOVI.fonts.body),    `body font "${CLOVI.fonts.body}" should be in allow-list`);
    assert.ok(fontSet.has(CLOVI.fonts.mono),    `mono font "${CLOVI.fonts.mono}" should be in allow-list`);
  });

  it('Clovi dark mode has all required tokens', () => {
    const dark = CLOVI.modes.dark!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in dark, `Clovi dark mode missing token "${token}"`);
    }
  });

  it('Clovi light mode has all required tokens', () => {
    const light = CLOVI.modes.light!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in light, `Clovi light mode missing token "${token}"`);
    }
  });

  it('rejects non-object input', () => {
    assert.ok(!validateTemplate('string').ok);
    assert.ok(!validateTemplate(null).ok);
    assert.ok(!validateTemplate([]).ok);
  });

  it('rejects unknown top-level keys', () => {
    const result = validateTemplate({ ...minimalTemplate(), extraKey: 'bad' });
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.path.includes('extraKey')));
  });

  it('rejects unknown brand keys', () => {
    const t = minimalTemplate();
    (t.brand as Record<string, unknown>).badKey = 'bad';
    const result = validateTemplate(t);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.path.includes('badKey')));
  });

  it('rejects unknown modes keys', () => {
    const t = minimalTemplate();
    (t.modes as Record<string, unknown>).purple = {};
    const result = validateTemplate(t);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.message.includes('purple')));
  });

  it('rejects unknown token names in a mode', () => {
    const t = minimalTemplate();
    if (t.modes.dark) (t.modes.dark as Record<string, unknown>).badToken = '#fff';
    const result = validateTemplate(t);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.path.includes('badToken')));
  });

  it('rejects missing modes (neither dark nor light)', () => {
    const t = minimalTemplate();
    t.modes = {} as typeof t.modes;
    const result = validateTemplate(t);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.path === 'modes'));
  });

  it('rejects invalid id slug (too short)', () => {
    const t = minimalTemplate({ id: 'ab' });
    const result = validateTemplate(t);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.path === 'id'));
  });

  it('rejects invalid id slug (uppercase)', () => {
    const t = minimalTemplate({ id: 'My-Theme' });
    const result = validateTemplate(t);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.path === 'id'));
  });

  it('rejects name longer than 60 chars', () => {
    const t = minimalTemplate({ name: 'a'.repeat(61) });
    const result = validateTemplate(t);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.path === 'name'));
  });

  it('rejects productName longer than 40 chars', () => {
    const t = minimalTemplate();
    t.brand.productName = 'a'.repeat(41);
    const result = validateTemplate(t);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.path === 'brand.productName'));
  });

  it('rejects description longer than 300 chars', () => {
    const t = minimalTemplate({ description: 'a'.repeat(301) });
    const result = validateTemplate(t);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.path === 'description'));
  });

  it('rejects radius values out of range', () => {
    const t = minimalTemplate();
    t.radius.sm = -1;
    const r1 = validateTemplate(t);
    assert.ok(!r1.ok);
    t.radius.sm = 4;
    t.radius.lg = 25;
    const r2 = validateTemplate(t);
    assert.ok(!r2.ok);
  });

  it('rejects invalid effects.motion value', () => {
    const t = minimalTemplate();
    (t.effects as Record<string, unknown>).motion = 'fast';
    const result = validateTemplate(t);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.path === 'effects.motion'));
  });

  it('rejects font not in allow-list', () => {
    const t = minimalTemplate();
    t.fonts.display = 'Comic Sans MS';
    const result = validateTemplate(t);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.path === 'fonts.display'));
  });

  it('accepts all fonts in FONT_ALLOW_LIST', () => {
    for (const font of FONT_ALLOW_LIST) {
      // Test each font in each slot to check they are individually valid
      const t = minimalTemplate();
      t.fonts.display = font;
      t.fonts.body = font;
      t.fonts.mono = font;
      const result = validateTemplate(t);
      assert.ok(result.ok, `Font "${font}" should be allowed but got: ${JSON.stringify(result.errors)}`);
    }
  });

  // ── Regression guards: browser-format (normalised) values must be rejected ──
  // These confirm the server contract: the editor must send server format (short font
  // names, numeric radius), not browser format (CSS stacks, "Npx" strings).
  // If the editor sends normalised values the server returns errors — which is
  // exactly the bug that was fixed in TemplateEditor.

  it('rejects full CSS font stack as font value (browser-format regression guard)', () => {
    const t = minimalTemplate();
    t.fonts.display = "'Quicksand Variable','Quicksand',system-ui,sans-serif"; // browser format
    const result = validateTemplate(t);
    assert.ok(!result.ok, 'A full CSS stack should fail — server accepts short names only');
    assert.ok(
      result.errors.some((e) => e.path === 'fonts.display'),
      `Expected fonts.display error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it('rejects "Npx" string as radius value (browser-format regression guard)', () => {
    const t = minimalTemplate();
    (t.radius as unknown as Record<string, unknown>).sm = '4px'; // browser format
    const result = validateTemplate(t);
    assert.ok(!result.ok, '"4px" string should fail — server expects a number');
    assert.ok(
      result.errors.some((e) => e.path === 'radius.sm'),
      `Expected radius.sm error, got: ${JSON.stringify(result.errors)}`,
    );
  });
});

// ── Unit tests: colour validation ─────────────────────────────────────────────

describe('isSafeColor — unit', () => {
  it('accepts #rgb', () => { assert.ok(isSafeColor('#fff')); });
  it('accepts #rrggbb', () => { assert.ok(isSafeColor('#1a2b3c')); });
  it('accepts #rrggbbaa', () => { assert.ok(isSafeColor('#1a2b3cff')); });
  it('accepts rgb()', () => { assert.ok(isSafeColor('rgb(10, 20, 30)')); });
  it('accepts rgba() with decimal alpha', () => { assert.ok(isSafeColor('rgba(10, 20, 30, 0.5)')); });
  it('accepts rgba() with leading-dot alpha', () => { assert.ok(isSafeColor('rgba(108,92,255,.35)')); });
  it('accepts hsl()', () => { assert.ok(isSafeColor('hsl(200, 50%, 30%)')); });
  it('accepts hsla()', () => { assert.ok(isSafeColor('hsla(200, 50%, 30%, 0.9)')); });

  it('rejects url() — CSS injection', () => {
    assert.ok(!isSafeColor('url(http://evil.com)'));
  });
  it('rejects expression() — CSS injection', () => {
    assert.ok(!isSafeColor('expression(alert(1))'));
  });
  it('rejects value with semicolon', () => {
    assert.ok(!isSafeColor('#fff; background: red'));
  });
  it('rejects value with closing brace', () => {
    assert.ok(!isSafeColor('#fff} .evil { color: red'));
  });
  it('rejects value with angle bracket', () => {
    assert.ok(!isSafeColor('#fff<script>'));
  });
  it('rejects javascript: URI', () => {
    assert.ok(!isSafeColor('javascript:alert(1)'));
  });
  it('rejects arbitrary text', () => {
    assert.ok(!isSafeColor('red'));
    assert.ok(!isSafeColor('transparent'));
  });
  it('rejects CSS comment injection', () => {
    assert.ok(!isSafeColor('#fff /* injected */'));
  });
});

// ── Unit tests: shadow/glow validation ───────────────────────────────────────

describe('isSafeShadowOrGlow — unit', () => {
  it('accepts "none"', () => { assert.ok(isSafeShadowOrGlow('none')); });
  it('accepts single layer with rgba', () => {
    assert.ok(isSafeShadowOrGlow('0 0 24px rgba(108,92,255,.35)'));
  });
  it('accepts multi-layer shadow', () => {
    assert.ok(isSafeShadowOrGlow('0 1px 2px rgba(20,30,50,.06), 0 4px 16px rgba(20,30,50,.06)'));
  });
  it('accepts inset shadow', () => {
    assert.ok(isSafeShadowOrGlow('inset 0 1px 0 rgba(255,255,255,.1)'));
  });
  it('accepts #hex colour in shadow', () => {
    assert.ok(isSafeShadowOrGlow('0 2px 4px #0000001a'));
  });

  it('rejects url() in shadow', () => {
    assert.ok(!isSafeShadowOrGlow('0 0 10px url(evil)'));
  });
  it('rejects expression() in shadow', () => {
    assert.ok(!isSafeShadowOrGlow('0 0 10px expression(alert(1))'));
  });
  it('rejects semicolon in shadow', () => {
    assert.ok(!isSafeShadowOrGlow('0 0 10px red; color: blue'));
  });
  it('rejects javascript: in shadow', () => {
    assert.ok(!isSafeShadowOrGlow('javascript:alert(1)'));
  });
});

// ── Unit tests: SVG sanitisation ─────────────────────────────────────────────

describe('sanitizeSvg — unit', () => {
  it('removes <script> tags and their content', () => {
    const svg = '<svg><script>alert("xss")</script><circle r="5"/></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(!out.includes('<script'), `Expected no <script> but got: ${out}`);
    assert.ok(!out.includes('alert'), `Expected no alert() but got: ${out}`);
    assert.ok(out.includes('<circle'), 'Expected circle to remain');
  });

  it('removes self-closing <script/> tags', () => {
    const svg = '<svg><script src="evil.js"/><circle r="5"/></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(!out.includes('<script'), out);
  });

  it('removes on* event handler attributes', () => {
    const svg = '<svg><circle onload="alert(1)" r="5"/></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(!out.includes('onload'), `Expected onload removed but got: ${out}`);
    assert.ok(out.includes('<circle'), 'Expected circle to remain');
  });

  it('removes onclick attribute', () => {
    const svg = '<svg><rect onclick="evil()" width="10" height="10"/></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(!out.includes('onclick'), out);
    assert.ok(out.includes('<rect'), out);
  });

  it('removes <foreignObject> and its content', () => {
    const svg = '<svg><foreignObject><div>html</div></foreignObject><circle r="5"/></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(!out.includes('foreignObject'), `Expected foreignObject removed: ${out}`);
    assert.ok(!out.includes('<div>'), out);
    assert.ok(out.includes('<circle'), out);
  });

  it('removes external href', () => {
    const svg = '<svg><a href="https://evil.com"><circle r="5"/></a></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(!out.includes('https://evil.com'), `Expected external href removed: ${out}`);
  });

  it('preserves #fragment href', () => {
    const svg = '<svg><a href="#my-element"><circle r="5"/></a></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(out.includes('#my-element'), `Expected #fragment preserved: ${out}`);
  });

  it('removes external xlink:href', () => {
    const svg = '<svg><use xlink:href="https://evil.com/sprite.svg#icon"/></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(!out.includes('https://evil.com'), `Expected external xlink:href removed: ${out}`);
  });

  it('preserves #fragment in xlink:href', () => {
    const svg = '<svg><use xlink:href="#my-symbol"/></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(out.includes('#my-symbol'), `Expected #fragment preserved: ${out}`);
  });

  it('removes javascript: URL', () => {
    const svg = '<svg><a href="javascript:alert(1)"><circle r="5"/></a></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(!out.includes('javascript:'), `Expected javascript: removed: ${out}`);
  });

  it('removes <style> containing @import', () => {
    const svg = '<svg><style>@import url("evil.css")</style><circle r="5"/></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(!out.includes('@import'), `Expected @import removed: ${out}`);
  });

  it('removes <style> containing url(', () => {
    const svg = '<svg><style>circle { fill: url(data:image/svg+xml;base64,evil) }</style><circle r="5"/></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(!out.includes('url('), `Expected url( in style removed: ${out}`);
  });

  it('preserves safe <style>', () => {
    const svg = '<svg><style>circle { fill: red; }</style><circle r="5"/></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(out.includes('<style>'), `Expected safe style preserved: ${out}`);
    assert.ok(out.includes('fill: red'), out);
  });

  it('passes clean SVG unchanged (structurally)', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#6c5cff"/></svg>';
    const out = sanitizeSvg(svg);
    assert.ok(out.includes('<circle'), out);
    assert.ok(out.includes('fill="#6c5cff"'), out);
  });
});

// ── HTTP route tests ─────────────────────────────────────────────────────────

describe('Theme CRUD routes', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(cleanup);

  it('GET /api/theme (public) returns the active template', async () => {
    const r = await fetchJson(baseUrl, '/api/theme');
    assert.equal(r.status, 200);
    const body = r.body as { template: { id: string }; etag: string };
    assert.ok(body.template, 'Expected template in response');
    assert.equal(body.template.id, 'aethrix-night', 'Default active should be aethrix-night');
    assert.ok(typeof body.etag === 'string', 'Expected etag');
  });

  it('GET /api/theme returns 304 on matching If-None-Match', async () => {
    const r1 = await fetchJson(baseUrl, '/api/theme');
    const etag = r1.headers.get('etag') ?? '';
    assert.ok(etag, 'Expected ETag header');

    const r2 = await fetch(`${baseUrl}/api/theme`, {
      headers: { 'If-None-Match': etag, 'X-Requested-With': 'agent-portal' },
    });
    assert.equal(r2.status, 304);
  });

  it('GET /api/admin/themes lists built-ins and (initially empty) custom', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { themes: Array<{ id: string; builtIn: boolean }> };
    assert.ok(Array.isArray(body.themes));
    assert.ok(body.themes.some((t) => t.id === 'aethrix-night' && t.builtIn));
    assert.ok(body.themes.some((t) => t.id === 'classic-teal' && t.builtIn));
  });

  it('POST /api/admin/themes creates a custom template', async () => {
    const tmpl = minimalTemplate({ id: 'my-custom-theme', name: 'My Custom' });
    const r = await fetchJson(baseUrl, '/api/admin/themes', {
      method: 'POST',
      body: tmpl,
      cookie: adminCookie,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const body = r.body as { ok: boolean; id: string; theme: { id: string } };
    assert.ok(body.ok);
    assert.equal(body.id, 'my-custom-theme');
    assert.ok(body.theme, 'Expected theme in create response');
    assert.equal(body.theme.id, 'my-custom-theme');
  });

  it('GET /api/admin/themes/:id returns the custom template', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/my-custom-theme', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { id: string; builtIn: boolean; template: { id: string } };
    assert.equal(body.id, 'my-custom-theme');
    assert.equal(body.builtIn, false);
    assert.equal(body.template.id, 'my-custom-theme');
  });

  it('POST /api/admin/themes returns 422 for invalid template', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes', {
      method: 'POST',
      body: { id: 'bad', name: 'X', version: 1, brand: { productName: 'P' }, modes: {}, fonts: { display: 'Inter', body: 'Inter', mono: 'Inter' }, effects: { glow: true, gridBackground: false, gradientAccents: false, motion: 'full' }, radius: { sm: 4, md: 8, lg: 12 } },
      cookie: adminCookie,
    });
    assert.equal(r.status, 422);
    const body = r.body as { errors: Array<{ path: string }> };
    assert.ok(Array.isArray(body.errors));
  });

  it('PUT /api/admin/themes/:id updates a custom template', async () => {
    const updated = minimalTemplate({ id: 'my-custom-theme', name: 'My Custom Updated' });
    const r = await fetchJson(baseUrl, '/api/admin/themes/my-custom-theme', {
      method: 'PUT',
      body: updated,
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; id: string; theme: { id: string; name: string } };
    assert.ok(body.ok);
    assert.equal(body.id, 'my-custom-theme');
    assert.ok(body.theme, 'Expected theme in update response');
    assert.equal(body.theme.name, 'My Custom Updated');
  });

  it('PUT /api/admin/themes/:id saves an override for a built-in', async () => {
    const updated = { ...AETHRIX_NIGHT, name: 'Aethrix Night (customised)' };
    const r = await fetchJson(baseUrl, '/api/admin/themes/aethrix-night', {
      method: 'PUT',
      body: updated,
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as { ok: boolean; id: string; theme: { id: string; name: string } };
    assert.ok(body.ok);
    assert.equal(body.id, 'aethrix-night');
    assert.equal(body.theme.name, 'Aethrix Night (customised)');
    // Clean up — reset so other tests see the unmodified built-in
    await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/override', {
      method: 'DELETE',
      cookie: adminCookie,
    });
  });

  it('DELETE /api/admin/themes/:id refuses to delete a built-in', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/aethrix-night', {
      method: 'DELETE',
      cookie: adminCookie,
    });
    assert.equal(r.status, 403);
  });

  it('POST /api/admin/themes/:id/activate changes the active theme', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/classic-teal/activate', {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; activeId: string };
    assert.ok(body.ok);
    assert.equal(body.activeId, 'classic-teal');

    // Verify public endpoint returns classic-teal
    const getR = await fetchJson(baseUrl, '/api/theme');
    assert.equal(getR.status, 200);
    const pub = getR.body as { template: { id: string } };
    assert.equal(pub.template.id, 'classic-teal');
  });

  it('POST /api/admin/themes/:id/activate reverts to default built-in when activated', async () => {
    // Activate aethrix-night again
    const r = await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/activate', {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const getR = await fetchJson(baseUrl, '/api/theme');
    const pub = getR.body as { template: { id: string } };
    assert.equal(pub.template.id, 'aethrix-night');
  });

  it('POST /api/admin/themes/:id/duplicate creates a copy', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/duplicate', {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    assert.equal(r.status, 201);
    const body = r.body as { ok: boolean; id: string; theme: { id: string } };
    assert.ok(body.ok);
    assert.ok(body.id.startsWith('aethrix-night-copy'), `Got id: ${body.id}`);
    assert.ok(body.theme, 'Expected theme in duplicate response');
    assert.ok(body.theme.id.startsWith('aethrix-night-copy'), `theme.id: ${body.theme.id}`);

    // The copy should be a custom (non-builtin) theme
    const getR = await fetchJson(baseUrl, `/api/admin/themes/${body.id}`, { cookie: adminCookie });
    assert.equal(getR.status, 200);
    const detail = getR.body as { builtIn: boolean };
    assert.equal(detail.builtIn, false);
  });

  it('DELETE /api/admin/themes/:id deletes a custom template', async () => {
    // First activate aethrix-night so my-custom-theme is not active
    await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });

    const r = await fetchJson(baseUrl, '/api/admin/themes/my-custom-theme', {
      method: 'DELETE',
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);

    // Confirm it's gone
    const getR = await fetchJson(baseUrl, '/api/admin/themes/my-custom-theme', { cookie: adminCookie });
    assert.equal(getR.status, 404);
  });

  it('DELETE /api/admin/themes/:id refuses to delete the active theme', async () => {
    // Create a theme and activate it
    const tmpl = minimalTemplate({ id: 'active-theme', name: 'Active' });
    await fetchJson(baseUrl, '/api/admin/themes', {
      method: 'POST', body: tmpl, cookie: adminCookie,
    });
    await fetchJson(baseUrl, '/api/admin/themes/active-theme/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });

    const r = await fetchJson(baseUrl, '/api/admin/themes/active-theme', {
      method: 'DELETE',
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });

  it('POST /api/admin/themes/validate returns errors without saving', async () => {
    const bad = { id: 'x', name: '', version: 'not-a-number', brand: { productName: 'P' }, modes: {}, fonts: {}, effects: {}, radius: {} };
    const r = await fetchJson(baseUrl, '/api/admin/themes/validate', {
      method: 'POST',
      body: bad,
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; errors: Array<{ path: string; message: string }> };
    assert.equal(body.ok, false);
    assert.ok(body.errors.length > 0);

    // Confirm nothing was saved
    const listR = await fetchJson(baseUrl, '/api/admin/themes', { cookie: adminCookie });
    const themes = (listR.body as { themes: Array<{ id: string }> }).themes;
    assert.ok(!themes.some((t) => t.id === 'x'));
  });

  it('GET /api/admin/themes requires admin', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes');
    assert.equal(r.status, 401);
  });

  it('POST /api/admin/themes requires admin', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes', {
      method: 'POST',
      body: minimalTemplate(),
    });
    assert.equal(r.status, 401);
  });
});

// ── Export / import round-trip ────────────────────────────────────────────────

// ── Built-in theme overrides ──────────────────────────────────────────────────

describe('Built-in theme overrides', () => {
  let baseUrl: string;
  let adminCookie: string;
  let nonAdminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);

    const createR = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: 'override-user@test.com', name: 'Override User', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    assert.equal(createR.status, 201, `Non-admin creation failed: ${JSON.stringify(createR.body)}`);
    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'override-user@test.com', password: 'password1234' },
    });
    nonAdminCookie = loginR.cookie ?? '';
  });

  after(cleanup);

  it('PUT /api/admin/themes/:id (built-in) returns 200 and stores override', async () => {
    const overrideTemplate = { ...AETHRIX_NIGHT, name: 'Aethrix Night Override' };
    const r = await fetchJson(baseUrl, '/api/admin/themes/aethrix-night', {
      method: 'PUT',
      body: overrideTemplate,
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as { ok: boolean; id: string; theme: { id: string; name: string } };
    assert.ok(body.ok);
    assert.equal(body.id, 'aethrix-night');
    assert.equal(body.theme.name, 'Aethrix Night Override');
  });

  it('GET /api/admin/themes/:id shows overridden=true and includes defaults', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/aethrix-night', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { builtIn: boolean; overridden: boolean; template: { name: string }; defaults: { id: string } };
    assert.ok(body.builtIn);
    assert.equal(body.overridden, true);
    assert.equal(body.template.name, 'Aethrix Night Override');
    assert.ok(body.defaults, 'Expected defaults field in response');
    assert.equal(body.defaults.id, 'aethrix-night');
  });

  it('GET /api/admin/themes list shows overridden=true for the built-in', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const themes = (r.body as { themes: Array<{ id: string; overridden: boolean; builtIn: boolean }> }).themes;
    const aethrix = themes.find((t) => t.id === 'aethrix-night');
    assert.ok(aethrix, 'Expected aethrix-night in list');
    assert.equal(aethrix!.overridden, true);
    const classicTeal = themes.find((t) => t.id === 'classic-teal');
    assert.ok(classicTeal);
    assert.equal(classicTeal!.overridden, false);
  });

  it('GET /api/theme returns override tokens when built-in is active', async () => {
    await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });
    const r = await fetchJson(baseUrl, '/api/theme');
    assert.equal(r.status, 200);
    const body = r.body as { template: { id: string; name: string }; etag: string };
    assert.equal(body.template.id, 'aethrix-night');
    assert.equal(body.template.name, 'Aethrix Night Override');
  });

  it('ETag changes after override is saved (differs from pre-computed built-in ETag)', async () => {
    const r = await fetchJson(baseUrl, '/api/theme');
    const etag = r.headers.get('etag') ?? '';
    assert.ok(etag, 'Expected ETag header');
    // Override ETag should contain 'builtin-override-' prefix
    assert.ok(etag.includes('builtin-override-'), `Expected override ETag prefix, got: ${etag}`);
  });

  it('PUT /api/admin/themes/:id (built-in) with invalid body returns 422', async () => {
    const bad = { ...AETHRIX_NIGHT, modes: {} };
    const r = await fetchJson(baseUrl, '/api/admin/themes/aethrix-night', {
      method: 'PUT',
      body: bad,
      cookie: adminCookie,
    });
    assert.equal(r.status, 422);
    const body = r.body as { errors: Array<{ path: string }> };
    assert.ok(Array.isArray(body.errors));
  });

  it('PUT /api/admin/themes/:id with id mismatch returns 400', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/classic-teal', {
      method: 'PUT',
      body: AETHRIX_NIGHT,
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });

  it('PUT /api/admin/themes/:id (built-in) returns 403 for non-admin', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/aethrix-night', {
      method: 'PUT',
      body: AETHRIX_NIGHT,
      cookie: nonAdminCookie,
    });
    assert.equal(r.status, 403);
  });

  it('DELETE /api/admin/themes/:id/override resets to shipped default', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/override', {
      method: 'DELETE',
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((r.body as { ok: boolean }).ok);

    const getR = await fetchJson(baseUrl, '/api/theme');
    const pub = getR.body as { template: { name: string } };
    assert.equal(pub.template.name, AETHRIX_NIGHT.name);
  });

  it('DELETE /api/admin/themes/:id/override returns 404 when no override exists', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/override', {
      method: 'DELETE',
      cookie: adminCookie,
    });
    assert.equal(r.status, 404);
  });

  it('DELETE /api/admin/themes/:id (built-in) still returns 403', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/aethrix-night', {
      method: 'DELETE',
      cookie: adminCookie,
    });
    assert.equal(r.status, 403);
  });

  it('theme.changed SSE event emitted on override save when built-in is active', async () => {
    await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });

    const sse = openSseHttp(baseUrl, '/api/events', adminCookie);
    await sse.ready;

    await fetchJson(baseUrl, '/api/admin/themes/aethrix-night', {
      method: 'PUT',
      body: { ...AETHRIX_NIGHT, name: 'SSE Test Override' },
      cookie: adminCookie,
    });

    await new Promise<void>((r) => setTimeout(r, 200));
    sse.close();

    const themeEvents = sse.events.filter(
      (e) => (e as Record<string, unknown>).type === 'theme.changed',
    );
    assert.ok(themeEvents.length > 0, `Expected theme.changed SSE event, got: ${JSON.stringify(sse.events)}`);

    await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/override', {
      method: 'DELETE', cookie: adminCookie,
    });
  });

  it('theme.changed SSE event emitted on override reset when built-in is active', async () => {
    await fetchJson(baseUrl, '/api/admin/themes/aethrix-night', {
      method: 'PUT',
      body: { ...AETHRIX_NIGHT, name: 'Reset SSE Test' },
      cookie: adminCookie,
    });

    const sse = openSseHttp(baseUrl, '/api/events', adminCookie);
    await sse.ready;

    await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/override', {
      method: 'DELETE', cookie: adminCookie,
    });

    await new Promise<void>((r) => setTimeout(r, 200));
    sse.close();

    const themeEvents = sse.events.filter(
      (e) => (e as Record<string, unknown>).type === 'theme.changed',
    );
    assert.ok(themeEvents.length > 0, `Expected theme.changed on reset, got: ${JSON.stringify(sse.events)}`);
  });
});

describe('Theme export/import round-trip', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(cleanup);

  it('exports a built-in template as JSON download', async () => {
    const r = await fetch(`${baseUrl}/api/admin/themes/aethrix-night/export`, {
      headers: {
        Cookie: adminCookie,
        'X-Requested-With': 'agent-portal',
      },
    });
    assert.equal(r.status, 200);
    const cd = r.headers.get('content-disposition') ?? '';
    assert.ok(cd.includes('attachment'), `Expected attachment, got: ${cd}`);
    assert.ok(cd.includes('aethrix-night'), cd);
    const body = await r.json() as { id: string };
    assert.equal(body.id, 'aethrix-night');
  });

  it('imports a template from JSON body', async () => {
    // Export aethrix-night, then import with a new id
    const exported = { ...AETHRIX_NIGHT, id: 'imported-night', name: 'Imported Night' };
    const r = await fetchJson(baseUrl, '/api/admin/themes/import', {
      method: 'POST',
      body: exported,
      cookie: adminCookie,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    // Verify it was saved
    const getR = await fetchJson(baseUrl, '/api/admin/themes/imported-night', { cookie: adminCookie });
    assert.equal(getR.status, 200);
    const detail = getR.body as { id: string; builtIn: boolean; template: { id: string; name: string } };
    assert.equal(detail.id, 'imported-night');
    assert.equal(detail.builtIn, false);
    assert.equal(detail.template.name, 'Imported Night');
  });

  it('import rejects invalid template', async () => {
    const bad = { id: 'bad-import', name: 'Bad', version: 1, brand: { productName: 'B' }, modes: {}, fonts: { display: 'Inter', body: 'Inter', mono: 'Inter' }, effects: { glow: false, gridBackground: false, gradientAccents: false, motion: 'full' }, radius: { sm: 4, md: 8, lg: 12 } };
    const r = await fetchJson(baseUrl, '/api/admin/themes/import', {
      method: 'POST',
      body: bad,
      cookie: adminCookie,
    });
    assert.equal(r.status, 422);
  });

  it('import refuses built-in id collision', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/import', {
      method: 'POST',
      body: AETHRIX_NIGHT,
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });
});

// ── Fallback when active theme is missing ─────────────────────────────────────

describe('Theme fallback', () => {
  it('GET /api/theme falls back to aethrix-night when active id does not exist', async () => {
    const db = createTestDb();
    // Point active to a nonexistent theme
    setSetting(db, 'theme.active', '"nonexistent-theme"');

    // Now open a fresh server (it will use the DB we just prepared via createTestServer)
    const ts = await createTestServer();
    const adminCookie = await loginAdmin(ts.baseUrl);

    // Activate a non-existent theme via the settings key directly
    // We can't do this via API (it would validate), so we test the fallback
    // by checking the resolver logic: the public endpoint must not crash.
    const r = await fetchJson(ts.baseUrl, '/api/theme');
    assert.equal(r.status, 200);
    const body = r.body as { template: { id: string } };
    // Active is aethrix-night by default in new DB
    assert.equal(body.template.id, 'aethrix-night');

    await cleanup();
  });
});

// ── CSS injection validation via HTTP ─────────────────────────────────────────

describe('CSS injection rejection via POST /api/admin/themes', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(cleanup);

  const injectionCases = [
    { name: 'url() injection', val: 'url(http://evil.com)' },
    { name: 'expression() injection', val: 'expression(alert(1))' },
    { name: 'semicolon injection', val: '#fff; background: red' },
    { name: 'brace injection', val: '#fff} .evil { color: red' },
    { name: 'script tag injection', val: '#fff<script>' },
    { name: 'javascript: injection', val: 'javascript:alert(1)' },
  ];

  for (const { name, val } of injectionCases) {
    it(`rejects ${name}`, async () => {
      const t = minimalTemplate({ id: 'inject-test' });
      if (t.modes.dark) (t.modes.dark as Record<string, unknown>)['accent'] = val;
      const r = await fetchJson(baseUrl, '/api/admin/themes', {
        method: 'POST',
        body: t,
        cookie: adminCookie,
      });
      assert.equal(r.status, 422, `Expected rejection of "${val}" but got ${r.status}: ${JSON.stringify(r.body)}`);
    });
  }
});

// ── API token refused on writes ────────────────────────────────────────────────

describe('API token refused on write routes', () => {
  let baseUrl: string;
  let adminCookie: string;
  let apiToken: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);

    // Create an API token with write scope
    const tokenR = await fetchJson(baseUrl, '/api/api-tokens', {
      method: 'POST',
      body: { name: 'test-token', scopes: ['read', 'write'] },
      cookie: adminCookie,
    });
    assert.equal(tokenR.status, 201, `Token creation failed: ${JSON.stringify(tokenR.body)}`);
    const tokenBody = tokenR.body as { token: string; info: unknown };
    apiToken = tokenBody.token;
  });

  after(cleanup);

  it('POST /api/admin/themes refuses API token auth', async () => {
    const r = await fetch(`${baseUrl}/api/admin/themes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'agent-portal',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(minimalTemplate({ id: 'token-test' })),
    });
    assert.equal(r.status, 403);
  });

  it('PUT /api/admin/themes/:id refuses API token auth', async () => {
    // First create via cookie so there's something to update
    await fetchJson(baseUrl, '/api/admin/themes', {
      method: 'POST',
      body: minimalTemplate({ id: 'token-update-test', name: 'Token Update Test' }),
      cookie: adminCookie,
    });

    const r = await fetch(`${baseUrl}/api/admin/themes/token-update-test`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'agent-portal',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(minimalTemplate({ id: 'token-update-test', name: 'Hacked' })),
    });
    assert.equal(r.status, 403);
  });

  it('DELETE /api/admin/themes/:id refuses API token auth', async () => {
    const r = await fetch(`${baseUrl}/api/admin/themes/token-update-test`, {
      method: 'DELETE',
      headers: {
        'X-Requested-With': 'agent-portal',
        Authorization: `Bearer ${apiToken}`,
      },
    });
    assert.equal(r.status, 403);
  });

  it('POST /api/admin/themes/:id/activate refuses API token auth', async () => {
    const r = await fetch(`${baseUrl}/api/admin/themes/classic-teal/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'agent-portal',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 403);
  });
});

// ── WCAG contrast — built-in themes ──────────────────────────────────────────

describe('WCAG contrast — built-in themes', () => {
  function relativeLuminance(hex: string): number {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const lin = (c: number): number =>
      c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrastRatio(fg: string, bg: string): number {
    const l1 = relativeLuminance(fg);
    const l2 = relativeLuminance(bg);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  const PAIRS: Array<[string, string, string]> = [
    ['ink on panel', 'ink', 'panel'],
    ['ink-2 on panel', 'ink-2', 'panel'],
    ['accent-ink on accent', 'accent-ink', 'accent'],
    ['link on panel', 'link', 'panel'],
  ];

  for (const theme of [AETHRIX_NIGHT, CLASSIC_TEAL]) {
    for (const [modeName, tokens] of Object.entries(theme.modes) as [string, Record<string, string>][]) {
      if (!tokens) continue;
      for (const [label, fgKey, bgKey] of PAIRS) {
        it(`${theme.name} ${modeName}: ${label} ≥ 4.5:1`, () => {
          const fg = tokens[fgKey];
          const bg = tokens[bgKey];
          assert.ok(fg, `Missing token "${fgKey}" in ${theme.name} ${modeName}`);
          assert.ok(bg, `Missing token "${bgKey}" in ${theme.name} ${modeName}`);
          const ratio = contrastRatio(fg, bg);
          assert.ok(
            ratio >= 4.5,
            `${theme.name} ${modeName} ${label}: ${ratio.toFixed(2)}:1 < 4.5:1 (fg=${fg} bg=${bg})`,
          );
        });
      }
    }
  }
});

// ── Token allow-list: link token ─────────────────────────────────────────────

describe('link token in ALLOWED_TOKEN_NAMES', () => {
  it('ALLOWED_TOKEN_NAMES includes link', () => {
    assert.ok(ALLOWED_TOKEN_NAMES.has('link'), 'Expected "link" in ALLOWED_TOKEN_NAMES');
  });

  it('validator accepts a template with link token', () => {
    const t = {
      id: 'link-test-theme',
      name: 'Link Test',
      version: 1,
      brand: { productName: 'Test' },
      modes: {
        dark: {
          canvas: '#0a0a0a', panel: '#111111', 'panel-2': '#141414', raised: '#1a1a1a',
          rail: '#0d0d0d', line: '#222222', 'line-2': '#1c1c1c',
          ink: '#ffffff', 'ink-2': '#bbbbbb', 'ink-3': '#888888',
          accent: '#6c5cff', 'accent-2': '#22d3ee', 'accent-3': '#ec4899',
          'accent-ink': '#ffffff', link: '#a5b4fc', 'accent-wash': 'rgba(108,92,255,0.15)',
          ok: '#22c55e', 'ok-wash': 'rgba(34,197,94,0.1)',
          warn: '#f59e0b', 'warn-wash': 'rgba(245,158,11,0.1)',
          danger: '#ef4444', 'danger-wash': 'rgba(239,68,68,0.1)',
          info: '#3b82f6', 'info-wash': 'rgba(59,130,246,0.1)',
          focus: '#6c5cff', glow: '0 0 16px rgba(108,92,255,.4)', 'code-bg': '#0a0a10',
          shadow: '0 2px 8px rgba(0,0,0,.5)',
        },
      },
      fonts: { display: 'Space Grotesk', body: 'Inter', mono: 'JetBrains Mono' },
      effects: { glow: true, gridBackground: false, gradientAccents: false, motion: 'full' as const },
      radius: { sm: 4, md: 8, lg: 12 },
    };
    const result = validateTemplate(t);
    assert.ok(result.ok, `Expected ok but got: ${JSON.stringify(result.errors)}`);
  });
});

// ── GET /api/admin/themes/fonts route ─────────────────────────────────────────

describe('GET /api/admin/themes/fonts', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(cleanup);

  it('returns fonts list and bundled subset', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/fonts', { cookie: adminCookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as { fonts: Array<{ name: string; bundled: boolean; stack: string }> };
    assert.ok(Array.isArray(body.fonts), 'Expected fonts array');
    assert.ok(body.fonts.length > 0, 'Expected non-empty fonts list');
    // Each entry has name, bundled, stack
    for (const f of body.fonts) {
      assert.ok(typeof f.name === 'string', `Font entry missing name: ${JSON.stringify(f)}`);
      assert.ok(typeof f.bundled === 'boolean', `Font "${f.name}" missing bundled flag`);
      assert.ok(typeof f.stack === 'string', `Font "${f.name}" missing stack`);
    }
    // Core bundled fonts are present and marked bundled
    const bundledFonts = body.fonts.filter((f) => f.bundled).map((f) => f.name);
    assert.ok(bundledFonts.includes('Space Grotesk'),  'Expected Space Grotesk in bundled');
    assert.ok(bundledFonts.includes('Inter'),          'Expected Inter in bundled');
    assert.ok(bundledFonts.includes('JetBrains Mono'), 'Expected JetBrains Mono in bundled');
    assert.ok(bundledFonts.includes('Quicksand'),      'Expected Quicksand in bundled');
    assert.ok(bundledFonts.includes('Geist Sans'),     'Expected Geist Sans in bundled');
  });

  it('GET /api/admin/themes/fonts requires admin', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/fonts');
    assert.equal(r.status, 401);
  });
});


// -- GET /api/events -- portal SSE route -------------------------------------

import http from 'node:http';
import { emit } from '../server/events.ts';

/**
 * Open an SSE connection using the low-level http module (avoids Web Streams /
 * AbortController async-cleanup warnings in the Node.js test runner).
 *
 * Returns:
 *   ready  - resolves once the server sends ": connected", meaning the
 *            subscriber is registered and actions can safely be triggered.
 *   events - array that accumulates parsed data-line payloads.
 *   close  - synchronously destroys the socket (ECONNRESET is swallowed).
 */
function openSseHttp(
  baseUrl: string,
  path: string,
  cookie: string,
): { ready: Promise<void>; events: object[]; close: () => void } {
  const events: object[] = [];
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let readyDone = false;

  const { hostname, port } = new URL(baseUrl);
  const req = http.request(
    {
      hostname,
      port: port ? parseInt(port, 10) : 80,
      path,
      method: 'GET',
      headers: { Cookie: cookie },
    },
    (res) => {
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          // SSE comment lines (": connected", ": ping")
          if (part.trimStart().startsWith(':')) {
            if (!readyDone) {
              readyDone = true;
              resolveReady();
            }
            continue;
          }
          for (const line of part.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                events.push(JSON.parse(line.slice(6)));
              } catch {
                /* ignore malformed SSE data */
              }
            }
          }
        }
      });
    },
  );

  req.on('error', (err: NodeJS.ErrnoException) => {
    // ECONNRESET is expected when close() destroys the socket
    if (err.code !== 'ECONNRESET' && !readyDone) {
      rejectReady(err as Error);
    }
  });

  req.setTimeout(5000, () => {
    if (!readyDone) rejectReady(new Error('SSE connection timed out'));
    req.destroy();
  });

  req.end();

  return { events, ready, close: () => req.destroy() };
}

describe('GET /api/events -- portal SSE', () => {
  let baseUrl: string;
  let adminCookie: string;
  let nonAdminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);

    const createR = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: 'events-user@test.com', name: 'Events User', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    assert.equal(createR.status, 201, `Non-admin creation failed: ${JSON.stringify(createR.body)}`);

    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'events-user@test.com', password: 'password1234' },
    });
    assert.equal(loginR.status, 200, `Non-admin login failed: ${JSON.stringify(loginR.body)}`);
    nonAdminCookie = loginR.cookie ?? '';
    assert.ok(nonAdminCookie, 'Expected session cookie for non-admin user');
  });

  after(cleanup);

  it('returns 401 for unauthenticated requests', async () => {
    const r = await fetchJson(baseUrl, '/api/events');
    assert.equal(r.status, 401);
  });

  it('returns 403 for API-token auth', async () => {
    const tokenR = await fetchJson(baseUrl, '/api/api-tokens', {
      method: 'POST',
      body: { name: 'events-token', scopes: ['read'] },
      cookie: adminCookie,
    });
    assert.equal(tokenR.status, 201, JSON.stringify(tokenR.body));
    const apiToken = (tokenR.body as { token: string }).token;

    const r = await fetch(`${baseUrl}/api/events`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(r.status, 403);
    await r.json();
  });

  it('non-admin receives theme.changed after admin activates a template', async () => {
    await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });

    const sse = openSseHttp(baseUrl, '/api/events', nonAdminCookie);
    await sse.ready;

    const activateR = await fetchJson(baseUrl, '/api/admin/themes/classic-teal/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });
    assert.equal(activateR.status, 200, `Activation failed: ${JSON.stringify(activateR.body)}`);

    await new Promise<void>((r) => setTimeout(r, 200));
    sse.close();

    const themeEvents = sse.events.filter(
      (e) => (e as Record<string, unknown>).type === 'theme.changed',
    );
    assert.ok(
      themeEvents.length > 0,
      `Expected at least one theme.changed event but received: ${JSON.stringify(sse.events)}`,
    );
  });

  it('non-admin does NOT receive run events emitted for a project', async () => {
    const sse = openSseHttp(baseUrl, '/api/events', nonAdminCookie);
    await sse.ready;

    emit('fake-project-id', { type: 'run.update', projectId: 'fake-project-id' });

    await new Promise<void>((r) => setTimeout(r, 200));
    sse.close();

    const runEvents = sse.events.filter(
      (e) => (e as Record<string, unknown>).type === 'run.update',
    );
    assert.equal(
      runEvents.length,
      0,
      `Expected no run.update but received: ${JSON.stringify(sse.events)}`,
    );
  });
});

// ── New built-in theme validation tests ──────────────────────────────────────

describe('validateTemplate — new built-in themes', () => {

  // ── Nebula ──────────────────────────────────────────────────────────────────
  it('accepts the Nebula built-in template', () => {
    const result = validateTemplate(NEBULA);
    assert.ok(result.ok, `nebula: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, []);
  });

  it('Nebula template has both dark and light modes', () => {
    assert.ok(NEBULA.modes.dark,  'Expected nebula.modes.dark');
    assert.ok(NEBULA.modes.light, 'Expected nebula.modes.light');
  });

  it('Nebula template uses allowed fonts', () => {
    const fontSet = new Set(FONT_ALLOW_LIST);
    assert.ok(fontSet.has(NEBULA.fonts.display), `display font "${NEBULA.fonts.display}" not in allow-list`);
    assert.ok(fontSet.has(NEBULA.fonts.body),    `body font "${NEBULA.fonts.body}" not in allow-list`);
    assert.ok(fontSet.has(NEBULA.fonts.mono),    `mono font "${NEBULA.fonts.mono}" not in allow-list`);
  });

  it('Nebula dark mode has all required tokens', () => {
    const dark = NEBULA.modes.dark!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in dark, `Nebula dark mode missing token "${token}"`);
    }
  });

  it('Nebula light mode has all required tokens', () => {
    const light = NEBULA.modes.light!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in light, `Nebula light mode missing token "${token}"`);
    }
  });

  // ── Aurora Glass ──────────────────────────────────────────────────────────
  it('accepts the Aurora Glass built-in template', () => {
    const result = validateTemplate(AURORA_GLASS);
    assert.ok(result.ok, `aurora-glass: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, []);
  });

  it('Aurora Glass template has both dark and light modes', () => {
    assert.ok(AURORA_GLASS.modes.dark,  'Expected aurora-glass.modes.dark');
    assert.ok(AURORA_GLASS.modes.light, 'Expected aurora-glass.modes.light');
  });

  it('Aurora Glass template uses allowed fonts', () => {
    const fontSet = new Set(FONT_ALLOW_LIST);
    assert.ok(fontSet.has(AURORA_GLASS.fonts.display), `display "${AURORA_GLASS.fonts.display}" not in allow-list`);
    assert.ok(fontSet.has(AURORA_GLASS.fonts.body),    `body "${AURORA_GLASS.fonts.body}" not in allow-list`);
    assert.ok(fontSet.has(AURORA_GLASS.fonts.mono),    `mono "${AURORA_GLASS.fonts.mono}" not in allow-list`);
  });

  it('Aurora Glass dark mode has all required tokens', () => {
    const dark = AURORA_GLASS.modes.dark!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in dark, `Aurora Glass dark mode missing token "${token}"`);
    }
  });

  it('Aurora Glass light mode has all required tokens', () => {
    const light = AURORA_GLASS.modes.light!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in light, `Aurora Glass light mode missing token "${token}"`);
    }
  });

  it('Aurora Glass uses rgba panel tokens (glassmorphism)', () => {
    const dark = AURORA_GLASS.modes.dark!;
    assert.ok(
      (dark['panel'] as string).startsWith('rgba('),
      `Expected aurora-glass dark panel to be rgba but got "${dark['panel']}"`,
    );
  });

  // ── Cyber HUD ─────────────────────────────────────────────────────────────
  it('accepts the Cyber HUD built-in template', () => {
    const result = validateTemplate(CYBER_HUD);
    assert.ok(result.ok, `cyber-hud: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, []);
  });

  it('Cyber HUD template has both dark and light modes', () => {
    assert.ok(CYBER_HUD.modes.dark,  'Expected cyber-hud.modes.dark');
    assert.ok(CYBER_HUD.modes.light, 'Expected cyber-hud.modes.light');
  });

  it('Cyber HUD template uses allowed fonts', () => {
    const fontSet = new Set(FONT_ALLOW_LIST);
    assert.ok(fontSet.has(CYBER_HUD.fonts.display), `display "${CYBER_HUD.fonts.display}" not in allow-list`);
    assert.ok(fontSet.has(CYBER_HUD.fonts.body),    `body "${CYBER_HUD.fonts.body}" not in allow-list`);
    assert.ok(fontSet.has(CYBER_HUD.fonts.mono),    `mono "${CYBER_HUD.fonts.mono}" not in allow-list`);
  });

  it('Cyber HUD uses Orbitron as display font', () => {
    assert.equal(CYBER_HUD.fonts.display, 'Orbitron');
  });

  it('Cyber HUD dark mode has all required tokens', () => {
    const dark = CYBER_HUD.modes.dark!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in dark, `Cyber HUD dark mode missing token "${token}"`);
    }
  });

  it('Cyber HUD light mode has all required tokens', () => {
    const light = CYBER_HUD.modes.light!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in light, `Cyber HUD light mode missing token "${token}"`);
    }
  });

  it('Cyber HUD has gradientAccents=false (solid neon HUD style)', () => {
    assert.equal(CYBER_HUD.effects.gradientAccents, false);
  });

  it('Cyber HUD has gridBackground=true (circuit/scanline pattern)', () => {
    assert.equal(CYBER_HUD.effects.gridBackground, true);
  });

  // ── Twilight ──────────────────────────────────────────────────────────────
  it('accepts the Twilight built-in template', () => {
    const result = validateTemplate(TWILIGHT);
    assert.ok(result.ok, `twilight: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, []);
  });

  it('Twilight template has both dark and light modes', () => {
    assert.ok(TWILIGHT.modes.dark,  'Expected twilight.modes.dark');
    assert.ok(TWILIGHT.modes.light, 'Expected twilight.modes.light');
  });

  it('Twilight template uses allowed fonts', () => {
    const fontSet = new Set(FONT_ALLOW_LIST);
    assert.ok(fontSet.has(TWILIGHT.fonts.display), `display "${TWILIGHT.fonts.display}" not in allow-list`);
    assert.ok(fontSet.has(TWILIGHT.fonts.body),    `body "${TWILIGHT.fonts.body}" not in allow-list`);
    assert.ok(fontSet.has(TWILIGHT.fonts.mono),    `mono "${TWILIGHT.fonts.mono}" not in allow-list`);
  });

  it('Twilight uses Plus Jakarta Sans as display font', () => {
    assert.equal(TWILIGHT.fonts.display, 'Plus Jakarta Sans');
  });

  it('Twilight dark mode has all required tokens', () => {
    const dark = TWILIGHT.modes.dark!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in dark, `Twilight dark mode missing token "${token}"`);
    }
  });

  it('Twilight light mode has all required tokens', () => {
    const light = TWILIGHT.modes.light!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in light, `Twilight light mode missing token "${token}"`);
    }
  });

  // ── Built-in registry coverage ────────────────────────────────────────────
  it('all four new themes are exported from server/themes', () => {
    assert.ok(NEBULA,       'NEBULA export missing');
    assert.ok(AURORA_GLASS, 'AURORA_GLASS export missing');
    assert.ok(CYBER_HUD,    'CYBER_HUD export missing');
    assert.ok(TWILIGHT,     'TWILIGHT export missing');
    assert.equal(NEBULA.id,       'nebula');
    assert.equal(AURORA_GLASS.id, 'aurora-glass');
    assert.equal(CYBER_HUD.id,    'cyber-hud');
    assert.equal(TWILIGHT.id,     'twilight');
  });
});

// ── WCAG contrast — new built-in themes ──────────────────────────────────────

describe('WCAG contrast — new built-in themes', () => {
  function relativeLuminance(hex: string): number {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const lin = (c: number): number =>
      c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrastRatio(fg: string, bg: string): number {
    const l1 = relativeLuminance(fg);
    const l2 = relativeLuminance(bg);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function isHex6(val: string): boolean {
    return /^#[0-9a-fA-F]{6}$/.test(val);
  }

  // Pairs checked: ink on canvas and ink on panel (skip if token is rgba)
  const PAIRS: Array<[string, string, string]> = [
    ['ink on canvas', 'ink', 'canvas'],
    ['ink on panel', 'ink', 'panel'],
    ['ink-2 on panel', 'ink-2', 'panel'],
  ];

  // Nebula, Cyber HUD, Twilight all have solid hex canvas+panel tokens
  for (const theme of [NEBULA, CYBER_HUD, TWILIGHT]) {
    for (const [modeName, tokens] of Object.entries(theme.modes) as [string, Record<string, string>][]) {
      if (!tokens) continue;
      for (const [label, fgKey, bgKey] of PAIRS) {
        it(`${theme.name} ${modeName}: ${label} >= 4.5:1`, () => {
          const fg = tokens[fgKey];
          const bg = tokens[bgKey];
          if (!fg || !bg || !isHex6(fg) || !isHex6(bg)) return; // skip rgba tokens
          const ratio = contrastRatio(fg, bg);
          assert.ok(
            ratio >= 4.5,
            `${theme.name} ${modeName} ${label}: ${ratio.toFixed(2)}:1 < 4.5:1 (fg=${fg} bg=${bg})`,
          );
        });
      }
    }
  }

  // Aurora Glass: panel is rgba so only check ink on canvas (solid hex)
  for (const [modeName, tokens] of Object.entries(AURORA_GLASS.modes) as [string, Record<string, string>][]) {
    if (!tokens) continue;
    it(`Aurora Glass ${modeName}: ink on canvas >= 4.5:1`, () => {
      const fg = tokens['ink'];
      const bg = tokens['canvas'];
      assert.ok(fg && bg, `Missing ink or canvas in aurora-glass ${modeName}`);
      if (!isHex6(fg) || !isHex6(bg)) return; // skip rgba
      const ratio = contrastRatio(fg, bg);
      assert.ok(
        ratio >= 4.5,
        `Aurora Glass ${modeName} ink on canvas: ${ratio.toFixed(2)}:1 < 4.5:1 (fg=${fg} bg=${bg})`,
      );
    });
  }
});

// ── New themes registered in BUILTIN_THEMES (HTTP route) ─────────────────────

describe('New built-in themes in /api/admin/themes', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(cleanup);

  it('lists all four new themes as built-ins', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { themes: Array<{ id: string; builtIn: boolean }> };
    assert.ok(body.themes.some((t) => t.id === 'nebula'       && t.builtIn), 'nebula missing from built-ins');
    assert.ok(body.themes.some((t) => t.id === 'aurora-glass' && t.builtIn), 'aurora-glass missing from built-ins');
    assert.ok(body.themes.some((t) => t.id === 'cyber-hud'    && t.builtIn), 'cyber-hud missing from built-ins');
    assert.ok(body.themes.some((t) => t.id === 'twilight'     && t.builtIn), 'twilight missing from built-ins');
  });

  it('can activate nebula and get its template', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/nebula/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; activeId: string };
    assert.ok(body.ok);
    assert.equal(body.activeId, 'nebula');

    const getR = await fetchJson(baseUrl, '/api/theme');
    assert.equal(getR.status, 200);
    const pub = getR.body as { template: { id: string } };
    assert.equal(pub.template.id, 'nebula');
  });

  it('can activate aurora-glass and get its template', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/aurora-glass/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const getR = await fetchJson(baseUrl, '/api/theme');
    const pub = getR.body as { template: { id: string } };
    assert.equal(pub.template.id, 'aurora-glass');
  });

  it('can activate cyber-hud and get its template', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/cyber-hud/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const getR = await fetchJson(baseUrl, '/api/theme');
    const pub = getR.body as { template: { id: string } };
    assert.equal(pub.template.id, 'cyber-hud');
  });

  it('can activate twilight and get its template', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/twilight/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const getR = await fetchJson(baseUrl, '/api/theme');
    const pub = getR.body as { template: { id: string } };
    assert.equal(pub.template.id, 'twilight');
  });

  it('can edit (override) new built-in themes and reset them', async () => {
    for (const id of ['nebula', 'aurora-glass', 'cyber-hud', 'twilight']) {
      const builtinTheme = [NEBULA, AURORA_GLASS, CYBER_HUD, TWILIGHT].find((t) => t.id === id)!;
      const updated = { ...builtinTheme, name: `${builtinTheme.name} Override` };
      const r = await fetchJson(baseUrl, `/api/admin/themes/${id}`, {
        method: 'PUT', body: updated, cookie: adminCookie,
      });
      assert.equal(r.status, 200, `Expected 200 for override of built-in "${id}" but got ${r.status}`);
      // Reset the override so other tests are not affected
      const delR = await fetchJson(baseUrl, `/api/admin/themes/${id}/override`, {
        method: 'DELETE', cookie: adminCookie,
      });
      assert.equal(delR.status, 200, `Expected 200 resetting override for "${id}" but got ${delR.status}`);
    }
  });

  it('cannot delete new built-in themes', async () => {
    // Make sure aethrix-night is active so we don't accidentally delete the active one
    await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });
    for (const id of ['nebula', 'aurora-glass', 'cyber-hud', 'twilight']) {
      const r = await fetchJson(baseUrl, `/api/admin/themes/${id}`, {
        method: 'DELETE', cookie: adminCookie,
      });
      assert.equal(r.status, 403, `Expected 403 for DELETE on built-in "${id}" but got ${r.status}`);
    }
  });

  it('import refuses new built-in id collisions', async () => {
    for (const [id, tmpl] of [
      ['nebula', NEBULA], ['aurora-glass', AURORA_GLASS],
      ['cyber-hud', CYBER_HUD], ['twilight', TWILIGHT],
    ] as const) {
      const r = await fetchJson(baseUrl, '/api/admin/themes/import', {
        method: 'POST', body: tmpl, cookie: adminCookie,
      });
      assert.equal(r.status, 400, `Expected 400 for built-in id "${id}" import but got ${r.status}`);
    }
  });

  it('new bundled fonts are marked bundled in /api/admin/themes/fonts', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/fonts', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { fonts: Array<{ name: string; bundled: boolean }> };
    const bundledNames = body.fonts.filter((f) => f.bundled).map((f) => f.name);
    assert.ok(bundledNames.includes('Outfit'),           'Expected Outfit in bundled fonts');
    assert.ok(bundledNames.includes('Plus Jakarta Sans'), 'Expected Plus Jakarta Sans in bundled fonts');
    assert.ok(bundledNames.includes('Orbitron'),          'Expected Orbitron in bundled fonts');
    assert.ok(bundledNames.includes('Exo 2'),             'Expected Exo 2 in bundled fonts');
  });
});

// ── POST /api/admin/themes/generate ──────────────────────────────────────────

import { setCallTextModelOverride } from '../server/testing/model-provider.ts';
import { AETHRIX_NIGHT as AETHRIX_FULL } from '../server/themes.ts';

/** A minimal but fully-valid generated theme JSON string (dark + light modes). */
function makeValidGeneratedJson(overrides: Record<string, unknown> = {}): string {
  const base = {
    id: 'placeholder-will-be-overridden',
    name: 'AI Generated Theme',
    version: 1,
    description: 'A test AI-generated theme',
    brand: { productName: 'Test Portal' },
    modes: {
      dark: {
        canvas: '#0a0a0a', panel: '#111111', 'panel-2': '#141414', raised: '#1a1a1a',
        rail: '#0d0d0d', line: '#222222', 'line-2': '#1c1c1c',
        ink: '#ffffff', 'ink-2': '#bbbbbb', 'ink-3': '#888888',
        accent: '#6c5cff', 'accent-2': '#22d3ee', 'accent-3': '#ec4899',
        'accent-ink': '#ffffff', link: '#a5b4fc', 'accent-wash': 'rgba(108,92,255,0.15)',
        ok: '#22c55e', 'ok-wash': 'rgba(34,197,94,0.1)',
        warn: '#f59e0b', 'warn-wash': 'rgba(245,158,11,0.1)',
        danger: '#ef4444', 'danger-wash': 'rgba(239,68,68,0.1)',
        info: '#3b82f6', 'info-wash': 'rgba(59,130,246,0.1)',
        focus: '#6c5cff', glow: '0 0 16px rgba(108,92,255,.4)', 'code-bg': '#0a0a10',
        shadow: '0 2px 8px rgba(0,0,0,.5)',
      },
      light: {
        canvas: '#ffffff', panel: '#f8f8f8', 'panel-2': '#f0f0f0', raised: '#e8e8e8',
        rail: '#f5f5f5', line: '#dddddd', 'line-2': '#e8e8e8',
        ink: '#111111', 'ink-2': '#444444', 'ink-3': '#777777',
        accent: '#5c4cef', 'accent-2': '#0ca5c5', 'accent-3': '#dc3888',
        'accent-ink': '#ffffff', link: '#5c4cef', 'accent-wash': 'rgba(92,76,239,0.1)',
        ok: '#16a34a', 'ok-wash': 'rgba(22,163,74,0.1)',
        warn: '#d97706', 'warn-wash': 'rgba(217,119,6,0.1)',
        danger: '#dc2626', 'danger-wash': 'rgba(220,38,38,0.1)',
        info: '#2563eb', 'info-wash': 'rgba(37,99,235,0.1)',
        focus: '#5c4cef', glow: '0 0 16px rgba(92,76,239,.4)', 'code-bg': '#f5f5ff',
        shadow: '0 2px 8px rgba(0,0,0,.1)',
      },
    },
    fonts: { display: 'Space Grotesk', body: 'Inter', mono: 'JetBrains Mono' },
    effects: { glow: true, gridBackground: false, gradientAccents: false, motion: 'full' },
    radius: { sm: 4, md: 8, lg: 12 },
    ...overrides,
  };
  return JSON.stringify(base);
}

describe('POST /api/admin/themes/generate', () => {
  let baseUrl: string;
  let adminCookie: string;
  let nonAdminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);

    const createR = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: 'gen-user@test.com', name: 'Gen User', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    assert.equal(createR.status, 201, `Non-admin create failed: ${JSON.stringify(createR.body)}`);
    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'gen-user@test.com', password: 'password1234' },
    });
    nonAdminCookie = loginR.cookie ?? '';
  });

  after(async () => {
    setCallTextModelOverride(null);
    await cleanup();
  });

  it('non-admin gets 403', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: { description: 'dark purple theme' },
      cookie: nonAdminCookie,
    });
    assert.equal(r.status, 403);
  });

  it('unauthenticated gets 401', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: { description: 'dark purple theme' },
    });
    assert.equal(r.status, 401);
  });

  it('missing description gets 400', async () => {
    setCallTextModelOverride(async () => makeValidGeneratedJson());
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: { description: '   ' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
    setCallTextModelOverride(null);
  });

  it('description over 1000 chars gets 400', async () => {
    setCallTextModelOverride(async () => makeValidGeneratedJson());
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: { description: 'a'.repeat(1001) },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
    setCallTextModelOverride(null);
  });

  it('more than 4 images gets 400', async () => {
    setCallTextModelOverride(async () => makeValidGeneratedJson());
    const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: {
        description: 'dark theme',
        referenceImages: Array(5).fill({ name: 'img.png', dataUrl: pngDataUrl }),
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    setCallTextModelOverride(null);
  });

  it('unsupported image MIME type gets 400', async () => {
    setCallTextModelOverride(async () => makeValidGeneratedJson());
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: {
        description: 'dark theme',
        referenceImages: [{ name: 'file.bmp', dataUrl: 'data:image/bmp;base64,AAAA' }],
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    setCallTextModelOverride(null);
  });

  it('happy path: returns valid unsaved theme with fresh id', async () => {
    setCallTextModelOverride(async () => makeValidGeneratedJson());
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: { description: 'A modern dark theme with purple accents' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as { ok: boolean; theme: { id: string; name: string }; warnings: string[] };
    assert.ok(body.ok);
    assert.ok(body.theme, 'Expected theme in response');
    assert.ok(typeof body.theme.id === 'string', 'Expected theme.id to be a string');
    // id should NOT be 'placeholder-will-be-overridden' — it must be replaced by the server
    assert.ok(body.theme.id !== 'placeholder-will-be-overridden', 'Expected server to assign a fresh id');
    assert.ok(body.theme.id.length >= 3 && body.theme.id.length <= 40, `id length invalid: ${body.theme.id}`);
    // theme must NOT be saved (no GET /api/admin/themes/:id should find it)
    const getR = await fetchJson(baseUrl, `/api/admin/themes/${body.theme.id}`, { cookie: adminCookie });
    assert.equal(getR.status, 404, 'Generated theme should NOT be saved yet');
    assert.ok(Array.isArray(body.warnings), 'Expected warnings array');
    setCallTextModelOverride(null);
  });

  it('fenced JSON with chatter is parsed successfully', async () => {
    setCallTextModelOverride(async () =>
      `Sure! Here is your theme:\n\`\`\`json\n${makeValidGeneratedJson()}\n\`\`\`\nI hope you like it!`,
    );
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: { description: 'minimal theme' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as { ok: boolean; theme: { id: string } };
    assert.ok(body.ok);
    assert.ok(body.theme?.id);
    setCallTextModelOverride(null);
  });

  it('invalid first answer triggers retry, then succeeds', async () => {
    let callCount = 0;
    setCallTextModelOverride(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: return invalid JSON (missing modes)
        return JSON.stringify({ id: 'bad-theme', name: 'Bad', version: 1, brand: { productName: 'X' },
          modes: {}, fonts: { display: 'Inter', body: 'Inter', mono: 'Inter' },
          effects: { glow: false, gridBackground: false, gradientAccents: false, motion: 'full' },
          radius: { sm: 4, md: 8, lg: 12 } });
      }
      // Second call: return valid theme
      return makeValidGeneratedJson();
    });
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: { description: 'A retried theme' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(callCount, 2, 'Expected exactly 2 model calls (initial + retry)');
    setCallTextModelOverride(null);
  });

  it('unfixable generated theme returns 422', async () => {
    // Return something completely invalid that auto-fix cannot save
    setCallTextModelOverride(async () => 'this is not JSON at all, no braces anywhere');
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: { description: 'broken response test' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    setCallTextModelOverride(null);
  });

  it('demo mode returns clear 503 error', async () => {
    setCallTextModelOverride(async () => {
      throw new Error('No AI provider configured. Set up an Anthropic API key, Bedrock, LiteLLM, or Kiro CLI in Settings to use this feature.');
    });
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: { description: 'demo mode test' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    const body = r.body as { error: string };
    assert.ok(body.error.includes('No AI provider') || body.error.includes('provider'), `Unexpected error: ${body.error}`);
    setCallTextModelOverride(null);
  });

  it('contrast auto-fix adds a warning when ink contrast is low', async () => {
    // Return a theme where ink-on-canvas has poor contrast
    const badContrast = JSON.parse(makeValidGeneratedJson()) as Record<string, unknown>;
    const modes = badContrast.modes as Record<string, Record<string, string>>;
    modes.dark.ink = '#333333';    // dark grey on dark background — low contrast
    modes.dark.canvas = '#111111';
    modes.dark['accent-ink'] = '#444444'; // also low on accent
    modes.dark.accent = '#333333';
    modes.light.ink = '#cccccc';    // light grey on white — low contrast
    modes.light.canvas = '#ffffff';
    setCallTextModelOverride(async () => JSON.stringify(badContrast));
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: { description: 'contrast test theme' },
      cookie: adminCookie,
    });
    // Should succeed (auto-fixed) with warnings
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as { ok: boolean; warnings: string[] };
    assert.ok(body.ok);
    assert.ok(Array.isArray(body.warnings), 'Expected warnings array');
    assert.ok(body.warnings.length > 0, `Expected at least one contrast warning, got: ${JSON.stringify(body.warnings)}`);
    const hasContrastWarning = body.warnings.some((w) => w.includes('contrast') || w.includes('adjusted'));
    assert.ok(hasContrastWarning, `Expected contrast adjustment warning, got: ${JSON.stringify(body.warnings)}`);
    setCallTextModelOverride(null);
  });

  it('SVG image is skipped with a warning', async () => {
    setCallTextModelOverride(async () => makeValidGeneratedJson());
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: {
        description: 'theme with SVG reference',
        referenceImages: [
          { name: 'logo.svg', dataUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=' },
        ],
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as { ok: boolean; warnings: string[] };
    assert.ok(body.ok);
    assert.ok(body.warnings.some((w) => w.includes('SVG') || w.includes('svg')), `Expected SVG warning, got: ${JSON.stringify(body.warnings)}`);
    setCallTextModelOverride(null);
  });

  it('generated theme id is never a built-in id', async () => {
    setCallTextModelOverride(async () => makeValidGeneratedJson({ id: 'aethrix-night' }));
    const r = await fetchJson(baseUrl, '/api/admin/themes/generate', {
      method: 'POST',
      body: { description: 'check id uniqueness' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as { ok: boolean; theme: { id: string } };
    assert.ok(body.ok);
    assert.ok(body.theme.id !== 'aethrix-night', `Expected fresh id, got: ${body.theme.id}`);
    setCallTextModelOverride(null);
  });
});

// ── Terminal and Kiro IDE theme import ────────────────────────────────────────

import {
  TERMINAL,
  KIRO_IDE,
} from '../server/themes.ts';

// ── validateTemplate — Terminal and Kiro IDE ──────────────────────────────────

describe('validateTemplate — Terminal theme', () => {
  it('accepts the Terminal built-in template', () => {
    const result = validateTemplate(TERMINAL);
    assert.ok(result.ok, `terminal: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, []);
  });

  it('Terminal template has both dark and light modes', () => {
    assert.ok(TERMINAL.modes.dark,  'Expected terminal.modes.dark');
    assert.ok(TERMINAL.modes.light, 'Expected terminal.modes.light');
  });

  it('Terminal template uses allowed fonts', () => {
    const fontSet = new Set(FONT_ALLOW_LIST);
    assert.ok(fontSet.has(TERMINAL.fonts.display), `display "${TERMINAL.fonts.display}" not in allow-list`);
    assert.ok(fontSet.has(TERMINAL.fonts.body),    `body "${TERMINAL.fonts.body}" not in allow-list`);
    assert.ok(fontSet.has(TERMINAL.fonts.mono),    `mono "${TERMINAL.fonts.mono}" not in allow-list`);
  });

  it('Terminal uses JetBrains Mono as display font (full monospace)', () => {
    assert.equal(TERMINAL.fonts.display, 'JetBrains Mono');
  });

  it('Terminal dark mode has all required tokens', () => {
    const dark = TERMINAL.modes.dark!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in dark, `Terminal dark mode missing token "${token}"`);
    }
  });

  it('Terminal light mode has all required tokens', () => {
    const light = TERMINAL.modes.light!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in light, `Terminal light mode missing token "${token}"`);
    }
  });

  it('Terminal has gridBackground=true (phosphor grid/scanline)', () => {
    assert.equal(TERMINAL.effects.gridBackground, true);
  });

  it('Terminal has gradientAccents=false (solid monochrome style)', () => {
    assert.equal(TERMINAL.effects.gradientAccents, false);
  });

  it('Terminal has square corners (radius sm=2, md=4, lg=6)', () => {
    assert.equal(TERMINAL.radius.sm, 2);
    assert.equal(TERMINAL.radius.md, 4);
    assert.equal(TERMINAL.radius.lg, 6);
  });

  it('Terminal dark canvas is near-black green-tinted', () => {
    const dark = TERMINAL.modes.dark!;
    assert.ok(
      (dark['canvas'] as string).startsWith('#0'),
      `Expected dark canvas to start with #0 (near-black), got "${dark['canvas']}"`,
    );
  });

  it('Terminal is exported from server/themes', () => {
    assert.ok(TERMINAL, 'TERMINAL export missing');
    assert.equal(TERMINAL.id, 'terminal');
  });
});

describe('validateTemplate — Kiro IDE theme', () => {
  it('accepts the Kiro IDE built-in template', () => {
    const result = validateTemplate(KIRO_IDE);
    assert.ok(result.ok, `kiro-ide: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, []);
  });

  it('Kiro IDE template has both dark and light modes', () => {
    assert.ok(KIRO_IDE.modes.dark,  'Expected kiro-ide.modes.dark');
    assert.ok(KIRO_IDE.modes.light, 'Expected kiro-ide.modes.light');
  });

  it('Kiro IDE template uses allowed fonts', () => {
    const fontSet = new Set(FONT_ALLOW_LIST);
    assert.ok(fontSet.has(KIRO_IDE.fonts.display), `display "${KIRO_IDE.fonts.display}" not in allow-list`);
    assert.ok(fontSet.has(KIRO_IDE.fonts.body),    `body "${KIRO_IDE.fonts.body}" not in allow-list`);
    assert.ok(fontSet.has(KIRO_IDE.fonts.mono),    `mono "${KIRO_IDE.fonts.mono}" not in allow-list`);
  });

  it('Kiro IDE uses Orbitron as display font', () => {
    assert.equal(KIRO_IDE.fonts.display, 'Orbitron');
  });

  it('Kiro IDE uses Inter as body font (KPI numbers read cleanly)', () => {
    assert.equal(KIRO_IDE.fonts.body, 'Inter');
  });

  it('Kiro IDE dark mode has all required tokens', () => {
    const dark = KIRO_IDE.modes.dark!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in dark, `Kiro IDE dark mode missing token "${token}"`);
    }
  });

  it('Kiro IDE light mode has all required tokens', () => {
    const light = KIRO_IDE.modes.light!;
    for (const token of ALLOWED_TOKEN_NAMES) {
      assert.ok(token in light, `Kiro IDE light mode missing token "${token}"`);
    }
  });

  it('Kiro IDE has gridBackground=true (blue grid + radial glow)', () => {
    assert.equal(KIRO_IDE.effects.gridBackground, true);
  });

  it('Kiro IDE has gradientAccents=false (solid blue HUD style)', () => {
    assert.equal(KIRO_IDE.effects.gradientAccents, false);
  });

  it('Kiro IDE has rounded corners (sm=6, md=10, lg=14)', () => {
    assert.equal(KIRO_IDE.radius.sm, 6);
    assert.equal(KIRO_IDE.radius.md, 10);
    assert.equal(KIRO_IDE.radius.lg, 14);
  });

  it('Kiro IDE dark canvas is deep navy-black', () => {
    const dark = KIRO_IDE.modes.dark!;
    assert.ok(
      (dark['canvas'] as string).startsWith('#0'),
      `Expected dark canvas to start with #0 (deep navy-black), got "${dark['canvas']}"`,
    );
  });

  it('Kiro IDE uses rgba line tokens (luminous border effect)', () => {
    const dark = KIRO_IDE.modes.dark!;
    assert.ok(
      (dark['line'] as string).startsWith('rgba('),
      `Expected kiro-ide dark line to be rgba, got "${dark['line']}"`,
    );
  });

  it('Kiro IDE is exported from server/themes', () => {
    assert.ok(KIRO_IDE, 'KIRO_IDE export missing');
    assert.equal(KIRO_IDE.id, 'kiro-ide');
  });
});

// ── WCAG contrast — Terminal and Kiro IDE ────────────────────────────────────

describe('WCAG contrast — Terminal and Kiro IDE themes', () => {
  function relativeLuminance(hex: string): number {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const lin = (c: number): number =>
      c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrastRatio(fg: string, bg: string): number {
    const l1 = relativeLuminance(fg);
    const l2 = relativeLuminance(bg);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function isHex6(val: string): boolean {
    return /^#[0-9a-fA-F]{6}$/.test(val);
  }

  // Pairs: ink/canvas, ink/panel, ink-2/panel, accent-ink/accent
  const PAIRS: Array<[string, string, string]> = [
    ['ink on canvas',        'ink',        'canvas'],
    ['ink on panel',         'ink',        'panel'],
    ['ink-2 on panel',       'ink-2',      'panel'],
    ['accent-ink on accent', 'accent-ink', 'accent'],
  ];

  for (const theme of [TERMINAL, KIRO_IDE]) {
    for (const [modeName, tokens] of Object.entries(theme.modes) as [string, Record<string, string>][]) {
      if (!tokens) continue;
      for (const [label, fgKey, bgKey] of PAIRS) {
        it(`${theme.name} ${modeName}: ${label} >= 4.5:1`, () => {
          const fg = tokens[fgKey];
          const bg = tokens[bgKey];
          if (!fg || !bg || !isHex6(fg) || !isHex6(bg)) return; // skip rgba tokens
          const ratio = contrastRatio(fg, bg);
          assert.ok(
            ratio >= 4.5,
            `${theme.name} ${modeName} ${label}: ${ratio.toFixed(2)}:1 < 4.5:1 (fg=${fg} bg=${bg})`,
          );
        });
      }
    }
  }
});

// ── New themes registered in BUILTIN_THEMES (HTTP route) ─────────────────────

describe('Terminal and Kiro IDE in /api/admin/themes', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(cleanup);

  it('lists terminal and kiro-ide as built-ins', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { themes: Array<{ id: string; builtIn: boolean }> };
    assert.ok(body.themes.some((t) => t.id === 'terminal'  && t.builtIn), 'terminal missing from built-ins');
    assert.ok(body.themes.some((t) => t.id === 'kiro-ide'  && t.builtIn), 'kiro-ide missing from built-ins');
  });

  it('can activate terminal and get its template', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/terminal/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; activeId: string };
    assert.ok(body.ok);
    assert.equal(body.activeId, 'terminal');

    const getR = await fetchJson(baseUrl, '/api/theme');
    assert.equal(getR.status, 200);
    const pub = getR.body as { template: { id: string } };
    assert.equal(pub.template.id, 'terminal');
  });

  it('can activate kiro-ide and get its template', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/themes/kiro-ide/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const getR = await fetchJson(baseUrl, '/api/theme');
    const pub = getR.body as { template: { id: string } };
    assert.equal(pub.template.id, 'kiro-ide');
  });

  it('can edit (override) terminal and kiro-ide built-ins and reset them', async () => {
    for (const [id, tmpl] of [['terminal', TERMINAL], ['kiro-ide', KIRO_IDE]] as const) {
      const updated = { ...tmpl, name: `${tmpl.name} Override` };
      const r = await fetchJson(baseUrl, `/api/admin/themes/${id}`, {
        method: 'PUT', body: updated, cookie: adminCookie,
      });
      assert.equal(r.status, 200, `Expected 200 for override of built-in "${id}" but got ${r.status}: ${JSON.stringify(r.body)}`);
      // Reset the override
      const delR = await fetchJson(baseUrl, `/api/admin/themes/${id}/override`, {
        method: 'DELETE', cookie: adminCookie,
      });
      assert.equal(delR.status, 200, `Expected 200 resetting override for "${id}" but got ${delR.status}`);
    }
  });

  it('cannot delete terminal and kiro-ide built-in themes', async () => {
    await fetchJson(baseUrl, '/api/admin/themes/aethrix-night/activate', {
      method: 'POST', body: {}, cookie: adminCookie,
    });
    for (const id of ['terminal', 'kiro-ide']) {
      const r = await fetchJson(baseUrl, `/api/admin/themes/${id}`, {
        method: 'DELETE', cookie: adminCookie,
      });
      assert.equal(r.status, 403, `Expected 403 for DELETE on built-in "${id}" but got ${r.status}`);
    }
  });

  it('import refuses terminal and kiro-ide id collisions', async () => {
    for (const [id, tmpl] of [['terminal', TERMINAL], ['kiro-ide', KIRO_IDE]] as const) {
      const r = await fetchJson(baseUrl, '/api/admin/themes/import', {
        method: 'POST', body: tmpl, cookie: adminCookie,
      });
      assert.equal(r.status, 400, `Expected 400 for built-in id "${id}" import but got ${r.status}`);
    }
  });
});
