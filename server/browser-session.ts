/**
 * The cloud browser of a session.
 *
 * A session's browser stays open between turns (the runner only disconnects when a turn ends) so a person can keep using it, and the
 * next turn reconnects to it. It ends after BROWSER_LIFETIME_MS (set when it is started), when the person closes it, or when the session
 * is deleted. The runner announces every browser session it starts or reconnects to as a `browser-session` event; the newest one is the
 * session's browser, and AgentCore says whether it is still open.
 */
import { getSessionsRepository } from './repositories/sessions.ts';
import { browserSessionStatus, stopBrowserSession } from './browser-live-view.ts';

/** The AgentCore calls, replaceable in a test. */
export const deps = { status: browserSessionStatus, stop: stopBrowserSession };

/** How long a session's browser may stay open (the runner starts it with this lifetime). */
export const BROWSER_LIFETIME_MS = 60 * 60_000;

export interface SessionBrowser { browserId: string; sessionId: string; width: number; height: number; announcedAt: string }

/** The browser session the newest `browser-session` event of this session names, or null. Whether it is still open is not checked. */
export async function latestBrowserSession(workflowId: string): Promise<SessionBrowser | null> {
  const events = await getSessionsRepository().listWorkflowRunEventsByType(workflowId, ['browser-session'], 500);
  const latest = [...events].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))[0];
  if (!latest) return null;
  let info: { browserId?: string; sessionId?: string; width?: number; height?: number } = {};
  try { info = JSON.parse(latest.payload ?? '{}'); } catch { return null; }
  if (!info.sessionId) return null;
  return { browserId: info.browserId || 'aws.browser.v1', sessionId: info.sessionId, width: info.width || 1280, height: info.height || 800, announcedAt: String(latest.created_at) };
}

/** The session's browser when it is open right now (announced within its lifetime and READY at AgentCore), else null. */
export async function liveBrowserSession(workflowId: string): Promise<SessionBrowser | null> {
  const b = await latestBrowserSession(workflowId);
  if (!b) return null;
  if (Date.now() - Date.parse(b.announcedAt) > BROWSER_LIFETIME_MS + 60_000) return null;
  return (await deps.status(b.browserId, b.sessionId)) === 'READY' ? b : null;
}

/** The session id to reconnect to on the next turn: the last one announced while it can still be open. The runner checks it is READY. */
export async function resumableBrowserSession(workflowId: string): Promise<string | null> {
  const b = await latestBrowserSession(workflowId);
  if (!b || Date.now() - Date.parse(b.announcedAt) > BROWSER_LIFETIME_MS - 5 * 60_000) return null;
  return b.sessionId;
}

/** Closes the session's browser if it is open. Never throws. */
export async function closeSessionBrowser(workflowId: string): Promise<boolean> {
  try {
    const b = await latestBrowserSession(workflowId);
    return b ? await deps.stop(b.browserId, b.sessionId) : false;
  } catch { return false; }
}
