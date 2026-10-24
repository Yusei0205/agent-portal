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

const web = await esbuild.build({
  entryPoints: [path.join(root, 'web/src/main.jsx')],
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

let js = '';
let css = '';
for (const [file, info] of Object.entries(web.metafile.outputs)) {
  if (info.entryPoint && info.entryPoint.endsWith('web/src/main.jsx') && file.endsWith('.js')) js = '/assets/' + path.basename(file);
  if (file.endsWith('.css') && path.basename(file).startsWith('main-')) css = '/assets/' + path.basename(file);
}
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
fs.copyFileSync(path.join(root, 'web/theme-init.js'), path.join(webOut, 'theme-init.js'));

const sizes = Object.entries(web.metafile.outputs)
  .filter(([f]) => !f.endsWith('.map'))
  .map(([, o]) => o.bytes)
  .reduce((a, b) => a + b, 0);
console.log(`web: ${js} (${Math.round(sizes / 1024)} KB total, lazy chunks included)`);

// The document generator the agents' make-documents skill runs. Always built, so `npm run dev` has it too.
await esbuild.build({
  entryPoints: [path.join(root, 'server/docgen-cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(out, 'make-doc.mjs'),
  packages: 'external',
  logLevel: 'warning',
});
console.log('tool: dist/make-doc.mjs');

if (!webOnly) {
  await esbuild.build({
    entryPoints: [path.join(root, 'server/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: path.join(out, 'server.mjs'),
    packages: 'external',
    sourcemap: 'linked',
    logLevel: 'warning',
  });
  console.log('server: dist/server.mjs');

  // The pre-flight tool: checks git, pandoc, aws, python modules, Claude Code CLI, data dir and optional packs.
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
