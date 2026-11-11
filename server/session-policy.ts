/**
 * How long a browser sign-in lasts.
 *   - Idle: a session ends after PORTAL_SESSION_IDLE_MINUTES without a request (default 60).
 *   - Absolute: a session ends PORTAL_SESSION_MAX_DAYS after sign-in whatever the activity (default 7).
 * The session row's expires_at carries both: it is "last activity + idle", never later than "sign-in + absolute".
 */

function positive(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function idleMs(env: NodeJS.ProcessEnv = process.env): number {
  return positive(env.PORTAL_SESSION_IDLE_MINUTES, 60) * 60_000;
}

export function absoluteMs(env: NodeJS.ProcessEnv = process.env): number {
  return positive(env.PORTAL_SESSION_MAX_DAYS, 7) * 86_400_000;
}

/** Expiry for a session that is active at `nowMs`: now + idle, capped at sign-in + absolute. */
export function sessionExpiry(createdAt: string, nowMs: number, env: NodeJS.ProcessEnv = process.env): string {
  const created = Date.parse(createdAt);
  const cap = Number.isFinite(created) ? created + absoluteMs(env) : Infinity;
  return new Date(Math.min(nowMs + idleMs(env), cap)).toISOString();
}

/** The expiry to store after a request, or null when the stored one is already within a few minutes of it (saves writes). */
export function nextExpiry(createdAt: string, currentExpiry: string, nowMs: number, env: NodeJS.ProcessEnv = process.env): string | null {
  const target = sessionExpiry(createdAt, nowMs, env);
  const diff = Math.abs(Date.parse(target) - Date.parse(currentExpiry));
  return diff > 5 * 60_000 || !Number.isFinite(diff) ? target : null;
}
