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
import { getMembership } from './project-access.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { now } from './util.ts';
import { emit } from './events.ts';
import { appendAudit } from './audit.ts';
import { checkDelegationChildIdleStop } from './delegation.ts';
import { getSessionBrowserState, shutdownSessionBrowser } from './agent/browser-manager.ts';
import { getSetting } from './settings.ts';
import { getSettingsRepository, _updateSnapshotKey } from './repositories/settings.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import { presignLiveViewUrl, setAutomationStream } from './browser-live-view.ts';

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
  const member = await getMembership(String(wf.project_id), req.user.id);
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
  const p = await getProjectRepository().getProjectById(projectId);
  if (!p) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (!req.user.is_admin) {
    const m = await getMembership(projectId, req.user.id);
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
  //     usageUnit: 'usd'|'credits',   — Kiro bills in credits, the other engines in dollars
  //     thisTurn: { costUsd: number, credits: number, inputTokens: number|null, outputTokens: number|null } | null,
  //     thisSession: { costUsd: number, credits: number, inputTokens: number|null, outputTokens: number|null }
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
            credits: latestRun.credits ?? 0,
            inputTokens: isKiro ? null : (latestRun.input_tokens ?? 0),
            outputTokens: isKiro ? null : (latestRun.output_tokens ?? 0),
          }
        : null;

      const thisSession = {
        costUsd: totals.total_cost,
        credits: totals.total_credits,
        inputTokens: isKiro ? null : totals.total_input,
        outputTokens: isKiro ? null : totals.total_output,
      };

      // How full the model's context window was at the last report of the session's runs.
      let contextPercent: number | null = null;
      try {
        const ctxEvents = await repo.listWorkflowRunEventsByType(wid, ['context-usage'], 50);
        const last = [...ctxEvents].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))[0];
        const pct = last ? Number((JSON.parse(String(last.payload ?? '{}')) as { percent?: unknown }).percent) : NaN;
        if (Number.isFinite(pct)) contextPercent = pct;
      } catch { /* the bar is optional */ }

      sendJson(res, 200, {
        agent: w.lead_agent ?? null,
        engine,
        // The model the next run uses (set by /model or the model chip), else the model of the last run.
        model: (typeof w.model === 'string' && w.model.trim()) || latestRun?.model || null,
        contextPercent,
        toolApprovalMode: w.trust_tools ? 'trust-all' : 'ask',
        usageUnit: isKiro ? 'credits' : 'usd',
        thisTurn,
        thisSession,
      });
    },
  );

  // ── Browser view ────────────────────────────────────────────────────────────
  //
  // GET /api/workflows/:wid/browser
  //
  // GET /api/workflows/:wid/browser/live-view
  // A short-lived signed URL for AgentCore Live View of the browser the agent is using right now (the page streams
  // it straight from AWS and can take over with mouse and keyboard). { available: false } when no browser is open.
  router.get(
    '/api/workflows/:wid/browser/live-view',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const wf = await requireWorkflowReadAccess(req, res, req.params.wid);
      if (!wf) return;
      const repo = getSessionsRepository();
      const active = await repo.getActiveRun(String(wf.id));
      const events = active ? await repo.listWorkflowRunEventsByType(String(wf.id), ['browser-session'], 500) : [];
      // The browser is closed when the run ends, so only a session announced during the current run can be watched.
      const since = String(active?.started_at ?? active?.created_at ?? '');
      const latest = [...events].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).find((e) => String(e.created_at) >= since);
      if (!latest) { sendJson(res, 200, { available: false }); return; }
      let info: { browserId?: string; sessionId?: string; width?: number; height?: number } = {};
      try { info = JSON.parse(latest.payload ?? '{}'); } catch { /* none */ }
      if (!info.sessionId) { sendJson(res, 200, { available: false }); return; }
      try {
        const url = await presignLiveViewUrl(info.browserId || 'aws.browser.v1', info.sessionId, 300);
        sendJson(res, 200, { available: true, url, sessionId: info.sessionId, width: info.width || 1280, height: info.height || 800, expiresIn: 300 });
      } catch (e: unknown) {
        console.error('[browser] live-view signing failed:', e);
        sendJson(res, 200, { available: false, error: 'Could not sign the live view address' });
      }
    },
  );

  // POST /api/workflows/:wid/browser/live-view/control  { enabled: boolean }
  // Take over (enabled=true: the agent's browser commands are paused) or hand control back to the agent.
  router.post(
    '/api/workflows/:wid/browser/live-view/control',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const wf = await requireWorkflowReadAccess(req, res, req.params.wid);
      if (!wf) return;
      if (req.authViaToken) { sendJson(res, 403, { error: 'This endpoint requires browser authentication, not an API token' }); return; }
      if (!req.user?.is_admin) {
        const member = wf.project_id ? await getMembership(String(wf.project_id), req.user!.id) : null;
        const ok = wf.project_id ? ['editor', 'owner'].includes(String(member?.access ?? '')) : String(wf.created_by ?? '') === req.user!.id;
        if (!ok) { sendJson(res, 403, { error: 'Project editor access required' }); return; }
      }
      const takeOver = Boolean((req.body as Record<string, unknown> | undefined)?.enabled);
      const repo = getSessionsRepository();
      const active = await repo.getActiveRun(String(wf.id));
      const events = active ? await repo.listWorkflowRunEventsByType(String(wf.id), ['browser-session'], 500) : [];
      const since = String(active?.started_at ?? active?.created_at ?? '');
      const latest = [...events].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).find((e) => String(e.created_at) >= since);
      let info: { browserId?: string; sessionId?: string } = {};
      try { info = JSON.parse(latest?.payload ?? '{}'); } catch { /* none */ }
      if (!info.sessionId) {
        // Nothing to hand back when the browser is already closed; only taking over needs one.
        if (!takeOver) { sendJson(res, 200, { ok: true, enabled: false }); return; }
        sendJson(res, 409, { error: 'No cloud browser is open for this session' }); return;
      }
      try {
        await setAutomationStream(info.browserId || 'aws.browser.v1', info.sessionId, !takeOver);
        sendJson(res, 200, { ok: true, enabled: takeOver });
      } catch (e: unknown) {
        console.error('[browser] stream update failed:', e);
        sendJson(res, 502, { error: e instanceof Error ? e.message : 'Could not change browser control' });
      }
    },
  );

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
        id: string;
        parentId?: string;
        name: string;
        status: string;
        startedAt: string | null;
        finishedAt: string | null;
        source: 'event' | 'session';
        sessionId?: string;
        description?: string;
        summary?: string;
        depth?: number;
        tokens?: number;
        toolUses?: number;
        durationMs?: number;
      }> = [];

      const childSessions = await repo.listChildWorkflows(wid);

      for (const child of childSessions) {
        const finishedAt =
          ['done', 'failed', 'paused'].includes(child.status)
            ? child.updated_at
            : null;
        agents.push({
          id: child.id,
          parentId: wid,
          name: child.title || child.goal.slice(0, 60),
          description: child.goal.slice(0, 600),
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
      // DynamoDB sequences restart for each run; timestamps order resumed turns.
      const oldestFirst = [...agentEvents].sort((a, b) => a.created_at.localeCompare(b.created_at) || Number(a.id) - Number(b.id));
      // What a runner reports about a subagent, copied onto its row whenever an event carries it.
      const detailsOf = (payload: Record<string, unknown>): Partial<(typeof agents)[number]> => {
        const out: Partial<(typeof agents)[number]> = {};
        if (typeof payload.description === 'string' && payload.description) out.description = payload.description;
        if (typeof payload.summary === 'string' && payload.summary) out.summary = payload.summary;
        for (const k of ['depth', 'tokens', 'toolUses', 'durationMs'] as const) {
          if (typeof payload[k] === 'number' && Number.isFinite(payload[k])) out[k] = payload[k] as number;
        }
        return out;
      };
      for (const ev of oldestFirst) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(ev.payload ?? '{}');
        } catch {
          continue;
        }
        const name = String(payload.name ?? payload.agentName ?? 'subagent');
        // Engines that report a task id (the AgentCore runner) get one row per subagent run.
        // A task id is unique within one run, so the row id carries the run (Codex ids are already unique).
        const rowId = (taskId: string): string => (payload.engine === 'codex' ? taskId : `${ev.run_id ?? ''}:${taskId}`);
        const key = typeof payload.id === 'string' && payload.id ? rowId(payload.id) : name;
        // The parent is named by the same row id, or the graph could not find it and would hang the agent off the session.
        const identity = { id: key, ...(typeof payload.parentId === 'string' && payload.parentId ? { parentId: rowId(payload.parentId) } : {}) };

        if (ev.type === 'subagent-started') {
          eventMap.set(key, {
            ...eventMap.get(key),
            ...identity,
            name,
            status: payload.status === 'pending' ? 'pending' : 'running',
            startedAt: String(ev.created_at),
            finishedAt: null,
            source: 'event',
            ...detailsOf(payload),
          });
        } else if (ev.type === 'subagent-finished') {
          const existing = eventMap.get(key);
          if (existing) {
            existing.status = 'done';
            existing.finishedAt = String(ev.created_at);
            Object.assign(existing, detailsOf(payload));
          } else {
            eventMap.set(key, {
              ...identity,
              name,
              status: 'done',
              startedAt: null,
              finishedAt: String(ev.created_at),
              source: 'event',
              ...detailsOf(payload),
            });
          }
        } else if (ev.type === 'subagent-failed') {
          const existing = eventMap.get(key);
          if (existing) {
            existing.status = payload.status === 'stopped' ? 'stopped' : 'failed';
            existing.finishedAt = String(ev.created_at);
            Object.assign(existing, detailsOf(payload));
          } else {
            eventMap.set(key, {
              ...identity,
              name,
              status: payload.status === 'stopped' ? 'stopped' : 'failed',
              startedAt: null,
              finishedAt: String(ev.created_at),
              source: 'event',
              ...detailsOf(payload),
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
