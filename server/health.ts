/**
 * Health and readiness endpoints.
 *
 * GET /api/health  — lightweight liveness check
 * GET /api/ready   — readiness check (db, dataDir writable, secretKey present, storage)
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { isDbOpen, one } from './db.ts';
import { config } from './config.ts';
import { getStorage } from './storage-instance.ts';
import fs from 'node:fs';
import path from 'node:path';

export function registerHealthRoutes(): void {
  /**
   * GET /api/health
   * Lightweight liveness probe — just verifies the DB is open and responsive.
   */
  router.get('/api/health', (_req: PortalRequest, res: PortalResponse): void => {
    if (!isDbOpen()) {
      sendJson(res, 503, { ok: false, db: 'error' });
      return;
    }
    try {
      one<{ n: number }>('SELECT 1 AS n');
    } catch {
      sendJson(res, 503, { ok: false, db: 'error' });
      return;
    }
    sendJson(res, 200, { ok: true, db: 'ok' });
  });

  /**
   * GET /api/ready
   * Readiness probe — checks all required subsystems.
   */
  router.get('/api/ready', async (_req: PortalRequest, res: PortalResponse): Promise<void> => {
    const checks: Record<string, string> = {};
    let allOk = true;

    // 1. DB check
    try {
      if (!isDbOpen()) throw new Error('not open');
      one<{ n: number }>('SELECT 1 AS n');
      checks.db = 'ok';
    } catch {
      checks.db = 'error';
      allOk = false;
    }

    // 2. dataDir writable
    try {
      const testFile = path.join(config.dataDir, '.readiness-probe');
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
      checks.dataDir = 'ok';
    } catch {
      checks.dataDir = 'error';
      allOk = false;
    }

    // 3. Secret key present
    if (config.secretKey) {
      checks.secretKey = 'ok';
    } else {
      checks.secretKey = 'missing';
      // warn but not fatal — server will auto-generate a key
    }

    // 4. Storage ping
    if (process.env.STORAGE_BACKEND === 's3') {
      try {
        const storage = getStorage();
        await storage.ping();
        checks.storage = 'ok';
      } catch {
        checks.storage = 'fail';
        allOk = false;
      }
    } else {
      checks.storage = 'skip';
    }

    sendJson(res, allOk ? 200 : 503, { ok: allOk, checks });
  });
}
