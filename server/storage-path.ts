import path from 'node:path';
import { config } from './config.ts';

/** Files in the data folder that are never served: the database, the master key, environment files. */
const NEVER_SERVED = /(^|[\\/])(master\.key|\.env[^\\/]*|[^\\/]*\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?)$/i;

/** True when `abs` is inside `root` (the folder itself does not count; a sibling such as `root-evil` does not either). */
export function isInside(root: string, abs: string): boolean {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  return a !== r && a.startsWith(r + path.sep);
}

/** Whether /api/storage-file may serve this absolute path: inside the data folder and not a database or key file. */
export function isServableStoragePath(abs: string, dataDir: string = config.dataDir): boolean {
  return isInside(dataDir, abs) && !NEVER_SERVED.test(abs);
}
