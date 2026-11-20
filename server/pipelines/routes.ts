/**
 * Pipeline monitor routes: the stored runs per repository, the settings and the chat webhook.
 * Members read; project owners and portal admins write. The chat URL is never returned (host and last 4 only).
 */

import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { badRequest } from '../util.ts';
import { requireProjectMember, requireProjectOwnerOrAdmin } from '../project-access-routes.ts';
import { parseGitHubOwnerRepo } from '../review.ts';
import { isGithubRepo } from '../autofix/intake.ts';
import { getPipelineRunsRepository } from '../repositories/pipeline-runs.ts';
import { getGitReposRepository } from '../repositories/git-repos.ts';
import { getPipelineSettings, savePipelineSettings, isAlertingBranch } from './settings.ts';
import { chatStatus, chatUrlHint, chatUrlProblem, getChatTarget, sendChat, setChatUrl } from './chat.ts';

const HISTORY_LIMIT = 20;

export function registerPipelineRoutes(): void {
  router.get('/api/projects/:id/pipelines', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const projectId = req.params.id;
    if (!await requireProjectMember(req, res, projectId)) return;
    const all = req.query.get('all') === '1';
    const [stored, settings, repoRows] = await Promise.all([
      getPipelineRunsRepository().latestPerBranch(projectId), getPipelineSettings(projectId), getGitReposRepository().listByProject(projectId),
    ]);
    const repos = [];
    for (const r of repoRows) {
      if (!isGithubRepo(r)) continue;
      const runs = stored.filter((x) => x.repo_id === r.id && (all || isAlertingBranch(settings, x.branch, r.default_branch)));
      const slug = parseGitHubOwnerRepo(r.url ?? '');
      repos.push({ repoId: r.id, fullName: slug ? `${slug.owner}/${slug.repo}` : r.name, defaultBranch: r.default_branch, runs });
    }
    sendJson(res, 200, { webhookSeen: stored.length > 0, repos });
  });

  router.get('/api/projects/:id/pipelines/history', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const projectId = req.params.id;
    if (!await requireProjectMember(req, res, projectId)) return;
    const repoId = req.query.get('repoId') ?? '';
    const repo = repoId ? (await getGitReposRepository().listByProject(projectId)).find((r) => r.id === repoId && isGithubRepo(r)) : undefined;
    if (!repo) { sendJson(res, 404, { error: 'Repository not found' }); return; }
    const wf = req.query.get('workflowId') ?? '';
    const workflowId = /^\d{1,15}$/.test(wf) ? Number(wf) : NaN;
    if (!Number.isInteger(workflowId) || workflowId < 1) throw badRequest('workflowId must be a positive integer');
    const branch = req.query.get('branch') ?? '';
    if (!branch || branch.length > 200) throw badRequest('branch must be 1 to 200 characters');
    const runs = await getPipelineRunsRepository().history(projectId, repo.id, workflowId, branch, HISTORY_LIMIT);
    sendJson(res, 200, { runs });
  });

  router.get('/api/projects/:id/pipelines/settings', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const projectId = req.params.id;
    if (!await requireProjectMember(req, res, projectId)) return;
    const [settings, hint, status] = await Promise.all([getPipelineSettings(projectId), chatUrlHint(projectId), chatStatus(projectId)]);
    sendJson(res, 200, { settings, chat: { hint, status } });
  });

  router.put('/api/projects/:id/pipelines/settings', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const projectId = req.params.id;
    if (!await requireProjectOwnerOrAdmin(req, res, projectId)) return;
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('Body must be a JSON object');
    const settings = await savePipelineSettings(projectId, body as Record<string, never>, { actorId: req.user!.id, ip: req.ip });
    sendJson(res, 200, { settings });
  });

  router.put('/api/projects/:id/pipelines/chat', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const projectId = req.params.id;
    if (!await requireProjectOwnerOrAdmin(req, res, projectId)) return;
    const url = (req.body as { url?: unknown } | null)?.url;
    if (url !== null && typeof url !== 'string') throw badRequest('url must be a string or null');
    if (typeof url === 'string') {
      const problem = chatUrlProblem(url);
      if (problem) throw badRequest(problem);
    }
    await setChatUrl(projectId, url, { actorId: req.user!.id, ip: req.ip });
    sendJson(res, 200, { hint: await chatUrlHint(projectId), status: await chatStatus(projectId) });
  });

  router.post('/api/projects/:id/pipelines/chat/test', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const projectId = req.params.id;
    if (!await requireProjectOwnerOrAdmin(req, res, projectId)) return;
    if (!await getChatTarget(projectId)) throw badRequest('No chat URL is set');
    sendJson(res, 200, { ok: await sendChat(projectId, 'Test message from Agent Portal') });
  });
}
