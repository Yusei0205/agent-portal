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

// ── Portal modules shared with the portal (same source, copied at build time) ──
// In the Docker build the Dockerfile COPYs them into shared/ (the server folder is not
// in the image). In a checkout they are copied here from ../server, so a local build
// and `npm run typecheck` always use the portal's current code.
const SHARED = [
  ['agent/guard.ts', 'agent/guard.ts'],
  ['agent/env-scrub.ts', 'agent/env-scrub.ts'],
  ['agent/agentcore-approvals.ts', 'agent/agentcore-approvals.ts'],
  ['agent/tool-policy.ts', 'agent/tool-policy.ts'],
  ['real-path.ts', 'real-path.ts'],
];
const serverDir = path.join(root, '..', 'server');
if (fs.existsSync(serverDir)) {
  for (const [from, to] of SHARED) {
    const dest = path.join(root, 'shared', to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(serverDir, from), dest);
  }
}
for (const [, to] of SHARED) {
  if (!fs.existsSync(path.join(root, 'shared', to))) throw new Error(`shared/${to} is missing: build from the repo checkout or the Dockerfile`);
}

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

console.log('kiro-runner build complete → dist/index.mjs');
