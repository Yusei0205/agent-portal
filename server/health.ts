/**
 * Health and readiness endpoints.
 *
 * GET /api/health  — lightweight liveness check
 * GET /api/ready   — readiness check (db, dataDir writable, secretKey present)
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { isDbOpen, one } from './db.ts';
import { config } from './config.ts';
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
  router.get('/api/ready', (_req: PortalRequest, res: PortalResponse): void => {
    const checks: Record<string, string> = {};
    let allOk = true;

    // DB check
    try {
      if (!isDbOpen()) throw new Error('not open');
      one<{ n: number }>('SELECT 1 AS n');
      checks.db = 'ok';
    } catch {
      checks.db = 'error';
      allOk = false;
    }

    // dataDir writable
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

    // Secret key present
    if (config.secretKey) {
      checks.secretKey = 'ok';
    } else {
      checks.secretKey = 'missing';
      // warn but not fatal — server will auto-generate a key
    }

    // Storage: skip if not S3
    // (S3 storage check would go here if configured; default is local disk)
    checks.storage = 'ok';

    sendJson(res, allOk ? 200 : 503, { ok: allOk, checks });
  });
}
