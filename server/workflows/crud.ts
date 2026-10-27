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
import { one, all, insert, run as dbRun } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now, str, int, badRequest } from '../util.ts';
import { subscribe } from '../events.ts';
import { cancelRun } from './controls.ts';
import { startRun } from './driver.ts';
import { resolveApproval } from '../agent/runner.ts';

// ── Constant ───────────────────────────────────────────────────────────────────

const GOAL_MAX_CHARS = 8_000;

// ── View helpers ───────────────────────────────────────────────────────────────

function workflowView(w: Row) {
  return {
    id: w.id,
    project_id: w.project_id,
    goal: w.goal,
    status: w.status,
    engine: w.engine,
    trust_tools: Boolean(w.trust_tools),
    lead_agent: w.lead_agent ?? null,
    workspace_id: w.workspace_id ?? null,
    output_files_enabled: Boolean(w.output_files_enabled),
    repo_ids: safeJson(w.repo_ids as string, []),
    iteration_count: w.iteration_count ?? 0,
    max_iterations: w.max_iterations ?? 10,
    created_by: w.created_by ?? null,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
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
    const conditions: string[] = ['project_id = ?'];
    const params: (string | number)[] = [projectId];

    if (statusFilter) { conditions.push('status = ?'); params.push(statusFilter); }
    if (engineFilter) { conditions.push('engine = ?'); params.push(engineFilter); }
    if (search) { conditions.push('goal LIKE ?'); params.push(`%${search}%`); }

    const where = conditions.join(' AND ');

    const total = (one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM p6_workflows WHERE ${where}`,
      ...params,
    )?.n) ?? 0;

    const workflows = all<Row>(
      `SELECT * FROM p6_workflows WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );

    sendJson(res, 200, { workflows: workflows.map(workflowView), total });
  });

  // POST /api/projects/:id/workflows
  router.post('/api/projects/:id/workflows', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const goal = str(body.goal as string, 'goal', { max: GOAL_MAX_CHARS }).trim();

    const engine = validateEngine(body.engine);
    const trustTools = Boolean(body.trustTools ?? false);
    const leadAgent = body.leadAgent ? str(body.leadAgent as string, 'leadAgent', { max: 200, optional: true }) : null;
    const workspaceId = body.workspaceId ? str(body.workspaceId as string, 'workspaceId', { max: 200, optional: true }) : null;
    const outputFiles = Boolean(body.outputFiles ?? false);
    const maxIterations = int(body.maxIterations, 'maxIterations', 10, 1, 100);
    const repoIds = Array.isArray(body.repoIds) ? body.repoIds.map(String) : [];
    const projectId = String(project.id);

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
      created_by: req.user!.id,
      created_at: ts,
      updated_at: ts,
    });

    const workflow = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', id)!;
    sendJson(res, 201, { workflow: workflowView(workflow) });
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
      workflow: workflowView(w),
      latestRun: latestRun ? runView(latestRun) : null,
    });
  });

  // DELETE /api/projects/:id/workflows/:wid
  router.delete('/api/projects/:id/workflows/:wid', (req: PortalRequest, res: PortalResponse): void => {
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

    dbRun('DELETE FROM p6_workflows WHERE id = ?', String(w.id));
    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/workflows/:wid/start
  router.post('/api/projects/:id/workflows/:wid/start', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    // Don't allow starting if already running
    if (w.status === 'running') {
      sendJson(res, 409, { error: 'This session is already running' });
      return;
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

    // Subscribe to live project events
    const unsubscribe = subscribe(String(p.id), res);
    res.on('close', unsubscribe);
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

    if (response !== 'approve' && response !== 'deny' && typeof response !== 'string') {
      sendJson(res, 400, { error: 'response must be "approve", "deny", or a string' });
      return;
    }

    // Persist the response to the input record
    dbRun(
      'UPDATE p6_inputs SET response = ?, allow_all = ? WHERE id = ? AND run_id = ?',
      JSON.stringify(response),
      allowAll ? 1 : 0,
      inputId,
      String(r.id),
    );

    const decision: 'approve' | 'deny' = response === 'approve' ? 'approve' : 'deny';
    const resolved = resolveApproval(String(r.id), inputId, decision);

    if (!resolved) {
      // The run may have finished already — that's fine
      sendJson(res, 200, { ok: true, note: 'Run was not waiting for this input' });
      return;
    }

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/workflows/:wid/cancel
  router.post('/api/projects/:id/workflows/:wid/cancel', (req: PortalRequest, res: PortalResponse): void => {
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

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/workflows/:wid/message
  router.post('/api/projects/:id/workflows/:wid/message', (req: PortalRequest, res: PortalResponse): void => {
    const project = requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = requireWorkflow(res, req.params.id, req.params.wid);
    if (!w) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = str(body.message as string, 'message', { max: 10_000 }).trim();

    // Store the follow-up message as a workflow event
    const eventId = generateId();
    insert('workflow_events', {
      id: eventId,
      workflow_id: String(w.id),
      kind: 'human',
      run_id: null,
      body: message,
      data: JSON.stringify({ by: req.user!.id }),
      consumed: 0,
      created_at: now(),
    });

    sendJson(res, 200, { ok: true, eventId });
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
