import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const root = findRoot(here);

export const config = {
  root,
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '127.0.0.1',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, 'data')),
  webDir: path.resolve(process.env.WEB_DIR || path.join(root, 'dist', 'web')),
  /** Master key for encrypting stored secrets. Generated into DATA_DIR/master.key when unset. */
  secretKey: process.env.PORTAL_SECRET_KEY || '',
  /** 'auto' marks cookies Secure when the request arrived over HTTPS (directly or via a proxy). */
  cookieSecure: (process.env.COOKIE_SECURE || 'auto') as 'auto' | 'true' | 'false',
  /** Speed of the simulated agent: 1 = realistic pauses, 0 = instant (tests). */
  demoSpeed: Number(process.env.DEMO_SPEED ?? 1),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024,
  trustProxy: process.env.TRUST_PROXY === '1',
};

export function dataPath(...parts: string[]): string {
  return path.join(config.dataDir, ...parts);
}

export function ensureDataDirs(): void {
  for (const d of ['', 'projects', 'library/agents', 'library/skills', 'claude-home', 'tmp', 'home/.local/bin', 'tools/bin']) {
    fs.mkdirSync(dataPath(d), { recursive: true });
  }
}
