/**
 * Build script for agent-runner.
 * Bundles src/index.ts (and its local imports) into dist/index.mjs.
 * @anthropic-ai/claude-agent-sdk stays external — loaded from node_modules at runtime.
 * The shared/ directory (guard.ts, env-scrub.ts) is inlined into the bundle.
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
  // Keep the SDK external — install it in the container via npm ci
  external: ['@anthropic-ai/claude-agent-sdk'],
  // node: built-ins stay external automatically with platform: 'node'
  sourcemap: false,
  logLevel: 'info',
});

console.log('agent-runner build complete → dist/index.mjs');
