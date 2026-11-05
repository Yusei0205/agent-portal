/**
 * Storage abstraction layer.
 *
 * Provides a uniform interface over local filesystem storage and AWS S3.
 * The backend is selected via the STORAGE_BACKEND environment variable:
 *   - 'local' (default): stores files in the DATA_DIR
 *   - 's3': stores files in an S3 bucket (requires @aws-sdk/client-s3)
 *
 * S3 dependencies are dynamically imported so they are not bundled in local mode.
 */

export interface StorageBackend {
  /**
   * Write a file to the storage backend.
   * @returns The logical path (key) of the stored file.
   */
  write(logicalPath: string, data: Buffer, mimeType?: string): Promise<string>;

  /** Read a file from the storage backend. */
  read(logicalPath: string): Promise<Buffer>;

  /** Delete a file. Silently ignores missing files. */
  delete(logicalPath: string): Promise<void>;

  /** Returns true if the file exists. */
  exists(logicalPath: string): Promise<boolean>;

  /** Logical paths of every file whose path starts with `prefix` (recursive, no ordering guarantee). */
  list(prefix: string): Promise<string[]>;
  /**
   * Like `list`, with a version tag per file that changes whenever the file is rewritten (the S3 ETag).
   * Optional: without it, callers can only tell whether a file exists, not whether it changed.
   */
  listVersions?(prefix: string): Promise<Array<{ path: string; version: string }>>;

  /**
   * Returns a URL the browser can use to access the file.
   * Local backend → proxied via /api/storage-file
   * S3 backend → presigned URL (15 min)
   */
  publicUrl(logicalPath: string, filename?: string): Promise<string>;

  /** Connectivity / health check. Throws on failure. */
  ping(): Promise<void>;
}

/**
 * Creates the appropriate storage backend based on the STORAGE_BACKEND env var.
 * Returns LocalStorageBackend unless STORAGE_BACKEND=s3.
 */
export async function createStorageBackend(): Promise<StorageBackend> {
  const backend = process.env.STORAGE_BACKEND ?? 'local';

  if (backend === 's3') {
    // Dynamic import so S3 SDK is not bundled in local mode
    const { S3StorageBackend } = await import('./s3.ts');
    const bucket = process.env.STORAGE_S3_BUCKET;
    if (!bucket) {
      throw new Error('STORAGE_S3_BUCKET must be set when STORAGE_BACKEND=s3');
    }
    const prefix = process.env.STORAGE_S3_PREFIX ?? '';
    const region = process.env.STORAGE_S3_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
    return new S3StorageBackend({ bucket, prefix, region });
  }

  // Default: local filesystem
  const { LocalStorageBackend } = await import('./local.ts');
  const dataDir = process.env.DATA_DIR ?? './data';
  return new LocalStorageBackend(dataDir);
}
