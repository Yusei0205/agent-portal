/**
 * Build script for kiro-runner.
 * Bundles src/index.ts (and its local imports) into dist/index.mjs.
 * node:* built-ins and the shared/ kiro-idc.ts are inlined (no external runtime deps).
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, 'dist');

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: path.join(distDir, 'index.mjs'),
  // node: built-ins (node:sqlite, node:fs, etc.) stay external automatically with platform:'node'
  sourcemap: false,
  logLevel: 'info',
});

// Stdio MCP server for the AgentCore Browser tools. playwright-core stays external (installed in the image).
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'browser-mcp.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: path.join(distDir, 'browser-mcp.mjs'),
  external: ['playwright-core'],
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  sourcemap: false,
  logLevel: 'info',
});

console.log('kiro-runner build complete → dist/index.mjs, dist/browser-mcp.mjs');
