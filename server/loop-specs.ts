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

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run, insert } from './db.ts';
import { generateId, now, str, parseJson, newId } from './util.ts';
import { emit } from './events.ts';

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

function requireProjectAccess(req: PortalRequest, res: PortalResponse, projectId: string): boolean {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  const project = one<{ id: string }>('SELECT id FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  if (req.user.is_admin) return true;
  const member = one<{ user_id: string }>(
    'SELECT user_id FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  return true;
}

function requireProjectEditor(req: PortalRequest, res: PortalResponse, projectId: string): boolean {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  if (req.user.is_admin) return true;
  const member = one<{ user_id: string; access: string }>(
    'SELECT user_id, access FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
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

function serializeSpec(s: LoopSpec) {
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
  router.get('/api/projects/:id/loop-specs', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const builtins = all<LoopSpec>(
      'SELECT * FROM p10_loop_specs WHERE project_id IS NULL AND is_builtin = 1 ORDER BY name',
    );
    const projectSpecs = all<LoopSpec>(
      'SELECT * FROM p10_loop_specs WHERE project_id = ? AND is_builtin = 0 ORDER BY created_at',
      req.params.id,
    );

    // Attach last run status to each spec
    const allSpecs = [...builtins, ...projectSpecs];
    const specsWithRuns = allSpecs.map((s) => {
      const lastRun = one<LoopRun>(
        'SELECT * FROM p10_loop_runs WHERE spec_id = ? ORDER BY started_at DESC LIMIT 1',
        s.id,
      );
      return { ...serializeSpec(s), last_run: lastRun ?? null };
    });

    sendJson(res, 200, { specs: specsWithRuns });
  });

  // POST /api/projects/:id/loop-specs
  router.post('/api/projects/:id/loop-specs', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectEditor(req, res, req.params.id)) return;

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

    insert('p10_loop_specs', {
      id,
      project_id: req.params.id,
      name,
      description,
      trigger_type: triggerType,
      trigger_config: triggerConfig,
      goal_template: goalTemplate,
      rules,
      stop_config: stopConfig,
      max_iterations: maxIterations,
      enabled: 1,
      is_builtin: 0,
      created_at: ts,
    });

    const spec = one<LoopSpec>('SELECT * FROM p10_loop_specs WHERE id = ?', id);
    sendJson(res, 201, { spec: spec ? serializeSpec(spec) : null });
  });

  // GET /api/projects/:id/loop-specs/:sid
  router.get('/api/projects/:id/loop-specs/:sid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    // Allow access to built-in specs or project-specific specs
    const spec = one<LoopSpec>(
      'SELECT * FROM p10_loop_specs WHERE id = ? AND (project_id = ? OR project_id IS NULL)',
      req.params.sid,
      req.params.id,
    );
    if (!spec) { sendJson(res, 404, { error: 'Loop spec not found' }); return; }

    sendJson(res, 200, { spec: serializeSpec(spec) });
  });

  // PUT /api/projects/:id/loop-specs/:sid
  router.put('/api/projects/:id/loop-specs/:sid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectEditor(req, res, req.params.id)) return;

    const spec = one<LoopSpec>(
      'SELECT * FROM p10_loop_specs WHERE id = ? AND project_id = ? AND is_builtin = 0',
      req.params.sid,
      req.params.id,
    );
    if (!spec) { sendJson(res, 404, { error: 'Loop spec not found or cannot be modified' }); return; }

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

    const keys = Object.keys(patch);
    run(
      `UPDATE p10_loop_specs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => patch[k] as string | number | null),
      spec.id,
    );

    const updated = one<LoopSpec>('SELECT * FROM p10_loop_specs WHERE id = ?', spec.id);
    sendJson(res, 200, { spec: updated ? serializeSpec(updated) : null });
  });

  // DELETE /api/projects/:id/loop-specs/:sid
  router.delete('/api/projects/:id/loop-specs/:sid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectEditor(req, res, req.params.id)) return;

    const spec = one<LoopSpec>(
      'SELECT * FROM p10_loop_specs WHERE id = ? AND project_id = ? AND is_builtin = 0',
      req.params.sid,
      req.params.id,
    );
    if (!spec) {
      sendJson(res, 404, { error: 'Loop spec not found or built-in specs cannot be deleted' });
      return;
    }

    run('DELETE FROM p10_loop_specs WHERE id = ?', spec.id);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/loop-specs/:sid/run — manually trigger a loop run
  router.post('/api/projects/:id/loop-specs/:sid/run', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectEditor(req, res, req.params.id)) return;

    // Find built-in or project spec
    const spec = one<LoopSpec>(
      'SELECT * FROM p10_loop_specs WHERE id = ? AND (project_id = ? OR project_id IS NULL)',
      req.params.sid,
      req.params.id,
    );
    if (!spec) { sendJson(res, 404, { error: 'Loop spec not found' }); return; }
    if (!spec.enabled) { sendJson(res, 400, { error: 'This loop spec is disabled' }); return; }

    const body = req.body as Record<string, unknown>;
    const vars = body.vars && typeof body.vars === 'object' ? body.vars as Record<string, string> : {};

    // Fill in goal template with any provided vars
    let goal = spec.goal_template;
    for (const [k, v] of Object.entries(vars)) {
      goal = goal.replace(new RegExp(`\\{\\{${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g'), String(v));
    }

    // Create a loop run record
    const runId = generateId();
    const ts = now();

    // Optionally create a p6_workflow to track this run
    let workflowId: string | null = null;
    try {
      const wid = generateId();
      insert('p6_workflows', {
        id: wid,
        project_id: req.params.id,
        goal: goal.slice(0, 2000),
        status: 'pending',
        engine: 'demo',
        trust_tools: 0,
        lead_agent: null,
        workspace_id: null,
        output_files_enabled: 0,
        repo_ids: '[]',
        iteration_count: 0,
        max_iterations: spec.max_iterations,
        created_by: req.user!.id,
        created_at: ts,
        updated_at: ts,
      });
      workflowId = wid;
      emit(req.params.id, { type: 'workflow.created', workflowId: wid });
    } catch { /* if workflow insert fails, continue */ }

    insert('p10_loop_runs', {
      id: runId,
      spec_id: spec.id,
      status: 'running',
      iteration: 0,
      last_workflow_id: workflowId,
      started_at: ts,
      finished_at: null,
    });

    const loopRun = one<LoopRun>('SELECT * FROM p10_loop_runs WHERE id = ?', runId);
    sendJson(res, 201, {
      run: loopRun,
      workflow_id: workflowId,
      goal,
    });
  });

  // GET /api/projects/:id/loop-specs/:sid/runs — list loop run history
  router.get('/api/projects/:id/loop-specs/:sid/runs', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    // Find built-in or project spec
    const spec = one<LoopSpec>(
      'SELECT * FROM p10_loop_specs WHERE id = ? AND (project_id = ? OR project_id IS NULL)',
      req.params.sid,
      req.params.id,
    );
    if (!spec) { sendJson(res, 404, { error: 'Loop spec not found' }); return; }

    const limit = Math.min(100, Math.max(1, Number(req.query.get('limit') ?? '20')));
    const runs = all<LoopRun>(
      'SELECT * FROM p10_loop_runs WHERE spec_id = ? ORDER BY started_at DESC LIMIT ?',
      spec.id,
      limit,
    );

    sendJson(res, 200, { runs });
  });
}
