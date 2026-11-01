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
import { one, all, run as dbRun, insert, getDb } from './db.ts';
import type { Row } from './db.ts';
import { now } from './util.ts';
import { emit } from './events.ts';
import { appendAudit } from './audit.ts';
import { checkDelegationChildIdleStop } from './delegation.ts';
import { getSessionBrowserState, shutdownSessionBrowser } from './agent/browser-manager.ts';
import { getSetting } from './settings.ts';
import { getSettingsRepository, _updateSnapshotKey } from './repositories/settings.ts';

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
export function checkIdleSessions(): void {
  try {
    const timeoutMinutes = getIdleTimeoutMinutes();
    const cutoff = new Date(Date.now() - timeoutMinutes * 60_000).toISOString();

    const idleSessions = all<Row>(
      `SELECT id, project_id FROM p6_workflows
        WHERE status IN ('done', 'pending')
          AND last_turn_at IS NOT NULL
          AND last_turn_at < ?
          AND stop_reason = ''`,
      cutoff,
    );

    for (const session of idleSessions) {
      const wid = String(session.id);
      const projectId = session.project_id ? String(session.project_id) : null;

      dbRun(
        `UPDATE p6_workflows
            SET status = 'paused', stop_reason = 'idle', updated_at = ?
          WHERE id = ?`,
        now(),
        wid,
      );

      insert('p6_workflow_events', {
        workflow_id: wid,
        kind: 'system',
        body: `Session stopped — idle for ${timeoutMinutes} minutes`,
        data: JSON.stringify({ reason: 'idle', timeoutMinutes }),
        created_at: now(),
      });

      appendAudit(
        getDb(),
        null,
        'session.idle-stop',
        `workflow:${wid}`,
        { timeoutMinutes },
        null,
      );

      // Shut down the live browser for this session (fire-and-forget)
      shutdownSessionBrowser(wid).catch(() => {/* non-fatal */});

      if (projectId) {
        emit(projectId, {
          type: 'workflow.idle-stopped',
          workflowId: wid,
          timeoutMinutes,
        });
        emit(projectId, { type: 'workflow.updated', workflowId: wid, status: 'paused' });
      }
    }

    // Also check child session idle stop (F7)
    checkDelegationChildIdleStop();
  } catch (e: unknown) {
    // Idle check errors must not crash the server
    console.error('[idle-stop] Error during idle check:', e);
  }
}

/** Start the periodic idle-session checker. Safe to call multiple times. */
export function startIdleStopTimer(): void {
  if (_idleTimer) return;
  _idleTimer = setInterval(checkIdleSessions, IDLE_CHECK_INTERVAL_MS);
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
function requireWorkflowReadAccess(
  req: PortalRequest,
  res: PortalResponse,
  workflowId: string,
): Row | null {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const wf = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', workflowId);
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
    String(wf.project_id),
    req.user.id,
  );
  if (!member) {
    sendJson(res, 403, { error: 'Not a project member' });
    return null;
  }
  return wf;
}

/** Require the user to be a member of the project that owns the workflow. */
function requireProjectAndWorkflow(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
  workflowId: string,
): Row | null {
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
  const w = one<Row>(
    'SELECT * FROM p6_workflows WHERE id = ? AND project_id = ?',
    workflowId,
    projectId,
  );
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
    (req: PortalRequest, res: PortalResponse): void => {
      const w = requireProjectAndWorkflow(req, res, req.params.id, req.params.wid);
      if (!w) return;

      const engine = String(w.engine ?? 'demo');
      const isKiro = engine === 'kiro';

      // Latest run (this turn)
      const latestRun = one<Row>(
        `SELECT * FROM p6_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1`,
        String(w.id),
      );

      // Session totals
      const totals = one<{ total_cost: number; total_input: number; total_output: number }>(
        `SELECT
           COALESCE(SUM(cost_usd), 0)        AS total_cost,
           COALESCE(SUM(input_tokens), 0)    AS total_input,
           COALESCE(SUM(output_tokens), 0)   AS total_output
         FROM p6_runs WHERE workflow_id = ?`,
        String(w.id),
      );

      const thisTurn = latestRun
        ? {
            costUsd: Number(latestRun.cost_usd ?? 0),
            // Kiro reports credits not tokens; surface as null so UI renders 'not reported'
            inputTokens: isKiro ? null : Number(latestRun.input_tokens ?? 0),
            outputTokens: isKiro ? null : Number(latestRun.output_tokens ?? 0),
          }
        : null;

      const thisSession = {
        costUsd: Number(totals?.total_cost ?? 0),
        inputTokens: isKiro ? null : Number(totals?.total_input ?? 0),
        outputTokens: isKiro ? null : Number(totals?.total_output ?? 0),
      };

      sendJson(res, 200, {
        agent: w.lead_agent ?? null,
        engine,
        model: latestRun ? (latestRun.model as string | null ?? null) : null,
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
    (req: PortalRequest, res: PortalResponse): void => {
      const wf = requireWorkflowReadAccess(req, res, req.params.wid);
      if (!wf) return;

      // Walk run events newest-first looking for navigate / screenshot events
      const events = all<Row>(
        `SELECT e.type, e.payload, e.created_at
           FROM p6_events e
           JOIN p6_runs r ON r.id = e.run_id
          WHERE r.workflow_id = ?
            AND e.type IN ('tool-start', 'tool-end', 'assistant-text', 'browser-navigate', 'browser-screenshot')
          ORDER BY e.id DESC
          LIMIT 200`,
        String(wf.id),
      );

      let lastUrl: string | null = null;
      let lastScreenshot: string | null = null;
      let recordedAt: string | null = null;

      for (const ev of events) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(String(ev.payload ?? '{}'));
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
    (req: PortalRequest, res: PortalResponse): void => {
      const wf = requireWorkflowReadAccess(req, res, req.params.wid);
      if (!wf) return;

      const agents: Array<{
        name: string;
        status: string;
        startedAt: string | null;
        finishedAt: string | null;
        source: 'event' | 'session';
        sessionId?: string;
      }> = [];

      // ── From child sessions (F7 delegated sessions) ──────────────────────
      const childSessions = all<Row>(
        `SELECT id, title, goal, status, created_at, updated_at
           FROM p6_workflows
          WHERE parent_id = ?
          ORDER BY created_at ASC`,
        String(wf.id),
      );

      for (const child of childSessions) {
        const finishedAt =
          ['done', 'failed', 'paused'].includes(String(child.status))
            ? String(child.updated_at)
            : null;

        agents.push({
          name: String(child.title || (child.goal as string).slice(0, 60)),
          status: String(child.status),
          startedAt: String(child.created_at),
          finishedAt,
          source: 'session',
          sessionId: String(child.id),
        });
      }

      // ── From run events (subagent-started / subagent-finished) ────────────
      const agentEvents = all<Row>(
        `SELECT e.type, e.payload, e.created_at
           FROM p6_events e
           JOIN p6_runs r ON r.id = e.run_id
          WHERE r.workflow_id = ?
            AND e.type IN ('subagent-started', 'subagent-finished', 'subagent-failed')
          ORDER BY e.id ASC`,
        String(wf.id),
      );

      const eventMap = new Map<string, (typeof agents)[number]>();
      for (const ev of agentEvents) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(String(ev.payload ?? '{}'));
        } catch {
          continue;
        }
        const name = String(payload.name ?? payload.agentName ?? 'subagent');
        const key = name;

        if (ev.type === 'subagent-started') {
          eventMap.set(key, {
            name,
            status: 'running',
            startedAt: String(ev.created_at),
            finishedAt: null,
            source: 'event',
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
