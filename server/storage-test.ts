/**
 * POST /api/admin/test-storage (admin only): checks that the portal can use an S3 bucket.
 *
 * The setup wizard's Storage step calls this with { bucket, region, prefix }. It writes, reads
 * and deletes a small probe object, so a pass means the portal's credentials can really store files.
 */

import { router, sendJson, requireCookieAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { HttpError, str } from './util.ts';

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function registerStorageTestRoutes(): void {
  router.post(
    '/api/admin/test-storage',
    requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
      if (!req.user?.is_admin) {
        sendJson(res, 403, { error: 'Admin access required' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const bucket = str(body.bucket, 'Bucket', { max: 63 }).trim();
      const region = str(body.region, 'Region', { max: 30 }).trim();
      const prefix = typeof body.prefix === 'string' ? body.prefix.trim().replace(/^\/+/, '') : '';
      if (!BUCKET_RE.test(bucket)) throw new HttpError(400, 'Bucket name is not valid.');
      if (!REGION_RE.test(region)) throw new HttpError(400, 'Region is not valid (example: ap-southeast-1).');

      const { S3StorageBackend } = await import('./storage/s3.ts');
      const store = new S3StorageBackend({ bucket, prefix, region });
      const key = `.portal-storage-test/${Date.now()}.txt`;
      const probe = Buffer.from('agent-portal storage test');
      try {
        await store.ping();
        await store.write(key, probe, 'text/plain');
        const back = await store.read(key);
        if (!back.equals(probe)) throw new Error('The object read back does not match what was written.');
        await store.delete(key);
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
        const code = err.$metadata?.httpStatusCode;
        const hint =
          code === 403 ? 'Access denied: the portal\'s AWS role has no permission on this bucket.'
          : code === 404 || err.name === 'NotFound' || err.name === 'NoSuchBucket' ? 'Bucket not found in that region.'
          : (err.message ?? 'S3 request failed.');
        sendJson(res, 400, { error: `S3 check failed: ${hint}` });
        return;
      }
      sendJson(res, 200, { ok: true, message: `Verified: the portal can read and write s3://${bucket}/${prefix}` });
    }),
  );
}
