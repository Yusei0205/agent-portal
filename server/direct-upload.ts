/**
 * Uploads that go from the browser straight to S3.
 *
 * On the cloud portal every request passes through a Lambda Function URL, which accepts at most 6 MB, so a bigger file cannot be
 * posted to the portal. Instead the portal hands the browser a presigned PUT link for a staging object, the browser uploads to
 * S3 itself, and the portal then checks the object and copies it to its permanent place, inside S3, without the bytes passing
 * through Lambda.
 *
 * Nothing is stored between the two calls. What the portal needs to remember travels in a sealed token (the same pattern as
 * claude-plan-oauth.ts): the person, the project, the upload id, the name and size chosen, and when it expires. Objects that were
 * uploaded but never completed live under STAGING_PREFIX, which an S3 lifecycle rule expires after a day.
 */

import { config } from './config.ts';
import { encrypt, decrypt } from './secrets.ts';
import { durableStorageEnabled } from './durable-files.ts';
import { getStorage } from './storage-instance.ts';
import type { StorageBackend } from './storage/index.ts';

/** Where uploads wait until the portal has checked them (under the storage prefix, `data/` in the cloud). */
export const STAGING_PREFIX = 'upload-staging';

/** The most one file attached to a chat message may be. Other uploads keep the per-kind limits in ai-attachments.ts. */
export const MAX_CHAT_UPLOAD_BYTES = 50 * 1024 * 1024;

/** How long the presigned PUT link works. */
export const UPLOAD_URL_SECONDS = 15 * 60;
/** How long the token stays valid: the link plus time for the browser to call back. */
export const UPLOAD_TOKEN_MS = 20 * 60_000;

export interface PendingUpload {
  v: 1;
  user: string;
  project: string;
  id: string;
  /** The name the person's file has, as chosen. */
  name: string;
  /** The name it is stored under. */
  safe: string;
  size: number;
  purpose: 'chat' | 'default';
  exp: number;
}

/** The storage backend when it can take direct uploads (S3 with presigned links), else null: the portal then takes the file itself. */
export function directUploadStorage(): (StorageBackend & Required<Pick<StorageBackend, 'presign' | 'head' | 'readRange' | 'copy'>>) | null {
  if (!durableStorageEnabled()) return null;
  let storage: StorageBackend;
  try { storage = getStorage(); } catch { return null; }
  return storage.presign && storage.head && storage.readRange && storage.copy
    ? (storage as StorageBackend & Required<Pick<StorageBackend, 'presign' | 'head' | 'readRange' | 'copy'>>)
    : null;
}

/** The logical path an upload waits at. Built here from ids and a cleaned name, never from what the browser sends. */
export function stagingKey(projectId: string, uploadId: string, safeName: string): string {
  return `${STAGING_PREFIX}/${projectId}/${uploadId}/${safeName}`;
}

export function sealUpload(p: PendingUpload): string {
  return encrypt(JSON.stringify(p), config.secretKey);
}

/** What the token says, or null when it is not ours, is for another person or project, or has expired. */
export function openUpload(token: unknown, userId: string, projectId: string): PendingUpload | null {
  if (typeof token !== 'string' || !token || token.length > 4096) return null;
  try {
    const p = JSON.parse(decrypt(token, config.secretKey)) as PendingUpload;
    if (p?.v !== 1 || p.user !== userId || p.project !== projectId || !(p.exp > Date.now())) return null;
    if (typeof p.id !== 'string' || typeof p.safe !== 'string' || typeof p.name !== 'string' || !Number.isInteger(p.size) || p.size < 1) return null;
    return p;
  } catch {
    return null;
  }
}
