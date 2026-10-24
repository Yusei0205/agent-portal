/**
 * Unauthenticated health endpoint for Docker / load-balancer health checks.
 *
 * GET /api/health
 *   200  { ok: true,  version: string, db: 'ok' }   — server is up, DB responded
 *   503  { ok: false, reason: string }               — draining or DB error
 *
 * The route bypasses both auth and the CSRF same-origin check.
 * It intentionally reveals nothing sensitive.
 */
import { get } from './http.ts';
import { one } from './db.ts';
import { isDraining } from './control-plane.ts';

export function registerHealthRoutes(): void {
  get('/api/health', (_ctx) => {
    if (isDraining()) {
      _ctx.res.statusCode = 503;
      return { ok: false, reason: 'draining' };
    }
    try {
      // Trivial query — just proves the DB file is open and responsive.
      one<{ n: number }>('SELECT 1 AS n');
    } catch {
      _ctx.res.statusCode = 503;
      return { ok: false, reason: 'db_error' };
    }
    return { ok: true, db: 'ok' };
  }, { auth: 'public', csrfExempt: true });
}
