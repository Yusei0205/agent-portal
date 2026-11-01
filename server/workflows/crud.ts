/**
 * Session (workflow) CRUD routes.
 *
 * Routes registered here:
 *   GET    /api/projects/:id/workflows                      — list workflows
 *   POST   /api/projects/:id/workflows                      — create workflow
 *   GET    /api/projects/:id/workflows/:wid                 — get workflow + latest run
 *   DELETE /api/projects/:id/workflows/:wid                 — delete workflow
 *   POST   /api/projects/:id/workflows/:wid/start           — start a new run
 *   GET    /api/projects/:id/workflows/:wid/runs            — list runs
 *   GET    /api/projects/:id/workflows/:wid/runs/:rid       — run details with events
 *   GET    /api/projects/:id/workflows/:wid/runs/:rid/events — SSE stream
 *   POST   /api/projects/:id/workflows/:wid/runs/:rid/input  — submit approval response
 *   POST   /api/projects/:id/workflows/:wid/cancel          — cancel running workflow
 *   POST   /api/projects/:id/workflows/:wid/message         — send follow-up message
 */

import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { one, all, insert, run as dbRun, getDb } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now, str, int, badRequest } from '../util.ts';
import { subscribe, addLiveSubscriber } from '../events.ts';
import { emit } from '../events.ts';
import { shutdownSessionBrowser } from '../agent/browser-manager.ts';
import { cancelRun } from './controls.ts';
import { startRun } from './driver.ts';
import { resolveApproval } from '../agent/approvals.ts';
import { inputFingerprint } from '../agent/runner.ts';
import { appendAudit } from '../audit.ts';
import { createChildSession, checkDelegationLimits, getDelegationSettings, stopAndDeleteChildren } from '../delegation.ts';
import { getDelegationSettingsRepository } from '../repositories/delegation-settings.ts';
import { checkKey, issueDetail, mustMapping } from '../jira.ts';

// ── Constant ───────────────────────────────────────────────────────────────────

const GOAL_MAX_CHARS = 8_000;
const MODEL_RE = /^[A-Za-z0-9._:\/@-]{0,200}$/;

// ── Scope helper ───────────────────────────────────────────────────────────────

function hasTokenScope(req: PortalRequest, scope: string): boolean {
  if (!req.authViaToken) return true; // browser session — all scopes allowed
  return (req.tokenScopes ?? []).includes(scope);
}

// ── View helpers ───────────────────────────────────────────────────────────────

function workflowView(w: Row) {
  return {
    id: w.id,
    project_id: w.project_id,
    title: (w.title as string | undefined) ?? '',
    goal: w.goal,
    status: w.status,
    stop_reason: (w.stop_reason as string | undefined) ?? '',
    engine: w.engine,
    trust_tools: Boolean(w.trust_tools),
    lead_agent: w.lead_agent ?? null,
    workspace_id: w.workspace_id ?? null,
    output_files_enabled: Boolean(w.output_files_enabled),
    repo_ids: safeJson(w.repo_ids as string, []),
    iteration_count: w.iteration_count ?? 0,
    max_iterations: w.max_iterations ?? 10,
    last_turn_at: w.last_turn_at ?? null,
    credential_id: w.credential_id ?? null,
    model: (w.model as string | undefined) ?? '',
    engineSessionId: (w.engine_session_id as string | undefined) ?? null,
    created_by: w.created_by ?? null,
    created_at: w.created_at,
    updated_at: w.updated_at,
    parent_id: w.parent_id ?? null,
    parent_title: (w.parent_title as string | undefined) ?? null,
    child_count: (w.child_count as number | undefined) ?? 0,
    jira_key: (w.jira_key as string | undefined) ?? '',
    jira_summary: (w.jira_summary as string | undefined) ?? '',
    jira_url: (w.jira_url as string | undefined) ?? '',
    resumable: Boolean(w.resumable),
    lastRunStatus: (w.lastRunStatus as string | undefined) ?? null,
  };
}

/**
 * Enrich a single workflow row with parent_title, child_count, resumable, and lastRunStatus.
 * Two bounded queries — safe for detail endpoints (not N+1).
 */
function enrichWorkflowRow(w: Row): Row {
  let parentTitle: string | null = null;
  if (w.parent_id) {
    const parent = one<Row>(
      'SELECT title, goal FROM p6_workflows WHERE id = ?',
      String(w.parent_id),
    );
    if (parent) {
      const t = (parent.title as string | undefined) ?? '';
      parentTitle = t || String(parent.goal ?? '').slice(0, 60);
    }
  }
  const childCount =
    (one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM p6_workflows WHERE parent_id = ?',
      String(w.id),
    )?.n) ?? 0;

  // Compute resumable: allowed when workflow status is failed/paused/stopped/cancelled
  // OR when the latest run is failed/cancelled (workflow in any terminal state with failed/cancelled last run).
  const wfStatus = String(w.status ?? '');
  const latestRun = one<{ status: string }>(
    'SELECT status FROM p6_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1',
    String(w.id),
  );
  const lastRunStatus = latestRun?.status ?? null;
  const resumableStatuses = new Set(['failed', 'paused', 'stopped', 'cancelled']);
  const resumableRunStatuses = new Set(['failed', 'cancelled']);
  const resumable =
    resumableStatuses.has(wfStatus) ||
    (lastRunStatus !== null && resumableRunStatuses.has(lastRunStatus));

  return { ...w, parent_title: parentTitle, child_count: childCount, resumable, lastRunStatus };
}

function runView(r: Row) {
  return {
    id: r.id,
    workflow_id: r.workflow_id,
    status: r.status,
    started_at: r.started_at ?? null,
    finished_at: r.finished_at ?? null,
    cost_usd: r.cost_usd ?? 0,
    input_tokens: r.input_tokens ?? 0,
    output_tokens: r.output_tokens ?? 0,
    created_at: r.created_at,
  };
}

function eventView(e: Row) {
  return {
    id: e.id,
    run_id: e.run_id,
    type: e.type,
    payload: safeJson(e.payload as string, {}),
    created_at: e.created_at,
  };
}

function safeJson(s: string | null | undefined, fallback: unknown): unknown {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// ── Access helpers ─────────────────────────────────────────────────────────────

/**
 * Verify the user has at least 'viewer' access to the project.
 * Returns the project row, or null (response already sent).
 */
function requireProjectMember(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): Row | null {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return null; }
  const p = one<Row>('SELECT * FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!p) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  if (req.user.is_admin) return p;
  const m = one<Row>(
    'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!m) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  return p;
}

/**
 * Verify the workflow belongs to the project.
 * Returns the workflow row, or null (response already sent).
 */
function requireWorkflow(
  res: PortalResponse,
  projectId: string,
  workflowId: string,
): Row | null {
  const w = one<Row>('SELECT * FROM p6_workflows WHERE id = ? AND project_id = ?', workflowId, projectId);
  if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return null; }
  return w;
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerWorkflowRoutes(): void {

  // GET /api/projects/:id/workflows
  router.get('/api/projects/:id/workflows', (req: PortalRequest, res: PortalResponse): void => {
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;

    const limit = Math.min(int(req.query.get('limit'), 'limit', 50, 1, 200), 200);
    const offset = int(req.query.get('offset'), 'offset', 0, 0);
    const statusFilter = req.query.get('status') ?? '';
    const engineFilter = req.query.get('engine') ?? '';
    const search = req.query.get('search') ?? '';
    const projectId = String(project.id);

    // Build query dynamically with typed parameters
    const conditions: string[] = ['w.project_id = ?'];
    const params: (string | number)[] = [projectId];

    if (statusFilter) { conditions.push('w.status = ?'); params.push(statusFilter); }
    if (engineFilter) { conditions.push('w.engine = ?'); params.push(engineFilter); }
    if (search) { conditions.push('w.goal LIKE ?'); params.push(`%${search}%`); }

    const where = conditions.join(' AND ');

    const total = (one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM p6_workflows w WHERE ${where}`,
      ...params,
    )?.n) ?? 0;

    const workflows = all<Row>(
      `SELECT w.*,
        CASE WHEN w.parent_id IS NOT NULL THEN
          SUBSTR(COALESCE(NULLIF(p.title, ''), p.goal), 1, 60)
        ELSE NULL END AS parent_title,
        (SELECT COUNT(*) FROM p6_workflows c WHERE c.parent_id = w.id) AS child_count
      FROM p6_workflows w
      LEFT JOIN p6_workflows p ON p.id = w.parent_id
      WHERE ${where}
      ORDER BY w.updated_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );

    sendJson(res, 200, { workflows: workflows.map(workflowView), total });
  });

  // POST /api/projects/:id/workflows
  router.post('/api/projects/:id/workflows', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const goal = str(body.goal as string, 'goal', { max: GOAL_MAX_CHARS }).trim();

    // Validate engine from request (null = not specified, will use workspace/project/built-in default)
    const requestEngine: Engine | null = body.engine ? validateEngine(body.engine) : null;

    const trustTools = Boolean(body.trustTools ?? false);

    // Safety: turning on "trust all tools" can only be done from a signed-in browser session
    // (API tokens should not be able to bypass guardrails on behalf of a user).
    if (trustTools && req.authViaToken) {
      sendJson(res, 403, { error: 'API tokens cannot turn on "trust all tools". Do this from a signed-in browser.' });
      return;
    }

    // Validate leadAgent from request (null = not specified)
    const requestLeadAgent: string | null = body.leadAgent
      ? (str(body.leadAgent as string, 'leadAgent', { max: 200, optional: true }).trim() || null)
      : null;

    // Validate model ID from request (null = not specified, will use workspace/project default)
    let requestModel: string | null = null;
    if (body.model && typeof body.model === 'string' && body.model.trim()) {
      const modelStr = body.model.trim();
      if (!MODEL_RE.test(modelStr)) {
        sendJson(res, 400, { error: 'model is not a valid model ID (allowed: A-Z a-z 0-9 . _ : / @ -)' });
        return;
      }
      requestModel = modelStr;
    }

    const workspaceId = body.workspaceId ? str(body.workspaceId as string, 'workspaceId', { max: 200, optional: true }) : null;
    const outputFiles = Boolean(body.outputFiles ?? false);
    const maxIterations = int(body.maxIterations, 'maxIterations', 10, 1, 100);
    const credentialId = body.credentialId ? str(body.credentialId as string, 'credentialId', { max: 200, optional: true }) : null;
    const projectId = String(project.id);

    // Jira ticket context: validate the key, fetch title/url, attach to workflow
    let jiraKey = '';
    let jiraSummary = '';
    let jiraUrl = '';
    if (body.jiraKey) {
      const keyRaw = str(body.jiraKey as string, 'jiraKey', { max: 30 }).trim().toUpperCase();
      const mapping = mustMapping(projectId);
      checkKey(mapping, keyRaw);
      try {
        const t = await issueDetail(projectId, mapping, keyRaw);
        jiraKey = t.key;
        jiraSummary = t.summary;
        jiraUrl = t.url;
      } catch (e: unknown) {
        const msg = (e as { message?: string })?.message ?? String(e);
        const status = (e as { status?: number })?.status ?? 400;
        sendJson(res, status, { error: msg });
        return;
      }
    }

    const explicitRepoIds = Array.isArray(body.repoIds) ? body.repoIds.map(String) : [];
    let repoIds: string[];

    // Workspace defaults (engine, agent, model) populated when the workspace is loaded
    let wsDefaultEngine: Engine | null = null;
    let wsDefaultAgent: string | null = null;
    let wsDefaultModel: string | null = null;

    if (workspaceId) {
      const ws = one<{ repo_ids: string | null; default_engine: string; default_agent: string; default_model: string }>(
        'SELECT repo_ids, default_engine, default_agent, default_model FROM workspaces_v2 WHERE id = ? AND project_id = ?',
        workspaceId,
        projectId,
      );
      if (!ws) {
        sendJson(res, 400, { error: 'Workspace not found' });
        return;
      }
      // Capture workspace defaults (empty string = no default)
      wsDefaultEngine = ws.default_engine ? validateEngine(ws.default_engine) : null;
      wsDefaultAgent = ws.default_agent?.trim() || null;
      wsDefaultModel = ws.default_model?.trim() || null;

      const wsRepoIds = safeJson(ws.repo_ids, []) as string[];
      const combined = [...new Set([...wsRepoIds, ...explicitRepoIds])];
      if (combined.length > 0) {
        const placeholders = combined.map(() => '?').join(', ');
        const validRows = all<{ id: string }>(
          `SELECT id FROM repositories WHERE project_id = ? AND id IN (${placeholders})`,
          projectId,
          ...combined,
        );
        repoIds = validRows.map((r) => r.id);
      } else {
        repoIds = [];
      }
    } else {
      repoIds = explicitRepoIds;
    }

    // ── Apply fallback chain: request → workspace → project → built-in default ──

    // Engine: request → workspace default → 'demo' (no project-level engine default)
    const engine: Engine = requestEngine
      ?? wsDefaultEngine
      ?? 'demo';

    // Workspace agent/model only apply when the workspace has no default_engine,
    // or its default_engine matches the session's final engine.
    const wsEngineMatches = wsDefaultEngine === null || wsDefaultEngine === engine;

    // Lead agent: request → workspace default (if engine matches) → project default → null
    const projectDefaultAgent = typeof project.default_lead_agent === 'string' && project.default_lead_agent
      ? project.default_lead_agent
      : null;
    const leadAgent: string | null = requestLeadAgent ?? (wsEngineMatches ? wsDefaultAgent : null) ?? projectDefaultAgent;

    // Model: request → workspace default (if engine matches) → project default → ''
    const projectDefaultModel = typeof project.default_model === 'string' && project.default_model
      ? project.default_model
      : null;
    const model: string = requestModel ?? (wsEngineMatches ? wsDefaultModel : null) ?? projectDefaultModel ?? '';

    const id = generateId();
    const ts = now();

    insert('p6_workflows', {
      id,
      project_id: projectId,
      goal,
      status: 'pending',
      engine,
      trust_tools: trustTools ? 1 : 0,
      lead_agent: leadAgent,
      workspace_id: workspaceId,
      output_files_enabled: outputFiles ? 1 : 0,
      repo_ids: JSON.stringify(repoIds),
      iteration_count: 0,
      max_iterations: maxIterations,
      credential_id: credentialId,
      model,
      jira_key: jiraKey,
      jira_summary: jiraSummary,
      jira_url: jiraUrl,
      created_by: req.user!.id,
      created_at: ts,
      updated_at: ts,
    });

    emit(projectId, { type: 'workflow.created', workflowId: id });

    const workflow = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', id)!;
    sendJson(res, 201, { workflow: workflowView(enrichWorkflowRow(workflow)) });
  });

  // GET /api/projects/:id/workflows/:wid
  router.get('/api/projects/:id/workflows/:wid', (req: PortalRequest, res: PortalResponse): void => {
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    const latestRun = one<Row>(
      'SELECT * FROM p6_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1',
      String(w.id),
    );

    sendJson(res, 200, {
      workflow: workflowView(enrichWorkflowRow(w)),
      latestRun: latestRun ? runView(latestRun) : null,
    });
  });

  // DELETE /api/projects/:id/workflows/:wid
  router.delete('/api/projects/:id/workflows/:wid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    // Cancel any active run first
    const activeRun = one<Row>(
      "SELECT id FROM p6_runs WHERE workflow_id = ? AND status IN ('pending','running')",
      String(w.id),
    );
    if (activeRun) cancelRun(String(activeRun.id));

    // Stop and delete child sessions recursively (F7)
    stopAndDeleteChildren(String(w.id));

    // Close the session's live browser, if one is running
    shutdownSessionBrowser(String(w.id)).catch(() => {/* non-fatal */});

    dbRun('DELETE FROM p6_workflows WHERE id = ?', String(w.id));
    emit(String(project.id), { type: 'workflow.deleted', workflowId: String(w.id) });
    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/workflows/:wid/delegate  — delegate a task to a child session (F7)
  //
  // Body: { task: string, title?: string, leadAgent?: string }
  // Response: 201 { workflow } (child session, already started)
  // Errors:
  //   400 — validation failure
  //   429 — delegation disabled or per-parent/per-user cap exceeded
  router.post(
    '/api/projects/:id/workflows/:wid/delegate',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
      const project = requireProjectMember(req, res, req.params.id);
      if (!project) return;
      const w = requireWorkflow(res, req.params.id, req.params.wid);
      if (!w) return;
      if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const task = str(body.task as string, 'task', { max: GOAL_MAX_CHARS }).trim();
      const title = body.title ? str(body.title as string, 'title', { max: 200, optional: true }).trim() : undefined;
      const leadAgent = body.leadAgent ? str(body.leadAgent as string, 'leadAgent', { max: 200, optional: true }).trim() : undefined;

      const settings = await getDelegationSettingsRepository().get();
      if (!settings.enabled) {
        sendJson(res, 429, { error: 'Delegation is disabled by the portal administrator.' });
        return;
      }

      try {
        const child = await createChildSession(String(w.id), req.user.id, task, { title, leadAgent });
        sendJson(res, 201, { workflow: workflowView(enrichWorkflowRow(child)) });
      } catch (e: unknown) {
        const status = (e as { status?: number })?.status ?? 400;
        const msg = (e as { message?: string })?.message ?? String(e);
        sendJson(res, status, { error: msg });
      }
    },
  );

  // POST /api/projects/:id/workflows/:wid/start
  router.post('/api/projects/:id/workflows/:wid/start', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    // Idempotent: if a run is already active for this workflow (e.g. the /message
    // route started one just before the composer UI called /start), return it with
    // HTTP 200 instead of creating a duplicate.  Callers should treat 200 as
    // "already running, nothing to do" and 201 as "new run created".
    // IMPORTANT: check for an active run BEFORE checking workflow status so that
    // the second call always gets 200 (idempotent), not 409.
    const existingRun = one<Row>(
      "SELECT * FROM p6_runs WHERE workflow_id = ? AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1",
      String(w.id),
    );
    if (existingRun) {
      sendJson(res, 200, { runId: String(existingRun.id), run: runView(existingRun), alreadyRunning: true });
      return;
    }

    // No active run record exists. If the workflow row says 'running' the DB is
    // in an inconsistent state — refuse rather than create a duplicate run.
    if (w.status === 'running') {
      sendJson(res, 409, { error: 'This session is already running' });
      return;
    }

    try {
      const runId = await startRun(String(w.id));
      // Track last user interaction
      dbRun(
        'UPDATE p6_workflows SET last_turn_at = ?, stop_reason = \'\', updated_at = ? WHERE id = ?',
        now(),
        now(),
        String(w.id),
      );
      const run = one<Row>('SELECT * FROM p6_runs WHERE id = ?', runId)!;
      sendJson(res, 201, { runId, run: runView(run) });
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? String(e);
      sendJson(res, 429, { error: msg });
    }
  });

  // GET /api/projects/:id/workflows/:wid/runs
  router.get('/api/projects/:id/workflows/:wid/runs', (req: PortalRequest, res: PortalResponse): void => {
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    const runs = all<Row>(
      'SELECT * FROM p6_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 100',
      String(w.id),
    );
    sendJson(res, 200, { runs: runs.map(runView) });
  });

  // GET /api/projects/:id/workflows/:wid/runs/:rid
  router.get('/api/projects/:id/workflows/:wid/runs/:rid', (req: PortalRequest, res: PortalResponse): void => {
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    const r = one<Row>(
      'SELECT * FROM p6_runs WHERE id = ? AND workflow_id = ?',
      req.params.rid,
      String(w.id),
    );
    if (!r) { sendJson(res, 404, { error: 'Run not found' }); return; }

    const events = all<Row>(
      'SELECT * FROM p6_events WHERE run_id = ? ORDER BY id ASC LIMIT 500',
      String(r.id),
    );

    sendJson(res, 200, { run: runView(r), events: events.map(eventView) });
  });

  // GET /api/projects/:id/workflows/:wid/runs/:rid/events  (SSE)
  router.sse('/api/projects/:id/workflows/:wid/runs/:rid/events', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const p = one<Row>('SELECT * FROM projects WHERE id = ? AND archived = 0', req.params.id);
    if (!p) { sendJson(res, 404, { error: 'Project not found' }); return; }

    const w = one<Row>('SELECT * FROM p6_workflows WHERE id = ? AND project_id = ?', req.params.wid, String(p.id));
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

    const r = one<Row>('SELECT * FROM p6_runs WHERE id = ? AND workflow_id = ?', req.params.rid, String(w.id));
    if (!r) { sendJson(res, 404, { error: 'Run not found' }); return; }

    // Replay historical events
    const past = all<Row>('SELECT * FROM p6_events WHERE run_id = ? ORDER BY id ASC', String(r.id));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    for (const e of past) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'event', event: eventView(e) })}\n\n`);
      }
    }

    // Subscribe to live project events — addLiveSubscriber does NOT write headers
    // (they are already sent above), but keeps the connection alive and cleans up.
    addLiveSubscriber(String(p.id), res);
  });

  // POST /api/projects/:id/workflows/:wid/runs/:rid/input
  router.post('/api/projects/:id/workflows/:wid/runs/:rid/input', (req: PortalRequest, res: PortalResponse): void => {
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    const r = one<Row>('SELECT * FROM p6_runs WHERE id = ? AND workflow_id = ?', req.params.rid, String(w.id));
    if (!r) { sendJson(res, 404, { error: 'Run not found' }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const inputId = str(body.inputId as string, 'inputId');
    const response = body.response;
    const allowAll = Boolean(body.allowAll ?? false);
    const clientHash = typeof body.inputHash === 'string' ? body.inputHash : null;

    if (response !== 'approve' && response !== 'deny' && typeof response !== 'string') {
      sendJson(res, 400, { error: 'response must be "approve", "deny", or a string' });
      return;
    }

    // Load the input record for fingerprint and status checks.
    const inputRow = one<Row>('SELECT * FROM p6_inputs WHERE id = ? AND run_id = ?', inputId, String(r.id));
    if (!inputRow) { sendJson(res, 404, { error: 'Input not found' }); return; }

    // An expired input cannot be answered.
    if (inputRow.status === 'expired') {
      sendJson(res, 409, { error: 'Nobody answered this in time, so the agent was told to carry on without it.' });
      return;
    }

    // Fingerprint check: an approval must send back the exact hash the server stored.
    // This ensures the call that runs is always the one the person reviewed.
    if (response === 'approve') {
      let storedHash = (inputRow.input_hash as string | null) ?? null;
      // If not stored separately, re-derive from payload.
      if (!storedHash) {
        try {
          const p = JSON.parse(inputRow.payload as string ?? '{}');
          storedHash = p.inputHash ?? null;
          if (!storedHash && inputRow.tool_input) {
            const ti = JSON.parse(inputRow.tool_input as string);
            storedHash = inputFingerprint(inputRow.tool_name as string, ti);
          }
        } catch { /* skip */ }
      }
      if (storedHash && clientHash !== storedHash) {
        sendJson(res, 409, { error: 'This is not the tool call you reviewed. Reload the page and review it again.' });
        return;
      }
    }

    // Claim atomically — prevents two simultaneous answers both winning,
    // and prevents an expiry timer overtaking an in-flight answer.
    const claimed = dbRun(
      "UPDATE p6_inputs SET status = 'answered', response = ?, allow_all = ?, answered_by = ?, answered_at = ? WHERE id = ? AND status = 'pending'",
      JSON.stringify(response),
      allowAll ? 1 : 0,
      req.user?.id ?? null,
      now(),
      inputId,
    );
    if (!claimed.changes) {
      sendJson(res, 409, { error: 'Someone answered this a moment ago.' });
      return;
    }

    const decision: 'allow' | 'deny' = response === 'approve' ? 'allow' : 'deny';
    const message = typeof body.message === 'string' ? body.message.slice(0, 2000) : '';
    resolveApproval(String(r.id), inputId, decision, { remember: allowAll, message });

    if (w.project_id) {
      emit(String(w.project_id), { type: 'input.resolved', inputId, status: 'answered' });
    }

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/workflows/:wid/cancel
  router.post('/api/projects/:id/workflows/:wid/cancel', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    // Find the active run
    const activeRun = one<Row>(
      "SELECT id FROM p6_runs WHERE workflow_id = ? AND status IN ('pending','running')",
      String(w.id),
    );
    if (activeRun) {
      cancelRun(String(activeRun.id));
    }

    dbRun(
      `UPDATE p6_workflows SET status = 'paused', updated_at = ? WHERE id = ?`,
      now(),
      String(w.id),
    );

    if (w.project_id) {
      emit(String(w.project_id), { type: 'workflow.updated', workflowId: String(w.id), status: 'paused' });
    }

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/workflows/:wid/resume — resume a failed/paused/stopped/cancelled workflow
  router.post('/api/projects/:id/workflows/:wid/resume', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    // Idempotent: if a run is already active, return 200 with alreadyRunning: true
    const existingRun = one<Row>(
      "SELECT * FROM p6_runs WHERE workflow_id = ? AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1",
      String(w.id),
    );
    if (existingRun) {
      sendJson(res, 200, { runId: String(existingRun.id), run: runView(existingRun), alreadyRunning: true });
      return;
    }

    // Check that the workflow is in a resumable state
    const wfStatus = String(w.status ?? '');
    const latestRun = one<{ status: string }>(
      'SELECT status FROM p6_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1',
      String(w.id),
    );
    const lastRunStatus = latestRun?.status ?? null;
    const resumableStatuses = new Set(['failed', 'paused', 'stopped', 'cancelled']);
    const resumableRunStatuses = new Set(['failed', 'cancelled']);
    const isResumable =
      resumableStatuses.has(wfStatus) ||
      (lastRunStatus !== null && resumableRunStatuses.has(lastRunStatus));

    if (!isResumable) {
      sendJson(res, 409, { error: 'Workflow is not in a resumable state' });
      return;
    }

    // Queue a visible human message so the transcript shows the resume context
    const resumeMessage = 'Continue where you left off. The previous run was interrupted.';
    insert('p6_workflow_events', {
      workflow_id: String(w.id),
      kind: 'human',
      body: resumeMessage,
      data: JSON.stringify({ by: req.user!.id, resume: true }),
      created_at: now(),
    });

    // Track last user interaction
    dbRun(
      'UPDATE p6_workflows SET last_turn_at = ?, stop_reason = \'\', updated_at = ? WHERE id = ?',
      now(), now(), String(w.id),
    );

    if (w.project_id) {
      emit(String(w.project_id), {
        type: 'workflow.message',
        workflowId: String(w.id),
        body: resumeMessage,
        by: req.user!.id,
      });
    }

    try {
      const runId = await startRun(String(w.id));
      const run = one<Row>('SELECT * FROM p6_runs WHERE id = ?', runId)!;
      sendJson(res, 201, { runId, run: runView(run) });
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? String(e);
      sendJson(res, 429, { error: msg });
    }
  });

  // POST /api/projects/:id/workflows/:wid/message
  router.post('/api/projects/:id/workflows/:wid/message', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = str(body.message as string, 'message', { max: 10_000 }).trim();

    // Slash commands are recorded with kind='command'; everything else is 'human'
    const isCommand = message.startsWith('/');
    const kind = isCommand ? 'command' : 'human';

    // Store the follow-up message as a p6 workflow event (avoids FK issue with legacy workflow_events)
    insert('p6_workflow_events', {
      workflow_id: String(w.id),
      kind,
      body: message,
      data: JSON.stringify({ by: req.user!.id }),
      created_at: now(),
    });

    // For demo-engine slash commands, immediately process and record result event
    if (isCommand && String(w.engine) === 'demo') {
      const cmdResult = processDemoSlashCommand(message);
      insert('p6_workflow_events', {
        workflow_id: String(w.id),
        kind: 'command-result',
        body: cmdResult,
        data: JSON.stringify({ command: message, by: req.user!.id }),
        created_at: now(),
      });
      if (w.project_id) {
        emit(String(w.project_id), {
          type: 'workflow.command-result',
          workflowId: String(w.id),
          command: message,
          result: cmdResult,
        });
      }
    }

    // For kiro/claude-code engines, /clear is handled server-side:
    // mark all pending unconsumed messages consumed so the next run starts fresh,
    // and clear the engine session ID so the next run begins a new conversation.
    if (isCommand && message.toLowerCase().trim() === '/clear' && String(w.engine) !== 'demo') {
      dbRun(
        'UPDATE p6_workflow_events SET consumed = 1 WHERE workflow_id = ? AND consumed = 0 AND kind IN (\'human\', \'command\')',
        String(w.id),
      );
      dbRun(
        'UPDATE p6_workflows SET engine_session_id = NULL, engine_session_engine = NULL, updated_at = ? WHERE id = ?',
        now(),
        String(w.id),
      );
    }

    // Track last user interaction (resets idle timer)
    const ts = now();
    dbRun(
      'UPDATE p6_workflows SET last_turn_at = ?, stop_reason = \'\', updated_at = ? WHERE id = ?',
      ts,
      ts,
      String(w.id),
    );

    // Emit live event so open clients see the message immediately
    if (w.project_id) {
      emit(String(w.project_id), {
        type: isCommand ? 'workflow.command' : 'workflow.message',
        workflowId: String(w.id),
        body: message,
        by: req.user!.id,
      });
    }

    // Resume idle-stopped (paused) sessions when a HUMAN message arrives.
    // Commands NEVER trigger a run start — they are forwarded to the engine
    // on the next turn as part of the pending messages prompt.
    let resumed = false;
    if (String(w.status) === 'paused' && !isCommand) {
      // Guard against concurrent double-start (message + /start racing)
      const hasActive = one<Row>(
        "SELECT 1 FROM p6_runs WHERE workflow_id = ? AND status IN ('pending','running')",
        String(w.id),
      );
      if (!hasActive) {
        try {
          await startRun(String(w.id));
          resumed = true;
        } catch {
          // Concurrency limit or other transient error — don't fail the message send
        }
      }
    }

    sendJson(res, 200, { ok: true, kind, resumed });
  });

  // PATCH /api/projects/:id/workflows/:wid — update session settings (title, goal, trust-tools, max-iterations)
  router.patch('/api/projects/:id/workflows/:wid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    const body = (req.body ?? {}) as Record<string, unknown>;

    // At least one settable field must be present
    const hasTitle       = body.title !== undefined;
    const hasGoal        = body.goal !== undefined;
    const hasTrustTools  = body.trustTools !== undefined;
    const hasMaxIter     = body.maxIterations !== undefined;

    if (!hasTitle && !hasGoal && !hasTrustTools && !hasMaxIter) {
      sendJson(res, 400, { error: 'Provide at least one of: title, goal, trustTools, maxIterations' });
      return;
    }

    const updates: Record<string, unknown> = {};
    let title: string | undefined;

    if (hasTitle) {
      title = str(body.title as string, 'title', { max: 200, optional: true }).trim();
      updates.title = title;
    }
    if (hasGoal) {
      updates.goal = str(body.goal as string, 'goal', { max: GOAL_MAX_CHARS }).trim();
    }
    if (hasTrustTools) {
      updates.trust_tools = body.trustTools ? 1 : 0;
    }
    if (hasMaxIter) {
      updates.max_iterations = int(body.maxIterations, 'maxIterations', 10, 1, 100);
    }

    const ts = now();
    updates.updated_at = ts;

    const keys = Object.keys(updates);
    dbRun(
      `UPDATE p6_workflows SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => updates[k] as string | number),
      String(w.id),
    );

    if (title !== undefined) {
      appendAudit(
        getDb(),
        req.user!.id,
        'session.rename',
        `workflow:${String(w.id)}`,
        { title },
        req.ip,
      );

      // Emit project event so all open clients update their session list
      if (w.project_id) {
        emit(String(w.project_id), {
          type: 'workflow.renamed',
          workflowId: String(w.id),
          title,
        });
      }
    }

    // Emit workflow.updated for any patch so the session list reloads
    if (w.project_id) {
      emit(String(w.project_id), { type: 'workflow.updated', workflowId: String(w.id) });
    }

    const updated = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', String(w.id))!;
    sendJson(res, 200, { workflow: workflowView(enrichWorkflowRow(updated)) });
  });

  // GET /api/projects/:id/workflows/:wid/transcript  — newest-first, cursor-based paging
  //
  //   Merges two sources into one chronological stream:
  //     p6_events        — agent run events (tool calls, assistant text, etc.)
  //     p6_workflow_events — human messages, commands, system/idle-stop markers
  //
  //   Query params:
  //     cursor  — opaque string (base64-encoded JSON) returned as nextCursor from
  //               a previous page; omit for the latest page
  //     limit   — page size, default 100, max 200
  //
  //   Response:
  //     {
  //       events:     TranscriptEvent[],   // newest-first
  //       nextCursor: string | null        // pass as ?cursor= to fetch the preceding page
  //     }
  //
  //   TranscriptEvent shape:
  //     {
  //       src:        'r' | 'w',      // 'r' = p6_events (run event), 'w' = p6_workflow_events
  //       id:         number,         // primary key in source table
  //       kind:       string,         // event type/kind ('assistant-text', 'human', 'command', …)
  //       payload:    object | string,// parsed JSON payload for run events; raw body for workflow events
  //       run_id:     string | null,  // set for src='r'
  //       created_at: string
  //     }
  //
  //   Cursor format (internal, opaque to clients):
  //     base64url( JSON({ ts: string, src: 'r'|'w', id: number }) )
  //     ts  — created_at of the last (oldest) event on the current page
  //     src — source table of that event ('r' before 'w' at the same timestamp, per ASC sort)
  //     id  — primary key of that event in its source table
  //   Sort order within a page: created_at DESC, src ASC ('r' before 'w'), id DESC
  router.get('/api/projects/:id/workflows/:wid/transcript', (req: PortalRequest, res: PortalResponse): void => {
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    const cursorStr = req.query.get('cursor');
    const limit = Math.min(int(req.query.get('limit'), 'limit', 100, 1, 200), 200);
    const wid = String(w.id);

    interface TxCursor { ts: string; src: 'r' | 'w'; id: number; }

    function encodeCursor(c: TxCursor): string {
      return Buffer.from(JSON.stringify(c)).toString('base64url');
    }

    function decodeCursor(s: string): TxCursor | null {
      try {
        return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as TxCursor;
      } catch { return null; }
    }

    const cursor = cursorStr ? decodeCursor(cursorStr) : null;

    // Build the merged query.  Sort: created_at DESC, src ASC ('r' < 'w'), id DESC.
    // The WHERE clause encodes "give me everything older than the cursor" in that
    // sort order: strictly older by ts, OR same ts but src is later (alphabetically
    // 'w' > 'r'), OR same ts+src but smaller id.
    let rows: Array<{
      src: string; id: number; created_at: string; kind: string;
      body: string; run_id: string | null;
    }>;

    if (cursor) {
      rows = getDb().prepare(`
        WITH merged AS (
          SELECT 'r' AS src, e.id, e.created_at, e.type AS kind, e.payload AS body, e.run_id
          FROM p6_events e
          JOIN p6_runs r ON r.id = e.run_id
          WHERE r.workflow_id = ?
          UNION ALL
          SELECT 'w' AS src, we.id, we.created_at, we.kind, we.body, NULL AS run_id
          FROM p6_workflow_events we
          WHERE we.workflow_id = ?
        )
        SELECT * FROM merged
        WHERE (
          created_at < ?
          OR (created_at = ? AND src > ?)
          OR (created_at = ? AND src = ? AND id < ?)
        )
        ORDER BY created_at DESC, src ASC, id DESC
        LIMIT ?
      `).all(wid, wid, cursor.ts, cursor.ts, cursor.src, cursor.ts, cursor.src, cursor.id, limit) as typeof rows;
    } else {
      rows = getDb().prepare(`
        WITH merged AS (
          SELECT 'r' AS src, e.id, e.created_at, e.type AS kind, e.payload AS body, e.run_id
          FROM p6_events e
          JOIN p6_runs r ON r.id = e.run_id
          WHERE r.workflow_id = ?
          UNION ALL
          SELECT 'w' AS src, we.id, we.created_at, we.kind, we.body, NULL AS run_id
          FROM p6_workflow_events we
          WHERE we.workflow_id = ?
        )
        SELECT * FROM merged
        ORDER BY created_at DESC, src ASC, id DESC
        LIMIT ?
      `).all(wid, wid, limit) as typeof rows;
    }

    const events = rows.map((e) => ({
      src: e.src,
      id: e.id,
      kind: e.kind,
      payload: e.src === 'r' ? safeJson(e.body, {}) : e.body,
      run_id: e.run_id ?? null,
      created_at: e.created_at,
    }));

    const nextCursor =
      rows.length === limit
        ? encodeCursor({
            ts: rows[rows.length - 1].created_at,
            src: rows[rows.length - 1].src as 'r' | 'w',
            id: Number(rows[rows.length - 1].id),
          })
        : null;

    sendJson(res, 200, { events, nextCursor });
  });
}

// ── Validation helpers ─────────────────────────────────────────────────────────

type Engine = 'claude-code' | 'kiro' | 'demo';
const VALID_ENGINES: Engine[] = ['claude-code', 'kiro', 'demo'];

function validateEngine(v: unknown): Engine {
  if (!v) return 'demo'; // default to demo in greenfield
  const s = String(v);
  if (VALID_ENGINES.includes(s as Engine)) return s as Engine;
  throw badRequest(`engine must be one of: ${VALID_ENGINES.join(', ')}`);
}

// ── Slash command handler for demo engine (gap 8) ─────────────────────────────

/**
 * Process a slash command for the demo engine and return a canned result string.
 * Unknown commands are gracefully handled (never crash).
 */
function processDemoSlashCommand(command: string): string {
  const cmd = command.trim().toLowerCase();
  if (cmd === '/clear') return 'Chat history cleared.';
  if (cmd === '/help') {
    return 'Available commands: /clear — clear chat history. /help — show this help.';
  }
  if (cmd === '/compact') return 'Conversation compacted.';
  if (cmd === '/status') return 'Session is active.';
  if (cmd === '/reset') return 'Context reset.';
  return `Unknown command: "${command}". Type /help for available commands.`;
}
