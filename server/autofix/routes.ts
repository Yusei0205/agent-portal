/**
 * Auto-fix routes. Each task adds its own routes inside registerAutofixRoutes().
 */

import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { badRequest } from '../util.ts';
import { requireProjectMember, requireProjectOwnerOrAdmin } from '../project-access-routes.ts';
import { getAutofixPolicy, saveAutofixPolicy, setPaused, removeAutofixClass, getPauseFlags } from './policy.ts';
import { unattendedPushAllowed } from './delivery.ts';
import { maybeProcess } from './pipeline.ts';
import { getAuditRepository } from '../repositories/audit.ts';
import { getGitReposRepository } from '../repositories/git-repos.ts';
import { githubPullRequestState } from '../pull-requests.ts';
import type { Repository } from '../repos.ts';
import type { AutofixPolicy } from './policy.ts';
import { newWebhookSecret } from '../loop-triggers.ts';
import { setSecret } from '../secrets.ts';
import { getAutofixFindingsRepository, FINDING_STATUSES } from '../repositories/autofix-findings.ts';
import type { FindingStatus, AutofixFinding } from '../repositories/autofix-findings.ts';
import { registerAutofixWebhook, webhookSecretName } from './webhook.ts';

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

async function loadFinding(req: PortalRequest, res: PortalResponse): Promise<AutofixFinding | null> {
  const finding = await getAutofixFindingsRepository().getById(req.params.fid);
  if (!finding || finding.project_id !== req.params.id) { sendJson(res, 404, { error: 'Finding not found' }); return null; }
  return finding;
}

async function auditFinding(req: PortalRequest, action: string, f: AutofixFinding, extra: Record<string, unknown> = {}): Promise<void> {
  await getAuditRepository().append({
    actorId: req.user!.id, action, target: f.id, detail: { project_id: f.project_id, kind: f.kind, previous_status: f.status, ...extra }, ip: req.ip,
  });
}

/** Statuses a person may dismiss from: everything that is not already finished. */
const DISMISSABLE: FindingStatus[] = ['new', 'triaged', 'fixing', 'pr_open', 'suppressed', 'needs_human'];
const RETRYABLE: FindingStatus[] = ['needs_human', 'new', 'suppressed'];

/** Whether the finding's PR is open on the host; no PR number, no repository or an unreadable state count as not open. */
async function prStillOpen(f: AutofixFinding): Promise<boolean> {
  if (f.pr_number == null || !f.repo_id) return false;
  const rec = await getGitReposRepository().getById(f.repo_id).catch(() => null);
  if (!rec) return false;
  return (await githubPullRequestState(rec as unknown as Repository, f.pr_number).catch(() => null)) === 'open';
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
    const paused = await getPauseFlags(req.params.id);
    sendJson(res, 200, { policy: await getAutofixPolicy(req.params.id), unattended_push_enabled: unattendedPushAllowed(), paused: paused.project, paused_global: paused.global });
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

  router.post('/api/projects/:id/autofix/findings/:fid/dismiss', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectOwnerOrAdmin(req, res, req.params.id)) return;
    const f = await loadFinding(req, res);
    if (!f) return;
    if (!await getAutofixFindingsRepository().transition(f.id, DISMISSABLE, { status: 'dismissed' })) {
      sendJson(res, 409, { error: `This finding is already ${f.status}` }); return;
    }
    await auditFinding(req, 'autofix.finding.dismiss', f);
    sendJson(res, 200, { finding: await getAutofixFindingsRepository().getById(f.id) });
  });

  // Dismiss, and stop auto-fix acting on this kind of finding in this project.
  router.post('/api/projects/:id/autofix/findings/:fid/never-fix', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectOwnerOrAdmin(req, res, req.params.id)) return;
    const f = await loadFinding(req, res);
    if (!f) return;
    if (!await getAutofixFindingsRepository().transition(f.id, DISMISSABLE, { status: 'dismissed' })) {
      sendJson(res, 409, { error: `This finding is already ${f.status}` }); return;
    }
    const policy = await removeAutofixClass(req.params.id, f.kind, { actorId: req.user!.id, ip: req.ip });
    await auditFinding(req, 'autofix.finding.never_fix', f);
    sendJson(res, 200, { finding: await getAutofixFindingsRepository().getById(f.id), classes: policy.classes });
  });

  // Back to `new` with the attempts and cooldown cleared; the pipeline picks it up again.
  router.post('/api/projects/:id/autofix/findings/:fid/retry', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectOwnerOrAdmin(req, res, req.params.id)) return;
    const f = await loadFinding(req, res);
    if (!f) return;
    // A needs_human finding may still name the branch of a PR a person since closed (or one whose state cannot be read): a retry must
    // not push to it, so it starts a fresh branch and PR instead. pr_number and pr_url stay for history.
    let clearPr = {};
    if (f.status === 'needs_human' && f.pr_branch && !(await prStillOpen(f))) clearPr = { pr_branch: null, pr_head_sha: null };
    if (!await getAutofixFindingsRepository().transition(f.id, RETRYABLE, { status: 'new', attempts: 0, cooldown_until: null, ...clearPr })) {
      sendJson(res, 409, { error: `A ${f.status} finding cannot be retried` }); return;
    }
    await auditFinding(req, 'autofix.finding.retry', f);
    void maybeProcess(f.id);
    sendJson(res, 200, { finding: await getAutofixFindingsRepository().getById(f.id) });
  });
}
