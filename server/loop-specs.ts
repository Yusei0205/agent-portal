/**
 * Loop Specs API (P10).
 *
 * Loop specs are reusable session recipes with triggers, goal templates,
 * verification pipelines, stop rules and escalation config.
 *
 * Routes:
 *   GET  /api/projects/:id/loop-specs              — list specs (built-ins + project)
 *   POST /api/projects/:id/loop-specs              — create custom spec
 *   GET  /api/projects/:id/loop-specs/:sid         — get spec
 *   PUT  /api/projects/:id/loop-specs/:sid         — update spec
 *   DELETE /api/projects/:id/loop-specs/:sid       — delete (non-builtin only)
 *   POST /api/projects/:id/loop-specs/:sid/run     — manually trigger a loop run
 *   GET  /api/projects/:id/loop-specs/:sid/runs    — list loop run history
 */

import { getSessionsRepository } from './repositories/sessions.ts';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, insert } from './db.ts';
import { generateId, now, str, parseJson, newId } from './util.ts';
import { emit } from './events.ts';
import { getLoopSpecsRepository } from './repositories/loop-specs.ts';
import type { LoopSpecRecord } from './repositories/loop-specs.ts';

import { getMemberRow, getProjectRow } from './project-access.ts';
// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoopSpec {
  id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  trigger_type: 'manual' | 'cron' | 'interval' | 'webhook' | 'github' | 'jira';
  trigger_config: string; // JSON
  goal_template: string;
  rules: string | null;
  stop_config: string; // JSON
  max_iterations: number;
  enabled: number;
  is_builtin: number;
  created_at: string;
}

export interface LoopRun {
  id: string;
  spec_id: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  iteration: number;
  last_workflow_id: string | null;
  started_at: string;
  finished_at: string | null;
}

const TRIGGER_TYPES = ['manual', 'cron', 'interval', 'webhook', 'github', 'jira'] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireProjectAccess(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  const project = await getProjectRow(projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  if (req.user.is_admin) return true;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  return true;
}

async function requireProjectEditor(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  if (req.user.is_admin) return true;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  if (!['editor', 'owner', 'admin'].includes(String(member.access))) {
    sendJson(res, 403, { error: 'Editor access required' });
    return false;
  }
  return true;
}

function serializeSpec(s: LoopSpec | LoopSpecRecord) {
  return {
    ...s,
    trigger_config: parseJson(s.trigger_config, {}),
    stop_config: parseJson(s.stop_config, {}),
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerLoopSpecRoutes(): void {

  // GET /api/projects/:id/loop-specs
  // Returns built-in specs (project_id IS NULL) + project-specific specs
  router.get('/api/projects/:id/loop-specs', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const allSpecs = await getLoopSpecsRepository().listSpecsByProject(req.params.id);

    // Attach last run status to each spec
    const specsWithRuns = await Promise.all(allSpecs.map(async (s) => {
      const lastRun = await getLoopSpecsRepository().getLastRunBySpec(s.id);
      return { ...serializeSpec(s), last_run: lastRun ?? null };
    }));

    sendJson(res, 200, { specs: specsWithRuns });
  });

  // POST /api/projects/:id/loop-specs
  router.post('/api/projects/:id/loop-specs', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectEditor(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;

    const name = str(body.name, 'name', { max: 120 }).trim();
    const description = body.description != null ? String(body.description).slice(0, 500) : null;
    const triggerType = TRIGGER_TYPES.includes(body.triggerType as typeof TRIGGER_TYPES[number])
      ? String(body.triggerType)
      : 'manual';
    const goalTemplate = String(body.goalTemplate ?? body.goal_template ?? '').slice(0, 6000);
    const rules = body.rules != null ? String(body.rules).slice(0, 4000) : null;
    const maxIterations = Math.min(50, Math.max(1, Number(body.maxIterations ?? 10)));

    const triggerConfig = body.triggerConfig && typeof body.triggerConfig === 'object'
      ? JSON.stringify(body.triggerConfig)
      : '{}';
    const stopConfig = body.stopConfig && typeof body.stopConfig === 'object'
      ? JSON.stringify(body.stopConfig)
      : '{}';

    const id = generateId();
    const ts = now();

    const spec = await getLoopSpecsRepository().createSpec({
      id, project_id: req.params.id, name, description, trigger_type: triggerType,
      trigger_config: triggerConfig, goal_template: goalTemplate, rules, stop_config: stopConfig,
      max_iterations: maxIterations, enabled: 1, is_builtin: 0, created_at: ts,
    });
    sendJson(res, 201, { spec: serializeSpec(spec) });
  });

  // GET /api/projects/:id/loop-specs/:sid
  router.get('/api/projects/:id/loop-specs/:sid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const spec = await getLoopSpecsRepository().getSpecById(req.params.sid);
    if (!spec || (spec.project_id !== null && spec.project_id !== req.params.id)) {
      sendJson(res, 404, { error: 'Loop spec not found' }); return;
    }

    sendJson(res, 200, { spec: serializeSpec(spec) });
  });

  // PUT /api/projects/:id/loop-specs/:sid
  router.put('/api/projects/:id/loop-specs/:sid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectEditor(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if (body.name !== undefined) patch.name = str(body.name, 'name', { max: 120 }).trim();
    if (body.description !== undefined) patch.description = String(body.description).slice(0, 500);
    if (body.triggerType !== undefined && TRIGGER_TYPES.includes(body.triggerType as typeof TRIGGER_TYPES[number])) {
      patch.trigger_type = String(body.triggerType);
    }
    if (body.triggerConfig !== undefined && typeof body.triggerConfig === 'object') {
      patch.trigger_config = JSON.stringify(body.triggerConfig);
    }
    if (body.goalTemplate !== undefined) patch.goal_template = String(body.goalTemplate).slice(0, 6000);
    if (body.rules !== undefined) patch.rules = String(body.rules).slice(0, 4000);
    if (body.stopConfig !== undefined && typeof body.stopConfig === 'object') {
      patch.stop_config = JSON.stringify(body.stopConfig);
    }
    if (body.maxIterations !== undefined) {
      patch.max_iterations = Math.min(50, Math.max(1, Number(body.maxIterations)));
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;

    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'Nothing to update' });
      return;
    }

    const updated = await getLoopSpecsRepository().updateSpec(req.params.sid, req.params.id, patch as Partial<LoopSpecRecord>);
    if (!updated) { sendJson(res, 404, { error: 'Loop spec not found or cannot be modified' }); return; }

    sendJson(res, 200, { spec: serializeSpec(updated) });
  });

  // DELETE /api/projects/:id/loop-specs/:sid
  router.delete('/api/projects/:id/loop-specs/:sid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectEditor(req, res, req.params.id)) return;

    const deleted = await getLoopSpecsRepository().deleteSpec(req.params.sid, req.params.id);
    if (!deleted) {
      sendJson(res, 404, { error: 'Loop spec not found or built-in specs cannot be deleted' });
      return;
    }

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/loop-specs/:sid/run — manually trigger a loop run
  router.post('/api/projects/:id/loop-specs/:sid/run', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectEditor(req, res, req.params.id)) return;

    // Find built-in or project spec
    const spec = await getLoopSpecsRepository().getSpecById(req.params.sid);
    if (!spec || (spec.project_id !== null && spec.project_id !== req.params.id)) {
      sendJson(res, 404, { error: 'Loop spec not found' }); return;
    }
    if (!spec.enabled) { sendJson(res, 400, { error: 'This loop spec is disabled' }); return; }

    const body = req.body as Record<string, unknown>;
    const vars = body.vars && typeof body.vars === 'object' ? body.vars as Record<string, string> : {};

    let goal = spec.goal_template;
    for (const [k, v] of Object.entries(vars)) {
      goal = goal.replace(new RegExp(`\\{\\{${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g'), String(v));
    }

    const runId = generateId();
    const ts = now();

    let workflowId: string | null = null;
    try {
      const wid = generateId();
      await getSessionsRepository().createWorkflow({
        id: wid, project_id: req.params.id, goal: goal.slice(0, 2000), status: 'pending',
        engine: 'demo', trust_tools: 0, lead_agent: null, workspace_id: null,
        output_files_enabled: 0, repo_ids: '[]', iteration_count: 0,
        max_iterations: spec.max_iterations, credential_id: null, model: '',
        created_by: req.user!.id, created_at: ts, updated_at: ts,
      });
      workflowId = wid;
      emit(req.params.id, { type: 'workflow.created', workflowId: wid });
    } catch { /* if workflow insert fails, continue */ }

    const loopRun = await getLoopSpecsRepository().createRun({
      id: runId, spec_id: spec.id, status: 'running', iteration: 0,
      last_workflow_id: workflowId, started_at: ts, finished_at: null,
    });
    sendJson(res, 201, { run: loopRun, workflow_id: workflowId, goal });
  });

  // GET /api/projects/:id/loop-specs/:sid/runs — list loop run history
  router.get('/api/projects/:id/loop-specs/:sid/runs', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const spec = await getLoopSpecsRepository().getSpecById(req.params.sid);
    if (!spec || (spec.project_id !== null && spec.project_id !== req.params.id)) {
      sendJson(res, 404, { error: 'Loop spec not found' }); return;
    }

    const limit = Math.min(100, Math.max(1, Number(req.query.get('limit') ?? '20')));
    const runs = await getLoopSpecsRepository().listRunsBySpec(spec.id, limit);

    sendJson(res, 200, { runs });
  });
}
