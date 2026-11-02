/**
 * Durable copies of files under DATA_DIR.
 *
 * On Lambda the local disk is /tmp and vanishes on restart, so files that must survive (vault uploads,
 * knowledge documents, templates, attachments) are mirrored to the storage backend (S3) and restored on
 * demand. Everything is a no-op unless STORAGE_BACKEND=s3, so local and Docker installs are unchanged.
 *
 * The S3 key is the file's path relative to DATA_DIR, so the layout in the bucket matches the data folder.
 *
 *   persistFile(abs)  after writing a file locally
 *   restoreFile(abs)  before reading a file; fetches it from S3 if it is not on local disk
 *   forgetFile(abs)   after deleting a file locally
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { getStorage } from './storage-instance.ts';

function enabled(): boolean {
  return process.env.STORAGE_BACKEND === 's3';
}

/** Logical key for an absolute path inside DATA_DIR, or null when the path is outside it. */
function keyFor(absPath: string): string | null {
  const rel = path.relative(config.dataDir, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export async function persistFile(absPath: string, mimeType?: string): Promise<void> {
  if (!enabled()) return;
  const key = keyFor(absPath);
  if (!key) return;
  await getStorage().write(key, await fs.promises.readFile(absPath), mimeType);
}

/** Returns true when the file is available on local disk afterwards. */
export async function restoreFile(absPath: string): Promise<boolean> {
  if (fs.existsSync(absPath)) return true;
  if (!enabled()) return false;
  const key = keyFor(absPath);
  if (!key) return false;
  const storage = getStorage();
  if (!(await storage.exists(key))) return false;
  const data = await storage.read(key);
  await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
  await fs.promises.writeFile(absPath, data);
  return true;
}

export async function forgetFile(absPath: string): Promise<void> {
  if (!enabled()) return;
  const key = keyFor(absPath);
  if (!key) return;
  await getStorage().delete(key);
}
