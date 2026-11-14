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

import { saveChatAttachments } from '../session-attachments.ts';
import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { one, all, getDb } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now, str, int, badRequest } from '../util.ts';
import { subscribe, addLiveSubscriber } from '../events.ts';
import { emit } from '../events.ts';
import { shutdownSessionBrowser } from '../agent/browser-manager.ts';
import { cancelRun } from './controls.ts';
import { startRun } from './driver.ts';
import { runPortalCommand, PORTAL_COMMANDS } from './slash-commands.ts';
import { parseSlashCommand, resolveSessionCommand, sessionCommands, unknownCommandText } from './session-commands.ts';
import { requestRepoPrep, getRepoPrep } from '../agent/repo-prep.ts';
import { setCavemanMode } from '../agent/caveman-guidance.ts';
import { resolveApproval } from '../agent/approvals.ts';
import { inputFingerprint, emitRunEvent } from '../agent/runner.ts';
import { appendAudit } from '../audit.ts';
import { createChildSession, checkDelegationLimits, getDelegationSettings, stopAndDeleteChildren } from '../delegation.ts';
import { getDelegationSettingsRepository } from '../repositories/delegation-settings.ts';
import { checkKey, issueDetail, mustMapping } from '../jira.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { getProjectRepository } from '../repositories/projects.ts';
import { getWorkspacesRepository } from '../repositories/workspaces.ts';
import { getGitReposRepository } from '../repositories/git-repos.ts';
import { getIntegrationsRepository } from '../repositories/integrations.ts';
import { getCredentialsRepository } from '../repositories/credentials.ts';
import { isBedrockRuntimeChoice } from '../credentials.ts';
import { flushWorkspaceViaRunner } from '../agent/runner-inspect-client.ts';
import { parseSessionIntegrations, encodeSessionIntegrations, integrationIsPersonal } from '../agent/runner-integrations.ts';
import { deleteSnapshot } from '../agent/runner-snapshot-access.ts';
import { newLoopState } from './loop.ts';
import type { WorkflowRecord } from '../repositories/sessions.ts';

// ── Constant ───────────────────────────────────────────────────────────────────

const GOAL_MAX_CHARS = 8_000;
const MODEL_RE = /^[A-Za-z0-9._:\/@-]{0,200}$/;

// ── Scope helper ───────────────────────────────────────────────────────────────

function hasTokenScope(req: PortalRequest, scope: string): boolean {
  if (!req.authViaToken) return true; // browser session — all scopes allowed
  return (req.tokenScopes ?? []).includes(scope);
}

// ── View helpers ───────────────────────────────────────────────────────────────

function workflowView(w: Row | WorkflowRecord) {
  return {
    id: w.id,
    project_id: w.project_id,
    title: (w.title as string | undefined) ?? '',
    goal: w.goal,
    initial_goal: w.initial_goal ?? w.goal,
    status: w.status,
    stop_reason: (w.stop_reason as string | undefined) ?? '',
    engine: w.engine,
    trust_tools: Boolean((w as Row).trust_tools),
    loop: Boolean(String((w as Row).loop_state ?? '').trim()),
    lead_agent: w.lead_agent ?? null,
    workspace_id: w.workspace_id ?? null,
    output_files_enabled: Boolean((w as Row).output_files_enabled),
    repo_ids: safeJson((w as Row).repo_ids as string, []),
    // null = the project's enabled integrations; a list = only those
    integration_ids: parseSessionIntegrations((w as Row).integrations),
    iteration_count: (w as WorkflowRecord).iteration_count ?? 0,
    max_iterations: (w as WorkflowRecord).max_iterations ?? 10,
    last_turn_at: w.last_turn_at ?? null,
    credential_id: w.credential_id ?? null,
    model: (w.model as string | undefined) ?? '',
    engineSessionId: (w.engine_session_id as string | undefined) ?? null,
    created_by: w.created_by ?? null,
    created_at: w.created_at,
    updated_at: w.updated_at,
    parent_id: (w as WorkflowRecord).parent_id ?? null,
    parent_title: (w as WorkflowRecord).parent_title ?? null,
    child_count: (w as WorkflowRecord).child_count ?? 0,
    jira_key: (w as WorkflowRecord).jira_key ?? '',
    jira_summary: (w as WorkflowRecord).jira_summary ?? '',
    jira_url: (w as WorkflowRecord).jira_url ?? '',
    resumable: Boolean((w as WorkflowRecord).resumable),
    lastRunStatus: (w as WorkflowRecord).lastRunStatus ?? null,
  };
}

/**
 * Enrich a single workflow row with parent_title, child_count, resumable, and lastRunStatus.
 * Uses the sessions repository.
 */
async function enrichWorkflowRow(w: Row | WorkflowRecord): Promise<WorkflowRecord> {
  const repo = getSessionsRepository();
  const id = String(w.id);
  const parentId = (w as WorkflowRecord).parent_id ?? (w as Row).parent_id ?? null;
  let parentTitle: string | null = null;
  if (parentId) {
    const parent = await repo.getWorkflowById(String(parentId));
    if (parent) {
      parentTitle = parent.title?.trim() || parent.goal.slice(0, 60);
    }
  }
  const childCount =
    (w as WorkflowRecord).child_count !== undefined
      ? ((w as WorkflowRecord).child_count ?? 0)
      : (await repo.listChildWorkflows(id)).length;

  const wfStatus = String(w.status ?? '');
  const latestRun = await repo.getLatestRun(id);
  const lastRunStatus = latestRun?.status ?? null;
  const resumableStatuses = new Set(['failed', 'paused', 'stopped', 'cancelled']);
  const resumableRunStatuses = new Set(['failed', 'cancelled']);
  const resumable = w.stop_reason !== 'awaiting_message' && (
    resumableStatuses.has(wfStatus) ||
    (lastRunStatus !== null && resumableRunStatuses.has(lastRunStatus)));

  // Build a WorkflowRecord merging enrichment with the original row
  const base: WorkflowRecord = typeof (w as WorkflowRecord).iteration_count === 'number'
    ? (w as WorkflowRecord)
    : {
        id: String(w.id),
        project_id: w.project_id != null ? String(w.project_id) : null,
        title: String((w as Row).title ?? ''),
        goal: String(w.goal ?? ''),
        status: String(w.status ?? ''),
        stop_reason: String((w as Row).stop_reason ?? ''),
        engine: String(w.engine ?? ''),
        trust_tools: Number((w as Row).trust_tools ?? 0),
        lead_agent: (w as Row).lead_agent != null ? String((w as Row).lead_agent) : null,
        workspace_id: (w as Row).workspace_id != null ? String((w as Row).workspace_id) : null,
        output_files_enabled: Number((w as Row).output_files_enabled ?? 0),
        repo_ids: String((w as Row).repo_ids ?? '[]'),
        iteration_count: Number((w as Row).iteration_count ?? 0),
        max_iterations: Number((w as Row).max_iterations ?? 10),
        last_turn_at: (w as Row).last_turn_at != null ? String((w as Row).last_turn_at) : null,
        credential_id: (w as Row).credential_id != null ? String((w as Row).credential_id) : null,
        model: String((w as Row).model ?? ''),
        engine_session_id: (w as Row).engine_session_id != null ? String((w as Row).engine_session_id) : null,
        engine_session_engine: null,
        created_by: w.created_by != null ? String(w.created_by) : null,
        created_at: String(w.created_at ?? ''),
        updated_at: String(w.updated_at ?? ''),
        parent_id: parentId != null ? String(parentId) : null,
        work_dir: null,
        jira_key: String((w as Row).jira_key ?? ''),
        jira_summary: String((w as Row).jira_summary ?? ''),
        jira_url: String((w as Row).jira_url ?? ''),
        kind: (w as Row).kind != null ? String((w as Row).kind) : null,
        run_timeout_minutes: null,
      };

  return { ...base, parent_title: parentTitle, child_count: childCount, resumable, lastRunStatus };
}

function runView(r: Row | import('../repositories/sessions.ts').RunRecord) {
  return {
    id: r.id,
    workflow_id: r.workflow_id,
    status: r.status,
    started_at: r.started_at ?? null,
    finished_at: r.finished_at ?? null,
    cost_usd: r.cost_usd ?? 0,
    input_tokens: r.input_tokens ?? 0,
    output_tokens: r.output_tokens ?? 0,
    cache_write_tokens: (r as import('../repositories/sessions.ts').RunRecord).cache_write_tokens ?? 0,
    cache_read_tokens: (r as import('../repositories/sessions.ts').RunRecord).cache_read_tokens ?? 0,
    created_at: r.created_at,
  };
}

function eventView(e: Row | import('../repositories/sessions.ts').EventRecord) {
  return {
    id: typeof e.id === 'number' ? e.id : Number(e.id),
    run_id: e.run_id,
    type: e.type,
    payload: safeJson(typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload), {}),
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
async function requireProjectMember(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): Promise<Row | null> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return null; }
  const projects = getProjectRepository();
  const p = await projects.getProjectById(projectId);
  if (!p) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  if (req.user.is_admin) return p as unknown as Row;
  if (!(await projects.isMember(projectId, req.user.id))) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  return p as unknown as Row;
}

// ── Transcript helpers ─────────────────────────────────────────────────────────

type TxRow = {
  src: string; id: number; created_at: string; kind: string;
  body: string; run_id: string | null;
};

/**
 * Coalesce consecutive streamed assistant-text rows from the same run into a
 * single row.  Rows are passed newest-first (as returned by the DB query).
 *
 * Why: Kiro emits one p6_events row per stream chunk, so a single agent reply
 * of ~100 chunks consumes 100 of the 200-row page limit.  After coalescing, a
 * page covers turns rather than tokens, making the >200-row case uncommon.
 *
 * Algorithm:
 *   Walk the newest-first array.  When we encounter a contiguous run of
 *   assistant-text rows (src='r', payload.stream=true) from the same run_id,
 *   we collect the group, reverse it to chronological order, concatenate the
 *   text, and emit a single row with the OLDEST chunk's id/created_at so the
 *   event sorts correctly in the timeline.  The payload retains stream:true so
 *   the client's mergeConsecutiveAssistantText recognises it.
 *
 * Cursor correctness: the caller computes nextCursor from the raw rows BEFORE
 * calling this function, so pagination positions are unaffected.
 */
export function coalesceStreamedRows(rows: TxRow[]): TxRow[] {
  if (rows.length === 0) return rows;

  const result: TxRow[] = [];
  let i = 0;

  while (i < rows.length) {
    const row = rows[i];

    // Only coalesce src='r' (p6_events) assistant-text rows that carry stream:true
    if (row.kind === 'assistant-text' && row.src === 'r') {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(row.body) as Record<string, unknown>; } catch { payload = {}; }

      if (payload.stream === true) {
        // Collect the full group (current order: newest → oldest)
        const group: TxRow[] = [row];
        let j = i + 1;
        while (j < rows.length) {
          const next = rows[j];
          if (next.kind !== 'assistant-text' || next.src !== 'r' || next.run_id !== row.run_id) break;
          let np: Record<string, unknown>;
          try { np = JSON.parse(next.body) as Record<string, unknown>; } catch { np = {}; }
          if (np.stream !== true) break;
          group.push(next);
          j++;
        }

        if (group.length === 1) {
          result.push(row);
        } else {
          // Reverse to chronological order (oldest first) for text concatenation
          const chron = group.slice().reverse();
          let text = '';
          for (const r of chron) {
            let p: Record<string, unknown>;
            try { p = JSON.parse(r.body) as Record<string, unknown>; } catch { p = {}; }
            text += String(p.text ?? p.content ?? '');
          }
          // Keep the oldest chunk's id/created_at so the event sorts to the
          // correct timeline position; retain stream:true for client merge logic.
          const oldest = chron[0];
          let oldestPayload: Record<string, unknown>;
          try { oldestPayload = JSON.parse(oldest.body) as Record<string, unknown>; } catch { oldestPayload = {}; }
          result.push({ ...oldest, body: JSON.stringify({ ...oldestPayload, text, stream: true }) });
        }

        i = j;
        continue;
      }
    }

    result.push(row);
    i++;
  }

  return result;
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerWorkflowRoutes(): void {

  // GET /api/projects/:id/workflows
  router.get('/api/projects/:id/workflows', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;

    const limit = Math.min(int(req.query.get('limit'), 'limit', 50, 1, 200), 200);
    const offset = int(req.query.get('offset'), 'offset', 0, 0);
    const statusFilter = req.query.get('status') ?? '';
    const engineFilter = req.query.get('engine') ?? '';
    const search = req.query.get('search') ?? '';
    const projectId = String(project.id);

    const repo = getSessionsRepository();
    const result = await repo.listWorkflowsByProject(projectId, {
      limit,
      offset,
      status: statusFilter || undefined,
      engine: engineFilter || undefined,
      search: search || undefined,
    });

    sendJson(res, 200, { workflows: result.workflows.map(workflowView), total: result.total, cursor: result.cursor ?? null });
  });

  // POST /api/projects/:id/workflows
  router.post('/api/projects/:id/workflows', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const goal = str(body.goal as string, 'goal', { max: GOAL_MAX_CHARS, optional: true }).trim();

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
      const ws = await getWorkspacesRepository().getByIdForProject(workspaceId, projectId);
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
        const projectRepos = await getGitReposRepository().listByProject(projectId);
        const validIds = new Set(projectRepos.map((r) => r.id));
        repoIds = combined.filter((id) => validIds.has(id));
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
    const model: string = requestModel ?? (wsEngineMatches ? wsDefaultModel : null) ?? (engine === 'codex' ? null : projectDefaultModel) ?? '';

    // A loop session's rules and checks are validated before anything is created (a check may not be allowed).
    let loopState: string | null = null;
    if (body.loop) {
      const loopBody = (typeof body.loop === 'object' ? body.loop : {}) as Record<string, unknown>;
      try {
        loopState = newLoopState(loopBody.stopRules, { progressFile: loopBody.progressFile !== false, checks: loopBody.checks });
      } catch (e) {
        sendJson(res, 400, { error: (e as Error).message });
        return;
      }
    }

    const id = generateId();
    const ts = now();

    const repo = getSessionsRepository();
    const wfRecord = await repo.createWorkflow({
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

    // A loop session goes from run to run by itself until a stop rule says to stop (see workflows/loop.ts).
    if (loopState) {
      await repo.updateWorkflow(id, { loop_state: loopState, updated_at: ts });
      wfRecord.loop_state = loopState;
    }

    // Terse replies (caveman) for a Claude session that asked for them.
    if (body.caveman === true && engine === 'claude-code') await setCavemanMode(id, true);

    // createWorkflow owns the child-count increment internally (both backends).
    emit(projectId, { type: 'workflow.created', workflowId: id });
    // Cloud engines: get the attached repositories ready before the first message.
    if (repoIds.length > 0) await requestRepoPrep(id).catch((e) => console.error('[repo-prep] request failed:', e));

    const enriched = await enrichWorkflowRow(wfRecord);
    sendJson(res, 201, { workflow: workflowView(enriched) });
  });

  // GET /api/projects/:id/workflows/:wid
  router.get('/api/projects/:id/workflows/:wid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const repo = getSessionsRepository();
    const w = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

    const latestRun = await repo.getLatestRun(w.id);

    sendJson(res, 200, {
      workflow: workflowView(await enrichWorkflowRow(w)),
      latestRun: latestRun ? runView(latestRun) : null,
    });
  });

  // DELETE /api/projects/:id/workflows/:wid
  router.delete('/api/projects/:id/workflows/:wid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const repo = getSessionsRepository();
    const w = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

    // Cancel any active run first
    const activeRun = await repo.getActiveRun(w.id);
    if (activeRun) cancelRun(activeRun.id);

    // Stop and delete child sessions recursively (must complete before deleteWorkflow
    // so delegation slot counters are released and FK constraints are satisfied).
    await stopAndDeleteChildren(w.id);

    // Close the session's live browser
    shutdownSessionBrowser(w.id).catch(() => {/* non-fatal */});

    // deleteWorkflow owns the child-count decrement internally (both backends).
    await repo.deleteWorkflow(w.id);
    // The saved workspace (repositories) of the session goes with it.
    deleteSnapshot(w.id).catch(() => {/* non-fatal: the bucket expires it anyway */});

    emit(String(project.id), { type: 'workflow.deleted', workflowId: w.id });
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
      const project = await requireProjectMember(req, res, req.params.id);
      if (!project) return;
      const repo = getSessionsRepository();
      const wf = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
      if (!wf) { sendJson(res, 404, { error: 'Workflow not found' }); return; }
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
        const child = await createChildSession(wf.id, req.user.id, task, { title, leadAgent });
        sendJson(res, 201, { workflow: workflowView(await enrichWorkflowRow(child)) });
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
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const repo = getSessionsRepository();
    const w = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

    const existingRun = await repo.getActiveRun(w.id);
    if (existingRun) {
      sendJson(res, 200, { runId: existingRun.id, run: runView(existingRun), alreadyRunning: true });
      return;
    }

    if (w.status === 'running') {
      sendJson(res, 409, { error: 'This session is already running' });
      return;
    }

    try {
      const runId = await startRun(w.id);
      const ts = now();
      await repo.updateWorkflow(w.id, { last_turn_at: ts, stop_reason: '', updated_at: ts });
      const run = await repo.getRunById(runId);
      sendJson(res, 201, { runId, run: run ? runView(run) : null });
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? String(e);
      console.error(`[workflows] start failed for ${req.params.wid}:`, e instanceof Error ? e.stack : e);
      sendJson(res, 429, { error: msg });
    }
  });

  // GET /api/projects/:id/workflows/:wid/runs
  router.get('/api/projects/:id/workflows/:wid/runs', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const repo = getSessionsRepository();
    const w = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }
    const runs = await repo.listRunsByWorkflow(w.id, 100);
    sendJson(res, 200, { runs: runs.map(runView) });
  });

  // GET /api/projects/:id/workflows/:wid/runs/:rid
  router.get('/api/projects/:id/workflows/:wid/runs/:rid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const repo = getSessionsRepository();
    const w = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

    const r = await repo.getRunByWorkflowAndId(w.id, req.params.rid);
    if (!r) { sendJson(res, 404, { error: 'Run not found' }); return; }

    const events = await repo.listRunEvents(r.id, 500);

    sendJson(res, 200, { run: runView(r), events: events.map(eventView) });
  });

  // GET /api/projects/:id/workflows/:wid/runs/:rid/events  (SSE)
  router.sse('/api/projects/:id/workflows/:wid/runs/:rid/events', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const projectId = req.params.id;
    const wfId = req.params.wid;
    const runId = req.params.rid;

    // Async setup: lookup via repository works in both SQLite and DynamoDB mode.
    const repo = getSessionsRepository();
    (async () => {
      const w = await repo.getWorkflowByProjectId(projectId, wfId);
      if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

      const rRow = await repo.getRunByWorkflowAndId(w.id, runId);
      if (!rRow) { sendJson(res, 404, { error: 'Run not found' }); return; }

      const rid = rRow.id;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');

      repo.listRunEvents(rid).then((past) => {
        for (const e of past) {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: 'event', event: eventView(e) })}\n\n`);
          }
        }
      }).catch(() => {});

      // Subscribe to live project events
      if (w.project_id) addLiveSubscriber(w.project_id, res);
    })().catch((e) => {
      if (!res.writableEnded) sendJson(res, 500, { error: 'Internal error' });
      console.error('[SSE /runs/events] Error:', e);
    });
  });

  // POST /api/projects/:id/workflows/:wid/runs/:rid/input
  router.post('/api/projects/:id/workflows/:wid/runs/:rid/input', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const repo = getSessionsRepository();
    const w = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

    const r = await repo.getRunByWorkflowAndId(w.id, req.params.rid);
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

    // Load the input record using the repository (works in both SQLite and DynamoDB mode).
    const inputRow = await repo.getInputByRunAndId(r.id, inputId);
    if (!inputRow) { sendJson(res, 404, { error: 'Input not found' }); return; }

    if (inputRow.status === 'expired') {
      sendJson(res, 409, { error: 'Nobody answered this in time, so the agent was told to carry on without it.' });
      return;
    }

    // Allowing a tool call is a person looking at it. A token may answer questions and decline tool calls, not allow them.
    if (response === 'approve' && req.authViaToken) {
      sendJson(res, 403, { error: 'API tokens cannot approve tool calls. Approve it from a signed-in browser, or decline it.' });
      return;
    }

    if (response === 'approve') {
      let storedHash = inputRow.input_hash ?? null;
      if (!storedHash) {
        try {
          const p = JSON.parse(inputRow.payload ?? '{}');
          storedHash = p.inputHash ?? null;
          if (!storedHash && inputRow.tool_input) {
            const ti = JSON.parse(inputRow.tool_input);
            storedHash = inputFingerprint(inputRow.tool_name as string, ti);
          }
        } catch { /* skip */ }
      }
      if (storedHash && clientHash !== storedHash) {
        sendJson(res, 409, { error: 'This is not the tool call you reviewed. Reload the page and review it again.' });
        return;
      }
    }

    const claimed = await repo.updateInputConditional(inputId, 'pending', {
      status: 'answered',
      response: JSON.stringify(response),
      allow_all: allowAll ? 1 : 0,
      answered_by: req.user?.id ?? null,
      answered_at: now(),
      run_id: r.id,
    });

    if (!claimed) {
      sendJson(res, 409, { error: 'Someone answered this a moment ago.' });
      return;
    }

    const decision: 'allow' | 'deny' = response === 'approve' ? 'allow' : 'deny';
    const message = typeof body.message === 'string' ? body.message.slice(0, 2000) : '';
    resolveApproval(r.id, inputId, decision, { remember: allowAll, message });
    // Saved in the session's history, so the approval card shows the answer (not the buttons) after a reload.
    emitRunEvent(r.id, w.project_id ? String(w.project_id) : null, w.id, 'approval-resolved', {
      inputId,
      status: decision === 'allow' ? 'approved' : 'denied',
      allowAll: Boolean(allowAll && decision === 'allow'),
      by: req.user?.name ?? null,
    });

    if (w.project_id) {
      emit(w.project_id, { type: 'input.resolved', inputId, status: 'answered' });
    }

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/workflows/:wid/cancel
  router.post('/api/projects/:id/workflows/:wid/cancel', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const repo = getSessionsRepository();
    const w = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

    const activeRun = await repo.getActiveRun(w.id);
    if (activeRun) cancelRun(activeRun.id);

    const ts = now();
    await repo.updateWorkflow(w.id, { status: 'paused', updated_at: ts });

    if (w.project_id) {
      emit(w.project_id, { type: 'workflow.updated', workflowId: w.id, status: 'paused' });
    }

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/workflows/:wid/resume — reopen a session; wait for a user message
  router.post('/api/projects/:id/workflows/:wid/resume', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const repo = getSessionsRepository();
    const w = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

    const existingRun = await repo.getActiveRun(w.id);
    if (existingRun) {
      sendJson(res, 200, { runId: existingRun.id, run: runView(existingRun), alreadyRunning: true });
      return;
    }

    const wfStatus = w.status ?? '';
    const latestRun = await repo.getLatestRun(w.id);
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

    // Reopening is not a model turn. Keep the workflow paused so background
    // scheduling cannot run it, and leave its conversation and saved files intact.
    const changed = await repo.updateWorkflowConditional(w.id, wfStatus, {
      status: 'paused', stop_reason: 'awaiting_message', updated_at: now(),
    });
    if (!changed) {
      sendJson(res, 409, { error: 'Session changed while reopening. Reload and try again.' });
      return;
    }
    if (w.project_id) {
      emit(w.project_id, { type: 'workflow.updated', workflowId: w.id, status: 'paused' });
    }
    sendJson(res, 200, { ok: true, ready: true, alreadyRunning: false, runId: null, run: null });
  });

  // POST /api/projects/:id/workflows/:wid/message
  router.post('/api/projects/:id/workflows/:wid/message', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const repo = getSessionsRepository();
    const w = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    let message = str(body.message, 'message', { max: 10_000, optional: true }).trim();
    // A demo session answers any "/..." itself. Elsewhere only "/name" is a command: "/src/app.ts fails" is a message.
    const looksLikeCommand = (text: string): boolean => (w.engine === 'demo' ? text.startsWith('/') : parseSlashCommand(text) !== null);
    if (looksLikeCommand(message) && Array.isArray(body.attachmentIds) && body.attachmentIds.length) {
      sendJson(res, 400, { error: 'Send attachments with a message, not a slash command' }); return;
    }
    const attachments = await saveChatAttachments(req.params.id, w.id, body.attachmentIds);
    if (!message && attachments.length) message = 'Please read the attached files.';
    if (!message) { sendJson(res, 400, { error: 'Message must not be empty' }); return; }

    let isCommand = looksLikeCommand(message);
    // The prompt a command becomes (/init, /review, the owner's commands and skills). The chat keeps what was typed.
    let commandPrompt: { name: string; source: string; prompt: string } | null = null;
    const ts = now();

    // Commands the portal answers itself (/model, /agent, /cost, ...) and commands this session does not have.
    // The command and its answer are saved as one event and nothing is sent to the engine.
    if (isCommand && w.engine !== 'demo' && message.toLowerCase().trim() !== '/clear') {
      let answer = await runPortalCommand(w, message, req.user!.id);
      if (answer === null) {
        const resolved = await resolveSessionCommand(w, message);
        if (resolved?.type === 'unknown') answer = unknownCommandText(resolved.name, String(w.engine));
        else if (resolved?.type === 'prompt') {
          // A request to the agent like any message: shown as typed, it resumes a paused session and is in recaps.
          isCommand = false;
          commandPrompt = { name: resolved.name, source: resolved.source, prompt: resolved.prompt };
        }
      }
      if (answer !== null) {
        await repo.appendWorkflowEvent({
          workflow_id: w.id,
          kind: 'command-result',
          body: `${message}\n---\n${answer}`,
          data: JSON.stringify({ command: message, by: req.user!.id }),
          created_at: ts,
        });
        if (w.project_id) {
          emit(w.project_id, { type: 'workflow.command-result', workflowId: w.id, command: message, result: answer });
          emit(w.project_id, { type: 'workflow.updated', workflowId: w.id });
        }
        sendJson(res, 200, { ok: true, kind: 'command', resumed: false, handled: true });
        return;
      }
    }

    const kind = isCommand ? 'command' : 'human';
    await repo.appendWorkflowEvent({
      workflow_id: w.id,
      kind,
      body: message,
      data: JSON.stringify({
        by: req.user!.id,
        ...(attachments.length ? { attachments } : {}),
        // What the run gives the agent for this message (runner.ts, eventPrompt).
        ...(commandPrompt ? { command: commandPrompt.name, commandSource: commandPrompt.source, prompt: commandPrompt.prompt } : {}),
      }),
      created_at: ts,
    });

    // For demo-engine slash commands, immediately process and record result event
    if (isCommand && w.engine === 'demo') {
      const cmdResult = processDemoSlashCommand(message);
      await repo.appendWorkflowEvent({
        workflow_id: w.id,
        kind: 'command-result',
        body: cmdResult,
        data: JSON.stringify({ command: message, by: req.user!.id }),
        created_at: now(),
      });
      if (w.project_id) {
        emit(w.project_id, { type: 'workflow.command-result', workflowId: w.id, command: message, result: cmdResult });
      }
    }

    // For kiro/claude-code engines, /clear is handled server-side
    if (isCommand && message.toLowerCase().trim() === '/clear' && w.engine !== 'demo') {
      await repo.markAllWorkflowEventsConsumed(w.id);
      await repo.updateWorkflow(w.id, { engine_session_id: null, engine_session_engine: null, updated_at: ts });
    }

    // Track last user interaction (resets idle timer)
    await repo.updateWorkflow(w.id, { last_turn_at: ts, stop_reason: '', updated_at: ts });

    if (w.project_id) {
      emit(w.project_id, {
        type: isCommand ? 'workflow.command' : 'workflow.message',
        workflowId: w.id,
        body: message,
        by: req.user!.id,
      });
    }

    // Resume idle-stopped (paused) sessions when a HUMAN message arrives
    let resumed = false;
    if (w.status === 'paused' && !isCommand) {
      const hasActive = await repo.getActiveRun(w.id);
      if (!hasActive) {
        try {
          // Re-acquire delegation slot if this is a child being resumed (idempotent).
          if (w.parent_id && w.created_by) {
            const dlgSettings = await getDelegationSettingsRepository().get();
            await repo.acquireChildDelegationSlot(
              w.id,
              w.parent_id,
              String(w.created_by),
              dlgSettings.maxRunningPerParent,
              dlgSettings.maxRunningPerUser,
            );
          }
          await startRun(w.id);
          resumed = true;
        } catch { /* non-fatal — auto-resume failure doesn't block the message ack */ }
      }
    }

    sendJson(res, 200, { ok: true, kind, resumed });
  });

  // GET /api/slash-commands — the commands the portal answers itself
  router.get('/api/slash-commands', async (_req: PortalRequest, res: PortalResponse): Promise<void> => {
    sendJson(res, 200, { commands: PORTAL_COMMANDS });
  });

  // GET /api/projects/:id/workflows/:wid/commands — the chat box's menu: the portal's commands, /init and /review,
  // and the session owner's own commands and skills for its engine
  router.get('/api/projects/:id/workflows/:wid/commands', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = await getSessionsRepository().getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }
    sendJson(res, 200, { commands: await sessionCommands(w) });
  });

  // PATCH /api/projects/:id/workflows/:wid — update session settings
  router.patch('/api/projects/:id/workflows/:wid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const repo = getSessionsRepository();
    const w = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;

    const hasTitle       = body.title !== undefined;
    const hasGoal        = body.goal !== undefined;
    const hasTrustTools  = body.trustTools !== undefined;
    const hasMaxIter     = body.maxIterations !== undefined;
    const hasRepoIds     = body.repoIds !== undefined;
    const hasIntegrationIds = body.integrationIds !== undefined;

    if (!hasTitle && !hasGoal && !hasTrustTools && !hasMaxIter && !hasRepoIds && !hasIntegrationIds) {
      sendJson(res, 400, { error: 'Provide at least one of: title, goal, trustTools, maxIterations, repoIds, integrationIds' });
      return;
    }

    const patch: Partial<WorkflowRecord> = {};
    let title: string | undefined;

    if (hasTitle) {
      title = str(body.title as string, 'title', { max: 200, optional: true }).trim();
      patch.title = title;
    }
    if (hasGoal) {
      patch.goal = str(body.goal as string, 'goal', { max: GOAL_MAX_CHARS, optional: true }).trim();
      patch.initial_goal = w.initial_goal ?? w.goal;
    }
    if (hasTrustTools) {
      // A session runs with its creator's identity, budget and vault, so only the creator can take the human check away
      // from it, and never an API token. Anyone with edit access may turn it off.
      if (body.trustTools && Number((w as unknown as Row).trust_tools ?? 0) !== 1) {
        if (req.authViaToken) {
          sendJson(res, 403, { error: 'API tokens cannot turn on "trust all tools". Do this from a signed-in browser.' });
          return;
        }
        if (w.created_by && String(w.created_by) !== req.user!.id) {
          sendJson(res, 403, { error: 'Only the person who started this session can turn on "trust all tools": the session runs as them.' });
          return;
        }
      }
      patch.trust_tools = body.trustTools ? 1 : 0;
    }
    if (hasMaxIter) {
      patch.max_iterations = int(body.maxIterations, 'maxIterations', 10, 1, 100);
    }
    if (hasRepoIds) {
      // The repositories the agent gets as context. Only this portal project's own repositories are accepted.
      if (!Array.isArray(body.repoIds) || body.repoIds.length > 10) throw badRequest('repoIds must be a list of at most 10 repository ids');
      const wanted = [...new Set(body.repoIds.map(String))];
      const projectRepos = await getGitReposRepository().listByProject(req.params.id);
      const valid = new Set(projectRepos.map((r) => String(r.id)));
      const bad = wanted.filter((rid) => !valid.has(rid));
      if (bad.length) throw badRequest('Some repositories do not belong to this project');
      patch.repo_ids = JSON.stringify(wanted);
    }
    if (hasIntegrationIds) {
      // The MCP integrations this session gets. null = whatever the project has enabled; a list = only those.
      if (body.integrationIds === null) {
        patch.integrations = encodeSessionIntegrations(null);
      } else {
        if (!Array.isArray(body.integrationIds) || body.integrationIds.length > 20) throw badRequest('integrationIds must be null or a list of at most 20 integration ids');
        const wanted = [...new Set(body.integrationIds.map(String))];
        const mine = (await getIntegrationsRepository().listByProject(req.params.id)).filter((i) => i.type === 'http');
        const usable = new Set(mine.filter((i) => !integrationIsPersonal(i) || i.created_by === req.user!.id).map((i) => i.id));
        if (wanted.some((id) => !usable.has(id))) throw badRequest('Some integrations do not belong to this project');
        patch.integrations = encodeSessionIntegrations(wanted);
      }
    }

    const ts = now();
    patch.updated_at = ts;

    await repo.updateWorkflow(w.id, patch);

    if (hasGoal && patch.goal !== w.goal) {
      // Keep an explicit instruction in the pending transcript as well: a resumed
      // session otherwise uses its pending messages instead of workflow.goal.
      const body = patch.goal ? `Session goal updated:\n${patch.goal}` : 'Session goal cleared. Follow the current request without the previous overarching goal.';
      await repo.appendWorkflowEvent({ workflow_id: w.id, kind: 'human', body, data: JSON.stringify({ by: req.user!.id, setting: 'goal' }), created_at: ts });
      if (w.project_id) emit(w.project_id, { type: 'workflow.message', workflowId: w.id, body, by: req.user!.id });
    }

    if (title !== undefined) {
      appendAudit(
        getDb(),
        req.user!.id,
        'session.rename',
        `workflow:${w.id}`,
        { title },
        req.ip,
      );
      if (w.project_id) {
        emit(w.project_id, { type: 'workflow.renamed', workflowId: w.id, title });
      }
    }

    if (w.project_id) {
      emit(w.project_id, { type: 'workflow.updated', workflowId: w.id });
    }

    if (hasRepoIds) await requestRepoPrep(w.id).catch((e) => console.error('[repo-prep] request failed:', e));

    const updated = await repo.getWorkflowById(w.id);
    const enriched = updated ? await enrichWorkflowRow(updated) : w;
    sendJson(res, 200, { workflow: workflowView(enriched) });
  });

  // POST /api/projects/:id/workflows/:wid/engine — continue the session with another engine
  //
  //   Body: { engine: 'claude-code'|'kiro'|'demo', credentialId?: string, model?: string, leadAgent?: string }
  //
  //   For when one provider can't go on (e.g. Kiro credits are used up). The session keeps its conversation,
  //   repositories and work folder; the stored engine session is dropped, so the next turn starts on the new
  //   engine with a recap of earlier turns. Not while a run is going. Only the person who started the session
  //   can switch it: the session runs as them, on their sign-ins.
  router.post('/api/projects/:id/workflows/:wid/engine', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const repo = getSessionsRepository();
    const w = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

    if (w.created_by && String(w.created_by) !== req.user!.id) {
      sendJson(res, 403, { error: 'Only the person who started this session can switch its engine: the session runs on their sign-ins.' });
      return;
    }
    if (w.status === 'running' || await repo.getActiveRun(w.id)) {
      sendJson(res, 409, { error: 'The session is running. Stop it, or wait for the turn to end, before switching engine.' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body.engine) throw badRequest('engine is required');
    const engine = validateEngine(body.engine);

    let credentialId: string | null = null;
    if (body.credentialId) {
      credentialId = str(body.credentialId as string, 'credentialId', { max: 200 });
      const owner = w.created_by ? String(w.created_by) : req.user!.id;
      if (!isBedrockRuntimeChoice(engine, credentialId)) {
        const cred = await getCredentialsRepository().getByIdAndUser(credentialId, owner);
        if (!cred) throw badRequest('Sign-in not found');
        if (cred.engine !== engine) throw badRequest(`That sign-in is for ${cred.engine}, not ${engine}`);
      }
    }

    let model = '';
    if (typeof body.model === 'string' && body.model.trim()) {
      model = body.model.trim();
      if (!MODEL_RE.test(model)) throw badRequest('model is not a valid model ID (allowed: A-Z a-z 0-9 . _ : / @ -)');
    }
    const leadAgent = typeof body.leadAgent === 'string' && body.leadAgent.trim()
      ? str(body.leadAgent, 'leadAgent', { max: 200 }).trim()
      : null;

    const fromEngine = String(w.engine || 'demo');
    const label = (e: string) => (e === 'claude-code' ? 'Claude Code' : e === 'kiro' ? 'Kiro' : e === 'demo' ? 'Demo' : e);
    const sameSetup = engine === fromEngine
      && (credentialId ?? null) === (w.credential_id ?? null)
      && model === String(w.model || '')
      && (leadAgent ?? null) === (w.lead_agent || null);
    if (sameSetup) throw badRequest('The session already runs with this engine, sign-in and model');

    // Cloud sessions: the old engine's machine saves its workspace now, so the new engine's machine restores the
    // latest files (including changes not committed). A failure does not stop the switch; it is said in the note.
    let workspaceNote = '';
    if (engine !== fromEngine && (safeJson(w.repo_ids, []) as unknown[]).length > 0) {
      const flushed = await flushWorkspaceViaRunner(w.id, fromEngine);
      if (!flushed.ok) workspaceNote = ` (${label(fromEngine)}'s latest files could not be saved: ${flushed.error}; the new engine starts from the last saved copy)`;
    }

    const ts = now();
    await repo.updateWorkflow(w.id, {
      engine,
      credential_id: credentialId,
      model,
      // Agents are defined per engine (.kiro or .claude), so one only carries over when it is chosen again.
      lead_agent: leadAgent,
      // The stored session belongs to the old engine; the new one starts fresh with a recap of earlier turns.
      engine_session_id: null,
      engine_session_engine: null,
      stop_reason: '',
      updated_at: ts,
    });

    const note = (engine === fromEngine
      ? `Switched ${label(engine)} sign-in or model`
      : `Switched engine from ${label(fromEngine)} to ${label(engine)}`) + workspaceNote;
    await repo.appendWorkflowEvent({
      workflow_id: w.id,
      kind: 'engine-switch',
      body: note,
      data: JSON.stringify({ from: fromEngine, to: engine, credentialId, model, leadAgent, by: req.user!.id }),
      created_at: ts,
    });
    appendAudit(getDb(), req.user!.id, 'session.engine-switch', `workflow:${w.id}`, { from: fromEngine, to: engine, credentialId, model }, req.ip);
    if (w.project_id) emit(w.project_id, { type: 'workflow.updated', workflowId: w.id });

    const updated = await repo.getWorkflowById(w.id);
    const enriched = updated ? await enrichWorkflowRow(updated) : w;
    sendJson(res, 200, { workflow: workflowView(enriched) });
  });

  // GET /api/projects/:id/workflows/:wid/repo-prep — how far getting the session's repositories ready has got
  router.get('/api/projects/:id/workflows/:wid/repo-prep', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = await getSessionsRepository().getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }
    sendJson(res, 200, { prep: getRepoPrep(w.id) });
  });

  // POST /api/projects/:id/workflows/:wid/repo-prep — try getting the session's repositories ready again (after the person
  // fixed a refused sign-in, for example updated the project's AWS keys)
  router.post('/api/projects/:id/workflows/:wid/repo-prep', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const w = await getSessionsRepository().getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!w) { sendJson(res, 404, { error: 'Workflow not found' }); return; }
    const current = getRepoPrep(w.id);
    if (current?.state === 'running' && Date.now() - new Date(current.at).getTime() < 17 * 60_000) {
      sendJson(res, 200, { prep: current, alreadyRunning: true });
      return;
    }
    await requestRepoPrep(w.id);
    sendJson(res, 202, { prep: getRepoPrep(w.id) });
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
  //   Cursor format (internal, opaque to clients):
  //     base64url( JSON({ ts: string, src: 'r'|'w', id: number }) )
  //   Sort order within a page: created_at DESC, src ASC ('r' before 'w'), id DESC
  router.get('/api/projects/:id/workflows/:wid/transcript', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await requireProjectMember(req, res, req.params.id);
    if (!project) return;
    const repo = getSessionsRepository();
    const wf = await repo.getWorkflowByProjectId(req.params.id, req.params.wid);
    if (!wf) { sendJson(res, 404, { error: 'Workflow not found' }); return; }

    const cursorStr = req.query.get('cursor');
    const limit = Math.min(int(req.query.get('limit'), 'limit', 100, 1, 200), 200);

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

    // Use repository to get the merged transcript (works in both SQLite and DynamoDB mode).
    const { rows, nextCursor: rawNextCursor } = await repo.listTranscript(wf.id, cursor, limit);

    // Compute the encoded next cursor.
    const nextCursor = rawNextCursor ? encodeCursor(rawNextCursor) : null;

    // Coalesce consecutive streamed assistant-text rows so each agent reply
    // is one event rather than O(stream-chunks) events.
    const coalescedRows = coalesceStreamedRows(rows);

    const events = coalescedRows.map((e) => ({
      src: e.src,
      id: e.id,
      kind: e.kind,
      payload: e.src === 'r' ? safeJson(e.body, {}) : e.body,
      run_id: e.run_id ?? null,
      created_at: e.created_at,
    }));

    sendJson(res, 200, { events, nextCursor });
  });
}

// ── Validation helpers ─────────────────────────────────────────────────────────

type Engine = 'claude-code' | 'kiro' | 'codex' | 'demo';
const VALID_ENGINES: Engine[] = ['claude-code', 'kiro', 'codex', 'demo'];

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
