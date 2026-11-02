/** GET /api/realtime/config: tells the browser whether to use AppSync Events, and gives it a token. */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { realtimeEnabled, issueRealtimeToken, TOKEN_TTL_SECONDS } from './realtime.ts';

export function registerRealtimeRoutes(): void {
  router.get('/api/realtime/config', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    if (!realtimeEnabled()) { sendJson(res, 200, { enabled: false }); return; }

    const isAdmin = Boolean(req.user.is_admin);
    const projects = isAdmin ? [] : await getProjectRepository().listMyProjects(req.user.id);
    const token = issueRealtimeToken({ id: req.user.id, is_admin: isAdmin }, projects.map((p) => p.id));
    sendJson(res, 200, {
      enabled: true,
      httpDomain: process.env.PORTAL_EVENTS_HTTP_DOMAIN,
      realtimeDomain: process.env.PORTAL_EVENTS_REALTIME_DOMAIN,
      token,
      expiresIn: TOKEN_TTL_SECONDS,
    });
  });
}
