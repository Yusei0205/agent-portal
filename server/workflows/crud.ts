/** Listing, creating, reading and updating sessions. */
import { all, insert, run as exec, type Row } from '../db.ts';
import { get, post, put } from '../http.ts';
import { getProject, requireProject } from '../projects.ts';
import { ensureFresh, getRepo } from '../repos.ts';
import { checkKey, issueDetail, mustMapping } from '../jira.ts';
import { badRequest, newId, now, parseJson, str } from '../util.ts';
import { claudeProvider, effectiveProvider, engineProvider } from '../project-aws.ts';
import { registerContextRoutes } from '../session-context.ts';
import { readRepoChoices } from '../runs.ts';
import { checkDocOutput, composeDocumentPrompt } from '../docrun.ts';
import { getWorkspace, workspaceIntegrations, workspaceRepos } from '../workspaces.ts';
import { readIntegrationIds } from '../integrations.ts';
import { assertBudget, getSettings } from '../settings.ts';
import { getToolPacks } from '../tool-packs.ts';
import { concurrencyReason, queueReasonLabel } from '../control-plane.ts';
import { audit } from '../audit.ts';
import { sessionOutput } from '../outputs.ts';
import { SINGLE_RUN_BUDGET_USD, driving, getWorkflow, patch, log } from './store.ts';
import { sessionRepos, view } from './views.ts';
import { kick } from './driver.ts';
import { readSettings, isKiro, checkLead, readContextItems, addContextItems, readEngine } from './validation.ts';

export function registerSessionRoutes(): void {
  // Which engines a project can run on, for the New dialog.
  get('/api/projects/:pid/engines', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return { default: effectiveProvider(project.id), claude: claudeProvider(project.id), kiro: true, pushMode: getSettings().agents.defaultPushMode || 'never' };
  });

  registerContextRoutes((workflowId, message) => log(workflowId, 'context', message));

  get('/api/projects/:pid/workflows', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return { workflows: all<Row>('SELECT * FROM workflows WHERE project_id = ? ORDER BY updated_at DESC LIMIT 100', project.id).map(view) };
  });

  post('/api/projects/:pid/workflows', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    // A single run is a session with one iteration. Its text arrives as "prompt" (or "goal"); "Document a repository" is
    // a single run whose prompt is built here and which reads the repository's reference clone in place.
    const singleRun = Boolean(body.singleRun);
    let docTitle = '';
    if (singleRun) {
      if (body.document) {
        const docRepo = getRepo(String(body.document.repoId ?? ''));
        if (docRepo.project_id !== project.id) throw badRequest('That repository belongs to another project');
        await ensureFresh(docRepo);
        const scope = str(body.document.scope, 'Focus', { max: 1000, optional: true });
        body.goal = composeDocumentPrompt(getRepo(docRepo.id), { scope, output: checkDocOutput(body.document.output ?? 'markdown') });
        docTitle = `Document ${docRepo.name}`;
        body.repoId = undefined;
        body.repos = undefined;
        body.workspaceId = undefined;
      } else if (body.goal === undefined) {
        body.goal = body.prompt;
      }
      body.playground = !body.workspaceId && !readRepoChoices(project.id, body).length;
      body.maxIterations = 1;
      if (body.pushMode === undefined) body.pushMode = 'never';
      if (body.budgetUsd === undefined) body.budgetUsd = SINGLE_RUN_BUDGET_USD;
      if (body.permissionMode === undefined || body.permissionMode === '') body.permissionMode = getSettings().agents.defaultPermissionMode;
    }
    let jira = { key: '', summary: '', url: '' };
    if (body.jiraKey) {
      const key = str(body.jiraKey, 'Jira key', { max: 30 }).trim().toUpperCase();
      const mapping = mustMapping(project.id);
      checkKey(mapping, key);
      const t = await issueDetail(project.id, mapping, key);
      jira = { key: t.key, summary: t.summary, url: t.url };
    }
    let goal = str(body.goal, singleRun ? 'Prompt' : 'Goal', { max: singleRun ? 50_000 : 6000, optional: Boolean(jira.key) }).trim();
    if (!goal && jira.key) goal = `Implement or fix what ticket ${jira.key} describes (${jira.summary}), following the project documents and decisions.`;
    if (!goal) throw badRequest(singleRun ? 'Describe what the agent should do' : 'Goal is required');
    const title = str(body.title, 'Title', { max: 120, optional: true }).trim() || docTitle || (jira.key ? `${jira.key}: ${jira.summary}`.slice(0, 120) : goal.split('\n')[0].slice(0, singleRun ? 100 : 80));
    // A workspace fills in the repositories (and integrations) unless the request lists its own.
    let workspace: Row | null = null;
    if (body.workspaceId) {
      workspace = getWorkspace(String(body.workspaceId));
      if (workspace.project_id !== project.id) throw badRequest('That workspace belongs to another project');
      if (!Array.isArray(body.repos) && !body.repoId) body.repos = workspaceRepos(workspace);
      if (!Array.isArray(body.integrations)) body.integrations = workspaceIntegrations(workspace);
    }
    const integrationIds = readIntegrationIds(body.integrations, ctx.user!.id);
    const engine = readEngine(project.id, body.engine);
    // Without a branch, a single repository keeps following its default branch, as before.
    const repos = readRepoChoices(project.id, body);
    const single = !Array.isArray(body.repos) && repos.length === 1;
    const repoId: string | null = repos[0]?.repoId ?? null;
    const playground = Boolean(body.playground);
    // A session must have a repository, a workspace, or be explicitly marked as a playground.
    if (!repoId && !workspace && !playground) {
      throw badRequest('Pick a repository or workspace, or start it as a playground with no repository.');
    }
    // Concurrency cap: queue instead of rejecting (when start=false, skip — it starts paused anyway).
    let queued = false;
    let queueReason = '';
    if (body.start !== false) {
      const reason = concurrencyReason(ctx.user!.id, project.id);
      if (reason && reason !== 'drain') {
        queued = true;
        queueReason = reason;
      } else if (reason === 'drain') {
        // During drain, still create as queued (held until drain lifts)
        queued = true;
        queueReason = reason;
      }
    }
    // A single run is refused up front when the monthly budget is used up (a session is created and pauses instead).
    if (singleRun && !queued && body.start !== false) assertBudget(engineProvider(project.id, engine || null), ctx.user!.id, project.id);
    const s = readSettings(body, undefined, { hasRepos: repos.length > 0, isPlayground: playground });
    const leadAgent = checkLead(project, body.leadAgent, engine);
    const contextItems = readContextItems(body.context);
    // Check pack availability BEFORE writing anything: a missing required pack returns 400 cleanly.
    if (!queued && body.start !== false && isKiro(project.id, engine)) {
      const packs = await getToolPacks();
      const kiroPack = packs.find((p) => p.id === 'kiro');
      if (kiroPack && kiroPack.status !== 'available') {
        throw badRequest(kiroPack.hint);
      }
    }
    const id = newId('w_');
    insert('workflows', {
      id,
      project_id: project.id,
      title,
      goal,
      status: queued ? 'queued' : (body.start === false ? 'paused' : 'running'),
      stop_reason: queued ? queueReasonLabel(queueReason) : (body.start === false ? 'Not started yet. Press Resume to start.' : ''),
      queue_reason: queueReason,
      queued_at: queued ? now() : null,
      repo_id: repoId,
      branch: single ? str(body.branch, 'Branch', { max: 200, optional: true }).trim() || null : (repos[0]?.branch ?? null),
      repos: JSON.stringify(repos.length > 1 ? repos : []),
      workspace_id: workspace?.id ?? null,
      engine,
      integrations: JSON.stringify(integrationIds),
      playground: playground ? 1 : 0,
      ...s,
      iteration: 0,
      burst_start: 0,
      spent_usd: 0,
      spent_credits: 0,
      work_branch: '',
      lead_agent: leadAgent,
      jira_key: jira.key,
      jira_summary: jira.summary,
      jira_url: jira.url,
      summary: '',
      loop_spec_id: body.loopSpecId ? String(body.loopSpecId) : null,
      planning_gate: body.planningGate ? 1 : (body.planning_gate ? 1 : 0),
      created_by: ctx.user!.id,
      created_at: now(),
      updated_at: now(),
    });
    log(id, 'system', `Session created by ${ctx.user!.name}`);
    try {
      addContextItems(id, { id: ctx.user!.id, name: ctx.user!.name }, contextItems);
    } catch (e) {
      // A bad context item must not leave a half-made session behind.
      exec('DELETE FROM workflows WHERE id = ?', id);
      throw e;
    }
    audit(ctx, 'session.start', `workflow:${id}`, { projectId: project.id, title, start: body.start !== false, ...(singleRun ? { singleRun: true } : {}) });
    if (!queued && body.start !== false) {
      kick(id);
    }
    return { workflow: view(getWorkflow(id)) };
  });

  get('/api/workflows/:id', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id);
    const events = all<Row>('SELECT * FROM workflow_events WHERE workflow_id = ? ORDER BY id DESC LIMIT 300', w.id)
      .reverse()
      .map((e) => ({ id: e.id, kind: e.kind, run_id: e.run_id, body: e.body, data: parseJson(e.data, {}), consumed: Boolean(e.consumed), created_at: e.created_at }));
    const runs = all<Row>('SELECT id, title, status, cost_usd, created_at, finished_at FROM agent_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 100', w.id);
    return { workflow: view(w), events, runs, driving: driving.has(w.id), output: sessionOutput(w.id) };
  });

  put('/api/workflows/:id', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const body = await ctx.json();
    const s = readSettings(body, w, { hasRepos: sessionRepos(w).length > 0, isPlayground: Boolean(w.playground) });
    const p: Record<string, string | number | null> = { ...s };
    if (body.engine !== undefined) p.engine = readEngine(w.project_id, body.engine);
    if (body.leadAgent !== undefined) p.lead_agent = checkLead(getProject(w.project_id), body.leadAgent, p.engine === undefined ? w.engine : String(p.engine));
    if (body.integrations !== undefined) p.integrations = JSON.stringify(readIntegrationIds(body.integrations, ctx.user!.id));
    if (body.title !== undefined) p.title = str(body.title, 'Title', { max: 120 }).trim();
    if (body.goal !== undefined) p.goal = str(body.goal, 'Goal', { max: 6000 }).trim();
    // Repositories can be attached (or changed) later; the next iteration starts on fresh working copies of them.
    if (body.repos !== undefined || body.repoId !== undefined) {
      if (w.status === 'running' || driving.has(w.id)) throw badRequest('Stop or pause the session before changing its repositories');
      const repos = readRepoChoices(w.project_id, body);
      const single = !Array.isArray(body.repos) && repos.length === 1;
      p.repo_id = repos[0]?.repoId ?? null;
      p.branch = single ? str(body.branch, 'Branch', { max: 200, optional: true }).trim() || null : (repos[0]?.branch ?? null);
      p.repos = JSON.stringify(repos.length > 1 ? repos : []);
      if (JSON.stringify(sessionRepos({ ...w, ...p } as Row)) !== JSON.stringify(sessionRepos(w))) p.work_branch = '';
    }
    const out = patch(w.id, p);
    log(w.id, 'system', `Settings changed by ${ctx.user!.name}`);
    return { workflow: view(out) };
  });
}
