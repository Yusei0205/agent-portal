import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

/**
 * Encrypt `plaintext` using AES-256-GCM.
 * `key` is the portal secret key as a 64-character hex string (32 bytes).
 * Returns a base64url-safe string in the format `iv:authTag:ciphertext`
 * where each component is base64-encoded.
 */
export function encrypt(plaintext: string, key: string): string {
  const keyBuf = Buffer.from(key, 'hex');
  if (keyBuf.length !== 32) {
    throw new Error('Secret key must be a 64-character hex string (32 bytes)');
  }
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt a value previously produced by `encrypt`.
 * `key` is the portal secret key as a 64-character hex string (32 bytes).
 */
export function decrypt(ciphertext: string, key: string): string {
  const keyBuf = Buffer.from(key, 'hex');
  if (keyBuf.length !== 32) {
    throw new Error('Secret key must be a 64-character hex string (32 bytes)');
  }
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format — expected iv:authTag:ciphertext');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ── Secrets table helpers ────────────────────────────────────────────────────
// Read and write encrypted entries in the `secrets` table that migrations
// create.  These are used by Jira integration (and potentially other
// per-project credentials) to avoid scattering SQL across feature modules.

import { one, run as dbRun } from './db.ts';
import { config } from './config.ts';
import { now } from './util.ts';
import { getSettingsRepository } from './repositories/settings.ts';

/** Store an encrypted plaintext value under a named key. */
export async function setSecret(name: string, value: string): Promise<void> {
  const enc = encrypt(value, config.secretKey);
  const hint = value.length > 8 ? `…${value.slice(-4)}` : 'set';
  const updatedAt = now();
  const repo = getSettingsRepository();
  if (repo) {
    await repo.setSecret(name, enc, hint, updatedAt);
  } else {
    dbRun(
      'INSERT INTO secrets (name, value, hint, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, hint = excluded.hint, updated_at = excluded.updated_at',
      name,
      enc,
      hint,
      updatedAt,
    );
  }
}

/** Retrieve and decrypt a value stored by {@link setSecret}. Returns null if not found. */
export async function getSecret(name: string): Promise<string | null> {
  const repo = getSettingsRepository();
  if (repo) {
    const rec = await repo.getSecret(name);
    if (!rec) return null;
    try {
      return decrypt(rec.value, config.secretKey);
    } catch {
      return null;
    }
  }
  // Fallback (pre-startup)
  const row = one<{ value: string }>('SELECT value FROM secrets WHERE name = ?', name);
  if (!row) return null;
  try {
    return decrypt(row.value, config.secretKey);
  } catch {
    return null;
  }
}

/** Delete a secret entry. No-op if it does not exist. */
export async function deleteSecret(name: string): Promise<void> {
  const repo = getSettingsRepository();
  if (repo) {
    await repo.deleteSecret(name);
  } else {
    dbRun('DELETE FROM secrets WHERE name = ?', name);
  }
}
