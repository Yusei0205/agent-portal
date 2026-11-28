/**
 * Local filesystem storage backend.
 *
 * Stores files under DATA_DIR. The publicUrl returns a portal-proxied URL
 * (/api/storage-file?path=...) that the server resolves to the actual file.
 */

import type { StorageBackend } from './index.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

export class LocalStorageBackend implements StorageBackend {
  constructor(private dataDir: string) {}

  async write(logicalPath: string, data: Buffer, _mimeType?: string): Promise<string> {
    const abs = path.join(this.dataDir, logicalPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
    return logicalPath;
  }

  async read(logicalPath: string): Promise<Buffer> {
    return fs.readFile(path.join(this.dataDir, logicalPath));
  }

  async delete(logicalPath: string): Promise<void> {
    await fs.unlink(path.join(this.dataDir, logicalPath)).catch(() => {});
  }

  async exists(logicalPath: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.dataDir, logicalPath));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const root = path.join(this.dataDir, prefix);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(path.relative(this.dataDir, full).split(path.sep).join('/'));
      }
    };
    await walk(root);
    return out;
  }

  async publicUrl(logicalPath: string, _filename?: string): Promise<string> {
    // Returns a path the portal proxies: /api/storage-file?path=<encoded>
    return `/api/storage-file?path=${encodeURIComponent(logicalPath)}`;
  }

  async ping(): Promise<void> {
    await fs.access(this.dataDir);
  }
}
