import { router, sendJson, type PortalRequest } from '../http.ts';
import { badRequest, forbidden, generateId, HttpError, notFound, now, str } from '../util.ts';
import { getProjectRow, getMemberRow } from '../project-access.ts';
import { getGitReposRepository } from '../repositories/git-repos.ts';
import { getAutomationsRepository } from '../repositories/automations.ts';
import { parseGraph, sdlcTemplate } from './schema.ts';
import { automationTemplates } from './templates.ts';
import { definitionKey, versionKey, runKey, scheduleAutomation, type Definition, type PublishedVersion, type AutomationRun } from './engine.ts';

async function access(req: PortalRequest, write = false): Promise<string> {
  if (!req.user) throw new HttpError(401, 'Sign in to continue');
  if (req.tokenWorkflowId) throw forbidden('Session tokens cannot manage workflows');
  if (write && req.authViaToken && !req.tokenScopes?.includes('write')) throw forbidden('Write scope required');
  const project = req.params.id;
  const p = await getProjectRow(project);
  if (!p || p.archived) throw notFound('Project not found');
  const member = await getMemberRow(project, req.user.id);
  if (!req.user.is_admin && !member) throw notFound('Project not found');
  if (write && !req.user.is_admin && !['owner', 'editor'].includes(String(member?.access))) throw forbidden('Editor access required');
  return project;
}
async function definition(project: string, id: string): Promise<Definition> {
  const value = await (await getAutomationsRepository()).get<Definition>(project, definitionKey(id));
  if (!value || value.deleted_at) throw notFound('Workflow not found');
  return value;
}
/** Names are unique per project (ignoring case), so the list never shows two workflows that look the same. */
async function ensureFreshName(project: string, wanted: string, exceptId: string | null): Promise<void> {
  const all = await (await getAutomationsRepository()).list<Definition>(project, 'DEF#');
  const taken = all.some((d) => !d.deleted_at && d.id !== exceptId && d.name.trim().toLowerCase() === wanted.trim().toLowerCase());
  if (taken) throw new HttpError(409, `A workflow named "${wanted}" already exists in this project. Choose another name.`);
}
async function checkRepos(project: string, repoIds: string[]): Promise<void> {
  const allowed = new Set((await getGitReposRepository().listByProject(project)).map((r) => r.id));
  if (repoIds.some((id) => !allowed.has(id))) throw badRequest('Select repositories connected to this project');
}
const conflict = (): HttpError => new HttpError(409, 'This workflow changed. Reload it before saving again.');
function name(value: unknown): string {
  const text = str(value, 'Name', { max: 120 }).trim();
  if (!text) throw badRequest('Enter a workflow name');
  return text;
}
const prefix = '/api/projects/:id/automations';
export function registerAutomationRoutes(): void {
  router.get(prefix, async (req, res) => {
    const project = await access(req);
    const repo = await getAutomationsRepository();
    const definitions = (await repo.list<Definition>(project, 'DEF#')).filter((d) => !d.deleted_at);
    // What the list shows beside each workflow: how many runs, how many are going now, and the latest one.
    const stats: Record<string, { runs: number; active: number; lastStatus: string | null; lastStartedAt: string | null }> = {};
    for (const r of await repo.list<AutomationRun>(project, 'RUN#')) {
      const s = stats[r.definition_id] ??= { runs: 0, active: 0, lastStatus: null, lastStartedAt: null };
      s.runs++;
      if (['running', 'waiting'].includes(r.status)) s.active++;
      if (!s.lastStartedAt || r.started_at > s.lastStartedAt) { s.lastStartedAt = r.started_at; s.lastStatus = r.status; }
    }
    sendJson(res, 200, { definitions, stats, template: sdlcTemplate(), templates: automationTemplates(), executionAvailable: !process.env.AWS_LAMBDA_FUNCTION_NAME || Boolean(process.env.PORTAL_AUTOMATION_STATE_MACHINE_ARN) });
  });
  router.post(prefix, async (req, res) => {
    const project = await access(req, true); const body = req.body as Record<string, unknown>;
    const chosen = body.templateId === undefined ? null : automationTemplates().find((t) => t.id === body.templateId);
    if (body.templateId !== undefined && !chosen) throw badRequest('Choose one of the listed templates');
    const graph = parseGraph(body.graph ?? chosen?.graph ?? sdlcTemplate()); await checkRepos(project, graph.repoIds);
    const wanted = name(body.name); await ensureFreshName(project, wanted, null);
    const d: Definition = { id: generateId(), project_id: project, revision: 1, name: wanted, graph, published_version: null, created_by: req.user!.id, updated_at: now() };
    await (await getAutomationsRepository()).put(project, definitionKey(d.id), d, null);
    sendJson(res, 201, { definition: d });
  });
  router.get(`${prefix}/:aid`, async (req, res) => {
    const project = await access(req); sendJson(res, 200, { definition: await definition(project, req.params.aid) });
  });
  router.put(`${prefix}/:aid`, async (req, res) => {
    const project = await access(req, true); const current = await definition(project, req.params.aid);
    const body = req.body as Record<string, unknown>;
    if (body.revision !== current.revision) throw conflict();
    const graph = parseGraph(body.graph); await checkRepos(project, graph.repoIds);
    const newName = name(body.name);
    if (newName.toLowerCase() !== current.name.trim().toLowerCase()) await ensureFreshName(project, newName, current.id);
    const updated: Definition = { ...current, name: newName, graph, revision: current.revision + 1, updated_at: now() };
    if (!await (await getAutomationsRepository()).put(project, definitionKey(current.id), updated, current.revision)) throw conflict();
    sendJson(res, 200, { definition: updated });
  });
  // Remove a workflow from the list. Its published versions and runs are kept (history); it just stops being offered.
  // A workflow with a run that is going or waiting for approval cannot be removed.
  router.delete(`${prefix}/:aid`, async (req, res) => {
    const project = await access(req, true); const current = await definition(project, req.params.aid);
    const repo = await getAutomationsRepository();
    const busy = (await repo.list<AutomationRun>(project, 'RUN#')).some((r) => r.definition_id === current.id && ['running', 'waiting'].includes(r.status));
    if (busy) throw new HttpError(409, 'This workflow has a run in progress. Cancel it first.');
    const removed: Definition = { ...current, deleted_at: now(), revision: current.revision + 1, updated_at: now() };
    if (!await repo.put(project, definitionKey(current.id), removed, current.revision)) throw conflict();
    sendJson(res, 200, { ok: true });
  });
  router.post(`${prefix}/:aid/publish`, async (req, res) => {
    const project = await access(req, true); const current = await definition(project, req.params.aid);
    if ((req.body as Record<string, unknown>).revision !== current.revision) throw conflict();
    const graph = parseGraph(current.graph, true); await checkRepos(project, graph.repoIds);
    const repo = await getAutomationsRepository();
    const version: PublishedVersion = { revision: 1, definition_id: current.id, version: current.revision, graph, name: current.name, created_at: now() };
    // A concurrent publisher of the same revision has identical content. Versions are never overwritten.
    await repo.put(project, versionKey(current.id, version.version), version, null);
    const updated: Definition = { ...current, published_version: version.version, revision: current.revision + 1, updated_at: now() };
    if (!await repo.put(project, definitionKey(current.id), updated, current.revision)) throw conflict();
    sendJson(res, 200, { definition: updated });
  });
  router.get(`${prefix}/:aid/versions`, async (req, res) => {
    const project = await access(req); await definition(project, req.params.aid);
    const versions = await (await getAutomationsRepository()).list<PublishedVersion>(project, `VERSION#${req.params.aid}#`);
    sendJson(res, 200, { versions });
  });
  router.get(`${prefix}/:aid/runs`, async (req, res) => {
    const project = await access(req); await definition(project, req.params.aid);
    const runs = (await (await getAutomationsRepository()).list<AutomationRun>(project, 'RUN#')).filter((r) => r.definition_id === req.params.aid).sort((a, b) => b.started_at.localeCompare(a.started_at));
    sendJson(res, 200, { runs: runs.slice(0, 50) });
  });
  router.post(`${prefix}/:aid/runs`, async (req, res) => {
    const project = await access(req, true); const d = await definition(project, req.params.aid);
    if (d.published_version === null) throw badRequest('Publish a workflow version before running it');
    if (process.env.AWS_LAMBDA_FUNCTION_NAME && !process.env.PORTAL_AUTOMATION_STATE_MACHINE_ARN) throw new HttpError(503, 'Durable workflow orchestration is not configured');
    // The execution owner must be a project editor, including portal admins running another person's project.
    const member = await getMemberRow(project, req.user!.id);
    if (!['owner', 'editor'].includes(String(member?.access))) throw forbidden('Join this project as an editor before running workflows');
    const repo = await getAutomationsRepository();
    const version = await repo.get<PublishedVersion>(project, versionKey(d.id, d.published_version));
    if (!version) throw notFound('Published workflow not found');
    await checkRepos(project, version.graph.repoIds);
    const body = req.body as Record<string, unknown>;
    // Client-generated idempotency ID: retrying a request never starts another paid run.
    const id = str(body.requestId, 'Request ID', { max: 36 });
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('Request ID must be a UUID');
    const old = await repo.get<AutomationRun>(project, runKey(id));
    if (old) {
      if (old.definition_id !== d.id || old.created_by !== req.user!.id) throw conflict();
      sendJson(res, 200, { run: old }); return;
    }
    const timestamp = now();
    const run: AutomationRun = {
      id, definition_id: d.id, version: version.version, project_id: project, created_by: req.user!.id,
      revision: 1, status: 'running', cursor: version.graph.nodes.find((n) => n.kind === 'start')!.id,
      input: str(body.input, 'Input', { max: 2000, optional: true }), session_id: generateId(), attempts: [], visits: {}, lastPassed: true,
      started_at: timestamp, updated_at: timestamp, error: null, leaseUntil: 0, cancelRequested: false,
    };
    if (!await repo.put(project, runKey(id), run, null)) throw conflict();
    try { await scheduleAutomation(project, id); }
    catch (e) {
      await repo.put(project, runKey(id), { ...run, revision: 2, status: 'failed', error: 'Could not start durable workflow execution. Retry with a new run.' }, 1);
      throw e;
    }
    sendJson(res, 202, { run });
  });
  router.get(`${prefix}/:aid/runs/:rid`, async (req, res) => {
    const project = await access(req); const run = await (await getAutomationsRepository()).get<AutomationRun>(project, runKey(req.params.rid));
    if (!run || run.definition_id !== req.params.aid) throw notFound('Run not found');
    sendJson(res, 200, { run });
  });
  router.post(`${prefix}/:aid/runs/:rid/:action`, async (req, res) => {
    const project = await access(req, true); const repo = await getAutomationsRepository();
    const run = await repo.get<AutomationRun>(project, runKey(req.params.rid));
    if (!run || run.definition_id !== req.params.aid) throw notFound('Run not found');
    if (!req.user!.is_admin && run.created_by !== req.user!.id) throw forbidden('Only the run owner or a portal admin can control this run');
    const body = req.body as Record<string, unknown>;
    if (body.revision !== run.revision) throw conflict();
    if (['done', 'failed', 'cancelled'].includes(run.status)) throw badRequest('This run has finished');
    const updated = structuredClone(run); updated.revision++; updated.updated_at = now();
    if (req.params.action === 'cancel') updated.cancelRequested = true;
    else if (req.params.action === 'approve') {
      const attempt = updated.attempts.at(-1);
      if (updated.status !== 'waiting' || attempt?.status !== 'waiting' || body.nodeId !== updated.cursor || body.visit !== attempt.visit) throw badRequest('This approval no longer matches the waiting step');
      const version = await repo.get<PublishedVersion>(project, versionKey(run.definition_id, run.version));
      if (!version) throw notFound('Published workflow not found');
      attempt.status = 'approved'; attempt.approvedBy = req.user!.id; attempt.finishedAt = now();
      updated.cursor = version.graph.edges.find((e) => e.source === run.cursor && e.branch === 'next')!.target;
      updated.status = 'running';
    } else throw notFound();
    if (!await repo.put(project, runKey(run.id), updated, run.revision)) throw conflict();
    sendJson(res, 200, { run: updated });
  });
}
