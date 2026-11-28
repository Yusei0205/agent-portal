/**
 * Portal-wide SSE endpoint.
 *
 * GET /api/events — delivers portal-level events (emitGlobal) to any
 * signed-in browser session.  API tokens are refused so that automated
 * callers cannot subscribe to portal events.
 *
 * Only events emitted via emitGlobal() are delivered here (e.g. theme.changed).
 * Per-project run events (emit(projectId, …)) are intentionally excluded to
 * prevent cross-project data leaks.
 */

import { router, requireCookieAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { subscribeGlobalOnly } from './events.ts';

export function registerPortalEventsRoutes(): void {
  router.sse(
    '/api/events',
    requireCookieAuth((req: PortalRequest, res: PortalResponse) => {
      subscribeGlobalOnly(res);
    }),
  );
}
