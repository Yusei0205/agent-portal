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
import { fireLoopSpec, newWebhookSecret, readWebhookBody, triggerProblem, webhookSignatureOk, webhookVars } from './loop-triggers.ts';
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
  // The webhook secret is shown once, when it is made; it is never sent again.
  const { webhookSecret, ...triggerConfig } = parseJson<Record<string, unknown>>(s.trigger_config, {});
  return {
    ...s,
    webhook_configured: Boolean(webhookSecret),
    trigger_config: triggerConfig,
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

    const triggerObj: Record<string, unknown> = body.triggerConfig && typeof body.triggerConfig === 'object'
      ? { ...(body.triggerConfig as Record<string, unknown>) }
      : {};
    const problem = triggerProblem(triggerType, triggerObj);
    if (problem) { sendJson(res, 400, { error: problem }); return; }
    // Sessions started by a trigger run as the person who set it up (and only while they can still edit the project).
    triggerObj.runAs = req.user!.id;
    delete triggerObj.webhookSecret;
    let webhookSecret: string | undefined;
    if (triggerType === 'webhook') { webhookSecret = newWebhookSecret(); triggerObj.webhookSecret = webhookSecret; }
    const triggerConfig = JSON.stringify(triggerObj);
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
    sendJson(res, 201, { spec: serializeSpec(spec), ...(webhookSecret ? { webhookSecret } : {}) });
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
    const current = await getLoopSpecsRepository().getSpecById(req.params.sid);
    if (!current || current.is_builtin || current.project_id !== req.params.id) {
      sendJson(res, 404, { error: 'Loop spec not found or cannot be modified' }); return;
    }
    let newSecret: string | undefined;
    if (body.triggerType !== undefined || body.triggerConfig !== undefined) {
      const type = body.triggerType !== undefined && TRIGGER_TYPES.includes(body.triggerType as typeof TRIGGER_TYPES[number])
        ? String(body.triggerType) : current.trigger_type;
      const old = parseJson<Record<string, unknown>>(current.trigger_config, {});
      const cfg: Record<string, unknown> = body.triggerConfig && typeof body.triggerConfig === 'object'
        ? { ...(body.triggerConfig as Record<string, unknown>) } : { ...old };
      const problem = triggerProblem(type, cfg);
      if (problem) { sendJson(res, 400, { error: problem }); return; }
      cfg.runAs = req.user!.id;
      delete cfg.webhookSecret;
      if (type === 'webhook') {
        if (typeof old.webhookSecret === 'string' && old.webhookSecret) cfg.webhookSecret = old.webhookSecret;
        else { newSecret = newWebhookSecret(); cfg.webhookSecret = newSecret; }
      }
      patch.trigger_type = type;
      patch.trigger_config = JSON.stringify(cfg);
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

    sendJson(res, 200, { spec: serializeSpec(updated), ...(newSecret ? { webhookSecret: newSecret } : {}) });
  });

  // POST /api/projects/:id/loop-specs/:sid/webhook-secret — make a new webhook secret (shown once)
  router.post('/api/projects/:id/loop-specs/:sid/webhook-secret', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectEditor(req, res, req.params.id)) return;
    const spec = await getLoopSpecsRepository().getSpecById(req.params.sid);
    if (!spec || spec.is_builtin || spec.project_id !== req.params.id) { sendJson(res, 404, { error: 'Loop spec not found' }); return; }
    if (spec.trigger_type !== 'webhook') { sendJson(res, 400, { error: 'This spec does not use a webhook trigger' }); return; }
    const cfg = parseJson<Record<string, unknown>>(spec.trigger_config, {});
    const secret = newWebhookSecret();
    cfg.webhookSecret = secret;
    cfg.runAs = req.user!.id;
    await getLoopSpecsRepository().updateSpec(spec.id, req.params.id, { trigger_config: JSON.stringify(cfg) } as Partial<LoopSpecRecord>);
    sendJson(res, 200, { webhookSecret: secret });
  });

  // POST /api/hooks/loop-specs/:sid — a signed webhook starts the spec (no sign-in: the signature is the proof)
  // A raw route: callers such as GitHub or Jira cannot send the browser header, so the signature replaces it, and
  // the body is read here (it has to be the exact bytes that were signed).
  router.rawPost('/api/hooks/loop-specs/:sid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    try {
      const body = await readWebhookBody(req);
      req.rawBody = body.raw;
      req.body = body.json;
    } catch {
      sendJson(res, 413, { error: 'Request body too large' }); return;
    }
    const spec = await getLoopSpecsRepository().getSpecById(req.params.sid);
    const cfg = spec ? parseJson<Record<string, unknown>>(spec.trigger_config, {}) : {};
    const secret = typeof cfg.webhookSecret === 'string' ? cfg.webhookSecret : '';
    const sig = String(req.headers['x-portal-signature'] ?? req.headers['x-hub-signature-256'] ?? '');
    // The same answer for "no such spec" and "wrong signature", so the ids cannot be probed.
    if (!spec || spec.trigger_type !== 'webhook' || !webhookSignatureOk(req.rawBody, sig, secret)) {
      sendJson(res, 401, { error: 'Invalid signature' }); return;
    }
    const result = await fireLoopSpec(spec, { source: 'webhook', vars: webhookVars(req.body) });
    if (!result.ok) { sendJson(res, result.status, { error: result.reason }); return; }
    sendJson(res, 202, { ok: true, workflow_id: result.workflowId, run_id: result.runId });
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

    const body = (req.body ?? {}) as Record<string, unknown>;
    const vars: Record<string, string> = {};
    if (body.vars && typeof body.vars === 'object') {
      for (const [k, v] of Object.entries(body.vars as Record<string, unknown>)) vars[k] = String(v).slice(0, 500);
    }
    const result = await fireLoopSpec(spec, { source: 'manual', vars, userId: req.user!.id, projectId: req.params.id });
    if (!result.ok) { sendJson(res, result.status, { error: result.reason }); return; }
    sendJson(res, 201, { run: result.run, workflow_id: result.workflowId, goal: result.goal });
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
