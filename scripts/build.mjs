// Builds the web UI (dist/web) and the server bundle (dist/server.mjs) with esbuild.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webOnly = process.argv.includes('--web-only');
const out = path.join(root, 'dist');
const webOut = path.join(out, 'web');

fs.rmSync(webOut, { recursive: true, force: true });
fs.mkdirSync(path.join(webOut, 'assets'), { recursive: true });

// ── Web UI ──────────────────────────────────────────────────────────────────

const webEntry = path.join(root, 'web/src/main.jsx');

// If web/src/main.jsx doesn't exist yet, create a minimal placeholder so the
// build doesn't fail during P0 (the real UI comes in later phases).
if (!fs.existsSync(webEntry)) {
  fs.mkdirSync(path.dirname(webEntry), { recursive: true });
  fs.writeFileSync(
    webEntry,
    `// Placeholder — replaced in UI phase\nimport React from 'react';\nimport { createRoot } from 'react-dom/client';\nconst root = document.getElementById('root');\nif (root) createRoot(root).render(React.createElement('p', null, 'Agent Portal — starting up'));\n`,
  );
}

const web = await esbuild.build({
  entryPoints: [webEntry],
  bundle: true,
  splitting: true,
  format: 'esm',
  outdir: path.join(webOut, 'assets'),
  entryNames: '[name]-[hash]',
  chunkNames: 'chunk-[hash]',
  assetNames: '[name]-[hash]',
  jsx: 'automatic',
  minify: true,
  sourcemap: 'linked',
  target: ['es2022', 'chrome110', 'safari16', 'firefox115'],
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.svg': 'file', '.woff2': 'file', '.woff': 'file' },
  metafile: true,
  logLevel: 'warning',
  legalComments: 'none',
});

// ── Inject asset hashes into index.html ─────────────────────────────────────

let js = '';
let css = '';
for (const [file, info] of Object.entries(web.metafile.outputs)) {
  if (
    info.entryPoint &&
    info.entryPoint.replace(/\\/g, '/').endsWith('web/src/main.jsx') &&
    file.endsWith('.js')
  ) {
    js = '/assets/' + path.basename(file);
  }
  if (file.endsWith('.css') && path.basename(file).startsWith('main-')) {
    css = '/assets/' + path.basename(file);
  }
}
// Fallback: find any CSS output
if (!css) {
  const cssFile = Object.keys(web.metafile.outputs).find((f) => f.endsWith('.css'));
  if (cssFile) css = '/assets/' + path.basename(cssFile);
}

const html = fs
  .readFileSync(path.join(root, 'web/index.html'), 'utf8')
  .replace('<!--CSS-->', css ? `<link rel="stylesheet" href="${css}">` : '')
  .replace('<!--JS-->', `<script type="module" src="${js}"></script>`);

fs.writeFileSync(path.join(webOut, 'index.html'), html);
fs.copyFileSync(path.join(root, 'web/favicon.svg'), path.join(webOut, 'favicon.svg'));

// ── Generate theme-init.js from shared/themes/*.json ────────────────────────
// This replaces the old fs.copyFileSync of web/theme-init.js.
// We read the canonical JSON, pre-compute normalised token tables, and inject
// them so theme-init.js never contains hardcoded palettes.

const FONT_STACKS = {
  'Space Grotesk':  "'Space Grotesk Variable','Space Grotesk',system-ui,sans-serif",
  'Inter':          "'Inter Variable','Inter',system-ui,sans-serif",
  'JetBrains Mono': "'JetBrains Mono Variable','JetBrains Mono','SF Mono',Consolas,monospace",
  'system-ui':      "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
  'ui-monospace':   "ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace",
};

function resolveFontStackNode(name) {
  if (!name) return name;
  if (name.includes(',') || name.includes("'")) return name;
  return FONT_STACKS[name] || name;
}

function normaliseForInit(raw) {
  const modes = {};
  for (const [mode, tokens] of Object.entries(raw.modes || {})) {
    modes[mode] = { ...tokens };
    if (!modes[mode].link) {
      modes[mode].link = tokens.accent || tokens['accent-ink'];
    }
  }
  const fonts = raw.fonts ? {
    display: resolveFontStackNode(raw.fonts.display),
    body:    resolveFontStackNode(raw.fonts.body),
    mono:    resolveFontStackNode(raw.fonts.mono),
  } : raw.fonts;
  const radius = raw.radius ? Object.fromEntries(
    Object.entries(raw.radius).map(([k, v]) => [k, typeof v === 'number' ? `${v}px` : v]),
  ) : raw.radius;
  return { ...raw, modes, fonts, radius };
}

const aethrixJson    = JSON.parse(fs.readFileSync(path.join(root, 'shared/themes/aethrix-night.json'), 'utf8'));
const classicJson    = JSON.parse(fs.readFileSync(path.join(root, 'shared/themes/classic-teal.json'),  'utf8'));
const bundledThemes  = {
  'aethrix-night': normaliseForInit(aethrixJson),
  'classic-teal':  normaliseForInit(classicJson),
};

const themeInitSrc = fs.readFileSync(path.join(root, 'web/theme-init.js'), 'utf8');
const themeInitOut = themeInitSrc.replace(
  '/* __BUNDLED_THEMES__ */',
  `var BUNDLED_THEMES = ${JSON.stringify(bundledThemes)};`,
);
fs.writeFileSync(path.join(webOut, 'theme-init.js'), themeInitOut);

const totalBytes = Object.entries(web.metafile.outputs)
  .filter(([f]) => !f.endsWith('.map'))
  .reduce((sum, [, o]) => sum + o.bytes, 0);
console.log(`web: ${js} (${Math.round(totalBytes / 1024)} KB total, lazy chunks included)`);

// ── Server bundle ────────────────────────────────────────────────────────────

if (!webOnly) {
  await esbuild.build({
    entryPoints: [path.join(root, 'server/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: path.join(out, 'server.mjs'),
    // Keep node: builtins and all npm packages external
    packages: 'external',
    sourcemap: 'linked',
    logLevel: 'warning',
  });
  console.log('server: dist/server.mjs');

  // Pre-flight tool
  await esbuild.build({
    entryPoints: [path.join(root, 'scripts/preflight.mjs')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: path.join(out, 'preflight.mjs'),
    packages: 'external',
    logLevel: 'warning',
  });
  console.log('tool: dist/preflight.mjs');
}
