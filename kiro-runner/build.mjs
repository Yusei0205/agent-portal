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
  // The runner's own pure modules (files, repositories, snapshots, MCP, checks).
  ['agent/runner-files.ts', 'runner-files.ts'],
  ['agent/runner-repos.ts', 'runner-repos.ts'],
  ['agent/runner-inspect.ts', 'runner-inspect.ts'],
  ['agent/runner-snapshot.ts', 'runner-snapshot.ts'],
  ['agent/runner-mcp.ts', 'runner-mcp.ts'],
  ['agent/runner-checks.ts', 'runner-checks.ts'],
  ['agent/runner-finalize.ts', 'runner-finalize.ts'],
  ['agent/runner-finalize-run.ts', 'runner-finalize-run.ts'],
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

// Stdio MCP proxy in front of one remote MCP integration (holds its secret headers, hides write tools).
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'mcp-proxy.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: path.join(distDir, 'mcp-proxy.mjs'),
  sourcemap: false,
  logLevel: 'info',
});

// The draw.io MCP server (lookups only), run from the copy installed in the image.
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'drawio-mcp.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: path.join(distDir, 'drawio-mcp.mjs'),
  sourcemap: false,
  logLevel: 'info',
});

console.log('kiro-runner build complete → dist/index.mjs, dist/browser-mcp.mjs, dist/mcp-proxy.mjs');
