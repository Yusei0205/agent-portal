/**
 * Portal configuration — loaded once at startup.
 *
 * Secret key resolution order:
 *   1. PORTAL_SECRET_KEY env var
 *   2. SECRET_KEY_ARN → AWS Secrets Manager (dynamic import)
 *   3. PORTAL_SECRET_KEY_SSM_PATH → AWS SSM Parameter Store (dynamic import)
 *   4. data/master.key file (auto-generated if missing)
 */

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ── Root detection ────────────────────────────────────────────────────────────

function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const here =
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

const root = findRoot(here);

// ── Config interface ──────────────────────────────────────────────────────────

export interface Config {
  root: string;
  port: number;
  host: string;
  dataDir: string;
  webDir: string;
  secretKey: string;
  /** 'auto' marks cookies Secure when the request arrived over HTTPS. */
  cookieSecure: 'auto' | 'true' | 'false';
  demoSpeed: number;
  maxUploadBytes: number;
  trustProxy: boolean;
  /** AWS region for SDK calls. */
  awsRegion: string;
  /** Deploy target returned to the UI (null = not set). */
  deployTarget: string | null;
}

// ── Secret key resolution ─────────────────────────────────────────────────────

async function resolveSecretKey(dataDir: string): Promise<string> {
  // 1. Env var
  const fromEnv = process.env.PORTAL_SECRET_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  // 2. AWS Secrets Manager
  const arn = process.env.SECRET_KEY_ARN;
  if (arn) {
    try {
      // Use Function() to bypass TypeScript module resolution for optional SDK deps
      type SMModule = {
        SecretsManagerClient: new (opts: object) => { send: (cmd: object) => Promise<{ SecretString?: string }> };
        GetSecretValueCommand: new (opts: { SecretId: string }) => object;
      };
      const mod = await (Function('m', 'return import(m)')('@aws-sdk/client-secrets-manager') as Promise<SMModule>);
      const client = new mod.SecretsManagerClient({});
      const resp = await client.send(new mod.GetSecretValueCommand({ SecretId: arn }));
      const val = resp.SecretString ?? '';
      if (val.trim()) {
        console.log('[config] Secret key loaded from AWS Secrets Manager');
        return val.trim();
      }
    } catch (e) {
      console.error('[config] Failed to load secret from Secrets Manager:', e);
    }
  }

  // 3. AWS SSM Parameter Store
  const ssmPath = process.env.PORTAL_SECRET_KEY_SSM_PATH;
  if (ssmPath) {
    try {
      type SSMModule = {
        SSMClient: new (opts: object) => { send: (cmd: object) => Promise<{ Parameter?: { Value?: string } }> };
        GetParameterCommand: new (opts: { Name: string; WithDecryption: boolean }) => object;
      };
      const mod = await (Function('m', 'return import(m)')('@aws-sdk/client-ssm') as Promise<SSMModule>);
      const client = new mod.SSMClient({});
      const resp = await client.send(
        new mod.GetParameterCommand({ Name: ssmPath, WithDecryption: true }),
      );
      const val = resp.Parameter?.Value ?? '';
      if (val.trim()) {
        console.log('[config] Secret key loaded from AWS SSM Parameter Store');
        return val.trim();
      }
    } catch (e) {
      console.error('[config] Failed to load secret from SSM:', e);
    }
  }

  // 4. Auto-generated master.key file
  const keyFile = path.join(dataDir, 'master.key');
  if (fs.existsSync(keyFile)) {
    const val = fs.readFileSync(keyFile, 'utf8').trim();
    if (val) return val;
  }
  // Generate a new key
  const generated = randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  console.warn(
    `[config] PORTAL_SECRET_KEY is not set; generated ${keyFile}. Back it up: secrets cannot be read without it.`,
  );
  return generated;
}

// ── loadConfig ────────────────────────────────────────────────────────────────

export async function loadConfig(): Promise<Config> {
  const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
  const secretKey = await resolveSecretKey(dataDir);

  return {
    root,
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? '127.0.0.1',
    dataDir,
    webDir: path.resolve(process.env.WEB_DIR ?? path.join(root, 'dist', 'web')),
    secretKey,
    cookieSecure: (process.env.COOKIE_SECURE ?? 'auto') as 'auto' | 'true' | 'false',
    demoSpeed: Number(process.env.DEMO_SPEED ?? 1),
    maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 50) * 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === '1',
    awsRegion: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    deployTarget: process.env.DEPLOY_TARGET ?? null,
  };
}

// ── Ensure data dirs exist ────────────────────────────────────────────────────

export function ensureDataDirs(dataDir: string): void {
  for (const d of [
    '',
    'projects',
    'library/agents',
    'library/skills',
    'claude-home',
    'tmp',
    'home/.local/bin',
    'tools/bin',
    'vault',
    'backups',
  ]) {
    fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  }
}

/** Helper: resolve a path relative to dataDir (accepts Config or uses the singleton). */
export function dataPath(cfgOrPart: Config | string, ...parts: string[]): string {
  if (typeof cfgOrPart === 'string') {
    // Called as dataPath('tools', 'icon-diagrams') — use the singleton
    return path.join(config.dataDir, cfgOrPart, ...parts);
  }
  return path.join(cfgOrPart.dataDir, ...parts);
}

// ── Singleton ────────────────────────────────────────────────────────────────
// config is populated by startServer() in index.ts before any handler runs.

let _config: Config | null = null;

export function setConfig(cfg: Config): void {
  _config = cfg;
}

export const config: Config = new Proxy({} as Config, {
  get(_target, prop: string) {
    if (!_config) {
      throw new Error(
        `config.${prop} accessed before loadConfig() completed. This is a startup ordering bug.`,
      );
    }
    return (_config as unknown as Record<string, unknown>)[prop];
  },
  set(_target, prop: string, value) {
    if (!_config) throw new Error('Cannot set config before loadConfig()');
    (_config as unknown as Record<string, unknown>)[prop] = value;
    return true;
  },
});

// Silence unused import warning for fsp — we may use it in future migrations
void (fsp as unknown);
