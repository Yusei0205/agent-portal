/**
 * Idle time for each runner's AgentCore sessions.
 *
 * AgentCore sets its idle timeout on the whole runtime (15 minutes, fixed by the stack), not per session, and a session holds its
 * memory until then. This setting lets an admin stop a runner's sessions sooner: once a portal session has been idle (no turn
 * running) for the chosen minutes, the portal calls StopRuntimeSession. It can only shorten the platform timeout, never lengthen
 * it. A stopped session starts again on the next message: the workspace comes back from its saved snapshot, only the warm
 * machine (running terminal, installed tools) is lost.
 *
 *   GET /api/agentcore/idle   -> { platformMinutes, engines: [{ engine, label, minutes }] }   (admin)
 *   PUT /api/agentcore/idle   { engine, minutes: number | null }                              (admin)
 *
 * `sweepAgentCoreIdle` runs from the per-minute idle-stop job (session-lifecycle.ts), so it works in the cloud and locally.
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getDb } from './db.ts';
import { getSetting, setSetting } from './settings.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import { runtimeFor } from './agent/repo-prep.ts';
import { agentCoreSessionId } from './agent/agentcore-session.ts';
import { stopAgentCoreSession } from './agent/kiro-agentcore.ts';

/** The idle timeout the stack gives every runner runtime, in minutes. */
export const PLATFORM_IDLE_MINUTES = 15;
export const MAX_IDLE_MINUTES = 240;

export const IDLE_ENGINES = [
  { engine: 'claude-code', label: 'Claude' },
  { engine: 'kiro', label: 'Kiro' },
  { engine: 'codex', label: 'Codex' },
  { engine: 'cursor', label: 'Cursor' },
] as const;
type IdleEngine = (typeof IDLE_ENGINES)[number]['engine'];

const settingKey = (engine: string): string => `agentcore.idle_minutes.${engine}`;
const stoppedKey = (workflowId: string): string => `agentcore.idle_stopped.${workflowId}`;

/** Minutes the portal waits before stopping this engine's sessions: null means leave it to the platform timeout. */
export function getIdleMinutes(engine: string): number | null {
  const raw = getSetting(getDb(), settingKey(engine));
  if (raw === null || raw === '') return null;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_IDLE_MINUTES) : null;
}

/**
 * One pass: stop the AgentCore session of every portal session whose engine has a setting and that has been idle for that long.
 * Each idle period is stopped once (a marker holds the last_turn_at it was stopped for), so a session is not stopped again every
 * minute, and a new turn (a new last_turn_at) makes it eligible again. Returns how many sessions it stopped.
 */
export async function sweepAgentCoreIdle(nowMs = Date.now()): Promise<number> {
  const limits = IDLE_ENGINES.map((e) => ({ engine: e.engine as string, minutes: getIdleMinutes(e.engine) }))
    .filter((l): l is { engine: string; minutes: number } => l.minutes !== null);
  if (limits.length === 0) return 0;
  const shortest = Math.min(...limits.map((l) => l.minutes));
  const byEngine = new Map(limits.map((l) => [l.engine, l.minutes]));

  const idle = await getSessionsRepository().listIdleWorkflows(new Date(nowMs - shortest * 60_000).toISOString());
  let stopped = 0;
  for (const w of idle) {
    const engine = String(w.engine);
    const minutes = byEngine.get(engine);
    if (minutes === undefined) continue;
    const lastTurn = String(w.last_turn_at ?? '');
    if (!lastTurn || Date.parse(lastTurn) > nowMs - minutes * 60_000) continue;
    const wid = String(w.id);
    if (getSetting(getDb(), stoppedKey(wid)) === lastTurn) continue;
    const runtime = runtimeFor(engine);
    if (!runtime) continue;
    try {
      await stopAgentCoreSession(runtime.arn, agentCoreSessionId(wid, runtime.kind));
      await setSetting(getDb(), stoppedKey(wid), lastTurn);
      stopped++;
    } catch (e) {
      // Not fatal: the platform timeout still ends it. It is tried again on the next pass.
      console.error(`[agentcore-idle] could not stop the ${engine} session of ${wid}:`, e instanceof Error ? e.message : e);
    }
  }
  return stopped;
}

export function registerAgentCoreIdleRoutes(): void {
  router.get(
    '/api/agentcore/idle',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      if (!req.user?.is_admin) { sendJson(res, 403, { error: 'Admins only' }); return; }
      sendJson(res, 200, {
        platformMinutes: PLATFORM_IDLE_MINUTES,
        maxMinutes: MAX_IDLE_MINUTES,
        engines: IDLE_ENGINES.map((e) => ({ engine: e.engine, label: e.label, minutes: getIdleMinutes(e.engine) })),
      });
    }),
  );

  router.put(
    '/api/agentcore/idle',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      if (!req.user?.is_admin) { sendJson(res, 403, { error: 'Admins only' }); return; }
      const body = (req.body ?? {}) as { engine?: unknown; minutes?: unknown };
      const engine = String(body?.engine ?? '');
      if (!IDLE_ENGINES.some((e) => e.engine === (engine as IdleEngine))) { sendJson(res, 400, { error: 'Unknown runner' }); return; }
      const m = body.minutes;
      if (m !== null && (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m > MAX_IDLE_MINUTES)) {
        sendJson(res, 400, { error: `minutes must be a whole number from 0 to ${MAX_IDLE_MINUTES}, or null for the platform default` });
        return;
      }
      await setSetting(getDb(), settingKey(engine), m === null ? '' : String(m));
      sendJson(res, 200, { engine, minutes: m });
    }),
  );
}
