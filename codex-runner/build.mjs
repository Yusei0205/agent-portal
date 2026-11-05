import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
await esbuild.build({ entryPoints: { index: path.join(root, 'src/index.ts'), 'mcp-proxy': path.join(root, 'src/mcp-proxy.ts') },
  bundle: true, platform: 'node', format: 'esm', target: 'node22', outdir: path.join(root, 'dist'), outExtension: { '.js': '.mjs' }, logLevel: 'info' });
