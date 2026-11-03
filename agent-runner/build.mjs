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
  external: ['@anthropic-ai/claude-agent-sdk', 'playwright-core', 'zod'],
  // node: built-ins stay external automatically with platform: 'node'
  // The AWS SDK (bundled for the browser tools) is CommonJS and calls require() on node: built-ins.
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

console.log('agent-runner build complete → dist/index.mjs, dist/mcp-proxy.mjs');
