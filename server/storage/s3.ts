/**
 * AWS S3 storage backend.
 *
 * Stores files in an S3 bucket. This module is dynamically imported only
 * when STORAGE_BACKEND=s3 to avoid bundling AWS SDK in local mode.
 *
 * Required env vars:
 *   STORAGE_S3_BUCKET  — bucket name
 *   STORAGE_S3_PREFIX  — (optional) key prefix, e.g. 'portal/'
 *   STORAGE_S3_REGION  — (optional) AWS region, falls back to AWS_REGION
 *
 * Optional dependencies (install when STORAGE_BACKEND=s3):
 *   @aws-sdk/client-s3
 *   @aws-sdk/s3-request-presigner
 */

import type { StorageBackend } from './index.ts';

// ── Minimal type stubs for optional AWS SDK ───────────────────────────────────
// These only exist to keep TypeScript happy; the real implementations are
// loaded dynamically via Function('m', 'return import(m)') at runtime.

interface AnyCommand {
  readonly input: object;
}

interface S3ClientLike {
  send(cmd: AnyCommand): Promise<unknown>;
}

// ── S3BackendOptions ──────────────────────────────────────────────────────────

interface S3BackendOptions {
  bucket: string;
  prefix: string;
  region: string;
}

// ── Helpers for dynamic imports ───────────────────────────────────────────────

// Using Function() indirection prevents static bundlers from analysing the
// import and avoids TypeScript module-resolution errors for optional packages.
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;

async function s3Sdk(): Promise<{
  S3Client: new (opts: { region: string }) => S3ClientLike;
  PutObjectCommand: new (opts: object) => AnyCommand;
  GetObjectCommand: new (opts: object) => AnyCommand;
  DeleteObjectCommand: new (opts: object) => AnyCommand;
  HeadObjectCommand: new (opts: object) => AnyCommand;
  HeadBucketCommand: new (opts: object) => AnyCommand;
}> {
  return dynamicImport('@aws-sdk/client-s3') as Promise<ReturnType<typeof s3Sdk>>;
}

async function presignerSdk(): Promise<{
  getSignedUrl: (client: S3ClientLike, cmd: AnyCommand, opts: { expiresIn: number }) => Promise<string>;
}> {
  return dynamicImport('@aws-sdk/s3-request-presigner') as Promise<ReturnType<typeof presignerSdk>>;
}

// ── S3StorageBackend ──────────────────────────────────────────────────────────

export class S3StorageBackend implements StorageBackend {
  private bucket: string;
  private prefix: string;
  private region: string;
  private _client: S3ClientLike | null = null;

  constructor(opts: S3BackendOptions) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix;
    this.region = opts.region;
  }

  /** Lazily initialise the S3 client (once). */
  private async client(): Promise<S3ClientLike> {
    if (this._client) return this._client;
    const mod = await s3Sdk();
    this._client = new mod.S3Client({ region: this.region });
    return this._client;
  }

  /** Build the full S3 key from a logical path. */
  private key(logicalPath: string): string {
    return this.prefix ? `${this.prefix.replace(/\/$/, '')}/${logicalPath}` : logicalPath;
  }

  async write(logicalPath: string, data: Buffer, mimeType?: string): Promise<string> {
    const mod = await s3Sdk();
    const client = await this.client();
    await client.send(
      new mod.PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(logicalPath),
        Body: data,
        ...(mimeType ? { ContentType: mimeType } : {}),
      }),
    );
    return logicalPath;
  }

  async read(logicalPath: string): Promise<Buffer> {
    const mod = await s3Sdk();
    const client = await this.client();
    const resp = await client.send(
      new mod.GetObjectCommand({ Bucket: this.bucket, Key: this.key(logicalPath) }),
    ) as { Body?: AsyncIterable<Uint8Array> };

    const body = resp.Body;
    if (!body) throw new Error(`S3 object ${logicalPath} has no body`);

    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async delete(logicalPath: string): Promise<void> {
    const mod = await s3Sdk();
    const client = await this.client();
    await client.send(
      new mod.DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(logicalPath) }),
    ).catch(() => {});
  }

  async exists(logicalPath: string): Promise<boolean> {
    const mod = await s3Sdk();
    const client = await this.client();
    try {
      await client.send(
        new mod.HeadObjectCommand({ Bucket: this.bucket, Key: this.key(logicalPath) }),
      );
      return true;
    } catch (e: unknown) {
      // NoSuchKey or 404 → file doesn't exist
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (
        err.name === 'NoSuchKey' ||
        err.name === 'NotFound' ||
        err.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      throw e;
    }
  }

  async publicUrl(logicalPath: string, filename?: string): Promise<string> {
    const [s3Mod, presignMod] = await Promise.all([s3Sdk(), presignerSdk()]);
    const client = await this.client();

    const cmdOpts: Record<string, unknown> = { Bucket: this.bucket, Key: this.key(logicalPath) };
    if (filename) {
      cmdOpts.ResponseContentDisposition = `attachment; filename="${filename}"`;
    }

    return presignMod.getSignedUrl(client, new s3Mod.GetObjectCommand(cmdOpts), {
      expiresIn: 900, // 15 minutes
    });
  }

  async ping(): Promise<void> {
    const mod = await s3Sdk();
    const client = await this.client();
    await client.send(new mod.HeadBucketCommand({ Bucket: this.bucket }));
  }
}
