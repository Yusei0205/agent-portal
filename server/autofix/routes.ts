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
import { getAutofixFindingsRepository, FINDING_STATUSES } from '../repositories/autofix-findings.ts';
import type { FindingStatus } from '../repositories/autofix-findings.ts';
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

const DEFAULT_FINDINGS_LIMIT = 50;
const MAX_FINDINGS_LIMIT = 100;

function parseStatus(raw: unknown): FindingStatus | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !(FINDING_STATUSES as readonly string[]).includes(raw)) throw badRequest('Unknown status');
  return raw as FindingStatus;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return DEFAULT_FINDINGS_LIMIT;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) throw badRequest('limit must be a positive integer');
  return Math.min(n, MAX_FINDINGS_LIMIT);
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

  // The list leaves out the evidence (it can be large); the detail route returns it.
  router.get('/api/projects/:id/autofix/findings', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectMember(req, res, req.params.id)) return;
    const status = parseStatus(req.query.get('status') ?? undefined);
    const limit = parseLimit(req.query.get('limit') ?? undefined);
    const repo = getAutofixFindingsRepository();
    const [rows, counts] = await Promise.all([repo.list(req.params.id, { status, limit }), repo.countByStatus(req.params.id)]);
    const findings = rows.map(({ evidence: _evidence, ...rest }) => rest);
    sendJson(res, 200, { findings, counts });
  });

  router.get('/api/projects/:id/autofix/findings/:fid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectMember(req, res, req.params.id)) return;
    const finding = await getAutofixFindingsRepository().getById(req.params.fid);
    if (!finding || finding.project_id !== req.params.id) { sendJson(res, 404, { error: 'Finding not found' }); return; }
    sendJson(res, 200, { finding });
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
