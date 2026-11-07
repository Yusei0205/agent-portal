/**
 * Session lifecycle — F1 + F3 supplementary routes and background jobs.
 *
 * Routes:
 *   GET /api/projects/:id/workflows/:wid/status-bar   — agent, tokens, cost, mode
 *   GET /api/workflows/:wid/browser                   — last browser URL + screenshot
 *   GET /api/workflows/:wid/agents                    — in-process subagents activity
 *
 * Background job (exported):
 *   startIdleStopTimer()   — starts the periodic idle-session checker
 *   stopIdleStopTimer()    — stops it (tests / graceful shutdown)
 *   checkIdleSessions()    — runs one check pass (exported for tests)
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, run as dbRun, insert, getDb } from './db.ts';
import type { Row } from './db.ts';
import { now } from './util.ts';
import { emit } from './events.ts';
import { appendAudit } from './audit.ts';
import { checkDelegationChildIdleStop } from './delegation.ts';
import { getSessionBrowserState, shutdownSessionBrowser } from './agent/browser-manager.ts';
import { getSetting } from './settings.ts';
import { getSettingsRepository, _updateSnapshotKey } from './repositories/settings.ts';
import { getSessionsRepository } from './repositories/sessions.ts';

// ── Idle stop ─────────────────────────────────────────────────────────────────

const IDLE_MIN_DEFAULT = 30;
const IDLE_MIN_RANGE: [number, number] = [5, 240];
const IDLE_CHECK_INTERVAL_MS = 60_000; // check every minute

let _idleTimer: ReturnType<typeof setInterval> | null = null;

/** Read the configured idle timeout in minutes from settings. */
function getIdleTimeoutMinutes(): number {
  try {
    const val = getSetting(getDb(), 'session.idle_timeout_minutes');
    if (!val) return IDLE_MIN_DEFAULT;
    const v = parseInt(val, 10);
    if (!Number.isFinite(v)) return IDLE_MIN_DEFAULT;
    return Math.max(IDLE_MIN_RANGE[0], Math.min(IDLE_MIN_RANGE[1], v));
  } catch {
    return IDLE_MIN_DEFAULT;
  }
}

/**
 * Check for sessions that have been inactive for longer than the configured
 * idle timeout and stop them. This function is safe to call repeatedly; it
 * only affects sessions whose status is 'done' or 'pending' (not running).
 *
 * Survives server restarts because last_turn_at is persisted in the DB.
 */
export async function checkIdleSessions(): Promise<void> {
  try {
    const timeoutMinutes = getIdleTimeoutMinutes();
    const cutoff = new Date(Date.now() - timeoutMinutes * 60_000).toISOString();

    const repo = getSessionsRepository();
    const idleSessions = await repo.listIdleWorkflows(cutoff);

    for (const session of idleSessions) {
      const wid = String(session.id);
      const projectId = session.project_id ? String(session.project_id) : null;

      // Conditionally update workflow status: only applies if the workflow is
      // still in the expected state (done or pending).  A concurrent resume or
      // manual change wins the race and this idle-stop is treated as a no-op.
      const updateTs = now();
      const applied = await repo.updateWorkflowConditional(wid, session.status, {
        status: 'paused',
        stop_reason: 'idle',
        updated_at: updateTs,
      }, { hintParentId: session.parent_id });

      if (!applied) {
        // Workflow status changed between listIdleWorkflows and now — skip.
        continue;
      }

      repo.appendWorkflowEvent({
        workflow_id: wid,
        kind: 'system',
        body: `Session stopped — idle for ${timeoutMinutes} minutes`,
        data: JSON.stringify({ reason: 'idle', timeoutMinutes }),
        created_at: updateTs,
      }).catch(() => {});

      appendAudit(
        getDb(),
        null,
        'session.idle-stop',
        `workflow:${wid}`,
        { timeoutMinutes },
        null,
      );

      shutdownSessionBrowser(wid).catch(() => {/* non-fatal */});

      if (projectId) {
        emit(projectId, { type: 'workflow.idle-stopped', workflowId: wid, timeoutMinutes });
        emit(projectId, { type: 'workflow.updated', workflowId: wid, status: 'paused' });
      }
    }

    checkDelegationChildIdleStop();
  } catch (e: unknown) {
    console.error('[idle-stop] Error during idle check:', e);
  }
}

/** Start the periodic idle-session checker. Safe to call multiple times. */
export function startIdleStopTimer(): void {
  if (_idleTimer) return;
  _idleTimer = setInterval(() => { checkIdleSessions().catch((e) => console.error('[idle-stop] Error:', e)); }, IDLE_CHECK_INTERVAL_MS);
  _idleTimer.unref();
}

/** Stop the periodic idle-session checker (for tests / graceful shutdown). */
export function stopIdleStopTimer(): void {
  if (_idleTimer) {
    clearInterval(_idleTimer);
    _idleTimer = null;
  }
}

// ── Access helpers ─────────────────────────────────────────────────────────────

/** Returns the workflow row after access check, or null (response already sent). */
async function requireWorkflowReadAccess(
  req: PortalRequest,
  res: PortalResponse,
  workflowId: string,
): Promise<import('./repositories/sessions.ts').WorkflowRecord | null> {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const repo = getSessionsRepository();
  const wf = await repo.getWorkflowById(workflowId);
  if (!wf) {
    sendJson(res, 404, { error: 'Session not found' });
    return null;
  }
  if (req.user.is_admin) return wf;
  if (!wf.project_id) {
    // Project-less workflow: only the creator can access (gap 10)
    if (String(wf.created_by ?? '') === req.user.id) return wf;
    sendJson(res, 403, { error: 'Not authorized to access this session' });
    return null;
  }
  const member = one<Row>(
    'SELECT access FROM project_members WHERE project_id = ? AND user_id = ?',
    wf.project_id,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 403, { error: 'Not a project member' });
    return null;
  }
  return wf;
}

/** Require the user to be a member of the project that owns the workflow. */
async function requireProjectAndWorkflow(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
  workflowId: string,
): Promise<import('./repositories/sessions.ts').WorkflowRecord | null> {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const p = one<Row>('SELECT * FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!p) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (!req.user.is_admin) {
    const m = one<Row>(
      'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
      projectId,
      req.user.id,
    );
    if (!m) {
      sendJson(res, 404, { error: 'Project not found' });
      return null;
    }
  }
  const repo = getSessionsRepository();
  const w = await repo.getWorkflowByProjectId(projectId, workflowId);
  if (!w) {
    sendJson(res, 404, { error: 'Session not found' });
    return null;
  }
  return w;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerSessionLifecycleRoutes(): void {

  // ── Status bar ─────────────────────────────────────────────────────────────
  //
  // GET /api/projects/:id/workflows/:wid/status-bar
  //
  // Response:
  //   {
  //     agent: string|null, engine: string, model: string|null,
  //     toolApprovalMode: 'trust-all'|'ask',
  //     thisTurn: { costUsd: number, inputTokens: number|null, outputTokens: number|null } | null,
  //     thisSession: { costUsd: number, inputTokens: number|null, outputTokens: number|null }
  //   }
  router.get(
    '/api/projects/:id/workflows/:wid/status-bar',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const w = await requireProjectAndWorkflow(req, res, req.params.id, req.params.wid);
      if (!w) return;

      const engine = String(w.engine ?? 'demo');
      const isKiro = engine === 'kiro';

      const repo = getSessionsRepository();
      const wid = String(w.id);

      const latestRun = await repo.getLatestRun(wid);
      const totals = await repo.getRunTotals(wid);

      const thisTurn = latestRun
        ? {
            costUsd: latestRun.cost_usd ?? 0,
            inputTokens: isKiro ? null : (latestRun.input_tokens ?? 0),
            outputTokens: isKiro ? null : (latestRun.output_tokens ?? 0),
          }
        : null;

      const thisSession = {
        costUsd: totals.total_cost,
        inputTokens: isKiro ? null : totals.total_input,
        outputTokens: isKiro ? null : totals.total_output,
      };

      sendJson(res, 200, {
        agent: w.lead_agent ?? null,
        engine,
        model: latestRun?.model ?? null,
        toolApprovalMode: w.trust_tools ? 'trust-all' : 'ask',
        thisTurn,
        thisSession,
      });
    },
  );

  // ── Browser view ────────────────────────────────────────────────────────────
  //
  // GET /api/workflows/:wid/browser
  //
  // Returns what the agent's browser tool last opened: most recent URL and
  // screenshot (base64 PNG) found in run events.  Returns empty when none.
  //
  // Response:
  //   { url: string|null, screenshotBase64: string|null, recordedAt: string|null }
  router.get(
    '/api/workflows/:wid/browser',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const wf = await requireWorkflowReadAccess(req, res, req.params.wid);
      if (!wf) return;

      const repo = getSessionsRepository();
      const events = await repo.listWorkflowRunEventsByType(
        String(wf.id),
        ['tool-start', 'tool-end', 'assistant-text', 'browser-navigate', 'browser-screenshot'],
        200,
      );

      let lastUrl: string | null = null;
      let lastScreenshot: string | null = null;
      let recordedAt: string | null = null;

      for (const ev of events) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(ev.payload ?? '{}');
        } catch {
          continue;
        }

        // Explicit browser screenshot event
        if (ev.type === 'browser-screenshot' && payload.screenshotBase64) {
          if (!lastScreenshot) {
            lastScreenshot = String(payload.screenshotBase64);
            recordedAt = String(ev.created_at);
          }
        }

        // Explicit browser navigate event
        if (ev.type === 'browser-navigate' && payload.url) {
          if (!lastUrl) {
            lastUrl = String(payload.url);
            if (!recordedAt) recordedAt = String(ev.created_at);
          }
        }

        // Also check tool-start/tool-end for browser tool names
        if ((ev.type === 'tool-start' || ev.type === 'tool-end')) {
          const toolName = String(payload.toolName ?? '').toLowerCase();
          if (toolName.includes('navigate') || toolName.includes('browser')) {
            const toolInput = payload.toolInput ?? payload.input ?? '';
            const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
            if (!lastUrl && inputStr) {
              // Try to extract URL from tool input
              try {
                const parsed = JSON.parse(inputStr);
                const urlVal = parsed.url ?? parsed.URL ?? parsed.href;
                if (urlVal && typeof urlVal === 'string') {
                  lastUrl = urlVal;
                  if (!recordedAt) recordedAt = String(ev.created_at);
                }
              } catch {
                // Not JSON — ignore
              }
            }
            const output = String(payload.output ?? '');
            // Screenshots in tool output are base64 PNG
            if (!lastScreenshot && output.startsWith('iVBOR')) {
              lastScreenshot = output;
              if (!recordedAt) recordedAt = String(ev.created_at);
            }
          }
        }

        if (lastUrl && lastScreenshot) break;
      }

      // Prefer the live manager frame over event-sourced screenshot
      const liveBrowser = getSessionBrowserState(String(wf.id));
      if (liveBrowser?.latestFrame) {
        const lf = liveBrowser.latestFrame;
        if (!lastScreenshot) lastScreenshot = lf.dataBase64;
        if (!lastUrl) lastUrl = lf.url || null;
        if (!recordedAt) recordedAt = new Date(lf.ts).toISOString();
      }

      sendJson(res, 200, {
        url: lastUrl,
        screenshotBase64: lastScreenshot,
        recordedAt,
        sessionBrowser: liveBrowser
          ? { running: true, control: liveBrowser.controlEnabled }
          : { running: false, control: false },
      });
    },
  );

  // ── Agents activity ─────────────────────────────────────────────────────────
  //
  // GET /api/workflows/:wid/agents
  //
  // Lists in-process subagents seen in run events, plus any delegated child
  // sessions (F7, future).  Currently returns subagent events from p6_events.
  //
  // Response:
  //   { agents: [ { name, status, startedAt, finishedAt, source } ] }
  //   source: 'event'   — extracted from a subagent-* run event
  //           'session' — a child p6_workflow (F7)
  router.get(
    '/api/workflows/:wid/agents',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const wf = await requireWorkflowReadAccess(req, res, req.params.wid);
      if (!wf) return;

      const repo = getSessionsRepository();
      const wid = String(wf.id);

      const agents: Array<{
        name: string;
        status: string;
        startedAt: string | null;
        finishedAt: string | null;
        source: 'event' | 'session';
        sessionId?: string;
        description?: string;
      }> = [];

      const childSessions = await repo.listChildWorkflows(wid);

      for (const child of childSessions) {
        const finishedAt =
          ['done', 'failed', 'paused'].includes(child.status)
            ? child.updated_at
            : null;
        agents.push({
          name: child.title || child.goal.slice(0, 60),
          status: child.status,
          startedAt: child.created_at,
          finishedAt,
          source: 'session',
          sessionId: child.id,
        });
      }

      const agentEvents = await repo.listWorkflowRunEventsByType(
        wid,
        ['subagent-started', 'subagent-finished', 'subagent-failed'],
        1000,
      );

      const eventMap = new Map<string, (typeof agents)[number]>();
      // The repository returns newest first; replay oldest first so a finish follows its start.
      const oldestFirst = [...agentEvents].sort((a, b) => Number(a.id) - Number(b.id));
      for (const ev of oldestFirst) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(ev.payload ?? '{}');
        } catch {
          continue;
        }
        const name = String(payload.name ?? payload.agentName ?? 'subagent');
        // Engines that report a task id (the AgentCore runner) get one row per subagent run.
        const key = typeof payload.id === 'string' && payload.id ? `${ev.run_id ?? ''}:${payload.id}` : name;

        if (ev.type === 'subagent-started') {
          eventMap.set(key, {
            name,
            status: 'running',
            startedAt: String(ev.created_at),
            finishedAt: null,
            source: 'event',
            ...(typeof payload.description === 'string' && payload.description ? { description: payload.description } : {}),
          });
        } else if (ev.type === 'subagent-finished') {
          const existing = eventMap.get(key);
          if (existing) {
            existing.status = 'done';
            existing.finishedAt = String(ev.created_at);
          } else {
            eventMap.set(key, {
              name,
              status: 'done',
              startedAt: null,
              finishedAt: String(ev.created_at),
              source: 'event',
            });
          }
        } else if (ev.type === 'subagent-failed') {
          const existing = eventMap.get(key);
          if (existing) {
            existing.status = 'failed';
            existing.finishedAt = String(ev.created_at);
          } else {
            eventMap.set(key, {
              name,
              status: 'failed',
              startedAt: null,
              finishedAt: String(ev.created_at),
              source: 'event',
            });
          }
        }
      }

      agents.push(...eventMap.values());

      sendJson(res, 200, { agents });
    },
  );

  // ── Admin idle-timeout setting ─────────────────────────────────────────────
  //
  // GET  /api/admin/session/idle-timeout
  // PUT  /api/admin/session/idle-timeout
  router.get(
    '/api/admin/session/idle-timeout',
    (req: PortalRequest, res: PortalResponse): void => {
      if (!req.user?.is_admin) {
        sendJson(res, 403, { error: 'Admin access required' });
        return;
      }
      sendJson(res, 200, { minutes: getIdleTimeoutMinutes() });
    },
  );

  router.put(
    '/api/admin/session/idle-timeout',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!req.user?.is_admin) {
        sendJson(res, 403, { error: 'Admin access required' });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const raw = Number(body.minutes);
      if (!Number.isFinite(raw)) {
        sendJson(res, 400, { error: 'minutes must be a number' });
        return;
      }
      const minutes = Math.max(IDLE_MIN_RANGE[0], Math.min(IDLE_MIN_RANGE[1], Math.round(raw)));
      const repo = getSettingsRepository();
      if (repo) {
        await repo.setKey('session.idle_timeout_minutes', String(minutes));
        _updateSnapshotKey('session.idle_timeout_minutes', String(minutes));
      } else {
        const db = getDb();
        db.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run('session.idle_timeout_minutes', String(minutes));
      }

      appendAudit(
        getDb(),
        req.user!.id,
        'admin.session.idle-timeout',
        null,
        { minutes },
        req.ip,
      );

      sendJson(res, 200, { minutes });
    },
  );
}
