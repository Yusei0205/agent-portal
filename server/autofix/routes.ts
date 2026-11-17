/**
 * Auto-fix routes. Each task adds its own routes inside registerAutofixRoutes().
 */

import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { badRequest } from '../util.ts';
import { getMemberRow, getProjectRow } from '../project-access.ts';
import { getAutofixPolicy, saveAutofixPolicy, setPaused } from './policy.ts';
import type { AutofixPolicy } from './policy.ts';
import { newWebhookSecret } from '../loop-triggers.ts';
import { setSecret } from '../secrets.ts';
import { registerAutofixWebhook, webhookSecretName } from './webhook.ts';

/** Any project member (or an admin) may read; non-members see 404. */
async function requireProjectMember(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  if (!await getProjectRow(projectId)) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  if (!await getMemberRow(projectId, req.user.id)) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  return true;
}

/** Only a portal admin or a project owner may change the policy or pause a project. */
async function requireProjectOwnerOrAdmin(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  if (!await getProjectRow(projectId)) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (String(member.access) !== 'owner') { sendJson(res, 403, { error: 'Project owner or admin access required' }); return false; }
  return true;
}

function pausedFlag(body: unknown): boolean {
  const paused = (body as { paused?: unknown } | null)?.paused;
  if (typeof paused !== 'boolean') throw badRequest('paused must be a boolean');
  return paused;
}

export function registerAutofixRoutes(): void {
  registerAutofixWebhook();

  // Rotate the GitHub webhook secret. The new secret is returned once and cannot be read again.
  router.post('/api/projects/:id/autofix/webhook-secret', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectOwnerOrAdmin(req, res, req.params.id)) return;
    const secret = newWebhookSecret();
    await setSecret(webhookSecretName(req.params.id), secret);
    sendJson(res, 200, { secret });
  });

  router.get('/api/projects/:id/autofix/policy', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectMember(req, res, req.params.id)) return;
    sendJson(res, 200, { policy: await getAutofixPolicy(req.params.id) });
  });

  router.put('/api/projects/:id/autofix/policy', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectOwnerOrAdmin(req, res, req.params.id)) return;
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('Body must be a JSON object');
    const policy = await saveAutofixPolicy(req.params.id, body as Partial<AutofixPolicy>, { actorId: req.user!.id, ip: req.ip, isAdmin: Boolean(req.user!.is_admin) });
    sendJson(res, 200, { policy });
  });

  router.post('/api/projects/:id/autofix/pause', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectOwnerOrAdmin(req, res, req.params.id)) return;
    const paused = pausedFlag(req.body);
    await setPaused(req.params.id, paused, { actorId: req.user!.id, ip: req.ip });
    sendJson(res, 200, { paused });
  });

  router.post('/api/autofix/pause', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    if (!req.user.is_admin) { sendJson(res, 403, { error: 'Admin access required' }); return; }
    const paused = pausedFlag(req.body);
    await setPaused('global', paused, { actorId: req.user.id, ip: req.ip });
    sendJson(res, 200, { paused });
  });
}
