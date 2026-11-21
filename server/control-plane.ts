/**
 * Session control plane — concurrency caps, graceful drain, queue management.
 *
 * Routes:
 *   GET  /api/admin/control-plane  — status (admin only)
 *   POST /api/admin/drain          — toggle drain mode (admin only)
 *   POST /api/admin/caps           — update concurrency caps (admin only)
 */

import { one } from './db.ts';
import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';

// ── Drain state ───────────────────────────────────────────────────────────────

let draining = false;
let drainStart = 0;

export function isDraining(): boolean {
  return draining;
}

export function startDrain(): void {
  if (draining) return;
  draining = true;
  drainStart = Date.now();
  console.log('[drain] Drain mode started; no new sessions will be accepted.');
}

export function stopDrain(): void {
  draining = false;
  drainStart = 0;
}

// ── Concurrency caps ──────────────────────────────────────────────────────────

export interface ConcurrencyCaps {
  globalMax: number;
  perUserMax: number;
  perProjectMax: number;
}

const currentCaps: ConcurrencyCaps = {
  globalMax: 0,
  perUserMax: 5,
  perProjectMax: 0,
};

export function getCaps(): ConcurrencyCaps {
  return { ...currentCaps };
}

export function setCaps(caps: Partial<ConcurrencyCaps>): void {
  if (caps.globalMax !== undefined) currentCaps.globalMax = Math.max(0, Number(caps.globalMax));
  if (caps.perUserMax !== undefined) currentCaps.perUserMax = Math.max(0, Number(caps.perUserMax));
  if (caps.perProjectMax !== undefined) currentCaps.perProjectMax = Math.max(0, Number(caps.perProjectMax));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countRunning(filter?: { userId?: string; projectId?: string }): number {
  const conditions: string[] = ["status = 'running'", "parent_id IS NULL"];
  const params: string[] = [];
  if (filter?.userId) { conditions.push('created_by = ?'); params.push(filter.userId); }
  if (filter?.projectId) { conditions.push('project_id = ?'); params.push(filter.projectId); }
  return Number(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM p6_workflows WHERE ${conditions.join(' AND ')}`,
      ...params,
    )?.n ?? 0,
  );
}

export function runningCount(): number {
  return countRunning();
}

export function checkConcurrency(userId: string, projectId: string): string | null {
  if (isDraining()) {
    return 'The server is restarting soon. New sessions are paused. Please try again in a moment.';
  }
  const caps = getCaps();
  if (caps.globalMax > 0 && countRunning() >= caps.globalMax) {
    return `The portal already has ${caps.globalMax} sessions running. Stop one to start another.`;
  }
  if (caps.perUserMax > 0 && countRunning({ userId }) >= caps.perUserMax) {
    return `You already have ${caps.perUserMax} sessions running. Stop one to start another.`;
  }
  if (caps.perProjectMax > 0 && countRunning({ projectId }) >= caps.perProjectMax) {
    return `This project already has ${caps.perProjectMax} sessions running. Stop one to start another.`;
  }
  return null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerControlPlaneRoutes(): void {
  /** GET /api/admin/control-plane — queue depth, running counts, drain state, caps */
  router.get(
    '/api/admin/control-plane',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      if (!req.user?.is_admin) {
        sendJson(res, 403, { error: 'Admin access required' });
        return;
      }

      const running = countRunning();
      const queued = Number(
        one<{ n: number }>("SELECT COUNT(*) AS n FROM p6_workflows WHERE status = 'queued'")?.n ?? 0,
      );
      const pendingApprovals = Number(
        one<{ n: number }>("SELECT COUNT(*) AS n FROM inputs WHERE status = 'pending'")?.n ?? 0,
      );

      sendJson(res, 200, {
        drain: {
          active: draining,
          startedAt: draining ? new Date(drainStart).toISOString() : null,
        },
        sessions: { running, queued },
        approvals: { pending: pendingApprovals },
        caps: getCaps(),
      });
    }),
  );

  /** POST /api/admin/drain — toggle drain mode */
  router.post(
    '/api/admin/drain',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      if (!req.user?.is_admin) {
        sendJson(res, 403, { error: 'Admin access required' });
        return;
      }
      const body = req.body as { enable?: boolean };
      if (body.enable) {
        startDrain();
      } else {
        stopDrain();
      }
      sendJson(res, 200, {
        drain: { active: draining, startedAt: draining ? new Date(drainStart).toISOString() : null },
      });
    }),
  );

  /** POST /api/admin/caps — update concurrency caps */
  router.post(
    '/api/admin/caps',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      if (!req.user?.is_admin) {
        sendJson(res, 403, { error: 'Admin access required' });
        return;
      }
      const body = req.body as Partial<ConcurrencyCaps>;
      setCaps(body);
      sendJson(res, 200, { caps: getCaps() });
    }),
  );
}
