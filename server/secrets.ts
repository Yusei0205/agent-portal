import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { config, dataPath } from './config.ts';
import { one, run } from './db.ts';
import { badRequest, now } from './util.ts';

const execFileP = promisify(execFile);

let key: Buffer | null = null;

function masterKey(): Buffer {
  if (key) return key;
  if (config.secretKey) {
    key = scryptSync(config.secretKey, 'agent-portal-secrets-v1', 32);
    return key;
  }
  const file = dataPath('master.key');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
    console.warn(`[secrets] PORTAL_SECRET_KEY is not set; generated ${file}. Back it up: secrets cannot be read without it.`);
  }
  key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  if (key.length !== 32) throw new Error(`${file} is not a valid 32-byte hex key`);
  return key;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(blob: string): string {
  const [v, ivB, tagB, dataB] = blob.split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}

interface Backend {
  mode: 'local' | 'aws-ssm';
  prefix: string;
  region: string;
}

function backend(): Backend {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = 'secrets'");
  const v = row ? JSON.parse(row.value) : {};
  return { mode: v.mode === 'aws-ssm' ? 'aws-ssm' : 'local', prefix: v.prefix || '/agent-portal/', region: v.region || '' };
}

function hint(value: string): string {
  return value.length > 8 ? `…${value.slice(-4)}` : 'set';
}

async function ssm(args: string[], region: string): Promise<string> {
  const full = [...args, '--output', 'json'];
  if (region) full.push('--region', region);
  // Uses the server's own AWS identity (for example an EC2 instance role), never stored keys.
  const { stdout } = await execFileP('aws', full, { timeout: 20_000 });
  return stdout;
}

export function validSecretName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) throw badRequest('Invalid secret name');
  return name;
}

export async function setSecret(name: string, value: string): Promise<void> {
  validSecretName(name);
  const b = backend();
  if (b.mode === 'aws-ssm') {
    // Pass the value through a short-lived 0600 file so it never appears in the process list.
    const tmp = dataPath('tmp', `ssm-${randomBytes(6).toString('hex')}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ Name: b.prefix + name, Type: 'SecureString', Overwrite: true, Value: value }), { mode: 0o600 });
    try {
      await ssm(['ssm', 'put-parameter', '--cli-input-json', `file://${tmp}`], b.region);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    run(
      'INSERT INTO secrets (name, value, hint, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, hint = excluded.hint, updated_at = excluded.updated_at',
      name,
      'ssm:' + b.prefix + name,
      hint(value),
      now(),
    );
    return;
  }
  run(
    'INSERT INTO secrets (name, value, hint, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, hint = excluded.hint, updated_at = excluded.updated_at',
    name,
    encrypt(value),
    hint(value),
    now(),
  );
}

const cache = new Map<string, { value: string; at: number }>();

export async function getSecret(name: string): Promise<string | null> {
  const row = one<{ value: string }>('SELECT value FROM secrets WHERE name = ?', name);
  if (!row) return null;
  if (row.value.startsWith('ssm:')) {
    const c = cache.get(name);
    if (c && Date.now() - c.at < 5 * 60_000) return c.value;
    const out = await ssm(['ssm', 'get-parameter', '--name', row.value.slice(4), '--with-decryption'], backend().region);
    const value = JSON.parse(out).Parameter.Value as string;
    cache.set(name, { value, at: Date.now() });
    return value;
  }
  return decrypt(row.value);
}

export function deleteSecret(name: string): void {
  cache.delete(name);
  run('DELETE FROM secrets WHERE name = ?', name);
}

export function secretInfo(name: string): { set: boolean; hint?: string; updatedAt?: string } {
  const row = one<{ hint: string; updated_at: string }>('SELECT hint, updated_at FROM secrets WHERE name = ?', name);
  return row ? { set: true, hint: row.hint, updatedAt: row.updated_at } : { set: false };
}
