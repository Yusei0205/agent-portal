/**
 * The portal's side of the workspace snapshots (see runner-snapshot.ts): hands a runner two presigned S3 URLs, one to
 * save the session's workspace and one to restore the earlier copy. The runners hold no AWS permissions of their own.
 *
 * Only when the portal stores its files in S3; otherwise (local mode) there is nothing to hand out and the runner
 * just keeps the workspace for as long as its machine lives.
 */

import { getStorage } from '../storage-instance.ts';

/** Long enough for a run (up to 30 minutes) plus the save that follows it. */
const URL_LIFETIME_SECONDS = 2 * 60 * 60;

export const snapshotKey = (workflowId: string): string => `workspace-snapshots/${workflowId}.tar.gz`;

interface Presigning {
  presign(logicalPath: string, method: 'get' | 'put', expiresInSeconds: number): Promise<string>;
}

export interface SnapshotAccess {
  getUrl?: string;
  putUrl: string;
}

/** Null when snapshots are not available (local storage, or the URLs could not be made). Never throws. */
export async function snapshotAccess(workflowId: string): Promise<SnapshotAccess | null> {
  try {
    const storage = getStorage();
    if (typeof (storage as unknown as Partial<Presigning>).presign !== 'function') return null;
    const s3 = storage as unknown as Presigning;
    const key = snapshotKey(workflowId);
    const putUrl = await s3.presign(key, 'put', URL_LIFETIME_SECONDS);
    // Only offer a download when an earlier copy exists, so a first run does not go looking for nothing.
    const getUrl = (await storage.exists(key)) ? await s3.presign(key, 'get', URL_LIFETIME_SECONDS) : undefined;
    return { putUrl, ...(getUrl ? { getUrl } : {}) };
  } catch {
    return null;
  }
}

/** Removes the saved workspace of a deleted session. */
export async function deleteSnapshot(workflowId: string): Promise<void> {
  try { await getStorage().delete(snapshotKey(workflowId)); } catch { /* the bucket's expiry rule removes it anyway */ }
}
