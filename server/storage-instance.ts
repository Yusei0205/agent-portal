/**
 * Storage singleton.
 *
 * Initialised once at startup by initStorage(). Exported so health.ts
 * and other modules can access the singleton without circular imports.
 */

import type { StorageBackend } from './storage/index.ts';
import { createStorageBackend } from './storage/index.ts';

let _storage: StorageBackend | null = null;

/** Initialise the storage backend. Called once in startServer(). */
export async function initStorage(): Promise<StorageBackend> {
  _storage = await createStorageBackend();
  return _storage;
}

/** Returns the storage singleton. Throws if not yet initialised. */
export function getStorage(): StorageBackend {
  if (!_storage) {
    throw new Error('Storage not initialised. Call initStorage() first.');
  }
  return _storage;
}

/** Replace the storage singleton (for tests). */
export function setStorage(backend: StorageBackend): void {
  _storage = backend;
}
