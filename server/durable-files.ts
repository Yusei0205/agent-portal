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

/** True when the file is on local disk or in the storage backend, without downloading it. */
export async function existsDurable(absPath: string): Promise<boolean> {
  if (fs.existsSync(absPath)) return true;
  if (!enabled()) return false;
  const key = keyFor(absPath);
  return key ? getStorage().exists(key) : false;
}

export async function forgetFile(absPath: string): Promise<void> {
  if (!enabled()) return;
  const key = keyFor(absPath);
  if (!key) return;
  await getStorage().delete(key);
}

// ── Whole folders ─────────────────────────────────────────────────────────────

const restoredTrees = new Map<string, number>();
const TREE_FRESH_MS = 30_000;

/**
 * Make sure every mirrored file under `absDir` exists locally (needed after a Lambda restart, before
 * listing or reading a folder). Repeat calls within a few seconds are skipped.
 */
export async function restoreTree(absDir: string): Promise<void> {
  if (!enabled()) return;
  const key = keyFor(absDir);
  if (!key) return;
  const last = restoredTrees.get(key);
  if (last && Date.now() - last < TREE_FRESH_MS && fs.existsSync(absDir)) return;
  restoredTrees.set(key, Date.now());
  const storage = getStorage();
  const keys = await storage.list(`${key}/`);
  await forEachLimit(keys, 32, async (k) => {
    const abs = path.join(config.dataDir, ...k.split('/'));
    if (fs.existsSync(abs)) return;
    try {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, await storage.read(k));
    } catch (e) {
      console.error('[durable-files] restore failed for', k, e instanceof Error ? e.message : e);
    }
  });
}

/**
 * Make the local folder match the storage backend: download what is missing and remove local files that are no longer
 * mirrored. For folders that several Lambda instances read and write (each has its own /tmp), where `restoreTree`,
 * which only adds, would let a file deleted on one instance reappear from another. Local files newer than the start of
 * this call are kept (they may be mid-write), and when nothing is mirrored yet the folder is left as it is.
 */
export async function syncTreeDown(absDir: string): Promise<void> {
  if (!enabled()) return;
  const key = keyFor(absDir);
  if (!key) return;
  const started = Date.now();
  const storage = getStorage();
  const keys = await storage.list(`${key}/`);
  if (keys.length === 0) return;
  const wanted = new Set(keys.map((k) => path.join(config.dataDir, ...k.split('/'))));
  await forEachLimit(keys, 32, async (k) => {
    const abs = path.join(config.dataDir, ...k.split('/'));
    if (fs.existsSync(abs)) return;
    try {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, await storage.read(k));
    } catch (e) {
      console.error('[durable-files] sync failed for', k, e instanceof Error ? e.message : e);
    }
  });
  const prune = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await prune(full); continue; }
      if (wanted.has(full)) continue;
      try {
        if ((await fs.promises.stat(full)).mtimeMs < started - 2000) await fs.promises.rm(full, { force: true });
      } catch { /* gone already */ }
    }
  };
  await prune(absDir);
}

/** Run `fn` over `items` with at most `limit` running at once (folders can hold thousands of files). */
async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Remove every mirrored file under `absDir` (after the folder was deleted or moved). */
export async function forgetTree(absDir: string): Promise<void> {
  if (!enabled()) return;
  const key = keyFor(absDir);
  if (!key) return;
  restoredTrees.delete(key);
  const storage = getStorage();
  for (const k of await storage.list(`${key}/`)) await storage.delete(k);
}

/** Mirror every file under a local folder (used after a folder is moved). */
export async function persistTree(absDir: string): Promise<void> {
  if (!enabled()) return;
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  if (!fs.existsSync(absDir)) return;
  await walk(absDir);
  await forEachLimit(files, 32, (f) => persistFile(f));
}
