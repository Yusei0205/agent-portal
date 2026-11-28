/**
 * Large attachments for a run: sent to the runner as download links instead of inline base64.
 *
 * Files within the inline limits (2 MB each, 8 MB together) travel in the runner's invocation as before. A larger file, up to
 * 50 MB, is left in S3 (the cloud portal mirrors every staged file there) and the runner is given a presigned link, which it
 * downloads itself (writeInputFilesAsync in runner-files.ts). Without S3 there is nowhere to link to, and the inline limits stay.
 */

import path from 'node:path';
import { collectInputFiles, URL_FILE_LIMITS } from './runner-files.ts';
import type { InputFile, LargeInputFiles } from './runner-files.ts';
import { durableKeyFor, durableStorageEnabled, persistFile } from '../durable-files.ts';
import { getStorage } from '../storage-instance.ts';

/** What one chat message may carry when large files can be sent as links. */
export const ATTACHMENT_LIMITS = { files: 5, fileBytes: URL_FILE_LIMITS.fileBytes, totalBytes: URL_FILE_LIMITS.totalBytes };

/** How long a download link works: long enough for a run to start and fetch its files, as for the workspace snapshot links. */
export const RUNNER_LINK_SECONDS = 2 * 60 * 60;

/** True when files can be handed to a runner as download links: S3 storage that can sign them. */
export function largeAttachmentsEnabled(): boolean {
  if (!durableStorageEnabled()) return false;
  try { return typeof getStorage().presign === 'function'; } catch { return false; }
}

/** The limits for chat attachments on this deployment, and whether the large ones apply. */
export function attachmentLimits(): { files: number; fileBytes: number; totalBytes: number; large: boolean } {
  return largeAttachmentsEnabled()
    ? { ...ATTACHMENT_LIMITS, large: true }
    : { files: 5, fileBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, large: false };
}

/**
 * The files staged for a run: small ones inline, large ones as `{ path, url, size }` when the deployment can sign links
 * (otherwise exactly collectInputFiles). Throws when a file of the current message is over the limits.
 */
export async function collectInputFilesWithUrls(workDir: string, preferredPaths: string[] = []): Promise<InputFile[]> {
  if (!largeAttachmentsEnabled()) return collectInputFiles(workDir, preferredPaths);
  const large: LargeInputFiles = { fileBytes: URL_FILE_LIMITS.fileBytes, totalBytes: URL_FILE_LIMITS.totalBytes, files: [] };
  const inline = collectInputFiles(workDir, preferredPaths, large);
  const storage = getStorage();
  const links: InputFile[] = [];
  for (const f of large.files) {
    const key = durableKeyFor(f.abs);
    if (!key) throw new Error(`The attachment ${path.basename(f.path)} could not be sent to the agent`);
    // Staged files are mirrored when they are written; one that is not there yet is mirrored now.
    if (!(await storage.exists(key))) await persistFile(f.abs);
    links.push({ path: f.path, url: await storage.presign!(key, 'get', RUNNER_LINK_SECONDS), size: f.size });
  }
  return [...inline, ...links];
}
