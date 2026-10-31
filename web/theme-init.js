/**
 * Runs before the page paints (loaded via <script src="/theme-init.js">).
 * Applies the cached active template synchronously to avoid a flash of wrong
 * fonts, colours, radius or effects.
 *
 * IMPORTANT: the line below is replaced at build time (scripts/build.mjs)
 * with the pre-computed, normalised bundled-theme data.  Never hard-code
 * palette tables here — edit shared/themes/*.json instead.
 *
 * Contract:
 *   portal-template-id  — active template id  (default: aethrix-night)
 *   portal-mode         — dark | light | system  (default: system)
 *   portal-theme-cached — JSON of last /api/theme payload (server format)
 */
(function () {
  /* __BUNDLED_THEMES__ */   // ← replaced by build script with var BUNDLED_THEMES = {...}

  /* ── Minimal normaliser for cached server templates ──────────────────── */
  /* (mirrors normaliseTemplate() in web/src/lib/templates/index.js)       */
  var FONT_STACKS = {
    'Space Grotesk':  "'Space Grotesk Variable','Space Grotesk',system-ui,sans-serif",
    'Inter':          "'Inter Variable','Inter',system-ui,sans-serif",
    'JetBrains Mono': "'JetBrains Mono Variable','JetBrains Mono','SF Mono',Consolas,monospace",
    'system-ui':      "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
    'ui-monospace':   "ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace",
  };
  function resolveFontStack(name) {
    if (!name) return name;
    if (name.indexOf(',') !== -1 || name.indexOf("'") !== -1) return name;
    return FONT_STACKS[name] || name;
  }

  /* ── Read preferences ─────────────────────────────────────────────── */
  var templateId = 'aethrix-night';
  var mode       = 'system';
  try {
    templateId = localStorage.getItem('portal-template-id') || templateId;
    mode       = localStorage.getItem('portal-mode')        || mode;
  } catch (e) { /* storage blocked */ }

  /* ── Resolve effective mode ───────────────────────────────────────── */
  var effective = mode;
  if (mode === 'system') {
    try {
      effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      effective = 'dark';
    }
  }

  /* ── Resolve template (cached server first, then bundled) ─────────── */
  var tmpl = null;

  try {
    var cached = JSON.parse(localStorage.getItem('portal-theme-cached') || 'null');
    if (cached && cached.id === templateId && cached.modes) {
      // Normalise numeric radius and short font names from cached server format
      if (cached.radius) {
        var r = {};
        for (var k in cached.radius) {
          var rv = cached.radius[k];
          r[k] = (typeof rv === 'number') ? (rv + 'px') : rv;
        }
        cached.radius = r;
      }
      if (cached.fonts) {
        cached.fonts = {
          display: resolveFontStack(cached.fonts.display),
          body:    resolveFontStack(cached.fonts.body),
          mono:    resolveFontStack(cached.fonts.mono),
        };
      }
      // Ensure link token exists in every mode
      for (var m in (cached.modes || {})) {
        if (!cached.modes[m].link) {
          cached.modes[m].link = cached.modes[m].accent || cached.modes[m]['accent-ink'];
        }
      }
      tmpl = cached;
    }
  } catch (e) { /* ignore */ }

  // Fall back to bundled themes
  if (!tmpl) {
    tmpl = (BUNDLED_THEMES && BUNDLED_THEMES[templateId])
         || (BUNDLED_THEMES && BUNDLED_THEMES['aethrix-night']);
  }

  if (!tmpl) return; // nothing to apply

  /* ── Resolve mode tokens ──────────────────────────────────────────── */
  var modes = tmpl.modes || {};
  var modeTokens = modes[effective] || modes[Object.keys(modes)[0]] || {};

  /* ── Apply CSS variables to <html> ───────────────────────────────── */
  var root = document.documentElement;

  // Mode colour tokens
  for (var prop in modeTokens) {
    root.style.setProperty('--' + prop, modeTokens[prop]);
  }

  // Fonts (full CSS stacks)
  var fonts = tmpl.fonts || {};
  if (fonts.display) {
    root.style.setProperty('--font-display', fonts.display);
  }
  if (fonts.body) {
    root.style.setProperty('--font-body', fonts.body);
    root.style.setProperty('--font',      fonts.body); // legacy alias
  }
  if (fonts.mono) {
    root.style.setProperty('--mono', fonts.mono);
  }

  // Radius — set BOTH --radius-xl and --radius-lg so they resolve consistently
  var radius = tmpl.radius || {};
  if (radius.sm) root.style.setProperty('--radius-sm', radius.sm);
  if (radius.md) root.style.setProperty('--radius-md', radius.md);
  if (radius.lg) {
    root.style.setProperty('--radius-xl', radius.lg);
    root.style.setProperty('--radius-lg', radius.lg);
  }

  /* ── Apply data attributes ───────────────────────────────────────── */
  root.setAttribute('data-template', tmpl.id);
  root.setAttribute('data-mode',     effective);
  root.setAttribute('data-theme',    effective); // backward compat

  // Effect attributes (drive CSS rules in aethrix.css)
  var fx = tmpl.effects || {};
  root.setAttribute('data-fx-glow',     fx.glow            ? 'true' : 'false');
  root.setAttribute('data-fx-grid',     fx.gridBackground  ? 'true' : 'false');
  root.setAttribute('data-fx-gradient', fx.gradientAccents ? 'true' : 'false');
  root.setAttribute('data-fx-motion',   fx.motion != null ? fx.motion : 'full');

  // Single-mode marker
  var modeKeys = Object.keys(modes);
  if (modeKeys.length === 1) {
    root.setAttribute('data-template-single-mode', modeKeys[0]);
  } else {
    root.removeAttribute('data-template-single-mode');
  }
})();
